/**
 * Ground pathfinding over the map's own `war3map.wpm` grid.
 *
 * Warcraft III ships one byte of movement flags per 32x32 world-unit cell,
 * four cells to a terrain tile. That grid is the authority on where a unit may
 * stand, and it is the reason this module exists rather than a navmesh built
 * from the terrain: the map's blockers, bridges and pathing-only doodads are
 * already baked into it, so anything derived from the tilepoints alone would
 * disagree with the original game exactly where players notice it.
 *
 * Two properties are non-negotiable here.
 *
 * Determinism. The search is integer-only — costs, the heuristic, the heap
 * ordering and every tie-break. Two clients running the same order must expand
 * the same nodes in the same sequence, because a path that differs by one cell
 * is a desync in the lockstep model the project is heading for.
 *
 * A bounded cost per call. This map is 1 920 x 1 920 = 3.7 million cells and
 * carries 2 400 units. An unbounded A* across it would freeze a tick, so the
 * search runs against an expansion budget and, when it runs out, returns the
 * best partial route it found. A unit that walks most of the way and asks
 * again is right; a simulation that stalls is not.
 */

import { ONE, fx } from "./fixed.ts";

/** `war3map.wpm` flag bits. */
export const NO_WALK = 0x02;
export const NO_FLY = 0x04;
export const NO_BUILD = 0x08;
export const BLIGHT = 0x20;
export const GROUND = 0x40;

/** Integer move costs. 10 orthogonal, 14 diagonal — 14/10 approximates sqrt 2. */
const COST_STRAIGHT = 10;
const COST_DIAGONAL = 14;

/** How far the "nearest standable cell" fallback is willing to look. */
const SNAP_RADIUS = 24;

/** Largest footprint the clearance map distinguishes; bigger units clamp to it. */
const MAX_CLEARANCE = 15;

export interface PathingMeta {
  width: number;
  height: number;
  /** World units per cell — 32 in every Warcraft III map. */
  cellSize: number;
  /** World-space position of the grid's south-west corner. */
  origin: [number, number];
}

export interface PathRequest {
  /** Fixed-point world coordinates. */
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  /** Unit radius in world units; decides how much clearance a cell needs. */
  radius?: number;
  /** Expansion ceiling for this call. */
  budget?: number;
}

export interface PathResult {
  /** Flat fixed-point waypoints: x0, y0, x1, y1, ... Empty when nothing was found. */
  points: number[];
  /** True when the goal itself was reached rather than the closest node to it. */
  complete: boolean;
  /** Nodes expanded, for instrumentation and for tuning the budget. */
  expanded: number;
  /**
   * False when no ground route to the goal exists at all.
   *
   * The caller wants this separated from "ran out of budget": an unreachable
   * order should be dropped, a truncated one should be resumed.
   */
  reachable: boolean;
}

/**
 * A binary min-heap of cell indices keyed by f-score.
 *
 * Ties break on the heap's own insertion counter rather than on anything
 * derived from the map, so the ordering is reproducible regardless of how the
 * host engine happens to sort equal keys.
 */
class Heap {
  private items = new Int32Array(1024);
  private keys = new Int32Array(1024);
  private order = new Int32Array(1024);
  private size = 0;
  private counter = 0;

  clear(): void {
    this.size = 0;
    this.counter = 0;
  }

  get length(): number {
    return this.size;
  }

  private grow(): void {
    const items = new Int32Array(this.items.length * 2);
    const keys = new Int32Array(this.keys.length * 2);
    const order = new Int32Array(this.order.length * 2);
    items.set(this.items);
    keys.set(this.keys);
    order.set(this.order);
    this.items = items;
    this.keys = keys;
    this.order = order;
  }

  private before(a: number, b: number): boolean {
    return this.keys[a] !== this.keys[b]
      ? this.keys[a] < this.keys[b]
      : this.order[a] < this.order[b];
  }

  private swap(a: number, b: number): void {
    const item = this.items[a];
    const key = this.keys[a];
    const seq = this.order[a];
    this.items[a] = this.items[b];
    this.keys[a] = this.keys[b];
    this.order[a] = this.order[b];
    this.items[b] = item;
    this.keys[b] = key;
    this.order[b] = seq;
  }

