/**
 * Builds a renderable mesh from the terrain grid.
 *
 * At 481x481 the grid is 231,361 vertices and 460,800 triangles - large enough
 * that it is built once into typed arrays and uploaded whole, rather than
 * rebuilt per frame. Indices need 32 bits.
 */

import type { Terrain } from "./data";

export interface TerrainMesh {
  /** x, y, z, nx, ny, nz, tileset, water — 8 floats per vertex. */
  vertices: Float32Array;
  indices: Uint32Array;
  vertexCount: number;
  indexCount: number;
  bounds: { min: [number, number, number]; max: [number, number, number] };
}

export const FLOATS_PER_VERTEX = 8;

/** Sentinel in the water slot meaning "this vertex is dry". */
export const WATER_NONE = -1e9;

export function buildTerrainMesh(terrain: Terrain): TerrainMesh {
  const { width, height, offset, tileSize } = terrain.meta;
  const [originX, originY] = offset;
  const count = width * height;

  const vertices = new Float32Array(count * FLOATS_PER_VERTEX);
  const elevation = new Float32Array(count);
  for (let i = 0; i < count; i++) elevation[i] = terrain.heightAt(i);

  let minZ = Infinity;
  let maxZ = -Infinity;

  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const i = row * width + col;
      const z = elevation[i];
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;

      // Central differences give a smooth normal without a second pass.
      const left = elevation[row * width + Math.max(0, col - 1)];
      const right = elevation[row * width + Math.min(width - 1, col + 1)];
      const down = elevation[Math.max(0, row - 1) * width + col];
      const up = elevation[Math.min(height - 1, row + 1) * width + col];

      let nx = (left - right) / (2 * tileSize);
      let ny = (down - up) / (2 * tileSize);
      const nz = 1;
      const length = Math.hypot(nx, ny, nz) || 1;
      nx /= length;
      ny /= length;

      const waterLevel = terrain.water[i] / 4;
      const o = i * FLOATS_PER_VERTEX;
      vertices[o + 0] = originX + col * tileSize;
      vertices[o + 1] = originY + row * tileSize;
      vertices[o + 2] = z;
      vertices[o + 3] = nx;
      vertices[o + 4] = ny;
      vertices[o + 5] = nz / length;
      vertices[o + 6] = terrain.groundTexture[i];
      vertices[o + 7] = waterLevel > z + 0.5 ? waterLevel : WATER_NONE;
    }
  }

  const quads = (width - 1) * (height - 1);
  const indices = new Uint32Array(quads * 6);
  let k = 0;
  for (let row = 0; row < height - 1; row++) {
    for (let col = 0; col < width - 1; col++) {
      const a = row * width + col;
      const b = a + 1;
      const c = a + width;
      const d = c + 1;
      indices[k++] = a;
      indices[k++] = c;
      indices[k++] = b;
      indices[k++] = b;
      indices[k++] = c;
      indices[k++] = d;
    }
  }

  return {
    vertices,
    indices,
    vertexCount: count,
    indexCount: indices.length,
    bounds: {
      min: [originX, originY, minZ],
      max: [originX + (width - 1) * tileSize, originY + (height - 1) * tileSize, maxZ],
    },
  };
}
