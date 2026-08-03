/**
 * A running match: the JASS virtual machine, the battlefield and the bots.
 *
 * This is the piece the interface talks to, and it is the piece that will one
 * day be Rust. So it holds no reference to the DOM, no `fetch`, no worker API -
 * everything it needs is handed in as plain data by the caller. What comes back
 * out is a flat typed array. That discipline is the whole reason the port is
 * expected to be mechanical rather than a rewrite.
 */

import { Interpreter } from "../../../engine/jass/interpreter.ts";
import type { JassSource } from "../../../engine/jass/interpreter.ts";
import { Battlefield, loadUnitStats } from "../../../engine/sim/units.ts";
import type { SimUnit, UnitStats } from "../../../engine/sim/units.ts";
import { DamageTable } from "../../../engine/sim/combat.ts";
import { ONE, unfx } from "../../../engine/sim/fixed.ts";
import { TICKS_PER_SECOND } from "../../../engine/sim/scheduler.ts";
import { ArmyDriver } from "../../../engine/ai/army-driver.ts";
import type { BotProfile } from "../../../engine/ai/army-driver.ts";
import {
  allianceTable,
  botProfile,
  playingSlots,
  type MatchConfig,
} from "../game/match-config.ts";
import {
  PLAYER_STRIDE,
  UNIT_FLAG_ATTACKING,
  UNIT_FLAG_BUILDING,
  UNIT_FLAG_SELECTED,
  UNIT_STRIDE,
  type MatchOutcome,
  type OrderKind,
  type Snapshot,
} from "../game/protocol.ts";
import { MAX_SLOTS, NEUTRAL_PASSIVE } from "../game/players.ts";

/** Everything the runner needs from the network, fetched by the caller. */
export interface MatchAssets {
  /** `common.j`, `Blizzard.j` and the map script, in load order. Empty for a sandbox. */
  scripts: JassSource[];
  /** Contents of `build/data/resolved/units.json`, or null when unavailable. */
  resolvedUnits: Array<{ id: string; fields: Record<string, unknown> }> | null;
  /** Contents of the map's `war3mapMisc.txt`, which carries its damage table. */
  misc: string | null;
  /** Start locations from `map.json`, used to place a sandbox skirmish. */
  startLocations: Array<[number, number]>;
}

/** `PLAYER_STATE_RESOURCE_GOLD` and `..._LUMBER` as common.j numbers them. */
const STATE_GOLD = 1;
const STATE_LUMBER = 2;

export class MatchRunner {
  readonly vm: Interpreter;
  readonly field: Battlefield;
  /** True when the map script was unavailable and this is a training skirmish. */
  readonly sandbox: boolean;

  private driver: ArmyDriver | null = null;
  private stats: Map<string, UnitStats>;
  private typeIndex = new Map<string, number>();
  typeNames: string[] = [];

  private allied = new Map<number, Set<number>>();
  private goldKey = "";
  private lumberKey = "";
  private spawnPeriodTicks: number;
  private lastSpawnTick = 0;
  private sandboxRoster: UnitStats[] = [];
  private kills = new Float64Array(MAX_SLOTS);
  private losses = new Float64Array(MAX_SLOTS);
  private seenDead = new Set<number>();
  private everHadUnits = new Set<number>();
  private outcome: MatchOutcome | null = null;
  /** Facing carried between snapshots so units do not snap back to east. */
  private facing = new Map<number, number>();
  private previous = new Map<number, [number, number]>();
  private startLocations: Array<[number, number]>;
  private config: MatchConfig;
  private log: (text: string, slot?: number) => void;

