"""Reader for MoPaQ (MPQ) archives, the container format of Warcraft III maps.

Scope is deliberately read-only and targeted at WC3 1.26 map archives:
format v0/v1, hash+block tables, sector-based storage, and the compression
codecs Blizzard's map editor actually emits.

A `.w3x` file is a 512-byte `HM3W` header followed by an MPQ archive, so
`MPQArchive.open_map()` handles that offset for you.
"""

from __future__ import annotations

import bz2
import struct
import zlib
from dataclasses import dataclass
from typing import Iterator, Optional

from .explode import explode

# --- Block flags -----------------------------------------------------------
FLAG_IMPLODE = 0x00000100      # compressed with PKWARE DCL only
FLAG_COMPRESS = 0x00000200     # compressed, each sector carries a codec mask
FLAG_ENCRYPTED = 0x00010000
FLAG_FIX_KEY = 0x00020000      # key is adjusted by file position
FLAG_PATCH_FILE = 0x00100000
FLAG_SINGLE_UNIT = 0x01000000  # stored as one blob, not split into sectors
FLAG_DELETE_MARKER = 0x02000000
FLAG_SECTOR_CRC = 0x04000000
FLAG_EXISTS = 0x80000000

# --- Compression mask bits -------------------------------------------------
COMP_HUFFMAN = 0x01
COMP_ZLIB = 0x02
COMP_PKWARE = 0x08
COMP_BZIP2 = 0x10
COMP_SPARSE = 0x20
COMP_ADPCM_MONO = 0x40
COMP_ADPCM_STEREO = 0x80

HASH_ENTRY_EMPTY = 0xFFFFFFFF
HASH_ENTRY_DELETED = 0xFFFFFFFE


class MPQError(Exception):
    """Raised for malformed archives or unsupported archive features."""


def _build_crypt_table() -> list[int]:
    table = [0] * 0x500
    seed = 0x00100001
    for i in range(0x100):
        index = i
        for _ in range(5):
            seed = (seed * 125 + 3) % 0x2AAAAB
            temp1 = (seed & 0xFFFF) << 16
            seed = (seed * 125 + 3) % 0x2AAAAB
            temp2 = seed & 0xFFFF
            table[index] = (temp1 | temp2) & 0xFFFFFFFF
            index += 0x100
    return table


_CRYPT_TABLE = _build_crypt_table()

HASH_TABLE_OFFSET = 0
HASH_NAME_A = 1
HASH_NAME_B = 2
HASH_FILE_KEY = 3


def hash_string(text: str, hash_type: int) -> int:
    """Blizzard's string hash. Paths are upper-cased and slash-normalised."""
    seed1 = 0x7FED7FED
    seed2 = 0xEEEEEEEE
    for char in text.upper().replace("/", "\\"):
        ch = ord(char)
        seed1 = _CRYPT_TABLE[(hash_type << 8) + ch] ^ ((seed1 + seed2) & 0xFFFFFFFF)
        seed1 &= 0xFFFFFFFF
        seed2 = (ch + seed1 + seed2 + (seed2 << 5) + 3) & 0xFFFFFFFF
    return seed1


def decrypt_block(data: bytes, key: int) -> bytes:
    """Decrypt a run of little-endian dwords in place-equivalent fashion."""
    count = len(data) // 4
    if count == 0:
        return data
    words = list(struct.unpack("<%dI" % count, data[: count * 4]))
    seed = 0xEEEEEEEE
    for i in range(count):
        seed = (seed + _CRYPT_TABLE[0x400 + (key & 0xFF)]) & 0xFFFFFFFF
        value = words[i] ^ ((key + seed) & 0xFFFFFFFF)
        key = (((~key << 21) & 0xFFFFFFFF) + 0x11111111) | (key >> 11)
        key &= 0xFFFFFFFF
        seed = (value + seed + (seed << 5) + 3) & 0xFFFFFFFF
        words[i] = value
    out = struct.pack("<%dI" % count, *words)
    return out + data[count * 4:]


