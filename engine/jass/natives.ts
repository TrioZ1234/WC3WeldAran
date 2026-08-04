/**
 * The engine contract — the functions `war3map.j` calls but never defines.
 *
 * Organised by subsystem to mirror `engine/natives/` in the architecture
 * document. Anything not implemented here is auto-stubbed by the interpreter,
 * logged, and reported; the stub log is the work queue for stage 4.
 *
 * Ordering follows call-site frequency from `docs/data/jass-api.json`:
 * `player` (5 716 sites) and `unit` (5 497) carry 73 % of all calls, so they
 * come first and get real state behind them rather than no-ops.
 */

import { JassHandle, JassCode, INT, REAL, STR, BOOL, NULLV, NOTHING, HANDLE, asNumber, asBool, asString, formatReal } from "./values.ts";
import type { JassValue, Random } from "./values.ts";
import type { Clock } from "../sim/scheduler.ts";
import type { Battlefield, UnitStats } from "../sim/units.ts";
import type { EventTable } from "../sim/events.ts";

/** What a native implementation is allowed to ask of the running VM. */
export interface NativeContext {
  createHandle(type: string): JassHandle;
  /** Stable singleton handle per (kind, key) — used for enum constants. */
  enumHandle(kind: string, key: number | string): JassHandle;
  random: Random;
  world: World;
  /** Ambient event context read by GetEnumPlayer, GetTriggerUnit and friends. */
  event: Map<string, JassValue>;
  /** Simulation clock and timer queue. */
  clock: Clock;
  /** Trigger event registrations. */
  events: EventTable;
  callByName(name: string, args: JassValue[]): JassValue;
  callCode(code: JassCode | null, args: JassValue[]): JassValue;
  /** Run a trigger's conditions and return their combined result. */
  evaluateTrigger(trigger: JassHandle): boolean;
  /** Run a trigger's actions. */
  executeTrigger(trigger: JassHandle): void;
}

export type NativeFn = (ctx: NativeContext, args: JassValue[]) => JassValue;

/** Mutable game state touched by the natives implemented here. */
export class World {
  players: JassHandle[] = [];
  units: JassHandle[] = [];
  /**
   * Optional combat simulation. When attached, every unit the script creates
   * also enters the battlefield, so the map's own spawns fight on their own.
   * Left null the VM is a pure logic runner, which keeps the tests fast.
   */
  battlefield: Battlefield | null = null;
  unitStats: Map<string, UnitStats> | null = null;
  /** playerIndex -> set of allied player indices, from SetPlayerAlliance. */
  alliances = new Map<number, Set<number>>();
  mapName = "";
  mapDescription = "";
  playerCount = 0;
  teamCount = 0;
  startLocations: Array<{ x: number; y: number }> = [];
  /** Populated by SetPlayerTechResearched / SetPlayerTechMaxAllowed. */
  techState = new Map<string, number>();
  cameraBounds: number[] = [];
}

const handleArg = (args: JassValue[], i: number): JassHandle | null => {
  const v = args[i];
  return v && v.v instanceof JassHandle ? (v.v as JassHandle) : null;
};
const codeArg = (args: JassValue[], i: number): JassCode | null => {
  const v = args[i];
  return v && v.v instanceof JassCode ? (v.v as JassCode) : null;
};
const num = (args: JassValue[], i: number): number => (args[i] ? asNumber(args[i]) : 0);
const str = (args: JassValue[], i: number): string => (args[i] ? asString(args[i]) : "");
const bool = (args: JassValue[], i: number): boolean => (args[i] ? asBool(args[i]) : false);

/** Per-handle scratch storage, created on demand. */
function slot<T>(h: JassHandle, key: string, make: () => T): T {
  let existing = h.data.get(key) as T | undefined;
  if (existing === undefined) {
    existing = make();
    h.data.set(key, existing);
  }
  return existing;
}

