#!/usr/bin/env python3
"""Produce a content-budget report for an extracted Warcraft III map.

Usage:
    python3 tools/analyze_map.py <extracted-dir> [--json report.json]

Reports the numbers that decide whether a map is portable: terrain extent,
placed object counts, custom object-data volume, script size, and asset
weight. Missing files are skipped rather than fatal.
"""

from __future__ import annotations

import collections
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from tools.wc3.w3x import (  # noqa: E402
    PLAYER_TYPES, RACES, parse_doo, parse_imp, parse_object_data, parse_units_doo,
    parse_w3e_header, parse_w3i, parse_wts,
)

TRIGSTR = re.compile(r"^TRIGSTR_(\d+)")

OBJECT_FILES = [
    ("war3map.w3u", "units"),
    ("war3map.w3t", "items"),
    ("war3map.w3b", "destructables"),
    ("war3map.w3d", "doodads"),
    ("war3map.w3a", "abilities"),
    ("war3map.w3h", "buffs"),
    ("war3map.w3q", "upgrades"),
]

MODEL_EXTS = {".mdx", ".mdl"}
TEXTURE_EXTS = {".blp", ".tga", ".jpg", ".jpeg", ".png"}
AUDIO_EXTS = {".mp3", ".wav"}


class Report:
    def __init__(self) -> None:
        self.data: dict = {}

    def section(self, title: str) -> None:
        print()
        print("=" * 74)
        print(title)
        print("=" * 74)


