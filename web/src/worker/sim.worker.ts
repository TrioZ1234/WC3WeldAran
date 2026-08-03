/**
 * The simulation worker: fetches what a match needs, then runs it off the main
 * thread.
 *
 * Why a worker at all. The clock runs at 32 Hz and each tick executes the map's
 * own script - 16 177 lines of JASS, 205 triggers, thousands of units. On the
 * main thread a slow tick is a dropped frame, and the honest failure mode of
 * that arrangement is a game that stutters exactly when it gets interesting.
 * Here the renderer keeps its own frame rate and reads the latest snapshot,
 * which is also precisely the shape a networked client needs.
 *
 * Everything DOM-shaped and network-shaped lives in this file. `MatchRunner`
 * next door stays pure.
 */

import { MatchRunner, type MatchAssets } from "./match-runner.ts";
import type { JassSource } from "../../../engine/jass/interpreter.ts";
import { TICKS_PER_SECOND } from "../../../engine/sim/scheduler.ts";
import type { MatchConfig } from "../game/match-config.ts";
import type { FromSim, LoadStage, ToSim } from "../game/protocol.ts";

/** Snapshot rate. Sixteen a second is smooth on screen at half the packing cost of 32. */
const SNAPSHOT_EVERY_TICKS = 2;

/**
 * Ticks the loop is allowed to catch up in one pass.
 *
 * Without a ceiling, a browser tab that was backgrounded for a minute wakes up
 * owing 1 920 ticks and freezes while it pays them off. Dropping the debt is the
 * right call for a single-player match; the networked step will replace this with
 * the lockstep turn timer, where nobody may skip a tick.
 */
const MAX_CATCHUP_TICKS = 8;

const post = (message: FromSim, transfer: Transferable[] = []): void => {
  (self as unknown as Worker).postMessage(message, transfer);
};

const progress = (stage: LoadStage, percent: number, note: string): void =>
  post({ type: "progress", stage, percent, note });

let runner: MatchRunner | null = null;
let config: MatchConfig | null = null;
let running = false;
let paused = false;
let speed = 1;
let timer: ReturnType<typeof setTimeout> | null = null;
let lastFrame = 0;
let tickDebt = 0;
let ticksSinceSnapshot = 0;
const selected = new Set<number>();

// -- loading ----------------------------------------------------------------

async function text(url: string): Promise<string | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    return await response.text();
  } catch {
    return null;
  }
}

async function json<T>(url: string): Promise<T | null> {
  const body = await text(url);
  if (body === null) return null;
  try {
    return JSON.parse(body) as T;
  } catch {
    return null;
  }
}

/**
 * Gather the match assets.
 *
 * Missing files are reported, not thrown. A clone without `build/data` should
 * land in a clearly labelled training match with an explanation, rather than on
 * an error screen that says nothing about which command fixes it.
 */
async function loadAssets(dataRoot: string): Promise<{ assets: MatchAssets; notes: string[] }> {
  const notes: string[] = [];

  progress("scripts", 8, "загрузка скриптов Warcraft III");
  const names = ["common.j", "Blizzard.j", "war3map.j"];
  const scripts: JassSource[] = [];
  for (const [index, name] of names.entries()) {
    const body = await text(`${dataRoot}/scripts/${name}`);
    progress("scripts", 8 + index * 12, `скрипт ${name}`);
    if (body === null) {
      notes.push(`нет ${name}`);
      continue;
    }
    scripts.push({ name, text: body });
  }
  // The map script alone is not enough: without common.j the natives are
  // undeclared and the interpreter cannot even type its own stubs.
  const complete = scripts.length === names.length;
  if (!complete && scripts.length > 0) {
    notes.push("набор скриптов неполный, логика карты не запускается");
  }

  progress("objects", 50, "характеристики объектов");
  const resolvedUnits = await json<Array<{ id: string; fields: Record<string, unknown> }>>(
    `${dataRoot}/resolved/units.json`,
  );
  if (!resolvedUnits) notes.push("нет resolved/units.json");

  progress("objects", 66, "таблица урона карты");
  const misc = await text(`${dataRoot}/scripts/war3mapMisc.txt`);
  if (!misc) notes.push("нет war3mapMisc.txt, таблица урона стоковая");

  progress("world", 78, "стартовые позиции");
  const mapInfo = await json<{ players?: Array<{ start: [number, number] }> }>(`${dataRoot}/map.json`);
  const startLocations = (mapInfo?.players ?? []).map((player) => player.start);

  return {
    assets: { scripts: complete ? scripts : [], resolvedUnits, misc, startLocations },
    notes,
  };
}

