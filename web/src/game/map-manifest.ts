/**
 * What the interface needs to know about the map before a match exists.
 *
 * The pipeline's `map.json` is the only source; nothing here parses `.w3x` or
 * guesses at content. But the repository ships without `build/data` on purpose
 * (the map is 25.6 MB and lives outside git), so a fresh clone would otherwise
 * show a blank menu and no explanation. When the data is missing we say so and
 * fall back to the map's published shape - twelve players in six forces, from
 * `docs/data/map-report.json` - so the lobby stays inspectable while the player
 * finds out which command produces the real thing.
 */

import type { MapInfo } from "../data.ts";

export interface ManifestPlayer {
  slot: number;
  controller: string;
  race: string;
  name: string;
  start: [number, number];
}

export interface ManifestForce {
  name: string;
  slots: number[];
}

export interface MapManifest {
  name: string;
  author: string;
  description: string;
  /** Where the data came from, shown in the menu. */
  path: string;
  players: ManifestPlayer[];
  forces: ManifestForce[];
  tiles: [number, number];
  /** False when `build/data` is absent and the shape below is the documented one. */
  dataPresent: boolean;
  /** Filled when loading failed, for an honest message instead of a silent fallback. */
  problem?: string;
}

const stripColourCodes = (text: string): string =>
  text.replace(/\|c[0-9a-fA-F]{8}|\|r|\|n/g, "").trim();

/**
 * The map's own player and force layout, as measured by `tools/analyze_map.py`
 * and recorded in `docs/data/map-report.json`: 12 players, 6 forces of two.
 * Used only to keep the interface honest when the build output is missing.
 */
function documentedShape(): { players: ManifestPlayer[]; forces: ManifestForce[] } {
  const players: ManifestPlayer[] = [];
  for (let slot = 0; slot < 12; slot++) {
    players.push({
      slot,
      controller: "human",
      race: "human",
      name: `Игрок ${slot + 1}`,
      start: [0, 0],
    });
  }
  const forces: ManifestForce[] = [];
  for (let force = 0; force < 6; force++) {
    forces.push({ name: `Команда ${force + 1}`, slots: [force * 2, force * 2 + 1] });
  }
  return { players, forces };
}

export async function loadMapManifest(base = "/data"): Promise<MapManifest> {
  try {
    const response = await fetch(`${base}/map.json`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const info = (await response.json()) as MapInfo;

    const players = (info.players ?? []) as ManifestPlayer[];
    const forces = (info.forces ?? []) as ManifestForce[];
    const shape = players.length === 0 ? documentedShape() : { players, forces };

    return {
      name: stripColourCodes(info.name || "War for WeldAran"),
      author: stripColourCodes(info.author || "неизвестен"),
      description: stripColourCodes(info.description || ""),
      path: `${base}/map.json`,
      players: shape.players,
      forces: forces.length > 0 ? forces : shape.forces,
      tiles: info.terrain?.tiles ?? [480, 480],
      dataPresent: true,
    };
  } catch (error) {
    const shape = documentedShape();
    return {
      name: "War for WeldAran",
      author: "[TZ.Ent]AeNeMeR / TrioZ",
      description:
        "Данные карты не собраны. Оболочка работает, но мир пуст: " +
        "запустите python3 build.py путь/к/WFWA.w3x, чтобы получить ландшафт, " +
        "объекты и скрипт.",
      path: `${base}/map.json`,
      players: shape.players,
      forces: shape.forces,
      tiles: [480, 480],
      dataPresent: false,
      problem: error instanceof Error ? error.message : String(error),
    };
  }
}
