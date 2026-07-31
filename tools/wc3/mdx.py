"""Parser for MDX v800 models - the Warcraft III mesh/animation format.

MDX is a flat sequence of tagged chunks. This module reads the ones that carry
renderable content:

    VERS MODL SEQS GLBS TEXS MTLS GEOS GEOA BONE HELP ATCH PIVT CAMS

Particle and ribbon emitters (PREM, PRE2, RIBB) are recorded as raw blobs
rather than decoded: they have no glTF equivalent and belong in a sidecar
description instead.

Nodes (bones, helpers, attachments) share one object-id space and one pivot
table, so they are collected into a single list ordered by object id.
"""

from __future__ import annotations

import struct
from dataclasses import dataclass, field
from typing import Optional

MAGIC = b"MDLX"

# Node flag bits that identify what a node is.
NODE_BONE = 0x100
NODE_LIGHT = 0x200
NODE_OBJECT = 0x400
NODE_ATTACHMENT = 0x800
NODE_PARTICLE = 0x1000
NODE_COLLISION = 0x2000
NODE_RIBBON = 0x4000
NODE_BILLBOARDED = 0x8

# Interpolation types used by keyframe tracks.
INTERP_NONE = 0
INTERP_LINEAR = 1
INTERP_HERMITE = 2
INTERP_BEZIER = 3


class MDXError(Exception):
    pass


class _Cursor:
    __slots__ = ("data", "pos", "end")

    def __init__(self, data: bytes, pos: int = 0, end: Optional[int] = None) -> None:
        self.data = data
        self.pos = pos
        self.end = len(data) if end is None else end

    @property
    def remaining(self) -> int:
        return self.end - self.pos

    def tag(self) -> str:
        return self.raw(4).decode("latin-1")

    def raw(self, n: int) -> bytes:
        if self.pos + n > self.end:
            raise MDXError(f"read past chunk end ({n} bytes at {self.pos})")
        out = self.data[self.pos:self.pos + n]
        self.pos += n
        return out

    def u32(self) -> int:
        return struct.unpack_from("<I", self.data, self._adv(4))[0]

    def i32(self) -> int:
        return struct.unpack_from("<i", self.data, self._adv(4))[0]

    def f32(self) -> float:
        return struct.unpack_from("<f", self.data, self._adv(4))[0]

    def vec(self, n: int) -> tuple:
        return struct.unpack_from("<%df" % n, self.data, self._adv(4 * n))

    def _adv(self, n: int) -> int:
        if self.pos + n > self.end:
            raise MDXError(f"read past chunk end ({n} bytes at {self.pos})")
        pos = self.pos
        self.pos += n
        return pos

    def string(self, length: int) -> str:
        raw = self.raw(length)
        return raw.split(b"\x00", 1)[0].decode("utf-8", errors="replace")

    def peek_tag(self) -> str:
        if self.remaining < 4:
            return ""
        return self.data[self.pos:self.pos + 4].decode("latin-1")


# --------------------------------------------------------------------------
# Animation tracks
# --------------------------------------------------------------------------
@dataclass
class Track:
    """One animated property of a node, as a list of (frame, value) keys."""
    tag: str
    interpolation: int
    global_sequence: int
    keys: list = field(default_factory=list)   # [(frame, value_tuple)]

    @property
    def animated(self) -> bool:
        return len(self.keys) > 1


def _read_track(c: _Cursor, tag: str, components: int) -> Track:
    count = c.u32()
    interpolation = c.u32()
    global_sequence = c.i32()
    keys = []
    for _ in range(count):
        frame = c.i32()
        value = c.vec(components)
        if interpolation > INTERP_LINEAR:
            c.vec(components)   # in tangent
            c.vec(components)   # out tangent
        keys.append((frame, value))
    return Track(tag, interpolation, global_sequence, keys)


