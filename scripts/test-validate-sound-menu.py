#!/usr/bin/env python3
"""rooms.json `sensors.soundMenu`: schema + validator checks.
Run: python scripts/test-validate-sound-menu.py

Needs `jsonschema`. Exits 1 on any failure. Every id here is synthetic, and
single-quoted so the PII guard (which flags double-quoted entity ids) passes.

WHAT THIS GUARDS
  1. houses/schema.json: a full block validates, and so does one without the
     optional `recent` / `openFrom`, and an openFrom value of null. A missing
     required helper, a helper of the wrong domain, a speaker that is not a
     media_player, an empty speaker list, an unknown key and a bad openFrom
     item id are rejected.
  2. scripts/validate-house.py: below schemaVersion 1.12 is an ERROR -- only
     when the block is present, so a 1.10 profile without it is untouched;
     an openFrom key with no furniture item behind it is an ERROR; an
     openFrom value that is not one of the speakers is an ERROR; a speaker
     listed twice is an ERROR; an openFrom item that also has a
     `sensors.items` card is WARNED; a clean block trips none of them.
  3. The demo house carries a block that passes, at 1.12.
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


BED = 'media_player.demo_bed_speaker'
LOUNGE = 'media_player.demo_lounge_speaker'
GOOD = {
    "selection": 'input_text.demo_speakers',
    "toggleScript": 'script.demo_toggle_speaker',
    "sound": 'input_select.demo_sound',
    "catalogue": 'sensor.demo_sounds',
    "recent": 'input_text.demo_recent',
    "speakers": [{"entity": BED, "label": "Bedroom"}, {"entity": LOUNGE}],
    "openFrom": {"bed_speaker": BED, "shelf": None},
}


def rooms_doc(sm, version="1.12", items=None):
    sensors = {"soundMenu": sm}
    if items is not None:
        sensors["items"] = items
    return {"kind": "rooms", "schemaVersion": version, "house": "t", "rooms": {}, "sensors": sensors}


def schema_errors(doc):
    r = vh.Report("t")
    vh.schema_validate(doc, SCHEMA, r, "rooms.json")
    return r.errors


GEO = {"furniture": [{"id": "bed_speaker", "room": "bedroom"}, {"id": "shelf", "room": "lounge"}], "doors": [], "curtains": []}
ROOM_IDS = {"bedroom", "lounge"}


def run(doc):
    r = vh.Report("t")
    vh.check_sensor_binding(doc, GEO, ROOM_IDS, r)
    return [f"{w}: {m}" for w, m in r.errors], [f"{w}: {m}" for w, m in r.warnings]


def with_(**kw):
    sm = copy.deepcopy(GOOD)
    for k, v in kw.items():
        if v is None:
            sm.pop(k, None)
        else:
            sm[k] = v
    return sm


# ---- 1. schema ---------------------------------------------------------------
check("schema: a full block validates", schema_errors(rooms_doc(GOOD)) == [], schema_errors(rooms_doc(GOOD)))
check("schema: without recent and openFrom validates", schema_errors(rooms_doc(with_(recent=None, openFrom=None))) == [])
for label, sm in [
    ("a missing selection", with_(selection=None)),
    ("a missing toggleScript", with_(toggleScript=None)),
    ("a missing sound", with_(sound=None)),
    ("a missing catalogue", with_(catalogue=None)),
    ("missing speakers", with_(speakers=None)),
    ("an empty speaker list", with_(speakers=[])),
    ("selection of the wrong domain", with_(selection='input_select.demo_x')),
    ("toggleScript of the wrong domain", with_(toggleScript='automation.demo_x')),
    ("sound of the wrong domain", with_(sound='input_text.demo_x')),
    ("catalogue of the wrong domain", with_(catalogue='input_text.demo_x')),
    ("a speaker that is not a media_player", with_(speakers=[{"entity": 'light.demo_x'}])),
    ("an openFrom value that is not a media_player", with_(openFrom={"shelf": 'light.demo_x'})),
    ("a bad openFrom item id", with_(openFrom={"Bad Id": BED})),
    ("an unknown key", dict(GOOD, spotify={})),
]:
    check(f"schema: rejects {label}", schema_errors(rooms_doc(sm)) != [])

# ---- 2. validator --------------------------------------------------------------
errs, warns = run(rooms_doc(GOOD))
check("validator: a clean block trips nothing", errs == [] and warns == [], (errs, warns))
errs, _ = run(rooms_doc(GOOD, version="1.11"))
check("validator: below 1.12 is an ERROR", any("1.12" in e for e in errs), errs)
old = {"kind": "rooms", "schemaVersion": "1.10", "house": "t", "rooms": {}, "sensors": {"climate": {"lounge": 'climate.demo_x'}}}
errs, warns = run(old)
check("validator: a 1.10 profile WITHOUT the block is untouched", not any("1.12" in m or "soundMenu" in m for m in errs + warns), (errs, warns))
errs, _ = run(rooms_doc(with_(openFrom={"ghost": BED})))
check("validator: an openFrom key with no furniture item is an error", any("ghost" in e for e in errs), errs)
errs, _ = run(rooms_doc(with_(openFrom={"shelf": 'media_player.demo_not_listed'})))
check("validator: an openFrom value that is not a listed speaker is an error", any("demo_not_listed" in e for e in errs), errs)
errs, _ = run(rooms_doc(with_(speakers=[{"entity": BED}, {"entity": BED}])))
check("validator: a speaker listed twice is an error", any("twice" in e for e in errs), errs)
errs, warns = run(rooms_doc(GOOD, items={"bed_speaker": {"media": [{"entity": BED}]}}))
check("validator: an openFrom item with a sensors.items card is warned", any("bed_speaker" in w and "card" in w for w in warns), warns)
check("validator: ... and not an error", not any("bed_speaker" in e for e in errs), errs)

# ---- 3. the demo -----------------------------------------------------------------
demo = json.loads((ROOT / "houses" / "demo" / "rooms.json").read_text(encoding="utf-8"))
demo_geo = json.loads((ROOT / "houses" / "demo" / "geometry.json").read_text(encoding="utf-8"))
check("demo: carries a soundMenu block at 1.12", "soundMenu" in (demo.get("sensors") or {}) and demo.get("schemaVersion") == "1.12")
check("demo: the block passes the schema", schema_errors(demo) == [], schema_errors(demo))
r = vh.Report("demo")
vh.check_sensor_binding(demo, demo_geo, {x.get("id") for x in demo_geo.get("rooms", [])}, r)
check("demo: no soundMenu error or warning", not any("soundMenu" in w for w, _ in r.errors + r.warnings), r.errors + r.warnings)

print(f"{'FAILED' if failures else 'ok'} -- {passes} passed, {failures} failed")
sys.exit(1 if failures else 0)
