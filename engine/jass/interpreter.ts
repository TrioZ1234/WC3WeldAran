/**
 * Tree-walking JASS interpreter with suspendable threads.
 *
 * The execution path is built from generators so that `TriggerSleepAction` can
 * suspend a running script mid-statement and resume it many ticks later. That
 * is not a nicety: `PolledWait` in Blizzard.j is a busy loop that only makes
 * progress because the thread sleeps inside it, and the map calls into it. A
 * synchronous walker spins there forever.
 *
 * Threads are cooperative and single-stepped by the simulation clock, matching
 * Warcraft III's model: nothing preempts, and a sleeping thread resumes at a
 * tick boundary.
 *
 * Two behaviours are faithful to the original on purpose:
 *   - `and` / `or` evaluate BOTH operands. JASS does not short-circuit.
 *   - integer `/` truncates; real division only when an operand is real.
 */

import { parseJass } from "./parser.ts";
import { buildNatives, World, EXTERNAL_CONSTANTS } from "./natives.ts";
import type { NativeFn, NativeContext } from "./natives.ts";
import { Clock } from "../sim/scheduler.ts";
import { EventTable } from "../sim/events.ts";
import type { EventContext } from "../sim/events.ts";
import {
  JassHandle, JassCode, Random,
  INT, REAL, STR, BOOL, NULLV, NOTHING, HANDLE, CODE,
  asNumber, asBool, asString, defaultFor,
} from "./values.ts";
import type { JassValue } from "./values.ts";
import type { Program, FuncDecl, NativeDecl, Stmt, Expr } from "./ast.ts";

export class JassRuntimeError extends Error {
  line: number;
  fn: string;
  constructor(message: string, line: number, fn: string) {
    super(`${message} (in ${fn}, line ${line})`);
    this.name = "JassRuntimeError";
    this.line = line;
    this.fn = fn;
  }
}

interface Slot {
  type: string;
  isArray: boolean;
  value: JassValue;
  array: JassValue[] | null;
}

/** Non-linear control flow bubbling out of a statement list. */
type Flow = null | { kind: "return"; value: JassValue } | { kind: "exit" };

/** The only thing a running thread can yield: a request to be resumed later. */
interface SleepRequest { seconds: number }

type Exec<T> = Generator<SleepRequest, T, void>;

/** A suspended or running JASS thread. */
export interface Thread {
  id: number;
  name: string;
  generator: Exec<unknown>;
  wakeTick: number;
  steps: number;
  done: boolean;
}

export interface RunOptions {
  /** Statement budget per thread. Catches runaway loops without killing the world. */
  maxStepsPerThread?: number;
  maxDepth?: number;
  seed?: number;
  trace?: boolean;
}

/** One script in the load order. */
export interface JassSource {
  name: string;
  text: string;
}

export class Interpreter implements NativeContext {
  program: Program;
  functions = new Map<string, FuncDecl>();
  globals = new Map<string, Slot>();
  natives: Map<string, NativeFn>;
  world = new World();
  random: Random;
  event = new Map<string, JassValue>();
  clock = new Clock();
  events = new EventTable();

  // Instrumentation.
  implementedCalls = new Map<string, number>();
  stubCalls = new Map<string, number>();
  firstSeen: string[] = [];
  externals = new Map<string, JassValue>();
  trace: string[] = [];
  loaded: Array<{ name: string; functions: number; globals: number; natives: number }> = [];
  nativeSignatures = new Map<string, NativeDecl>();
  handleTypes = new Set<string>();
  triggersEvaluated = 0;
  triggersExecuted = 0;
  tickErrors: Array<{ tick: number; message: string }> = [];

  /** Threads currently sleeping, waiting for their wake tick. */
  threads: Thread[] = [];
  /** Threads that slept and later resumed — proof coroutines are in use. */
  sleepsHonoured = 0;
  /** Sleeps requested from inside a native callback, where WC3 also ignores them. */
  sleepsIgnored = 0;

