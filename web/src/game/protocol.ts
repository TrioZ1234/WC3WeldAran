/**
 * The message contract between the interface and the simulation worker.
 *
 * The boundary is explicit on purpose (see docs/04-frontends.md): the
 * simulation must never hold a reference into interface state, because the
 * moment it does, moving the core to Rust or across a network socket stops
 * being a port and becomes a rewrite.
 *
 * State crosses as flat typed arrays, not objects. Three thousand units at
 * 32 Hz is the volume this has to survive, and allocating three thousand
 * objects per snapshot would spend more time in the garbage collector than in
 * the game.
 */

import type { MatchConfig } from "./match-config.ts";

// -- interface -> simulation ------------------------------------------------

export type OrderKind = "move" | "attack" | "stop" | "hold";

export type ToSim =
  | { type: "boot"; config: MatchConfig; dataRoot: string }
  | { type: "start" }
  | { type: "pause"; paused: boolean }
  | { type: "speed"; speed: number }
  | { type: "select"; units: number[] }
  | { type: "order"; kind: OrderKind; units: number[]; x: number; y: number }
  | { type: "shutdown" };

// -- simulation -> interface ------------------------------------------------

export type LoadStage = "scripts" | "objects" | "world" | "spawn" | "done";

/** Number of floats each unit occupies in a snapshot's `units` array. */
export const UNIT_STRIDE = 8;

/**
 * Snapshot unit layout, one entry per living unit:
 *
 *   0 id          stable handle, used to address orders back at the worker
 *   1 owner       player slot, 0..11, or 12/15 for the neutrals
 *   2 x           world coordinates, already converted out of fixed point
 *   3 y
 *   4 typeIndex   index into the snapshot's type table
 *   5 hp          0..1 fraction of maximum
 *   6 facing      radians
 *   7 flags       bit 0 selected, bit 1 attacking, bit 2 is a building
 */
export const UNIT_FLAG_SELECTED = 1;
export const UNIT_FLAG_ATTACKING = 2;
export const UNIT_FLAG_BUILDING = 4;

/** Number of floats each player occupies in a snapshot's `players` array. */
export const PLAYER_STRIDE = 6;

/**
 * Snapshot player layout, one entry per slot 0..11:
 *
 *   0 gold
 *   1 lumber
 *   2 unitCount
 *   3 kills
 *   4 losses
 *   5 alive        1 while the player still holds anything
 */

export interface Snapshot {
  tick: number;
  /** Game clock in seconds, derived from the tick count, never accumulated. */
  seconds: number;
  units: Float32Array;
  unitCount: number;
  players: Float32Array;
  /** Seconds until the next city spawn wave. */
  nextSpawn: number;
  /** Units the simulation is carrying but not drawing, for the diagnostics line. */
  totalUnits: number;
  /** Wall-clock milliseconds the last batch of ticks took, for the speed readout. */
  simMs: number;
}

export interface MatchOutcome {
  victory: boolean;
  /** Slots still standing when the match ended. */
  survivors: number[];
  seconds: number;
  reason: string;
}

export type FromSim =
  | { type: "progress"; stage: LoadStage; percent: number; note: string }
  | { type: "ready"; typeNames: string[]; note: string; degraded: boolean }
  | { type: "snapshot"; snapshot: Snapshot }
  | { type: "log"; text: string; slot?: number }
  | { type: "over"; outcome: MatchOutcome }
  | { type: "failed"; message: string };
