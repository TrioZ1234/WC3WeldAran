/**
 * Unit simulation: movement, target acquisition, attacks, death.
 *
 * Everything here runs on integers (see `fixed.ts`) and on the seeded
 * generator, so the same inputs produce the same match on every machine.
 *
 * Target acquisition is the one operation that cannot be done naively. With
 * three thousand units on a 61 440 x 61 440 map, checking every pair is nine
 * million distance tests per tick at 32 Hz. A uniform grid reduces each query
 * to the handful of cells the unit's acquisition radius actually covers.
 */

import { ONE, fx, unfx, fxDistanceSquared, isqrt } from "./fixed.ts";
import { DamageTable, resolveDamage } from "./combat.ts";
import type { ArmorType, AttackType } from "./combat.ts";
import { TICKS_PER_SECOND } from "./scheduler.ts";
import type { PathGrid } from "./pathing.ts";

/** Static definition shared by every unit of a type, taken from resolved object data. */
export interface UnitStats {
  typeId: string;
  name: string;
  maxHp: number;
  armor: number;
  armorType: ArmorType;
  attackType: AttackType;
  damageBase: number;
  damageDice: number;
  damageSides: number;
  /** Ticks between attacks. */
  cooldown: number;
  /** Fixed point. */
  range: number;
  acquireRange: number;
  /** Fixed point per tick. */
  speed: number;
  /** World units. `ucol` in the object data — what the pathing grid must clear. */
  collisionRadius: number;
  canAttack: boolean;
  model: string;
}

export interface SimUnit {
  id: number;
  stats: UnitStats;
  owner: number;
  /** Fixed point. */
  x: number;
  y: number;
  hp: number;
  cooldownLeft: number;
  target: SimUnit | null;
  alive: boolean;
  /** Fixed-point point the unit walks toward when it has no target. */
  orderX: number | null;
  orderY: number | null;
  /**
   * Route to the order, as flat fixed-point waypoints from `PathGrid.find`.
   *
   * Null means "walk straight at it", which is right for a unit already in the
   * open and for every battlefield built without a pathing grid.
   */
  path: number[] | null;
  /** Index of the next waypoint in `path`, in points rather than numbers. */
  pathAt: number;
  /** Ticks before this unit may ask for a route again. */
  repathIn: number;
}

const num = (fields: Record<string, unknown>, key: string, fallback = 0): number => {
  const value = fields[key];
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
};

/** Build the static stat table from `build/data/resolved/units.json`. */
export function loadUnitStats(resolved: Array<{ id: string; fields: Record<string, unknown> }>): Map<string, UnitStats> {
  const table = new Map<string, UnitStats>();
  for (const entry of resolved) {
    if (!entry.id) continue;
    const f = entry.fields;
    const cooldownSeconds = num(f, "ua1c", 0);
    const damageBase = num(f, "ua1b", 0);
    const dice = num(f, "ua1d", 0);
    const sides = num(f, "ua1s", 0);
    table.set(entry.id, {
      typeId: entry.id,
      name: String(f.unam ?? entry.id),
      maxHp: Math.max(1, Math.round(num(f, "uhpm", 1))),
      armor: Math.round(num(f, "udef", 0)),
      armorType: DamageTable.normaliseArmor(f.udty),
      attackType: DamageTable.normaliseAttack(f.ua1t),
      damageBase,
      damageDice: dice,
      damageSides: sides,
      cooldown: Math.max(1, Math.round(cooldownSeconds * TICKS_PER_SECOND)),
      range: fx(num(f, "ua1r", 90)),
      acquireRange: fx(num(f, "uacq", 500)),
      // `umvs` is world units per second; the simulation steps 32 times a second.
      speed: Math.trunc(fx(num(f, "umvs", 0)) / TICKS_PER_SECOND),
      collisionRadius: Math.max(0, Math.round(num(f, "ucol", 0))),
      canAttack: (damageBase > 0 || dice > 0) && cooldownSeconds > 0,
      model: String(f.umdl ?? ""),
    });
  }
  return table;
}

/** Uniform spatial grid over the playable area. */
class Grid {
  private cells = new Map<number, SimUnit[]>();
  private readonly cellSize: number;

  constructor(cellWorldSize = 512) {
    this.cellSize = fx(cellWorldSize);
  }

