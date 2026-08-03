#!/usr/bin/env python3
"""Fetch the Warcraft III data tables and scripts the engine needs.

    python3 tools/fetch_war3_data.py [output-dir]

Downloads only the data half of War3.mpq — scripts and spreadsheets, about
4 MB — from the WarRaft/War3.mpq mirror. Art and sound are deliberately not
fetched: they are the large, legally sensitive part, and the engine does not
need them to run game logic.

Output lands in `build/war3/`, which git ignores. Nothing from Blizzard is
committed to this repository; each developer fetches their own copy, exactly
as they would extract it from an installed game.

Why these files:
  common.j        1160 native signatures, 91 handle types, 426 real constants.
                  Turns guessed stub return types into declared ones.
  Blizzard.j      923 working functions. Removes every `*BJ` wrapper from the
                  contract instead of reimplementing them by hand.
  *.slk           Stats for the stock prototypes the map's custom objects are
                  derived from. Without these, a custom unit's inherited
                  hit points are simply unknown.
  *MetaData.slk   Maps object-editor field codes such as `uhpm` onto the
                  spreadsheet column they live in.
"""

from __future__ import annotations

import os
import sys
import urllib.error
import urllib.request

BASE = "https://raw.githubusercontent.com/WarRaft/War3.mpq/main/extract"

FILES = [
    # Scripts — the engine contract itself.
    "Scripts/common.j",
    "Scripts/Blizzard.j",
    # Object metadata — field code to spreadsheet column.
    "Units/UnitMetaData.slk",
    "Units/AbilityMetaData.slk",
    "Units/AbilityBuffMetaData.slk",
    "Units/DestructableMetaData.slk",
    "Units/UpgradeMetaData.slk",
    "Doodads/DoodadMetaData.slk",
    # Stock prototype statistics.
    "Units/UnitData.slk",
    "Units/UnitBalance.slk",
    "Units/unitUI.slk",
    "Units/UnitWeapons.slk",
    "Units/UnitAbilities.slk",
    "Units/AbilityData.slk",
    "Units/AbilityBuffData.slk",
    "Units/ItemData.slk",
    "Units/DestructableData.slk",
    "Units/UpgradeData.slk",
    "Doodads/Doodads.slk",
]


def fetch(url: str, destination: str) -> int:
    request = urllib.request.Request(url, headers={"User-Agent": "WC3WeldAran/pipeline"})
    with urllib.request.urlopen(request, timeout=60) as response:
        payload = response.read()
    with open(destination, "wb") as handle:
        handle.write(payload)
    return len(payload)


def main() -> int:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    out_dir = args[0] if args else os.path.join("build", "war3")
    os.makedirs(out_dir, exist_ok=True)

    total = 0
    failures = []
    for relative in FILES:
        name = os.path.basename(relative)
        destination = os.path.join(out_dir, name)
        if os.path.isfile(destination) and "--force" not in sys.argv:
            print(f"  have {name}")
            total += os.path.getsize(destination)
            continue
        try:
            size = fetch(f"{BASE}/{relative}", destination)
            total += size
            print(f"  get  {name:28} {size:>9,} bytes")
        except (urllib.error.URLError, OSError) as error:
            failures.append((name, str(error)))
            print(f"  FAIL {name:28} {error}")

    print(f"\n{len(FILES) - len(failures)}/{len(FILES)} files, {total / 1048576:.1f} MB in {out_dir}")
    if failures:
        print("\nfailed:")
        for name, error in failures:
            print(f"  {name}: {error}")
        return 1

    print("\nnext:")
    print("  python3 tools/export_stock.py build/war3 build/data")
    print("  node engine/cli/run-jass.ts build/extracted/war3map.j")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