  constructor(
    config: MatchConfig,
    assets: MatchAssets,
    log: (text: string, slot?: number) => void,
  ) {
    this.config = config;
    this.log = log;
    this.sandbox = assets.scripts.length === 0;
    this.spawnPeriodTicks = Math.max(1, Math.round(config.spawnPeriod * TICKS_PER_SECOND));

    // Alliances come from the lobby, not from the script. In a melee map the
    // script sets them; here the players chose, and the lobby is the authority.
    for (const [slot, allies] of allianceTable(config)) {
      this.allied.set(slot, new Set(allies));
    }

    this.stats = assets.resolvedUnits ? loadUnitStats(assets.resolvedUnits) : new Map();
    if (this.stats.size === 0) this.stats = syntheticStats();

    const table = assets.misc ? new DamageTable(assets.misc) : new DamageTable();
    this.field = new Battlefield(
      { damageTable: table, hostile: (a, b) => this.hostile(a, b) },
      config.seed,
    );

    this.vm = new Interpreter(this.sandbox ? [{ name: "<sandbox>", text: "" }] : assets.scripts, {
      seed: config.seed,
    });
    this.vm.world.unitStats = this.stats;
    this.vm.world.battlefield = this.field;
    for (const [slot, allies] of this.allied) this.vm.world.alliances.set(slot, allies);

    // Resolve the two player-state handles once. The natives key player state by
    // handle identity, so the keys have to be asked for rather than guessed.
    this.goldKey = String(this.vm.enumHandle("playerstate", STATE_GOLD));
    this.lumberKey = String(this.vm.enumHandle("playerstate", STATE_LUMBER));

    this.sandboxRoster = [...this.stats.values()]
      .filter((entry) => entry.canAttack && entry.speed > 0)
      .sort((a, b) => a.typeId.localeCompare(b.typeId))
      .slice(0, 8);

    this.startLocations = assets.startLocations;
  }

  private hostile(a: number, b: number): boolean {
    if (a === b) return false;
    if (a === NEUTRAL_PASSIVE || b === NEUTRAL_PASSIVE) return false;
    return !(this.allied.get(a)?.has(b) ?? false);
  }

  // -- boot -----------------------------------------------------------------

  /**
   * Run the map's own initialisation, then arm the bots.
   *
   * `config` and `main` are what Warcraft III itself calls; between them they
   * place every preset unit, arm 15 timers and register 205 triggers. Nothing
   * here reimplements any of that - it is the map's script doing its own job.
   */
  boot(): { units: number; timers: number; functions: number } {
    if (!this.sandbox) {
      this.vm.initGlobals();
      if (this.vm.has("config")) this.vm.run("config");
      if (this.vm.has("main")) this.vm.run("main");
    } else {
      this.seedSandbox();
    }

    this.applyLobbyToPlayers();

    const profiles: BotProfile[] = playingSlots(this.config)
      .filter((slot) => slot.kind === "computer")
      .map((slot) => {
        const profile = botProfile(slot);
        return {
          slot: slot.slot,
          handicap: profile.handicap,
          regroupSeconds: profile.regroupSeconds,
          waveSize: profile.waveSize,
        };
      });
    if (profiles.length > 0) {
      this.driver = new ArmyDriver(this.field, profiles, (a, b) => this.hostile(a, b));
    }

    for (const unit of this.field.units) if (unit.alive) this.everHadUnits.add(unit.owner);

    return {
      units: this.field.units.length,
      timers: this.vm.clock.pending,
      functions: this.vm.program.functions.length,
    };
  }

  /**
   * Push the lobby's choices onto the players the script created.
   *
   * Names and handicap are the player's own decisions and the map has no way to
   * know them, so they are written after `main` rather than before - otherwise
   * the script's own `SetPlayerName` calls would overwrite them.
   */
  private applyLobbyToPlayers(): void {
    for (const slot of playingSlots(this.config)) {
      const player = this.vm.world.players[slot.slot] ?? this.vm.enumHandle("player", slot.slot);
      player.data.set("index", slot.slot);
      player.data.set("name", slot.name);
      player.data.set("lobbyKind", slot.kind);
      player.data.set("team", slot.team);
      this.vm.world.players[slot.slot] = player;
    }
  }

