"""Parsers for the individual data files inside a Warcraft III map archive.

Covers the formats needed to understand a map's content budget:
  war3map.w3i   map info (players, forces, loading screen)
  war3map.w3e   terrain tilepoints
  war3map.doo   doodad / destructable placement
  war3mapUnits.doo  unit & item placement
  war3map.w3u/.w3t/.w3b/.w3h  object data without level fields
  war3map.w3a/.w3d/.w3q       object data with level/variation fields
  war3map.wts   localised string table
  war3map.imp   imported file list
"""

from __future__ import annotations

import struct
from dataclasses import dataclass, field
from typing import Any, Optional


class ParseError(Exception):
    pass


def _decode(raw: bytes) -> str:
    """WC3 strings are usually UTF-8 but older editors emit cp1251/cp1252."""
    for encoding in ("utf-8", "cp1251"):
        try:
            return raw.decode(encoding)
        except UnicodeDecodeError:
            continue
    return raw.decode("latin-1", errors="replace")


class Reader:
    """Little-endian cursor over a bytes buffer."""

    __slots__ = ("data", "pos")

    def __init__(self, data: bytes, pos: int = 0) -> None:
        self.data = data
        self.pos = pos

    def __len__(self) -> int:
        return len(self.data)

    @property
    def remaining(self) -> int:
        return len(self.data) - self.pos

    def bytes(self, n: int) -> bytes:
        if self.pos + n > len(self.data):
            raise ParseError(f"read past end ({n} bytes at {self.pos})")
        out = self.data[self.pos:self.pos + n]
        self.pos += n
        return out

    def int32(self) -> int:
        return struct.unpack_from("<i", self.data, self._advance(4))[0]

    def uint32(self) -> int:
        return struct.unpack_from("<I", self.data, self._advance(4))[0]

    def float32(self) -> float:
        return struct.unpack_from("<f", self.data, self._advance(4))[0]

    def uint8(self) -> int:
        return self.data[self._advance(1)]

    def _advance(self, n: int) -> int:
        if self.pos + n > len(self.data):
            raise ParseError(f"read past end ({n} bytes at {self.pos})")
        pos = self.pos
        self.pos += n
        return pos

    def fourcc(self) -> str:
        return self.bytes(4).decode("latin-1")

    def cstring(self) -> str:
        end = self.data.find(b"\x00", self.pos)
        if end < 0:
            raise ParseError(f"unterminated string at {self.pos}")
        raw = self.data[self.pos:end]
        self.pos = end + 1
        return _decode(raw)


# --------------------------------------------------------------------------
# war3map.w3i - map info
# --------------------------------------------------------------------------
@dataclass
class Player:
    index: int
    type: int
    race: int
    name: str
    start_x: float
    start_y: float


@dataclass
class Force:
    flags: int
    player_mask: int
    name: str


@dataclass
class MapInfo:
    version: int
    map_version: int
    editor_version: int
    name: str = ""
    author: str = ""
    description: str = ""
    players_recommended: str = ""
    playable_width: int = 0
    playable_height: int = 0
    flags: int = 0
    tileset: str = ""
    players: list = field(default_factory=list)
    forces: list = field(default_factory=list)
    upgrade_mods: int = 0
    tech_mods: int = 0
    random_unit_tables: int = 0
    random_item_tables: int = 0


PLAYER_TYPES = {1: "human", 2: "computer", 3: "neutral", 4: "rescuable"}
RACES = {1: "human", 2: "orc", 3: "undead", 4: "nightelf"}


def parse_w3i(data: bytes) -> MapInfo:
    r = Reader(data)
    version = r.int32()
    info = MapInfo(version=version, map_version=r.int32(), editor_version=r.int32())
    info.name = r.cstring()
    info.author = r.cstring()
    info.description = r.cstring()
    info.players_recommended = r.cstring()

    r.bytes(32)   # camera bounds (8 floats)
    r.bytes(16)   # camera bounds complements (4 ints)
    info.playable_width = r.int32()
    info.playable_height = r.int32()
    info.flags = r.uint32()
    info.tileset = chr(r.uint8())

    r.int32()          # loading screen preset
    r.cstring()        # custom loading screen model
    r.cstring()        # loading screen text
    r.cstring()        # loading screen title
    r.cstring()        # loading screen subtitle
    r.int32()          # game data set
    r.cstring()        # prologue screen model
    r.cstring()        # prologue text
    r.cstring()        # prologue title
    r.cstring()        # prologue subtitle

    if version >= 18:  # TFT block
        r.int32()      # fog type
        r.float32()    # fog start
        r.float32()    # fog end
        r.float32()    # fog density
        r.bytes(4)     # fog colour
        r.int32()      # global weather
        r.cstring()    # sound environment
        r.uint8()      # light environment tileset
        r.bytes(4)     # water colour

    for _ in range(r.int32()):
        idx = r.int32()
        ptype = r.int32()
        race = r.int32()
        r.int32()      # fixed start position
        pname = r.cstring()
        sx, sy = r.float32(), r.float32()
        r.int32()      # ally low priority flags
        r.int32()      # ally high priority flags
        info.players.append(Player(idx, ptype, race, pname, sx, sy))

    for _ in range(r.int32()):
        info.forces.append(Force(r.uint32(), r.uint32(), r.cstring()))

    try:
        info.upgrade_mods = r.int32()
        for _ in range(info.upgrade_mods):
            r.bytes(4 + 4 + 4 + 4)          # player flags, id, level, availability
        info.tech_mods = r.int32()
        for _ in range(info.tech_mods):
            r.bytes(4 + 4)                  # player flags, id
        info.random_unit_tables = r.int32()
        info.random_item_tables = 0
    except ParseError:
        pass
    return info


