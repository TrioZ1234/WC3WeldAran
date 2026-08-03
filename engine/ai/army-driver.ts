/**
 * Army driver for computer players.
 *
 * Deliberately small, because the map does the hard part already. War for
 * WeldAran is not a melee map: cities spawn a squad for their owner every 90
 * seconds, and 698 `SetUnitAcquireRange` calls mean units pick their own fights
 * once they are close enough. What the original relied on Warcraft III for was
 * only the march - moving the squad from where it appeared to somewhere worth
 * fighting. That is what this file supplies.
 *
 * So there is no base building, no economy, no scouting. Gather the idle units,
 * send them at the nearest enemy structure, let acquisition do the rest.
 *
 * Determinism rules apply as everywhere in the simulation: integer arithmetic,
 * no `Math.random`, and iteration in a stable order so that two clients given
 * the same inputs issue the same orders on the same tick.
 */

import type { Battlefield, SimUnit } from "../sim/units.ts";
import { TICKS_PER_SECOND } from "../sim/scheduler.ts";
import { unfx } from "../sim/fixed.ts";

export interface BotProfile {
  /** Player slot this profile drives. */
  slot: number;
  /** Percent applied to hit points and damage, 100 leaves the map's numbers alone. */
  handicap: number;
  /** Seconds the bot lets a squad gather before committing it. */
  regroupSeconds: number;
  /** Units required before the bot marches. */
  waveSize: number;
}

interface BotState {
  profile: BotProfile;
  /** Tick the bot is allowed to launch its next attack on. */
  nextLaunchTick: number;
  /** Ids already adjusted for handicap, so the scaling is applied exactly once. */
  adjusted: Set<number>;
}

/** A unit that is standing around: alive, mobile, no target, no destination. */
function isIdle(unit: SimUnit): boolean {
  return (
    unit.alive &&
    unit.stats.speed > 0 &&
    unit.target === null &&
    unit.orderX === null &&
    unit.orderY === null
  );
}

/** Immobile units are the map's cities, towers and halls - the things worth taking. */
const isStructure = (unit: SimUnit): boolean => unit.stats.speed <= 0;

export class ArmyDriver {
  private states: BotState[] = [];
  /** Ticks between decisions. One second is far finer than the 90 s spawn cycle. */
  private readonly interval = TICKS_PER_SECOND;
  private field: Battlefield;
  private hostile: (a: number, b: number) => boolean;

  constructor(
    field: Battlefield,
    profiles: BotProfile[],
    hostile: (a: number, b: number) => boolean,
  ) {
    this.field = field;
    this.hostile = hostile;
    // Sorted by slot so the order of decisions never depends on lobby order.
    for (const profile of [...profiles].sort((a, b) => a.slot - b.slot)) {
      this.states.push({
        profile,
        nextLaunchTick: profile.regroupSeconds * TICKS_PER_SECOND,
        adjusted: new Set(),
      });
    }
  }

  /**
   * Advance every bot. Safe to call each tick; the work is gated internally so
   * the cost is one pass per second rather than thirty-two.
   */
  step(tick: number): void {
    for (const state of this.states) this.applyHandicap(state);
    if (tick % this.interval !== 0) return;
    for (const state of this.states) this.decide(state, tick);
  }

  /**
   * Scale a bot's units the moment they appear.
   *
   * Difficulty has to act on the units themselves rather than on the decisions,
   * because the decisions are already about as good as this map needs. Stats are
   * shared per unit type, so a per-unit copy is made before it is changed -
   * otherwise raising one bot's damage would raise it for every player.
   */
  private applyHandicap(state: BotState): void {
    const percent = state.profile.handicap;
    if (percent === 100) return;
    for (const unit of this.field.units) {
      if (unit.owner !== state.profile.slot || state.adjusted.has(unit.id)) continue;
      state.adjusted.add(unit.id);
      if (!unit.alive) continue;

      const scaled = { ...unit.stats };
      scaled.maxHp = Math.max(1, Math.trunc((scaled.maxHp * percent) / 100));
      scaled.damageBase = Math.trunc((scaled.damageBase * percent) / 100);
      unit.stats = scaled;
      // Scale current hit points by the same factor so a fresh unit is full.
      unit.hp = Math.trunc((unit.hp * percent) / 100);
    }
  }

  private decide(state: BotState, tick: number): void {
    if (tick < state.nextLaunchTick) return;

    const squad: SimUnit[] = [];
    for (const unit of this.field.units) {
      if (unit.owner === state.profile.slot && isIdle(unit)) squad.push(unit);
    }
    if (squad.length < state.profile.waveSize) return;

    const objective = this.chooseObjective(state.profile.slot, squad);
    if (!objective) return;

    for (const unit of squad) this.field.order(unit, objective.x, objective.y);
    state.nextLaunchTick = tick + state.profile.regroupSeconds * TICKS_PER_SECOND;
  }

  /**
   * Pick where the squad goes: the closest hostile structure, or failing that
   * the closest hostile unit.
   *
   * Structures are preferred because they are what the map scores on - cities
   * spawn the armies, so taking one both removes the enemy's income and adds to
   * yours. Chasing units instead produces bots that wander.
   *
   * Distance is measured from the squad's integer centre so that the choice does
   * not depend on which unit happens to be first in the list.
   */
  private chooseObjective(slot: number, squad: SimUnit[]): { x: number; y: number } | null {
    let sumX = 0;
    let sumY = 0;
    for (const unit of squad) {
      sumX += Math.trunc(unfx(unit.x));
      sumY += Math.trunc(unfx(unit.y));
    }
    const centreX = Math.trunc(sumX / squad.length);
    const centreY = Math.trunc(sumY / squad.length);

    let bestStructure: SimUnit | null = null;
    let bestStructureDistance = Number.MAX_SAFE_INTEGER;
    let bestUnit: SimUnit | null = null;
    let bestUnitDistance = Number.MAX_SAFE_INTEGER;

    for (const other of this.field.units) {
      if (!other.alive || !this.hostile(slot, other.owner)) continue;
      const dx = Math.trunc(unfx(other.x)) - centreX;
      const dy = Math.trunc(unfx(other.y)) - centreY;
      const distance = dx * dx + dy * dy;
      if (isStructure(other)) {
        if (distance < bestStructureDistance) {
          bestStructureDistance = distance;
          bestStructure = other;
        }
      } else if (distance < bestUnitDistance) {
        bestUnitDistance = distance;
        bestUnit = other;
      }
    }

    const target = bestStructure ?? bestUnit;
    if (!target) return null;
    return { x: Math.trunc(unfx(target.x)), y: Math.trunc(unfx(target.y)) };
  }
}
