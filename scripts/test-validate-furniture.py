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
  4. Per-kind envelopes: a `{kind}` item is sized from the schema block's
     x-kindDefaults for that kind, as the house path sizes it (item 7c056b3e).

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


def schema_errors(doc, schema=None):
    r = vh.Report("t")
    vh.schema_validate(doc, schema or SCHEMA, r, "geometry.json")
    return [f"{w}: {m}" for w, m in r.errors]


def run_checks(doc, schema=None):
    r = vh.Report("t")
    vh.check_geometry(doc, r, schema or SCHEMA)
    return [f"{w}: {m}" for w, m in r.errors], [f"{w}: {m}" for w, m in r.warnings]


# A registered type whose params block is still a PLACEHOLDER. Once every
# registered type is built, the real schema has none left, so the placeholder
# path is exercised on a copy of the schema with one type's block reset to the
# pre-seeded placeholder shape ("x-placeholder": true, no properties).
PLACEHOLDER_TYPE = "sofa"
PLACEHOLDER_SCHEMA = copy.deepcopy(SCHEMA)
PLACEHOLDER_SCHEMA["$defs"][f"furnitureParams_{PLACEHOLDER_TYPE}"] = {"type": "object", "x-placeholder": True}


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
    # Percent-encoded traversal: the WHATWG URL parser decodes '%2e%2e' to '..'
    # (case-insensitively) before collapsing dot-segments, so a literal-only
    # '..' check in the pattern is not enough on its own.
    ("model src percent-encoded traversal (lower)",
     dict(BOX_FREE, type="model", params={"src": "%2e%2e/secret.glb"})),
    ("model src percent-encoded traversal (upper)",
     dict(BOX_FREE, type="model", params={"src": "a/%2E%2E/x.glb"})),
]:
    check(f"schema rejects: {label}", schema_errors(house([item])) != [], item)
for label, item in [
    ("fade auto", dict(BOX_FREE, fade="auto")),
    ("fade never", dict(BOX_FREE, fade="never")),
    ("priority normal", dict(BOX_FREE, priority="normal")),
    ("an unknown type is not a schema error", dict(BOX_FREE, type="spaceship")),
]:
    check(f"schema accepts: {label}", schema_errors(house([item])) == [], schema_errors(house([item])))
_ph_item = dict(BOX_FREE, type=PLACEHOLDER_TYPE, params={"anything": [1, 2]})
check("schema accepts: a placeholder type accepts any params",
      schema_errors(house([_ph_item]), PLACEHOLDER_SCHEMA) == [], schema_errors(house([_ph_item]), PLACEHOLDER_SCHEMA))

# balcony.js floors width/depth/height at 10 cm (Math.max(10, ...)); the
# schema's minimum must match so a house cannot ask for a size the builder
# silently overrides. Mutation: schema minimum back to exclusiveMinimum 0 ->
# fails (width 5 would validate but build 10 wide).
BALCONY_ITEM = {"id": "porch", "room": "room", "type": "balcony", "at": [300, 300], "rotation": 0}
for label, dim in [("width", "width"), ("depth", "depth"), ("height", "height")]:
    item = dict(BALCONY_ITEM, params={dim: 5})
    check(f"schema rejects: balcony {label} below 10", schema_errors(house([item])) != [], item)
check("schema accepts: balcony at the 10 cm floor",
      schema_errors(house([dict(BALCONY_ITEM, params={"width": 10, "depth": 10, "height": 10})])) == [])

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

# A far hit: the room is on one side of the wall but stops 25 cm short of it.
far_doc = house([{"id": "far", "room": "yard", "type": "box", "wall": 50, "centre": 150}])
far_doc["walls"]["segments"].append({"id": 50, "start": [0, 500], "end": [300, 500]})
far_doc["walls"]["highestIdEverAssigned"] = 50
far_doc["rooms"].append({"id": "yard", "label": "Yard", "polygon": [[0, 530], [300, 530], [300, 700], [0, 700]]})
errs, warns = run_checks(far_doc)
check("far hit: a warning, not an error", not has(errs, "furniture/far") and
      has(warns, "furniture/far", "only reaches to 25.0 cm from wall 50"), (errs, warns))
