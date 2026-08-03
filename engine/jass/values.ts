/**
 * Runtime value model.
 *
 * Values carry their JASS type alongside the payload. That costs an allocation
 * per operation, but it buys correct `integer` vs `real` semantics — notably
 * that `7 / 2` is 3 for integers and 3.5 for reals. Getting that wrong silently
 * corrupts damage and gold arithmetic, so the type tag is worth its price until
 * a bytecode compiler can resolve types statically.
 */

export interface JassValue {
  t: string;
  v: unknown;
}

/** Opaque runtime object: unit, trigger, group, rect, hashtable, and friends. */
export class JassHandle {
  id: number;
  type: string;
  data: Map<string, unknown>;

  constructor(id: number, type: string) {
    this.id = id;
    this.type = type;
    this.data = new Map();
  }

  toString(): string {
    return `${this.type}#${this.id}`;
  }
}

/** A `code` value — a reference to a function by name. */
export class JassCode {
  name: string;
  constructor(name: string) {
    this.name = name;
  }
  toString(): string {
    return `code:${this.name}`;
  }
}

// JASS integers are 32-bit signed; `| 0` reproduces the wraparound exactly.
export const INT = (n: number): JassValue => ({ t: "integer", v: n | 0 });
export const REAL = (n: number): JassValue => ({ t: "real", v: n });
export const STR = (s: string): JassValue => ({ t: "string", v: s });
export const BOOL = (b: boolean): JassValue => ({ t: "boolean", v: b });
export const NOTHING: JassValue = { t: "nothing", v: null };
export const NULLV: JassValue = { t: "null", v: null };
export const HANDLE = (h: JassHandle): JassValue => ({ t: h.type, v: h });
export const CODE = (c: JassCode): JassValue => ({ t: "code", v: c });

export const isNumeric = (t: string): boolean => t === "integer" || t === "real";

/** Numeric payload of a value, tolerating nulls so stubbed natives cannot poison arithmetic with NaN. */
export function asNumber(value: JassValue): number {
  if (typeof value.v === "number") return value.v;
  if (typeof value.v === "boolean") return value.v ? 1 : 0;
  return 0;
}

export function asBool(value: JassValue): boolean {
  if (typeof value.v === "boolean") return value.v;
  if (typeof value.v === "number") return value.v !== 0;
  return value.v !== null && value.v !== undefined;
}

export function asString(value: JassValue): string {
  if (value.v === null || value.v === undefined) return "null";
  if (typeof value.v === "string") return value.v;
  if (typeof value.v === "number") {
    // JASS prints reals with a decimal part; integers without.
    return value.t === "real" ? formatReal(value.v) : String(value.v | 0);
  }
  if (typeof value.v === "boolean") return value.v ? "true" : "false";
  return String(value.v);
}

/** Warcraft III renders reals with three decimal places by default. */
export function formatReal(n: number): string {
  return n.toFixed(3);
}

/** Default value for a declared type, used for globals, locals and array slots. */
export function defaultFor(type: string): JassValue {
  switch (type) {
    case "integer": return INT(0);
    case "real": return REAL(0);
    case "boolean": return BOOL(false);
    case "string": return STR("");
    default: return NULLV;
  }
}

/**
 * Deterministic PRNG (mulberry32).
 *
 * The engine must never touch `Math.random`: lockstep networking requires every
 * client to produce an identical sequence from the same seed.
 */
export class Random {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  int(low: number, high: number): number {
    if (high < low) return low;
    return low + Math.floor(this.next() * (high - low + 1));
  }

  real(low: number, high: number): number {
    return low + this.next() * (high - low);
  }
}
