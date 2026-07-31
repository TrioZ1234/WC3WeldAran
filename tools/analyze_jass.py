#!/usr/bin/env python3
"""Measure a map script's dependency on the Warcraft III runtime API.

Any function the script calls but does not itself define must come from
common.j / Blizzard.j — i.e. it is engine surface a replacement runtime has
to provide. That call list is the concrete porting contract.

Usage:
    python3 tools/analyze_jass.py <war3map.j> [--json natives.json]
"""

from __future__ import annotations

import collections
import json
import re
import sys

DEFINE_RE = re.compile(r"^\s*function\s+([A-Za-z_]\w*)", re.M)
CALL_RE = re.compile(r"\b([A-Za-z_]\w*)\s*\(")
GLOBAL_DECL_RE = re.compile(
    r"^\s*(?:constant\s+)?(\w+)\s+(array\s+)?([A-Za-z_]\w*)", re.M)

# JASS keywords and control words that the call regex would otherwise catch.
KEYWORDS = {
    "if", "then", "else", "elseif", "endif", "loop", "endloop", "exitwhen",
    "return", "call", "set", "local", "constant", "function", "endfunction",
    "takes", "returns", "nothing", "globals", "endglobals", "native", "type",
    "extends", "array", "and", "or", "not", "null", "true", "false",
}

# Natives grouped by the engine subsystem that has to implement them.
SUBSYSTEMS = [
    ("unit",       re.compile(r"Unit|Hero", re.I)),
    ("ability",    re.compile(r"Abil|Spell|Buff|Channel", re.I)),
    ("trigger",    re.compile(r"Trigger|Event|Condition|Action|Filter", re.I)),
    ("player",     re.compile(r"Player|Team|Force", re.I)),
    ("ui",         re.compile(r"Text|Message|Multiboard|Leaderboard|Dialog|Button|Frame|Cinematic|Quest", re.I)),
    ("effect",     re.compile(r"Effect|Lightning|Weather|Terrain|Fog|Image|Ubersplat", re.I)),
    ("timer",      re.compile(r"Timer|Sleep|Wait", re.I)),
    ("group",      re.compile(r"Group|Enum", re.I)),
    ("region",     re.compile(r"Region|Rect|Location|Destructable|Item|Doodad", re.I)),
    ("sound",      re.compile(r"Sound|Music|Volume", re.I)),
    ("math",       re.compile(r"^(I2|R2|S2|Sin|Cos|Tan|A?Sin|A?Cos|A?Tan|Pow|Sqrt|Abs|Min|Max|Mod|Get.*Random)", re.I)),
    ("camera",     re.compile(r"Camera|Pan|Zoom", re.I)),
    ("ai",         re.compile(r"^(AI|Start|Command|Melee)", re.I)),
]


def classify(name: str) -> str:
    for label, pattern in SUBSYSTEMS:
        if pattern.search(name):
            return label
    return "other"


def main() -> int:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if not args:
        print(__doc__)
        return 2
    with open(args[0], "rb") as handle:
        text = handle.read().decode("utf-8", errors="replace")

    # Strip line comments so commented-out code does not inflate counts.
    code = re.sub(r"//[^\n]*", "", text)

    defined = set(DEFINE_RE.findall(code))
    calls = collections.Counter(CALL_RE.findall(code))
    for kw in KEYWORDS:
        calls.pop(kw, None)

    external = collections.Counter(
        {name: n for name, n in calls.items() if name not in defined})
    internal = collections.Counter(
        {name: n for name, n in calls.items() if name in defined})

    # BJ wrappers ship in Blizzard.j and are implemented on top of natives.
    bj = collections.Counter({n: c for n, c in external.items() if n.endswith("BJ")})
    core = collections.Counter({n: c for n, c in external.items() if not n.endswith("BJ")})

    print("=" * 74)
    print("JASS SCRIPT / RUNTIME API SURFACE")
    print("=" * 74)
    print(f"script size            : {len(text):,} bytes, {text.count(chr(10)) + 1:,} lines")
    print(f"functions defined      : {len(defined):,}")
    print(f"distinct calls         : {len(calls):,}  ({sum(calls.values()):,} call sites)")
    print(f"  internal             : {len(internal):,} ({sum(internal.values()):,} sites)")
    print(f"  engine API required  : {len(external):,} ({sum(external.values()):,} sites)")
    print(f"    core natives       : {len(core):,}")
    print(f"    Blizzard.j wrappers: {len(bj):,}")

    print("\nENGINE API BY SUBSYSTEM (distinct functions / call sites)")
    buckets: dict = collections.defaultdict(lambda: [0, 0])
    for name, count in external.items():
        b = buckets[classify(name)]
        b[0] += 1
        b[1] += count
    for label, (distinct, sites) in sorted(buckets.items(), key=lambda kv: -kv[1][1]):
        print(f"  {label:<10} {distinct:>5} fns  {sites:>7,} sites")

    print("\nTOP 40 ENGINE CALLS BY FREQUENCY")
    for name, count in external.most_common(40):
        print(f"  {count:>6,}  {name}")

    if "--json" in sys.argv:
        out_path = sys.argv[sys.argv.index("--json") + 1]
        with open(out_path, "w", encoding="utf-8") as handle:
            json.dump({
                "script_bytes": len(text),
                "functions_defined": sorted(defined),
                "engine_api": external.most_common(),
                "core_natives": sorted(core),
                "bj_wrappers": sorted(bj),
                "by_subsystem": {k: {"distinct": v[0], "sites": v[1]}
                                 for k, v in buckets.items()},
            }, handle, indent=2)
        print(f"\nwrote {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
