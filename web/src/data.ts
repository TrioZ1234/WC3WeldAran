/**
 * Loaders for the pipeline output in `public/data/`.
 *
 * Terrain arrives as a flat binary described by `terrain.json`, so the browser
 * never has to parse a few hundred thousand JSON numbers.
 */

export interface TerrainBinaryField {
  name: string;
  type: "int16" | "uint8";
}

export interface TerrainMeta {
  width: number;
  height: number;
  offset: [number, number];
  tileSize: number;
  groundTilesets: string[];
  cliffTilesets: string[];
  heightFormula: string;
  binary: { file: string; count: number; layout: TerrainBinaryField[] };
}

export interface Terrain {
  meta: TerrainMeta;
  groundHeight: Int16Array;
  water: Int16Array;
  groundTexture: Uint8Array;
  cliffTexture: Uint8Array;
  layerHeight: Uint8Array;
  flags: Uint8Array;
  /** World-space Z of a tilepoint, per terrain.json's heightFormula. */
  heightAt(index: number): number;
}

export interface MapPlayer {
  slot: number;
  controller: string;
  race: string;
  name: string;
  start: [number, number];
}

export interface MapForce {
  name: string;
  slots: number[];
}

export interface MapInfo {
  name: string;
  author: string;
  description: string;
  players: MapPlayer[];
  forces: MapForce[];
  terrain: { tiles: [number, number] };
}

export interface Placement {
  type: string;
  var: number;
  pos: [number, number, number];
  rot: number;
  scale: [number, number, number];
}

export interface UnitPlacement extends Placement {
  player: number;
  heroLevel: number;
}

const BYTES: Record<TerrainBinaryField["type"], number> = { int16: 2, uint8: 1 };

async function getJSON<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return (await response.json()) as T;
}

export async function loadTerrain(base: string): Promise<Terrain> {
  const meta = await getJSON<TerrainMeta>(`${base}/terrain.json`);
  const response = await fetch(`${base}/${meta.binary.file}`);
  if (!response.ok) throw new Error(`${meta.binary.file}: HTTP ${response.status}`);
  const buffer = await response.arrayBuffer();

  const count = meta.binary.count;
  const views: Record<string, Int16Array | Uint8Array> = {};
  let offset = 0;
  for (const field of meta.binary.layout) {
    views[field.name] =
      field.type === "int16"
        ? new Int16Array(buffer, offset, count)
        : new Uint8Array(buffer, offset, count);
    offset += count * BYTES[field.type];
  }

  const groundHeight = views.groundHeight as Int16Array;
  const layerHeight = views.layerHeight as Uint8Array;

  return {
    meta,
    groundHeight,
    water: views.water as Int16Array,
    groundTexture: views.groundTexture as Uint8Array,
    cliffTexture: views.cliffTexture as Uint8Array,
    layerHeight,
    flags: views.flags as Uint8Array,
    heightAt(index: number) {
      return (groundHeight[index] - 8192) / 4 + (layerHeight[index] - 2) * 128;
    },
  };
}

export const loadMapInfo = (base: string) => getJSON<MapInfo>(`${base}/map.json`);
export const loadDoodads = (base: string) => getJSON<Placement[]>(`${base}/doodads.json`);
export const loadUnits = (base: string) => getJSON<UnitPlacement[]>(`${base}/units.json`);
