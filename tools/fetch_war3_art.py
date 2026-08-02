#!/usr/bin/env python3
"""Fetch exactly the Warcraft III art the map refers to and does not ship.

    python3 tools/fetch_war3_art.py [--out build/war3/art] [--json report.json]

Reads `docs/data/asset-gap.json` — produced by `analyze_assets.py` — and pulls
only the models, textures and icons on that list. Nothing speculative: the
mirror holds roughly ten thousand files and the map needs a few hundred.

Every reference resolves to one of three places, and knowing which matters:

  * the Warcraft III mirror  — stock art, fetched here
  * the map archive itself   — the author's own imports, already extracted
  * nowhere                  — dead references left in the object data

Output goes to `build/war3/art/`, which git ignores. Nothing from Blizzard is
committed to this repository.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request

# The mirror keeps a fully lower-cased tree, which removes any need to guess
# the original capitalisation of a path taken from the map's object data.
BASE = "https://raw.githubusercontent.com/WarRaft/War3.mpq/main/lowercase"
LISTFILE = "https://raw.githubusercontent.com/WarRaft/War3.mpq/main/listfile.txt"


def normalise(path: str) -> str:
    """Map an object-data reference onto the mirror's path convention."""
    clean = path.strip().lower().replace("\\", "/")
    # Object data still names models `.mdl`; the shipped files are binary `.mdx`.
    if clean.endswith(".mdl"):
        clean = clean[:-4] + ".mdx"
    return clean


def load_listfile(cache: str) -> set:
    if not os.path.isfile(cache):
        request = urllib.request.Request(LISTFILE, headers={"User-Agent": "WC3WeldAran/pipeline"})
        with urllib.request.urlopen(request, timeout=60) as response:
            payload = response.read()
        with open(cache, "wb") as handle:
            handle.write(payload)
    with open(cache, "r", encoding="utf-8", errors="replace") as handle:
        return {line.strip().lower().replace("\\", "/") for line in handle if line.strip()}


def shipped_by_map(extract_dir: str) -> set:
    """Basenames the map archive already provides."""
    names = set()
    for root, _dirs, files in os.walk(extract_dir):
        for name in files:
            relative = os.path.relpath(os.path.join(root, name), extract_dir)
            names.add(relative.lower().replace(os.sep, "/"))
            names.add(name.lower())
    return names


def fetch(remote: str, destination: str) -> int:
    request = urllib.request.Request(f"{BASE}/{remote}", headers={"User-Agent": "WC3WeldAran/pipeline"})
    with urllib.request.urlopen(request, timeout=60) as response:
        payload = response.read()
    os.makedirs(os.path.dirname(destination), exist_ok=True)
    with open(destination, "wb") as handle:
        handle.write(payload)
    return len(payload)


def main() -> int:
    argv = sys.argv[1:]
    out_dir = argv[argv.index("--out") + 1] if "--out" in argv else os.path.join("build", "war3", "art")
    report_path = argv[argv.index("--json") + 1] if "--json" in argv else None
    gap_path = os.path.join("docs", "data", "asset-gap.json")
    extract_dir = os.path.join("build", "extracted")

    if not os.path.isfile(gap_path):
        print(f"missing {gap_path}\nrun: python3 tools/analyze_assets.py build/extracted build/data --json {gap_path}")
        return 2

    with open(gap_path, "r", encoding="utf-8") as handle:
        gap = json.load(handle)

    os.makedirs(out_dir, exist_ok=True)
    available = load_listfile(os.path.join(out_dir, "_listfile.txt"))
    from_map = shipped_by_map(extract_dir) if os.path.isdir(extract_dir) else set()

    wanted = []
    for group in ("missingModels", "stockTextures", "icons"):
        for path in gap.get(group, []):
            wanted.append((group, path))

    to_fetch, in_map, nowhere = [], [], []
    for group, path in wanted:
        remote = normalise(path)
        if remote in available:
            to_fetch.append((group, path, remote))
        elif remote in from_map or os.path.basename(remote) in from_map:
            in_map.append(path)
        else:
            nowhere.append(path)

    print("=" * 62)
    print("Warcraft III art required by the map")
    print("=" * 62)
    print(f"\n  referenced      {len(wanted)}")
    print(f"  in the mirror   {len(to_fetch)}   <- fetching")
    print(f"  in the map      {len(in_map)}   <- already extracted")
    print(f"  nowhere         {len(nowhere)}   <- dead references in the object data")

    total = 0
    failures = []
    print()
    for index, (_group, _original, remote) in enumerate(to_fetch, 1):
        destination = os.path.join(out_dir, remote)
        if os.path.isfile(destination) and "--force" not in argv:
            total += os.path.getsize(destination)
            continue
        try:
            total += fetch(remote, destination)
        except (urllib.error.URLError, OSError) as error:
            failures.append((remote, str(error)))
        if index % 50 == 0 or index == len(to_fetch):
            print(f"  {index}/{len(to_fetch)}  {total / 1048576:.1f} MB")

    print(f"\n{len(to_fetch) - len(failures)}/{len(to_fetch)} files, {total / 1048576:.1f} MB in {out_dir}")
    if failures:
        print(f"failed: {len(failures)}")
        for name, error in failures[:5]:
            print(f"  {name}: {error}")

    if nowhere:
        print(f"\ndead references ({len(nowhere)}) — these resolve nowhere and are almost")
        print("certainly leftovers in the map's object data:")
        for path in sorted(nowhere)[:12]:
            print(f"  {path}")
        if len(nowhere) > 12:
            print(f"  ... and {len(nowhere) - 12} more")

    if report_path:
        os.makedirs(os.path.dirname(os.path.abspath(report_path)), exist_ok=True)
        with open(report_path, "w", encoding="utf-8") as handle:
            json.dump({
                "referenced": len(wanted),
                "fetched": len(to_fetch) - len(failures),
                "bytes": total,
                "providedByMap": sorted(in_map),
                "deadReferences": sorted(nowhere),
                "failures": [name for name, _ in failures],
            }, handle, indent=2, ensure_ascii=False)
        print(f"\nreport written to {report_path}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
