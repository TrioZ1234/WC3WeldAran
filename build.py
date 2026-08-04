#!/usr/bin/env python3
"""One-command build: .w3x -> engine-ready data, staged into both frontends.

    python3 build.py path/to/WFWA.w3x
    python3 build.py path/to/WFWA.w3x --skip-assets     data only, much faster
    python3 build.py --stage-only                       re-link existing output

Runs the whole pipeline in order and then publishes the result to
`web/public/` and `godot/` so the WebGPU frontend and the Godot project read
byte-identical content. Works on Windows, macOS and Linux; a Makefile with the
same targets is provided for convenience where `make` is available.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.abspath(__file__))
BUILD = os.path.join(ROOT, "build")
EXTRACT = os.path.join(BUILD, "extracted")
DATA = os.path.join(BUILD, "data")
ASSETS = os.path.join(BUILD, "assets")

# (target inside the frontend, source directory)
STAGE_TARGETS = [
    (os.path.join(ROOT, "web", "public", "data"), DATA),
    (os.path.join(ROOT, "web", "public", "assets"), ASSETS),
    (os.path.join(ROOT, "godot", "data"), DATA),
    (os.path.join(ROOT, "godot", "assets"), ASSETS),
]


def run(label: str, args: list) -> None:
    print(f"\n=== {label} " + "=" * max(0, 60 - len(label)))
    started = time.time()
    result = subprocess.run([sys.executable] + args, cwd=ROOT)
    if result.returncode not in (0, 1):   # 1 means "completed with warnings"
        raise SystemExit(f"{label} failed with exit code {result.returncode}")
    print(f"--- {label} done in {time.time() - started:.1f}s")


def stage_scripts() -> None:
    """Copy the JASS scripts and the damage table into the data directory.

    The web client runs the map's own script in a worker, so it needs
    `common.j`, `Blizzard.j`, `war3map.j` and `war3mapMisc.txt` over HTTP. They
    are copied into `build/data/scripts/` rather than staged separately, so the
    single symlink each frontend already has continues to cover everything.

    Missing files are skipped rather than fatal: `common.j` and `Blizzard.j` come
    from `tools/fetch_war3_data.py`, which is a separate, optional step.
    """
    target = os.path.join(DATA, "scripts")
    sources = [
        os.path.join(EXTRACT, "war3map.j"),
        os.path.join(EXTRACT, "war3mapMisc.txt"),
        os.path.join(BUILD, "war3", "common.j"),
        os.path.join(BUILD, "war3", "Blizzard.j"),
    ]
    present = [path for path in sources if os.path.isfile(path)]
    if not present:
        return

    os.makedirs(target, exist_ok=True)
    for path in present:
        shutil.copy2(path, os.path.join(target, os.path.basename(path)))
    print(f"\n=== scripts " + "=" * 53)
    print(f"  {len(present)}/{len(sources)} files -> {os.path.relpath(target, ROOT)}")
    for path in sources:
        if path not in present:
            print(f"  missing {os.path.relpath(path, ROOT)}")
    if not os.path.isfile(os.path.join(BUILD, "war3", "common.j")):
        print("  run tools/fetch_war3_data.py to let the browser run the map's own script")


def art_root() -> str:
    """Union of the map's own imports and the stock art fetched from War3.mpq.

    The converters walk a single tree, and the two halves of the map's art live
    in two: the author's imports come out of the archive into `build/extracted`,
    while everything inherited from a stock prototype is pulled by
    `tools/fetch_war3_art.py` into `build/war3/art`. Converting only the former
    leaves every stock unit without a model and every stock model without its
    skin, so the trees are merged here - hardlinks where the filesystem allows
    it, copies otherwise, and the map always wins a name collision because its
    imports are what override the stock file in Warcraft III too.
    """
    union = os.path.join(BUILD, "artroot")
    sources = [EXTRACT, os.path.join(BUILD, "war3", "art")]
    linked = copied = 0
    for source in sources:
        if not os.path.isdir(source):
            continue
        for dirpath, _dirs, files in os.walk(source):
            for name in files:
                origin = os.path.join(dirpath, name)
                target = os.path.join(union, os.path.relpath(origin, source))
                if os.path.exists(target):
                    continue
                os.makedirs(os.path.dirname(target), exist_ok=True)
                try:
                    os.link(origin, target)
                    linked += 1
                except (OSError, NotImplementedError, AttributeError):
                    shutil.copy2(origin, target)
                    copied += 1
    print(f"\n=== art root " + "=" * 51)
    print(f"  {linked} linked, {copied} copied -> {os.path.relpath(union, ROOT)}")
    if not os.path.isdir(sources[1]):
        print("  no build/war3/art: run tools/fetch_war3_art.py for the stock models")
    return union


def stage() -> None:
    """Publish build output into both frontends.

    Symlinks keep a single copy on disk, but Windows needs Developer Mode or
    admin rights to create them, so fall back to copying rather than failing.
    """
    print(f"\n=== stage " + "=" * 55)
    for target, source in STAGE_TARGETS:
        if not os.path.isdir(source):
            print(f"  skip {os.path.relpath(target, ROOT)} (no {os.path.relpath(source, ROOT)})")
            continue
        os.makedirs(os.path.dirname(target), exist_ok=True)
        if os.path.islink(target):
            os.unlink(target)
        elif os.path.isdir(target):
            shutil.rmtree(target)

        relative = os.path.relpath(source, os.path.dirname(target))
        try:
            os.symlink(relative, target, target_is_directory=True)
            how = "link"
        except (OSError, NotImplementedError, AttributeError):
            shutil.copytree(source, target)
            how = "copy"
        print(f"  {how} {os.path.relpath(target, ROOT)} -> {os.path.relpath(source, ROOT)}")


def main() -> int:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    skip_assets = "--skip-assets" in sys.argv
    stage_only = "--stage-only" in sys.argv

    if stage_only:
        stage_scripts()
        stage()
        return 0

    if not args:
        print(__doc__)
        return 2
    map_path = os.path.abspath(args[0])
    if not os.path.isfile(map_path):
        print(f"map not found: {map_path}")
        return 2

    started = time.time()
    run("extract", ["tools/extract_map.py", map_path, EXTRACT])
    run("export data", ["tools/export_data.py", EXTRACT, DATA])
    run("analyse map", ["tools/analyze_map.py", EXTRACT, "--json", "docs/data/map-report.json"])
    run("analyse script", ["tools/analyze_jass.py", os.path.join(EXTRACT, "war3map.j"),
                           "--json", "docs/data/jass-api.json"])

    if skip_assets:
        print("\nskipping texture and model conversion (--skip-assets)")
    else:
        art = art_root()
        run("convert textures", ["tools/convert_textures.py", art,
                                 os.path.join(ASSETS, "textures"),
                                 "--manifest", os.path.join(ASSETS, "textures.json")])
        run("convert models", ["tools/convert_models.py", art,
                               os.path.join(ASSETS, "models"),
                               "--textures", os.path.join(ASSETS, "textures"),
                               "--manifest", os.path.join(ASSETS, "models.json")])

    stage_scripts()
    stage()
    print(f"\nbuild complete in {time.time() - started:.1f}s")
    print("  web   : cd web && npm install && npm run dev")
    print("  godot : open the godot/ folder in Godot 4.3+")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
