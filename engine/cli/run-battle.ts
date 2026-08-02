/**
 * Stand two armies of real map units against each other and simulate the fight.
 *
 *   node engine/cli/run-battle.ts
 *   node engine/cli/run-battle.ts --a h01S --b h01V --count 12
 *   node engine/cli/run-battle.ts --list
 *
 * Everything comes from the map: unit statistics from `build/data/resolved`,
 * and the attack-versus-armour table from the map's own `war3mapMisc.txt`,
 * which this author edited away from Blizzard's defaults.
 *
 * The point is not the spectacle — it is that combat is decided by the numbers
 * the map actually ships, and that the same seed always produces the same
 * outcome, which is the precondition for lockstep multiplayer.
 */

import { existsSync, readFileSync } from "node:fs";
import { Battlefield, loadUnitStats } from "../sim/units.ts";
import type { UnitStats, SimUnit } from "../sim/units.ts";
import { DamageTable } from "../sim/combat.ts";
import { ONE, unfx } from "../sim/fixed.ts";
import { TICKS_PER_SECOND } from "../sim/scheduler.ts";

const RESOLVED = "build/data/resolved/units.json";
const MISC = "build/extracted/war3mapMisc.txt";

function flag(argv: string[], name: string, fallback: string): string {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
}

function main(argv: string[]): number {
  if (!existsSync(RESOLVED)) {
    console.error(`missing ${RESOLVED}\nrun: python3 tools/export_stock.py build/war3 build/data`);
    return 2;
  }

  const resolved = JSON.parse(readFileSync(RESOLVED, "utf8"));
  const stats = loadUnitStats(resolved);
  const fighters = [...stats.values()].filter((s) => s.canAttack && s.speed > 0);

  if (argv.includes("--list")) {
    console.log(`${fighters.length} combat-capable unit types:\n`);
    for (const s of fighters.slice(0, 40)) {
      console.log(`  ${s.typeId}  ${s.name.slice(0, 26).padEnd(28)} ` +
        `hp ${String(s.maxHp).padStart(5)}  dmg ${s.damageBase}+${s.damageDice}d${s.damageSides}` +
        `  ${s.attackType}/${s.armorType}  arm ${s.armor}`);
    }
    return 0;
  }

  const table = existsSync(MISC) ? new DamageTable(readFileSync(MISC, "utf8")) : new DamageTable();
  console.log("=".repeat(66));
  console.log("Battle simulation");
  console.log("=".repeat(66));
  console.log(existsSync(MISC)
    ? "\ndamage table: from the map's own war3mapMisc.txt"
    : "\ndamage table: Warcraft III defaults (map file not found)");

  const idA = flag(argv, "--a", "h01S");
  const idB = flag(argv, "--b", "h01V");
  const count = Number(flag(argv, "--count", "10")) || 10;

  const a = stats.get(idA);
  const b = stats.get(idB);
  if (!a || !b) {
    console.error(`unknown unit type: ${!a ? idA : idB}. Try --list.`);
    return 2;
  }

  const show = (s: UnitStats): string =>
    `${s.name} (${s.typeId})\n` +
    `    hp ${s.maxHp}   armour ${s.armor} ${s.armorType}   attack ${s.attackType}\n` +
    `    damage ${s.damageBase} + ${s.damageDice}d${s.damageSides}` +
    `   cooldown ${(s.cooldown / TICKS_PER_SECOND).toFixed(2)}s` +
    `   range ${Math.round(unfx(s.range))}   speed ${Math.round(unfx(s.speed) * TICKS_PER_SECOND)}`;

  console.log(`\nside A  ${count} x ${show(a)}`);
  console.log(`\nside B  ${count} x ${show(b)}`);

  const multiplier = table.multiplier(a.attackType, b.armorType) / ONE;
  const reverse = table.multiplier(b.attackType, a.armorType) / ONE;
  console.log(`\nmatchup  A->B ${a.attackType} vs ${b.armorType} = ${multiplier.toFixed(2)}x` +
    `   B->A ${b.attackType} vs ${a.armorType} = ${reverse.toFixed(2)}x`);

  const field = new Battlefield({ damageTable: table });
  for (let i = 0; i < count; i++) {
    field.spawn(a, 1, -400 + (i % 5) * 64, -200 + Math.floor(i / 5) * 64);
    field.spawn(b, 2, 400 + (i % 5) * 64, -200 + Math.floor(i / 5) * 64);
  }
  for (const unit of field.units) {
    field.order(unit, unit.owner === 1 ? 400 : -400, 0);
  }

  console.log(`\nsimulating at ${TICKS_PER_SECOND} Hz ...\n`);
  console.log("     time    A alive    B alive    attacks    deaths");
  console.log("     " + "-".repeat(50));

  const alive = (owner: number): number =>
    field.units.filter((u: SimUnit) => u.alive && u.owner === owner).length;

  const started = Date.now();
  let tick = 0;
  const limit = TICKS_PER_SECOND * 120;
  while (tick < limit && alive(1) > 0 && alive(2) > 0) {
    field.step();
    tick++;
    if (tick % (TICKS_PER_SECOND * 5) === 0) {
      const seconds = (tick / TICKS_PER_SECOND).toFixed(0);
      console.log(`  ${seconds.padStart(6)}s ${String(alive(1)).padStart(10)} ${String(alive(2)).padStart(10)}` +
        ` ${String(field.attacks).padStart(10)} ${String(field.deaths).padStart(9)}`);
    }
  }

  const survivorsA = alive(1);
  const survivorsB = alive(2);
  console.log("\nresult");
  console.log(`  duration      ${(tick / TICKS_PER_SECOND).toFixed(1)}s of game time in ${Date.now() - started} ms`);
  console.log(`  survivors     A ${survivorsA}   B ${survivorsB}`);
  console.log(`  attacks       ${field.attacks}`);
  console.log(`  deaths        ${field.deaths}`);
  console.log(`  damage dealt  ${Math.round(field.damageDealt / ONE)}`);

  const winner = survivorsA === survivorsB ? "draw"
    : survivorsA > survivorsB ? `${a.name} wins` : `${b.name} wins`;
  console.log(`\n  ${winner}`);

  // Determinism is the whole reason for the fixed-point arithmetic; assert it.
  const replay = new Battlefield({ damageTable: table });
  for (let i = 0; i < count; i++) {
    replay.spawn(a, 1, -400 + (i % 5) * 64, -200 + Math.floor(i / 5) * 64);
    replay.spawn(b, 2, 400 + (i % 5) * 64, -200 + Math.floor(i / 5) * 64);
  }
  for (const unit of replay.units) replay.order(unit, unit.owner === 1 ? 400 : -400, 0);
  for (let i = 0; i < tick; i++) replay.step();

  const identical = replay.attacks === field.attacks
    && replay.deaths === field.deaths
    && replay.damageDealt === field.damageDealt;
  console.log(`  replay        ${identical ? "bit-identical — deterministic" : "DIVERGED"}`);

  return identical ? 0 : 1;
}

process.exitCode = main(process.argv.slice(2));