  private key(x: number, y: number): number {
    // Offset keeps negative map coordinates inside a single positive keyspace.
    const cx = Math.trunc(x / this.cellSize) + 4096;
    const cy = Math.trunc(y / this.cellSize) + 4096;
    return cy * 8192 + cx;
  }

  clear(): void {
    this.cells.clear();
  }

  insert(unit: SimUnit): void {
    const key = this.key(unit.x, unit.y);
    let bucket = this.cells.get(key);
    if (!bucket) {
      bucket = [];
      this.cells.set(key, bucket);
    }
    bucket.push(unit);
  }

  /** Every unit in the cells overlapping a square of `radius` around a point. */
  near(x: number, y: number, radius: number, out: SimUnit[]): SimUnit[] {
    out.length = 0;
    const span = Math.trunc(radius / this.cellSize) + 1;
    const cx = Math.trunc(x / this.cellSize) + 4096;
    const cy = Math.trunc(y / this.cellSize) + 4096;
    for (let gy = cy - span; gy <= cy + span; gy++) {
      for (let gx = cx - span; gx <= cx + span; gx++) {
        const bucket = this.cells.get(gy * 8192 + gx);
        if (bucket) for (const unit of bucket) out.push(unit);
      }
    }
    return out;
  }
}

export interface BattlefieldOptions {
  damageTable?: DamageTable;
  /** Returns true when two owners should fight. Alliances come from the VM. */
  hostile?: (a: number, b: number) => boolean;
  /**
   * The map's own pathing grid. Without it units walk in straight lines, which
   * is what every test that predates `war3map.wpm` support expects.
   */
  pathing?: PathGrid;
  /**
   * Cells the whole battlefield may expand per tick, across every search.
   *
   * Counting searches would be the wrong unit: one route across a continent
   * costs as much as fifty across a courtyard. Counting expansions caps the
   * actual work, so a tick stays inside its 31 ms whatever the orders look
   * like. Requests that miss the window keep their old route and retry.
   */
  pathExpansionsPerTick?: number;
}

export class Battlefield {
  units: SimUnit[] = [];
  damageTable: DamageTable;
  /** Simulation-owned RNG; must be the only source of randomness in combat. */
  private randomState: number;
  private grid = new Grid();
  private scratch: SimUnit[] = [];
  private nextId = 1;
  private hostile: (a: number, b: number) => boolean;
  private pathing: PathGrid | null;
  private pathExpansionsPerTick: number;
  private pathBudgetLeft = 0;

  // Instrumentation for the pathing layer.
  pathsFound = 0;
  pathsUnreachable = 0;
  pathsTruncated = 0;

  // Instrumentation.
  attacks = 0;
  deaths = 0;
  damageDealt = 0;

  constructor(options: BattlefieldOptions = {}, seed = 0x5eed) {
    this.damageTable = options.damageTable ?? new DamageTable();
    this.hostile = options.hostile ?? ((a, b) => a !== b);
    this.pathing = options.pathing ?? null;
    this.pathExpansionsPerTick = options.pathExpansionsPerTick ?? 24000;
    this.randomState = seed >>> 0;
  }

  /** Deterministic integer roll, inclusive. */
  private roll = (low: number, high: number): number => {
    if (high <= low) return low;
    this.randomState = (Math.imul(this.randomState, 1664525) + 1013904223) >>> 0;
    return low + (this.randomState % (high - low + 1));
  };

  spawn(stats: UnitStats, owner: number, worldX: number, worldY: number): SimUnit {
    const unit: SimUnit = {
      id: this.nextId++,
      stats,
      owner,
      x: fx(worldX),
      y: fx(worldY),
      hp: stats.maxHp * ONE,
      cooldownLeft: 0,
      target: null,
      alive: true,
      orderX: null,
      orderY: null,
      path: null,
      pathAt: 0,
      repathIn: 0,
    };
    this.units.push(unit);
    return unit;
  }

  order(unit: SimUnit, worldX: number, worldY: number): void {
    unit.orderX = fx(worldX);
    unit.orderY = fx(worldY);
    unit.path = null;
    unit.pathAt = 0;
    unit.repathIn = 0;
    // Route immediately: an order is the one moment the player is watching.
    this.route(unit, unit.orderX, unit.orderY, true);
  }