export function buildNatives(): Map<string, NativeFn> {
  const n = new Map<string, NativeFn>();

  // -- player -------------------------------------------------------------

  n.set("Player", (ctx, a) => {
    const index = num(a, 0) | 0;
    const h = ctx.enumHandle("player", index);
    if (!h.data.has("index")) {
      h.data.set("index", index);
      ctx.world.players[index] = h;
    }
    return HANDLE(h);
  });
  n.set("GetPlayerId", (_c, a) => INT(Number(handleArg(a, 0)?.data.get("index") ?? 0)));
  n.set("GetLocalPlayer", (ctx) => HANDLE(ctx.enumHandle("player", 0)));
  n.set("GetPlayerName", (_c, a) => STR(String(handleArg(a, 0)?.data.get("name") ?? "Player")));
  n.set("SetPlayerName", (_c, a) => { handleArg(a, 0)?.data.set("name", str(a, 1)); return NOTHING; });
  n.set("SetPlayerColor", (_c, a) => { handleArg(a, 0)?.data.set("color", a[1]); return NOTHING; });
  n.set("SetPlayerTeam", (_c, a) => { handleArg(a, 0)?.data.set("team", num(a, 1)); return NOTHING; });
  n.set("SetPlayerStartLocation", (_c, a) => { handleArg(a, 0)?.data.set("startLoc", num(a, 1)); return NOTHING; });
  n.set("SetPlayerState", (_c, a) => {
    const p = handleArg(a, 0);
    if (p) slot(p, "state", () => new Map<string, number>()).set(String(handleArg(a, 1) ?? "?"), num(a, 2));
    return NOTHING;
  });
  n.set("GetPlayerState", (_c, a) => {
    const p = handleArg(a, 0);
    const m = p ? (p.data.get("state") as Map<string, number> | undefined) : undefined;
    return INT(m?.get(String(handleArg(a, 1) ?? "?")) ?? 0);
  });
  n.set("SetPlayerTechMaxAllowed", (ctx, a) => {
    ctx.world.techState.set(`max:${handleArg(a, 0)?.id}:${num(a, 1)}`, num(a, 2));
    return NOTHING;
  });
  n.set("SetPlayerTechResearched", (ctx, a) => {
    ctx.world.techState.set(`res:${handleArg(a, 0)?.id}:${num(a, 1)}`, num(a, 2));
    return NOTHING;
  });
  n.set("GetPlayerTechCount", (ctx, a) =>
    INT(ctx.world.techState.get(`res:${handleArg(a, 0)?.id}:${num(a, 1)}`) ?? 0));
  n.set("SetPlayerAbilityAvailable", (_c, a) => {
    const p = handleArg(a, 0);
    if (p) slot(p, "abilities", () => new Map<number, boolean>()).set(num(a, 1), bool(a, 2));
    return NOTHING;
  });
  n.set("SetPlayerAlliance", (ctx, a) => {
    const source = handleArg(a, 0);
    const target = handleArg(a, 1);
    if (!source || !target) return NOTHING;
    const from = Number(source.data.get("index") ?? 0);
    const to = Number(target.data.get("index") ?? 0);
    let allies = ctx.world.alliances.get(from);
    if (!allies) { allies = new Set(); ctx.world.alliances.set(from, allies); }
    // Warcraft III models alliance per-aspect; "passive" is the one that decides
    // whether units shoot each other, and it is what the simulation needs.
    if (bool(a, 3)) allies.add(to); else allies.delete(to);
    return NOTHING;
  });
  n.set("SetPlayers", (ctx, a) => { ctx.world.playerCount = num(a, 0); return NOTHING; });
  n.set("SetTeams", (ctx, a) => { ctx.world.teamCount = num(a, 0); return NOTHING; });
  n.set("DefineStartLocation", (ctx, a) => {
    ctx.world.startLocations[num(a, 0)] = { x: num(a, 1), y: num(a, 2) };
    return NOTHING;
  });
  n.set("SetMapName", (ctx, a) => { ctx.world.mapName = str(a, 0); return NOTHING; });
  n.set("SetMapDescription", (ctx, a) => { ctx.world.mapDescription = str(a, 0); return NOTHING; });

  // -- force --------------------------------------------------------------

  n.set("CreateForce", (ctx) => {
    const h = ctx.createHandle("force");
    h.data.set("members", [] as JassHandle[]);
    return HANDLE(h);
  });
  n.set("ForceAddPlayer", (_c, a) => {
    const f = handleArg(a, 0); const p = handleArg(a, 1);
    if (f && p) slot(f, "members", () => [] as JassHandle[]).push(p);
    return NOTHING;
  });
  n.set("ForceClear", (_c, a) => { handleArg(a, 0)?.data.set("members", []); return NOTHING; });
  n.set("ForForce", (ctx, a) => {
    const f = handleArg(a, 0);
    const cb = codeArg(a, 1);
    const members = (f?.data.get("members") as JassHandle[] | undefined) ?? [];
    const saved = ctx.event.get("enumPlayer");
    for (const p of members) {
      ctx.event.set("enumPlayer", HANDLE(p));
      ctx.callCode(cb, []);
    }
    if (saved) ctx.event.set("enumPlayer", saved); else ctx.event.delete("enumPlayer");
    return NOTHING;
  });
  n.set("ForGroup", (ctx, a) => {
    const g = handleArg(a, 0);
    const cb = codeArg(a, 1);
    const units = ((g?.data.get("units") as JassHandle[] | undefined) ?? []).slice();
    const saved = ctx.event.get("enumUnit");
    for (const u of units) {
      ctx.event.set("enumUnit", HANDLE(u));
      ctx.callCode(cb, []);
    }
    if (saved) ctx.event.set("enumUnit", saved); else ctx.event.delete("enumUnit");
    return NOTHING;
  });

  // -- unit ---------------------------------------------------------------

  /** 0x68303153 -> "h01S": object data is keyed by rawcode text, not by integer. */
  const toRawcode = (id: number): string =>
    String.fromCharCode((id >> 24) & 255, (id >> 16) & 255, (id >> 8) & 255, id & 255);

  const createUnit = (ctx: NativeContext, owner: JassHandle | null, typeId: number, x: number, y: number, face: number): JassValue => {
    const u = ctx.createHandle("unit");
    u.data.set("typeId", typeId);
    u.data.set("owner", owner);
    u.data.set("x", x);
    u.data.set("y", y);
    u.data.set("facing", face);
    u.data.set("alive", true);
    ctx.world.units.push(u);

    // Mirror the unit into the combat simulation when one is attached.
    const world = ctx.world;
    if (world.battlefield && world.unitStats) {
      const stats = world.unitStats.get(toRawcode(typeId));
      if (stats) {
        const ownerIndex = Number(owner?.data.get("index") ?? 0);
        const sim = world.battlefield.spawn(stats, ownerIndex, x, y);
        u.data.set("sim", sim);
      }
    }
    return HANDLE(u);
  };
  n.set("CreateUnit", (ctx, a) => createUnit(ctx, handleArg(a, 0), num(a, 1), num(a, 2), num(a, 3), num(a, 4)));
  n.set("CreateUnitAtLoc", (ctx, a) => {
    const loc = handleArg(a, 2);
    return createUnit(ctx, handleArg(a, 0), num(a, 1),
      Number(loc?.data.get("x") ?? 0), Number(loc?.data.get("y") ?? 0), num(a, 3));
  });
  n.set("GetUnitTypeId", (_c, a) => INT(Number(handleArg(a, 0)?.data.get("typeId") ?? 0)));
  n.set("GetOwningPlayer", (_c, a) => {
    const owner = handleArg(a, 0)?.data.get("owner");
    return owner instanceof JassHandle ? HANDLE(owner) : NULLV;
  });
  n.set("SetUnitOwner", (_c, a) => { handleArg(a, 0)?.data.set("owner", handleArg(a, 1)); return NOTHING; });
  n.set("SetUnitColor", (_c, a) => { handleArg(a, 0)?.data.set("color", a[1]); return NOTHING; });
  n.set("SetUnitAcquireRange", (_c, a) => { handleArg(a, 0)?.data.set("acquireRange", num(a, 1)); return NOTHING; });
  n.set("SetUnitState", (_c, a) => {
    const u = handleArg(a, 0);
    if (u) slot(u, "state", () => new Map<string, number>()).set(String(handleArg(a, 1) ?? "?"), num(a, 2));
    return NOTHING;
  });
  n.set("GetUnitState", (_c, a) => {
    const u = handleArg(a, 0);
    const m = u ? (u.data.get("state") as Map<string, number> | undefined) : undefined;
    return REAL(m?.get(String(handleArg(a, 1) ?? "?")) ?? 0);
  });
  n.set("GetUnitX", (_c, a) => REAL(Number(handleArg(a, 0)?.data.get("x") ?? 0)));
  n.set("GetUnitY", (_c, a) => REAL(Number(handleArg(a, 0)?.data.get("y") ?? 0)));
  n.set("SetUnitX", (_c, a) => { handleArg(a, 0)?.data.set("x", num(a, 1)); return NOTHING; });
  n.set("SetUnitY", (_c, a) => { handleArg(a, 0)?.data.set("y", num(a, 1)); return NOTHING; });
  n.set("SetUnitFacing", (_c, a) => { handleArg(a, 0)?.data.set("facing", num(a, 1)); return NOTHING; });
  n.set("RemoveUnit", (ctx, a) => {
    const u = handleArg(a, 0);
    if (u) { u.data.set("alive", false); ctx.world.units = ctx.world.units.filter((x) => x !== u); }
    return NOTHING;
  });
  n.set("KillUnit", (_c, a) => {
    const u = handleArg(a, 0);
    if (u) {
      u.data.set("alive", false);
      const sim = u.data.get("sim") as { alive: boolean } | undefined;
      if (sim) sim.alive = false;
    }
    return NOTHING;
  });
  n.set("GetUnitStateSwap", (_c, a) => {
    const u = handleArg(a, 1);
    const sim = u?.data.get("sim") as { hp: number } | undefined;
    return REAL(sim ? sim.hp / 256 : 0);
  });
  n.set("GetUnitTypeIdAll", (_c, a) => INT(Number(handleArg(a, 0)?.data.get("typeId") ?? 0)));

  // -- group --------------------------------------------------------------

  n.set("CreateGroup", (ctx) => {
    const g = ctx.createHandle("group");
    g.data.set("units", [] as JassHandle[]);
    return HANDLE(g);
  });
  n.set("GroupAddUnit", (_c, a) => {
    const g = handleArg(a, 0); const u = handleArg(a, 1);
    if (g && u) {
      const list = slot(g, "units", () => [] as JassHandle[]);
      if (!list.includes(u)) list.push(u);
    }
    return NOTHING;
  });
  n.set("GroupRemoveUnit", (_c, a) => {
    const g = handleArg(a, 0); const u = handleArg(a, 1);
    if (g && u) g.data.set("units", (slot(g, "units", () => [] as JassHandle[])).filter((x) => x !== u));
    return NOTHING;
  });
  n.set("GroupClear", (_c, a) => { handleArg(a, 0)?.data.set("units", []); return NOTHING; });
  n.set("DestroyGroup", (_c, a) => { handleArg(a, 0)?.data.set("units", []); return NOTHING; });
  n.set("FirstOfGroup", (_c, a) => {
    const list = (handleArg(a, 0)?.data.get("units") as JassHandle[] | undefined) ?? [];
    return list.length > 0 ? HANDLE(list[0]) : NULLV;
  });
  n.set("CountUnitsInGroup", (_c, a) =>
    INT(((handleArg(a, 0)?.data.get("units") as JassHandle[] | undefined) ?? []).length));

  // -- trigger ------------------------------------------------------------

  n.set("CreateTrigger", (ctx) => {
    const t = ctx.createHandle("trigger");
    t.data.set("enabled", true);
    t.data.set("actions", [] as JassCode[]);
    t.data.set("conditions", [] as JassCode[]);
    return HANDLE(t);
  });
  n.set("DestroyTrigger", (_c, a) => { handleArg(a, 0)?.data.set("enabled", false); return NOTHING; });
  n.set("EnableTrigger", (_c, a) => { handleArg(a, 0)?.data.set("enabled", true); return NOTHING; });
  n.set("DisableTrigger", (_c, a) => { handleArg(a, 0)?.data.set("enabled", false); return NOTHING; });
  n.set("IsTriggerEnabled", (_c, a) => BOOL(Boolean(handleArg(a, 0)?.data.get("enabled"))));
  n.set("TriggerAddAction", (ctx, a) => {
    const t = handleArg(a, 0); const c = codeArg(a, 1);
    if (t && c) slot(t, "actions", () => [] as JassCode[]).push(c);
    return HANDLE(ctx.createHandle("triggeraction"));
  });
  n.set("TriggerAddCondition", (ctx, a) => {
    const t = handleArg(a, 0); const c = handleArg(a, 1);
    if (t && c) slot(t, "conditions", () => [] as JassHandle[]).push(c);
    return HANDLE(ctx.createHandle("triggercondition"));
  });
  n.set("Condition", (ctx, a) => {
    const h = ctx.createHandle("conditionfunc");
    h.data.set("code", codeArg(a, 0));
    return HANDLE(h);
  });
  n.set("Filter", (ctx, a) => {
    const h = ctx.createHandle("filterfunc");
    h.data.set("code", codeArg(a, 0));
    return HANDLE(h);
  });
  n.set("TriggerExecute", (ctx, a) => {
    const t = handleArg(a, 0);
    if (t) ctx.executeTrigger(t);
    return NOTHING;
  });
  // Not a stub: the map's 32 Hz heartbeat is a bare TriggerEvaluate, and vJASS
  // libraries routinely hang periodic work off conditions rather than actions
  // because conditions are cheaper. Returning a constant true would run nothing.
  n.set("TriggerEvaluate", (ctx, a) => {
    const t = handleArg(a, 0);
    return BOOL(t ? ctx.evaluateTrigger(t) : false);
  });
  n.set("ConditionalTriggerExecute", (ctx, a) => {
    const t = handleArg(a, 0);
    if (t && ctx.evaluateTrigger(t)) ctx.executeTrigger(t);
    return NOTHING;
  });
  n.set("TriggerClearConditions", (_c, a) => { handleArg(a, 0)?.data.set("conditions", []); return NOTHING; });
  n.set("TriggerClearActions", (_c, a) => { handleArg(a, 0)?.data.set("actions", []); return NOTHING; });
  n.set("DestroyCondition", (_c, a) => { void a; return NOTHING; });
  n.set("DestroyFilter", (_c, a) => { void a; return NOTHING; });
  n.set("GetHandleId", (_c, a) => INT(handleArg(a, 0)?.id ?? 0));

  // -- event registration -------------------------------------------------
  // These record intent only; the simulation raises the events later.

  const registerEvent = (
    ctx: NativeContext, a: JassValue[], eventKey: string,
    scope: { player?: number; unit?: number; rect?: number; filter?: number; chat?: number; exact?: number } = {},
  ): JassValue => {
    const trigger = handleArg(a, 0);
    if (!trigger) return NULLV;
    ctx.events.register({
      trigger,
      event: eventKey,
      player: scope.player !== undefined ? handleArg(a, scope.player) : null,
      unit: scope.unit !== undefined ? handleArg(a, scope.unit) : null,
      rect: scope.rect !== undefined ? handleArg(a, scope.rect) : null,
      filter: scope.filter !== undefined ? handleArg(a, scope.filter) : null,
      chat: scope.chat !== undefined ? str(a, scope.chat) : null,
      chatExact: scope.exact !== undefined ? bool(a, scope.exact) : false,
    });
    return HANDLE(ctx.createHandle("event"));
  };

  const eventKey = (a: JassValue[], index: number): string => {
    const h = handleArg(a, index);
    return h ? `${h.type}#${h.id}` : "event#none";
  };

  n.set("TriggerRegisterPlayerUnitEvent", (ctx, a) =>
    registerEvent(ctx, a, eventKey(a, 2), { player: 1, filter: 3 }));
  n.set("TriggerRegisterUnitEvent", (ctx, a) =>
    registerEvent(ctx, a, eventKey(a, 2), { unit: 1 }));
  n.set("TriggerRegisterPlayerEvent", (ctx, a) =>
    registerEvent(ctx, a, eventKey(a, 2), { player: 1 }));
  n.set("TriggerRegisterGameEvent", (ctx, a) =>
    registerEvent(ctx, a, eventKey(a, 1)));
  n.set("TriggerRegisterEnterRegion", (ctx, a) =>
    registerEvent(ctx, a, "region:enter", { rect: 1, filter: 2 }));
  n.set("TriggerRegisterLeaveRegion", (ctx, a) =>
    registerEvent(ctx, a, "region:leave", { rect: 1, filter: 2 }));
  n.set("TriggerRegisterPlayerChatEvent", (ctx, a) =>
    registerEvent(ctx, a, "player:chat", { player: 1, chat: 2, exact: 3 }));
  n.set("TriggerRegisterUnitStateEvent", (ctx, a) =>
    registerEvent(ctx, a, eventKey(a, 2), { unit: 1 }));
  n.set("TriggerRegisterDeathEvent", (ctx, a) =>
    registerEvent(ctx, a, "widget:death", { unit: 1 }));

  // Timer-driven registrations own a timer that fires the trigger.
  const registerTimerEvent = (ctx: NativeContext, a: JassValue[], seconds: number, periodic: boolean): JassValue => {
    const trigger = handleArg(a, 0);
    if (!trigger) return NULLV;
    const timer = ctx.createHandle("timer");
    timer.data.set("firesTrigger", trigger);
    ctx.clock.start(timer, seconds, periodic, null);
    return HANDLE(ctx.createHandle("event"));
  };
  n.set("TriggerRegisterTimerEvent", (ctx, a) => registerTimerEvent(ctx, a, num(a, 1), bool(a, 2)));
  n.set("TriggerRegisterTimerExpireEvent", (ctx, a) => {
    const trigger = handleArg(a, 0);
    const timer = handleArg(a, 1);
    if (trigger && timer) timer.data.set("firesTrigger", trigger);
    return HANDLE(ctx.createHandle("event"));
  });

  // -- rect and location --------------------------------------------------

  const makeRect = (ctx: NativeContext, minx: number, miny: number, maxx: number, maxy: number): JassValue => {
    const r = ctx.createHandle("rect");
    r.data.set("minx", minx); r.data.set("miny", miny);
    r.data.set("maxx", maxx); r.data.set("maxy", maxy);
    return HANDLE(r);
  };
  n.set("Rect", (ctx, a) => makeRect(ctx, num(a, 0), num(a, 1), num(a, 2), num(a, 3)));
  n.set("RemoveRect", () => NOTHING);
  n.set("GetRectMinX", (_c, a) => REAL(Number(handleArg(a, 0)?.data.get("minx") ?? 0)));
  n.set("GetRectMinY", (_c, a) => REAL(Number(handleArg(a, 0)?.data.get("miny") ?? 0)));
  n.set("GetRectMaxX", (_c, a) => REAL(Number(handleArg(a, 0)?.data.get("maxx") ?? 0)));
  n.set("GetRectMaxY", (_c, a) => REAL(Number(handleArg(a, 0)?.data.get("maxy") ?? 0)));
  n.set("GetRectCenterX", (_c, a) => {
    const r = handleArg(a, 0);
    return REAL((Number(r?.data.get("minx") ?? 0) + Number(r?.data.get("maxx") ?? 0)) / 2);
  });
  n.set("GetRectCenterY", (_c, a) => {
    const r = handleArg(a, 0);
    return REAL((Number(r?.data.get("miny") ?? 0) + Number(r?.data.get("maxy") ?? 0)) / 2);
  });

  const makeLocation = (ctx: NativeContext, x: number, y: number): JassValue => {
    const l = ctx.createHandle("location");
    l.data.set("x", x); l.data.set("y", y);
    return HANDLE(l);
  };
  n.set("Location", (ctx, a) => makeLocation(ctx, num(a, 0), num(a, 1)));
  n.set("RemoveLocation", () => NOTHING);
  n.set("GetLocationX", (_c, a) => REAL(Number(handleArg(a, 0)?.data.get("x") ?? 0)));
  n.set("GetLocationY", (_c, a) => REAL(Number(handleArg(a, 0)?.data.get("y") ?? 0)));
  n.set("GetRectCenter", (ctx, a) => {
    const r = handleArg(a, 0);
    return makeLocation(ctx,
      (Number(r?.data.get("minx") ?? 0) + Number(r?.data.get("maxx") ?? 0)) / 2,
      (Number(r?.data.get("miny") ?? 0) + Number(r?.data.get("maxy") ?? 0)) / 2);
  });

  // -- hashtable ----------------------------------------------------------
  // The map leans on these heavily (SaveInteger alone has 228 call sites),
  // so they are backed by a real nested map rather than stubbed.

  type Table = Map<number, Map<number, JassValue>>;
  const table = (h: JassHandle | null): Table | null =>
    h ? slot(h, "table", () => new Map() as Table) : null;

  n.set("InitHashtable", (ctx) => {
    const h = ctx.createHandle("hashtable");
    h.data.set("table", new Map() as Table);
    return HANDLE(h);
  });

  const saver = (): NativeFn => (_c, a) => {
    const t = table(handleArg(a, 0));
    if (!t) return NOTHING;
    const parent = num(a, 1); const child = num(a, 2);
    let inner = t.get(parent);
    if (!inner) { inner = new Map(); t.set(parent, inner); }
    inner.set(child, a[3] ?? NULLV);
    return NOTHING;
  };
  const loader = (fallback: JassValue): NativeFn => (_c, a) => {
    const t = table(handleArg(a, 0));
    return t?.get(num(a, 1))?.get(num(a, 2)) ?? fallback;
  };
  for (const name of ["SaveInteger", "SaveReal", "SaveBoolean", "SaveStr",
    "SaveUnitHandle", "SaveTriggerHandle", "SaveGroupHandle", "SaveTimerHandle",
    "SavePlayerHandle", "SaveRectHandle", "SaveLocationHandle", "SaveEffectHandle",
    "SaveItemHandle", "SaveDestructableHandle", "SaveAbilityHandle",
    "SaveWidgetHandle", "SaveTextTagHandle", "SaveForceHandle",
    "SaveTriggerConditionHandle", "SaveTriggerActionHandle"]) n.set(name, saver());
  n.set("LoadInteger", loader(INT(0)));
  n.set("LoadReal", loader(REAL(0)));
  n.set("LoadBoolean", loader(BOOL(false)));
  n.set("LoadStr", loader(STR("")));
  for (const name of ["LoadUnitHandle", "LoadTriggerHandle", "LoadGroupHandle",
    "LoadTimerHandle", "LoadPlayerHandle", "LoadRectHandle", "LoadLocationHandle",
    "LoadEffectHandle", "LoadItemHandle", "LoadDestructableHandle",
    "LoadAbilityHandle", "LoadWidgetHandle", "LoadTextTagHandle",
    "LoadForceHandle"]) n.set(name, loader(NULLV));
  n.set("HaveSavedInteger", (_c, a) => BOOL(table(handleArg(a, 0))?.get(num(a, 1))?.has(num(a, 2)) ?? false));
  n.set("HaveSavedReal", (_c, a) => BOOL(table(handleArg(a, 0))?.get(num(a, 1))?.has(num(a, 2)) ?? false));
  n.set("HaveSavedBoolean", (_c, a) => BOOL(table(handleArg(a, 0))?.get(num(a, 1))?.has(num(a, 2)) ?? false));
  n.set("HaveSavedString", (_c, a) => BOOL(table(handleArg(a, 0))?.get(num(a, 1))?.has(num(a, 2)) ?? false));
  n.set("HaveSavedHandle", (_c, a) => BOOL(table(handleArg(a, 0))?.get(num(a, 1))?.has(num(a, 2)) ?? false));
  n.set("FlushChildHashtable", (_c, a) => { table(handleArg(a, 0))?.delete(num(a, 1)); return NOTHING; });
  n.set("FlushParentHashtable", (_c, a) => { table(handleArg(a, 0))?.clear(); return NOTHING; });
  n.set("RemoveSavedInteger", (_c, a) => { table(handleArg(a, 0))?.get(num(a, 1))?.delete(num(a, 2)); return NOTHING; });

  // -- timer --------------------------------------------------------------

  n.set("CreateTimer", (ctx) => HANDLE(ctx.createHandle("timer")));
  n.set("DestroyTimer", (ctx, a) => {
    const t = handleArg(a, 0);
    if (t) ctx.clock.remove(t);
    return NOTHING;
  });
  n.set("TimerStart", (ctx, a) => {
    const t = handleArg(a, 0);
    if (t) ctx.clock.start(t, num(a, 1), bool(a, 2), codeArg(a, 3));
    return NOTHING;
  });
  n.set("PauseTimer", (ctx, a) => {
    const t = handleArg(a, 0);
    if (t) ctx.clock.pause(t);
    return NOTHING;
  });
  n.set("ResumeTimer", (ctx, a) => {
    const t = handleArg(a, 0);
    if (t) ctx.clock.resume(t);
    return NOTHING;
  });
  n.set("TimerGetElapsed", (ctx, a) => {
    const t = handleArg(a, 0);
    return REAL(t ? ctx.clock.elapsed(t) : 0);
  });
  n.set("TimerGetRemaining", (ctx, a) => {
    const t = handleArg(a, 0);
    return REAL(t ? ctx.clock.remaining(t) : 0);
  });
  n.set("TimerGetTimeout", (_c, a) => REAL(Number(handleArg(a, 0)?.data.get("timeout") ?? 0)));

  // -- math and strings ---------------------------------------------------

  n.set("GetRandomInt", (ctx, a) => INT(ctx.random.int(num(a, 0) | 0, num(a, 1) | 0)));
  n.set("GetRandomReal", (ctx, a) => REAL(ctx.random.real(num(a, 0), num(a, 1))));
  n.set("SquareRoot", (_c, a) => REAL(Math.sqrt(Math.max(0, num(a, 0)))));
  n.set("Pow", (_c, a) => REAL(Math.pow(num(a, 0), num(a, 1))));
  n.set("Sin", (_c, a) => REAL(Math.sin(num(a, 0))));
  n.set("Cos", (_c, a) => REAL(Math.cos(num(a, 0))));
  n.set("Tan", (_c, a) => REAL(Math.tan(num(a, 0))));
  n.set("Asin", (_c, a) => REAL(Math.asin(num(a, 0))));
  n.set("Acos", (_c, a) => REAL(Math.acos(num(a, 0))));
  n.set("Atan", (_c, a) => REAL(Math.atan(num(a, 0))));
  n.set("Atan2", (_c, a) => REAL(Math.atan2(num(a, 0), num(a, 1))));
  n.set("ModuloInteger", (_c, a) => {
    const d = num(a, 1) | 0;
    if (d === 0) return INT(0);
    let r = (num(a, 0) | 0) % d;
    if (r < 0) r += Math.abs(d);
    return INT(r);
  });
  n.set("ModuloReal", (_c, a) => {
    const d = num(a, 1);
    if (d === 0) return REAL(0);
    let r = num(a, 0) % d;
    if (r < 0) r += Math.abs(d);
    return REAL(r);
  });
  n.set("I2R", (_c, a) => REAL(num(a, 0)));
  n.set("R2I", (_c, a) => INT(Math.trunc(num(a, 0))));
  n.set("I2S", (_c, a) => STR(String(num(a, 0) | 0)));
  n.set("R2S", (_c, a) => STR(formatReal(num(a, 0))));
  n.set("R2SW", (_c, a) => STR(num(a, 0).toFixed(Math.max(0, num(a, 2) | 0))));
  n.set("S2I", (_c, a) => INT(parseInt(str(a, 0), 10) || 0));
  n.set("S2R", (_c, a) => REAL(parseFloat(str(a, 0)) || 0));
  n.set("StringLength", (_c, a) => INT(str(a, 0).length));
  n.set("SubString", (_c, a) => STR(str(a, 0).substring(num(a, 1) | 0, num(a, 2) | 0)));
  n.set("StringCase", (_c, a) => STR(bool(a, 1) ? str(a, 0).toUpperCase() : str(a, 0).toLowerCase()));
  n.set("StringHash", (_c, a) => {
    // FNV-1a: any stable hash works, but it must be identical on every client.
    const s = str(a, 0);
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return INT(h | 0);
  });

  // -- control ------------------------------------------------------------

  n.set("ExecuteFunc", (ctx, a) => { ctx.callByName(str(a, 0), []); return NOTHING; });

  return n;
}

/**
 * Constants that live in `common.j` / `Blizzard.j` and are referenced but never
 * declared by the map. Numeric ones must carry their real values or arithmetic
 * silently produces zeroes; the rest become opaque enum handles.
 */
export const EXTERNAL_CONSTANTS: Readonly<Record<string, JassValue>> = {
  bj_UNIT_FACING: REAL(270),
  bj_MAX_PLAYERS: INT(12),
  bj_MAX_PLAYER_SLOTS: INT(16),
  bj_CELLWIDTH: REAL(128),
  bj_PI: REAL(3.14159),
  bj_E: REAL(2.71828),
  bj_RADTODEG: REAL(57.2957795),
  bj_DEGTORAD: REAL(0.0174532925),
  bj_TEXT_DELAY_HINT: REAL(2),
  bj_MELEE_STARTING_GOLD: INT(750),
  bj_MELEE_STARTING_LUMBER: INT(200),
  bj_GHOUL_HARVEST_DELAY: REAL(0),
};
