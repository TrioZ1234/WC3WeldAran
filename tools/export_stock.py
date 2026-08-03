#!/usr/bin/env python3
"""Resolve the map's objects against Warcraft III's stock prototypes.

    python3 tools/export_stock.py <war3-dir> <data-dir> [--json report.json]

The map stores its objects as a *diff*: "take prototype `hbla`, change these 20
fields". Every field left alone is inherited from a stock object that lives in
War3.mpq, so a custom unit's hit points are unknowable from the .w3x alone.

This script closes that gap. It reads the stock spreadsheets, applies the map's
modifications on top, and writes complete self-contained definitions:

    build/data/stock/*.json      the stock prototypes, keyed by id
    build/data/resolved/*.json   the map's objects with every field filled in

After this runs, the game *logic* no longer depends on War3.mpq. Only art and
sound still do — which splits the standalone problem cleanly in two.

Field codes such as `uhpm` are mapped onto spreadsheet columns using the
`*MetaData.slk` tables, so nothing here is hand-maintained.
"""

from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from tools.wc3.slk import read_table, key_of  # noqa: E402

# Logical table name used by the metadata -> file on disk.
SLK_FILES = {
    "UnitData": "UnitData.slk",
    "UnitBalance": "UnitBalance.slk",
    "UnitUI": "unitUI.slk",
    "UnitWeapons": "UnitWeapons.slk",
    "UnitAbilities": "UnitAbilities.slk",
    "ItemData": "ItemData.slk",
    "AbilityData": "AbilityData.slk",
    "AbilityBuffData": "AbilityBuffData.slk",
    "DestructableData": "DestructableData.slk",
    "UpgradeData": "UpgradeData.slk",
    # DoodadMetaData calls this table "DoodadData"; the file on disk is Doodads.slk.
    "DoodadData": "Doodads.slk",
}

META_FILES = [
    "UnitMetaData.slk", "AbilityMetaData.slk", "AbilityBuffMetaData.slk",
    "DestructableMetaData.slk", "UpgradeMetaData.slk", "DoodadMetaData.slk",
]

# Exported object table -> the stock tables its prototypes come from.
CATEGORIES = {
    "units": ["UnitData", "UnitBalance", "UnitUI", "UnitWeapons", "UnitAbilities"],
    "items": ["ItemData"],
    "abilities": ["AbilityData"],
    "buffs": ["AbilityBuffData"],
    "destructables": ["DestructableData"],
    "upgrades": ["UpgradeData"],
    "doodads": ["DoodadData"],
}


def load_metadata(war3_dir: str) -> dict:
    """field code -> (logical table, column name)."""
    mapping = {}
    for name in META_FILES:
        path = os.path.join(war3_dir, name)
        if not os.path.isfile(path):
            continue
        for row in read_table(path):
            code = row.get("ID")
            field = row.get("field")
            table = row.get("slk")
            if not (isinstance(code, str) and isinstance(field, str) and isinstance(table, str)):
                continue
            code = code.strip()
            field = field.strip()
            if not code or table == "Profile":
                # Profile fields live in the .txt string tables, not the spreadsheets.
                continue
            index = row.get("index", -1)
            suffix = int(index) + 1 if isinstance(index, (int, float)) and int(index) >= 0 else None
            # Array fields split across columns (`cool1`, `cool2`), but several
            # tables set index 0 on plain fields. Keep both candidates and let
            # the data decide which column actually exists.
            mapping[code] = (table, field, suffix)
    return mapping


def load_tables(war3_dir: str) -> dict:
    """logical table -> {id: row}."""
    tables = {}
    for logical, filename in SLK_FILES.items():
        path = os.path.join(war3_dir, filename)
        if not os.path.isfile(path):
            continue
        indexed = {}
        for row in read_table(path):
            key = key_of(row)
            if key:
                indexed[key] = row
        tables[logical] = indexed
    return tables


def build_prototypes(tables: dict, mapping: dict) -> dict:
    """category -> {id: {field code: value}}."""
    # Invert: table -> [(code, base column, array suffix or None)]
    by_table = {}
    for code, (table, column, suffix) in mapping.items():
        by_table.setdefault(table, []).append((code, column, suffix))

    prototypes = {}
    for category, sources in CATEGORIES.items():
        records: dict = {}
        for table in sources:
            rows = tables.get(table)
            if not rows:
                continue
            for object_id, row in rows.items():
                target = records.setdefault(object_id, {})
                for code, column, suffix in by_table.get(table, []):
                    name = None
                    if suffix is not None and f"{column}{suffix}" in row:
                        name = f"{column}{suffix}"
                    elif column in row:
                        name = column
                    if name is None:
                        continue
                    value = row[name]
                    if value != "" and value != "-":
                        target[code] = value
        prototypes[category] = records
    return prototypes