def _decompress_sparse(data: bytes) -> bytes:
    """Blizzard's RLE-style 'sparse' codec (0x20)."""
    out = bytearray()
    pos = 0
    end = len(data)
    while pos < end:
        control = data[pos]
        pos += 1
        if control & 0x80:
            count = (control & 0x7F) + 1
            out += data[pos:pos + count]
            pos += count
        else:
            out += b"\x00" * (control + 3)
    return bytes(out)


def decompress(data: bytes, expected_size: int) -> bytes:
    """Apply the codec chain described by the leading mask byte."""
    if not data:
        return data
    mask = data[0]
    payload = data[1:]

    # Order mirrors StormLib's decompression table.
    if mask & COMP_SPARSE:
        payload = _decompress_sparse(payload)
    if mask & COMP_ZLIB:
        payload = zlib.decompress(payload)
    if mask & COMP_PKWARE:
        payload = explode(payload)
    if mask & COMP_BZIP2:
        payload = bz2.decompress(payload)
    if mask & COMP_HUFFMAN:
        raise MPQError("Huffman-compressed sector (audio codec) not supported")
    if mask & (COMP_ADPCM_MONO | COMP_ADPCM_STEREO):
        raise MPQError("ADPCM-compressed sector (audio codec) not supported")

    unknown = mask & ~(COMP_SPARSE | COMP_ZLIB | COMP_PKWARE | COMP_BZIP2 |
                       COMP_HUFFMAN | COMP_ADPCM_MONO | COMP_ADPCM_STEREO)
    if unknown:
        raise MPQError(f"unknown compression mask 0x{mask:02x}")
    return payload


@dataclass
class BlockEntry:
    offset: int
    packed_size: int
    unpacked_size: int
    flags: int

    @property
    def exists(self) -> bool:
        return bool(self.flags & FLAG_EXISTS)

    @property
    def is_compressed(self) -> bool:
        return bool(self.flags & (FLAG_COMPRESS | FLAG_IMPLODE))


@dataclass
class HashEntry:
    name_a: int
    name_b: int
    locale: int
    platform: int
    block_index: int


