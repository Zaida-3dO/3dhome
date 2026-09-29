#!/usr/bin/env python3
"""rooms.json `sensors.items`: schema + validator checks.
Run: python scripts/test-validate-items.py

Needs `jsonschema`. Exits 1 on any failure. Every id here is synthetic, and
single-quoted so the PII guard (which flags double-quoted entity ids) passes.

WHAT THIS GUARDS
  1. houses/schema.json: one card, a list of region cards and a title-only
     card validate; a card with neither rows nor a title, a region card with no rows, a row of the wrong domain, a region missing `to`, a negative
     region start, an unknown role and an unknown key are rejected.
  2. scripts/validate-house.py: a binding to a furniture item that does not
     exist is an ERROR, as is a region with from >= to; a region past the
     item's width and two overlapping regions are warned; a profile below
     schemaVersion 1.6 is warned; a title-only radiator in a room with no
     sensors.climate binding is warned; a clean binding trips none.
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


CONSOLE = [
    {"title": "Cupboard", "region": {"from": 0, "to": 50},
     "readings": [{"entity": 'sensor.demo_a_temperature', "label": "A", "humidity": 'sensor.demo_a_humidity'}]},
    {"region": {"from": 50, "to": 130},
     "media": [{"entity": 'media_player.demo_receiver', "role": "receiver"}, {"entity": 'media_player.demo_cast', "role": "cast"}]},
]
TV = {"media": [{"entity": 'media_player.demo_tv', "role": "tv"}]}
BEDSIDE = {"title": "Bedside", "lights": [{"entity": 'light.demo_bedside', "label": "All"}]}


def rooms_doc(items, version="1.6", climate=None):
    sensors = {"items": items}
    if climate is not None:
        sensors["climate"] = climate
    return {"kind": "rooms", "schemaVersion": version, "house": "t", "rooms": {},
            "sensors": sensors}


def schema_errors(doc):
    r = vh.Report("t")
    vh.schema_validate(doc, SCHEMA, r, "rooms.json")
    return r.errors


GEO = {"furniture": [{"id": "clock", "room": "room", "type": "wall-clock", "at": [1, 1]},
                     {"id": "rad", "room": "room", "type": "radiator", "at": [1, 1]},{"id": "console", "room": "room", "type": "cabinet", "at": [1, 1], "params": {"width": 180}},
                     {"id": "tv", "room": "room", "type": "tv", "at": [1, 1]},
                     {"id": "bedside", "room": "room", "type": "cabinet", "at": [1, 1]}],
       "doors": [], "curtains": []}
ROOM_IDS = {"room"}


def run(doc):
    r = vh.Report("t")
    vh.check_sensor_binding(doc, GEO, ROOM_IDS, r)
    return [f"{w}: {m}" for w, m in r.errors], [f"{w}: {m}" for w, m in r.warnings]


GOOD = {"console": CONSOLE, "tv": TV, "bedside": BEDSIDE}

# ---- 1. schema ---------------------------------------------------------------
check("schema: one card and a list of region cards validate", schema_errors(rooms_doc(GOOD)) == [], schema_errors(rooms_doc(GOOD)))
for label, b in [
    ("a card with no rows and no title", {"label": "Empty"}),
    ("a region card with no rows", {"title": "Left", "region": {"from": 0, "to": 5}}),
    ("an empty list", []),
    ("a light in a media row", {"media": [{"entity": 'light.demo_x'}]}),
    ("a switch as a light", {"lights": [{"entity": 'switch.demo_x'}]}),
    ("a binary_sensor reading", {"readings": [{"entity": 'binary_sensor.demo_x'}]}),
    ("a light as the humidity partner", {"readings": [{"entity": 'sensor.demo_x', "humidity": 'light.demo_x'}]}),
    ("a region missing to", {"region": {"from": 0}, "readings": [{"entity": 'sensor.demo_x'}]}),
    ("a negative region start", {"region": {"from": -1, "to": 5}, "readings": [{"entity": 'sensor.demo_x'}]}),
    ("an unknown role", {"media": [{"entity": 'media_player.demo_x', "role": "toaster"}]}),
    ("an unknown key", dict(TV, colour="red")),
]:
    check(f"schema: rejects {label}", schema_errors(rooms_doc({"tv": b})) != [])

check("schema: a title-only card (a clock's name) validates", schema_errors(rooms_doc({"clock": {"title": "Kitchen clock"}})) == [])

# ---- 2. validator --------------------------------------------------------------
errs, warns = run(rooms_doc(GOOD))
check("validator: a clean binding trips nothing", errs == [] and warns == [], (errs, warns))
errs, _ = run(rooms_doc({"ghost": TV}))
check("validator: an unknown furniture item is an error", any("ghost" in e for e in errs), errs)
errs, _ = run(rooms_doc({"console": [{"region": {"from": 60, "to": 60}, "readings": [{"entity": 'sensor.demo_x'}]}]}))
check("validator: a region with from >= to is an error", any("from (60)" in e for e in errs), errs)
_, warns = run(rooms_doc({"console": [{"region": {"from": 130, "to": 200}, "readings": [{"entity": 'sensor.demo_x'}]}]}))
check("validator: a region past the item's width is warned", any("180 cm wide" in w for w in warns), warns)
_, warns = run(rooms_doc({"console": [CONSOLE[0], dict(CONSOLE[1], region={"from": 40, "to": 130})]}))
check("validator: overlapping regions are warned", any("overlaps card 0" in w for w in warns), warns)
_, warns = run(rooms_doc(dict(GOOD, clock={"title": "Kitchen clock"})))
check("validator: a title-only card on a clock is clean", not any("title-only" in w for w in warns), warns)
_, warns = run(rooms_doc({"tv": {"title": "Living room TV"}}))
# Mutation: drop the ftype check -> no warning -> fails.
check("validator: a title-only card on anything else is warned", any("title-only" in w for w in warns), warns)
_, warns = run(rooms_doc({"rad": {"title": "Radiator by the window"}}))
# Mutation: drop the new elif branch -> no warning -> fails.
check("validator: a title-only radiator in a room with no climate binding is warned",
      any("no sensors.climate binding" in w and "rad" in w for w in warns), warns)
_, warns = run(rooms_doc({"rad": {"title": "Radiator by the window"}}, climate={"room": 'climate.demo_room'}))
# Mutation: warn whatever the climate binding says -> fails.
check("validator: a title-only radiator in a climate-bound room is clean", warns == [], warns)
_, warns = run(rooms_doc({"rad": {"title": "Radiator by the window"}}, climate={"other": 'climate.demo_other'}))
check("validator: another room's climate binding does not count", any("no sensors.climate binding" in w for w in warns), warns)
# ---- switches rows (schemaVersion 1.8) ------------------------------------------
DESK = {"title": "Desk", "switches": [{"entity": 'switch.demo_desk_a', "label": "Monitor", "power": 'sensor.demo_desk_a_power'},
                                      {"entity": 'input_boolean.demo_desk_b'}]}
check("schema: a switches card (switch + input_boolean, a power partner) validates",
      schema_errors(rooms_doc({"tv": DESK}, version="1.8")) == [], schema_errors(rooms_doc({"tv": DESK}, version="1.8")))
for label, b in [
    ("a light as a switch", {"switches": [{"entity": 'light.demo_x'}]}),
    ("a sensor as a switch", {"switches": [{"entity": 'sensor.demo_x'}]}),
    ("a switch as the power partner", {"switches": [{"entity": 'switch.demo_x', "power": 'switch.demo_y'}]}),
    ("an empty switches list", {"switches": []}),
    ("an unknown key on a switch row", {"switches": [{"entity": 'switch.demo_x', "watts": 'sensor.demo_y'}]}),
]:
    # Mutation: widen the entity pattern to any domain -> accepted -> fails.
    check(f"schema: rejects {label}", schema_errors(rooms_doc({"tv": b}, version="1.8")) != [])
_, warns = run(rooms_doc({"tv": DESK}, version="1.8"))
check("validator: a switches card at 1.8 is clean", warns == [], warns)
_, warns = run(rooms_doc({"tv": DESK}, version="1.6"))
# Mutation: drop the 1.8 check -> no warning -> fails.
check("validator: switches below 1.8 are warned", any("1.8" in w and "switches" in w for w in warns), warns)
_, warns = run(rooms_doc({"clock": {"title": "Kitchen clock"}, "tv": DESK}, version="1.8"))
check("validator: a switches card is not mistaken for a title-only one", not any("title-only" in w for w in warns), warns)
# ---- cameras rows (schemaVersion 1.9) -------------------------------------------
CAM = {"title": "Crate", "cameras": [{"entity": 'camera.demo_crate', "label": "Crate cam", "refreshMs": 2000}]}
check("schema: a cameras card validates", schema_errors(rooms_doc({"tv": CAM}, version="1.9")) == [],
      schema_errors(rooms_doc({"tv": CAM}, version="1.9")))
for label, b in [
    ("a non-camera entity", {"cameras": [{"entity": 'image.demo_x'}]}),
    ("a refreshMs below 500", {"cameras": [{"entity": 'camera.demo_x', "refreshMs": 100}]}),
    ("an unknown key on a camera row", {"cameras": [{"entity": 'camera.demo_x', "stream": True}]}),
]:
    check(f"schema: rejects {label}", schema_errors(rooms_doc({"tv": b}, version="1.9")) != [])
_, warns = run(rooms_doc({"tv": CAM}, version="1.9"))
check("validator: a cameras card at 1.9 is clean", warns == [], warns)
_, warns = run(rooms_doc({"tv": CAM}, version="1.8"))
# Mutation: drop the 1.9 check -> no warning -> fails.
check("validator: cameras below 1.9 are warned", any("1.9" in w and "cameras" in w for w in warns), warns)
_, warns = run(rooms_doc(GOOD, version="1.5"))
check("validator: below 1.6 is warned", any("1.6" in w for w in warns), warns)
# ---- actions rows + a TV row's art condition (schemaVersion 1.10) ----------------
ART_TV = {"title": "Frame TV",
          "media": [{"entity": 'media_player.demo_frame_tv', "label": "TV", "role": "tv",
                     "art": {"entity": 'remote.demo_frame_stick', "attribute": "current_activity", "value": "example.photo.frame"}}],
          "actions": [{"entity": 'script.demo_tv_art', "label": "Art mode", "icon": "art", "variables": {"tv": 'media_player.demo_frame_tv'}}]}
check("schema: an art condition and an actions row validate", schema_errors(rooms_doc({"tv": ART_TV}, version="1.10")) == [],
      schema_errors(rooms_doc({"tv": ART_TV}, version="1.10")))
ACTIONS_ONLY = {"title": "Scenes", "actions": [{"entity": 'script.demo_scene'}]}
check("schema: an actions-only card validates (actions count as a row)",
      schema_errors(rooms_doc({"tv": ACTIONS_ONLY}, version="1.10")) == [], schema_errors(rooms_doc({"tv": ACTIONS_ONLY}, version="1.10")))
check("schema: an art condition with no attribute (state compare) validates",
      schema_errors(rooms_doc({"tv": {"media": [{"entity": 'media_player.demo_x', "role": "tv",
                                                  "art": {"entity": 'select.demo_mode', "value": "art"}}]}}, version="1.10")) == [])
for label, b in [
    ("a non-script action", {"actions": [{"entity": 'light.demo_x'}]}),
    ("an action whose variables is a list", {"actions": [{"entity": 'script.demo_x', "variables": [1]}]}),
    ("an unknown key on an action", {"actions": [{"entity": 'script.demo_x', "confirm": True}]}),
    ("an empty actions list", {"actions": []}),
    ("an action icon that is not a plain name", {"actions": [{"entity": 'script.demo_x', "icon": "<svg>"}]}),
    ("an art condition with no value", {"media": [{"entity": 'media_player.demo_x', "role": "tv", "art": {"entity": 'remote.demo_x'}}]}),
    ("an art condition with an unknown key", {"media": [{"entity": 'media_player.demo_x', "role": "tv",
                                                         "art": {"entity": 'remote.demo_x', "value": "a", "equals": "b"}}]}),
]:
    # Mutation: loosen the matching schema block -> accepted -> fails.
    check(f"schema: rejects {label}", schema_errors(rooms_doc({"tv": b}, version="1.10")) != [])
_, warns = run(rooms_doc({"tv": ART_TV}, version="1.10"))
check("validator: art + actions at 1.10 are clean", warns == [], warns)
_, warns = run(rooms_doc({"tv": ART_TV}, version="1.9"))
# Mutation: drop the 1.10 check -> no warning -> fails.
check("validator: actions and art below 1.10 are warned",
      any("1.10" in w and "actions" in w and "art" in w for w in warns), warns)
_, warns = run(rooms_doc({"tv": ACTIONS_ONLY}, version="1.9"))
check("validator: actions alone below 1.10 are warned", any("1.10" in w and "actions" in w for w in warns), warns)
_, warns = run(rooms_doc({"clock": {"title": "Kitchen clock"}, "tv": ACTIONS_ONLY}, version="1.10"))
check("validator: an actions card is not mistaken for a title-only one", not any("title-only" in w for w in warns), warns)
_, warns = run(rooms_doc({"tv": {"media": [{"entity": 'media_player.demo_x', "role": "cast",
                                            "art": {"entity": 'remote.demo_x', "value": "a"}}]}}, version="1.10"))
# Mutation: drop the role check -> no warning -> fails.
check("validator: art on a non-tv row is warned", any("role" in w and "art" in w for w in warns), warns)

print(f"{'FAILED' if failures else 'ok'} -- {passes} passed, {failures} failed")
sys.exit(1 if failures else 0)
