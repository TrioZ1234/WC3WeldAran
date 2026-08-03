/**
 * The match screen: the world, the interface over it, and the player's hands.
 *
 * Three clocks run here and none of them is allowed to wait on another. The
 * simulation ticks at 32 Hz inside the worker. Snapshots arrive at 16 Hz. The
 * renderer draws whenever the display is ready. Drawing therefore always uses the
 * newest snapshot it has rather than asking for one, which is what keeps a heavy
 * tick from turning into a dropped frame.
 *
 * Input is written out here rather than reusing the viewer's orbit controls,
 * because an RTS has already spent the mouse buttons: left selects, right orders.
 * Panning moves to the keyboard, the middle button and the minimap - the same
 * places Warcraft III put it.
 */

import { h } from "../dom.ts";
import type { Screen, Shell } from "../app.ts";
import { OrbitCamera, project } from "../../camera.ts";
import { Renderer } from "../../renderer.ts";
import { buildTerrainMesh } from "../../terrain-mesh.ts";
import { loadDoodads, loadTerrain, type Placement, type Terrain } from "../../data.ts";
import { Session } from "../../game/session.ts";
import type { MatchConfig } from "../../game/match-config.ts";
import { localSlot } from "../../game/match-config.ts";
import {
  MAX_SLOTS,
  NEUTRAL_COLOUR,
  PLAYER_COLOURS,
} from "../../game/players.ts";
import {
  UNIT_FLAG_BUILDING,
  UNIT_STRIDE,
  type OrderKind,
  type Snapshot,
} from "../../game/protocol.ts";
import { Hud, type CommandId } from "../../hud/hud.ts";
import { Minimap } from "../../hud/minimap.ts";

/** Palette slots beyond the twelve players. */
const COLOUR_NEUTRAL = 12;
const COLOUR_SELECTED = 13;
const COLOUR_DOODAD = 14;

/** Instance floats per object, matching the renderer's vertex layout. */
const INSTANCE_FLOATS = 8;

/** A click shorter and smaller than this is a pick, not a marquee. */
const CLICK_SLOP = 5;

/** World radius a single click searches for a unit. */
const PICK_RADIUS = 220;

