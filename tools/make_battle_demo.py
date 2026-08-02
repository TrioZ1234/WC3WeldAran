#!/usr/bin/env python3
"""Build the browser battle demo from local pipeline output.

    python3 tools/make_battle_demo.py [--out build/battle.html] [--units 18]

Takes the page template at `engine/demo/battle.html` and injects the data it
needs: unit statistics from `build/data/resolved/units.json`, the attack-versus
-armour table from the map's own `war3mapMisc.txt`, and command-button icons
decoded straight out of the BLP files.

The template ships in git; the generated page does not. That split is
deliberate — the page embeds Warcraft III icons as base64, and nothing from
Blizzard belongs in this repository. Everyone builds their own copy from the
assets they already fetched.

Prerequisites:
    python3 build.py <map.w3x>
    python3 tools/fetch_war3_data.py
    python3 tools/export_stock.py build/war3 build/data
    python3 tools/analyze_assets.py build/extracted build/data --json docs/data/asset-gap.json
    python3 tools/fetch_war3_art.py
"""

from __future__ import annotations

import base64
import io
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from tools.wc3.blp import decode_blp  # noqa: E402

TEMPLATE = os.path.join("engine", "demo", "battle.html")
RESOLVED = os.path.join("build", "data", "resolved", "units.json")
MISC = os.path.join("build", "extracted", "war3mapMisc.txt")
ART = os.path.join("build", "war3", "art")
ICON_PX = 48


def opt(name: str, default):
    return sys.argv[sys.argv.index(name) + 1] if name in sys.argv else default


def as_number(fields: dict, key: str, fallback: float = 0.0) -> float:
    try:
        return float(fields.get(key))
    except (TypeError, ValueError):
        return fallback


def icon_data_uri(path: str) -> str:
    from PIL import Image  # imported lazily: only this step needs Pillow

    width, height, rgba = decode_blp(open(path, "rb").read())
    image = Image.frombytes("RGBA", (width, height), rgba).resize((ICON_PX, ICON_PX), Image.LANCZOS)
    buffer = io.BytesIO()
    image.save(buffer, "PNG", optimize=True)
    return "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode()


def pick_units(resolved: list, limit: int) -> list:
    """Combat-capable units that have an icon on disk, spread across matchup types."""
    candidates = []
    for entry in resolved:
        fields = entry.get("fields", {})
        if as_number(fields, "ua1c") <= 0 or as_number(fields, "umvs") <= 0:
            continue
        if not (as_number(fields, "ua1b") > 0 or as_number(fields, "ua1d") > 0):
            continue
        icon = str(fields.get("uico") or "").strip()
        if not icon:
            continue
        path = os.path.join(ART, icon.lower().replace("\\", "/"))
        if os.path.isfile(path):
            candidates.append((entry["id"], fields, path))

    # Sort by hit points so the list opens with the map's headline units, then
    # cap each attack/armour pairing so the roster stays varied rather than
    # eighteen near-identical heroes.
    seen: dict = {}
    picked = []
    for uid, fields, path in sorted(candidates, key=lambda c: -as_number(c[1], "uhpm")):
        name = str(fields.get("unam") or uid).strip()
        if len(name) < 3:
            continue
        key = (str(fields.get("ua1t")).lower(), str(fields.get("udty")).lower())
        if seen.get(key, 0) >= 2:
            continue
        seen[key] = seen.get(key, 0) + 1
        picked.append((uid, fields, path))
        if len(picked) >= limit:
            break
    return picked


def damage_table(path: str) -> dict:
    """DamageBonus rows out of the map's war3mapMisc.txt."""
    table = {}
    if not os.path.isfile(path):
        return table
    with open(path, "r", encoding="cp1252", errors="replace") as handle:
        for line in handle:
            match = re.match(r"\s*DamageBonus([A-Za-z]+)\s*=\s*(.+)", line)
            if not match:
                continue
            try:
                table[match.group(1).lower()] = [float(v) for v in match.group(2).split(",")]
            except ValueError:
                continue
    return table


def main() -> int:
    out_path = opt("--out", os.path.join("build", "battle.html"))
    limit = int(opt("--units", 18))

    for required in (TEMPLATE, RESOLVED):
        if not os.path.isfile(required):
            print(f"missing {required}")
            print(__doc__)
            return 2

    with open(RESOLVED, "r", encoding="utf-8") as handle:
        resolved = json.load(handle)

    picked = pick_units(resolved, limit)
    units = []
    for uid, fields, path in picked:
        try:
            icon = icon_data_uri(path)
        except Exception as error:  # noqa: BLE001 - one bad icon must not stop the build
            print(f"  skip {uid}: {error}")
            continue
        units.append({
            "id": uid,
            "name": str(fields.get("unam") or uid).strip(),
            "hp": int(as_number(fields, "uhpm", 1)),
            "armor": int(as_number(fields, "udef")),
            "armorType": str(fields.get("udty") or "normal").lower(),
            "attackType": str(fields.get("ua1t") or "normal").lower(),
            "base": int(as_number(fields, "ua1b")),
            "dice": int(as_number(fields, "ua1d")),
            "sides": int(as_number(fields, "ua1s")),
            "cooldown": as_number(fields, "ua1c", 1),
            "range": int(as_number(fields, "ua1r", 90)),
            "speed": int(as_number(fields, "umvs", 270)),
            "acquire": int(as_number(fields, "uacq", 500)),
            "icon": icon,
        })

    if not units:
        print("no units with icons found — run tools/fetch_war3_art.py first")
        return 1

    table = damage_table(MISC)
    payload = (
        "const UNITS=" + json.dumps(units, separators=(",", ":"), ensure_ascii=False) + ";\n"
        "const DAMAGE_TABLE=" + json.dumps(table, separators=(",", ":")) + ";\n"
    )

    with open(TEMPLATE, "r", encoding="utf-8") as handle:
        page = handle.read()
    if "__DATA__" not in page:
        print(f"{TEMPLATE} has no __DATA__ placeholder")
        return 1

    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as handle:
        handle.write(page.replace("__DATA__", payload))

    print(f"{len(units)} units, damage table {'from the map' if table else 'defaults'}")
    print(f"written to {out_path}  ({os.path.getsize(out_path) // 1024} KB)")
    print("open it in any browser — no server needed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