  push(item: number, key: number): void {
    if (this.size === this.items.length) this.grow();
    let i = this.size++;
    this.items[i] = item;
    this.keys[i] = key;
    this.order[i] = this.counter++;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!this.before(i, parent)) break;
      this.swap(i, parent);
      i = parent;
    }
  }

  pop(): number {
    const top = this.items[0];
    this.size--;
    if (this.size > 0) {
      this.items[0] = this.items[this.size];
      this.keys[0] = this.keys[this.size];
      this.order[0] = this.order[this.size];
      let i = 0;
      for (;;) {
        const left = i * 2 + 1;
        const right = left + 1;
        let best = i;
        if (left < this.size && this.before(left, best)) best = left;
        if (right < this.size && this.before(right, best)) best = right;
        if (best === i) break;
        this.swap(i, best);
        i = best;
      }
    }
    return top;
  }
}

export class PathGrid {
  readonly width: number;
  readonly height: number;
  readonly cellSize: number;
  readonly originX: number;
  readonly originY: number;
  readonly cells: Uint8Array;

  /**
   * Cells of open space around each cell, capped at MAX_CLEARANCE.
   *
   * Built once so the search can reject a cell for a wide unit with a single
   * lookup instead of scanning its footprint on every expansion. This is what
   * keeps a siege engine out of a one-cell gap a footman walks through.
   */
  private clearance: Uint8Array;

  // Search scratch, reused across calls: allocating 3.7M-element arrays per
  // order would cost more than the search itself. `stamp` marks which entries
  // belong to the current run, so nothing has to be cleared between calls.
  private gScore: Int32Array;
  private cameFrom: Int32Array;
  private stamp: Int32Array;
  private run = 0;
  private open = new Heap();

  constructor(meta: PathingMeta, cells: Uint8Array) {
    if (cells.length !== meta.width * meta.height) {
      throw new Error(
        `pathing grid is ${cells.length} cells, expected ${meta.width * meta.height}`,
      );
    }
    this.width = meta.width;
    this.height = meta.height;
    this.cellSize = meta.cellSize;
    this.originX = meta.origin[0];
    this.originY = meta.origin[1];
    this.cells = cells;

    const count = meta.width * meta.height;
    this.gScore = new Int32Array(count);
    this.cameFrom = new Int32Array(count);
    this.stamp = new Int32Array(count);
    this.clearance = this.buildClearance();
  }

