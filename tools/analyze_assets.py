#!/usr/bin/env python3
"""Measure what the map still needs from an installed Warcraft III.

Usage:
    python3 tools/analyze_assets.py <extracted-dir> <data-dir> [--json report.json]

The map is a *diff* against Warcraft III, not a self-contained package. Custom
units are declared as "base = hbla, change these 20 fields"; every field left
alone — model, icon, sounds, attack speed, armour type — is inherited from a
stock object that lives in War3.mpq, not in the .w3x.

This script quantifies that dependency so the gap to a standalone build is a
tracked number rather than a guess. It reads only pipeline output, never the
archive itself.
"""

from __future__ import annotations

import json
import os
import sys

# Object-data fields that name an art or sound file, per object type.
MODEL_FIELDS = ("umdl", "imod", "bmod", "dfil", "ufoo", "amat")
ICON_FIELDS = ("uico", "iico", "aart", "ucun", "gar1", "arar")
SOUND_FIELDS = ("usnd", "usei", "ucs1", "asnd", "gsnd")

OBJECT_FILES = (
    "units.json", "items.json", "abilities.json", "buffs.json",
    "destructables.json", "doodads.json", "upgrades.json",
)


def normalise(path: str) -> str:
    return path.strip().lower().replace("/", "\\")


def collect(data_dir: str) -> dict:
    """Walk the exported object tables and gather every external reference."""
    bases: set = set()
    models: set = set()
    icons: set = set()
    sounds: set = set()
    custom_total = 0
    inherits_model = 0
    per_type = {}

    objects_dir = os.path.join(data_dir, "objects")
    for filename in OBJECT_FILES:
        path = os.path.join(objects_dir, filename)
        if not os.path.isfile(path):
            continue
        with open(path, "r", encoding="utf-8") as handle:
            table = json.load(handle)

        custom = table.get("custom") or []
        modified = table.get("modifiedStock") or []
        per_type[filename[:-5]] = {"custom": len(custom), "modifiedStock": len(modified)}

        for obj in custom:
            custom_total += 1
            base = obj.get("base")
            if base:
                bases.add(base)

            fields = {m.get("field"): m.get("value") for m in obj.get("mods", [])}

            model = next((fields[f] for f in MODEL_FIELDS
                          if isinstance(fields.get(f), str) and fields[f].strip()), None)
            if model:
                models.add(normalise(model))
            else:
                # No model of its own: whatever the stock prototype looks like.
                inherits_model += 1

            for field in ICON_FIELDS:
                value = fields.get(field)
                if isinstance(value, str) and value.strip():
                    icons.add(normalise(value))
            for field in SOUND_FIELDS:
                value = fields.get(field)
                if isinstance(value, str) and value.strip():
                    sounds.add(normalise(value))

        # A modified stock object is, by definition, a dependency on that stock object.
        for obj in modified:
            if obj.get("id"):
                bases.add(obj["id"])

    return {
        "bases": bases, "models": models, "icons": icons, "sounds": sounds,
        "customTotal": custom_total, "inheritsModel": inherits_model,
        "perType": per_type,
    }


def shipped_models(build_dir: str) -> set:
    """Model files the map actually carries, by full path and by basename."""
    manifest = os.path.join(build_dir, "assets", "models.json")
    if not os.path.isfile(manifest):
        return set()
    with open(manifest, "r", encoding="utf-8") as handle:
        data = json.load(handle)
    names = set()
    for entry in data.get("models", []):
        source = normalise(entry.get("source", ""))
        names.add(source)
        names.add(os.path.basename(source))
    return names


def main() -> int:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if len(args) < 2:
        print(__doc__)
        return 2
    extract_dir, data_dir = args[0], args[1]
    json_index = sys.argv.index("--json") if "--json" in sys.argv else -1
    json_path = sys.argv[json_index + 1] if json_index >= 0 else None

    build_dir = os.path.dirname(os.path.abspath(data_dir))
    found = collect(data_dir)
    shipped = shipped_models(build_dir)

    missing_models = sorted(
        m for m in found["models"]
        if m not in shipped and os.path.basename(m) not in shipped
    )

    stock_textures: list = []
    manifest = os.path.join(build_dir, "assets", "models.json")
    if os.path.isfile(manifest):
        with open(manifest, "r", encoding="utf-8") as handle:
            stock_textures = json.load(handle).get("stockTextures", [])

    print("=" * 62)
    print("Dependency on an installed Warcraft III")
    print("=" * 62)
    print("\nobject data")
    for name, counts in found["perType"].items():
        print(f"  {name:14} custom {counts['custom']:4}   modified stock {counts['modifiedStock']:4}")
    print(f"\n  custom objects total       {found['customTotal']:5}")
    print(f"  distinct stock prototypes  {len(found['bases']):5}   <- their stats live in War3.mpq SLK tables")
    print(f"  custom objects with no own model {found['inheritsModel']:4}   <- inherit stock art entirely")

    print("\nart and sound references that the map does NOT ship")
    print(f"  models    {len(missing_models):5} of {len(found['models'])} referenced")
    print(f"  textures  {len(stock_textures):5} (from the model converter)")
    print(f"  icons     {len(found['icons']):5}")
    print(f"  sounds    {len(found['sounds']):5}")

    print("\nsample of missing models:")
    for path in missing_models[:10]:
        print(f"    {path}")

    if json_path:
        report = {
            "customObjects": found["customTotal"],
            "stockPrototypes": sorted(found["bases"]),
            "inheritsModelFromStock": found["inheritsModel"],
            "perType": found["perType"],
            "missingModels": missing_models,
            "stockTextures": sorted(stock_textures),
            "icons": sorted(found["icons"]),
            "sounds": sorted(found["sounds"]),
            "totals": {
                "missingModels": len(missing_models),
                "stockTextures": len(stock_textures),
                "icons": len(found["icons"]),
                "sounds": len(found["sounds"]),
                "stockPrototypes": len(found["bases"]),
            },
        }
        os.makedirs(os.path.dirname(os.path.abspath(json_path)), exist_ok=True)
        with open(json_path, "w", encoding="utf-8") as handle:
            json.dump(report, handle, indent=2, ensure_ascii=False)
        print(f"\nreport written to {json_path}")

    void = extract_dir  # reserved: future passes may re-read raw files
    del void
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