  private handles: JassHandle[] = [];
  private nextHandleId = 0x100000;
  private enumHandles = new Map<string, JassHandle>();
  private steps = 0;
  private threadSteps = 0;
  private depth = 0;
  private maxStepsPerThread: number;
  private maxDepth: number;
  private traceEnabled: boolean;
  private currentFn = "<init>";
  private nextThreadId = 1;
  /** True while running inside a native callback, where a sleep cannot suspend. */
  private insideNative = 0;

  /**
   * Load one or more scripts in order: `common.j`, `Blizzard.j`, then the map.
   * Later files win on name collisions, exactly as Warcraft III allows.
   */
  constructor(sources: string | JassSource[], options: RunOptions = {}) {
    const list: JassSource[] = typeof sources === "string"
      ? [{ name: "<script>", text: sources }]
      : sources;

    this.program = { globals: [], functions: [], natives: [], types: [] };
    for (const source of list) {
      const parsed = parseJass(source.text);
      this.program.globals.push(...parsed.globals);
      this.program.functions.push(...parsed.functions);
      this.program.natives.push(...parsed.natives);
      this.program.types.push(...parsed.types);
      this.loaded.push({
        name: source.name, functions: parsed.functions.length,
        globals: parsed.globals.length, natives: parsed.natives.length,
      });
    }

    this.natives = buildNatives();
    this.maxStepsPerThread = options.maxStepsPerThread ?? 2_000_000;
    this.maxDepth = options.maxDepth ?? 400;
    this.traceEnabled = options.trace ?? false;
    this.random = new Random(options.seed ?? 0x5eed);

    for (const fn of this.program.functions) this.functions.set(fn.name, fn);
    for (const decl of this.program.natives) this.nativeSignatures.set(decl.name, decl);
    for (const decl of this.program.types) this.handleTypes.add(decl.name);

    this.installEventNatives();
    this.declareGlobals();
  }

  // -- NativeContext ------------------------------------------------------

  createHandle(type: string): JassHandle {
    const handle = new JassHandle(this.nextHandleId++, type);
    this.handles.push(handle);
    return handle;
  }

  enumHandle(kind: string, key: number | string): JassHandle {
    const id = `${kind}:${key}`;
    let handle = this.enumHandles.get(id);
    if (!handle) {
      handle = new JassHandle(this.nextHandleId++, kind);
      handle.data.set("key", key);
      this.enumHandles.set(id, handle);
    }
    return handle;
  }

  /** Synchronous entry point for natives. A sleep requested here cannot suspend. */
  callByName(name: string, args: JassValue[]): JassValue {
    this.insideNative++;
    try {
      return this.drive(this.invoke(name, args, 0));
    } finally {
      this.insideNative--;
    }
  }

  callCode(code: JassCode | null, args: JassValue[]): JassValue {
    if (!code) return NOTHING;
    return this.callByName(code.name, args);
  }

  /**
   * Run a trigger's conditions and combine them with AND.
   *
   * vJASS libraries hang periodic work off conditions rather than actions
   * because conditions skip the action queue, so this must genuinely execute:
   * the map's 32 Hz heartbeat is a bare `TriggerEvaluate`.
   */
  evaluateTrigger(trigger: JassHandle): boolean {
    this.triggersEvaluated++;
    if (trigger.data.get("enabled") === false) return false;
    const conditions = (trigger.data.get("conditions") as JassHandle[] | undefined) ?? [];
    let result = true;
    for (const condition of conditions) {
      const code = condition.data.get("code");
      if (!asBool(this.callCode(code instanceof JassCode ? code : null, []))) result = false;
    }
    return result;
  }

  /** Run a trigger's actions as their own thread, so an action may sleep. */
  executeTrigger(trigger: JassHandle): void {
    this.triggersExecuted++;
    if (trigger.data.get("enabled") === false) return;
    const actions = (trigger.data.get("actions") as JassCode[] | undefined) ?? [];
    for (const action of actions) {
      const previous = this.event.get("triggeringTrigger");
      this.event.set("triggeringTrigger", HANDLE(trigger));
      this.spawn(action.name);
      if (previous) this.event.set("triggeringTrigger", previous);
      else this.event.delete("triggeringTrigger");
    }
  }

