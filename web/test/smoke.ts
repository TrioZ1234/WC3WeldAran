/**
 * Regression test for the shell's non-visual half.
 *
 *   node web/test/smoke.ts
 *
 * Screens are not tested here - a headless browser to click twelve dropdowns
 * would cost more than it catches. What is tested is everything underneath them:
 * the slot rules, the alliance table they produce, and a real match advancing
 * under the bot driver. Those are the parts where a mistake is silent, and the
 * parts a networked build will depend on.
 *
 * Deliberately dependency-free, like `engine/test/smoke.ts` next to it: a test
 * that needs an install is a test that stops being run.
 */

import {
  balanceTeams,
  clearBots,
  createMatchConfig,
  fillWithBots,
  playingSlots,
  allianceTable,
  setKind,
  teamSizes,
  validate,
  describeMatch,
} from "../src/game/match-config.ts";
import type { MapManifest } from "../src/game/map-manifest.ts";
import { MAX_SLOTS } from "../src/game/players.ts";
import { MatchRunner } from "../src/worker/match-runner.ts";
import { PLAYER_STRIDE, UNIT_STRIDE } from "../src/game/protocol.ts";
import { TICKS_PER_SECOND } from "../../engine/sim/scheduler.ts";

let passed = 0;
let failed = 0;

function ok(condition: unknown, label: string): void {
  if (condition) {
    passed++;
    console.log(`  ok    ${label}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}`);
  }
}

function equal(actual: unknown, expected: unknown, label: string): void {
  ok(actual === expected, `${label}${actual === expected ? "" : `  (${actual} != ${expected})`}`);
}

function section(title: string): void {
  console.log(`\n${title}`);
}

/** The map's real shape: twelve slots in six forces of two. */
function manifest(): MapManifest {
  return {
    name: "War for WeldAran",
    author: "TrioZ",
    description: "",
    path: "test",
    players: Array.from({ length: MAX_SLOTS }, (_, slot) => ({
      slot,
      controller: "human",
      race: "human",
      name: `Игрок ${slot + 1}`,
      start: [slot * 1000 - 6000, 0] as [number, number],
    })),
    forces: Array.from({ length: 6 }, (_, force) => ({
      name: `Команда ${force + 1}`,
      slots: [force * 2, force * 2 + 1],
    })),
    tiles: [480, 480],
    dataPresent: true,
  };
}

// -- lobby ------------------------------------------------------------------

section("lobby model");
{
  const config = createMatchConfig(manifest());

  equal(config.slots.length, MAX_SLOTS, "twelve slots exist");
  equal(config.slots.filter((slot) => slot.local).length, 1, "exactly one local seat");
  equal(playingSlots(config).length, 1, "only the local player starts occupied");
  ok(!validate(config).ok, "a lobby of one cannot start");

  const filled = fillWithBots(config, "hard");
  equal(filled, MAX_SLOTS - 1, "bots take every remaining slot");
  equal(playingSlots(config).length, MAX_SLOTS, "twelve players after filling");
  ok(validate(config).ok, "a full lobby can start");
  ok(
    playingSlots(config).every((slot) => slot.ready),
    "bots are ready without being asked",
  );

  const teams = teamSizes(config);
  equal(teams.size, 6, "the map's six forces are kept");
  ok(
    [...teams.values()].every((size) => size === 2),
    "each force holds two players",
  );

  // The local seat must survive every edit: it is this browser's player.
  setKind(config, config.slots.findIndex((slot) => slot.local), "closed");
  equal(config.slots.filter((slot) => slot.local).length, 1, "the local seat cannot be closed");

  balanceTeams(config, 2);
  const halves = [...teamSizes(config).values()];
  equal(halves.length, 2, "balancing to two teams gives two teams");
  equal(halves[0], halves[1], "twelve players split evenly");
  ok(describeMatch(config).startsWith("6 на 6"), "the summary reads as six on six");

  const alliances = new Map(allianceTable(config));
  const first = playingSlots(config)[0];
  const mate = playingSlots(config).find(
    (slot) => slot !== first && slot.team === first.team,
  );
  ok(alliances.get(first.slot)?.includes(mate?.slot ?? -1), "team mates are allied");
  ok(
    !alliances
      .get(first.slot)
      ?.some((ally) => config.slots[ally].team !== first.team),
    "nobody is allied across teams",
  );

  const removed = clearBots(config);
  equal(removed, MAX_SLOTS - 1, "clearing bots frees every bot slot");
  equal(playingSlots(config).length, 1, "only the human remains");
}