TRACK_COMPONENTS = {
    "KGTR": 3, "KGRT": 4, "KGSC": 3,      # node translation / rotation / scale
    "KMTA": 1, "KMTF": 1,                 # material alpha / texture id
    "KGAO": 1, "KGAC": 3,                 # geoset animation alpha / colour
    "KATV": 1,                            # attachment visibility
}


def _read_node(c: _Cursor) -> "Node":
    start = c.pos
    inclusive_size = c.u32()
    end = start + inclusive_size
    name = c.string(80)
    object_id = c.i32()
    parent_id = c.i32()
    flags = c.u32()

    tracks = {}
    while c.pos < end:
        tag = c.peek_tag()
        if tag not in TRACK_COMPONENTS:
            break
        c.tag()
        tracks[tag] = _read_track(c, tag, TRACK_COMPONENTS[tag])
    c.pos = end
    return Node(name, object_id, parent_id, flags, tracks)


@dataclass
class Node:
    name: str
    object_id: int
    parent_id: int
    flags: int
    tracks: dict = field(default_factory=dict)
    pivot: tuple = (0.0, 0.0, 0.0)
    kind: str = "helper"

    @property
    def is_bone(self) -> bool:
        return bool(self.flags & NODE_BONE)


# --------------------------------------------------------------------------
# Content records
# --------------------------------------------------------------------------
@dataclass
class Sequence:
    name: str
    start: int
    end: int
    move_speed: float
    flags: int
    rarity: float
    bounds_radius: float

    @property
    def non_looping(self) -> bool:
        return bool(self.flags & 1)

    @property
    def duration_ms(self) -> int:
        return max(0, self.end - self.start)


@dataclass
class Texture:
    replaceable_id: int
    path: str
    flags: int

    @property
    def wrap_width(self) -> bool:
        return bool(self.flags & 1)

    @property
    def wrap_height(self) -> bool:
        return bool(self.flags & 2)


@dataclass
class Layer:
    filter_mode: int
    shading_flags: int
    texture_id: int
    texture_anim_id: int
    coord_id: int
    alpha: float
    tracks: dict = field(default_factory=dict)

    @property
    def two_sided(self) -> bool:
        return bool(self.shading_flags & 0x10)

    @property
    def unshaded(self) -> bool:
        return bool(self.shading_flags & 0x1)


@dataclass
class Material:
    priority_plane: int
    flags: int
    layers: list = field(default_factory=list)


@dataclass
class Geoset:
    vertices: list
    normals: list
    faces: list
    vertex_groups: list         # per-vertex index into matrix_groups
    matrix_groups: list         # count of bone indices per group
    matrix_indices: list        # flat list of node object ids
    material_id: int
    selection_group: int
    selection_flags: int
    uvs: list                   # list of UV sets, each a list of (u, v)

    def bones_for_vertex(self, index: int) -> list:
        """Resolve a vertex's matrix group to the node object ids it uses."""
        group = self.vertex_groups[index] if index < len(self.vertex_groups) else 0
        if group >= len(self.matrix_groups):
            return []
        offset = sum(self.matrix_groups[:group])
        return self.matrix_indices[offset:offset + self.matrix_groups[group]]


@dataclass
class GeosetAnim:
    alpha: float
    flags: int
    color: tuple
    geoset_id: int
    tracks: dict = field(default_factory=dict)


@dataclass
class Model:
    name: str = ""
    version: int = 0
    bounds_radius: float = 0.0
    min_extent: tuple = (0.0, 0.0, 0.0)
    max_extent: tuple = (0.0, 0.0, 0.0)
    sequences: list = field(default_factory=list)
    global_sequences: list = field(default_factory=list)
    textures: list = field(default_factory=list)
    materials: list = field(default_factory=list)
    geosets: list = field(default_factory=list)
    geoset_anims: list = field(default_factory=list)
    nodes: list = field(default_factory=list)
    unsupported: dict = field(default_factory=dict)   # tag -> byte size

    @property
    def bones(self) -> list:
        return [n for n in self.nodes if n.is_bone]


