#!/usr/bin/env python3
"""Furniture schema + validator checks. Run: python scripts/test-validate-furniture.py

Needs `jsonschema` (the schema half is the point). Exits 1 on any failure.

WHAT THIS GUARDS
  1. houses/schema.json: both anchor forms validate; both-or-neither and
     `rotation` with `wall` are rejected; `fade` is only auto/never/{wall:int};
     `priority` only normal/minor; per-type params are checked through the
     allOf rules (box is strict, a placeholder type accepts anything).
  2. scripts/validate-house.py's furniture checks: every ERROR and WARNING the
     plan lists fires on a synthetic house built to trip it -- and a clean
     house trips none of them, so a check that fires on everything fails too.
  3. The wall-side probe errors on "neither side" for windows and curtains.

Every number here is synthetic.
"""

import copy
import importlib.util
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("validate_house", ROOT / "scripts" / "validate-house.py")
vh = importlib.util.module_from_spec(spec)
spec.loader.exec_module(vh)

try:
    import jsonschema  # noqa: F401
except ImportError:
    print("FAIL jsonschema is not installed -- pip install jsonschema")
    sys.exit(1)

SCHEMA = json.loads((ROOT / "houses" / "schema.json").read_text(encoding="utf-8"))

passes = 0
failures = 0


def check(name, cond, detail=None):
    global passes, failures
    if cond:
        passes += 1
    else:
        failures += 1
        print(f"FAIL {name}" + (f" -- {detail}" if detail is not None else ""))


# A 400 x 300 room (x 100..500, y 100..400) in four 10 cm walls, plus a store
# north of it and a diagonal wall.
BASE = {
    "kind": "geometry", "schemaVersion": "1.2", "id": "t", "name": "T", "units": "cm",
    "coordinateTransform": {"originX": 0, "originY": 0, "scale": 0.01},
    "defaults": {"wallHeight": 250, "wallThickness": 10},
    "rooms": [
        {"id": "room", "label": "Room", "polygon": [[100, 100], [500, 100], [500, 400], [100, 400]]},
        {"id": "store", "label": "Store", "polygon": [[100, 0], [500, 0], [500, 90], [100, 90]]},
    ],
    "walls": {"highestIdEverAssigned": 9, "segments": [
        {"id": 1, "start": [95, 95], "end": [505, 95]},
        {"id": 2, "start": [95, 405], "end": [505, 405], "exterior": True},
        {"id": 3, "start": [95, 95], "end": [95, 405], "exterior": True},
        {"id": 4, "start": [505, 95], "end": [505, 405], "exterior": True},
        {"id": 5, "start": [800, 0], "end": [800, 300], "exterior": True},
        {"id": 9, "start": [600, 0], "end": [700, 80]},
    ]},
}


def house(furniture=None, **extra):
    doc = copy.deepcopy(BASE)
    if furniture is not None:
        doc["furniture"] = furniture
    doc.update(extra)
    return doc


def schema_errors(doc):
    r = vh.Report("t")
    vh.schema_validate(doc, SCHEMA, r, "geometry.json")
    return [f"{w}: {m}" for w, m in r.errors]


def run_checks(doc):
    r = vh.Report("t")
    vh.check_geometry(doc, r, SCHEMA)
    return [f"{w}: {m}" for w, m in r.errors], [f"{w}: {m}" for w, m in r.warnings]


def has(msgs, *needles):
    return any(all(n in m for n in needles) for m in msgs)


BOX_WALL = {"id": "crate", "room": "room", "type": "box", "wall": 1, "centre": 200}
BOX_FREE = {"id": "stool", "room": "room", "type": "box", "at": [300, 300], "rotation": 90}

# ---- 1. schema -----------------------------------------------------------------
check("schema: a clean house with both anchor forms validates",
      schema_errors(house([BOX_WALL, BOX_FREE])) == [], schema_errors(house([BOX_WALL, BOX_FREE])))
check("schema: wall anchor with offset, elevation, fade {wall}, priority minor validates",
      schema_errors(house([dict(BOX_WALL, offset=2, elevation=30, fade={"wall": 2}, priority="minor")])) == [])
