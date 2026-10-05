#!/usr/bin/env python3
"""rooms.json 1.11 `bindings` and `sidebar`, geometry 1.5 fixture `static`:
schema + validator checks.
Run: python scripts/test-validate-bindings.py

Needs `jsonschema`. Exits 1 on any failure. Every id here is synthetic.

WHAT THIS GUARDS
  1. houses/schema.json: a curtain / light binding and a sidebar config
     validate; an unknown target key, an unknown channel, a transform outside
     the closed list, an extra of the wrong domain or kind, a `show` that is
     not an item key, and a fixture `static` with a bad colour are rejected.
  2. scripts/validate-house.py: a target bound BOTH in `bindings` and in its
     legacy slot is an ERROR (curtain and light); a channel bound to the wrong
     domain is an ERROR; a binding / sidebar for a curtain, room or item that
     does not exist is an ERROR; below 1.11 is warned; a fixture `static`
     below geometry 1.5 is warned; a static or `bindings`-bound fixture is no
     longer warned as "permanently off"; a clean profile trips none of them.
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


GEO = {
    "kind": "geometry", "schemaVersion": "1.5", "id": "t", "name": "T",
    "rooms": [{"id": "lounge"}, {"id": "study"}],
    "curtains": [{"id": "sheer", "room": "lounge"}],
    "doors": [{"id": "front"}],
    "furniture": [{"id": "lamp", "room": "lounge"}],
    "lights": [{"room": "lounge", "fixtures": [{"channel": "main"}, {"channel": "ambient", "static": {"on": True, "brightness": 40}}]},
               {"room": "study", "fixtures": [{"channel": "ambient"}]}],
}

GOOD = {
    "kind": "rooms", "schemaVersion": "1.11", "house": "t",
    "rooms": {"lounge": {"main": ["light.demo_lounge"]}},
    "sensors": {"items": {"lamp": {"lights": [{"entity": "light.demo_lamp"}]}}},
    "bindings": {
        "curtain:sheer": {"openPct": {"entity": "cover.demo_sheer", "transform": "invert"}},
        "light:study/ambient": {"on": {"entity": "light.demo_a"}, "brightness": {"entity": "light.demo_b", "transform": "identity"}},
    },
    "sidebar": {"lounge": {
        "hide": ["main", "ambient", "doors", "curtain:sheer"],
        "show": ["item:lamp"],
        "extra": [{"kind": "script", "entity": "script.demo_kill", "label": "Kill room", "confirm": True},
                  {"kind": "light", "entity": "light.demo_group", "label": "Ambient"},
                  {"kind": "switch", "entity": "input_boolean.demo_mode", "label": "Guest"}],
    }},
}


def schema_errors(doc):
    r = vh.Report("t")
    vh.schema_validate(doc, SCHEMA, r, "rooms.json" if doc.get("kind") == "rooms" else "geometry.json")
    return r.errors


def cross(rooms, geo=GEO):
    r = vh.Report("t")
    vh.check_rooms_binding(rooms, geo, r)
    return r


def mutate(fn, base=GOOD):
    d = copy.deepcopy(base)
    fn(d)
    return d


# ---- 1. schema --------------------------------------------------------------
check("schema: a full bindings + sidebar profile validates", schema_errors(GOOD) == [], schema_errors(GOOD))
for name, fn in [
    ("unknown target key", lambda d: d["bindings"].update({"fan:x": {"on": {"entity": "light.demo_x"}}})),
    ("unknown channel", lambda d: d["bindings"]["curtain:sheer"].update({"tilt": {"entity": "cover.demo_x"}})),
    ("a transform outside the closed list", lambda d: d["bindings"]["curtain:sheer"]["openPct"].update({"transform": "x*2"})),
    ("an empty binding entry", lambda d: d["bindings"].update({"curtain:other": {}})),
    ("an extra light bound to a cover", lambda d: d["sidebar"]["lounge"]["extra"][1].update({"entity": "cover.demo_x"})),
    ("an extra script bound to a light", lambda d: d["sidebar"]["lounge"]["extra"][0].update({"entity": "light.demo_x"})),
    ("an extra of an unknown kind", lambda d: d["sidebar"]["lounge"]["extra"][0].update({"kind": "fan"})),
    ("an extra with no label", lambda d: d["sidebar"]["lounge"]["extra"][0].pop("label")),
    ("a show entry that is not an item", lambda d: d["sidebar"]["lounge"].update({"show": ["main"]})),
    ("a hide entry that names no derived row", lambda d: d["sidebar"]["lounge"].update({"hide": ["sofa"]})),
]:
    check(f"schema rejects {name}", schema_errors(mutate(fn)) != [])
FIXTURE = {"$ref": "#/$defs/lightFixture", "$defs": SCHEMA["$defs"]}


def fixture_ok(fx):
    return not list(jsonschema.Draft202012Validator(FIXTURE).iter_errors(fx))


check("schema: a fixture static validates", fixture_ok({"channel": "ambient", "static": {"on": True, "brightness": 40, "color": "#00ccff"}}))
check("schema: a fixture static carrying an entity id as its colour is rejected",
      not fixture_ok({"channel": "ambient", "static": {"color": "light.demo_x"}}))
check("schema: a fixture static brightness over 100 is rejected", not fixture_ok({"channel": "ambient", "static": {"brightness": 140}}))
check("schema: an unknown static key (an entity) is rejected", not fixture_ok({"channel": "ambient", "static": {"entity": "light.demo_x"}}))

# ---- 2. cross-file checks ---------------------------------------------------------
r = cross(GOOD)
check("clean profile: no errors", r.errors == [], r.errors)
check("clean profile: no bindings/sidebar version warning", not any("1.11" in m for _, m in r.warnings), r.warnings)
check("a static fixture is not warned as permanently off",
      not any("lights/lounge/ambient" in w for w, _ in r.warnings), r.warnings)
check("a `bindings`-bound fixture is not warned as permanently off",
      not any("lights/study/ambient" in w for w, _ in r.warnings), r.warnings)

r = cross(mutate(lambda d: d["sensors"].update({"curtains": {"sheer": ["cover.demo_sheer"]}})))
check("curtain bound in BOTH places: an error", any("both" in m and "sheer" in m for _, m in r.errors), r.errors)
r = cross(mutate(lambda d: d["rooms"].update({"study": {"ambient": ["light.demo_a"]}})))
check("light channel bound in BOTH places: an error", any("both" in m and "study/ambient" in m for _, m in r.errors), r.errors)
r = cross(mutate(lambda d: d["bindings"]["curtain:sheer"]["openPct"].update({"entity": "light.demo_x"})))
check("openPct bound to a light: an error", any("cover" in m for _, m in r.errors), r.errors)
r = cross(mutate(lambda d: d["bindings"].update({"curtain:gone": {"openPct": {"entity": "cover.demo_x"}}})))
check("a binding to a curtain that does not exist: an error", any("gone" in m for _, m in r.errors), r.errors)
r = cross(mutate(lambda d: d["sidebar"].update({"attic": {"hide": ["main"]}})))
check("a sidebar for a room that does not exist: an error", any("attic" in m for _, m in r.errors), r.errors)
r = cross(mutate(lambda d: d["sidebar"]["lounge"].update({"show": ["item:gone"]})))
check("show names an item that does not exist: an error", any("item:gone" in m for _, m in r.errors), r.errors)
r = cross(mutate(lambda d: d["sensors"].pop("items")))
check("show names an item with no card: a warning", any("no sensors.items card" in m for _, m in r.warnings), r.warnings)
r = cross(mutate(lambda d: d.update({"schemaVersion": "1.10"})))
check("bindings / sidebar below 1.11: warned", any("1.11" in m for _, m in r.warnings), r.warnings)

g = copy.deepcopy(GEO)
g["schemaVersion"] = "1.4"
rep = vh.Report("t")
vh.check_fixture_statics(g, rep)
check("a fixture static below geometry 1.5: warned", any("1.5" in m for _, m in rep.warnings), rep.warnings)
rep = vh.Report("t")
vh.check_fixture_statics(GEO, rep)
check("... and not at 1.5", rep.warnings == [], rep.warnings)

print(f"{'ok' if not failures else 'FAILED'} -- {passes} passed, {failures} failed")
sys.exit(1 if failures else 0)