// -- the loop ---------------------------------------------------------------

/**
 * Advance the simulation in step with the wall clock.
 *
 * `setTimeout` rather than `requestAnimationFrame`: a worker has no frames, and
 * the simulation rate must not be tied to a display's refresh rate anyway. Game
 * speed multiplies how much time the loop owes, never the tick rate itself - the
 * map's own 32 Hz heartbeat is load-bearing, so changing it would change the
 * gameplay rather than its pace.
 */
function loop(): void {
  if (!running || !runner) return;

  const now = performance.now();
  const elapsed = Math.min(500, now - lastFrame);
  lastFrame = now;

  if (!paused) {
    tickDebt += (elapsed / 1000) * TICKS_PER_SECOND * speed;
    const owed = Math.min(MAX_CATCHUP_TICKS, Math.floor(tickDebt));
    tickDebt -= Math.floor(tickDebt);

    const startedAt = performance.now();
    for (let i = 0; i < owed; i++) {
      runner.step();
      ticksSinceSnapshot++;
    }
    const simMs = performance.now() - startedAt;

    if (owed > 0 && ticksSinceSnapshot >= SNAPSHOT_EVERY_TICKS) {
      ticksSinceSnapshot = 0;
      const snapshot = runner.snapshot(simMs, selected);
      post({ type: "snapshot", snapshot }, [
        snapshot.units.buffer as ArrayBuffer,
        snapshot.players.buffer as ArrayBuffer,
      ]);
    }

    const outcome = runner.finished;
    if (outcome) {
      running = false;
      post({ type: "over", outcome });
      return;
    }
  }

  timer = setTimeout(loop, 1000 / TICKS_PER_SECOND);
}

// -- messages ---------------------------------------------------------------

async function boot(message: Extract<ToSim, { type: "boot" }>): Promise<void> {
  config = message.config;
  const { assets, notes } = await loadAssets(message.dataRoot);

  progress("spawn", 88, assets.scripts.length > 0 ? "инициализация карты" : "подготовка боя");
  runner = new MatchRunner(message.config, assets, (line, slot) =>
    post({ type: "log", text: line, slot }),
  );

  const summary = runner.boot();
  progress("done", 100, "готово");

  const note = runner.sandbox
    ? `Тренировочный бой. ${notes.join(", ") || "данные карты недоступны"}. ` +
      "Полная карта запускается после python3 build.py путь/к/WFWA.w3x"
    : `Карта загружена: ${summary.functions} функций, ${summary.units} юнитов, ` +
      `${summary.timers} таймеров.`;

  post({ type: "ready", typeNames: runner.typeNames, note, degraded: runner.sandbox });
}

self.onmessage = (event: MessageEvent<ToSim>): void => {
  const message = event.data;
  try {
    switch (message.type) {
      case "boot":
        boot(message).catch((error) =>
          post({ type: "failed", message: error instanceof Error ? error.message : String(error) }),
        );
        break;

      case "start":
        if (!runner) return;
        running = true;
        paused = false;
        lastFrame = performance.now();
        tickDebt = 0;
        loop();
        break;

      case "pause":
        paused = message.paused;
        lastFrame = performance.now();
        break;

      case "speed":
        speed = message.speed === 2 || message.speed === 4 ? message.speed : 1;
        break;

      case "select":
        setSelection(message.units);
        break;

      case "order": {
        if (!runner || !config) return;
        const owner = config.slots.find((slot) => slot.local)?.slot ?? 0;
        setSelection(message.units);
        runner.order(message.kind, message.units, message.x, message.y, owner);
        break;
      }

      case "shutdown":
        running = false;
        if (timer !== null) clearTimeout(timer);
        runner = null;
        break;
    }
  } catch (error) {
    post({ type: "failed", message: error instanceof Error ? error.message : String(error) });
  }
};

/**
 * Keep the worker's idea of the selection in step with the interface's.
 *
 * The selection itself lives on the main thread - it is an interface concern -
 * but each snapshot has to mark the selected units so the renderer can highlight
 * them without a per-unit lookup every frame.
 */
function setSelection(ids: number[]): void {
  selected.clear();
  for (const id of ids) selected.add(id);
}
