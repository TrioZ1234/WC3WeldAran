/**
 * Tests for ground pathfinding.
 *
 *   node engine/test/pathing.ts
 *
 * Two halves. The synthetic grids pin down the rules — corners are not cut,
 * wide units are kept out of narrow gaps, an enclosed goal is reported as
 * unreachable instead of searched for, and the same request always produces
 * the same route. The second half runs against the real `war3map.wpm` when the
 * pipeline has produced it, because a rule that holds on a 16x16 toy and falls
 * over on 3.7 million cells has not been tested.
 */

import { existsSync, readFileSync } from "node:fs";
import { PathGrid, NO_WALK, GROUND } from "../sim/pathing.ts";
import { Battlefield, type UnitStats } from "../sim/units.ts";
import { ONE, fx, unfx } from "../sim/fixed.ts";
import { TICKS_PER_SECOND } from "../sim/scheduler.ts";

let passed = 0;
let failed = 0;

function check(label: string, actual: unknown, expected: unknown): void {
  if (Object.is(actual, expected)) {
    passed++;
    console.log(`  ok    ${label}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}\n          expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function ok(label: string, condition: boolean, detail = ""): void {
  if (condition) {
    passed++;
    console.log(`  ok    ${label}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ""}`);
  }
}

/** Build a grid from ASCII art: '.' walkable ground, '#' blocked. Row 0 is the top. */
function gridFrom(rows: string[]): PathGrid {
  const height = rows.length;
  const width = rows[0].length;
  const cells = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // ASCII row 0 is the north edge; the grid's row 0 is the south edge.
      const index = (height - 1 - y) * width + x;
      cells[index] = rows[y][x] === "#" ? GROUND | NO_WALK : GROUND;
    }
  }
  return new PathGrid({ width, height, cellSize: 32, origin: [0, 0] }, cells);
}

/** Every waypoint pair must be walkable end to end for the given footprint. */
function routeIsClear(grid: PathGrid, points: number[], radius: number): boolean {
  const needed = grid.clearanceFor(radius);
  for (let i = 0; i + 3 < points.length; i += 2) {
    const ax = grid.cellX(points[i]);
    const ay = grid.cellY(points[i + 1]);
    const bx = grid.cellX(points[i + 2]);
    const by = grid.cellY(points[i + 3]);
    if (!grid.lineOfSight(ax, ay, bx, by, needed)) return false;
  }
  return true;
}

// -- synthetic grids ---------------------------------------------------------

console.log("grid rules");
{
  const grid = gridFrom([
    "..........",
    "..........",
    "....##....",
    "....##....",
    "....##....",
    "....##....",
    "..........",
    "..........",
  ]);
  const from = { x: grid.centreX(1), y: grid.centreY(4) };
  const to = { x: grid.centreX(8), y: grid.centreY(4) };
  const path = grid.find({ fromX: from.x, fromY: from.y, toX: to.x, toY: to.y });
  ok("a wall is routed around", path.complete && path.points.length >= 4);
  ok("the route never crosses the wall", routeIsClear(grid, path.points, 0));
  ok("the route is smoothed, not a staircase", path.points.length / 2 <= 5,
    `${path.points.length / 2} waypoints`);

  const again = grid.find({ fromX: from.x, fromY: from.y, toX: to.x, toY: to.y });
  check("the same request gives the same route", JSON.stringify(again.points), JSON.stringify(path.points));
}

{
  // A one-cell gap: passable for a small unit, not for a wide one.
  const grid = gridFrom([
    "#########",
    "#...#...#",
    "#...#...#",
    "#.......#",
    "#...#...#",
    "#...#...#",
    "#########",
  ]);
  const from = { x: grid.centreX(2), y: grid.centreY(3) };
  const to = { x: grid.centreX(6), y: grid.centreY(3) };
  const small = grid.find({ fromX: from.x, fromY: from.y, toX: to.x, toY: to.y, radius: 0 });
  ok("a small unit slips through the gap", small.complete);
  const wide = grid.find({ fromX: from.x, fromY: from.y, toX: to.x, toY: to.y, radius: 64 });
  ok("a wide unit is refused the same gap", !wide.reachable || !wide.complete);
}

{
  // The only way between the two open cells is the diagonal between two
  // blocked ones. Warcraft III does not let a unit squeeze through there, and
  // neither may the search: the two cells are separate components.
  const grid = gridFrom([
    "#.",
    ".#",
  ]);
  const pinched = grid.find({
    fromX: grid.centreX(0), fromY: grid.centreY(0),   // ASCII row 1, column 0
    toX: grid.centreX(1), toY: grid.centreY(1),       // ASCII row 0, column 1
  });
  ok("corners are never cut", !pinched.reachable);
  check("each side of the pinch is its own component", grid.componentCount(0), 2);
}

{
  const grid = gridFrom([
    ".....",
    ".###.",
    ".#.#.",
    ".###.",
    ".....",
  ]);
  const sealed = grid.find({
    fromX: grid.centreX(0), fromY: grid.centreY(0),
    toX: grid.centreX(2), toY: grid.centreY(2),
  });
  ok("a sealed goal is reported unreachable", !sealed.reachable);
  check("and costs no search at all", sealed.expanded, 0);
  check("the walled cell is its own component", grid.componentCount(0), 2);
}

// -- the real map ------------------------------------------------------------

const DATA = "build/data";
const metaPath = `${DATA}/pathing.json`;
const binPath = `${DATA}/pathing.bin`;

if (!existsSync(metaPath) || !existsSync(binPath)) {
  console.log("\nreal map: skipped (run python3 build.py path/to/WFWA.w3x first)");
} else {
  console.log("\nthe map's own grid");
  const meta = JSON.parse(readFileSync(metaPath, "utf8"));
  const started = Date.now();
  const grid = new PathGrid(meta, new Uint8Array(readFileSync(binPath)));
  const buildMs = Date.now() - started;

  check("grid is 1920x1920", `${grid.width}x${grid.height}`, "1920x1920");
  ok("grid builds in well under a second", buildMs < 1000, `${buildMs} ms`);
  ok("a quarter of the map is walkable",
    grid.countStandable(0) > 900_000 && grid.countStandable(0) < 1_100_000,
    `${grid.countStandable(0)} cells`);
  ok("wide units lose ground to clearance",
    grid.countStandable(96) < grid.countStandable(0));

  // Label the components once before timing: that cost belongs to load, not
  // to a tick, and the runner pays it while the loading screen is up.
  const labelStarted = Date.now();
  grid.componentCount(32);
  const labelMs = Date.now() - labelStarted;
  ok("components label in load time, not tick time", labelMs < 500, `${labelMs} ms`);

  const info = JSON.parse(readFileSync(`${DATA}/map.json`, "utf8"));
  const starts: Array<[number, number]> = info.players.map((p: { start: [number, number] }) => p.start);

  let complete = 0;
  let unreachable = 0;
  let worst = 0;
  const badRoutes: string[] = [];
  for (let i = 0; i < starts.length; i++) {
    for (let j = 0; j < starts.length; j++) {
      if (i === j) continue;
      const call = Date.now();
      const result = grid.find({
        fromX: fx(starts[i][0]), fromY: fx(starts[i][1]),
        toX: fx(starts[j][0]), toY: fx(starts[j][1]),
        radius: 32,
      });
      worst = Math.max(worst, Date.now() - call);
      if (!result.reachable) unreachable++;
      else if (result.complete) complete++;
      if (result.points.length > 0 && !routeIsClear(grid, result.points, 32)) {
        badRoutes.push(`${i}->${j}`);
      }
    }
  }
  ok("every route returned stays on walkable ground", badRoutes.length === 0,
    badRoutes.join(", "));
  ok("most start locations are on separate landmasses", unreachable > 80,
    `${unreachable} of 132 pairs unreachable, ${complete} routed`);
  ok("no single search stalls a tick", worst < 40, `worst call ${worst} ms`);

  // Movement: a unit given an order must actually make progress along the route.
  console.log("\nunits follow their routes");
  const stats: UnitStats = {
    typeId: "test", name: "Тестовый", maxHp: 500, armor: 0, armorType: "medium",
    attackType: "normal", damageBase: 10, damageDice: 1, damageSides: 1,
    cooldown: 32, range: 100 * ONE, acquireRange: 0,
    speed: Math.trunc((300 * ONE) / TICKS_PER_SECOND),
    collisionRadius: 32, canAttack: false, model: "",
  };

  // Find two connected points a few thousand world units apart.
  let from: [number, number] | null = null;
  let to: [number, number] | null = null;
  const units = JSON.parse(readFileSync(`${DATA}/units.json`, "utf8")) as Array<{ pos: [number, number, number] }>;
  for (let i = 0; i < units.length && !to; i += 37) {
    for (let j = i + 1; j < units.length; j += 53) {
      const a = units[i].pos;
      const b = units[j].pos;
      const distance = Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);
      if (distance < 3000 || distance > 8000) continue;
      const test = grid.find({ fromX: fx(a[0]), fromY: fx(a[1]), toX: fx(b[0]), toY: fx(b[1]), radius: 32 });
      if (test.complete) {
        from = [a[0], a[1]];
        to = [b[0], b[1]];
        break;
      }
    }
  }

  if (!from || !to) {
    console.log("  (no suitable pair of preplaced units found; movement check skipped)");
  } else {
    const field = new Battlefield({ pathing: grid }, 1);
    const unit = field.spawn(stats, 0, from[0], from[1]);
    field.order(unit, to[0], to[1]);
    ok("the order produced a route", unit.path !== null);

    const startDistance = Math.hypot(unfx(unit.x) - to[0], unfx(unit.y) - to[1]);
    let offGrid = 0;
    for (let tick = 0; tick < TICKS_PER_SECOND * 120; tick++) {
      field.step();
      if (!grid.walkableAt(unit.x, unit.y, stats.collisionRadius)) offGrid++;
      if (unit.orderX === null) break;
    }
    const endDistance = Math.hypot(unfx(unit.x) - to[0], unfx(unit.y) - to[1]);

    ok("the unit closed most of the distance",
      endDistance < startDistance * 0.2,
      `${Math.round(startDistance)} -> ${Math.round(endDistance)} world units`);
    check("the unit never stood on unwalkable ground", offGrid, 0);

    // Determinism: the same seed and the same order replay identically.
    const replay = new Battlefield({ pathing: grid }, 1);
    const twin = replay.spawn(stats, 0, from[0], from[1]);
    replay.order(twin, to[0], to[1]);
    for (let tick = 0; tick < TICKS_PER_SECOND * 120; tick++) {
      replay.step();
      if (twin.orderX === null) break;
    }
    check("a replay lands on the same coordinates", `${twin.x},${twin.y}`, `${unit.x},${unit.y}`);
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed === 0 ? 0 : 1;