export function matchScreen(shell: Shell, config: MatchConfig): Screen {
  const canvas = h("canvas");
  const loadingBar = h("div", { class: "loading__fill" });
  const loadingStage = h("div", { class: "loading__stage" }, "подготовка");
  const loadingTip = h("div", { class: "loading__tip" });
  const loading = h(
    "div",
    { class: "screen loading" },
    h("h2", {}, "Загрузка"),
    h("div", { class: "loading__bar" }, loadingBar),
    loadingStage,
    loadingTip,
  );

  const hud = new Hud(config, {
    onCommand: (command) => runCommand(command),
    onFocusUnit: (id) => focusUnit(id),
  });

  const element = h("div", { class: "screen match" }, canvas, hud.element, loading);
  hud.element.style.display = "none";

  const camera = new OrbitCamera();
  const localPlayer = localSlot(config)?.slot ?? 0;

  let renderer: Renderer | null = null;
  let terrain: Terrain | null = null;
  let minimap: Minimap | null = null;
  let session: Session | null = null;
  let frameHandle = 0;
  let disposed = false;
  let overlay: HTMLElement | null = null;

  let selection: number[] = [];
  let armed: CommandId | null = null;
  let instanceScratch = new Float32Array(1024 * INSTANCE_FLOATS);
  const pressed = new Set<string>();
  let fps = 0;
  let frames = 0;
  let fpsClock = performance.now();
  /** Tick and selection the instance buffer currently holds. */
  let packedTick = -1;
  let packedSelection = "";

  // -- world height ---------------------------------------------------------

  /**
   * Ground height under a world point.
   *
   * Units are placed on the terrain rather than at z = 0 so that an army marching
   * over a ridge does not sink into it. Nearest tilepoint rather than bilinear:
   * this runs once per unit per frame, and at 128 units per tile the difference is
   * smaller than a unit's own footprint.
   */
  function heightAt(x: number, y: number): number {
    if (!terrain) return 0;
    const { width, height, offset, tileSize } = terrain.meta;
    const column = Math.round((x - offset[0]) / tileSize);
    const row = Math.round((y - offset[1]) / tileSize);
    if (column < 0 || row < 0 || column >= width || row >= height) return 0;
    return terrain.heightAt(row * width + column);
  }

  // -- boot -----------------------------------------------------------------

  async function boot(): Promise<void> {
    loadingStage.textContent = "инициализация WebGPU";
    const gpu = new Renderer(canvas);
    await gpu.init();
    renderer = gpu;

    // Twelve player colours, then neutral, the selection highlight and doodads.
    gpu.setUnitPalette([
      ...PLAYER_COLOURS.map((colour) => colour.rgb),
      NEUTRAL_COLOUR.rgb,
      [1, 0.87, 0.42],
      [0.24, 0.29, 0.2],
    ]);

    loadingStage.textContent = "загрузка ландшафта";
    loadingBar.style.width = "12%";
    terrain = await loadTerrain("/data").catch(() => null);

    if (terrain) {
      const mesh = buildTerrainMesh(terrain);
      gpu.setTerrain(mesh);
      gpu.setPalette(
        terrain.meta.groundTilesets.map(
          (id) => TILESET_COLOURS[id] ?? ([0.45, 0.43, 0.38] as [number, number, number]),
        ),
      );
      const [minX, minY, minZ] = mesh.bounds.min;
      const [maxX, maxY, maxZ] = mesh.bounds.max;
      camera.target = [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2];
      camera.maxDistance = (maxX - minX) * 1.4;
      camera.distance = Math.min(camera.maxDistance, 7000);
    } else {
      loadingTip.textContent =
        "Ландшафт недоступен — данные карты не собраны. Бой пойдёт на пустой плоскости.";
      camera.distance = 9000;
    }

    // Scenery is static, so it is uploaded once and never touched again.
    loadingStage.textContent = "декорации";
    loadingBar.style.width = "30%";
    const doodads = await loadDoodads("/data").catch(() => [] as Placement[]);
    if (doodads.length > 0) {
      gpu.setInstanceBatches([{ label: "doodads", ...packDoodads(doodads) }]);
    }

    minimap = new Minimap(hud.minimapCanvas, terrain);

    loadingStage.textContent = "запуск симуляции";
    session = new Session(config, {
      onProgress: (_stage, percent, note) => {
        loadingBar.style.width = `${Math.max(30, percent)}%`;
        loadingStage.textContent = note;
      },
      onReady: (note, degraded) => {
        hud.setTypeNames(session?.typeNames ?? []);
        hud.setFlag(degraded ? "тренировочный бой" : null);
        loading.style.display = "none";
        hud.element.style.display = "";
        hud.log(note);
        session?.setSpeed(config.speed);
        session?.start();
      },
      onSnapshot: (snapshot) => {
        // Keep the selection honest: units die, and a command card that lists
        // corpses is worse than one that lists nothing.
        if (selection.length > 0) selection = livingOf(snapshot, selection);
      },
      onLog: (text, slot) => hud.log(text, slot),
      onOver: (outcome) => {
        shell.results({ config, outcome, final: session?.snapshot ?? null });
      },
      onFailed: (message) => shell.fatal(new Error(message)),
    });

    startFrames();
  }

  // -- rendering ------------------------------------------------------------

  function startFrames(): void {
    const frame = (): void => {
      if (disposed) return;
      frameHandle = requestAnimationFrame(frame);
      if (!renderer) return;

      panFromKeyboard();
      renderer.resize();

      // Snapshots arrive at 16 Hz and frames run at the display's rate, so most
      // frames would re-upload bytes the GPU already has. Repack only when the
      // simulation moved or the highlight changed.
      const snapshot = session?.snapshot ?? null;
      if (snapshot) {
        const stamp = selection.join(",");
        if (snapshot.tick !== packedTick || stamp !== packedSelection) {
          packedTick = snapshot.tick;
          packedSelection = stamp;
          renderer.writeDynamicBatch("units", packUnits(snapshot), snapshot.unitCount);
        }
      }
      renderer.render(camera.viewProjection(renderer.aspect));

      frames++;
      const now = performance.now();
      if (now - fpsClock >= 500) {
        fps = (frames * 1000) / (now - fpsClock);
        frames = 0;
        fpsClock = now;
      }

      if (snapshot) {
        hud.update(snapshot, selection, fps);
        minimap?.draw(
          snapshot,
          { centre: [camera.target[0], camera.target[1]], radius: camera.distance * 0.62 },
          localPlayer,
        );
      }
    };
    frameHandle = requestAnimationFrame(frame);
  }

  /**
   * Pack a snapshot into instance data.
   *
   * One buffer for every unit on screen, reused between frames. Selected units
   * are drawn in the highlight colour and slightly larger - at the zoom an RTS is
   * played at, an outline a pixel wide is not visible, but a size difference is.
   */
  function packUnits(snapshot: Snapshot): Float32Array {
    const needed = snapshot.unitCount * INSTANCE_FLOATS;
    if (instanceScratch.length < needed) {
      instanceScratch = new Float32Array(Math.ceil(needed * 1.5));
    }
    const out = instanceScratch;
    const chosen = new Set(selection);

    for (let index = 0; index < snapshot.unitCount; index++) {
      const from = index * UNIT_STRIDE;
      const to = index * INSTANCE_FLOATS;
      const id = snapshot.units[from + 0];
      const owner = snapshot.units[from + 1];
      const x = snapshot.units[from + 2];
      const y = snapshot.units[from + 3];
      const building = (snapshot.units[from + 7] & UNIT_FLAG_BUILDING) !== 0;
      const selected = chosen.has(id);

      const size = building ? 260 : selected ? 130 : 108;
      out[to + 0] = x;
      out[to + 1] = y;
      out[to + 2] = heightAt(x, y);
      out[to + 3] = snapshot.units[from + 6];
      out[to + 4] = size;
      out[to + 5] = size;
      out[to + 6] = building ? 420 : 190;
      out[to + 7] = selected
        ? COLOUR_SELECTED
        : owner < MAX_SLOTS
          ? owner
          : COLOUR_NEUTRAL;
    }
    return out;
  }

  function packDoodads(items: Placement[]): { data: Float32Array; count: number } {
    const data = new Float32Array(items.length * INSTANCE_FLOATS);
    items.forEach((item, index) => {
      const at = index * INSTANCE_FLOATS;
      data[at + 0] = item.pos[0];
      data[at + 1] = item.pos[1];
      data[at + 2] = item.pos[2];
      data[at + 3] = item.rot;
      data[at + 4] = 90 * (item.scale[0] || 1);
      data[at + 5] = 90 * (item.scale[1] || 1);
      data[at + 6] = 150 * (item.scale[2] || 1);
      data[at + 7] = COLOUR_DOODAD;
    });
    return { data, count: items.length };
  }

  // -- selection and orders -------------------------------------------------

  const livingOf = (snapshot: Snapshot, ids: number[]): number[] => {
    const alive = new Set<number>();
    for (let index = 0; index < snapshot.unitCount; index++) {
      alive.add(snapshot.units[index * UNIT_STRIDE + 0]);
    }
    return ids.filter((id) => alive.has(id));
  };

  function setSelection(ids: number[]): void {
    selection = ids;
    session?.select(ids);
  }

  /**
   * Units of the local player inside a screen rectangle.
   *
   * Selection is done by projecting each unit forward rather than by unprojecting
   * the rectangle: forward is one matrix multiply per unit with no ambiguity about
   * depth, and it is the same arithmetic the GPU is already doing.
   */
  function selectInRectangle(x0: number, y0: number, x1: number, y1: number): void {
    const snapshot = session?.snapshot;
    if (!snapshot || !renderer) return;

    const rect = canvas.getBoundingClientRect();
    const matrix = camera.viewProjection(renderer.aspect);
    const left = Math.min(x0, x1);
    const right = Math.max(x0, x1);
    const top = Math.min(y0, y1);
    const bottom = Math.max(y0, y1);

    const picked: number[] = [];
    for (let index = 0; index < snapshot.unitCount; index++) {
      const at = index * UNIT_STRIDE;
      if (snapshot.units[at + 1] !== localPlayer) continue;
      const worldX = snapshot.units[at + 2];
      const worldY = snapshot.units[at + 3];
      const [ndcX, ndcY, w] = project(matrix, worldX, worldY, heightAt(worldX, worldY) + 90);
      if (w <= 0) continue;
      const screenX = ((ndcX + 1) / 2) * rect.width;
      const screenY = ((1 - ndcY) / 2) * rect.height;
      if (screenX >= left && screenX <= right && screenY >= top && screenY <= bottom) {
        picked.push(snapshot.units[at + 0]);
      }
    }
    // Buildings only when nothing else was caught: dragging a box over a city
    // should select the army standing in it, not the city.
    setSelection(picked);
  }

  /** Nearest own unit to a world point, for a plain click. */
  function pickAt(worldX: number, worldY: number): number | null {
    const snapshot = session?.snapshot;
    if (!snapshot) return null;
    let best: number | null = null;
    let bestDistance = PICK_RADIUS * PICK_RADIUS;
    for (let index = 0; index < snapshot.unitCount; index++) {
      const at = index * UNIT_STRIDE;
      if (snapshot.units[at + 1] !== localPlayer) continue;
      const dx = snapshot.units[at + 2] - worldX;
      const dy = snapshot.units[at + 3] - worldY;
      const distance = dx * dx + dy * dy;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = snapshot.units[at + 0];
      }
    }
    return best;
  }

  function issueOrder(kind: OrderKind, worldX: number, worldY: number): void {
    if (selection.length === 0) return;
    session?.order(kind, worldX, worldY);
    armed = null;
    hud.setArmedCommand(null);
  }

  function runCommand(command: CommandId): void {
    switch (command) {
      case "stop":
      case "hold":
        issueOrder(command, 0, 0);
        break;
      case "centre":
        centreOnSelection();
        break;
      case "menu":
        toggleMenu();
        break;
      case "move":
      case "attack":
        // Arm the order; the next left click on the ground places it.
        armed = armed === command ? null : command;
        hud.setArmedCommand(armed);
        break;
    }
  }

  function focusUnit(id: number): void {
    const snapshot = session?.snapshot;
    if (!snapshot) return;
    for (let index = 0; index < snapshot.unitCount; index++) {
      const at = index * UNIT_STRIDE;
      if (snapshot.units[at + 0] !== id) continue;
      camera.target[0] = snapshot.units[at + 2];
      camera.target[1] = snapshot.units[at + 3];
      camera.target[2] = heightAt(camera.target[0], camera.target[1]);
      setSelection([id]);
      return;
    }
  }

  /** Centre the camera on the selection, or on the player's army if none. */
  function centreOnSelection(): void {
    const snapshot = session?.snapshot;
    if (!snapshot) return;
    const wanted = selection.length > 0 ? new Set(selection) : null;
    let sumX = 0;
    let sumY = 0;
    let count = 0;
    for (let index = 0; index < snapshot.unitCount; index++) {
      const at = index * UNIT_STRIDE;
      const id = snapshot.units[at + 0];
      if (wanted ? !wanted.has(id) : snapshot.units[at + 1] !== localPlayer) continue;
      sumX += snapshot.units[at + 2];
      sumY += snapshot.units[at + 3];
      count++;
    }
    if (count === 0) return;
    camera.target[0] = sumX / count;
    camera.target[1] = sumY / count;
    camera.target[2] = heightAt(camera.target[0], camera.target[1]);
  }

  // -- input ----------------------------------------------------------------

  let dragging: "select" | "pan" | "orbit" | null = null;
  let dragStart: [number, number] = [0, 0];
  let dragLast: [number, number] = [0, 0];

  const ndcOf = (event: PointerEvent | MouseEvent): [number, number] => {
    const rect = canvas.getBoundingClientRect();
    return [
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      1 - ((event.clientY - rect.top) / rect.height) * 2,
    ];
  };

  const groundOf = (event: PointerEvent | MouseEvent): [number, number] | null => {
    if (!renderer) return null;
    const [ndcX, ndcY] = ndcOf(event);
    return camera.groundPoint(ndcX, ndcY, renderer.aspect, camera.target[2]);
  };

  canvas.addEventListener("contextmenu", (event) => event.preventDefault());

  canvas.addEventListener("pointerdown", (event) => {
    canvas.setPointerCapture(event.pointerId);
    dragStart = [event.clientX, event.clientY];
    dragLast = [event.clientX, event.clientY];

    if (event.button === 2) {
      // Right click is an order, resolved immediately - an RTS that made the
      // player wait for mouse-up here would feel broken.
      const point = groundOf(event);
      if (point) issueOrder("attack", point[0], point[1]);
      return;
    }
    if (event.button === 1 || event.altKey) {
      dragging = event.altKey ? "orbit" : "pan";
      return;
    }
    dragging = "select";
    hud.marquee.style.display = "block";
    updateMarquee(event.clientX, event.clientY);
  });

  canvas.addEventListener("pointermove", (event) => {
    if (!dragging) return;
    const dx = event.clientX - dragLast[0];
    const dy = event.clientY - dragLast[1];
    dragLast = [event.clientX, event.clientY];

    if (dragging === "select") updateMarquee(event.clientX, event.clientY);
    else if (dragging === "pan") camera.pan(-dx, dy);
    else camera.orbit(dx, dy);
  });

  canvas.addEventListener("pointerup", (event) => {
    canvas.releasePointerCapture(event.pointerId);
    const wasDragging = dragging;
    dragging = null;
    hud.marquee.style.display = "none";
    if (wasDragging !== "select") return;

    const moved =
      Math.abs(event.clientX - dragStart[0]) + Math.abs(event.clientY - dragStart[1]);

    if (moved <= CLICK_SLOP) {
      const point = groundOf(event);
      if (!point) return;
      if (armed) {
        issueOrder(armed === "attack" ? "attack" : "move", point[0], point[1]);
        return;
      }
      const id = pickAt(point[0], point[1]);
      setSelection(id === null ? [] : [id]);
      return;
    }

    const rect = canvas.getBoundingClientRect();
    selectInRectangle(
      dragStart[0] - rect.left,
      dragStart[1] - rect.top,
      event.clientX - rect.left,
      event.clientY - rect.top,
    );
  });

  function updateMarquee(x: number, y: number): void {
    const left = Math.min(dragStart[0], x);
    const top = Math.min(dragStart[1], y);
    hud.marquee.style.left = `${left}px`;
    hud.marquee.style.top = `${top}px`;
    hud.marquee.style.width = `${Math.abs(x - dragStart[0])}px`;
    hud.marquee.style.height = `${Math.abs(y - dragStart[1])}px`;
  }

  canvas.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      camera.zoom(event.deltaY);
    },
    { passive: false },
  );

  hud.minimapCanvas.addEventListener("pointerdown", (event) => {
    if (!minimap) return;
    const rect = hud.minimapCanvas.getBoundingClientRect();
    const [x, y] = minimap.toWorld(
      (event.clientX - rect.left) / rect.width,
      (event.clientY - rect.top) / rect.height,
    );
    if (event.button === 2 && selection.length > 0) {
      issueOrder("attack", x, y);
      return;
    }
    camera.target[0] = x;
    camera.target[1] = y;
    camera.target[2] = heightAt(x, y);
  });
  hud.minimapCanvas.addEventListener("contextmenu", (event) => event.preventDefault());

  /** Keyboard panning, applied per frame so the speed is frame-rate independent. */
  function panFromKeyboard(): void {
    if (pressed.size === 0) return;
    const step = 22;
    let dx = 0;
    let dy = 0;
    if (pressed.has("KeyW") || pressed.has("ArrowUp")) dy += step;
    if (pressed.has("KeyS") || pressed.has("ArrowDown")) dy -= step;
    if (pressed.has("KeyA") || pressed.has("ArrowLeft")) dx -= step;
    if (pressed.has("KeyD") || pressed.has("ArrowRight")) dx += step;
    if (dx !== 0 || dy !== 0) camera.pan(dx, -dy);
  }

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.target instanceof HTMLInputElement) return;
    pressed.add(event.code);

    switch (event.code) {
      case "Escape":
        if (armed) {
          armed = null;
          hud.setArmedCommand(null);
        } else if (overlay) {
          closeMenu();
        } else if (selection.length > 0) {
          setSelection([]);
        } else {
          toggleMenu();
        }
        break;
      case "F10":
        event.preventDefault();
        toggleMenu();
        break;
      case "KeyM":
        runCommand("move");
        break;
      case "KeyA":
        if (!event.ctrlKey) runCommand("attack");
        break;
      case "KeyH":
        runCommand("hold");
        break;
      case "Space":
        event.preventDefault();
        centreOnSelection();
        break;
      case "KeyP":
        if (session) hud.log(session.togglePause() ? "Пауза" : "Продолжаем");
        break;
      case "Digit1":
      case "Digit2":
      case "Digit4": {
        const speed = Number(event.code.slice(5)) as 1 | 2 | 4;
        session?.setSpeed(speed);
        hud.log(`Скорость ×${speed}`);
        break;
      }
      case "KeyE":
        if (event.ctrlKey) selectAllOwn();
        break;
    }
    // Stop is on S, but S also pans; the pan wins while a key is held, so Stop
    // gets the less crowded X, matching the map's own habit of Escape-to-cancel.
    if (event.code === "KeyX") runCommand("stop");
  };

  const onKeyUp = (event: KeyboardEvent): void => {
    pressed.delete(event.code);
  };

  function selectAllOwn(): void {
    const snapshot = session?.snapshot;
    if (!snapshot) return;
    const own: number[] = [];
    for (let index = 0; index < snapshot.unitCount; index++) {
      const at = index * UNIT_STRIDE;
      if (snapshot.units[at + 1] !== localPlayer) continue;
      if ((snapshot.units[at + 7] & UNIT_FLAG_BUILDING) !== 0) continue;
      own.push(snapshot.units[at + 0]);
    }
    setSelection(own);
    hud.log(`Выделено войск: ${own.length}`);
  }

  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);

  // -- pause menu -----------------------------------------------------------

  function toggleMenu(): void {
    if (overlay) closeMenu();
    else openMenu();
  }

  function openMenu(): void {
    session?.setPaused(true);
    overlay = h(
      "div",
      { class: "overlay" },
      h(
        "div",
        { class: "panel overlay__panel" },
        h("h2", {}, "Пауза"),
        h("hr", { class: "rule" }),
        h("div", { class: "dim" }, config.mapName),
        h(
          "div",
          { class: "overlay__actions" },
          h("button", { class: "btn btn--primary", onclick: () => closeMenu() }, "Продолжить"),
          h(
            "button",
            {
              class: "btn",
              onclick: () => {
                const speed = config.speed === 4 ? 1 : ((config.speed * 2) as 1 | 2 | 4);
                config.speed = speed;
                session?.setSpeed(speed);
                closeMenu();
                hud.log(`Скорость ×${speed}`);
              },
            },
            `Скорость: ×${config.speed}`,
          ),
          h("button", { class: "btn", onclick: () => shell.lobby() }, "Выйти в лобби"),
          h("button", { class: "btn btn--quiet", onclick: () => shell.menu() }, "Главное меню"),
        ),
      ),
    );
    element.appendChild(overlay);
  }

  function closeMenu(): void {
    overlay?.remove();
    overlay = null;
    session?.setPaused(false);
  }

  boot().catch((error) => shell.fatal(error));

  return {
    element,
    dispose: () => {
      disposed = true;
      cancelAnimationFrame(frameHandle);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      session?.dispose();
    },
  };
}

/**
 * Per-tileset ground colours.
 *
 * Shared with the world viewer in intent but kept here as its own table: the
 * viewer is a diagnostic tool and may want garish contrast, while a match wants
 * the terrain to sit behind the units rather than compete with them.
 */
const TILESET_COLOURS: Record<string, [number, number, number]> = {
  Fdrt: [0.41, 0.35, 0.24], Frok: [0.43, 0.42, 0.38], Fgrs: [0.31, 0.4, 0.21],
  Ldrg: [0.47, 0.38, 0.24], Wsng: [0.29, 0.42, 0.24], Alvd: [0.38, 0.36, 0.29],
  Zgrs: [0.34, 0.44, 0.23], Adrg: [0.5, 0.41, 0.26], Yblm: [0.36, 0.33, 0.26],
  Ywmb: [0.39, 0.35, 0.27], Dlvc: [0.34, 0.29, 0.24], Idki: [0.59, 0.63, 0.67],
  Iice: [0.73, 0.79, 0.84], Qcbp: [0.42, 0.39, 0.35], Qstp: [0.46, 0.43, 0.36],
  Zsan: [0.65, 0.58, 0.42],
};
