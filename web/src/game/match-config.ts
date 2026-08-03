/**
 * The lobby's data model: twelve slots and the rules that keep them legal.
 *
 * This module is deliberately free of DOM and of any engine import. The lobby
 * screen edits a `MatchConfig`, the session hands the same structure to the
 * simulation worker, and the results screen reads it back. One plain structure
 * crossing every boundary is what makes the network step later a transport
 * problem rather than a redesign.
 */

import {
  BOT_NAMES,
  DIFFICULTIES,
  MAX_SLOTS,
  type Difficulty,
  type Race,
  normaliseRace,
} from "./players.ts";
import type { MapManifest } from "./map-manifest.ts";

/**
 * What occupies a slot.
 *
 * `open` is a slot a joining human takes; `closed` is one the host locked out.
 * The distinction matters for the online step - an open slot is an invitation,
 * a closed slot is a smaller game.
 */
export type SlotKind = "human" | "computer" | "open" | "closed";

export interface MatchSlot {
  /** 0..11, fixed for the life of the lobby: it is the player index the map uses. */
  slot: number;
  kind: SlotKind;
  name: string;
  race: Race;
  /** Force number as shown in the lobby, 1-based. */
  team: number;
  /** Percent, 50..150. Applied to hit points and damage. */
  handicap: number;
  difficulty: Difficulty;
  /** True for the seat this browser controls. Exactly one slot may hold it. */
  local: boolean;
  /** Set when the map's own w3i marks the slot as a computer or unused player. */
  fixedByMap: boolean;
  ready: boolean;
}

export interface MatchConfig {
  mapName: string;
  /** Copied from the manifest so the worker never needs the manifest itself. */
  mapPath: string;
  slots: MatchSlot[];
  /** Deterministic seed. Shared by every client in a network game. */
  seed: number;
  /** Game speed multiplier applied to the wall clock, never to the tick rate. */
  speed: 1 | 2 | 4;
  /** Fog of war and shared vision are lobby options in the original map. */
  sharedVision: boolean;
  revealMap: boolean;
  /** Seconds between city spawn waves; the map's own default is 90. */
  spawnPeriod: number;
}

// -- construction -----------------------------------------------------------

/**
 * Build the opening lobby state from the map's own player and force tables.
 *
 * The map decides how many slots exist and which of them it reserves for
 * computers. The lobby may not invent a thirteenth player or re-open a slot the
 * map never had, so the manifest is the authority here and the interface only
 * edits what remains free.
 */
export function createMatchConfig(manifest: MapManifest): MatchConfig {
  const teamOf = new Map<number, number>();
  manifest.forces.forEach((force, index) => {
    for (const slot of force.slots) teamOf.set(slot, index + 1);
  });

  const slots: MatchSlot[] = [];
  for (let index = 0; index < MAX_SLOTS; index++) {
    const declared = manifest.players.find((player) => player.slot === index);
    const usable = declared !== undefined;
    const mapComputer = declared?.controller === "computer";

    slots.push({
      slot: index,
      kind: !usable ? "closed" : mapComputer ? "computer" : "open",
      name: !usable
        ? "—"
        : mapComputer
          ? BOT_NAMES[index] ?? `Компьютер ${index + 1}`
          : "Открыт",
      race: normaliseRace(declared?.race),
      team: teamOf.get(index) ?? Math.min(manifest.forces.length || 1, index + 1),
      handicap: 100,
      difficulty: "normal",
      local: false,
      fixedByMap: !usable,
      ready: mapComputer,
    });
  }

  // The first slot the map leaves to a human is the seat this browser takes.
  const seat = slots.find((slot) => slot.kind === "open");
  if (seat) {
    seat.kind = "human";
    seat.name = "Игрок";
    seat.local = true;
    seat.ready = true;
  }

  return {
    mapName: manifest.name,
    mapPath: manifest.path,
    slots,
    seed: (Date.now() ^ 0x5eed) >>> 0,
    speed: 1,
    sharedVision: false,
    revealMap: false,
    spawnPeriod: 90,
  };
}

// -- editing ----------------------------------------------------------------

export function setKind(config: MatchConfig, index: number, kind: SlotKind): void {
  const slot = config.slots[index];
  if (!slot || slot.fixedByMap || slot.local) return;
  slot.kind = kind;
  slot.ready = kind === "computer";
  slot.name =
    kind === "computer"
      ? BOT_NAMES[index] ?? `Компьютер ${index + 1}`
      : kind === "open"
        ? "Открыт"
        : "Закрыт";
}

/**
 * Put a computer player into every free slot.
 *
 * This is the single button that turns an empty lobby into a playable match
 * against bots, which is stage A of the roadmap. Slots the host closed on
 * purpose stay closed - "fill the empty seats" should not undo a decision.
 */
