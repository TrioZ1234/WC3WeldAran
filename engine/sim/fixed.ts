/**
 * Fixed-point arithmetic for the simulation.
 *
 * Every number that can affect the outcome of a match lives here: positions,
 * hit points, damage, movement. Not because floats are imprecise, but because
 * they are imprecise *differently* on different machines and JIT paths. In a
 * lockstep game — which is the stated goal for 12 players — one client landing
 * on 99.9999999 where another lands on 100.0 is a desync, and a desync twenty
 * minutes into a match is the most expensive bug in the genre.
 *
 * Representation: a 32-bit-ish integer where 1 world unit = 256. JavaScript
 * numbers hold integers exactly up to 2^53, and the largest intermediate here
 * is a squared distance across the map (61 440 * 256)^2 ≈ 2.5e14, comfortably
 * inside that. Every operation truncates deterministically.
 */

/** Fixed-point units per world unit. A power of two keeps division exact. */
export const ONE = 256;

export const fx = (n: number): number => Math.round(n * ONE) | 0;
export const unfx = (n: number): number => n / ONE;

export const fxMul = (a: number, b: number): number => Math.trunc((a * b) / ONE);
export const fxDiv = (a: number, b: number): number => (b === 0 ? 0 : Math.trunc((a * ONE) / b));

/**
 * Integer square root by Newton's method.
 *
 * `Math.sqrt` is not guaranteed to be bit-identical across engines, so it must
 * not appear anywhere in the simulation path.
 */
export function isqrt(value: number): number {
  if (value <= 0) return 0;
  if (value < 2) return value;
  let guess = value;
  let next = Math.trunc((guess + 1) / 2);
  while (next < guess) {
    guess = next;
    next = Math.trunc((guess + Math.trunc(value / guess)) / 2);
  }
  return guess;
}

/** Distance between two fixed-point points, in fixed-point units. */
export function fxDistance(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax - bx;
  const dy = ay - by;
  return isqrt(dx * dx + dy * dy);
}

/** Squared distance — use this for comparisons to avoid the square root entirely. */
export function fxDistanceSquared(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
}
