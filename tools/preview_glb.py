#!/usr/bin/env python3
"""Render a .glb to a PNG with a tiny software rasteriser.

This exists to verify the model converter without a GPU or a browser: it
loads the GLB back through the public glTF structures, so a bad accessor,
a broken index buffer or flipped UVs shows up as a visibly wrong picture.

Usage:
    python3 tools/preview_glb.py <model.glb> <out.png> [--size N] [--textures DIR]
"""

from __future__ import annotations

import json
import os
import struct
import sys

import numpy as np

COMPONENT_DTYPE = {
    5120: "<i1", 5121: "<u1", 5122: "<i2",
    5123: "<u2", 5125: "<u4", 5126: "<f4",
}
TYPE_COUNT = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}


def load_glb(path: str):
    with open(path, "rb") as handle:
        data = handle.read()
    magic, _, _ = struct.unpack_from("<4sII", data, 0)
    if magic != b"glTF":
        raise ValueError("not a GLB file")
    offset = 12
    doc = None
    blob = b""
    while offset < len(data):
        length, kind = struct.unpack_from("<II", data, offset)
        payload = data[offset + 8:offset + 8 + length]
        if kind == 0x4E4F534A:
            doc = json.loads(payload.decode("utf-8"))
        elif kind == 0x004E4942:
            blob = payload
        offset += 8 + length + ((-length) % 4)
    return doc, blob


def read_accessor(doc, blob, index):
    accessor = doc["accessors"][index]
    view = doc["bufferViews"][accessor["bufferView"]]
    count = accessor["count"]
    n = TYPE_COUNT[accessor["type"]]
    dtype = np.dtype(COMPONENT_DTYPE[accessor["componentType"]])
    start = view.get("byteOffset", 0) + accessor.get("byteOffset", 0)
    raw = np.frombuffer(blob, dtype=dtype, count=count * n, offset=start)
    return raw.reshape(count, n) if n > 1 else raw


def main() -> int:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    for flag in ("--size", "--textures"):
        if flag in sys.argv:
            value = sys.argv[sys.argv.index(flag) + 1]
            if value in args:
                args.remove(value)
    if len(args) < 2:
        print(__doc__)
        return 2
    src, dst = args[0], args[1]
    size = int(sys.argv[sys.argv.index("--size") + 1]) if "--size" in sys.argv else 420
    tex_root = (sys.argv[sys.argv.index("--textures") + 1]
                if "--textures" in sys.argv else None)

    from PIL import Image

    doc, blob = load_glb(src)
    if not doc.get("meshes"):
        print("no mesh in file")
        return 1

    colour = np.zeros((size, size, 3), dtype=np.float32)
    depth = np.full((size, size), np.inf, dtype=np.float32)

    # Gather every primitive first so the view fits the whole model.
    prims = []
    for primitive in doc["meshes"][0]["primitives"]:
        pos = read_accessor(doc, blob, primitive["attributes"]["POSITION"]).astype(np.float32)
        idx = read_accessor(doc, blob, primitive["indices"]).astype(np.int64)
        uv = None
        if "TEXCOORD_0" in primitive["attributes"]:
            uv = read_accessor(doc, blob, primitive["attributes"]["TEXCOORD_0"]).astype(np.float32)
        nrm = None
        if "NORMAL" in primitive["attributes"]:
            nrm = read_accessor(doc, blob, primitive["attributes"]["NORMAL"]).astype(np.float32)

        image = None
        mat_index = primitive.get("material")
        if tex_root is not None and mat_index is not None:
            material = doc["materials"][mat_index]
            info = material.get("pbrMetallicRoughness", {}).get("baseColorTexture")
            if info:
                uri = doc["images"][doc["textures"][info["index"]]["source"]]["uri"]
                full = os.path.join(tex_root, uri)
                if os.path.exists(full):
                    image = np.asarray(Image.open(full).convert("RGB"),
                                       dtype=np.float32) / 255.0
        prims.append((pos, idx, uv, nrm, image))

    everything = np.concatenate([p[0] for p in prims], axis=0)
    # MDX is Z-up; view it from the front with Z as screen-up.
    lo, hi = everything.min(axis=0), everything.max(axis=0)
    centre = (lo + hi) / 2.0
    extent = float(np.max(hi - lo)) or 1.0
    scale = size * 0.85 / extent

    light = np.array([0.4, -0.7, 0.6], dtype=np.float32)
    light /= np.linalg.norm(light)

    for pos, idx, uv, nrm, image in prims:
        local = (pos - centre) * scale
        sx = local[:, 0] + size / 2.0
        sy = size / 2.0 - local[:, 2]      # Z up on screen
        sz = local[:, 1]                   # Y is depth
        tris = idx.reshape(-1, 3)

        for tri in tris:
            x = sx[tri]
            y = sy[tri]
            z = sz[tri]
            x0, x1 = int(max(0, np.floor(x.min()))), int(min(size - 1, np.ceil(x.max())))
            y0, y1 = int(max(0, np.floor(y.min()))), int(min(size - 1, np.ceil(y.max())))
            if x1 < x0 or y1 < y0:
                continue

            px, py = np.meshgrid(np.arange(x0, x1 + 1), np.arange(y0, y1 + 1))
            px = px + 0.5
            py = py + 0.5
            denom = ((y[1] - y[2]) * (x[0] - x[2]) + (x[2] - x[1]) * (y[0] - y[2]))
            if abs(denom) < 1e-9:
                continue
            w0 = ((y[1] - y[2]) * (px - x[2]) + (x[2] - x[1]) * (py - y[2])) / denom
            w1 = ((y[2] - y[0]) * (px - x[2]) + (x[0] - x[2]) * (py - y[2])) / denom
            w2 = 1.0 - w0 - w1
            inside = (w0 >= 0) & (w1 >= 0) & (w2 >= 0)
            if not inside.any():
                continue

            zz = w0 * z[0] + w1 * z[1] + w2 * z[2]
            ys, xs = np.nonzero(inside)
            gy = ys + y0
            gx = xs + x0
            zv = zz[inside]
            closer = zv < depth[gy, gx]
            if not closer.any():
                continue
            gy, gx, zv = gy[closer], gx[closer], zv[closer]

            if image is not None and uv is not None:
                u = (w0 * uv[tri[0], 0] + w1 * uv[tri[1], 0] + w2 * uv[tri[2], 0])[inside][closer]
                v = (w0 * uv[tri[0], 1] + w1 * uv[tri[1], 1] + w2 * uv[tri[2], 1])[inside][closer]
                th, tw = image.shape[:2]
                tx = np.clip((u % 1.0) * (tw - 1), 0, tw - 1).astype(np.int32)
                ty = np.clip((v % 1.0) * (th - 1), 0, th - 1).astype(np.int32)
                base = image[ty, tx]
            else:
                base = np.full((len(gy), 3), 0.72, dtype=np.float32)

            if nrm is not None:
                face_n = nrm[tri].mean(axis=0)
                norm = np.linalg.norm(face_n)
                shade = 0.45 + 0.55 * abs(float(face_n @ light) / norm) if norm else 0.8
            else:
                shade = 0.8
            depth[gy, gx] = zv
            colour[gy, gx] = np.clip(base * shade, 0, 1)

    out = (colour * 255).astype(np.uint8)
    Image.fromarray(out).save(dst)
    print(f"rendered {os.path.basename(src)} -> {dst}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