  /**
   * Ask the grid for a route, honouring the per-tick search budget.
   *
   * `urgent` spends from the budget even when it is exhausted, because a fresh
   * player order that visibly does nothing for a tick reads as a dropped click.
   */
  private route(unit: SimUnit, toX: number, toY: number, urgent = false): void {
    if (!this.pathing) return;
    if (!urgent && this.pathBudgetLeft <= 0) {
      unit.repathIn = Math.max(unit.repathIn, 4);
      return;
    }

    // An urgent request may overdraw, but only up to its own ceiling: a player
    // order is worth one long search, never an unbounded one.
    const ceiling = urgent ? 20000 : Math.min(8000, this.pathBudgetLeft);
    const result = this.pathing.find({
      fromX: unit.x, fromY: unit.y, toX, toY,
      radius: unit.stats.collisionRadius,
      budget: ceiling,
    });
    this.pathBudgetLeft -= result.expanded;

    if (!result.reachable) {
      // No ground route exists at all. Standing still beats walking into the
      // sea, and the order is cleared so the unit stops asking every tick.
      this.pathsUnreachable++;
      unit.path = null;
      unit.orderX = null;
      unit.orderY = null;
      return;
    }
    if (result.points.length === 0) {
      unit.path = null;
      unit.repathIn = TICKS_PER_SECOND;
      return;
    }

    if (result.complete) this.pathsFound++;
    else this.pathsTruncated++;
    unit.path = result.points;
    unit.pathAt = 0;
    // A truncated route ends short of the goal, so plan to extend it soon.
    unit.repathIn = result.complete ? 0 : TICKS_PER_SECOND;
  }

  get living(): number {
    let count = 0;
    for (const unit of this.units) if (unit.alive) count++;
    return count;
  }

  /** Advance the battlefield by one simulation tick. */
  step(): void {
    this.pathBudgetLeft = this.pathExpansionsPerTick;
    this.grid.clear();
    for (const unit of this.units) if (unit.alive) this.grid.insert(unit);

    for (const unit of this.units) {
      if (!unit.alive) continue;
      if (unit.cooldownLeft > 0) unit.cooldownLeft--;

      if (unit.target && !unit.target.alive) unit.target = null;
      if (!unit.target && unit.stats.canAttack) unit.target = this.acquire(unit);

      if (unit.repathIn > 0) unit.repathIn--;

      if (unit.target) {
        const reach = unit.stats.range + fx(64); // a little slack for unit radius
        if (fxDistanceSquared(unit.x, unit.y, unit.target.x, unit.target.y) > reach * reach) {
          this.pursue(unit, unit.target);
        } else if (unit.cooldownLeft === 0) {
          this.strike(unit, unit.target);
        }
      } else if (unit.orderX !== null && unit.orderY !== null) {
        const arrived = fxDistanceSquared(unit.x, unit.y, unit.orderX, unit.orderY) <= fx(96) * fx(96);
        if (arrived) {
          unit.orderX = null;
          unit.orderY = null;
          unit.path = null;
        } else {
          this.follow(unit, unit.orderX, unit.orderY);
        }
      }
    }

    // Compact the dead out in one pass rather than splicing during iteration.
    if (this.deaths > 0 && this.units.length > 4096) {
      this.units = this.units.filter((unit) => unit.alive);
    }
  }

  private acquire(unit: SimUnit): SimUnit | null {
    const radius = unit.stats.acquireRange;
    const candidates = this.grid.near(unit.x, unit.y, radius, this.scratch);
    let best: SimUnit | null = null;
    let bestDistance = radius * radius;
    for (const other of candidates) {
      if (other === unit || !other.alive) continue;
      if (!this.hostile(unit.owner, other.owner)) continue;
      const distance = fxDistanceSquared(unit.x, unit.y, other.x, other.y);
      if (distance <= bestDistance) {
        bestDistance = distance;
        best = other;
      }
    }
    return best;
  }

