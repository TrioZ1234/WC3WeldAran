#!/usr/bin/env python3
"""Convert an extracted Warcraft III map's data files into engine-ready JSON.

This is the bridge between the WC3 binary formats and the new runtime: every
gameplay-relevant table becomes a plain JSON document with localised strings
already resolved.

Usage:
    python3 tools/export_data.py <extracted-dir> <output-dir>

Outputs
    map.json          identity, players, forces, terrain header
    terrain.json      per-tilepoint heights/textures (large)
    doodads.json      placed doodads and destructables
    units.json        preplaced units and items
    objects/<kind>.json   custom + modified object definitions
    strings.json      localised string table
"""

from __future__ import annotations

import array
import json
import os
import re
import struct
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from tools.wc3.w3x import (  # noqa: E402
    PLAYER_TYPES, RACES, parse_doo, parse_imp, parse_object_data,
    parse_units_doo, parse_w3e_header, parse_w3i, parse_wts,
)

TRIGSTR = re.compile(r"^TRIGSTR_(\d+)")

OBJECT_FILES = {
    "units": "war3map.w3u",
    "items": "war3map.w3t",
    "destructables": "war3map.w3b",
    "doodads": "war3map.w3d",
    "abilities": "war3map.w3a",
    "buffs": "war3map.w3h",
    "upgrades": "war3map.w3q",
}


def write_json(path: str, payload) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, separators=(",", ":"))
    print(f"  {os.path.relpath(path):<44} {os.path.getsize(path):>12,} bytes")