# --------------------------------------------------------------------------
# Placement files (.doo)
# --------------------------------------------------------------------------
@dataclass
class Doodad:
    type_id: str
    variation: int
    x: float
    y: float
    z: float
    rotation: float
    scale: tuple
    flags: int
    life: int


@dataclass
class DoodadFile:
    version: int
    subversion: int
    doodads: list
    special_doodads: int


def parse_doo(data: bytes) -> DoodadFile:
    r = Reader(data)
    magic = r.fourcc()
    if magic != "W3do":
        raise ParseError(f"expected W3do, got {magic!r}")
    version = r.int32()
    subversion = r.int32()
    count = r.int32()

    doodads = []
    for _ in range(count):
        type_id = r.fourcc()
        variation = r.int32()
        x, y, z = r.float32(), r.float32(), r.float32()
        rotation = r.float32()
        sx, sy, sz = r.float32(), r.float32(), r.float32()
        flags = r.uint8()
        life = r.uint8()
        if version >= 8:
            r.int32()                       # item table pointer
            for _ in range(r.int32()):      # dropped item sets
                for _ in range(r.int32()):
                    r.bytes(8)              # item id + chance
        r.int32()                           # editor id
        doodads.append(Doodad(type_id, variation, x, y, z, rotation,
                              (sx, sy, sz), flags, life))

    special = 0
    if r.remaining >= 8:
        r.int32()                           # special doodad format version
        special = r.int32()
    return DoodadFile(version, subversion, doodads, special)


@dataclass
class Unit:
    type_id: str
    variation: int
    x: float
    y: float
    z: float
    rotation: float
    scale: tuple
    player: int
    hitpoints: int
    mana: int
    gold: int
    hero_level: int
    inventory: list
    abilities: list


@dataclass
class UnitFile:
    version: int
    subversion: int
    units: list


def parse_units_doo(data: bytes) -> UnitFile:
    r = Reader(data)
    magic = r.fourcc()
    if magic != "W3do":
        raise ParseError(f"expected W3do, got {magic!r}")
    version = r.int32()
    subversion = r.int32()
    count = r.int32()

    units = []
    for _ in range(count):
        type_id = r.fourcc()
        variation = r.int32()
        x, y, z = r.float32(), r.float32(), r.float32()
        rotation = r.float32()
        sx, sy, sz = r.float32(), r.float32(), r.float32()
        r.uint8()                           # flags
        player = r.int32()
        r.uint8()                           # unknown
        r.uint8()                           # unknown
        hitpoints = r.int32()
        mana = r.int32()
        if version >= 8:
            r.int32()                       # item table pointer
        for _ in range(r.int32()):          # dropped item sets
            for _ in range(r.int32()):
                r.bytes(8)
        gold = r.int32()
        r.float32()                         # target acquisition range
        hero_level = r.int32()
        if version >= 8:
            r.int32(); r.int32(); r.int32()  # hero str/agi/int

        inventory = []
        for _ in range(r.int32()):
            slot = r.int32()
            inventory.append((slot, r.fourcc()))

        abilities = []
        for _ in range(r.int32()):
            abil = r.fourcc()
            active = r.int32()
            level = r.int32()
            abilities.append((abil, active, level))

        # Random-unit block is variable length, keyed by the leading flag.
        random_flag = r.int32()
        if random_flag == 0:
            r.bytes(4)                      # 3-byte level + 1-byte item class
        elif random_flag == 1:
            r.bytes(8)                      # unit group + column index
        elif random_flag == 2:
            for _ in range(r.int32()):      # explicit table of id/chance pairs
                r.bytes(8)
        else:
            raise ParseError(f"unknown random-unit flag {random_flag}")

        r.int32()                           # custom colour
        r.int32()                           # waygate
        r.int32()                           # editor id
        units.append(Unit(type_id, variation, x, y, z, rotation, (sx, sy, sz),
                          player, hitpoints, mana, gold, hero_level,
                          inventory, abilities))
    return UnitFile(version, subversion, units)