for label, item in [
    ("both anchors", dict(BOX_WALL, at=[1, 1])),
    ("neither anchor", {"id": "x", "room": "room", "type": "box"}),
    ("rotation with wall", dict(BOX_WALL, rotation=90)),
    ("offset with at", dict(BOX_FREE, offset=3)),
    ("wall without centre", {"id": "x", "room": "room", "type": "box", "wall": 1}),
    ("fade string not auto/never", dict(BOX_FREE, fade="sometimes")),
    ("fade {wall} not an int", dict(BOX_FREE, fade={"wall": "two"})),
    ("fade {wall} with an extra key", dict(BOX_FREE, fade={"wall": 2, "also": 1})),
    ("priority not normal/minor", dict(BOX_FREE, priority="major")),
    ("type with capitals", dict(BOX_FREE, type="Box")),
    ("unknown top-level key", dict(BOX_FREE, colour="#ffffff")),
    ("box params wrong type", dict(BOX_FREE, params={"width": "wide"})),
    ("box params unknown key", dict(BOX_FREE, params={"wobble": 1})),
    ("box finish outside the palette", dict(BOX_FREE, params={"finish": "shiny"})),
]:
    check(f"schema rejects: {label}", schema_errors(house([item])) != [], item)
for label, item in [
    ("fade auto", dict(BOX_FREE, fade="auto")),
    ("fade never", dict(BOX_FREE, fade="never")),
    ("priority normal", dict(BOX_FREE, priority="normal")),
    ("a placeholder type accepts any params", dict(BOX_FREE, type="sofa", params={"anything": [1, 2]})),
    ("an unknown type is not a schema error", dict(BOX_FREE, type="spaceship")),
]:
    check(f"schema accepts: {label}", schema_errors(house([item])) == [], schema_errors(house([item])))

# ---- 2. validator: the clean house is clean ------------------------------------
errs, warns = run_checks(house([BOX_WALL, BOX_FREE]))
check("validator: clean house has no errors", errs == [], errs)
check("validator: clean house has no warnings", warns == [], warns)
errs, warns = run_checks(house())
check("validator: no furniture key is fine", errs == [] and warns == [], (errs, warns))

# ---- 3. validator ERRORS --------------------------------------------------------
errs, _ = run_checks(house([BOX_FREE], schemaVersion="1.1"))
check("error: furniture below 1.2", has(errs, "schemaVersion", "1.2"), errs)
errs, _ = run_checks(house([BOX_FREE, dict(BOX_FREE, at=[200, 200])]))
check("error: duplicate id", has(errs, "furniture/stool", "duplicate"), errs)
errs, _ = run_checks(house([dict(BOX_FREE, room="attic")]))
check("error: missing room", has(errs, "furniture/stool", "'attic'"), errs)
errs, _ = run_checks(house([dict(BOX_WALL, wall=77)]))
check("error: missing wall", has(errs, "furniture/crate", "wall 77"), errs)
errs, _ = run_checks(house([dict(BOX_WALL, wall=9, centre=650)]))
check("error: non-axis-aligned host", has(errs, "furniture/crate", "not axis-aligned"), errs)
errs, _ = run_checks(house([dict(BOX_WALL, centre=900)]))
check("error: centre outside the wall span", has(errs, "furniture/crate", "outside wall 1"), errs)
errs, _ = run_checks(house([dict(BOX_WALL, wall=5, centre=100)]))
check("error: neither side (furniture)", has(errs, "furniture/crate", "neither side of wall 5"), errs)
errs, _ = run_checks(house([dict(BOX_FREE, fade={"wall": 77})]))
check("error: fade.wall missing", has(errs, "furniture/stool", "fade.wall 77 does not exist"), errs)
errs, _ = run_checks(house([dict(BOX_FREE, fade={"wall": 1})]))
check("error: fade.wall not exterior", has(errs, "furniture/stool", "not an exterior wall"), errs)
errs, _ = run_checks(house([dict(BOX_FREE, fade={"wall": 2})]))
check("no error: fade.wall exterior", not has(errs, "fade.wall"), errs)
errs, _ = run_checks(house([dict(BOX_WALL, at=[1, 1])]))
check("error: both anchors (structural, without the schema)", has(errs, "exactly one anchor"), errs)
errs, _ = run_checks(house([dict(BOX_WALL, rotation=0)]))
check("error: rotation with wall (structural)", has(errs, "`rotation` is not allowed"), errs)