  /**
   * Place a small skirmish when the map script is not available.
   *
   * This exists so a fresh clone has something to look at and the interface can
   * be exercised end to end. It is labelled as a training match everywhere it
   * shows, because it is not the map: the map's own logic is what `build.py`
   * produces, and no amount of synthetic spawning substitutes for it.
   */
  private seedSandbox(): void {
    const slots = playingSlots(this.config);
    const radius = 9000;
    slots.forEach((slot, index) => {
      const [baseX, baseY] = this.startLocationFor(index, slots.length, radius);
      const hall = this.sandboxRoster[0];
      if (hall) {
        // A stationary unit stands in for the city the map would place here.
        const keep: UnitStats = {
          ...hall,
          typeId: `${hall.typeId}#keep`,
          name: "Город",
          maxHp: hall.maxHp * 12,
          speed: 0,
          canAttack: false,
        };
        this.field.spawn(keep, slot.slot, baseX, baseY);
      }
      this.spawnWave(slot.slot, baseX, baseY, 6);
    });
    this.log(
      `тренировочный бой: ${slots.length} игроков, ` +
        `${this.field.units.length} юнитов, скрипт карты не загружен`,
    );
  }

  private startLocationFor(index: number, total: number, radius: number): [number, number] {
    const declared = this.startLocations[index];
    if (declared && (declared[0] !== 0 || declared[1] !== 0)) return declared;
    // Integer trigonometry is fine here: placement happens once, before the
    // deterministic part of the match begins.
    const angle = (index / Math.max(1, total)) * Math.PI * 2;
    return [Math.round(Math.cos(angle) * radius), Math.round(Math.sin(angle) * radius)];
  }

  private spawnWave(owner: number, x: number, y: number, count: number): void {
    if (this.sandboxRoster.length === 0) return;
    for (let i = 0; i < count; i++) {
      const stats = this.sandboxRoster[(owner + i) % this.sandboxRoster.length];
      const ring = 220 + (i % 3) * 180;
      const angle = (i / count) * Math.PI * 2;
      this.field.spawn(
        stats,
        owner,
        x + Math.round(Math.cos(angle) * ring),
        y + Math.round(Math.sin(angle) * ring),
      );
    }
  }

  // -- ticking --------------------------------------------------------------

  /** Advance one simulation tick: script logic, combat, then the bots. */
  step(): void {
    this.vm.runFor(1 / TICKS_PER_SECOND);
    this.driver?.step(this.vm.clock.tick);
    if (this.sandbox) this.sandboxSpawns();
    this.accountDeaths();
    this.checkOutcome();
  }

  private sandboxSpawns(): void {
    if (this.vm.clock.tick - this.lastSpawnTick < this.spawnPeriodTicks) return;
    this.lastSpawnTick = this.vm.clock.tick;
    const slots = playingSlots(this.config);
    slots.forEach((slot, index) => {
      if (!this.everHadUnits.has(slot.slot)) return;
      const [x, y] = this.startLocationFor(index, slots.length, 9000);
      this.spawnWave(slot.slot, x, y, 4);
    });
  }

  /**
   * Attribute deaths to owners.
   *
   * The battlefield counts deaths in aggregate; a scoreboard needs them per
   * player, and it must not count the same corpse twice, hence the id set.
   */
  private accountDeaths(): void {
    for (const unit of this.field.units) {
      if (unit.alive || this.seenDead.has(unit.id)) continue;
      this.seenDead.add(unit.id);
      if (unit.owner < MAX_SLOTS) this.losses[unit.owner]++;
      this.facing.delete(unit.id);
      this.previous.delete(unit.id);
    }
    // Kills are losses seen from the other side: every death credits the
    // opposing team as a whole, which is what a team scoreboard should show.
    for (let slot = 0; slot < MAX_SLOTS; slot++) {
      let credited = 0;
      for (let other = 0; other < MAX_SLOTS; other++) {
        if (this.hostile(slot, other)) credited += this.losses[other];
      }
      this.kills[slot] = credited;
    }
  }

