/**
 * Damage resolution.
 *
 * The attack-type versus armour-type table is not hardcoded: the map ships its
 * own `war3mapMisc.txt` and this author edited it. Reading the map's copy is
 * the difference between the balance he tuned and Blizzard's defaults —
 * pierce against light is 2.10 here, not the stock 2.00.
 */

import { ONE, fxMul, fxDiv } from "./fixed.ts";

/** Column order of the DamageBonus rows in war3mapMisc.txt. */
export const ARMOR_TYPES = [
  "small", "medium", "large", "fort", "normal", "hero", "divine", "none",
] as const;

export const ATTACK_TYPES = [
  "normal", "pierce", "siege", "spells", "chaos", "magic", "hero",
] as const;

export type ArmorType = (typeof ARMOR_TYPES)[number];
export type AttackType = (typeof ATTACK_TYPES)[number];

/** Warcraft III's aliases for the same armour types, as they appear in object data. */
const ARMOR_ALIASES: Record<string, ArmorType> = {
  small: "small", light: "small",
  medium: "medium",
  large: "large", heavy: "large",
  fort: "fort", fortified: "fort",
  normal: "normal", flesh: "normal", metal: "normal", stone: "normal",
  wood: "normal", ethereal: "normal",
  hero: "hero",
  divine: "divine",
  none: "none",
};

export class DamageTable {
  /** multipliers[attackType][armorType], fixed point. */
  private multipliers = new Map<string, number[]>();

  /** Stock Warcraft III values, used when the map ships no table of its own. */
  static readonly DEFAULTS: Record<string, number[]> = {
    normal: [1.00, 1.50, 1.00, 0.70, 1.00, 1.00, 0.05, 1.00],
    pierce: [2.00, 0.75, 1.00, 0.35, 1.00, 0.50, 0.05, 1.00],
    siege: [1.00, 0.50, 1.00, 1.50, 1.00, 0.50, 0.05, 1.00],
    spells: [1.00, 0.75, 1.00, 0.35, 1.00, 0.70, 0.05, 1.00],
    chaos: [1.00, 1.00, 1.00, 1.00, 1.00, 1.00, 0.05, 1.00],
    magic: [1.25, 0.75, 2.00, 0.35, 1.00, 0.50, 0.05, 1.00],
    hero: [1.00, 1.00, 1.00, 0.50, 1.00, 1.00, 0.05, 1.00],
  };

  constructor(source?: string) {
    for (const [attack, row] of Object.entries(DamageTable.DEFAULTS)) {
      this.multipliers.set(attack, row.map((v) => Math.round(v * ONE)));
    }
    if (source) this.parse(source);
  }

  /** Read `DamageBonus<AttackType>=a,b,c,...` lines out of war3mapMisc.txt. */
  private parse(source: string): void {
    for (const line of source.split(/\r?\n/)) {
      const match = /^\s*DamageBonus([A-Za-z]+)\s*=\s*(.+)$/.exec(line);
      if (!match) continue;
      const attack = match[1].toLowerCase();
      if (!ATTACK_TYPES.includes(attack as AttackType)) continue;
      const values = match[2].split(",").map((v) => Math.round(parseFloat(v.trim()) * ONE) || 0);
      if (values.length >= ARMOR_TYPES.length) this.multipliers.set(attack, values);
    }
  }

  static normaliseArmor(value: unknown): ArmorType {
    const key = String(value ?? "normal").trim().toLowerCase();
    return ARMOR_ALIASES[key] ?? "normal";
  }

  static normaliseAttack(value: unknown): AttackType {
    const key = String(value ?? "normal").trim().toLowerCase();
    return (ATTACK_TYPES as readonly string[]).includes(key) ? (key as AttackType) : "normal";
  }

  /** Fixed-point multiplier for an attack type against an armour type. */
  multiplier(attack: AttackType, armor: ArmorType): number {
    const row = this.multipliers.get(attack) ?? this.multipliers.get("normal")!;
    const index = ARMOR_TYPES.indexOf(armor);
    return row[index >= 0 ? index : 4] ?? ONE;
  }
}

/**
 * Warcraft III's armour reduction curve: each point of armour is worth 6 %
 * of the remaining damage, so armour has diminishing returns and never
 * reaches immunity. Negative armour amplifies damage instead.
 */
export function armorMultiplier(armor: number): number {
  if (armor >= 0) {
    const scaled = fxMul(armor * ONE, Math.round(0.06 * ONE));
    return fxDiv(ONE, ONE + scaled);
  }
  const scaled = fxMul(-armor * ONE, Math.round(0.06 * ONE));
  return 2 * ONE - fxDiv(ONE, ONE + scaled);
}

export interface AttackProfile {
  attackType: AttackType;
  /** Base damage before dice. */
  base: number;
  dice: number;
  sides: number;
}

export interface DefenceProfile {
  armorType: ArmorType;
  armor: number;
}

/**
 * Roll one attack. `roll` must come from the simulation's seeded generator —
 * never `Math.random`, or two clients diverge on the first swing.
 */
export function resolveDamage(
  table: DamageTable,
  attack: AttackProfile,
  defence: DefenceProfile,
  roll: (low: number, high: number) => number,
): number {
  let raw = attack.base;
  for (let die = 0; die < attack.dice; die++) {
    raw += attack.sides > 0 ? roll(1, attack.sides) : 0;
  }
  if (raw <= 0) return 0;

  let damage = raw * ONE;
  damage = fxMul(damage, table.multiplier(attack.attackType, defence.armorType));
  damage = fxMul(damage, armorMultiplier(defence.armor));
  return damage > 0 ? damage : 0;
}