def resolve(objects_path: str, prototypes: dict) -> dict:
    """Apply the map's modifications on top of the stock prototypes."""
    if not os.path.isfile(objects_path):
        return {"resolved": [], "missingBases": []}

    with open(objects_path, "r", encoding="utf-8") as handle:
        table = json.load(handle)

    resolved = []
    missing = []

    for obj in table.get("custom", []) or []:
        base = obj.get("base")
        fields = dict(prototypes.get(base, {}))
        if base and base not in prototypes:
            missing.append(base)
        for mod in obj.get("mods", []) or []:
            field = mod.get("field")
            if field:
                fields[field] = mod.get("value")
        resolved.append({"id": obj.get("id"), "base": base, "inherited": len(prototypes.get(base, {})),
                         "fields": fields})

    for obj in table.get("modifiedStock", []) or []:
        # A modified stock object edits the prototype in place: `base` carries the
        # real id and `id` is four NUL bytes, because no new object is created.
        object_id = obj.get("base") or obj.get("id")
        if isinstance(object_id, str):
            object_id = object_id.replace("\x00", "").strip()
        fields = dict(prototypes.get(object_id, {}))
        if object_id and object_id not in prototypes:
            missing.append(object_id)
        for mod in obj.get("mods", []) or []:
            field = mod.get("field")
            if field:
                fields[field] = mod.get("value")
        resolved.append({"id": object_id, "base": object_id, "modifiesStock": True,
                         "inherited": len(prototypes.get(object_id, {})), "fields": fields})

    return {"resolved": resolved, "missingBases": sorted(set(missing))}


def main() -> int:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if len(args) < 2:
        print(__doc__)
        return 2
    war3_dir, data_dir = args[0], args[1]
    json_index = sys.argv.index("--json") if "--json" in sys.argv else -1
    report_path = sys.argv[json_index + 1] if json_index >= 0 else None

    if not os.path.isdir(war3_dir):
        print(f"war3 data not found: {war3_dir}")
        print("run: python3 tools/fetch_war3_data.py")
        return 2

    mapping = load_metadata(war3_dir)
    tables = load_tables(war3_dir)
    prototypes = build_prototypes(tables, mapping)

    print("=" * 62)
    print("Stock prototypes")
    print("=" * 62)
    print(f"\nfield codes mapped : {len(mapping)}")
    print("spreadsheets loaded:")
    for name, rows in sorted(tables.items()):
        print(f"  {name:20} {len(rows):5} rows")

    stock_dir = os.path.join(data_dir, "stock")
    resolved_dir = os.path.join(data_dir, "resolved")
    os.makedirs(stock_dir, exist_ok=True)
    os.makedirs(resolved_dir, exist_ok=True)

    print("\nprototypes exported:")
    summary = {}
    for category, records in prototypes.items():
        with open(os.path.join(stock_dir, f"{category}.json"), "w", encoding="utf-8") as handle:
            json.dump(records, handle, ensure_ascii=False, separators=(",", ":"))
        fields = sum(len(v) for v in records.values())
        print(f"  {category:16} {len(records):5} objects, {fields:7} fields")
        summary[category] = {"prototypes": len(records), "fields": fields}

    print("\nmap objects resolved against them:")
    total_missing = set()
    for category in CATEGORIES:
        objects_path = os.path.join(data_dir, "objects", f"{category}.json")
        outcome = resolve(objects_path, prototypes[category])
        if not outcome["resolved"] and not os.path.isfile(objects_path):
            continue
        with open(os.path.join(resolved_dir, f"{category}.json"), "w", encoding="utf-8") as handle:
            json.dump(outcome["resolved"], handle, ensure_ascii=False, separators=(",", ":"))
        inherited = sum(o["inherited"] for o in outcome["resolved"])
        complete = sum(1 for o in outcome["resolved"] if o["inherited"] > 0)
        total_missing |= set(outcome["missingBases"])
        print(f"  {category:16} {len(outcome['resolved']):5} objects, "
              f"{complete:5} with a known prototype, {inherited:7} fields inherited")
        summary.setdefault(category, {})["resolved"] = len(outcome["resolved"])
        summary[category]["withPrototype"] = complete
        summary[category]["inheritedFields"] = inherited

    if total_missing:
        print(f"\nprototypes not found in the stock tables: {len(total_missing)}")
        for base in sorted(total_missing)[:10]:
            print(f"  {base}")
    else:
        print("\nevery prototype the map refers to was resolved")

    print(f"\nwritten to {stock_dir} and {resolved_dir}")

    if report_path:
        os.makedirs(os.path.dirname(os.path.abspath(report_path)), exist_ok=True)
        with open(report_path, "w", encoding="utf-8") as handle:
            json.dump({"fieldCodes": len(mapping),
                       "tables": {k: len(v) for k, v in tables.items()},
                       "categories": summary,
                       "missingBases": sorted(total_missing)}, handle, indent=2, ensure_ascii=False)
        print(f"report written to {report_path}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