# --------------------------------------------------------------------------
# Chunk parsers
# --------------------------------------------------------------------------
def _parse_seqs(c: _Cursor, end: int) -> list:
    out = []
    while c.pos < end:
        name = c.string(80)
        start, stop = c.u32(), c.u32()
        move_speed = c.f32()
        flags = c.u32()
        rarity = c.f32()
        c.u32()                       # sync point
        radius = c.f32()
        c.vec(3)                      # min extent
        c.vec(3)                      # max extent
        out.append(Sequence(name, start, stop, move_speed, flags, rarity, radius))
    return out


def _parse_texs(c: _Cursor, end: int) -> list:
    out = []
    while c.pos < end:
        replaceable = c.u32()
        path = c.string(260)
        flags = c.u32()
        out.append(Texture(replaceable, path, flags))
    return out


def _parse_mtls(c: _Cursor, end: int) -> list:
    out = []
    while c.pos < end:
        start = c.pos
        size = c.u32()
        stop = start + size
        priority = c.i32()
        flags = c.u32()
        layers = []
        if c.peek_tag() == "LAYS":
            c.tag()
            for _ in range(c.u32()):
                lstart = c.pos
                lsize = c.u32()
                lend = lstart + lsize
                filter_mode = c.u32()
                shading = c.u32()
                texture_id = c.i32()
                tex_anim = c.i32()
                coord_id = c.u32()
                alpha = c.f32()
                tracks = {}
                while c.pos < lend:
                    tag = c.peek_tag()
                    if tag not in TRACK_COMPONENTS:
                        break
                    c.tag()
                    tracks[tag] = _read_track(c, tag, TRACK_COMPONENTS[tag])
                c.pos = lend
                layers.append(Layer(filter_mode, shading, texture_id,
                                    tex_anim, coord_id, alpha, tracks))
        c.pos = stop
        out.append(Material(priority, flags, layers))
    return out


def _expect(c: _Cursor, tag: str) -> int:
    got = c.tag()
    if got != tag:
        raise MDXError(f"expected {tag}, found {got!r}")
    return c.u32()


def _parse_geos(c: _Cursor, end: int) -> list:
    out = []
    while c.pos < end:
        start = c.pos
        size = c.u32()
        stop = start + size

        n = _expect(c, "VRTX")
        vertices = [c.vec(3) for _ in range(n)]
        n = _expect(c, "NRMS")
        normals = [c.vec(3) for _ in range(n)]

        n = _expect(c, "PTYP")
        face_types = [c.u32() for _ in range(n)]
        n = _expect(c, "PCNT")
        face_counts = [c.u32() for _ in range(n)]
        n = _expect(c, "PVTX")
        indices = list(struct.unpack_from("<%dH" % n, c.data, c.pos))
        c.pos += n * 2

        faces = []
        offset = 0
        for ftype, fcount in zip(face_types, face_counts):
            chunk = indices[offset:offset + fcount]
            offset += fcount
            if ftype == 4:            # triangle list
                for i in range(0, len(chunk) - 2, 3):
                    faces.append((chunk[i], chunk[i + 1], chunk[i + 2]))
        if not face_types:
            for i in range(0, len(indices) - 2, 3):
                faces.append((indices[i], indices[i + 1], indices[i + 2]))

        n = _expect(c, "GNDX")
        vertex_groups = list(c.raw(n))
        n = _expect(c, "MTGC")
        matrix_groups = [c.u32() for _ in range(n)]
        n = _expect(c, "MATS")
        matrix_indices = [c.u32() for _ in range(n)]

        material_id = c.u32()
        selection_group = c.u32()
        selection_flags = c.u32()
        c.f32()                       # bounds radius
        c.vec(3)                      # min extent
        c.vec(3)                      # max extent
        for _ in range(c.u32()):      # per-sequence extents
            c.raw(28)

        uvs = []
        if c.peek_tag() == "UVAS":
            c.tag()
            for _ in range(c.u32()):
                m = _expect(c, "UVBS")
                uvs.append([c.vec(2) for _ in range(m)])

        c.pos = stop
        out.append(Geoset(vertices, normals, faces, vertex_groups, matrix_groups,
                          matrix_indices, material_id, selection_group,
                          selection_flags, uvs))
    return out