def main() -> int:
    if len(sys.argv) != 3:
        print(__doc__)
        return 2
    root, out = sys.argv[1], sys.argv[2]

    def read(name: str):
        p = os.path.join(root, name)
        return open(p, "rb").read() if os.path.exists(p) else None

    wts = parse_wts(read("war3map.wts") or b"")

    def resolve(text: str) -> str:
        m = TRIGSTR.match((text or "").strip())
        return wts.get(int(m.group(1)), text) if m else text

    print("exporting:")

    # -- strings ------------------------------------------------------------
    write_json(os.path.join(out, "strings.json"),
               {str(k): v for k, v in sorted(wts.items())})

    # -- map identity + terrain header --------------------------------------
    doc: dict = {}
    raw_w3i = read("war3map.w3i")
    if raw_w3i:
        info = parse_w3i(raw_w3i)
        doc["name"] = resolve(info.name)
        doc["author"] = resolve(info.author)
        doc["description"] = resolve(info.description)
        doc["recommendedPlayers"] = resolve(info.players_recommended)
        doc["mapVersion"] = info.map_version
        doc["playable"] = {"width": info.playable_width, "height": info.playable_height}
        doc["tileset"] = info.tileset
        doc["players"] = [{
            "slot": p.index,
            "controller": PLAYER_TYPES.get(p.type, str(p.type)),
            "race": RACES.get(p.race, str(p.race)),
            "name": resolve(p.name),
            "start": [p.start_x, p.start_y],
        } for p in info.players]
        doc["forces"] = [{
            "name": resolve(f.name),
            "slots": [b for b in range(12) if (f.player_mask >> b) & 1],
            "flags": f.flags,
        } for f in info.forces]

    raw_w3e = read("war3map.w3e")
    terrain_info = None
    if raw_w3e:
        terrain_info = parse_w3e_header(raw_w3e)
        doc["terrain"] = {
            "vertices": [terrain_info.width, terrain_info.height],
            "tiles": [terrain_info.width - 1, terrain_info.height - 1],
            "offset": [terrain_info.offset_x, terrain_info.offset_y],
            "tileSize": 128,
            "groundTilesets": terrain_info.ground_tilesets,
            "cliffTilesets": terrain_info.cliff_tilesets,
        }

    raw_imp = read("war3map.imp")
    if raw_imp:
        doc["imports"] = [p for _, p in parse_imp(raw_imp)]

    write_json(os.path.join(out, "map.json"), doc)

    # -- terrain tilepoints --------------------------------------------------
    # Each tilepoint is 7 bytes: height, water level+boundary, flags+ground
    # texture, texture details, cliff texture+layer height.
    if raw_w3e and terrain_info:
        w, h = terrain_info.width, terrain_info.height
        base = terrain_info.tilepoint_offset
        count = w * h
        heights = array.array("h", [0]) * count
        water = array.array("h", [0]) * count
        ground = bytearray(count)
        cliff = bytearray(count)
        layer = bytearray(count)
        flags = bytearray(count)
        for i in range(count):
            gh, wl, flags_tex, details, cliff_layer = struct.unpack_from(
                "<hhBBB", raw_w3e, base + i * 7)
            heights[i] = gh
            # Top two bits are the boundary flag, not part of the water level.
            water[i] = (wl & 0x3FFF) - 0x2000
            ground[i] = flags_tex & 0x0F
            flags[i] = (flags_tex >> 4) & 0x0F
            cliff[i] = (cliff_layer >> 4) & 0x0F
            layer[i] = cliff_layer & 0x0F

        # Runtime loads a flat binary; JSON keeps only the metadata. Parsing
        # five 231k-element JSON arrays in a browser is pure waste.
        blob = bytearray()
        blob += heights.tobytes()
        blob += water.tobytes()
        blob += bytes(ground) + bytes(cliff) + bytes(layer) + bytes(flags)
        bin_path = os.path.join(out, "terrain.bin")
        os.makedirs(os.path.dirname(bin_path), exist_ok=True)
        with open(bin_path, "wb") as handle:
            handle.write(blob)
        print(f"  {os.path.relpath(bin_path):<44} {len(blob):>12,} bytes")

        write_json(os.path.join(out, "terrain.json"), {
            "width": w, "height": h,
            "groundTilesets": terrain_info.ground_tilesets,
            "cliffTilesets": terrain_info.cliff_tilesets,
            "offset": [terrain_info.offset_x, terrain_info.offset_y],
            "tileSize": 128,
            "heightFormula": "(groundHeight - 8192) / 4 + (layerHeight - 2) * 128",
            "binary": {
                "file": "terrain.bin",
                "count": count,
                "layout": [
                    {"name": "groundHeight", "type": "int16"},
                    {"name": "water", "type": "int16"},
                    {"name": "groundTexture", "type": "uint8"},
                    {"name": "cliffTexture", "type": "uint8"},
                    {"name": "layerHeight", "type": "uint8"},
                    {"name": "flags", "type": "uint8"},
                ],
            },
        })

    # -- placement ----------------------------------------------------------
    raw_doo = read("war3map.doo")
    if raw_doo:
        doo = parse_doo(raw_doo)
        write_json(os.path.join(out, "doodads.json"), [{
            "type": d.type_id, "var": d.variation,
            "pos": [round(d.x, 2), round(d.y, 2), round(d.z, 2)],
            "rot": round(d.rotation, 4),
            "scale": [round(s, 3) for s in d.scale],
            "flags": d.flags, "life": d.life,
        } for d in doo.doodads])

    raw_units = read("war3mapUnits.doo")
    if raw_units:
        uf = parse_units_doo(raw_units)
        write_json(os.path.join(out, "units.json"), [{
            "type": u.type_id, "var": u.variation,
            "pos": [round(u.x, 2), round(u.y, 2), round(u.z, 2)],
            "rot": round(u.rotation, 4),
            "scale": [round(s, 3) for s in u.scale],
            "player": u.player,
            "hp": u.hitpoints, "mana": u.mana, "gold": u.gold,
            "heroLevel": u.hero_level,
            "inventory": [{"slot": s, "item": i} for s, i in u.inventory],
            "abilities": [{"id": a, "autocast": ac, "level": lv}
                          for a, ac, lv in u.abilities],
        } for u in uf.units])

    # -- object data --------------------------------------------------------
    for kind, filename in OBJECT_FILES.items():
        raw = read(filename)
        if not raw:
            continue
        ext = filename.rsplit(".", 1)[1]
        od = parse_object_data(raw, ext)

        def dump(objects):
            result = []
            for o in objects:
                mods = []
                for m in o.mods:
                    value = resolve(m.value) if isinstance(m.value, str) else m.value
                    entry = {"field": m.mod_id, "value": value}
                    if m.level:
                        entry["level"] = m.level
                    mods.append(entry)
                result.append({"base": o.base_id, "id": o.new_id or o.base_id,
                               "mods": mods})
            return result

        write_json(os.path.join(out, "objects", f"{kind}.json"), {
            "version": od.version,
            "custom": dump(od.custom),
            "modifiedStock": dump(od.original),
        })

    print("\ndone.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
