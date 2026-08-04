/**
 * Run the map as a game: initialise, then advance simulated time.
 *
 *   node engine/cli/run-game.ts                      60 seconds of game time
 *   node engine/cli/run-game.ts --seconds 300
 *   node engine/cli/run-game.ts --json report.json
 *
 * This is the difference between "the world was built" and "the game is
 * running". After `main()` returns, the clock starts ticking at 32 Hz — the
 * same rate Warcraft III uses and the rate the map's own `T32` heartbeat
 * expects — and the map's timers and triggers begin firing on their own.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { Interpreter } from "../jass/interpreter.ts";
import type { JassSource } from "../jass/interpreter.ts";
import { TICKS_PER_SECOND } from "../sim/scheduler.ts";
import { Battlefield, loadUnitStats } from "../sim/units.ts";
import { DamageTable } from "../sim/combat.ts";
import { ONE } from "../sim/fixed.ts";
import { PathGrid } from "../sim/pathing.ts";

const WAR3_SCRIPTS = ["build/war3/common.j", "build/war3/Blizzard.j"];
const MAP_SCRIPT = "build/extracted/war3map.j";

function arg(argv: string[], name: string, fallback: number): number {
  const index = argv.indexOf(name);
  if (index < 0) return fallback;
  const value = Number(argv[index + 1]);
  return Number.isFinite(value) ? value : fallback;
}

function main(argv: string[]): number {
  const seconds = arg(argv, "--seconds", 60);
  const jsonIndex = argv.indexOf("--json");
  const jsonPath = jsonIndex >= 0 ? argv[jsonIndex + 1] : null;

  const scriptPath = argv.find((a) => a.endsWith(".j") && !a.startsWith("--")) ?? MAP_SCRIPT;
  if (!existsSync(scriptPath)) {
    console.error(`map script not found: ${scriptPath}\nrun: python3 build.py <map.w3x>`);
    return 2;
  }

  const sources: JassSource[] = [];
  for (const path of WAR3_SCRIPTS) {
    if (existsSync(path)) sources.push({ name: path, text: readFileSync(path, "utf8") });
  }
  sources.push({ name: scriptPath, text: readFileSync(scriptPath, "utf8") });

  console.log("=".repeat(66));
  console.log("War for WeldAran — prototype run");
  console.log("=".repeat(66));

  const vm = new Interpreter(sources);
  console.log(`\nloaded ${vm.program.functions.length} functions, ${vm.program.globals.length} globals`);

  // Attach combat when the resolved object data is available. Without it the
  // VM is still a correct logic runner — it just has nothing to fight with.
  const resolvedPath = "build/data/resolved/units.json";
  const miscPath = "build/extracted/war3mapMisc.txt";
  const pathingMetaPath = "build/data/pathing.json";
  const pathingBinPath = "build/data/pathing.bin";
  if (existsSync(resolvedPath) && !argv.includes("--no-combat")) {
    const stats = loadUnitStats(JSON.parse(readFileSync(resolvedPath, "utf8")));
    const table = existsSync(miscPath) ? new DamageTable(readFileSync(miscPath, "utf8")) : new DamageTable();
    // The map's own pathing grid, when the pipeline has exported it.
    let pathing: PathGrid | undefined;
    if (existsSync(pathingMetaPath) && existsSync(pathingBinPath)) {
      pathing = new PathGrid(
        JSON.parse(readFileSync(pathingMetaPath, "utf8")),
        new Uint8Array(readFileSync(pathingBinPath)),
      );
      console.log(`pathing grid: ${pathing.width}x${pathing.height}, ` +
        `${pathing.countStandable(32).toLocaleString()} standable cells`);
    }

    vm.world.unitStats = stats;
    vm.world.battlefield = new Battlefield({
      damageTable: table,
      pathing,
      // Neutral passive (15) never fights; otherwise anyone not explicitly
      // allied is an enemy, which is Warcraft III's default posture.
      hostile: (a, b) => {
        if (a === b || a === 15 || b === 15) return false;
        return !(vm.world.alliances.get(a)?.has(b) ?? false);
      },
    });
    console.log(`combat enabled: ${stats.size} unit types, damage table from ` +
      `${existsSync(miscPath) ? "the map" : "Warcraft III defaults"}`);
  }

  // -- initialise ---------------------------------------------------------

  const bootStart = Date.now();
  vm.initGlobals();
  if (vm.has("config")) vm.run("config");
  if (vm.has("main")) vm.run("main");
  const bootMs = Date.now() - bootStart;

  console.log(`\ninitialisation  ${bootMs} ms`);
  console.log(`  map            ${vm.world.mapName}`);
  console.log(`  players        ${vm.world.playerCount}   teams ${vm.world.teamCount}`);
  console.log(`  units placed   ${vm.world.units.length}`);
  console.log(`  timers armed   ${vm.clock.pending}`);
  console.log(`  events bound   ${vm.events.size}`);

  const unitsAtBoot = vm.world.units.length;

  const topEvents = vm.events.summary().slice(0, 3);
  if (topEvents.length > 0) {
    console.log("  largest event registrations:");
    for (const entry of topEvents) console.log(`    ${entry.count.toString().padStart(5)}  ${entry.event}`);
  }

  if (vm.clock.pending === 0) {
    console.log("\nno timers armed — the world would sit still. Nothing to simulate.");
    return 1;
  }

  // -- simulate -----------------------------------------------------------

  console.log(`\nsimulating ${seconds}s of game time at ${TICKS_PER_SECOND} Hz ...\n`);
  console.log("   game time    ticks   callbacks   trig eval   trig exec     units    wall ms");
  console.log("   " + "-".repeat(76));

  const samples: Array<Record<string, number | string>> = [];
  const realStart = Date.now();
  let callbacks = 0;
  const sampleEvery = Math.max(1, Math.round(seconds / 6));

  for (let second = 1; second <= seconds; second++) {
    const before = Date.now();
    const outcome = vm.runFor(1);
    callbacks += outcome.callbacks;
    if (second % sampleEvery === 0 || second === seconds) {
      const row = {
        time: vm.clock.formatted,
        ticks: vm.clock.tick,
        callbacks,
        evaluated: vm.triggersEvaluated,
        executed: vm.triggersExecuted,
        units: vm.world.units.length,
        wallMs: Date.now() - before,
      };
      samples.push(row);
      console.log(
        `   ${String(row.time).padStart(9)} ${String(row.ticks).padStart(8)} ${String(row.callbacks).padStart(11)}` +
        ` ${String(row.evaluated).padStart(11)} ${String(row.executed).padStart(11)} ${String(row.units).padStart(9)} ${String(row.wallMs).padStart(10)}`,
      );
    }
  }

  const realMs = Date.now() - realStart;
  const speed = (seconds * 1000) / Math.max(1, realMs);
  const spawned = vm.world.units.length - unitsAtBoot;

  console.log("\nresult");
  console.log(`  simulated      ${seconds}s of game time in ${realMs} ms of wall clock`);
  console.log(`  speed          ${speed.toFixed(1)}x real time`);
  console.log(`  ticks          ${vm.clock.tick} at ${TICKS_PER_SECOND} Hz`);
  console.log(`  timer callbacks ${callbacks}`);
  console.log(`  trigger evals  ${vm.triggersEvaluated}`);
  console.log(`  trigger execs  ${vm.triggersExecuted}`);
  console.log(`  statements     ${vm.stepCount.toLocaleString("en-US")}`);
  console.log(`  timers pending ${vm.clock.pending}`);
  console.log(`  threads asleep ${vm.sleepingThreads}`);
  const field = vm.world.battlefield;
  if (field) {
    console.log("\ncombat");
    console.log(`  units on field ${field.units.length}   alive ${field.living}`);
    console.log(`  attacks        ${field.attacks}`);
    console.log(`  deaths         ${field.deaths}`);
    console.log(`  damage dealt   ${Math.round(field.damageDealt / ONE).toLocaleString("en-US")}`);
  }
  console.log(`  sleeps resumed ${vm.sleepsHonoured}   (TriggerSleepAction suspensions honoured)`);

  if (spawned > 0) {
    // The clearest evidence the map's own logic is driving the world.
    const fresh = vm.world.units.slice(unitsAtBoot);
    const byType = new Map<number, number>();
    for (const unit of fresh) {
      const id = Number(unit.data.get("typeId"));
      byType.set(id, (byType.get(id) ?? 0) + 1);
    }
    const rawcode = (n: number): string =>
      String.fromCharCode((n >> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255);
    console.log(`\n  the map spawned ${spawned} units on its own, ${byType.size} distinct types:`);
    for (const [id, count] of [...byType.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)) {
      console.log(`    ${String(count).padStart(4)} x ${rawcode(id)}`);
    }
  }

  if (vm.tickErrors.length > 0) {
    console.log(`\n  errors inside callbacks: ${vm.tickErrors.length}`);
    const seen = new Set<string>();
    for (const error of vm.tickErrors) {
      if (seen.has(error.message)) continue;
      seen.add(error.message);
      console.log(`    tick ${error.tick}: ${error.message}`);
      if (seen.size >= 5) break;
    }
  }

  const alive = vm.clock.fired > 0 && vm.triggersEvaluated > 0;
  console.log(`\n${alive ? "THE GAME IS RUNNING — time advances and the map's own logic executes"
                         : "clock advanced but nothing fired"}`);

  if (jsonPath) {
    writeFileSync(jsonPath, JSON.stringify({
      script: scriptPath,
      bootMs,
      world: {
        mapName: vm.world.mapName,
        players: vm.world.playerCount,
        units: vm.world.units.length,
      },
      simulation: {
        seconds, ticks: vm.clock.tick, wallMs: realMs, speedFactor: Number(speed.toFixed(2)),
        callbacks, evaluated: vm.triggersEvaluated, executed: vm.triggersExecuted,
        statements: vm.stepCount, timersPending: vm.clock.pending,
        unitsAtBoot, unitsSpawned: vm.world.units.length - unitsAtBoot,
        sleepsHonoured: vm.sleepsHonoured, threadsAsleep: vm.sleepingThreads,
      },
      events: vm.events.summary().slice(0, 20),
      samples,
      errors: vm.tickErrors.slice(0, 50),
    }, null, 2));
    console.log(`\nreport written to ${jsonPath}`);
  }

  return alive ? 0 : 1;
}

process.exitCode = main(process.argv.slice(2));