  /**
   * Decide whether the match is over.
   *
   * A player is out when they held units and hold none. The grace period keeps
   * the first spawn cycle from declaring a winner before the map has placed
   * anything - on a 90-second spawn timer that is a real risk.
   */
  private checkOutcome(): void {
    if (this.outcome) return;
    if (this.vm.clock.tick < 10 * TICKS_PER_SECOND) return;

    const holding = new Set<number>();
    for (const unit of this.field.units) {
      if (unit.alive && unit.owner < MAX_SLOTS) holding.add(unit.owner);
    }
    for (const slot of holding) this.everHadUnits.add(slot);

    const contenders = playingSlots(this.config)
      .map((slot) => slot.slot)
      .filter((slot) => this.everHadUnits.has(slot));
    if (contenders.length === 0) return;

    const alive = contenders.filter((slot) => holding.has(slot));
    const local = this.config.slots.find((slot) => slot.local)?.slot ?? 0;

    // One surviving team, or the local player wiped out.
    const teams = new Set(
      alive.map((slot) => this.config.slots[slot]?.team ?? slot),
    );
    if (alive.length > 0 && teams.size <= 1 && contenders.length > alive.length) {
      this.outcome = {
        victory: alive.includes(local),
        survivors: alive,
        seconds: this.vm.clock.seconds,
        reason: alive.includes(local) ? "Все противники разбиты." : "Победила другая команда.",
      };
    } else if (!holding.has(local) && this.everHadUnits.has(local)) {
      this.outcome = {
        victory: false,
        survivors: alive,
        seconds: this.vm.clock.seconds,
        reason: "Вы потеряли все войска.",
      };
    }
  }

  get finished(): MatchOutcome | null {
    return this.outcome;
  }

  // -- orders ---------------------------------------------------------------

  /**
   * Apply a player's order to the units they actually own.
   *
   * Ownership is re-checked here rather than trusted from the caller: in the
   * networked step these ids arrive from another machine, and a client that can
   * order its opponent's army is not a game.
   */
  order(kind: OrderKind, ids: number[], x: number, y: number, owner: number): number {
    const wanted = new Set(ids);
    let applied = 0;
    for (const unit of this.field.units) {
      if (!unit.alive || unit.owner !== owner || !wanted.has(unit.id)) continue;
      switch (kind) {
        case "move":
          unit.target = null;
          this.field.order(unit, x, y);
          break;
        case "attack":
          this.field.order(unit, x, y);
          break;
        case "stop":
        case "hold":
          unit.orderX = null;
          unit.orderY = null;
          unit.target = null;
          break;
      }
      applied++;
    }
    return applied;
  }

  // -- snapshots ------------------------------------------------------------

  /**
   * Pack the world into flat arrays for the renderer and HUD.
   *
   * Only living units are packed, and their coordinates leave fixed point here -
   * this is the boundary, so this is the only correct place to do it.
   */
  snapshot(simMs: number, selected: Set<number>): Snapshot {
    const living: SimUnit[] = [];
    for (const unit of this.field.units) if (unit.alive) living.push(unit);

    const units = new Float32Array(living.length * UNIT_STRIDE);
    const perPlayer = new Float32Array(MAX_SLOTS * PLAYER_STRIDE);
    const counts = new Int32Array(MAX_SLOTS);

    living.forEach((unit, index) => {
      const x = unfx(unit.x);
      const y = unfx(unit.y);
      const previous = this.previous.get(unit.id);
      let facing = this.facing.get(unit.id) ?? 0;
      if (previous) {
        const dx = x - previous[0];
        const dy = y - previous[1];
        if (dx * dx + dy * dy > 1) facing = Math.atan2(dy, dx);
      }
      this.facing.set(unit.id, facing);
      this.previous.set(unit.id, [x, y]);

      let flags = 0;
      if (selected.has(unit.id)) flags |= UNIT_FLAG_SELECTED;
      if (unit.target) flags |= UNIT_FLAG_ATTACKING;
      if (unit.stats.speed <= 0) flags |= UNIT_FLAG_BUILDING;

      const at = index * UNIT_STRIDE;
      units[at + 0] = unit.id;
      units[at + 1] = unit.owner;
      units[at + 2] = x;
      units[at + 3] = y;
      units[at + 4] = this.indexOfType(unit.stats);
      units[at + 5] = Math.max(0, unit.hp / ONE / unit.stats.maxHp);
      units[at + 6] = facing;
      units[at + 7] = flags;

      if (unit.owner < MAX_SLOTS) counts[unit.owner]++;
    });

    for (let slot = 0; slot < MAX_SLOTS; slot++) {
      const at = slot * PLAYER_STRIDE;
      const state = this.vm.world.players[slot]?.data.get("state");
      const resources = state instanceof Map ? (state as Map<string, number>) : null;
      perPlayer[at + 0] = resources?.get(this.goldKey) ?? 0;
      perPlayer[at + 1] = resources?.get(this.lumberKey) ?? 0;
      perPlayer[at + 2] = counts[slot];
      perPlayer[at + 3] = this.kills[slot];
      perPlayer[at + 4] = this.losses[slot];
      perPlayer[at + 5] = counts[slot] > 0 ? 1 : 0;
    }

    return {
      tick: this.vm.clock.tick,
      seconds: this.vm.clock.seconds,
      units,
      unitCount: living.length,
      players: perPlayer,
      nextSpawn: this.secondsToNextSpawn(),
      totalUnits: this.field.units.length,
      simMs,
    };
  }

