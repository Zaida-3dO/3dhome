#!/usr/bin/env python3
"""rooms.json `sensors.vacuums`: schema + validator checks.
Run: python scripts/test-validate-vacuum.py

Needs `jsonschema`. Exits 1 on any failure. Every id here is synthetic.

WHAT THIS GUARDS
  1. houses/schema.json: a full binding validates; a non-vacuum entity, a
     non-sensor battery, a negative or fractional segment, an unknown key and
     a missing entity are rejected.
  2. scripts/validate-house.py: a binding to a furniture item that does not
     exist is an ERROR, as is a segment on a room that does not exist; a
     profile below schemaVersion 1.4 is warned; a clean binding trips none.
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


GOOD = {"entity": "vacuum.test_robot", "battery": "sensor.test_robot_battery",
        "segments": {"room": 7}, "segmentService": "some_vac.clean_segment"}


def rooms_doc(vacuums, version="1.4"):
    return {"kind": "rooms", "schemaVersion": version, "house": "t", "rooms": {},
            "sensors": {"vacuums": vacuums}}


def schema_errors(doc):
    r = vh.Report("t")
    vh.schema_validate(doc, SCHEMA, r, "rooms.json")
    return r.errors


GEO = {"furniture": [{"id": "robot", "room": "room", "type": "robot-vacuum", "at": [1, 1]}], "doors": [], "curtains": []}
ROOM_IDS = {"room"}


def run(doc):
    r = vh.Report("t")
    vh.check_sensor_binding(doc, GEO, ROOM_IDS, r)
    return [f"{w}: {m}" for w, m in r.errors], [f"{w}: {m}" for w, m in r.warnings]


# ---- 1. schema ---------------------------------------------------------------
check("schema: a full binding validates", schema_errors(rooms_doc({"robot": GOOD})) == [],
      schema_errors(rooms_doc({"robot": GOOD})))
check("schema: entity alone validates", schema_errors(rooms_doc({"robot": {"entity": "vacuum.x"}})) == [])
for label, b in [
    ("non-vacuum entity", dict(GOOD, entity="light.x")),
    ("non-sensor battery", dict(GOOD, battery="binary_sensor.x")),
    ("negative segment", dict(GOOD, segments={"room": -1})),
    ("fractional segment", dict(GOOD, segments={"room": 1.5})),
    ("unknown key", dict(GOOD, colour="red")),
    ("malformed service", dict(GOOD, segmentService="clean it")),
]:
    check(f"schema: rejects {label}", schema_errors(rooms_doc({"robot": b})) != [])
no_entity = copy.deepcopy(GOOD)
del no_entity["entity"]
check("schema: rejects a binding with no entity", schema_errors(rooms_doc({"robot": no_entity})) != [])

# ---- 2. validator --------------------------------------------------------------
errs, warns = run(rooms_doc({"robot": GOOD}))
check("validator: a clean binding trips nothing", errs == [] and warns == [], (errs, warns))
errs, _ = run(rooms_doc({"ghost": GOOD}))
check("validator: an unknown furniture item is an error", any("ghost" in e for e in errs), errs)
errs, _ = run(rooms_doc({"robot": dict(GOOD, segments={"attic": 3})}))
check("validator: a segment on an unknown room is an error", any("attic" in e for e in errs), errs)
_, warns = run(rooms_doc({"robot": GOOD}, version="1.3"))
check("validator: below 1.4 is warned", any("1.4" in w for w in warns), warns)

print(f"{'FAILED' if failures else 'ok'} -- {passes} passed, {failures} failed")
sys.exit(1 if failures else 0)
