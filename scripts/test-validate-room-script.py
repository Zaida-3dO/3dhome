#!/usr/bin/env python3
"""rooms.json `sensors.roomScripts`: schema + validator checks.
Run: python scripts/test-validate-room-script.py

Needs `jsonschema`. Exits 1 on any failure. Every id here is synthetic, and
single-quoted so the PII guard (which flags double-quoted entity ids) passes.

WHAT THIS GUARDS
  1. houses/schema.json: a binding with variables and a label validates, and
     so does one with the entity alone; the same script on several rooms with
     identical variables validates. A non-script entity, a missing entity, a
     list (or string) as `variables`, an empty label and an unknown key are
     rejected.
  2. scripts/validate-house.py: a binding to a room the geometry does not
     have is an ERROR; a profile below schemaVersion 1.7 is warned; a clean
     binding -- including two rooms sharing identical variables -- trips none.
  3. Older rooms.json versions still validate against the schema (a 1.0 with
     no sensors, a 1.6 with items), and the demo house is at 1.7 or newer.
"""

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


SCRIPT = 'script.demo_room_off'
GOOD = {"entity": SCRIPT, "variables": {"area": "demo_a"}, "label": "Switch room off"}


def rooms_doc(scripts, version="1.7"):
    return {"kind": "rooms", "schemaVersion": version, "house": "t", "rooms": {},
            "sensors": {"roomScripts": scripts}}


def schema_errors(doc):
    r = vh.Report("t")
    vh.schema_validate(doc, SCHEMA, r, "rooms.json")
    return r.errors


GEO = {"furniture": [], "doors": [], "curtains": []}
ROOM_IDS = {"lounge", "kitchen"}


def run(doc):
    r = vh.Report("t")
    vh.check_sensor_binding(doc, GEO, ROOM_IDS, r)
    return [f"{w}: {m}" for w, m in r.errors], [f"{w}: {m}" for w, m in r.warnings]


# ---- 1. schema ---------------------------------------------------------------
check("schema: a full binding validates", schema_errors(rooms_doc({"lounge": GOOD})) == [],
      schema_errors(rooms_doc({"lounge": GOOD})))
check("schema: entity alone validates", schema_errors(rooms_doc({"lounge": {"entity": SCRIPT}})) == [])
shared = {"lounge": {"entity": SCRIPT, "variables": {"area": "demo_ab"}},
          "kitchen": {"entity": SCRIPT, "variables": {"area": "demo_ab"}}}
check("schema: one script, identical variables on two rooms validates", schema_errors(rooms_doc(shared)) == [])
for label, b in [
    ("a non-script entity", dict(GOOD, entity='light.demo_x')),
    ("a missing entity", {"variables": {"area": "demo_a"}}),
    ("a list as variables", dict(GOOD, variables=["demo_a"])),
    ("a string as variables", dict(GOOD, variables="demo_a")),
    ("an empty label", dict(GOOD, label="")),
    ("an unknown key", dict(GOOD, confirm=False)),
    ("a bad room id", None),
]:
    doc = rooms_doc({"Lounge Room": GOOD}) if b is None else rooms_doc({"lounge": b})
    check(f"schema: rejects {label}", schema_errors(doc) != [])

# ---- 2. validator --------------------------------------------------------------
errs, warns = run(rooms_doc(shared))
check("validator: a clean binding (shared variables) trips nothing", errs == [] and warns == [], (errs, warns))
errs, _ = run(rooms_doc({"ghost": GOOD}))
check("validator: an unknown room is an error", any("ghost" in e for e in errs), errs)
_, warns = run(rooms_doc({"lounge": GOOD}, version="1.6"))
check("validator: below 1.7 is warned", any("1.7" in w for w in warns), warns)

# ---- 3. older versions and the demo -----------------------------------------------
old10 = {"kind": "rooms", "schemaVersion": "1.0", "house": "t", "rooms": {"lounge": {"main": ['light.demo_x']}}}
check("schema: a 1.0 profile with no sensors still validates", schema_errors(old10) == [], schema_errors(old10))
old16 = {"kind": "rooms", "schemaVersion": "1.6", "house": "t", "rooms": {},
         "sensors": {"climate": {"lounge": 'climate.demo_x'}}}
check("schema: a 1.6 profile still validates", schema_errors(old16) == [], schema_errors(old16))
errs, warns = run(old16)
check("validator: a 1.6 profile without roomScripts is not warned about them",
      not any("roomScripts" in w for w in warns), warns)
demo = json.loads((ROOT / "houses" / "demo" / "rooms.json").read_text(encoding="utf-8"))
_demo_ver = tuple(int(x) for x in str(demo.get("schemaVersion") or "0.0").split("."))
check("demo: rooms.json is at 1.7 or newer (roomScripts)", _demo_ver >= (1, 7), demo.get("schemaVersion"))
check("demo: binds roomScripts", bool((demo.get("sensors") or {}).get("roomScripts")))

print(f"{'FAILED' if failures else 'ok'} -- {passes} passed, {failures} failed")
sys.exit(1 if failures else 0)