near_doc = copy.deepcopy(far_doc)
near_doc["rooms"][-1]["polygon"] = [[0, 511], [300, 511], [300, 700], [0, 700]]   # 6 cm off the face
errs, warns = run_checks(near_doc)
check("near hit (6 cm off the face): no contact warning", not has(warns, "only reaches"), warns)

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
sofa = dict(BOX_FREE, type=PLACEHOLDER_TYPE)
_, warns = run_checks(house([sofa]), PLACEHOLDER_SCHEMA)

# "registered but unbuilt type": every real registry entry now has a builder
# (sofa.js was the last), so this is exercised via a monkeypatched registry
# rather than a real gap -- monkeypatch load_registry() to return the real
# registry plus one type mapped to a module that does not exist on disk.
_real_registry = vh.load_registry()
_UNBUILT_TYPE = "not-built-yet"
_patched_registry = dict(_real_registry or {}, **{_UNBUILT_TYPE: "not-built-yet.js"})
_orig_load_registry = vh.load_registry
vh.load_registry = lambda: _patched_registry
try:
    unbuilt = dict(BOX_FREE, type=_UNBUILT_TYPE, params={"anything": 1})
    unbuilt_schema = copy.deepcopy(SCHEMA)
    unbuilt_schema["$defs"][f"furnitureParams_{_UNBUILT_TYPE}"] = {"type": "object", "x-placeholder": True}
    _, warns = run_checks(house([unbuilt]), unbuilt_schema)
    # Mutation: comment out the "has no builder yet" report in validate-house.py -> fails.
    check("warn: registered but unbuilt type", has(warns, "furniture/stool", "no builder yet"), warns)
finally:
    vh.load_registry = _orig_load_registry
check("warn: type with no schema defaults (footprint checks skipped)",
      has(warns, "furniture/stool", "no schema defaults"), warns)
_, warns = run_checks(house([dict(sofa, params={"width": 100, "depth": 50, "height": 80})]), PLACEHOLDER_SCHEMA)
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

# ---- 5. per-kind envelopes (item 7c056b3e) ---------------------------------------
# The house path sizes a `{kind}`-only item from THAT kind's DEFAULTS
# (defaultsFor), so the validator's footprint/ceiling checks must too -- via the
# schema block's x-kindDefaults. Ceiling 250: a diy-words clock (39 tall) at
# elevation 215 tops out at 254, over it, where the generic 30 x 30 would read
# 245 and pass. An up-down sconce (20 tall) at 220 tops out at 240, under it,
# where the swing-arm globe's 45.95 would read 265.95 and warn.
d = vh.schema_param_defaults(SCHEMA, "wall-clock", "diy-words")
check("schema_param_defaults: diy-words gets its own width/height", (d["width"], d["height"], d["depth"]) == (49.8, 39, 4), d)
d = vh.schema_param_defaults(SCHEMA, "wall-clock")
check("schema_param_defaults: no kind -> the default kind's (30 x 30)", (d["width"], d["height"]) == (30, 30), d)
d = vh.schema_param_defaults(SCHEMA, "wall-sconce", "up-down")
check("schema_param_defaults: up-down gets its own envelope", (d["width"], d["height"], d["depth"]) == (12, 20, 6), d)
CLOCK = {"id": "clock", "room": "room", "type": "wall-clock", "wall": 1, "centre": 300}
_, warns = run_checks(house([dict(CLOCK, elevation=215, params={"kind": "diy-words"})]))
check("warn: a diy-words clock sized by ITS envelope reaches over the ceiling",
      has(warns, "furniture/clock", "top at 254 cm"), warns)
_, warns = run_checks(house([dict(CLOCK, elevation=215, params={"kind": "framed"})]))
check("no warn: the same clock as `framed` (30 tall) stays under it", not has(warns, "above the ceiling"), warns)
SCONCE = {"id": "sconce", "room": "room", "type": "wall-sconce", "wall": 1, "centre": 300, "elevation": 220}
_, warns = run_checks(house([dict(SCONCE, params={"kind": "up-down"})]))
check("no warn: an up-down sconce sized by ITS envelope stays under the ceiling", not has(warns, "above the ceiling"), warns)
_, warns = run_checks(house([dict(SCONCE, params={"kind": "swing-arm-globe"})]))
check("warn: the same sconce as swing-arm-globe (45.95 tall) reaches over it",
      has(warns, "furniture/sconce", "above the ceiling"), warns)

print(("FAILED" if failures else "ok") + f" -- {passes} passed, {failures} failed")
sys.exit(1 if failures else 0)