// -- a running match --------------------------------------------------------

section("match runner (training skirmish, no map data)");
{
  const config = createMatchConfig(manifest());
  fillWithBots(config, "normal");
  balanceTeams(config, 2);
  config.spawnPeriod = 10;

  const lines: string[] = [];
  const runner = new MatchRunner(
    config,
    { scripts: [], resolvedUnits: null, misc: null, startLocations: [] },
    (text) => lines.push(text),
  );

  ok(runner.sandbox, "with no scripts the runner reports a training match");
  const boot = runner.boot();
  ok(boot.units > 0, `boot placed units (${boot.units})`);
  ok(lines.length > 0, "the runner explains what it started");

  const atBoot = runner.field.units.length;
  for (let tick = 0; tick < 40 * TICKS_PER_SECOND; tick++) runner.step();

  ok(runner.field.attacks > 0, `armies engaged (${runner.field.attacks} attacks)`);
  ok(runner.field.deaths > 0, `units died (${runner.field.deaths})`);
  ok(
    runner.field.units.length > atBoot,
    `the spawn cycle produced reinforcements (${atBoot} -> ${runner.field.units.length})`,
  );

  const moving = runner.field.units.filter(
    (unit) => unit.alive && (unit.orderX !== null || unit.target !== null),
  );
  ok(moving.length > 0, `the bot driver committed units (${moving.length} on the move)`);

  const snapshot = runner.snapshot(1.5, new Set());
  equal(snapshot.units.length, snapshot.unitCount * UNIT_STRIDE, "snapshot stride is consistent");
  equal(snapshot.players.length, MAX_SLOTS * PLAYER_STRIDE, "every slot has a player row");
  ok(snapshot.seconds > 0, "the clock advanced");
  ok(
    snapshot.nextSpawn <= config.spawnPeriod,
    "the wave countdown never exceeds its period",
  );

  let ownersValid = true;
  for (let index = 0; index < snapshot.unitCount; index++) {
    const owner = snapshot.units[index * UNIT_STRIDE + 1];
    if (owner < 0 || owner > 15) ownersValid = false;
  }
  ok(snapshot.unitCount > 0, `units were packed (${snapshot.unitCount})`);
  ok(ownersValid, "every packed unit belongs to a valid player slot");

  let losses = 0;
  for (let slot = 0; slot < MAX_SLOTS; slot++) losses += snapshot.players[slot * PLAYER_STRIDE + 4];
  equal(losses, runner.field.deaths, "per-player losses add up to the battlefield's deaths");
}

// -- determinism ------------------------------------------------------------

section("determinism");
{
  const run = (): string => {
    const config = createMatchConfig(manifest());
    fillWithBots(config, "hard");
    balanceTeams(config, 2);
    config.seed = 0x1234;
    const runner = new MatchRunner(
      config,
      { scripts: [], resolvedUnits: null, misc: null, startLocations: [] },
      () => {},
    );
    runner.boot();
    for (let tick = 0; tick < 20 * TICKS_PER_SECOND; tick++) runner.step();
    const snapshot = runner.snapshot(0, new Set());
    // Hash the whole packed state: positions, hit points, ownership.
    let hash = 0;
    for (let i = 0; i < snapshot.unitCount * UNIT_STRIDE; i++) {
      hash = (Math.imul(hash, 31) + Math.round(snapshot.units[i] * 64)) | 0;
    }
    return `${snapshot.unitCount}:${hash}:${runner.field.deaths}`;
  };

  const first = run();
  const second = run();
  equal(second, first, "the same seed replays the same match");
  ok(first.split(":")[0] !== "0", "the replay actually simulated something");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed === 0 ? 0 : 1;
