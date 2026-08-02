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

  // Instrumentation.
  attacks = 0;
  deaths = 0;
  damageDealt = 0;

  constructor(options: BattlefieldOptions = {}, seed = 0x5eed) {
    this.damageTable = options.damageTable ?? new DamageTable();
    this.hostile = options.hostile ?? ((a, b) => a !== b);
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
    };
    this.units.push(unit);
    return unit;
  }

  order(unit: SimUnit, worldX: number, worldY: number): void {
    unit.orderX = fx(worldX);
    unit.orderY = fx(worldY);
  }

  get living(): number {
    let count = 0;
    for (const unit of this.units) if (unit.alive) count++;
    return count;
  }

  /** Advance the battlefield by one simulation tick. */
  step(): void {
    this.grid.clear();
    for (const unit of this.units) if (unit.alive) this.grid.insert(unit);

    for (const unit of this.units) {
      if (!unit.alive) continue;
      if (unit.cooldownLeft > 0) unit.cooldownLeft--;

      if (unit.target && !unit.target.alive) unit.target = null;
      if (!unit.target && unit.stats.canAttack) unit.target = this.acquire(unit);

      if (unit.target) {
        const reach = unit.stats.range + fx(64); // a little slack for unit radius
        if (fxDistanceSquared(unit.x, unit.y, unit.target.x, unit.target.y) > reach * reach) {
          this.advance(unit, unit.target.x, unit.target.y);
        } else if (unit.cooldownLeft === 0) {
          this.strike(unit, unit.target);
        }
      } else if (unit.orderX !== null && unit.orderY !== null) {
        const arrived = fxDistanceSquared(unit.x, unit.y, unit.orderX, unit.orderY) <= fx(96) * fx(96);
        if (arrived) {
          unit.orderX = null;
          unit.orderY = null;
        } else {
          this.advance(unit, unit.orderX, unit.orderY);
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
