"""PKWARE Data Compression Library "implode" decompressor (a.k.a. explode).

MPQ archives store a large share of their files with this codec (compression
mask 0x08), so archive extraction depends on having it. Python has no stdlib
support for it, hence this pure-Python port of Mark Adler's `blast.c`.

The bit stream is read LSB-first and Huffman codes are stored inverted, which
is why `decode()` flips each bit as it walks the code lengths.
"""

from __future__ import annotations

MAXBITS = 13   # maximum code length
MAXWIN = 4096  # maximum window size

# Run-length encoded Huffman code lengths. Each byte packs a repeat count in
# the high nibble (count - 1) and the bit length in the low nibble.
_LITLEN = bytes([
    11, 124, 8, 7, 28, 7, 188, 13, 76, 4, 10, 8, 12, 10, 12, 10, 8, 23, 8,
    9, 7, 6, 7, 8, 7, 6, 55, 8, 23, 24, 12, 11, 7, 9, 11, 12, 6, 7, 22, 5,
    7, 24, 6, 11, 9, 6, 7, 22, 7, 11, 38, 7, 9, 8, 25, 11, 8, 11, 9, 12,
    8, 12, 5, 38, 5, 38, 5, 11, 7, 5, 6, 21, 6, 10, 53, 8, 7, 24, 10, 27,
    44, 253, 253, 253, 252, 252, 252, 13, 12, 45, 12, 45, 12, 61, 12, 45,
    44, 173,
])
_LENLEN = bytes([2, 35, 36, 53, 38, 23])
_DISTLEN = bytes([2, 20, 53, 230, 247, 151, 248])

# Base length for each length symbol, plus the number of extra bits to read.
_BASE = (3, 2, 4, 5, 6, 7, 8, 9, 10, 12, 16, 24, 40, 72, 136, 264)
_EXTRA = (0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8)


class ExplodeError(Exception):
    """Raised when a PKWARE-imploded stream is malformed or truncated."""


class _Huffman:
    """Canonical Huffman decoding table built from run-length encoded lengths."""

    __slots__ = ("count", "symbol")

    def __init__(self, rep: bytes) -> None:
        lengths: list[int] = []
        for packed in rep:
            repeat = (packed >> 4) + 1
            length = packed & 15
            lengths.extend([length] * repeat)

        count = [0] * (MAXBITS + 1)
        for length in lengths:
            count[length] += 1

        # Offset of the first symbol of each code length in the symbol table.
        offsets = [0] * (MAXBITS + 2)
        for length in range(1, MAXBITS + 1):
            offsets[length + 1] = offsets[length] + count[length]

        symbols = [0] * len(lengths)
        for symbol, length in enumerate(lengths):
            if length:
                symbols[offsets[length]] = symbol
                offsets[length] += 1

        self.count = count
        self.symbol = symbols


_LITCODE = _Huffman(_LITLEN)
_LENCODE = _Huffman(_LENLEN)
_DISTCODE = _Huffman(_DISTLEN)


class _BitReader:
    __slots__ = ("data", "pos", "bitbuf", "bitcnt")

    def __init__(self, data: bytes) -> None:
        self.data = data
        self.pos = 0
        self.bitbuf = 0
        self.bitcnt = 0

    def bits(self, need: int) -> int:
        """Read `need` bits LSB-first from the stream."""
        val = self.bitbuf
        while self.bitcnt < need:
            if self.pos >= len(self.data):
                raise ExplodeError("out of input while reading bits")
            val |= self.data[self.pos] << self.bitcnt
            self.pos += 1
            self.bitcnt += 8
        self.bitbuf = val >> need
        self.bitcnt -= need
        return val & ((1 << need) - 1)

    def decode(self, huff: _Huffman) -> int:
        """Decode one Huffman symbol. Codes are stored bit-inverted.

        `self.bitcnt` is deliberately left untouched until the symbol is
        found: each refill below adds exactly 8 bits, so the residual bit
        count is always (original count - code length) mod 8.
        """
        code = first = index = 0
        count_table = huff.count
        symbols = huff.symbol
        bitbuf = self.bitbuf
        left = self.bitcnt
        length = 1
        next_idx = 1
        while True:
            while left > 0:
                left -= 1
                code |= (bitbuf & 1) ^ 1  # invert the bit
                bitbuf >>= 1
                count = count_table[next_idx]
                next_idx += 1
                if code < first + count:
                    self.bitbuf = bitbuf
                    self.bitcnt = (self.bitcnt - length) & 7
                    return symbols[index + (code - first)]
                index += count
                first = (first + count) << 1
                code <<= 1
                length += 1
            left = (MAXBITS + 1) - length
            if left == 0:
                raise ExplodeError("ran out of Huffman codes")
            if self.pos >= len(self.data):
                raise ExplodeError("out of input while decoding symbol")
            bitbuf = self.data[self.pos]
            self.pos += 1
            if left > 8:
                left = 8


def explode(data: bytes) -> bytes:
    """Decompress a PKWARE DCL imploded stream and return the raw bytes."""
    if len(data) < 4:
        raise ExplodeError("stream too short to be imploded data")

    reader = _BitReader(data)

    coded_literals = reader.bits(8)
    if coded_literals > 1:
        raise ExplodeError(f"invalid literal mode {coded_literals}")
    dict_bits = reader.bits(8)
    if not 4 <= dict_bits <= 6:
        raise ExplodeError(f"invalid dictionary size {dict_bits}")

    out = bytearray()
    while True:
        if reader.bits(1):
            # Length/distance pair.
            symbol = reader.decode(_LENCODE)
            length = _BASE[symbol] + reader.bits(_EXTRA[symbol])
            if length == 519:
                break  # end-of-stream marker

            shift = 2 if length == 2 else dict_bits
            dist = reader.decode(_DISTCODE) << shift
            dist += reader.bits(shift)
            dist += 1

            if dist > len(out):
                raise ExplodeError("distance points before start of output")

            start = len(out) - dist
            if dist >= length:
                # Non-overlapping: bulk slice copy.
                out += out[start:start + length]
            else:
                # Overlapping run (e.g. RLE fill) must be copied bytewise.
                for i in range(length):
                    out.append(out[start + i])
        else:
            # Literal byte.
            if coded_literals:
                out.append(reader.decode(_LITCODE))
            else:
                out.append(reader.bits(8))

    return bytes(out)
