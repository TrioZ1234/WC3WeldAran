/**
 * Trigger event registry.
 *
 * `TriggerRegister*` does not run anything — it records that a trigger cares
 * about a kind of event, optionally narrowed to one player, unit or region.
 * When the simulation later raises that event, this table answers "which
 * triggers should be evaluated, in what order".
 *
 * Registration order is preserved. Warcraft III fires triggers in the order
 * they were registered, and map scripts are written around that; a Set or a
 * hash bucket would quietly reorder them.
 */

import type { JassHandle } from "../jass/values.ts";

export interface Registration {
  /** Monotonic, so ordering survives filtering. */
  seq: number;
  trigger: JassHandle;
  /** Event constant, rendered as its handle key (e.g. `playerunitevent#1048600`). */
  event: string;
  player: JassHandle | null;
  unit: JassHandle | null;
  rect: JassHandle | null;
  filter: JassHandle | null;
  chat: string | null;
  chatExact: boolean;
}

export interface EventContext {
  player?: JassHandle | null;
  unit?: JassHandle | null;
  rect?: JassHandle | null;
  chat?: string;
}

export class EventTable {
  private registrations: Registration[] = [];
  private byEvent = new Map<string, Registration[]>();
  private sequence = 0;

  get size(): number {
    return this.registrations.length;
  }

  register(entry: Omit<Registration, "seq">): Registration {
    const record: Registration = { ...entry, seq: this.sequence++ };
    this.registrations.push(record);
    let bucket = this.byEvent.get(record.event);
    if (!bucket) {
      bucket = [];
      this.byEvent.set(record.event, bucket);
    }
    bucket.push(record);
    return record;
  }

  /** Registrations for an event, narrowed by whatever scope the context supplies. */
  match(event: string, context: EventContext = {}): Registration[] {
    const bucket = this.byEvent.get(event);
    if (!bucket) return [];
    return bucket.filter((entry) => {
      if (entry.player && context.player && entry.player !== context.player) return false;
      if (entry.unit && context.unit && entry.unit !== context.unit) return false;
      if (entry.rect && context.rect && entry.rect !== context.rect) return false;
      if (entry.chat !== null && context.chat !== undefined) {
        return entry.chatExact ? context.chat === entry.chat : context.chat.startsWith(entry.chat);
      }
      return true;
    });
  }

  /** How many registrations exist per event kind — useful for a readiness report. */
  summary(): Array<{ event: string; count: number }> {
    return [...this.byEvent.entries()]
      .map(([event, entries]) => ({ event, count: entries.length }))
      .sort((a, b) => b.count - a.count);
  }
}