# Windows and curtains get the probe too.
fit = {"windows": [{"id": "w", "room": "room", "wall": 5, "centre": 100, "width": 60, "height": 100}],
       "curtains": [{"id": "c", "room": "room", "wall": 5, "centre": 100, "width": 60}]}
errs, _ = run_checks(house(None, **fit))
check("error: neither side (window)", has(errs, "windows/w", "neither side of wall 5"), errs)
check("error: neither side (curtain)", has(errs, "curtains/c", "neither side of wall 5"), errs)
fit_ok = {"windows": [{"id": "w", "room": "room", "wall": 2, "centre": 300, "width": 60, "height": 100}],
          "curtains": [{"id": "c", "room": "room", "wall": 2, "centre": 300, "width": 60}]}
errs, _ = run_checks(house(None, **fit_ok))
check("no error: window and curtain on their room's wall", errs == [], errs)

# ---- 4. validator WARNINGS -------------------------------------------------------
_, warns = run_checks(house([dict(BOX_FREE, at=[110, 300])]))
check("warn: footprint outside the room polygon", has(warns, "furniture/stool", "outside room 'room'"), warns)
_, warns = run_checks(house([BOX_FREE, dict(BOX_FREE, id="stool2", at=[320, 310])]))
check("warn: 3D overlap", has(warns, "furniture/stool", "overlaps 'stool2'"), warns)
_, warns = run_checks(house([BOX_FREE, dict(BOX_FREE, id="shelf", at=[320, 310], elevation=150)]))
check("no warn: overlapping in plan but not in height", not has(warns, "overlaps"), warns)
_, warns = run_checks(house([dict(BOX_FREE, elevation=230)]))
check("warn: top above the ceiling", has(warns, "furniture/stool", "above the ceiling"), warns)
_, warns = run_checks(house([dict(BOX_FREE, type="spaceship", params={"width": 10, "depth": 10, "height": 10})]))
check("warn: unregistered type", has(warns, "furniture/stool", "not registered"), warns)
sofa = dict(BOX_FREE, type="sofa")
_, warns = run_checks(house([sofa]))
if (ROOT / "src" / "furniture" / "sofa.js").exists():
    print("note: sofa.js exists now -- the 'unbuilt type' case needs another unbuilt type")
else:
    check("warn: registered but unbuilt type", has(warns, "furniture/stool", "no builder yet"), warns)
check("warn: type with no schema defaults (footprint checks skipped)",
      has(warns, "furniture/stool", "no schema defaults"), warns)
_, warns = run_checks(house([dict(sofa, params={"width": 100, "depth": 50, "height": 80})]))
check("no 'no schema defaults' warning when params give the dimensions", not has(warns, "no schema defaults"), warns)
run = {"room": "room", "type": "kitchen-base-run", "params": {"width": 200, "depth": 60, "height": 90}}
_, warns = run_checks(house([
    dict(run, id="run_north", wall=1, centre=200),   # x 100..300, y 100..160
    dict(run, id="run_west", wall=3, centre=200),     # its back strip runs x 100..160, into the north run
]))
check("warn: worktop overlap between runs", has(warns, "run_north", "worktop overlaps kitchen run 'run_west'"), warns)
check("worktop overlap is not ALSO reported as a generic overlap", not has(warns, "overlaps 'run_west' ("), warns)
_, warns = run_checks(house([
    dict(run, id="run_north", wall=1, centre=200),   # x 100..300, y 100..160
    dict(run, id="run_west", wall=3, centre=260),     # starts at y 160: meets the north run's front face
]))
check("no worktop warning when the runs only meet", not has(warns, "worktop"), warns)

print(("FAILED" if failures else "ok") + f" -- {passes} passed, {failures} failed")
sys.exit(1 if failures else 0)
