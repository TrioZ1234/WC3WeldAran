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
        run("convert textures", ["tools/convert_textures.py", EXTRACT,
                                 os.path.join(ASSETS, "textures"),
                                 "--manifest", os.path.join(ASSETS, "textures.json")])
        run("convert models", ["tools/convert_models.py", EXTRACT,
                               os.path.join(ASSETS, "models"),
                               "--textures", os.path.join(ASSETS, "textures"),
                               "--manifest", os.path.join(ASSETS, "models.json")])

    stage()
    print(f"\nbuild complete in {time.time() - started:.1f}s")
    print("  web   : cd web && npm install && npm run dev")
    print("  godot : open the godot/ folder in Godot 4.3+")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
