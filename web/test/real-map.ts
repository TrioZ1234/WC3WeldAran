/**
 * Ad-hoc check: run the web client's own match path against the real build/data.
 *
 * Mirrors what `src/worker/sim.worker.ts` does on boot, but reads the staged
 * files from disk instead of fetching them, so the browser is not required to
 * prove that the pipeline output actually drives a match.
 */

import fs from "node:fs";
import path from "node:path";
import { MatchRunner, type MatchAssets } from "../src/worker/match-runner.ts";
import { createMatchConfig } from "../src/game/match-config.ts";
import type { MapManifest } from "../src/game/map-manifest.ts";

const DATA = path.resolve(import.meta.dirname, "../public/data");
const read = (rel: string): string | null => {
  const file = path.join(DATA, rel);
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
};

const info = JSON.parse(read("map.json")!);
const scripts = ["common.j", "Blizzard.j", "war3map.j"].map((name) => ({
  name,
  text: read(`scripts/${name}`),
}));
for (const script of scripts) if (script.text === null) throw new Error(`missing scripts/${script.name}`);

const pathingMeta = read("pathing.json");
const assets: MatchAssets = {
  scripts: scripts as Array<{ name: string; text: string }>,
  resolvedUnits: JSON.parse(read("resolved/units.json")!),
  misc: read("scripts/war3mapMisc.txt"),
  startLocations: (info.players ?? []).map((p: { start: [number, number] }) => p.start),
  pathing: pathingMeta
    ? {
        meta: JSON.parse(pathingMeta),
        cells: new Uint8Array(fs.readFileSync(path.join(DATA, "pathing.bin"))),
      }
    : null,
};

const manifest: MapManifest = {
  name: info.name,
  author: info.author,
  description: info.description ?? "",
  path: "/data/map.json",
  players: info.players,
  forces: info.forces,
  tiles: info.terrain.tiles,
  dataPresent: true,
};

const config = createMatchConfig(manifest);
const runner = new MatchRunner(config, assets, () => {});
const summary = runner.boot();

console.log(`map        ${manifest.name.replace(/\|c[0-9a-fA-F]{8}|\|r|\|n/g, "").trim()}`);
console.log(`sandbox    ${runner.sandbox}  (false = the map's own script is running)`);
console.log(`boot       ${summary.functions} functions, ${summary.units} units, ${summary.timers} timers`);

const TICKS = 32 * 60;
const started = performance.now();
for (let i = 0; i < TICKS; i++) runner.step();
const ms = performance.now() - started;

const snapshot = runner.snapshot(ms, new Set<number>());
console.log(`stepped    ${TICKS} ticks (60s) in ${ms.toFixed(0)} ms -> ${((TICKS / 32) / (ms / 1000)).toFixed(1)}x real time`);
console.log(`snapshot   ${snapshot.unitCount} units drawn, ${snapshot.totalUnits} carried, ${runner.typeNames.length} distinct types`);
console.log(`outcome    ${runner.finished ? JSON.stringify(runner.finished) : "match still running"}`);
console.log(`pathing    ${runner.pathing ? `${runner.pathing.width}x${runner.pathing.height} grid` : "none"}` +
  `, routes ${runner.field.pathsFound} complete, ${runner.field.pathsTruncated} truncated, ` +
  `${runner.field.pathsUnreachable} unreachable`);
if (runner.sandbox) throw new Error("fell back to sandbox: the map script did not load");
if (snapshot.unitCount === 0) throw new Error("no units in snapshot");
console.log("\nthe web client's match path runs on the real map data");
