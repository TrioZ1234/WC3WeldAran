/**
 * Simulation clock and timer queue.
 *
 * Time advances in fixed ticks of 1/32 s, the same rate Warcraft III uses. The
 * map depends on this: it ships its own 32 Hz heartbeat (`T32_PERIOD=0.03125`)
 * and schedules periodic work against it, so a different rate would silently
 * change gameplay speed.
 *
 * Ticks are integers, never accumulated floats. Summing 0.03125 repeatedly
 * drifts, and drift across clients is a desync in a lockstep game.
 */

import type { JassHandle, JassCode } from "../jass/values.ts";

export const TICKS_PER_SECOND = 32;
export const TICK_SECONDS = 1 / TICKS_PER_SECOND;

export interface ScheduledTimer {
  handle: JassHandle;
  dueTick: number;
  /** Repeat interval in ticks, or null for a one-shot. */
  periodTicks: number | null;
  handler: JassCode | null;
  paused: boolean;
  /** Ticks left when paused, so resume continues rather than restarts. */
  remaining: number;
}

/** Convert seconds to whole ticks, never rounding a positive delay down to zero. */
export function toTicks(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds <= 0) return 1;
  return Math.max(1, Math.round(seconds * TICKS_PER_SECOND));
}

export class Clock {
  tick = 0;
  /** Total timer callbacks fired since start. */
  fired = 0;

  private timers = new Map<JassHandle, ScheduledTimer>();

  get seconds(): number {
    return this.tick * TICK_SECONDS;
  }

  get pending(): number {
    return this.timers.size;
  }

  /** Format the clock the way the game HUD would. */
  get formatted(): string {
    const total = Math.floor(this.seconds);
    const minutes = String(Math.floor(total / 60)).padStart(2, "0");
    const seconds = String(total % 60).padStart(2, "0");
    return `${minutes}:${seconds}`;
  }

  start(handle: JassHandle, timeoutSeconds: number, periodic: boolean, handler: JassCode | null): void {
    const ticks = toTicks(timeoutSeconds);
    this.timers.set(handle, {
      handle,
      dueTick: this.tick + ticks,
      periodTicks: periodic ? ticks : null,
      handler,
      paused: false,
      remaining: ticks,
    });
  }

  pause(handle: JassHandle): void {
    const timer = this.timers.get(handle);
    if (timer && !timer.paused) {
      timer.paused = true;
      timer.remaining = Math.max(1, timer.dueTick - this.tick);
    }
  }

  resume(handle: JassHandle): void {
    const timer = this.timers.get(handle);
    if (timer && timer.paused) {
      timer.paused = false;
      timer.dueTick = this.tick + timer.remaining;
    }
  }

  remove(handle: JassHandle): void {
    this.timers.delete(handle);
  }

  remaining(handle: JassHandle): number {
    const timer = this.timers.get(handle);
    if (!timer) return 0;
    if (timer.paused) return timer.remaining * TICK_SECONDS;
    return Math.max(0, timer.dueTick - this.tick) * TICK_SECONDS;
  }

  elapsed(handle: JassHandle): number {
    const timer = this.timers.get(handle);
    if (!timer || timer.periodTicks === null) return 0;
    return (timer.periodTicks - Math.max(0, timer.dueTick - this.tick)) * TICK_SECONDS;
  }

  /**
   * Collect the timers due at the current tick and reschedule the periodic ones.
   *
   * The list is snapshotted before any callback runs, so a handler that starts
   * new timers cannot extend the current tick into an infinite loop.
   */
  /**
   * Every repeating timer, as period and time left.
   *
   * The HUD needs this: the map's city spawn runs on a 90-second periodic timer,
   * and a countdown to the next wave is one of the few numbers a player watches
   * constantly. Reading it from the clock keeps one source of truth - a second
   * counter maintained alongside would drift, and the visible one would be wrong.
   */
  periodic(): Array<{ period: number; remaining: number }> {
    const found: Array<{ period: number; remaining: number }> = [];
    for (const timer of this.timers.values()) {
      if (timer.periodTicks === null) continue;
      const left = timer.paused ? timer.remaining : Math.max(0, timer.dueTick - this.tick);
      found.push({ period: timer.periodTicks * TICK_SECONDS, remaining: left * TICK_SECONDS });
    }
    return found;
  }

  takeDue(): ScheduledTimer[] {
    const due: ScheduledTimer[] = [];
    for (const timer of this.timers.values()) {
      if (!timer.paused && timer.dueTick <= this.tick) due.push(timer);
    }
    for (const timer of due) {
      if (timer.periodTicks === null) this.timers.delete(timer.handle);
      else timer.dueTick = this.tick + timer.periodTicks;
    }
    this.fired += due.length;
    return due;
  }

  advance(): void {
    this.tick++;
  }
}
