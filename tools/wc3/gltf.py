"""Minimal glTF 2.0 / GLB writer.

Just enough of the spec to emit skinned, animated meshes: a binary blob
builder plus accessor bookkeeping, then `to_glb()` to pack it all up.
Written by hand so the pipeline stays dependency-free apart from Pillow.
"""

from __future__ import annotations

import json
import struct
from typing import Optional

# Accessor component types
BYTE = 5120
UNSIGNED_BYTE = 5121
SHORT = 5122
UNSIGNED_SHORT = 5123
UNSIGNED_INT = 5125
FLOAT = 5126

# bufferView targets
ARRAY_BUFFER = 34962
ELEMENT_ARRAY_BUFFER = 34963

_COMPONENT_COUNT = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}
_STRUCT_CODE = {
    BYTE: "b", UNSIGNED_BYTE: "B", SHORT: "h", UNSIGNED_SHORT: "H",
    UNSIGNED_INT: "I", FLOAT: "f",
}


class GLTFBuilder:
    def __init__(self, generator: str = "WC3WeldAran pipeline") -> None:
        self.json: dict = {
            "asset": {"version": "2.0", "generator": generator},
            "scene": 0,
            "scenes": [{"nodes": []}],
            "nodes": [],
            "meshes": [],
            "materials": [],
            "textures": [],
            "images": [],
            "samplers": [],
            "accessors": [],
            "bufferViews": [],
        }
        self._blob = bytearray()

    # -- buffer plumbing ----------------------------------------------------
    def _align(self, boundary: int = 4) -> None:
        pad = (-len(self._blob)) % boundary
        if pad:
            self._blob.extend(b"\x00" * pad)

    def add_view(self, data: bytes, target: Optional[int] = None,
                 stride: Optional[int] = None) -> int:
        self._align()
        offset = len(self._blob)
        self._blob.extend(data)
        view = {"buffer": 0, "byteOffset": offset, "byteLength": len(data)}
        if target is not None:
            view["target"] = target
        if stride is not None:
            view["byteStride"] = stride
        self.json["bufferViews"].append(view)
        return len(self.json["bufferViews"]) - 1

    def add_accessor(self, values, kind: str, component: int,
                     target: Optional[int] = None, normalized: bool = False,
                     minmax: bool = False) -> int:
        """`values` is a flat sequence already in element order."""
        n = _COMPONENT_COUNT[kind]
        count = len(values) // n
        packed = struct.pack("<%d%s" % (len(values), _STRUCT_CODE[component]), *values)
        view = self.add_view(packed, target)
        accessor = {
            "bufferView": view,
            "componentType": component,
            "count": count,
            "type": kind,
        }
        if normalized:
            accessor["normalized"] = True
        if minmax and count:
            mins = [min(values[i::n]) for i in range(n)]
            maxs = [max(values[i::n]) for i in range(n)]
            accessor["min"] = list(mins)
            accessor["max"] = list(maxs)
        self.json["accessors"].append(accessor)
        return len(self.json["accessors"]) - 1

    # -- record helpers -----------------------------------------------------
    def add_node(self, node: dict) -> int:
        self.json["nodes"].append(node)
        return len(self.json["nodes"]) - 1

    def add_mesh(self, mesh: dict) -> int:
        self.json["meshes"].append(mesh)
        return len(self.json["meshes"]) - 1

    def add_material(self, material: dict) -> int:
        self.json["materials"].append(material)
        return len(self.json["materials"]) - 1

    def add_image_uri(self, uri: str) -> int:
        self.json["images"].append({"uri": uri})
        return len(self.json["images"]) - 1

    def add_sampler(self, wrap_s: int = 10497, wrap_t: int = 10497) -> int:
        sampler = {"wrapS": wrap_s, "wrapT": wrap_t,
                   "magFilter": 9729, "minFilter": 9987}
        for i, existing in enumerate(self.json["samplers"]):
            if existing == sampler:
                return i
        self.json["samplers"].append(sampler)
        return len(self.json["samplers"]) - 1

    def add_texture(self, source: int, sampler: int) -> int:
        entry = {"source": source, "sampler": sampler}
        for i, existing in enumerate(self.json["textures"]):
            if existing == entry:
                return i
        self.json["textures"].append(entry)
        return len(self.json["textures"]) - 1

    def add_skin(self, skin: dict) -> int:
        self.json.setdefault("skins", []).append(skin)
        return len(self.json["skins"]) - 1

    def add_animation(self, animation: dict) -> int:
        self.json.setdefault("animations", []).append(animation)
        return len(self.json["animations"]) - 1

    def set_scene_roots(self, roots: list) -> None:
        self.json["scenes"][0]["nodes"] = roots

    # -- output -------------------------------------------------------------
    def to_glb(self) -> bytes:
        self._align()
        blob = bytes(self._blob)
        self.json["buffers"] = [{"byteLength": len(blob)}]

        # Drop empty optional arrays: some loaders reject them.
        payload = {k: v for k, v in self.json.items()
                   if not (isinstance(v, list) and len(v) == 0)}

        json_bytes = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        json_bytes += b" " * ((-len(json_bytes)) % 4)
        bin_bytes = blob + b"\x00" * ((-len(blob)) % 4)

        total = 12 + 8 + len(json_bytes) + (8 + len(bin_bytes) if bin_bytes else 0)
        out = bytearray()
        out += struct.pack("<4sII", b"glTF", 2, total)
        out += struct.pack("<II", len(json_bytes), 0x4E4F534A)   # 'JSON'
        out += json_bytes
        if bin_bytes:
            out += struct.pack("<II", len(bin_bytes), 0x004E4942)  # 'BIN\0'
            out += bin_bytes
        return bytes(out)