  /**
   * Walk one tick toward the order, along the route when there is one.
   *
   * Waypoints are retired as they are reached, and a unit that has fallen off
   * its route - shoved by a spawn, blocked by a building that appeared - asks
   * for a new one rather than grinding against whatever stopped it.
   */
  private follow(unit: SimUnit, goalX: number, goalY: number): void {
    if (!this.pathing) {
      this.advance(unit, goalX, goalY);
      return;
    }

    if (!unit.path && unit.repathIn === 0) this.route(unit, goalX, goalY);
    const path = unit.path;
    if (!path) {
      // No route this tick: hold position rather than march into a cliff.
      return;
    }

    // Retire every waypoint already reached; a fast unit can pass several.
    const tolerance = fx(48) * fx(48);
    while (unit.pathAt * 2 + 1 < path.length) {
      const wx = path[unit.pathAt * 2];
      const wy = path[unit.pathAt * 2 + 1];
      if (fxDistanceSquared(unit.x, unit.y, wx, wy) > tolerance) break;
      unit.pathAt++;
    }
    if (unit.pathAt * 2 + 1 >= path.length) {
      unit.path = null;
      // The route ended. Either this was the goal or the route was truncated,
      // in which case the next tick asks for the continuation.
      if (fxDistanceSquared(unit.x, unit.y, goalX, goalY) > fx(96) * fx(96)) {
        unit.repathIn = 0;
      }
      return;
    }

    const before = { x: unit.x, y: unit.y };
    this.advance(unit, path[unit.pathAt * 2], path[unit.pathAt * 2 + 1]);
    if (unit.x === before.x && unit.y === before.y && unit.stats.speed > 0) {
      unit.path = null;
      unit.repathIn = Math.max(unit.repathIn, TICKS_PER_SECOND >> 1);
    }
  }

  /**
   * Close on a target.
   *
   * Combat is nearly always fought at short range where the straight line is
   * both correct and free, so the grid is only consulted when the direct line
   * is actually blocked - a unit shooting across a river, a melee unit whose
   * prey stands on the far side of a wall.
   */
  private pursue(unit: SimUnit, target: SimUnit): void {
    if (this.pathing && unit.stats.speed > 0) {
      const clear = this.pathing.lineOfSight(
        this.pathing.cellX(unit.x), this.pathing.cellY(unit.y),
        this.pathing.cellX(target.x), this.pathing.cellY(target.y),
        this.pathing.clearanceFor(unit.stats.collisionRadius),
      );
      if (!clear) {
        if (!unit.path && unit.repathIn === 0) this.route(unit, target.x, target.y);
        const path = unit.path;
        if (path && unit.pathAt * 2 + 1 < path.length) {
          this.follow(unit, target.x, target.y);
          return;
        }
        // Nothing routable: fall through to the straight line, which at worst
        // presses the unit against the obstacle rather than freezing it.
      } else if (unit.path) {
        unit.path = null;                 // the way is open; drop the detour
      }
    }
    this.advance(unit, target.x, target.y);
  }

  private advance(unit: SimUnit, targetX: number, targetY: number): void {
    const speed = unit.stats.speed;
    if (speed <= 0) return;
    const dx = targetX - unit.x;
    const dy = targetY - unit.y;
    const distance = isqrt(dx * dx + dy * dy);
    if (distance === 0) return;
    if (distance <= speed) {
      unit.x = targetX;
      unit.y = targetY;
      return;
    }
    unit.x += Math.trunc((dx * speed) / distance);
    unit.y += Math.trunc((dy * speed) / distance);
  }

  private strike(attacker: SimUnit, defender: SimUnit): void {
    const damage = resolveDamage(
      this.damageTable,
      {
        attackType: attacker.stats.attackType,
        base: attacker.stats.damageBase,
        dice: attacker.stats.damageDice,
        sides: attacker.stats.damageSides,
      },
      { armorType: defender.stats.armorType, armor: defender.stats.armor },
      this.roll,
    );

    attacker.cooldownLeft = attacker.stats.cooldown;
    this.attacks++;
    this.damageDealt += damage;

    defender.hp -= damage;
    if (defender.hp <= 0) {
      defender.hp = 0;
      defender.alive = false;
      defender.target = null;
      this.deaths++;
    } else if (!defender.target) {
      // Retaliate: being hit pulls a unit's attention even out of acquisition range.
      defender.target = attacker;
    }
  }

  /** Human-readable snapshot for reports. */
  describe(unit: SimUnit): string {
    return `${unit.stats.name} #${unit.id} p${unit.owner} ` +
      `(${Math.round(unfx(unit.x))},${Math.round(unfx(unit.y))}) ` +
      `${Math.round(unit.hp / ONE)}/${unit.stats.maxHp}`;
  }
}