  /**
   * Chebyshev distance to the nearest blocked cell, in two sweeps.
   *
   * The map border counts as blocked so units cannot be pathed off the edge.
   */
  private buildClearance(): Uint8Array {
    const { width, height, cells } = this;
    const out = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const index = y * width + x;
        if (cells[index] & NO_WALK) {
          out[index] = 0;
          continue;
        }
        if (x === 0 || y === 0) {
          out[index] = 1;
          continue;
        }
        const a = out[index - 1];
        const b = out[index - width];
        const c = out[index - width - 1];
        out[index] = Math.min(a, b, c, MAX_CLEARANCE - 1) + 1;
      }
    }
    for (let y = height - 1; y >= 0; y--) {
      for (let x = width - 1; x >= 0; x--) {
        const index = y * width + x;
        if (out[index] === 0) continue;
        if (x === width - 1 || y === height - 1) {
          out[index] = 1;
          continue;
        }
        const a = out[index + 1];
        const b = out[index + width];
        const c = out[index + width + 1];
        const limit = Math.min(a, b, c, MAX_CLEARANCE - 1) + 1;
        if (limit < out[index]) out[index] = limit;
      }
    }
    return out;
  }

  // -- coordinates ----------------------------------------------------------

  /** Fixed-point world X to cell column. */
  cellX(fxX: number): number {
    return Math.floor((fxX / ONE - this.originX) / this.cellSize);
  }

  cellY(fxY: number): number {
    return Math.floor((fxY / ONE - this.originY) / this.cellSize);
  }

  /** Centre of a cell, in fixed-point world coordinates. */
  centreX(cx: number): number {
    return fx(this.originX + (cx + 0.5) * this.cellSize);
  }

  centreY(cy: number): number {
    return fx(this.originY + (cy + 0.5) * this.cellSize);
  }

  inside(cx: number, cy: number): boolean {
    return cx >= 0 && cy >= 0 && cx < this.width && cy < this.height;
  }

  /** Flags byte, or NO_WALK for anything off the map. */
  flagsAt(cx: number, cy: number): number {
    if (!this.inside(cx, cy)) return NO_WALK | NO_FLY | NO_BUILD;
    return this.cells[cy * this.width + cx];
  }

  /** True when a unit of this footprint may stand with its centre on the cell. */
  standable(cx: number, cy: number, clearanceNeeded = 1): boolean {
    if (!this.inside(cx, cy)) return false;
    return this.clearance[cy * this.width + cx] >= clearanceNeeded;
  }

  /** World-space walkability test, for callers that never touch cells. */
  walkableAt(fxX: number, fxY: number, radius = 0): boolean {
    return this.standable(this.cellX(fxX), this.cellY(fxY), this.clearanceFor(radius));
  }

  /** How many cells of open space a unit of this radius needs around it. */
  clearanceFor(radius: number): number {
    if (radius <= 0) return 1;
    const cells = Math.ceil(radius / this.cellSize);
    return Math.max(1, Math.min(MAX_CLEARANCE, cells));
  }

  /**
   * Nearest cell the unit could actually stand on, searched in rings.
   *
   * Orders land on blocked cells constantly — a click on a cliff, a spawn
   * point inside a building's footprint, a target standing against a wall — and
   * the honest answer to "walk here" is the closest place that "here" allows.
   */
  snap(cx: number, cy: number, clearanceNeeded: number): number {
    if (this.standable(cx, cy, clearanceNeeded)) return cy * this.width + cx;
    for (let ring = 1; ring <= SNAP_RADIUS; ring++) {
      for (let dx = -ring; dx <= ring; dx++) {
        for (let dy = -ring; dy <= ring; dy++) {
          if (Math.abs(dx) !== ring && Math.abs(dy) !== ring) continue;
          const x = cx + dx;
          const y = cy + dy;
          if (this.standable(x, y, clearanceNeeded)) return y * this.width + x;
        }
      }
    }
    return -1;
  }

  // -- line of sight --------------------------------------------------------

  /**
   * Integer supercover line test between two cells.
   *
   * Used to pull the staircase out of a grid path. A diagonal step is only
   * accepted when both orthogonal neighbours are clear, matching the movement
   * rule the search itself uses, so smoothing can never produce a route that
   * clips a corner the search refused to cut.
   */
  lineOfSight(ax: number, ay: number, bx: number, by: number, clearanceNeeded: number): boolean {
    let x = ax;
    let y = ay;
    const dx = Math.abs(bx - ax);
    const dy = Math.abs(by - ay);
    const stepX = bx > ax ? 1 : -1;
    const stepY = by > ay ? 1 : -1;
    let error = dx - dy;

    if (!this.standable(x, y, clearanceNeeded)) return false;
    while (x !== bx || y !== by) {
      const doubled = error * 2;
      if (doubled > -dy && doubled < dx) {
        // Genuine diagonal: both orthogonal neighbours must be open.
        if (!this.standable(x + stepX, y, clearanceNeeded)) return false;
        if (!this.standable(x, y + stepY, clearanceNeeded)) return false;
        x += stepX;
        y += stepY;
        error += dx - dy;
      } else if (doubled > -dy) {
        x += stepX;
        error -= dy;
      } else {
        y += stepY;
        error += dx;
      }
      if (!this.standable(x, y, clearanceNeeded)) return false;
    }
    return true;
  }

  // -- the search -----------------------------------------------------------

  /** Octile distance, in the same integer units as the move costs. */
  private heuristic(ax: number, ay: number, bx: number, by: number): number {
    const dx = Math.abs(ax - bx);
    const dy = Math.abs(ay - by);
    const low = dx < dy ? dx : dy;
    const high = dx < dy ? dy : dx;
    return COST_STRAIGHT * (high - low) + COST_DIAGONAL * low;
  }

  find(request: PathRequest): PathResult {
    const clearanceNeeded = this.clearanceFor(request.radius ?? 0);
    const budget = request.budget ?? 12000;

    const startIndex = this.snap(
      this.cellX(request.fromX), this.cellY(request.fromY), clearanceNeeded);
    const goalIndex = this.snap(
      this.cellX(request.toX), this.cellY(request.toY), clearanceNeeded);
    if (startIndex < 0 || goalIndex < 0) {
      return { points: [], complete: false, expanded: 0, reachable: false };
    }
    if (startIndex === goalIndex) {
      return { points: [request.toX, request.toY], complete: true, expanded: 0, reachable: true };
    }
    if (!this.connected(startIndex, goalIndex, clearanceNeeded)) {
      return { points: [], complete: false, expanded: 0, reachable: false };
    }

    const { width } = this;
    const goalX = goalIndex % width;
    const goalY = (goalIndex / width) | 0;

    const run = ++this.run;
    const { gScore, cameFrom, stamp, open } = this;
    open.clear();
    gScore[startIndex] = 0;
    cameFrom[startIndex] = -1;
    stamp[startIndex] = run;
    open.push(startIndex, this.heuristic(startIndex % width, (startIndex / width) | 0, goalX, goalY));

    let expanded = 0;
    let bestIndex = startIndex;
    let bestHeuristic = this.heuristic(
      startIndex % width, (startIndex / width) | 0, goalX, goalY);
    let found = false;

    while (open.length > 0) {
      const current = open.pop();
      if (current === goalIndex) {
        found = true;
        break;
      }
      if (expanded++ >= budget) break;

      const cx = current % width;
      const cy = (current / width) | 0;
      const currentG = gScore[current];

      for (let direction = 0; direction < 8; direction++) {
        // Fixed order, so equal-cost expansions always resolve the same way.
        const dx = direction === 0 || direction === 4 || direction === 5 ? 1
          : direction === 1 || direction === 6 || direction === 7 ? -1 : 0;
        const dy = direction === 2 || direction === 4 || direction === 6 ? 1
          : direction === 3 || direction === 5 || direction === 7 ? -1 : 0;
        const nx = cx + dx;
        const ny = cy + dy;
        if (!this.standable(nx, ny, clearanceNeeded)) continue;

        const diagonal = dx !== 0 && dy !== 0;
        if (diagonal) {
          // No corner cutting: a unit may not slip between two blocked cells.
          if (!this.standable(cx + dx, cy, clearanceNeeded)) continue;
          if (!this.standable(cx, cy + dy, clearanceNeeded)) continue;
        }

        const neighbour = ny * width + nx;
        const tentative = currentG + (diagonal ? COST_DIAGONAL : COST_STRAIGHT);
        if (stamp[neighbour] === run && tentative >= gScore[neighbour]) continue;

        stamp[neighbour] = run;
        gScore[neighbour] = tentative;
        cameFrom[neighbour] = current;
        const remaining = this.heuristic(nx, ny, goalX, goalY);
        if (remaining < bestHeuristic) {
          bestHeuristic = remaining;
          bestIndex = neighbour;
        }
        open.push(neighbour, tentative + remaining);
      }
    }

    const endIndex = found ? goalIndex : bestIndex;
    if (endIndex === startIndex) {
      return { points: [], complete: false, expanded, reachable: true };
    }

    // Walk the parent chain back, then smooth it forwards.
    const chain: number[] = [];
    for (let index = endIndex; index !== -1; index = cameFrom[index]) {
      chain.push(index);
      if (index === startIndex) break;
    }
    chain.reverse();

    const points = this.smooth(chain, clearanceNeeded);
    if (found) {
      // Finish on the exact point that was asked for, not on a cell centre.
      points[points.length - 2] = request.toX;
      points[points.length - 1] = request.toY;
    }
    return { points, complete: found, expanded, reachable: true };
  }

  /**
   * String-pulling: drop every waypoint that the previous one can see past.
   *
   * A raw grid path is a staircase, and a unit walking a staircase looks
   * broken even when it arrives. Line of sight uses the same corner rule as
   * the search, so smoothing cannot introduce a route the search rejected.
   */
  private smooth(chain: number[], clearanceNeeded: number): number[] {
    const { width } = this;
    const points: number[] = [];
    let anchor = 0;
    points.push(this.centreX(chain[0] % width), this.centreY((chain[0] / width) | 0));

    for (let i = 2; i < chain.length; i++) {
      const ax = chain[anchor] % width;
      const ay = (chain[anchor] / width) | 0;
      const cx = chain[i] % width;
      const cy = (chain[i] / width) | 0;
      if (!this.lineOfSight(ax, ay, cx, cy, clearanceNeeded)) {
        anchor = i - 1;
        points.push(this.centreX(chain[anchor] % width), this.centreY((chain[anchor] / width) | 0));
      }
    }

    const last = chain[chain.length - 1];
    points.push(this.centreX(last % width), this.centreY((last / width) | 0));
    return points;
  }

  /**
   * Connected components of standable space, one labelling per footprint size.
   *
   * On an island map most orders are between places that no ground unit can
   * walk between at all, and A* answers that question the expensive way: it
   * exhausts its whole budget proving a negative. Labelling the components once
   * turns "is there a route" into two array reads, which is the difference
   * between a 25 ms stall per hopeless order and none.
   *
   * Labels use the same corner rule as the search, so a component is exactly
   * the set of cells the search can actually reach.
   */
  private components = new Map<number, Uint16Array>();

  private componentsFor(clearanceNeeded: number): Uint16Array | null {
    const cached = this.components.get(clearanceNeeded);
    if (cached) return cached;

    const { width, height } = this;
    const labels = new Uint16Array(width * height);
    const queue = new Int32Array(width * height);
    let next = 1;

    for (let start = 0; start < labels.length; start++) {
      if (labels[start] !== 0) continue;
      const sx = start % width;
      const sy = (start / width) | 0;
      if (!this.standable(sx, sy, clearanceNeeded)) continue;
      if (next > 0xfffe) {
        // More components than the label type can hold. Rather than silently
        // mislabel, drop the optimisation for this footprint.
        return null;
      }

      const label = next++;
      let head = 0;
      let tail = 0;
      queue[tail++] = start;
      labels[start] = label;
      while (head < tail) {
        const current = queue[head++];
        const cx = current % width;
        const cy = (current / width) | 0;
        for (let direction = 0; direction < 8; direction++) {
          const dx = direction === 0 || direction === 4 || direction === 5 ? 1
            : direction === 1 || direction === 6 || direction === 7 ? -1 : 0;
          const dy = direction === 2 || direction === 4 || direction === 6 ? 1
            : direction === 3 || direction === 5 || direction === 7 ? -1 : 0;
          const nx = cx + dx;
          const ny = cy + dy;
          if (!this.standable(nx, ny, clearanceNeeded)) continue;
          if (dx !== 0 && dy !== 0) {
            if (!this.standable(cx + dx, cy, clearanceNeeded)) continue;
            if (!this.standable(cx, cy + dy, clearanceNeeded)) continue;
          }
          const neighbour = ny * width + nx;
          if (labels[neighbour] !== 0) continue;
          labels[neighbour] = label;
          queue[tail++] = neighbour;
        }
      }
    }

    this.components.set(clearanceNeeded, labels);
    return labels;
  }

  /** True when a ground route between these cells can exist at all. */
  connected(startIndex: number, goalIndex: number, clearanceNeeded: number): boolean {
    const labels = this.componentsFor(clearanceNeeded);
    if (!labels) return true;           // labelling unavailable: let A* decide
    return labels[startIndex] === labels[goalIndex] && labels[startIndex] !== 0;
  }

  /** Number of separate walkable regions for a footprint — landmasses, mostly. */
  componentCount(radius = 0): number {
    const labels = this.componentsFor(this.clearanceFor(radius));
    if (!labels) return -1;
    let highest = 0;
    for (let i = 0; i < labels.length; i++) if (labels[i] > highest) highest = labels[i];
    return highest;
  }

  /** Cells a unit of this radius may stand on, for reporting and tests. */
  countStandable(radius = 0): number {
    const needed = this.clearanceFor(radius);
    let total = 0;
    for (let i = 0; i < this.clearance.length; i++) if (this.clearance[i] >= needed) total++;
    return total;
  }
}

/** Build a grid from the pipeline's `pathing.json` + `pathing.bin`. */
export function loadPathGrid(meta: PathingMeta, binary: ArrayBuffer | Uint8Array): PathGrid {
  const cells = binary instanceof Uint8Array ? binary : new Uint8Array(binary);
  return new PathGrid(meta, cells);
}
