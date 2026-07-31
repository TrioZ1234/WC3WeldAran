#!/usr/bin/env python3
"""Convert Warcraft III textures (BLP1, TGA) to web/engine formats.

Requires Pillow:  pip install Pillow

Usage:
    python3 tools/convert_textures.py <extracted-dir> <output-dir> [options]

Options:
    --format auto|png|jpg|webp
                            auto (default) picks JPEG for fully opaque images
                            and WebP where alpha is actually used
    --quality N             lossy quality, default 90
    --max-size N            downscale anything larger than N on its long edge
    --manifest FILE         write a JSON conversion report

Format choice matters more than it looks. BLP is lossy, so re-encoding an
alpha texture as lossless PNG makes it ~40% *bigger* than the original. WebP
carries lossy colour plus an alpha channel in one file and is understood by
both browsers and Godot 4, so `auto` uses it wherever alpha is real and plain
JPEG everywhere else.
"""

from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from tools.wc3.blp import BLPError, decode_blp, has_alpha, parse_header  # noqa: E402

SOURCE_EXTS = {".blp", ".tga"}
ALPHA_THRESHOLD = 252  # below this a pixel counts as genuinely translucent


def opt(name: str, default=None):
    return sys.argv[sys.argv.index(name) + 1] if name in sys.argv else default


def load_image(path: str):
    """Return a Pillow RGBA image for a BLP or TGA source file."""
    from PIL import Image

    ext = os.path.splitext(path)[1].lower()
    with open(path, "rb") as handle:
        data = handle.read()

    if ext == ".blp":
        header = parse_header(data)
        width, height, rgba = decode_blp(data)
        image = Image.frombytes("RGBA", (width, height), rgba)
        return image, has_alpha(header.alpha_bits)

    image = Image.open(path)
    image.load()
    declared = image.mode in ("RGBA", "LA", "PA")
    return image.convert("RGBA"), declared


def uses_alpha(image) -> bool:
    """True when the alpha channel actually varies - not just declared."""
    alpha = image.getchannel("A")
    low, high = alpha.getextrema()
    return low < ALPHA_THRESHOLD


def main() -> int:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    # Drop values that belong to option flags.
    for flag in ("--format", "--quality", "--max-size", "--manifest"):
        value = opt(flag)
        if value in args:
            args.remove(value)
    if len(args) < 2:
        print(__doc__)
        return 2

    root, out_dir = args[0], args[1]
    fmt = opt("--format", "auto")
    quality = int(opt("--quality", 90))
    max_size = int(opt("--max-size", 0) or 0)
    manifest_path = opt("--manifest")

    sources = []
    for dirpath, _, filenames in os.walk(root):
        for filename in filenames:
            if os.path.splitext(filename)[1].lower() in SOURCE_EXTS:
                sources.append(os.path.join(dirpath, filename))
    sources.sort()

    records = []
    failures = []
    total_in = total_out = 0

    for path in sources:
        rel = os.path.relpath(path, root)
        try:
            image, declared_alpha = load_image(path)
        except (BLPError, OSError, ValueError) as exc:
            failures.append({"file": rel, "error": str(exc)})
            print(f"  FAIL {rel}: {exc}")
            continue

        if max_size and max(image.size) > max_size:
            ratio = max_size / max(image.size)
            image = image.resize(
                (max(1, round(image.width * ratio)), max(1, round(image.height * ratio))),
                resample=1)  # LANCZOS

        real_alpha = declared_alpha and uses_alpha(image)

        if fmt == "auto":
            ext, mode = (".webp", "WEBP") if real_alpha else (".jpg", "JPEG")
        elif fmt == "png":
            ext, mode = ".png", "PNG"
        elif fmt == "webp":
            ext, mode = ".webp", "WEBP"
        else:
            ext, mode = ".jpg", "JPEG"

        dest = os.path.join(out_dir, os.path.splitext(rel)[0] + ext)
        os.makedirs(os.path.dirname(dest), exist_ok=True)

        if mode == "JPEG":
            image.convert("RGB").save(dest, "JPEG", quality=quality, optimize=True)
        elif mode == "WEBP":
            image.save(dest, "WEBP", quality=quality, method=4)
        else:
            image.save(dest, "PNG", optimize=True)

        size_in = os.path.getsize(path)
        size_out = os.path.getsize(dest)
        total_in += size_in
        total_out += size_out
        records.append({
            "source": rel.replace(os.sep, "/"),
            "output": os.path.relpath(dest, out_dir).replace(os.sep, "/"),
            "size": list(image.size),
            "alpha": real_alpha,
            "bytesIn": size_in,
            "bytesOut": size_out,
        })

    print(f"\nconverted {len(records)}/{len(sources)} textures")
    print(f"  with alpha : {sum(1 for r in records if r['alpha'])}")
    print(f"  opaque     : {sum(1 for r in records if not r['alpha'])}")
    print(f"  bytes in   : {total_in:,}")
    print(f"  bytes out  : {total_out:,}"
          + (f"  ({100 * (total_in - total_out) / total_in:.1f}% smaller)"
             if total_in else ""))
    if failures:
        print(f"  FAILURES   : {len(failures)}")

    if manifest_path:
        os.makedirs(os.path.dirname(manifest_path) or ".", exist_ok=True)
        with open(manifest_path, "w", encoding="utf-8") as handle:
            json.dump({"textures": records, "failures": failures}, handle, indent=1)
        print(f"  manifest   : {manifest_path}")

    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