def main() -> int:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if not args:
        print(__doc__)
        return 2
    root = args[0]
    json_out = None
    if "--json" in sys.argv:
        json_out = sys.argv[sys.argv.index("--json") + 1]

    def path(name: str) -> str:
        return os.path.join(root, name)

    def read(name: str):
        p = path(name)
        return open(p, "rb").read() if os.path.exists(p) else None

    rep = Report()
    out: dict = {}

    # -- strings ------------------------------------------------------------
    wts = parse_wts(read("war3map.wts") or b"")

    def resolve(text: str) -> str:
        match = TRIGSTR.match((text or "").strip())
        return wts.get(int(match.group(1)), text) if match else text

    # -- identity -----------------------------------------------------------
    raw_w3i = read("war3map.w3i")
    if raw_w3i:
        info = parse_w3i(raw_w3i)
        rep.section("MAP IDENTITY")
        print(f"name             : {resolve(info.name)}")
        print(f"author           : {resolve(info.author)}")
        print(f"recommended      : {resolve(info.players_recommended)}")
        print(f"w3i version      : {info.version}   map version: {info.map_version}")
        print(f"playable area    : {info.playable_width} x {info.playable_height} tiles")
        print(f"tileset          : {info.tileset}")
        desc = resolve(info.description).replace("\r", " ").replace("\n", " ")
        print(f"description      : {desc[:300]}")

        print(f"\nplayers ({len(info.players)}):")
        for p in info.players:
            print("  slot %2d  %-9s %-9s %s" % (
                p.index, PLAYER_TYPES.get(p.type, p.type),
                RACES.get(p.race, p.race), resolve(p.name)))
        print(f"\nforces ({len(info.forces)}):")
        for f in info.forces:
            slots = [b for b in range(12) if (f.player_mask >> b) & 1]
            print("  %-34s slots=%s" % (resolve(f.name)[:34], slots))

        out["info"] = {
            "name": resolve(info.name), "author": resolve(info.author),
            "version": info.version, "playable": [info.playable_width, info.playable_height],
            "players": len(info.players), "forces": len(info.forces),
            "tileset": info.tileset,
        }

    # -- terrain ------------------------------------------------------------
    raw_w3e = read("war3map.w3e")
    if raw_w3e:
        t = parse_w3e_header(raw_w3e)
        rep.section("TERRAIN")
        tiles_x, tiles_y = t.width - 1, t.height - 1
        print(f"grid             : {t.width} x {t.height} vertices  ->  {tiles_x} x {tiles_y} tiles")
        print(f"world extent     : {tiles_x * 128} x {tiles_y * 128} units")
        print(f"ground tilesets  : {len(t.ground_tilesets)}/16 used  {t.ground_tilesets}")
        print(f"cliff tilesets   : {len(t.cliff_tilesets)}  {t.cliff_tilesets}")
        print(f"tilepoints       : {t.width * t.height:,}")
        out["terrain"] = {
            "tiles": [tiles_x, tiles_y],
            "tilepoints": t.width * t.height,
            "ground_tilesets": t.ground_tilesets,
            "cliff_tilesets": t.cliff_tilesets,
        }

    # -- placement ----------------------------------------------------------
    rep.section("PLACED OBJECTS")
    raw_doo = read("war3map.doo")
    if raw_doo:
        doo = parse_doo(raw_doo)
        kinds = collections.Counter(d.type_id for d in doo.doodads)
        print(f"doodads/destructables : {len(doo.doodads):,}  "
              f"({len(kinds)} distinct types, +{doo.special_doodads:,} special)")
        print("  top types:", ", ".join(f"{k}={v}" for k, v in kinds.most_common(10)))
        out["doodads"] = {"count": len(doo.doodads), "distinct": len(kinds),
                          "special": doo.special_doodads}

    raw_units = read("war3mapUnits.doo")
    if raw_units:
        uf = parse_units_doo(raw_units)
        by_player = collections.Counter(u.player for u in uf.units)
        kinds = collections.Counter(u.type_id for u in uf.units)
        # hero_level defaults to 1 on ordinary units, so only >1 is meaningful.
        heroes = [u for u in uf.units if u.hero_level > 1]
        print(f"preplaced units/items : {len(uf.units):,}  ({len(kinds)} distinct types)")
        print(f"  levelled heroes     : {len(heroes)}")
        print(f"  by owner            : " +
              ", ".join(f"p{p}={c}" for p, c in sorted(by_player.items())[:16]))
        print("  top types:", ", ".join(f"{k}={v}" for k, v in kinds.most_common(10)))
        out["units"] = {"count": len(uf.units), "distinct": len(kinds),
                        "heroes": len(heroes)}

    # -- object data --------------------------------------------------------
    rep.section("CUSTOM OBJECT DATA")
    total_custom = total_mods = 0
    obj_summary = {}
    for filename, label in OBJECT_FILES:
        raw = read(filename)
        if not raw:
            continue
        ext = filename.rsplit(".", 1)[1]
        try:
            od = parse_object_data(raw, ext)
        except Exception as exc:  # noqa: BLE001
            print(f"{label:<16} PARSE FAILED: {exc}")
            continue
        custom = len(od.custom)
        modified = len(od.original)
        mods = od.total_mods
        total_custom += custom
        total_mods += mods
        print(f"{label:<16} custom={custom:<6} modified-stock={modified:<6} "
              f"field-overrides={mods:,}")
        obj_summary[label] = {"custom": custom, "modified": modified, "mods": mods}
    print(f"{'TOTAL':<16} custom={total_custom:<6} "
          f"{'':<21} field-overrides={total_mods:,}")
    out["object_data"] = obj_summary
    out["object_totals"] = {"custom": total_custom, "mods": total_mods}

    # -- script -------------------------------------------------------------
    rep.section("SCRIPT & TRIGGERS")
    jass = read("war3map.j") or read(os.path.join("scripts", "war3map.j"))
    if jass:
        text = jass.decode("utf-8", errors="replace")
        lines = text.count("\n") + 1
        funcs = len(re.findall(r"^function\s+\w+", text, re.M))
        globals_block = re.search(r"^globals\b(.*?)^endglobals", text, re.M | re.S)
        gcount = 0
        if globals_block:
            gcount = len([l for l in globals_block.group(1).split("\n") if l.strip()])
        arrays = len(re.findall(r"\barray\b", text))
        triggers = len(re.findall(r"CreateTrigger\s*\(", text))
        timers = len(re.findall(r"CreateTimer\s*\(", text))
        units_created = len(re.findall(r"CreateUnit\s*\(", text))
        print(f"war3map.j        : {len(jass):,} bytes, {lines:,} lines")
        print(f"functions        : {funcs:,}")
        print(f"globals declared : {gcount:,} ({arrays} arrays)")
        print(f"CreateTrigger    : {triggers:,}")
        print(f"CreateTimer      : {timers:,}")
        print(f"CreateUnit calls : {units_created:,}")
        out["script"] = {"bytes": len(jass), "lines": lines, "functions": funcs,
                         "globals": gcount, "triggers": triggers,
                         "timers": timers, "create_unit": units_created}

    for name, label in [("war3map.wtg", "GUI trigger tree"),
                        ("war3map.wct", "custom text triggers")]:
        raw = read(name)
        if raw:
            print(f"{label:<16} : {len(raw):,} bytes")
    print(f"{'string table':<16} : {len(wts):,} localised strings")
    out["strings"] = len(wts)

    # -- assets -------------------------------------------------------------
    rep.section("IMPORTED ASSETS")
    raw_imp = read("war3map.imp")
    if raw_imp:
        imports = parse_imp(raw_imp)
        print(f"declared imports : {len(imports):,}")

    buckets = collections.Counter()
    sizes = collections.Counter()
    biggest = []
    for dirpath, _, filenames in os.walk(root):
        for fn in filenames:
            if fn == "_manifest.json":
                continue
            full = os.path.join(dirpath, fn)
            size = os.path.getsize(full)
            ext = os.path.splitext(fn)[1].lower()
            if ext in MODEL_EXTS:
                key = "models"
            elif ext in TEXTURE_EXTS:
                key = "textures"
            elif ext in AUDIO_EXTS:
                key = "audio"
            elif fn.startswith("war3map"):
                key = "map data"
            else:
                key = "other"
            buckets[key] += 1
            sizes[key] += size
            biggest.append((size, os.path.relpath(full, root)))

    total_size = sum(sizes.values())
    print(f"\n{'CATEGORY':<12}{'FILES':>8}{'BYTES':>14}{'SHARE':>9}")
    for key, size in sizes.most_common():
        print(f"{key:<12}{buckets[key]:>8}{size:>14,}{100 * size / total_size:>8.1f}%")
    print(f"{'TOTAL':<12}{sum(buckets.values()):>8}{total_size:>14,}")

    biggest.sort(reverse=True)
    print("\nlargest files:")
    for size, name in biggest[:12]:
        print(f"  {size:>12,}  {name}")

    out["assets"] = {k: {"files": buckets[k], "bytes": sizes[k]} for k in sizes}
    out["assets_total_bytes"] = total_size

    if json_out:
        with open(json_out, "w", encoding="utf-8") as handle:
            json.dump(out, handle, indent=2, ensure_ascii=False)
        print(f"\nwrote {json_out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
