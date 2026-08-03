/**
 * Minimap.
 *
 * The terrain is drawn once into an offscreen bitmap and blitted every frame;
 * only the unit blips and the camera rectangle are redrawn. A 481 x 481
 * heightmap repainted pixel by pixel at 60 Hz would cost more than the 3D view
 * it sits next to, which would be an absurd way to lose a frame budget.
 *
 * Colour follows the same rule as the main view: terrain by tileset, units by
 * owner. Anything a player has to translate in their head is a design failure at
 * this size, where a blip is three pixels across.
 */

import type { Terrain } from "../data.ts";
import { PLAYER_COLOURS, NEUTRAL_COLOUR, MAX_SLOTS } from "../game/players.ts";
import { UNIT_FLAG_BUILDING, UNIT_STRIDE, type Snapshot } from "../game/protocol.ts";

/** Bitmap resolution. Higher than the widget's pixel size so it stays crisp. */
const SIZE = 256;

export interface MinimapView {
  /** Camera target in world coordinates, drawn as the view marker. */
  centre: [number, number];
  /** Half-extent of what the camera sees, in world units. */
  radius: number;
}

export class Minimap {
  private base: HTMLCanvasElement;
  private context: CanvasRenderingContext2D;
  /** World-space bounds of the playable area. */
  private minX = 0;
  private minY = 0;
  private spanX = 1;
  private spanY = 1;

  constructor(
    private canvas: HTMLCanvasElement,
    terrain: Terrain | null,
  ) {
    canvas.width = SIZE;
    canvas.height = SIZE;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Миникарта: контекст 2d недоступен.");
    this.context = context;

    this.base = document.createElement("canvas");
    this.base.width = SIZE;
    this.base.height = SIZE;

    if (terrain) this.paintTerrain(terrain);
    else this.paintEmpty();
  }

  /** World coordinates of the map's corners, so callers can convert clicks. */
  get bounds(): { minX: number; minY: number; spanX: number; spanY: number } {
    return { minX: this.minX, minY: this.minY, spanX: this.spanX, spanY: this.spanY };
  }

  private paintEmpty(): void {
    const context = this.base.getContext("2d");
    if (!context) return;
    context.fillStyle = "#0b0e13";
    context.fillRect(0, 0, SIZE, SIZE);
    context.strokeStyle = "#1d2430";
    for (let i = 1; i < 6; i++) {
      const at = (SIZE / 6) * i;
      context.beginPath();
      context.moveTo(at, 0);
      context.lineTo(at, SIZE);
      context.moveTo(0, at);
      context.lineTo(SIZE, at);
      context.stroke();
    }
    // Keep the coordinate space usable even with no terrain: the map is
    // 480 x 480 tiles of 128 units, centred on the origin.
    this.minX = -30720;
    this.minY = -30720;
    this.spanX = 61440;
    this.spanY = 61440;
  }

  /**
   * Shade the heightmap.
   *
   * Height drives brightness and the water table tints blue, which is enough for
   * a player to recognise the map's shape - ridges, lakes, the passes between
   * them. Tileset hue is deliberately muted here: at this scale, contrast between
   * high and low ground reads, and sixteen distinct greens do not.
   */
  private paintTerrain(terrain: Terrain): void {
    const context = this.base.getContext("2d");
    if (!context) return;

    const { width, height, offset, tileSize } = terrain.meta;
    this.minX = offset[0];
    this.minY = offset[1];
    this.spanX = Math.max(1, (width - 1) * tileSize);
    this.spanY = Math.max(1, (height - 1) * tileSize);

    let lowest = Number.POSITIVE_INFINITY;
    let highest = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < width * height; index++) {
      const z = terrain.heightAt(index);
      if (z < lowest) lowest = z;
      if (z > highest) highest = z;
    }
    const range = Math.max(1, highest - lowest);

    const image = context.createImageData(SIZE, SIZE);
    for (let py = 0; py < SIZE; py++) {
      // Flip vertically: world Y grows north, canvas Y grows down.
      const ty = Math.min(height - 1, Math.floor(((SIZE - 1 - py) / SIZE) * height));
      for (let px = 0; px < SIZE; px++) {
        const tx = Math.min(width - 1, Math.floor((px / SIZE) * width));
        const index = ty * width + tx;
        const z = terrain.heightAt(index);
        const lift = (z - lowest) / range;

        let r = 46 + lift * 92;
        let g = 58 + lift * 96;
        let b = 40 + lift * 62;

        const water = terrain.water[index];
        if (water > -8000 && water / 4 - 2048 > z) {
          r = 24;
          g = 52;
          b = 88;
        }

        const at = (py * SIZE + px) * 4;
        image.data[at + 0] = r;
        image.data[at + 1] = g;
        image.data[at + 2] = b;
        image.data[at + 3] = 255;
      }
    }
    context.putImageData(image, 0, 0);
  }

  /** Convert a click inside the widget to world coordinates. */
  toWorld(fractionX: number, fractionY: number): [number, number] {
    return [
      this.minX + fractionX * this.spanX,
      this.minY + (1 - fractionY) * this.spanY,
    ];
  }

  private toPixel(x: number, y: number): [number, number] {
    return [
      ((x - this.minX) / this.spanX) * SIZE,
      (1 - (y - this.minY) / this.spanY) * SIZE,
    ];
  }

  /** Redraw: terrain, then every unit, then the camera rectangle. */
  draw(snapshot: Snapshot | null, view: MinimapView, localPlayer: number): void {
    const context = this.context;
    context.clearRect(0, 0, SIZE, SIZE);
    context.drawImage(this.base, 0, 0);

    if (snapshot) {
      const units = snapshot.units;
      for (let index = 0; index < snapshot.unitCount; index++) {
        const at = index * UNIT_STRIDE;
        const owner = units[at + 1];
        const [px, py] = this.toPixel(units[at + 2], units[at + 3]);
        const building = (units[at + 7] & UNIT_FLAG_BUILDING) !== 0;
        context.fillStyle =
          owner < MAX_SLOTS ? PLAYER_COLOURS[owner].css : NEUTRAL_COLOUR.css;
        // Structures are the map's cities and worth finding at a glance, so they
        // get a larger square than the armies moving between them.
        const size = building ? 5 : owner === localPlayer ? 3 : 2.5;
        context.fillRect(px - size / 2, py - size / 2, size, size);
      }
    }

    const [cx, cy] = this.toPixel(view.centre[0], view.centre[1]);
    const half = (view.radius / this.spanX) * SIZE;
    context.strokeStyle = "rgba(240,205,94,.85)";
    context.lineWidth = 1;
    context.strokeRect(cx - half, cy - half, half * 2, half * 2);
  }
}
