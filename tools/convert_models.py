#!/usr/bin/env python3
"""Convert Warcraft III MDX v800 models to glTF 2.0 (.glb).

Usage:
    python3 tools/convert_models.py <extracted-dir> <output-dir> [options]

Options:
    --textures DIR      converted-texture root, used to resolve image URIs
    --manifest FILE     write a JSON conversion report
    --no-animations     geometry only (much smaller, useful for doodads)
    --limit N           convert only the first N models (for quick checks)

Mapping notes
    Axes      MDX is Z-up, glTF is Y-up. Rather than rewriting every vertex
              and quaternion, a single root node carries a -90 degrees X
              rotation, so the data stays in its original space.
    Pivots    An MDX node's transform is relative to its pivot point, so the
              glTF node translation is (pivot - parent pivot) and animated
              translations add on top of that.
    Skinning  MDX puts each vertex in a "matrix group" listing the bones that
              drive it, all with equal influence. That becomes JOINTS_0 and
              WEIGHTS_0, capped at glTF's four influences per vertex.
    Blending  glTF has no additive blend, so the original MDX filter mode is
              preserved in material extras for the engine to honour.
"""

from __future__ import annotations

import json
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from tools.wc3.gltf import (  # noqa: E402
    ARRAY_BUFFER, ELEMENT_ARRAY_BUFFER, FLOAT, UNSIGNED_INT, UNSIGNED_SHORT,
    GLTFBuilder,
)
from tools.wc3.mdx import MDXError, parse_mdx  # noqa: E402

# -90 degrees about X, taking Z-up into Y-up.
ZUP_TO_YUP = [-math.sqrt(0.5), 0.0, 0.0, math.sqrt(0.5)]

MAX_INFLUENCES = 4

FILTER_NAMES = {
    0: "none", 1: "transparent", 2: "blend",
    3: "additive", 4: "addalpha", 5: "modulate", 6: "modulate2x",
}
# Filter modes that must not write depth / are order-dependent at runtime.
FILTER_ALPHA_MODE = {
    0: "OPAQUE", 1: "MASK", 2: "BLEND",
    3: "BLEND", 4: "BLEND", 5: "BLEND", 6: "BLEND",
}

TEXTURE_EXTS = (".webp", ".jpg", ".png")

# Directory roots that live in the retail War3.mpq / War3x.mpq rather than in
# the map. Referencing them is normal - the map only imports its custom art -
# but the engine must source them from a WC3 install at load time.
STOCK_ROOTS = (
    "buildings/", "units/", "doodads/", "abilities/", "environment/",
    "objects/", "replaceabletextures/", "textures/", "terrainart/",
    "cliffs/", "ui/",
)


def is_stock_texture(path: str) -> bool:
    normalised = path.replace("\\", "/").lower().lstrip("/")
    return normalised.startswith(STOCK_ROOTS)


def opt(name: str, default=None):
    return sys.argv[sys.argv.index(name) + 1] if name in sys.argv else default


def build_texture_index(texture_root: str) -> dict:
    """Map a lower-cased WC3 texture path (no extension) to its output file."""
    index = {}
    if not texture_root or not os.path.isdir(texture_root):
        return index
    for dirpath, _, filenames in os.walk(texture_root):
        for filename in filenames:
            stem, ext = os.path.splitext(filename)
            if ext.lower() not in TEXTURE_EXTS:
                continue
            full = os.path.join(dirpath, filename)
            rel = os.path.relpath(full, texture_root).replace(os.sep, "/")
            key = os.path.splitext(rel)[0].lower()
            index[key] = rel
    return index


def resolve_texture(path: str, index: dict) -> str:
    """Turn an MDX texture reference into a converted-asset relative path."""
    normalised = path.replace("\\", "/").strip()
    key = os.path.splitext(normalised)[0].lower()
    if key in index:
        return index[key]
    # Models often reference a texture by basename only.
    base = key.rsplit("/", 1)[-1]
    for candidate_key, value in index.items():
        if candidate_key.rsplit("/", 1)[-1] == base:
            return value
    return ""


def sample_track(track, frame: int):
    """Value of a track at an arbitrary frame, with linear interpolation."""
    keys = track.keys
    if not keys:
        return None
    if frame <= keys[0][0]:
        return keys[0][1]
    if frame >= keys[-1][0]:
        return keys[-1][1]
    for i in range(1, len(keys)):
        f1, v1 = keys[i]
        if f1 >= frame:
            f0, v0 = keys[i - 1]
            span = f1 - f0
            t = 0.0 if span == 0 else (frame - f0) / span
            return tuple(a + (b - a) * t for a, b in zip(v0, v1))
    return keys[-1][1]


