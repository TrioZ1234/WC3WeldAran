#!/usr/bin/env python3
"""Unpack a Warcraft III .w3x map archive into a directory tree.

Usage:
    python3 tools/extract_map.py <map.w3x> <output-dir>

Every file named in the archive's (listfile) is written out, preserving the
internal directory layout. Files that fail to decode are reported at the end
rather than aborting the run, so a single unsupported codec never blocks a
full extraction.
"""

from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from tools.wc3.mpq import MPQArchive, MPQError  # noqa: E402

# Internal files that exist in every map but are often absent from (listfile).
WELL_KNOWN = [
    "war3map.w3e", "war3map.w3i", "war3map.wtg", "war3map.wct", "war3map.wts",
    "war3map.j", "war3map.shd", "war3map.mmp", "war3map.wpm", "war3map.doo",
    "war3mapUnits.doo", "war3map.w3r", "war3map.w3c", "war3map.w3u",
    "war3map.w3t", "war3map.w3b", "war3map.w3d", "war3map.w3a", "war3map.w3h",
    "war3map.w3q", "war3map.w3s", "war3map.imp", "war3mapMap.blp",
    "war3mapMap.b00", "war3mapMap.tga", "war3mapPreview.tga",
    "war3mapMisc.txt", "war3mapSkin.txt", "war3mapExtra.txt",
    "scripts\\war3map.j", "conflict.j",
    "(listfile)", "(attributes)", "(signature)",
]


def main() -> int:
    if len(sys.argv) != 3:
        print(__doc__)
        return 2
    map_path, out_dir = sys.argv[1], sys.argv[2]

    archive = MPQArchive.open_map(map_path)
    names = archive.listfile() or []
    known = set(names)
    for candidate in WELL_KNOWN:
        if candidate not in known and candidate in archive:
            names.append(candidate)
            known.add(candidate)

    os.makedirs(out_dir, exist_ok=True)
    manifest = []
    failures = []

    for name in names:
        rel = name.replace("\\", os.sep)
        dest = os.path.join(out_dir, rel)
        try:
            payload = archive.read_file(name)
        except KeyError:
            failures.append((name, "not present in archive"))
            continue
        except (MPQError, Exception) as exc:  # noqa: BLE001 - report, don't abort
            failures.append((name, str(exc)))
            continue

        os.makedirs(os.path.dirname(dest) or out_dir, exist_ok=True)
        with open(dest, "wb") as handle:
            handle.write(payload)
        manifest.append({"name": name, "size": len(payload)})

    manifest_path = os.path.join(out_dir, "_manifest.json")
    with open(manifest_path, "w", encoding="utf-8") as handle:
        json.dump({
            "source": os.path.basename(map_path),
            "format_version": archive.format_version,
            "sector_size": archive.sector_size,
            "block_count": archive.used_block_count,
            "extracted": len(manifest),
            "failed": len(failures),
            "files": manifest,
            "failures": [{"name": n, "error": e} for n, e in failures],
        }, handle, indent=2)

    print(f"extracted {len(manifest)} files to {out_dir}")
    if failures:
        print(f"{len(failures)} failures:")
        for name, err in failures[:20]:
            print(f"  {name}: {err}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
