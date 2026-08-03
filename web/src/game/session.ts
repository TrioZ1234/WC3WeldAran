/**
 * The interface's handle on a running match.
 *
 * Owns the worker, keeps the newest snapshot, and turns player intent into
 * messages. Nothing here knows how the simulation works, and the simulation
 * knows nothing about here - that is the point, and it is what makes the same
 * class serve a network socket later without changes to either side.
 */

import type {
  FromSim,
  LoadStage,
  MatchOutcome,
  OrderKind,
  Snapshot,
  ToSim,
} from "./protocol.ts";
import type { MatchConfig } from "./match-config.ts";
import { localSlot } from "./match-config.ts";

export interface SessionHandlers {
  onProgress?: (stage: LoadStage, percent: number, note: string) => void;
  onReady?: (note: string, degraded: boolean) => void;
  onSnapshot?: (snapshot: Snapshot) => void;
  onLog?: (text: string, slot?: number) => void;
  onOver?: (outcome: MatchOutcome) => void;
  onFailed?: (message: string) => void;
}

export class Session {
  /** Newest snapshot, or null before the first tick. */
  snapshot: Snapshot | null = null;
  /** Unit type names, indexed by the snapshot's `typeIndex` column. */
  typeNames: string[] = [];
  /** True when the match is a training skirmish rather than the map itself. */
  degraded = false;
  paused = false;
  speed: 1 | 2 | 4 = 1;

  private worker: Worker;
  private selection: number[] = [];
  private over: MatchOutcome | null = null;

  constructor(
    readonly config: MatchConfig,
    private handlers: SessionHandlers,
    dataRoot = "/data",
  ) {
    this.worker = new Worker(new URL("../worker/sim.worker.ts", import.meta.url), {
      type: "module",
    });
    this.worker.onmessage = (event: MessageEvent<FromSim>) => this.receive(event.data);
    this.worker.onerror = (event) =>
      this.handlers.onFailed?.(event.message || "сбой в потоке симуляции");
    this.send({ type: "boot", config, dataRoot });
  }

  get localPlayer(): number {
    return localSlot(this.config)?.slot ?? 0;
  }

  get finished(): MatchOutcome | null {
    return this.over;
  }

  private send(message: ToSim): void {
    this.worker.postMessage(message);
  }

  private receive(message: FromSim): void {
    switch (message.type) {
      case "progress":
        this.handlers.onProgress?.(message.stage, message.percent, message.note);
        break;
      case "ready":
        this.typeNames = message.typeNames;
        this.degraded = message.degraded;
        this.handlers.onReady?.(message.note, message.degraded);
        break;
      case "snapshot":
        this.snapshot = message.snapshot;
        this.handlers.onSnapshot?.(message.snapshot);
        break;
      case "log":
        this.handlers.onLog?.(message.text, message.slot);
        break;
      case "over":
        this.over = message.outcome;
        this.handlers.onOver?.(message.outcome);
        break;
      case "failed":
        this.handlers.onFailed?.(message.message);
        break;
    }
  }

  // -- control --------------------------------------------------------------

  start(): void {
    this.send({ type: "start" });
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
    this.send({ type: "pause", paused });
  }

  togglePause(): boolean {
    this.setPaused(!this.paused);
    return this.paused;
  }

  setSpeed(speed: 1 | 2 | 4): void {
    this.speed = speed;
    this.send({ type: "speed", speed });
  }

  select(ids: number[]): void {
    this.selection = ids;
    this.send({ type: "select", units: ids });
  }

  get selected(): number[] {
    return this.selection;
  }

  order(kind: OrderKind, x: number, y: number): void {
    if (this.selection.length === 0) return;
    this.send({ type: "order", kind, units: this.selection, x, y });
  }

  dispose(): void {
    this.send({ type: "shutdown" });
    this.worker.terminate();
  }
}