  private installEventNatives(): void {
    const read = (key: string): NativeFn => () => this.event.get(key) ?? NULLV;
    for (const [name, key] of [
      ["GetEnumPlayer", "enumPlayer"], ["GetEnumUnit", "enumUnit"],
      ["GetTriggerUnit", "triggerUnit"], ["GetTriggerPlayer", "triggerPlayer"],
      ["GetTriggeringTrigger", "triggeringTrigger"], ["GetFilterUnit", "filterUnit"],
      ["GetSpellAbilityUnit", "triggerUnit"], ["GetExpiredTimer", "expiredTimer"],
      ["GetEnumDestructable", "enumDestructable"], ["GetEnumItem", "enumItem"],
      ["GetDyingUnit", "triggerUnit"], ["GetKillingUnit", "killingUnit"],
      ["GetEnteringUnit", "triggerUnit"], ["GetLeavingUnit", "triggerUnit"],
      ["GetEventDamageSource", "damageSource"],
    ] as Array<[string, string]>) {
      this.natives.set(name, read(key));
    }
  }

  // -- globals ------------------------------------------------------------

  private declareGlobals(): void {
    for (const global of this.program.globals) {
      this.globals.set(global.name, {
        type: global.type,
        isArray: global.isArray,
        value: defaultFor(global.type),
        array: global.isArray ? [] : null,
      });
    }
  }

  initGlobals(): void {
    this.currentFn = "<globals>";
    this.threadSteps = 0;
    for (const global of this.program.globals) {
      if (!global.init || global.isArray) continue;
      const slot = this.globals.get(global.name)!;
      slot.value = this.drive(this.evalExpr(global.init, null));
    }
  }

  // -- entry points -------------------------------------------------------

  /** Run a function to completion. Sleeps are not honoured here — use `spawn`. */
  run(functionName: string): JassValue {
    const fn = this.functions.get(functionName);
    if (!fn) throw new JassRuntimeError(`no such function '${functionName}'`, 0, "<host>");
    this.threadSteps = 0;
    return this.drive(this.callFunction(fn, []));
  }

  /**
   * Start a function as a thread. If it sleeps, it is parked and resumed by
   * the clock; otherwise it finishes immediately, exactly as in Warcraft III.
   */
  spawn(functionName: string): Thread | null {
    const fn = this.functions.get(functionName);
    if (!fn) {
      this.callByName(functionName, []);
      return null;
    }
    const thread: Thread = {
      id: this.nextThreadId++,
      name: functionName,
      generator: this.callFunction(fn, []) as Exec<unknown>,
      wakeTick: this.clock.tick,
      steps: 0,
      done: false,
    };
    this.resume(thread);
    if (!thread.done) this.threads.push(thread);
    return thread;
  }

  has(functionName: string): boolean {
    return this.functions.has(functionName);
  }

  get handleCount(): number { return this.handles.length; }
  get stepCount(): number { return this.steps; }
  get sleepingThreads(): number { return this.threads.length; }

  // -- thread driving -----------------------------------------------------

  /** Pump a generator to completion, ignoring any sleep it requests. */
  private drive<T>(generator: Exec<T>): T {
    let result = generator.next();
    while (!result.done) {
      this.sleepsIgnored++;
      result = generator.next();
    }
    return result.value;
  }

