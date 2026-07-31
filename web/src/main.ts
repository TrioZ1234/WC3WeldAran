/**
 * World viewer entry point.
 *
 * Loads the pipeline output and draws the map: terrain grid plus every placed
 * doodad and unit. Nothing here is gameplay - the point is to prove the data
 * pipeline end to end and to measure whether the real content volume renders
 * at speed before any engine work is built on top of it.
 */

import { OrbitCamera } from "./camera";
import { loadDoodads, loadMapInfo, loadTerrain, loadUnits } from "./data";
import { Renderer, type InstanceBatch } from "./renderer";
import { buildTerrainMesh } from "./terrain-mesh";

const DATA_ROOT = "/data";

// Rough per-tileset colours so terrain reads correctly before the real
// texture atlas is wired up.
const TILESET_COLOURS: Record<string, [number, number, number]> = {
  Fdrt: [0.41, 0.35, 0.24], Frok: [0.43, 0.42, 0.38], Fgrs: [0.31, 0.40, 0.21],
  Ldrg: [0.47, 0.38, 0.24], Wsng: [0.29, 0.42, 0.24], Alvd: [0.38, 0.36, 0.29],
  Zgrs: [0.34, 0.44, 0.23], Adrg: [0.50, 0.41, 0.26], Yblm: [0.36, 0.33, 0.26],
  Ywmb: [0.39, 0.35, 0.27], Dlvc: [0.34, 0.29, 0.24], Idki: [0.59, 0.63, 0.67],
  Iice: [0.73, 0.79, 0.84], Qcbp: [0.42, 0.39, 0.35], Qstp: [0.46, 0.43, 0.36],
  Zsan: [0.65, 0.58, 0.42],
};

const PLACEMENT_COLOUR = { doodad: 6, playerUnit: 12, neutralUnit: 15 };

const hud = document.getElementById("hud") as HTMLDivElement;
const errorBox = document.getElementById("err") as HTMLDivElement;

function fail(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  errorBox.style.display = "grid";
  errorBox.textContent = message;
  hud.style.display = "none";
  console.error(error);
}

async function main(): Promise<void> {
  const canvas = document.getElementById("view") as HTMLCanvasElement;
  const renderer = new Renderer(canvas);
  await renderer.init();

  hud.textContent = "загрузка данных карты…";
  const [info, terrain, doodads, units] = await Promise.all([
    loadMapInfo(DATA_ROOT),
    loadTerrain(DATA_ROOT),
    loadDoodads(DATA_ROOT),
    loadUnits(DATA_ROOT),
  ]);

  hud.textContent = "построение сетки ландшафта…";
  const started = performance.now();
  const mesh = buildTerrainMesh(terrain);
  const meshMs = performance.now() - started;
  renderer.setTerrain(mesh);

  const FALLBACK_TILE: [number, number, number] = [0.45, 0.43, 0.38];
  renderer.setPalette(
    terrain.meta.groundTilesets.map((id) => TILESET_COLOURS[id] ?? FALLBACK_TILE),
  );

  // One batch per kind keeps the draw-call count at three regardless of how
  // many objects the map places.
  const batches: InstanceBatch[] = [
    packInstances("doodads", doodads, () => PLACEMENT_COLOUR.doodad, 90),
    packInstances(
      "units",
      units,
      (item) => ((item as { player: number }).player < 12
        ? PLACEMENT_COLOUR.playerUnit
        : PLACEMENT_COLOUR.neutralUnit),
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

  let frames = 0;
  let fpsClock = performance.now();
  let fps = 0;

  const summary = [
    `<b>${escapeHtml(stripColourCodes(info.name))}</b>`,
    `<span class="k">автор</span> ${escapeHtml(info.author)}`,
    `<span class="k">размер</span> ${terrain.meta.width - 1}x${terrain.meta.height - 1} тайлов`,
    `<span class="k">вершин</span> ${mesh.vertexCount.toLocaleString("ru")}`,
    `<span class="k">треугольников</span> ${(mesh.indexCount / 3).toLocaleString("ru")}`,
    `<span class="k">декораций</span> ${doodads.length.toLocaleString("ru")}`,
    `<span class="k">юнитов</span> ${units.length.toLocaleString("ru")}`,
    `<span class="k">сетка собрана за</span> ${meshMs.toFixed(0)} мс`,
    `<span class="k">вызовов отрисовки</span> ${renderer.drawCallCount}`,
  ].join("<br>");

  function frame(): void {
    renderer.resize();
    renderer.render(camera.viewProjection(renderer.aspect));

    frames++;
    const now = performance.now();
    if (now - fpsClock >= 500) {
      fps = (frames * 1000) / (now - fpsClock);
      frames = 0;
      fpsClock = now;
    }
    hud.innerHTML = `${summary}<br><span class="k">FPS</span> <b>${fps.toFixed(0)}</b>`;
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

function packInstances(
  label: string,
  items: { pos: [number, number, number]; rot: number; scale: [number, number, number] }[],
  colourOf: (item: unknown) => number,
  baseSize: number,
): InstanceBatch {
  const data = new Float32Array(items.length * 8);
  items.forEach((item, i) => {
    const o = i * 8;
    data[o + 0] = item.pos[0];
    data[o + 1] = item.pos[1];
    data[o + 2] = item.pos[2];
    data[o + 3] = item.rot;
    data[o + 4] = baseSize * (item.scale[0] || 1);
    data[o + 5] = baseSize * (item.scale[1] || 1);
    data[o + 6] = baseSize * 1.6 * (item.scale[2] || 1);
    data[o + 7] = colourOf(item);
  });
  return { label, data, count: items.length };
}

const stripColourCodes = (text: string) => text.replace(/\|c[0-9a-fA-F]{8}|\|r/g, "").trim();
const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;",
};
const escapeHtml = (text: string) => text.replace(/[&<>"]/g, (c) => HTML_ESCAPES[c] ?? c);

main().catch(fail);
