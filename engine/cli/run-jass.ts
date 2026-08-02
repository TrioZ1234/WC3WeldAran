/**
 * Load `war3map.j`, run the map's entry points, and report what the engine
 * still owes it.
 *
 *   node engine/cli/run-jass.ts build/extracted/war3map.j
 *   node engine/cli/run-jass.ts build/extracted/war3map.j --json report.json
 *
 * This is the stage 3 checkpoint from docs/03-roadmap.md: `config()` and
 * `main()` reach their last line, and the log of unimplemented natives becomes
 * the prioritised work queue for stage 4.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { Interpreter, JassRuntimeError } from "../jass/interpreter.ts";
import type { JassSource } from "../jass/interpreter.ts";
import { JassSyntaxError } from "../jass/lexer.ts";

/**
 * Warcraft III's own scripts, loaded ahead of the map when they are available.
 * They are not redistributed here — `tools/fetch_war3_data.py` puts them in
 * `build/war3/`, which git ignores.
 */
const WAR3_SCRIPTS = ["build/war3/common.j", "build/war3/Blizzard.j"];

interface Outcome {
  name: string;
  ok: boolean;
  error?: string;
  steps: number;
  ms: number;
}

function bar(value: number, max: number, width = 28): string {
  if (max <= 0) return "";
  return "█".repeat(Math.max(1, Math.round((value / max) * width)));
}

function main(argv: string[]): number {
  const args = argv.filter((a) => !a.startsWith("--"));
  const scriptPath = args[0] ?? "build/extracted/war3map.j";
  const jsonIndex = argv.indexOf("--json");
  const jsonPath = jsonIndex >= 0 ? argv[jsonIndex + 1] : null;

  let source: string;
  try {
    source = readFileSync(scriptPath, "utf8");
  } catch {
    console.error(`cannot read ${scriptPath}`);
    return 2;
  }

  console.log("=".repeat(66));
  console.log(`JASS runtime — ${scriptPath}`);
  console.log("=".repeat(66));

  // -- parse --------------------------------------------------------------

  const sources: JassSource[] = [];
  if (!argv.includes("--no-war3")) {
    for (const path of WAR3_SCRIPTS) {
      if (existsSync(path)) sources.push({ name: path, text: readFileSync(path, "utf8") });
    }
  }
  sources.push({ name: scriptPath, text: source });

  let vm: Interpreter;
  const parseStart = Date.now();
  try {
    vm = new Interpreter(sources, { trace: false });
  } catch (error) {
    if (error instanceof JassSyntaxError) {
      console.error(`\nPARSE FAILED: ${error.message}`);
      const lines = source.split("\n");
      for (let i = Math.max(0, error.line - 3); i < Math.min(lines.length, error.line + 2); i++) {
        console.error(`${i + 1 === error.line ? " >>" : "   "} ${i + 1}: ${lines[i]}`);
      }
      return 1;
    }
    throw error;
  }
  const parseMs = Date.now() - parseStart;

  console.log(`\nparse       ${parseMs} ms`);
  for (const file of vm.loaded) {
    console.log(`  ${file.name.padEnd(30)} funcs ${String(file.functions).padStart(5)}  globals ${String(file.globals).padStart(4)}  natives ${String(file.natives).padStart(5)}`);
  }
  console.log(`  ${"total".padEnd(30)} funcs ${String(vm.program.functions.length).padStart(5)}  globals ${String(vm.program.globals.length).padStart(4)}  natives ${String(vm.program.natives.length).padStart(5)}`);

  // -- execute ------------------------------------------------------------

  const outcomes: Outcome[] = [];
  const runStage = (name: string, fn: () => void): void => {
    const before = vm.stepCount;
    const started = Date.now();
    try {
      fn();
      outcomes.push({ name, ok: true, steps: vm.stepCount - before, ms: Date.now() - started });
    } catch (error) {
      const message = error instanceof JassRuntimeError || error instanceof Error
        ? error.message : String(error);
      outcomes.push({ name, ok: false, error: message, steps: vm.stepCount - before, ms: Date.now() - started });
    }
  };

  runStage("globals", () => vm.initGlobals());
  if (vm.has("config")) runStage("config", () => vm.run("config"));
  if (vm.has("main")) runStage("main", () => vm.run("main"));

  console.log("\nexecution");
  for (const o of outcomes) {
    const status = o.ok ? "ok    " : "FAILED";
    console.log(`  ${status} ${o.name.padEnd(9)} ${String(o.steps).padStart(9)} steps  ${String(o.ms).padStart(5)} ms`);
    if (o.error) console.log(`         ${o.error}`);
  }
  console.log(`  handles created: ${vm.handleCount}`);

  // -- what the engine already provides -----------------------------------

  const implemented = [...vm.implementedCalls.entries()].sort((a, b) => b[1] - a[1]);
  const stubs = [...vm.stubCalls.entries()].sort((a, b) => b[1] - a[1]);
  const implementedTotal = implemented.reduce((s, [, c]) => s + c, 0);
  const stubTotal = stubs.reduce((s, [, c]) => s + c, 0);
  const grandTotal = implementedTotal + stubTotal;

  console.log("\nnative calls at runtime");
  console.log(`  implemented   ${String(implementedTotal).padStart(7)} calls across ${implemented.length} functions`);
  console.log(`  stubbed       ${String(stubTotal).padStart(7)} calls across ${stubs.length} functions`);
  if (grandTotal > 0) {
    const pct = ((implementedTotal / grandTotal) * 100).toFixed(1);
    console.log(`  coverage      ${pct}% of executed calls are backed by real behaviour`);
  }

  const maxStub = stubs.length > 0 ? stubs[0][1] : 0;
  console.log("\nwork queue — unimplemented natives by runtime call count");
  for (const [name, count] of stubs.slice(0, 25)) {
    console.log(`  ${String(count).padStart(6)}  ${name.padEnd(32)} ${bar(count, maxStub)}`);
  }
  if (stubs.length > 25) console.log(`  ... and ${stubs.length - 25} more`);

  console.log(`\nexternal constants resolved from common.j: ${vm.externals.size}`);

  // -- report -------------------------------------------------------------

  if (jsonPath) {
    const report = {
      script: scriptPath,
      parse: { ms: parseMs, functions: vm.program.functions.length, globals: vm.program.globals.length },
      execution: outcomes,
      handles: vm.handleCount,
      implemented: Object.fromEntries(implemented),
      stubs: Object.fromEntries(stubs),
      firstSeen: vm.firstSeen,
      externals: [...vm.externals.keys()].sort(),
      world: {
        mapName: vm.world.mapName,
        players: vm.world.playerCount,
        teams: vm.world.teamCount,
        startLocations: vm.world.startLocations.filter(Boolean).length,
        unitsCreated: vm.world.units.length,
        techEntries: vm.world.techState.size,
      },
    };
    writeFileSync(jsonPath, JSON.stringify(report, null, 2));
    console.log(`\nreport written to ${jsonPath}`);
  }

  const allOk = outcomes.every((o) => o.ok);
  console.log(`\n${allOk ? "ALL ENTRY POINTS COMPLETED" : "SOME ENTRY POINTS FAILED"}`);
  return allOk ? 0 : 1;
}

process.exitCode = main(process.argv.slice(2));