def normalise_quat(q):
    length = math.sqrt(sum(component * component for component in q))
    if length == 0:
        return (0.0, 0.0, 0.0, 1.0)
    return tuple(component / length for component in q)


def convert_model(data: bytes, texture_index: dict, name: str,
                  with_animations: bool = True) -> tuple:
    model = parse_mdx(data)
    gltf = GLTFBuilder()
    report = {
        "geosets": len(model.geosets),
        "bones": len(model.bones),
        "sequences": len(model.sequences),
        "triangles": sum(len(g.faces) for g in model.geosets),
        "vertices": sum(len(g.vertices) for g in model.geosets),
        "missingTextures": [],
        "stockTextures": [],
        "undecoded": {k: v for k, v in model.unsupported.items()
                      if not k.startswith("_")},
    }

    # -- materials ----------------------------------------------------------
    sampler_cache = {}
    material_map = {}
    for index, material in enumerate(model.materials):
        layer = material.layers[0] if material.layers else None
        entry: dict = {
            "name": f"mat{index}",
            "doubleSided": bool(layer and layer.two_sided),
            "pbrMetallicRoughness": {
                "baseColorFactor": [1.0, 1.0, 1.0, layer.alpha if layer else 1.0],
                "metallicFactor": 0.0,
                "roughnessFactor": 1.0,
            },
            "extras": {},
        }
        if layer:
            entry["alphaMode"] = FILTER_ALPHA_MODE.get(layer.filter_mode, "OPAQUE")
            if entry["alphaMode"] == "MASK":
                entry["alphaCutoff"] = 0.5
            entry["extras"]["filterMode"] = FILTER_NAMES.get(
                layer.filter_mode, str(layer.filter_mode))
            entry["extras"]["unshaded"] = layer.unshaded
            if layer.unshaded:
                entry["extensions"] = {"KHR_materials_unlit": {}}

            if 0 <= layer.texture_id < len(model.textures):
                texture = model.textures[layer.texture_id]
                if texture.replaceable_id:
                    # 1 = team colour, 2 = team glow; resolved at runtime.
                    entry["extras"]["replaceableId"] = texture.replaceable_id
                else:
                    uri = resolve_texture(texture.path, texture_index)
                    if uri:
                        wrap_s = 10497 if texture.wrap_width else 33071
                        wrap_t = 10497 if texture.wrap_height else 33071
                        key = (wrap_s, wrap_t)
                        if key not in sampler_cache:
                            sampler_cache[key] = gltf.add_sampler(wrap_s, wrap_t)
                        image = gltf.add_image_uri(uri)
                        tex = gltf.add_texture(image, sampler_cache[key])
                        entry["pbrMetallicRoughness"]["baseColorTexture"] = {
                            "index": tex}
                    elif texture.path:
                        bucket = ("stockTextures" if is_stock_texture(texture.path)
                                  else "missingTextures")
                        report[bucket].append(texture.path)
        material_map[index] = gltf.add_material(entry)

    # -- node hierarchy -----------------------------------------------------
    # MDX object ids are dense; map them to glTF node indices.
    id_to_gltf = {}
    node_defs = []
    for node in model.nodes:
        parent = None
        if node.parent_id >= 0:
            parent = next((n for n in model.nodes
                           if n.object_id == node.parent_id), None)
        px, py, pz = node.pivot
        if parent:
            qx, qy, qz = parent.pivot
            translation = [px - qx, py - qy, pz - qz]
        else:
            translation = [px, py, pz]
        definition = {"name": node.name or f"node{node.object_id}"}
        if any(abs(v) > 1e-9 for v in translation):
            definition["translation"] = translation
        node_defs.append(definition)
        id_to_gltf[node.object_id] = len(node_defs) - 1

    for node in model.nodes:
        if node.parent_id in id_to_gltf:
            parent_def = node_defs[id_to_gltf[node.parent_id]]
            parent_def.setdefault("children", []).append(id_to_gltf[node.object_id])

    # -- geometry -----------------------------------------------------------
    joint_order = [n.object_id for n in model.nodes]
    joint_slot = {oid: i for i, oid in enumerate(joint_order)}

    primitives = []
    for geoset in model.geosets:
        vertex_count = len(geoset.vertices)
        if vertex_count == 0 or not geoset.faces:
            continue

        positions = [c for v in geoset.vertices for c in v]
        normals = [c for v in geoset.normals for c in v] if geoset.normals else None
        uvs = None
        if geoset.uvs and len(geoset.uvs[0]) == vertex_count:
            uvs = [c for uv in geoset.uvs[0] for c in uv]

        joints = []
        weights = []
        for i in range(vertex_count):
            bones = geoset.bones_for_vertex(i)[:MAX_INFLUENCES]
            slots = [joint_slot.get(b, 0) for b in bones]
            share = 1.0 / len(slots) if slots else 0.0
            values = [share] * len(slots)
            while len(slots) < MAX_INFLUENCES:
                slots.append(0)
                values.append(0.0)
            if not bones:
                values[0] = 1.0
            joints.extend(slots)
            weights.extend(values)

        attributes = {
            "POSITION": gltf.add_accessor(positions, "VEC3", FLOAT,
                                          ARRAY_BUFFER, minmax=True)
        }
        if normals and len(normals) == len(positions):
            attributes["NORMAL"] = gltf.add_accessor(normals, "VEC3", FLOAT,
                                                     ARRAY_BUFFER)
        if uvs:
            attributes["TEXCOORD_0"] = gltf.add_accessor(uvs, "VEC2", FLOAT,
                                                         ARRAY_BUFFER)
        if joint_order:
            attributes["JOINTS_0"] = gltf.add_accessor(
                joints, "VEC4", UNSIGNED_SHORT, ARRAY_BUFFER)
            attributes["WEIGHTS_0"] = gltf.add_accessor(
                weights, "VEC4", FLOAT, ARRAY_BUFFER)

        flat_indices = [i for face in geoset.faces for i in face]
        component = UNSIGNED_SHORT if vertex_count <= 65535 else UNSIGNED_INT
        index_accessor = gltf.add_accessor(flat_indices, "SCALAR", component,
                                           ELEMENT_ARRAY_BUFFER)

        primitive = {"attributes": attributes, "indices": index_accessor, "mode": 4}
        if geoset.material_id in material_map:
            primitive["material"] = material_map[geoset.material_id]
        primitives.append(primitive)

    roots = [i for i, node in enumerate(model.nodes) if node.parent_id < 0]
    scene_children = list(roots)

    mesh_node = None
    if primitives:
        mesh_index = gltf.add_mesh({"name": model.name or name,
                                    "primitives": primitives})
        mesh_node = {"name": "mesh", "mesh": mesh_index}

        if joint_order:
            # Bind pose is pure translation by pivot, so the inverse bind
            # matrix is just a translation by the negated pivot.
            ibm = []
            for oid in joint_order:
                node = next(n for n in model.nodes if n.object_id == oid)
                px, py, pz = node.pivot
                ibm.extend([1.0, 0.0, 0.0, 0.0,
                            0.0, 1.0, 0.0, 0.0,
                            0.0, 0.0, 1.0, 0.0,
                            -px, -py, -pz, 1.0])
            ibm_accessor = gltf.add_accessor(ibm, "MAT4", FLOAT)
            skin = gltf.add_skin({
                "inverseBindMatrices": ibm_accessor,
                "joints": [id_to_gltf[o] for o in joint_order],
            })
            mesh_node["skin"] = skin

    # Register nodes now that indices are final.
    for definition in node_defs:
        gltf.add_node(definition)
    if mesh_node:
        scene_children.append(gltf.add_node(mesh_node))

    root_index = gltf.add_node({
        "name": model.name or name,
        "rotation": ZUP_TO_YUP,
        "children": scene_children,
    })
    gltf.set_scene_roots([root_index])

    # -- animations ---------------------------------------------------------
    if with_animations and model.sequences:
        for sequence in model.sequences:
            channels = []
            samplers = []
            duration = max(1, sequence.duration_ms)

            for node in model.nodes:
                gltf_index = id_to_gltf[node.object_id]
                parent = None
                if node.parent_id >= 0:
                    parent = next((n for n in model.nodes
                                   if n.object_id == node.parent_id), None)
                base = node.pivot
                if parent:
                    base = tuple(a - b for a, b in zip(node.pivot, parent.pivot))

                for tag, path in (("KGTR", "translation"),
                                  ("KGRT", "rotation"),
                                  ("KGSC", "scale")):
                    track = node.tracks.get(tag)
                    if not track or not track.keys:
                        continue

                    frames = sorted({f for f, _ in track.keys
                                     if sequence.start <= f <= sequence.end}
                                    | {sequence.start, sequence.end})
                    if len(frames) < 2:
                        continue

                    samples = []
                    for frame in frames:
                        value = sample_track(track, frame)
                        if path == "translation":
                            samples.append(tuple(base[i] + value[i] for i in range(3)))
                        elif path == "rotation":
                            samples.append(normalise_quat(value))
                        else:
                            samples.append(tuple(value[:3]))

                    # Most sequences only animate a handful of bones. Dropping
                    # channels that never leave the rest pose, and collapsing
                    # constant ones to two keys, cuts the bulk of the output.
                    rest = {"translation": tuple(base),
                            "rotation": (0.0, 0.0, 0.0, 1.0),
                            "scale": (1.0, 1.0, 1.0)}[path]
                    constant = all(
                        all(abs(a - b) < 1e-5 for a, b in zip(s, samples[0]))
                        for s in samples)
                    if constant:
                        if all(abs(a - b) < 1e-5 for a, b in zip(samples[0], rest)):
                            continue
                        frames = [frames[0], frames[-1]]
                        samples = [samples[0], samples[-1]]

                    times = [(f - sequence.start) / 1000.0 for f in frames]
                    values = [c for s in samples for c in s]

                    time_accessor = gltf.add_accessor(times, "SCALAR", FLOAT)
                    kind = "VEC4" if path == "rotation" else "VEC3"
                    value_accessor = gltf.add_accessor(values, kind, FLOAT)
                    samplers.append({
                        "input": time_accessor,
                        "output": value_accessor,
                        "interpolation": "LINEAR"
                        if track.interpolation != 0 else "STEP",
                    })
                    channels.append({
                        "sampler": len(samplers) - 1,
                        "target": {"node": gltf_index, "path": path},
                    })

            if channels:
                gltf.add_animation({
                    "name": sequence.name or f"seq{len(gltf.json.get('animations', []))}",
                    "channels": channels,
                    "samplers": samplers,
                    "extras": {
                        "durationMs": duration,
                        "looping": not sequence.non_looping,
                        "moveSpeed": sequence.move_speed,
                        "rarity": sequence.rarity,
                    },
                })

    if any(m.get("extensions", {}).get("KHR_materials_unlit") is not None
           for m in gltf.json["materials"]):
        gltf.json["extensionsUsed"] = ["KHR_materials_unlit"]

    report["animations"] = len(gltf.json.get("animations", []))
    return gltf.to_glb(), report