  private indexOfType(stats: UnitStats): number {
    const existing = this.typeIndex.get(stats.typeId);
    if (existing !== undefined) return existing;
    const index = this.typeNames.length;
    this.typeIndex.set(stats.typeId, index);
    this.typeNames.push(stats.name || stats.typeId);
    return index;
  }

  /**
   * Seconds until the next city wave.
   *
   * In a real match the map owns this timer, so the number is read back from the
   * clock rather than tracked separately - two counters would eventually
   * disagree, and the one on screen would be the wrong one.
   */
  private secondsToNextSpawn(): number {
    if (this.sandbox) {
      const elapsed = this.vm.clock.tick - this.lastSpawnTick;
      return Math.max(0, (this.spawnPeriodTicks - elapsed) / TICKS_PER_SECOND);
    }
    // Of the map's periodic timers, the one whose period matches the configured
    // spawn interval is the city wave. Matching by period rather than by handle
    // means the HUD keeps working if the map renames or re-creates the timer.
    let best = Number.POSITIVE_INFINITY;
    for (const timer of this.vm.clock.periodic()) {
      if (Math.abs(timer.period - this.config.spawnPeriod) > 1) continue;
      best = Math.min(best, timer.remaining);
    }
    return Number.isFinite(best) ? best : 0;
  }
}

/**
 * Stand-in statistics used only when `build/data` is absent.
 *
 * Numbers are round and obviously invented so nobody mistakes a training match
 * for the map's own balance.
 */
function syntheticStats(): Map<string, UnitStats> {
  const make = (
    typeId: string,
    name: string,
    maxHp: number,
    damage: number,
    speed: number,
    range: number,
  ): UnitStats => ({
    typeId,
    name,
    maxHp,
    armor: 2,
    armorType: "medium",
    attackType: "normal",
    damageBase: damage,
    damageDice: 1,
    damageSides: 3,
    cooldown: Math.round(1.5 * TICKS_PER_SECOND),
    range: range * ONE,
    acquireRange: 800 * ONE,
    speed: Math.trunc((speed * ONE) / TICKS_PER_SECOND),
    canAttack: true,
    model: "",
  });

  const table = new Map<string, UnitStats>();
  for (const stats of [
    make("t001", "Пехотинец", 420, 12, 270, 90),
    make("t002", "Стрелок", 300, 16, 270, 600),
    make("t003", "Рыцарь", 800, 26, 320, 100),
    make("t004", "Жрец", 240, 9, 270, 550),
    make("t005", "Осадная машина", 550, 40, 220, 700),
  ]) {
    table.set(stats.typeId, stats);
  }
  return table;
}
