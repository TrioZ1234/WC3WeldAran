#!/usr/bin/env python3
"""SYLK (.slk) reader.

Warcraft III keeps its stock game balance in SYLK spreadsheets — a 1980s
Multiplan text format. The subset used here is small: a dimension record and a
stream of cell records.

    ID;PWXL;N;E
    B;X32;Y837;D0
    C;X1;Y1;K"unitID"
    C;X2;K"sort"

Coordinates persist between records: a cell without `Y` belongs to the row of
the previous cell. Row 1 holds column names, so each later row becomes a dict
keyed by those names.

Semicolons inside values are escaped by doubling, which is why the line cannot
simply be split on `;`.
"""

from __future__ import annotations

from typing import Any, Optional


def _split_records(line: str) -> list:
    """Split on single semicolons, honouring the `;;` escape for a literal one."""
    fields = []
    current = []
    i = 0
    length = len(line)
    while i < length:
        char = line[i]
        if char == ";":
            if i + 1 < length and line[i + 1] == ";":
                current.append(";")
                i += 2
                continue
            fields.append("".join(current))
            current = []
            i += 1
            continue
        current.append(char)
        i += 1
    fields.append("".join(current))
    return fields


def _parse_value(raw: str) -> Any:
    if raw.startswith('"') and raw.endswith('"') and len(raw) >= 2:
        return raw[1:-1]
    upper = raw.upper()
    if upper == "TRUE":
        return True
    if upper == "FALSE":
        return False
    try:
        return int(raw)
    except ValueError:
        pass
    try:
        return float(raw)
    except ValueError:
        return raw


def read_cells(path: str) -> dict:
    """Return {row: {column: value}} with 1-based coordinates."""
    grid: dict = {}
    x, y = 1, 1
    # Blizzard's tables are Windows-1252; a few carry stray bytes, so never abort on them.
    with open(path, "r", encoding="cp1252", errors="replace") as handle:
        for line in handle:
            line = line.rstrip("\r\n")
            if not line or line[0] != "C":
                continue
            value: Optional[Any] = None
            has_value = False
            for field in _split_records(line)[1:]:
                if not field:
                    continue
                tag, rest = field[0], field[1:]
                if tag == "X":
                    try:
                        x = int(rest)
                    except ValueError:
                        pass
                elif tag == "Y":
                    try:
                        y = int(rest)
                    except ValueError:
                        pass
                elif tag == "K":
                    value = _parse_value(rest)
                    has_value = True
            if has_value:
                grid.setdefault(y, {})[x] = value
    return grid


def read_table(path: str) -> list:
    """Read an .slk into a list of row dicts, using row 1 as column names."""
    grid = read_cells(path)
    if not grid:
        return []

    header = grid.get(1, {})
    names = {column: str(name) for column, name in header.items()}

    rows = []
    for y in sorted(k for k in grid if k > 1):
        record = {}
        for column, value in grid[y].items():
            name = names.get(column)
            if name:
                record[name] = value
        if record:
            rows.append(record)
    return rows


def key_of(row: dict, candidates=(
    "unitID", "unitWeapID", "unitBalanceID", "unitUIID", "unitAbilID",
    "alias", "buffID", "doodID", "DestructableID", "destID",
    "upgradeid", "itemID", "ID",
)) -> Optional[str]:
    """Identify a row's primary key; every table names it differently."""
    for name in candidates:
        value = row.get(name)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def index_table(path: str) -> dict:
    """Read an .slk and index it by primary key."""
    indexed = {}
    for row in read_table(path):
        key = key_of(row)
        if key:
            indexed[key] = row
    return indexed


if __name__ == "__main__":
    import json
    import sys

    if len(sys.argv) < 2:
        print(__doc__)
        raise SystemExit(2)
    table = read_table(sys.argv[1])
    print(f"{len(table)} rows, {len(table[0]) if table else 0} columns")
    print(json.dumps(table[:2], indent=2, ensure_ascii=False)[:1500])