def main() -> int:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    for flag in ("--textures", "--manifest", "--limit"):
        value = opt(flag)
        if value in args:
            args.remove(value)
    if len(args) < 2:
        print(__doc__)
        return 2

    root, out_dir = args[0], args[1]
    texture_root = opt("--textures")
    manifest_path = opt("--manifest")
    limit = int(opt("--limit", 0) or 0)
    with_animations = "--no-animations" not in sys.argv

    texture_index = build_texture_index(texture_root)
    print(f"texture index: {len(texture_index)} entries")

    sources = []
    for dirpath, _, filenames in os.walk(root):
        for filename in filenames:
            if filename.lower().endswith(".mdx"):
                sources.append(os.path.join(dirpath, filename))
    sources.sort()
    if limit:
        sources = sources[:limit]

    records = []
    failures = []
    missing = set()
    stock = set()
    total_in = total_out = 0

    for path in sources:
        rel = os.path.relpath(path, root)
        try:
            with open(path, "rb") as handle:
                data = handle.read()
            glb, report = convert_model(
                data, texture_index, os.path.basename(rel), with_animations)
        except (MDXError, Exception) as exc:  # noqa: BLE001 - report, continue
            failures.append({"file": rel, "error": f"{type(exc).__name__}: {exc}"})
            print(f"  FAIL {rel}: {type(exc).__name__}: {exc}")
            continue

        dest = os.path.join(out_dir, os.path.splitext(rel)[0] + ".glb")
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        with open(dest, "wb") as handle:
            handle.write(glb)

        missing.update(report.pop("missingTextures", []))
        stock.update(report.pop("stockTextures", []))
        size_in, size_out = len(data), len(glb)
        total_in += size_in
        total_out += size_out
        records.append({
            "source": rel.replace(os.sep, "/"),
            "output": os.path.relpath(dest, out_dir).replace(os.sep, "/"),
            "bytesIn": size_in, "bytesOut": size_out, **report,
        })

    print(f"\nconverted {len(records)}/{len(sources)} models")
    if records:
        print(f"  triangles  : {sum(r['triangles'] for r in records):,}")
        print(f"  bones      : {sum(r['bones'] for r in records):,}")
        print(f"  animations : {sum(r['animations'] for r in records):,}")
        print(f"  bytes in   : {total_in:,}")
        print(f"  bytes out  : {total_out:,}")
    if stock:
        print(f"  stock WC3 textures referenced: {len(stock)} "
              f"(supplied by the game install, not the map)")
    if missing:
        print(f"  UNRESOLVED custom texture refs: {len(missing)}")
        for name in sorted(missing)[:8]:
            print(f"    {name}")
    if failures:
        print(f"  FAILURES   : {len(failures)}")

    if manifest_path:
        os.makedirs(os.path.dirname(manifest_path) or ".", exist_ok=True)
        with open(manifest_path, "w", encoding="utf-8") as handle:
            json.dump({"models": records, "failures": failures,
                       "unresolvedTextures": sorted(missing),
                       "stockTextures": sorted(stock)}, handle, indent=1)
        print(f"  manifest   : {manifest_path}")

    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