class MPQArchive:
    """Read-only view over an MPQ archive."""

    def __init__(self, data: bytes, offset: int = 0) -> None:
        self.data = data
        self.offset = offset
        self._parse_header()
        self._read_tables()

    # -- construction -------------------------------------------------------
    @classmethod
    def open_map(cls, path: str) -> "MPQArchive":
        """Open a .w3x/.w3m map, skipping the HM3W wrapper if present."""
        with open(path, "rb") as handle:
            data = handle.read()
        offset = 0
        if data[:4] == b"HM3W":
            found = data.find(b"MPQ\x1a", 0, 4096)
            if found < 0:
                raise MPQError("HM3W header present but no MPQ archive found")
            offset = found
        elif data[:4] != b"MPQ\x1a":
            found = data.find(b"MPQ\x1a", 0, 4096)
            if found < 0:
                raise MPQError("not an MPQ archive")
            offset = found
        return cls(data, offset)

    def _parse_header(self) -> None:
        base = self.offset
        magic = self.data[base:base + 4]
        if magic != b"MPQ\x1a":
            raise MPQError(f"bad MPQ magic {magic!r} at offset {base}")
        (self.header_size, self.archive_size, self.format_version,
         self.sector_size_shift, self.hash_table_pos, self.block_table_pos,
         self.hash_table_size, self.block_table_size) = struct.unpack_from(
            "<IIHHIIII", self.data, base + 4)
        self.sector_size = 512 << self.sector_size_shift
        if self.format_version > 1:
            raise MPQError(
                f"MPQ format v{self.format_version} not supported "
                "(WC3 1.26 maps are v0/v1)")

    def _read_tables(self) -> None:
        hash_bytes = self._slice(self.hash_table_pos, self.hash_table_size * 16)
        hash_bytes = decrypt_block(hash_bytes, hash_string("(hash table)", HASH_FILE_KEY))
        self.hash_table = [
            HashEntry(*struct.unpack_from("<IIHHI", hash_bytes, i * 16))
            for i in range(self.hash_table_size)
        ]

        block_bytes = self._slice(self.block_table_pos, self.block_table_size * 16)
        block_bytes = decrypt_block(block_bytes, hash_string("(block table)", HASH_FILE_KEY))
        self.block_table = [
            BlockEntry(*struct.unpack_from("<IIII", block_bytes, i * 16))
            for i in range(self.block_table_size)
        ]

    def _slice(self, rel_pos: int, length: int) -> bytes:
        start = self.offset + rel_pos
        return self.data[start:start + length]

    # -- lookup -------------------------------------------------------------
    def find_hash_entry(self, name: str) -> Optional[HashEntry]:
        if self.hash_table_size == 0:
            return None
        start = hash_string(name, HASH_TABLE_OFFSET) & (self.hash_table_size - 1)
        name_a = hash_string(name, HASH_NAME_A)
        name_b = hash_string(name, HASH_NAME_B)
        for i in range(self.hash_table_size):
            entry = self.hash_table[(start + i) & (self.hash_table_size - 1)]
            if entry.block_index == HASH_ENTRY_EMPTY:
                return None
            if entry.name_a == name_a and entry.name_b == name_b:
                if entry.block_index == HASH_ENTRY_DELETED:
                    continue
                return entry
        return None

    def __contains__(self, name: str) -> bool:
        return self.find_hash_entry(name) is not None

    # -- extraction ---------------------------------------------------------
    def read_file(self, name: str) -> bytes:
        entry = self.find_hash_entry(name)
        if entry is None:
            raise KeyError(name)
        block = self.block_table[entry.block_index]
        if not block.exists:
            raise KeyError(f"{name} (block marked non-existent)")
        return self._read_block(block, name)

    def _read_block(self, block: BlockEntry, name: str) -> bytes:
        raw = self._slice(block.offset, block.packed_size)

        key = 0
        if block.flags & FLAG_ENCRYPTED:
            basename = name.replace("/", "\\").split("\\")[-1]
            key = hash_string(basename, HASH_FILE_KEY)
            if block.flags & FLAG_FIX_KEY:
                key = ((key + block.offset) ^ block.unpacked_size) & 0xFFFFFFFF

        if block.flags & FLAG_SINGLE_UNIT:
            if block.flags & FLAG_ENCRYPTED:
                raw = decrypt_block(raw, key)
            if not block.is_compressed or block.packed_size >= block.unpacked_size:
                return raw[:block.unpacked_size]
            if block.flags & FLAG_COMPRESS:
                return decompress(raw, block.unpacked_size)
            return explode(raw)

        # Sectored file: leading table of sector offsets.
        sector_size = self.sector_size
        num_sectors = (block.unpacked_size + sector_size - 1) // sector_size
        table_entries = num_sectors + 1
        if block.flags & FLAG_SECTOR_CRC:
            table_entries += 1
        table_bytes = raw[: table_entries * 4]
        if block.flags & FLAG_ENCRYPTED:
            table_bytes = decrypt_block(table_bytes, (key - 1) & 0xFFFFFFFF)
        offsets = struct.unpack("<%dI" % table_entries, table_bytes)

        out = bytearray()
        for i in range(num_sectors):
            start, end = offsets[i], offsets[i + 1]
            chunk = raw[start:end]
            if block.flags & FLAG_ENCRYPTED:
                chunk = decrypt_block(chunk, (key + i) & 0xFFFFFFFF)

            remaining = block.unpacked_size - len(out)
            target = min(sector_size, remaining)

            if block.is_compressed and len(chunk) < target:
                if block.flags & FLAG_COMPRESS:
                    chunk = decompress(chunk, target)
                else:
                    chunk = explode(chunk)
            out += chunk[:target]

        return bytes(out[:block.unpacked_size])

    # -- listing ------------------------------------------------------------
    def listfile(self) -> Optional[list[str]]:
        """Return names from the internal (listfile), if it survived."""
        try:
            raw = self.read_file("(listfile)")
        except (KeyError, MPQError):
            return None
        text = raw.decode("utf-8", errors="replace")
        return [line.strip() for line in text.replace("\r\n", "\n").split("\n") if line.strip()]

    def resolve(self, candidates: Iterator[str]) -> list[str]:
        """Filter a candidate name list down to those actually present."""
        return [name for name in candidates if name in self]

    @property
    def used_block_count(self) -> int:
        return sum(1 for b in self.block_table if b.exists)
