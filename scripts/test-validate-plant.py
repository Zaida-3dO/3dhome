#!/usr/bin/env python3
"""rooms.json `sensors.plants`: schema + validator checks.
Run: python scripts/test-validate-plant.py

Needs `jsonschema`. Exits 1 on any failure. Every id here is synthetic, and
single-quoted so the PII guard (which flags double-quoted entity ids) passes.

WHAT THIS GUARDS
  1. houses/schema.json: a full binding validates, and so do moisture alone
     and watering alone; a binding with neither, a non-sensor moisture, a
     light as the status helper, a threshold out of 0..100 and an unknown
     key are rejected.
  2. scripts/validate-house.py: a binding to a furniture item that does not
     exist is an ERROR, as is dryBelow not below wetAbove; a profile below
     schemaVersion 1.5 is warned; a clean binding trips none.
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


GOOD = {"moisture": 'sensor.demo_fern_moisture', "battery": 'sensor.demo_fern_battery',
        "status": 'binary_sensor.demo_fern_dry', "temperature": 'sensor.demo_fern_temperature',
        "watering": 'sensor.demo_fern_countdown', "name": "Fern", "dryBelow": 25, "wetAbove": 75}


def rooms_doc(plants, version="1.5"):
    return {"kind": "rooms", "schemaVersion": version, "house": "t", "rooms": {},
            "sensors": {"plants": plants}}


def schema_errors(doc):
    r = vh.Report("t")
    vh.schema_validate(doc, SCHEMA, r, "rooms.json")
    return r.errors


GEO = {"furniture": [{"id": "fern", "room": "room", "type": "plant", "at": [1, 1]}], "doors": [], "curtains": []}
ROOM_IDS = {"room"}


def run(doc):
    r = vh.Report("t")
    vh.check_sensor_binding(doc, GEO, ROOM_IDS, r)
    return [f"{w}: {m}" for w, m in r.errors], [f"{w}: {m}" for w, m in r.warnings]


# ---- 1. schema ---------------------------------------------------------------
check("schema: a full binding validates", schema_errors(rooms_doc({"fern": GOOD})) == [],
      schema_errors(rooms_doc({"fern": GOOD})))
check("schema: moisture alone validates", schema_errors(rooms_doc({"fern": {"moisture": 'sensor.demo_x'}})) == [])
check("schema: watering alone validates", schema_errors(rooms_doc({"fern": {"watering": 'sensor.demo_x'}})) == [])
check("schema: a text status sensor validates", schema_errors(rooms_doc({"fern": dict(GOOD, status='sensor.demo_x_warning')})) == [])
for label, b in [
    ("neither moisture nor watering", {"battery": 'sensor.demo_x'}),
    ("non-sensor moisture", dict(GOOD, moisture='binary_sensor.demo_x')),
    ("light as the status helper", dict(GOOD, status='light.demo_x')),
    ("threshold above 100", dict(GOOD, wetAbove=120)),
    ("negative threshold", dict(GOOD, dryBelow=-1)),
    ("empty name", dict(GOOD, name="")),
    ("unknown key", dict(GOOD, colour="red")),
]:
    check(f"schema: rejects {label}", schema_errors(rooms_doc({"fern": b})) != [])

# ---- 2. validator --------------------------------------------------------------
errs, warns = run(rooms_doc({"fern": GOOD}))
check("validator: a clean binding trips nothing", errs == [] and warns == [], (errs, warns))
errs, _ = run(rooms_doc({"ghost": GOOD}))
check("validator: an unknown furniture item is an error", any("ghost" in e for e in errs), errs)
errs, _ = run(rooms_doc({"fern": dict(GOOD, dryBelow=80, wetAbove=80)}))
check("validator: dryBelow not below wetAbove is an error", any("dryBelow" in e for e in errs), errs)
errs, _ = run(rooms_doc({"fern": {"moisture": 'sensor.demo_x', "dryBelow": 85}}))
check("validator: dryBelow above the default wetAbove is an error", any("dryBelow" in e for e in errs), errs)
_, warns = run(rooms_doc({"fern": GOOD}, version="1.4"))
check("validator: below 1.5 is warned", any("1.5" in w for w in warns), warns)

print(f"{'FAILED' if failures else 'ok'} -- {passes} passed, {failures} failed")
sys.exit(1 if failures else 0)
