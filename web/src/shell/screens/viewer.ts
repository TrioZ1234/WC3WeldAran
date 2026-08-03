/**
 * World viewer.
 *
 * This is the original client, kept intact and moved behind a menu entry. It is
 * not the game: it draws every placed object as a box and measures how the volume
 * behaves - 25 222 doodads and 2 401 units in three draw calls. That measurement
 * is the reason the rest of this interface was safe to build on top, so removing
 * the tool that produces it would be a poor trade.
 */

import { h } from "../dom.ts";
import type { Screen, Shell } from "../app.ts";
import { OrbitCamera } from "../../camera.ts";
import { loadDoodads, loadMapInfo, loadTerrain, loadUnits } from "../../data.ts";
import { Renderer, type InstanceBatch } from "../../renderer.ts";
import { buildTerrainMesh } from "../../terrain-mesh.ts";
import { NEUTRAL_COLOUR, PLAYER_COLOURS } from "../../game/players.ts";

const DATA_ROOT = "/data";

const TILESET_COLOURS: Record<string, [number, number, number]> = {
  Fdrt: [0.41, 0.35, 0.24], Frok: [0.43, 0.42, 0.38], Fgrs: [0.31, 0.4, 0.21],
  Ldrg: [0.47, 0.38, 0.24], Wsng: [0.29, 0.42, 0.24], Alvd: [0.38, 0.36, 0.29],
  Zgrs: [0.34, 0.44, 0.23], Adrg: [0.5, 0.41, 0.26], Yblm: [0.36, 0.33, 0.26],
  Ywmb: [0.39, 0.35, 0.27], Dlvc: [0.34, 0.29, 0.24], Idki: [0.59, 0.63, 0.67],
  Iice: [0.73, 0.79, 0.84], Qcbp: [0.42, 0.39, 0.35], Qstp: [0.46, 0.43, 0.36],
  Zsan: [0.65, 0.58, 0.42],
};

/** Palette slots for the viewer's instanced boxes. */
const COLOUR_DOODAD = 14;
const COLOUR_NEUTRAL = 12;

export function viewerScreen(shell: Shell): Screen {
  const canvas = h("canvas");
  const readout = h("div", { class: "hud__diag", style: "bottom:16px;right:16px" }, "загрузка…");
  const element = h(
    "div",
    { class: "screen match" },
    canvas,
    h(
      "div",
      { class: "hud" },
      h(
        "div",
        { class: "hud__top" },
        h("span", { class: "dim" }, "Просмотрщик мира"),
        h("button", { class: "btn btn--quiet btn--small", onclick: () => shell.menu() }, "Назад"),
      ),
      readout,
    ),
  );

  let handle = 0;
  let disposed = false;

  async function boot(): Promise<void> {
    const renderer = new Renderer(canvas);
    await renderer.init();
    renderer.setUnitPalette([
      ...PLAYER_COLOURS.map((colour) => colour.rgb),
      NEUTRAL_COLOUR.rgb,
      [1, 0.87, 0.42],
      [0.24, 0.29, 0.2],
    ]);

    const [info, terrain, doodads, units] = await Promise.all([
      loadMapInfo(DATA_ROOT),
      loadTerrain(DATA_ROOT),
      loadDoodads(DATA_ROOT),
      loadUnits(DATA_ROOT),
    ]);

    const started = performance.now();
    const mesh = buildTerrainMesh(terrain);
    const meshMs = performance.now() - started;
    renderer.setTerrain(mesh);
    renderer.setPalette(
      terrain.meta.groundTilesets.map(
        (id) => TILESET_COLOURS[id] ?? ([0.45, 0.43, 0.38] as [number, number, number]),
      ),
    );

    const batches: InstanceBatch[] = [
      pack("doodads", doodads, () => COLOUR_DOODAD, 90),
      pack(
        "units",
        units,
        (item) => {
          const player = (item as { player: number }).player;
          return player < PLAYER_COLOURS.length ? player : COLOUR_NEUTRAL;
        },
        150,
      ),
    ];
    renderer.setInstanceBatches(batches);

    const camera = new OrbitCamera();
    const [minX, minY, minZ] = mesh.bounds.min;
    const [maxX, maxY, maxZ] = mesh.bounds.max;
    camera.target = [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2];
    camera.distance = (maxX - minX) * 0.75;
    camera.maxDistance = (maxX - minX) * 2;
    camera.attach(canvas);

    const summary =
      `${info.author} · ${terrain.meta.width - 1}x${terrain.meta.height - 1} тайлов · ` +
      `вершин ${mesh.vertexCount.toLocaleString("ru")} · ` +
      `треугольников ${(mesh.indexCount / 3).toLocaleString("ru")} · ` +
      `декораций ${doodads.length.toLocaleString("ru")} · ` +
      `юнитов ${units.length.toLocaleString("ru")} · ` +
      `сетка ${meshMs.toFixed(0)} мс · вызовов отрисовки ${renderer.drawCallCount}`;

    let frames = 0;
    let clock = performance.now();
    let fps = 0;

    const frame = (): void => {
      if (disposed) return;
      handle = requestAnimationFrame(frame);
      renderer.resize();
      renderer.render(camera.viewProjection(renderer.aspect));
      frames++;
      const now = performance.now();
      if (now - clock >= 500) {
        fps = (frames * 1000) / (now - clock);
        frames = 0;
        clock = now;
      }
      readout.textContent = `${summary} · ${fps.toFixed(0)} FPS`;
    };
    handle = requestAnimationFrame(frame);
  }

  boot().catch((error) => shell.fatal(error));

  return {
    element,
    dispose: () => {
      disposed = true;
      cancelAnimationFrame(handle);
    },
  };
}

function pack(
  label: string,
  items: Array<{ pos: [number, number, number]; rot: number; scale: [number, number, number] }>,
  colourOf: (item: unknown) => number,
  baseSize: number,
): InstanceBatch {
  const data = new Float32Array(items.length * 8);
  items.forEach((item, index) => {
    const at = index * 8;
    data[at + 0] = item.pos[0];
    data[at + 1] = item.pos[1];
    data[at + 2] = item.pos[2];
    data[at + 3] = item.rot;
    data[at + 4] = baseSize * (item.scale[0] || 1);
    data[at + 5] = baseSize * (item.scale[1] || 1);
    data[at + 6] = baseSize * 1.6 * (item.scale[2] || 1);
    data[at + 7] = colourOf(item);
  });
  return { label, data, count: items.length };
}
