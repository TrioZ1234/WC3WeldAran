"""Decoder for BLP1 textures, the image format used by Warcraft III.

BLP1 comes in two flavours:
  * JPEG mode    - a shared JPEG header plus per-mipmap scan data. Channels are
                   stored B, G, R, A rather than RGBA.
  * Palette mode - a 256-entry BGRA palette followed by index data, optionally
                   with a separate alpha plane at 1, 4 or 8 bits per pixel.

`decode_blp()` returns (width, height, RGBA bytes) so callers can hand the
result straight to an image library.
"""

from __future__ import annotations

import io
import struct
from dataclasses import dataclass
from typing import Optional

MAGIC_BLP1 = b"BLP1"
MAGIC_BLP2 = b"BLP2"

COMPRESSION_JPEG = 0
COMPRESSION_PALETTE = 1


class BLPError(Exception):
    pass


@dataclass
class BLPHeader:
    compression: int
    alpha_bits: int
    width: int
    height: int
    picture_type: int
    picture_subtype: int
    mip_offsets: tuple
    mip_sizes: tuple


def parse_header(data: bytes) -> BLPHeader:
    if data[:4] != MAGIC_BLP1:
        if data[:4] == MAGIC_BLP2:
            raise BLPError("BLP2 (WoW-era) is not supported; WC3 uses BLP1")
        raise BLPError(f"not a BLP1 file (magic {data[:4]!r})")
    (compression, alpha_bits, width, height,
     picture_type, picture_subtype) = struct.unpack_from("<IIIIII", data, 4)
    mip_offsets = struct.unpack_from("<16I", data, 28)
    mip_sizes = struct.unpack_from("<16I", data, 92)
    return BLPHeader(compression, alpha_bits, width, height,
                     picture_type, picture_subtype, mip_offsets, mip_sizes)


def has_alpha(alpha_bits: int) -> bool:
    """Whether the alpha channel carries real data.

    Blizzard's own terrain BLPs use non-standard values here (6 and 9 both
    appear in WC3's TerrainArt), so the field behaves as a flag rather than a
    strict bit depth: zero means opaque, anything else means alpha is present.
    Terrain tiles rely on this - their alpha holds the tile-edge blend masks.
    """
    return alpha_bits != 0


def _expand_alpha(raw: bytes, bits: int, count: int) -> bytes:
    """Unpack a packed alpha plane to one byte per pixel."""
    if bits == 0:
        return b"\xff" * count
    if bits not in (1, 4):
        # 8 and any non-standard non-zero value: one byte per pixel.
        return raw[:count].ljust(count, b"\xff")
    out = bytearray(count)
    if bits == 1:
        for i in range(count):
            byte = raw[i >> 3] if (i >> 3) < len(raw) else 0xFF
            out[i] = 0xFF if (byte >> (i & 7)) & 1 else 0x00
    elif bits == 4:
        for i in range(count):
            byte = raw[i >> 1] if (i >> 1) < len(raw) else 0xFF
            nibble = (byte & 0x0F) if (i & 1) == 0 else (byte >> 4)
            out[i] = nibble * 17          # 0..15 -> 0..255
    return bytes(out)


def _decode_palette(data: bytes, hdr: BLPHeader, mip: int) -> bytes:
    palette = data[156:156 + 1024]        # 256 BGRA entries
    offset = hdr.mip_offsets[mip]
    width = max(1, hdr.width >> mip)
    height = max(1, hdr.height >> mip)
    count = width * height

    indices = data[offset:offset + count]
    if len(indices) < count:
        raise BLPError(f"truncated index data for mip {mip}")

    alpha_raw = data[offset + count:offset + hdr.mip_sizes[mip]]
    alpha = _expand_alpha(alpha_raw, hdr.alpha_bits, count)

    out = bytearray(count * 4)
    for i in range(count):
        p = indices[i] * 4
        out[i * 4 + 0] = palette[p + 2]   # R  (palette is BGRA)
        out[i * 4 + 1] = palette[p + 1]   # G
        out[i * 4 + 2] = palette[p + 0]   # B
        out[i * 4 + 3] = alpha[i]
    return bytes(out)


def _decode_jpeg(data: bytes, hdr: BLPHeader, mip: int) -> bytes:
    from PIL import Image                 # imported lazily: only JPEG mode needs it

    header_size = struct.unpack_from("<I", data, 156)[0]
    shared_header = data[160:160 + header_size]
    offset = hdr.mip_offsets[mip]
    scan = data[offset:offset + hdr.mip_sizes[mip]]

    image = Image.open(io.BytesIO(shared_header + scan))
    image.load()

    # WC3 stores four components in B, G, R, A order. Pillow reports such a
    # JPEG as CMYK because there is no Adobe marker to say otherwise, and its
    # CMYK path inverts the samples - undo that, then reorder to RGBA.
    if image.mode == "CMYK":
        b, g, r, a = image.split()
        from PIL import ImageChops
        inv = ImageChops.invert
        b, g, r, a = inv(b), inv(g), inv(r), inv(a)
        image = Image.merge("RGBA", (r, g, b, a))
    elif image.mode != "RGBA":
        image = image.convert("RGBA")

    if not has_alpha(hdr.alpha_bits):
        r, g, b, _ = image.split()
        image = Image.merge("RGBA", (r, g, b, Image.new("L", image.size, 255)))

    return image.tobytes()


def decode_blp(data: bytes, mip: int = 0) -> tuple:
    """Decode one mipmap level. Returns (width, height, rgba_bytes)."""
    hdr = parse_header(data)
    if mip >= 16 or hdr.mip_sizes[mip] == 0:
        raise BLPError(f"mip level {mip} not present")

    width = max(1, hdr.width >> mip)
    height = max(1, hdr.height >> mip)

    if hdr.compression == COMPRESSION_JPEG:
        rgba = _decode_jpeg(data, hdr, mip)
    elif hdr.compression == COMPRESSION_PALETTE:
        rgba = _decode_palette(data, hdr, mip)
    else:
        raise BLPError(f"unknown compression mode {hdr.compression}")
    return width, height, rgba


def mip_count(data: bytes) -> int:
    hdr = parse_header(data)
    return sum(1 for size in hdr.mip_sizes if size > 0)