# --------------------------------------------------------------------------
# Object data (.w3u .w3t .w3b .w3h / .w3a .w3d .w3q)
# --------------------------------------------------------------------------
@dataclass
class ObjectMod:
    mod_id: str
    var_type: int
    level: int
    data_pointer: int
    value: Any


@dataclass
class ObjectDef:
    base_id: str
    new_id: str
    mods: list

    @property
    def is_custom(self) -> bool:
        return self.new_id != "\0\0\0\0" and self.new_id.strip("\x00") != ""


@dataclass
class ObjectData:
    version: int
    original: list
    custom: list

    @property
    def total_mods(self) -> int:
        return (sum(len(o.mods) for o in self.original) +
                sum(len(o.mods) for o in self.custom))


# Extensions whose modifications carry a level / variation field.
LEVELLED_EXTS = {"w3a", "w3d", "w3q"}


def parse_object_data(data: bytes, ext: str) -> ObjectData:
    """Parse an object-data file. `ext` selects the level-field variant."""
    ext = ext.lower().lstrip(".")
    levelled = ext in LEVELLED_EXTS
    r = Reader(data)
    version = r.int32()

    def read_table() -> list:
        objects = []
        for _ in range(r.int32()):
            base_id = r.fourcc()
            new_id = r.fourcc()
            if version >= 3:
                # Reforged-era format nests modifications inside sets.
                mods = []
                for _ in range(r.int32()):
                    r.int32()               # set flags
                    mods.extend(read_mods())
            else:
                mods = read_mods()
            objects.append(ObjectDef(base_id, new_id, mods))
        return objects

    def read_mods() -> list:
        mods = []
        for _ in range(r.int32()):
            mod_id = r.fourcc()
            var_type = r.int32()
            level = data_ptr = 0
            if levelled:
                level = r.int32()
                data_ptr = r.int32()
            if var_type == 0:
                value: Any = r.int32()
            elif var_type in (1, 2):
                value = r.float32()
            elif var_type == 3:
                value = r.cstring()
            else:
                raise ParseError(f"unknown variable type {var_type}")
            r.bytes(4)                      # end-of-modification marker
            mods.append(ObjectMod(mod_id, var_type, level, data_ptr, value))
        return mods

    original = read_table()
    custom = read_table()
    return ObjectData(version, original, custom)


# --------------------------------------------------------------------------
# war3map.wts - localised strings
# --------------------------------------------------------------------------
def parse_wts(data: bytes) -> dict:
    """Return {id: text} from the trigger-string table."""
    text = _decode(data.lstrip(b"\xef\xbb\xbf"))
    strings: dict = {}
    idx = 0
    while True:
        start = text.find("STRING ", idx)
        if start < 0:
            break
        line_end = text.find("\n", start)
        if line_end < 0:
            break
        try:
            key = int(text[start + 7:line_end].strip())
        except ValueError:
            idx = line_end + 1
            continue
        brace_open = text.find("{", line_end)
        brace_close = text.find("}", brace_open + 1)
        if brace_open < 0 or brace_close < 0:
            break
        strings[key] = text[brace_open + 1:brace_close].strip("\r\n")
        idx = brace_close + 1
    return strings


# --------------------------------------------------------------------------
# war3map.imp - imported file table
# --------------------------------------------------------------------------
def parse_imp(data: bytes) -> list:
    r = Reader(data)
    r.int32()                               # format version
    entries = []
    for _ in range(r.int32()):
        flag = r.uint8()
        path = r.cstring()
        entries.append((flag, path))
    return entries


# --------------------------------------------------------------------------
# war3map.w3e - terrain header only (tilepoints are bulk data)
# --------------------------------------------------------------------------
@dataclass
class TerrainInfo:
    version: int
    tileset: str
    ground_tilesets: list
    cliff_tilesets: list
    width: int
    height: int
    offset_x: float
    offset_y: float
    tilepoint_offset: int


def parse_w3e_header(data: bytes) -> TerrainInfo:
    r = Reader(data)
    magic = r.fourcc()
    if magic != "W3E!":
        raise ParseError(f"expected W3E!, got {magic!r}")
    version = r.int32()
    tileset = chr(r.uint8())
    r.int32()                               # custom tileset flag
    ground = [r.fourcc() for _ in range(r.int32())]
    cliff = [r.fourcc() for _ in range(r.int32())]
    width, height = r.int32(), r.int32()
    ox, oy = r.float32(), r.float32()
    return TerrainInfo(version, tileset, ground, cliff, width, height, ox, oy, r.pos)
