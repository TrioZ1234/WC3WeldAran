#!/usr/bin/env python3
"""Render exported terrain data to a PNG for verification.

Draws the heightmap with hillshading, tints it by ground tileset, floods
water, and can overlay placed doodads and units. Comparing the result with
the map's own minimap is a quick way to prove the terrain export is right.

Usage:
    python3 tools/preview_terrain.py <data-dir> <out.png> [--size N] [--overlay]
"""

from __future__ import annotations

import json
import os
import sys

import numpy as np

# Approximate colour per WC3 tileset id, enough to read the terrain at a glance.
TILESET_COLOURS = {
    "Fdrt": (104, 88, 62), "Frok": (110, 106, 98), "Fgrs": (78, 102, 54),
    "Ldrg": (120, 96, 60), "Wsng": (74, 108, 60), "Alvd": (96, 92, 74),
    "Zgrs": (86, 112, 58), "Adrg": (128, 104, 66), "Yblm": (92, 84, 66),
    "Ywmb": (100, 90, 70), "Dlvc": (86, 74, 62), "Idki": (150, 160, 170),
    "Iice": (186, 202, 214), "Qcbp": (108, 100, 88), "Qstp": (118, 110, 92),
    "Zsan": (166, 148, 108),
}
DEFAULT_COLOUR = (100, 96, 84)
WATER_COLOUR = np.array([40, 70, 110], dtype=np.float32)


def opt(name, default=None):
    return sys.argv[sys.argv.index(name) + 1] if name in sys.argv else default


def main() -> int:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    for flag in ("--size",):
        value = opt(flag)
        if value in args:
            args.remove(value)
    if len(args) < 2:
        print(__doc__)
        return 2
    data_dir, out_path = args[0], args[1]
    target = int(opt("--size", 1024))

    from PIL import Image

    with open(os.path.join(data_dir, "terrain.json"), encoding="utf-8") as handle:
        terrain = json.load(handle)

    w, h = terrain["width"], terrain["height"]
    count = w * h
    with open(os.path.join(data_dir, terrain["binary"]["file"]), "rb") as handle:
        blob = handle.read()

    # Layout matches terrain.json["binary"]["layout"].
    off = 0
    ground_raw = np.frombuffer(blob, "<i2", count, off).astype(np.float32).reshape(h, w)
    off += count * 2
    water_raw = np.frombuffer(blob, "<i2", count, off).astype(np.float32).reshape(h, w)
    off += count * 2
    texture = np.frombuffer(blob, "u1", count, off).astype(np.int16).reshape(h, w)
    off += count * 2          # skip cliffTexture too
    layer = np.frombuffer(blob, "u1", count, off).astype(np.float32).reshape(h, w)

    # WC3 stores heights biased and quantised; layer adds a cliff step of 128.
    height = (ground_raw - 8192.0) / 4.0 + (layer - 2.0) * 128.0
    water = water_raw / 4.0

    # Colour by tileset.
    tilesets = terrain["groundTilesets"]
    palette = np.array(
        [TILESET_COLOURS.get(t, DEFAULT_COLOUR) for t in tilesets] +
        [DEFAULT_COLOUR] * (16 - len(tilesets)), dtype=np.float32)
    rgb = palette[np.clip(texture, 0, 15)]

    # Hillshade from the height gradient.
    gy, gx = np.gradient(height)
    normal_z = 1.0 / np.sqrt(gx * gx + gy * gy + 1.0)
    shade = np.clip(0.55 + 0.75 * (normal_z * 0.6 + (-gx - gy) * 0.02), 0.25, 1.5)
    rgb *= shade[..., None]

    # Flood where the water table sits above ground.
    depth = water - height
    wet = depth > 0.5
    if wet.any():
        blend = np.clip(depth / 300.0, 0.25, 0.85)[..., None]
        rgb = np.where(wet[..., None], rgb * (1 - blend) + WATER_COLOUR * blend, rgb)

    image = Image.fromarray(np.clip(rgb, 0, 255).astype(np.uint8))
    # w3e row 0 is the south edge; flip so north is up like the in-game minimap.
    image = image.transpose(Image.FLIP_TOP_BOTTOM)

    if "--overlay" in sys.argv:
        image = image.convert("RGB")
        from PIL import ImageDraw
        draw = ImageDraw.Draw(image, "RGBA")
        offset_x, offset_y = terrain["offset"]

        def to_pixel(x, y):
            px = (x - offset_x) / 128.0
            py = (y - offset_y) / 128.0
            return px, (h - 1) - py

        doodad_path = os.path.join(data_dir, "doodads.json")
        if os.path.exists(doodad_path):
            with open(doodad_path, encoding="utf-8") as handle:
                for d in json.load(handle):
                    px, py = to_pixel(d["pos"][0], d["pos"][1])
                    draw.point((px, py), fill=(40, 200, 80, 150))

        unit_path = os.path.join(data_dir, "units.json")
        if os.path.exists(unit_path):
            with open(unit_path, encoding="utf-8") as handle:
                for u in json.load(handle):
                    px, py = to_pixel(u["pos"][0], u["pos"][1])
                    colour = (255, 90, 90, 230) if u["player"] < 12 else (230, 200, 60, 200)
                    draw.ellipse((px - 1.5, py - 1.5, px + 1.5, py + 1.5), fill=colour)

    if target and max(image.size) != target:
        image = image.resize((target, target), Image.LANCZOS)
    image.save(out_path)
    print(f"rendered {w}x{h} terrain -> {out_path}")
    print(f"  height range : {height.min():.0f} .. {height.max():.0f} world units")
    print(f"  water cells  : {int(wet.sum()):,} ({100 * wet.mean():.1f}%)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