def _parse_geoa(c: _Cursor, end: int) -> list:
    out = []
    while c.pos < end:
        start = c.pos
        size = c.u32()
        stop = start + size
        alpha = c.f32()
        flags = c.u32()
        color = c.vec(3)
        geoset_id = c.i32()
        tracks = {}
        while c.pos < stop:
            tag = c.peek_tag()
            if tag not in TRACK_COMPONENTS:
                break
            c.tag()
            tracks[tag] = _read_track(c, tag, TRACK_COMPONENTS[tag])
        c.pos = stop
        out.append(GeosetAnim(alpha, flags, color, geoset_id, tracks))
    return out


def _parse_nodes(c: _Cursor, end: int, kind: str, trailing: int = 0) -> list:
    """Read a run of nodes. `trailing` skips per-kind fields after each node."""
    out = []
    while c.pos < end:
        node = _read_node(c)
        node.kind = kind
        out.append(node)
        if trailing:
            c.raw(trailing)
    return out


# Chunks we knowingly do not decode, with the reason kept close to the data.
SKIPPED = {
    "PREM": "particle emitter (no glTF equivalent)",
    "PRE2": "particle emitter 2 (no glTF equivalent)",
    "RIBB": "ribbon emitter (no glTF equivalent)",
    "EVTS": "event object",
    "CLID": "collision shape",
    "LITE": "light",
    "CAMS": "camera",
    "TXAN": "texture animation",
    "BPOS": "bind pose",
    "FAFX": "facial effects",
}


def parse_mdx(data: bytes) -> Model:
    if data[:4] != MAGIC:
        raise MDXError(f"not an MDX file (magic {data[:4]!r})")

    model = Model()
    c = _Cursor(data, 4)

    while c.remaining >= 8:
        tag = c.tag()
        size = c.u32()
        end = c.pos + size
        if end > len(data):
            raise MDXError(f"chunk {tag} overruns file")

        if tag == "VERS":
            model.version = c.u32()
        elif tag == "MODL":
            model.name = c.string(80)
            c.string(260)                       # animation file name
            model.bounds_radius = c.f32()
            model.min_extent = c.vec(3)
            model.max_extent = c.vec(3)
        elif tag == "SEQS":
            model.sequences = _parse_seqs(c, end)
        elif tag == "GLBS":
            model.global_sequences = [c.u32() for _ in range(size // 4)]
        elif tag == "TEXS":
            model.textures = _parse_texs(c, end)
        elif tag == "MTLS":
            model.materials = _parse_mtls(c, end)
        elif tag == "GEOS":
            model.geosets = _parse_geos(c, end)
        elif tag == "GEOA":
            model.geoset_anims = _parse_geoa(c, end)
        elif tag == "BONE":
            model.nodes += _parse_nodes(c, end, "bone", trailing=8)
        elif tag == "HELP":
            model.nodes += _parse_nodes(c, end, "helper")
        elif tag == "ATCH":
            # Attachments are the one node type wrapped in an outer size field:
            #   uint32 outerSize | Node (own size first) | char path[260] | int32 id
            # Trusting outerSize also skips any trailing visibility track.
            while c.pos < end:
                entry_start = c.pos
                outer_size = c.u32()
                node = _read_node(c)
                node.kind = "attachment"
                model.nodes.append(node)
                c.pos = entry_start + outer_size
        elif tag == "PIVT":
            pivots = [c.vec(3) for _ in range(size // 12)]
            for node in model.nodes:
                if 0 <= node.object_id < len(pivots):
                    node.pivot = pivots[node.object_id]
            model.unsupported.setdefault("_pivots", len(pivots))
        else:
            model.unsupported[tag] = size

        c.pos = end

    model.nodes.sort(key=lambda n: n.object_id)
    return model