export function fillWithBots(config: MatchConfig, difficulty: Difficulty = "normal"): number {
  let filled = 0;
  for (const slot of config.slots) {
    if (slot.kind !== "open") continue;
    setKind(config, slot.slot, "computer");
    slot.difficulty = difficulty;
    filled++;
  }
  return filled;
}

/** Remove every computer player, returning their slots to open. */
export function clearBots(config: MatchConfig): number {
  let removed = 0;
  for (const slot of config.slots) {
    if (slot.kind !== "computer" || slot.fixedByMap) continue;
    setKind(config, slot.slot, "open");
    removed++;
  }
  return removed;
}

/**
 * Spread the occupied slots evenly across the teams the map defines.
 *
 * Balance is by head count only. Weighing bot difficulty against human skill
 * is a matchmaking problem, and pretending to solve it here would only produce
 * a number nobody trusts.
 */
export function balanceTeams(config: MatchConfig, teamCount: number): void {
  const playing = config.slots.filter((slot) => slot.kind === "human" || slot.kind === "computer");
  const teams = Math.max(2, Math.min(teamCount, playing.length));
  playing.forEach((slot, index) => {
    slot.team = (index % teams) + 1;
  });
}

// -- reading ----------------------------------------------------------------

export const playingSlots = (config: MatchConfig): MatchSlot[] =>
  config.slots.filter((slot) => slot.kind === "human" || slot.kind === "computer");

export const localSlot = (config: MatchConfig): MatchSlot | undefined =>
  config.slots.find((slot) => slot.local);

export function teamSizes(config: MatchConfig): Map<number, number> {
  const sizes = new Map<number, number>();
  for (const slot of playingSlots(config)) {
    sizes.set(slot.team, (sizes.get(slot.team) ?? 0) + 1);
  }
  return sizes;
}

export interface Validation {
  ok: boolean;
  /** Blocking reasons - the match cannot start. */
  errors: string[];
  /** Non-blocking observations worth showing the host. */
  warnings: string[];
}

/**
 * Decide whether this lobby can start, and say why not in plain words.
 *
 * A start button that is merely greyed out teaches the player nothing, so
 * every refusal here carries its own sentence.
 */
export function validate(config: MatchConfig): Validation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const playing = playingSlots(config);
  const sizes = teamSizes(config);

  if (!config.slots.some((slot) => slot.local)) {
    errors.push("Ни один слот не отмечен как ваш.");
  }
  if (playing.length < 2) {
    errors.push("Нужно хотя бы два игрока — добавьте компьютерных противников.");
  }
  if (sizes.size < 2 && playing.length >= 2) {
    errors.push("Все игроки в одной команде — воевать будет не с кем.");
  }
  const notReady = playing.filter((slot) => !slot.ready);
  if (notReady.length > 0) {
    errors.push(`Не готовы: ${notReady.map((slot) => slot.name).join(", ")}.`);
  }

  const counts = [...sizes.values()];
  if (counts.length >= 2 && Math.max(...counts) - Math.min(...counts) >= 2) {
    warnings.push("Команды неравны по числу игроков.");
  }
  const open = config.slots.filter((slot) => slot.kind === "open").length;
  if (open > 0) {
    warnings.push(`Свободных слотов: ${open}. Их можно занять ботами.`);
  }
  if (playing.some((slot) => slot.handicap !== 100)) {
    warnings.push("У части игроков изменён гандикап.");
  }

  return { ok: errors.length === 0, errors, warnings };
}

/** One-line summary for the loading screen and the results header. */
export function describeMatch(config: MatchConfig): string {
  const sizes = [...teamSizes(config).entries()].sort((a, b) => a[0] - b[0]);
  const humans = playingSlots(config).filter((slot) => slot.kind === "human").length;
  const bots = playingSlots(config).filter((slot) => slot.kind === "computer").length;
  const shape = sizes.map(([, size]) => size).join(" на ");
  return `${shape} · людей ${humans}, компьютеров ${bots}`;
}

/**
 * Alliances in the shape the simulation wants: player index -> allied indices.
 *
 * The battlefield asks "are these two hostile", so it needs the positive list
 * of friends; deriving it once here keeps that question cheap per tick.
 */
export function allianceTable(config: MatchConfig): Array<[number, number[]]> {
  const playing = playingSlots(config);
  return playing.map((slot) => [
    slot.slot,
    playing.filter((other) => other !== slot && other.team === slot.team).map((other) => other.slot),
  ]);
}

/** Effective difficulty numbers for a slot, resolved once at match start. */
export function botProfile(slot: MatchSlot) {
  const profile = DIFFICULTIES[slot.difficulty];
  return { ...profile, handicap: Math.round((profile.handicap * slot.handicap) / 100) };
}