  /** Advance a thread until it sleeps again or finishes. */
  private resume(thread: Thread): void {
    const savedSteps = this.threadSteps;
    this.threadSteps = thread.steps;
    try {
      const outcome = thread.generator.next();
      if (outcome.done) {
        thread.done = true;
      } else {
        const ticks = Math.max(1, Math.round(outcome.value.seconds * 32));
        thread.wakeTick = this.clock.tick + ticks;
      }
    } catch (error) {
      thread.done = true;
      this.tickErrors.push({
        tick: this.clock.tick,
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      thread.steps = this.threadSteps;
      this.threadSteps = savedSteps;
    }
  }

  /**
   * Advance the simulation by one 1/32 s tick: fire due timers, then wake any
   * thread whose sleep has elapsed.
   */
  step(): number {
    this.clock.advance();

    const due = this.clock.takeDue();
    for (const timer of due) {
      const saved = this.event.get("expiredTimer");
      this.event.set("expiredTimer", HANDLE(timer.handle));
      try {
        if (timer.handler) {
          this.spawn(timer.handler.name);
        } else {
          const target = timer.handle.data.get("firesTrigger");
          if (target instanceof JassHandle && this.evaluateTrigger(target)) {
            this.executeTrigger(target);
          }
        }
      } catch (error) {
        this.tickErrors.push({
          tick: this.clock.tick,
          message: error instanceof Error ? error.message : String(error),
        });
      }
      if (saved) this.event.set("expiredTimer", saved);
      else this.event.delete("expiredTimer");
    }

    if (this.threads.length > 0) {
      const ready = this.threads.filter((t) => t.wakeTick <= this.clock.tick);
      for (const thread of ready) {
        this.sleepsHonoured++;
        this.resume(thread);
      }
      this.threads = this.threads.filter((t) => !t.done);
    }

    // Combat runs after script logic so that units created this tick are
    // already on the field, and deaths are visible to next tick's triggers.
    if (this.world.battlefield) this.world.battlefield.step();

    return due.length;
  }

  runFor(seconds: number): { ticks: number; callbacks: number } {
    const ticks = Math.round(seconds * 32);
    let callbacks = 0;
    for (let i = 0; i < ticks; i++) callbacks += this.step();
    return { ticks, callbacks };
  }

  fire(event: string, context: EventContext = {}): number {
    let ran = 0;
    for (const registration of this.events.match(event, context)) {
      const saved = new Map(this.event);
      if (context.unit) this.event.set("triggerUnit", HANDLE(context.unit));
      if (context.player) this.event.set("triggerPlayer", HANDLE(context.player));
      if (this.evaluateTrigger(registration.trigger)) {
        this.executeTrigger(registration.trigger);
        ran++;
      }
      this.event = saved;
    }
    return ran;
  }

  // -- calling ------------------------------------------------------------

  private *invoke(name: string, args: JassValue[], line: number): Exec<JassValue> {
    const fn = this.functions.get(name);
    if (fn) return yield* this.callFunction(fn, args);
    return this.callNative(name, args, line);
  }

  private *callFunction(fn: FuncDecl, args: JassValue[]): Exec<JassValue> {
    if (++this.depth > this.maxDepth) {
      this.depth--;
      throw new JassRuntimeError(`call depth exceeded ${this.maxDepth}`, fn.line, fn.name);
    }
    const previousFn = this.currentFn;
    this.currentFn = fn.name;

    const scope = new Map<string, Slot>();
    fn.params.forEach((param, index) => {
      scope.set(param.name, {
        type: param.type,
        isArray: false,
        value: args[index] ?? defaultFor(param.type),
        array: null,
      });
    });

    try {
      const flow = yield* this.execBlock(fn.body, scope);
      if (flow && flow.kind === "return") return flow.value;
      return NOTHING;
    } finally {
      this.depth--;
      this.currentFn = previousFn;
    }
  }

  private callNative(name: string, args: JassValue[], line: number): JassValue {
    const implementation = this.natives.get(name);
    if (implementation) {
      this.implementedCalls.set(name, (this.implementedCalls.get(name) ?? 0) + 1);
      if (this.traceEnabled) this.trace.push(name);
      return implementation(this, args);
    }

    const signature = this.nativeSignatures.get(name);

    // `ConvertX(i)` families are pure enum constructors; common.j declares 30-odd
    // of them with identical shape, so derive rather than hand-write each one.
    if (signature && name.startsWith("Convert") && signature.params.length === 1) {
      this.implementedCalls.set(name, (this.implementedCalls.get(name) ?? 0) + 1);
      return HANDLE(this.enumHandle(signature.returnType, asNumber(args[0] ?? INT(0))));
    }

    if (!this.stubCalls.has(name)) this.firstSeen.push(name);
    this.stubCalls.set(name, (this.stubCalls.get(name) ?? 0) + 1);
    if (this.traceEnabled) this.trace.push(`~${name}`);
    void line;
    // A typed default beats a blanket null: `integer` stubs yield 0 rather than
    // poisoning arithmetic, while handle stubs still yield null so that
    // `exitwhen X()==null` terminates.
    return signature ? defaultFor(signature.returnType) : NULLV;
  }

  // -- statements ---------------------------------------------------------

  private *execBlock(stmts: Stmt[], scope: Map<string, Slot> | null): Exec<Flow> {
    for (const stmt of stmts) {
      const flow = yield* this.execStmt(stmt, scope);
      if (flow) return flow;
    }
    return null;
  }

  private *execStmt(stmt: Stmt, scope: Map<string, Slot> | null): Exec<Flow> {
    this.steps++;
    if (++this.threadSteps > this.maxStepsPerThread) {
      throw new JassRuntimeError(
        `thread step budget of ${this.maxStepsPerThread} exhausted`, stmt.line, this.currentFn);
    }

    switch (stmt.kind) {
      case "local": {
        const slot: Slot = {
          type: stmt.type,
          isArray: stmt.isArray,
          value: defaultFor(stmt.type),
          array: stmt.isArray ? [] : null,
        };
        if (stmt.init) slot.value = yield* this.evalExpr(stmt.init, scope);
        scope?.set(stmt.name, slot);
        return null;
      }

      case "set": {
        const slot = this.resolve(stmt.name, scope);
        const value = yield* this.evalExpr(stmt.value, scope);
        if (slot) slot.value = this.coerce(value, slot.type);
        return null;
      }

      case "setIndex": {
        const slot = this.resolve(stmt.name, scope);
        const index = asNumber(yield* this.evalExpr(stmt.index, scope)) | 0;
        const value = yield* this.evalExpr(stmt.value, scope);
        if (slot) {
          if (!slot.array) slot.array = [];
          if (index >= 0 && index < 8192) slot.array[index] = this.coerce(value, slot.type);
        }
        return null;
      }

      case "callStmt":
        yield* this.evalExpr(stmt.call, scope);
        return null;

      case "if": {
        if (asBool(yield* this.evalExpr(stmt.cond, scope))) return yield* this.execBlock(stmt.then, scope);
        for (const elif of stmt.elifs) {
          if (asBool(yield* this.evalExpr(elif.cond, scope))) return yield* this.execBlock(elif.body, scope);
        }
        if (stmt.else) return yield* this.execBlock(stmt.else, scope);
        return null;
      }

      case "loop": {
        for (;;) {
          const flow = yield* this.execBlock(stmt.body, scope);
          if (!flow) continue;
          if (flow.kind === "exit") return null;
          return flow;
        }
      }

      case "exitwhen":
        return asBool(yield* this.evalExpr(stmt.cond, scope)) ? { kind: "exit" } : null;

      case "return":
        return { kind: "return", value: stmt.value ? yield* this.evalExpr(stmt.value, scope) : NOTHING };
    }
    return null;
  }

  // -- expressions --------------------------------------------------------

  private resolve(name: string, scope: Map<string, Slot> | null): Slot | undefined {
    return scope?.get(name) ?? this.globals.get(name);
  }

  /** Keep declared types honest so integer division stays integer after assignment. */
  private coerce(value: JassValue, type: string): JassValue {
    if (type === "integer" && value.t === "real") return INT(Math.trunc(asNumber(value)));
    if (type === "real" && value.t === "integer") return REAL(asNumber(value));
    return value;
  }

  private *evalExpr(expr: Expr, scope: Map<string, Slot> | null): Exec<JassValue> {
    switch (expr.kind) {
      case "int": return INT(expr.value);
      case "real": return REAL(expr.value);
      case "str": return STR(expr.value);
      case "bool": return BOOL(expr.value);
      case "null": return NULLV;

      case "var": {
        const slot = this.resolve(expr.name, scope);
        return slot ? slot.value : this.externalConstant(expr.name);
      }

      case "index": {
        const slot = this.resolve(expr.name, scope);
        if (!slot) return this.externalConstant(expr.name);
        const index = asNumber(yield* this.evalExpr(expr.index, scope)) | 0;
        if (!slot.array) return defaultFor(slot.type);
        return slot.array[index] ?? defaultFor(slot.type);
      }

      case "funcref": return CODE(new JassCode(expr.name));

      case "call": {
        const args: JassValue[] = [];
        for (const argument of expr.args) args.push(yield* this.evalExpr(argument, scope));

        // The one native that suspends the calling thread.
        if (expr.name === "TriggerSleepAction") {
          const seconds = asNumber(args[0] ?? REAL(0));
          this.implementedCalls.set("TriggerSleepAction",
            (this.implementedCalls.get("TriggerSleepAction") ?? 0) + 1);
          if (this.insideNative > 0) {
            // Warcraft III cannot suspend inside a condition or filter either.
            this.sleepsIgnored++;
          } else if (seconds > 0) {
            yield { seconds };
          }
          return NOTHING;
        }

        return yield* this.invoke(expr.name, args, expr.line);
      }

      case "unary": {
        const operand = yield* this.evalExpr(expr.operand, scope);
        if (expr.op === "not") return BOOL(!asBool(operand));
        return operand.t === "integer" ? INT(-asNumber(operand)) : REAL(-asNumber(operand));
      }

      case "binary": return yield* this.evalBinary(expr, scope);
    }
  }

  /**
   * Identifiers with no declaration anywhere. With common.j loaded this should
   * never fire; without it, the name becomes a stable opaque handle so that
   * `x == SOME_CONSTANT` still compares consistently.
   */
  private externalConstant(name: string): JassValue {
    const known = this.externals.get(name);
    if (known) return known;
    const builtin = (EXTERNAL_CONSTANTS as Record<string, JassValue>)[name];
    const value = builtin ?? HANDLE(this.enumHandle("constant", name));
    this.externals.set(name, value);
    return value;
  }

  private *evalBinary(expr: Expr & { kind: "binary" }, scope: Map<string, Slot> | null): Exec<JassValue> {
    // NOTE: both sides are evaluated even for and/or — JASS has no short-circuit.
    const left = yield* this.evalExpr(expr.left, scope);
    const right = yield* this.evalExpr(expr.right, scope);

    switch (expr.op) {
      case "and": return BOOL(asBool(left) && asBool(right));
      case "or": return BOOL(asBool(left) || asBool(right));

      case "+": {
        if (left.t === "string" || right.t === "string") return STR(asString(left) + asString(right));
        return this.numericResult(left, right, asNumber(left) + asNumber(right));
      }
      case "-": return this.numericResult(left, right, asNumber(left) - asNumber(right));
      case "*": return this.numericResult(left, right, asNumber(left) * asNumber(right));
      case "/": {
        const divisor = asNumber(right);
        if (left.t === "integer" && right.t === "integer") {
          return INT(divisor === 0 ? 0 : Math.trunc(asNumber(left) / divisor));
        }
        return REAL(divisor === 0 ? 0 : asNumber(left) / divisor);
      }

      case "==": return BOOL(this.equals(left, right));
      case "!=": return BOOL(!this.equals(left, right));
      case "<": return BOOL(this.compare(left, right) < 0);
      case ">": return BOOL(this.compare(left, right) > 0);
      case "<=": return BOOL(this.compare(left, right) <= 0);
      case ">=": return BOOL(this.compare(left, right) >= 0);
    }

    throw new JassRuntimeError(`unknown operator '${expr.op}'`, expr.line, this.currentFn);
  }

  private numericResult(left: JassValue, right: JassValue, value: number): JassValue {
    return left.t === "real" || right.t === "real" ? REAL(value) : INT(value);
  }

  private equals(left: JassValue, right: JassValue): boolean {
    const leftNull = left.v === null || left.v === undefined;
    const rightNull = right.v === null || right.v === undefined;
    if (leftNull || rightNull) return leftNull && rightNull;
    if (left.t === "string" || right.t === "string") return asString(left) === asString(right);
    if (typeof left.v === "number" || typeof right.v === "number") return asNumber(left) === asNumber(right);
    if (typeof left.v === "boolean" || typeof right.v === "boolean") return asBool(left) === asBool(right);
    return left.v === right.v;
  }

  private compare(left: JassValue, right: JassValue): number {
    if (left.t === "string" && right.t === "string") {
      const a = asString(left);
      const b = asString(right);
      return a < b ? -1 : a > b ? 1 : 0;
    }
    const a = asNumber(left);
    const b = asNumber(right);
    return a < b ? -1 : a > b ? 1 : 0;
  }
}
