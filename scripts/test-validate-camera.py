#!/usr/bin/env python3
"""geometry.json `camera`: schema + validator checks.
Run: python scripts/test-validate-camera.py

Needs `jsonschema`. Exits 1 on any failure.

WHAT THIS GUARDS
  1. houses/schema.json: the full default block validates; a wrong type, an
     out-of-range value, an unknown key (at any level) are rejected.
  2. scripts/validate-house.py: a maxMoveMs below minMoveMs is an ERROR; a
     profile below schemaVersion 1.7 with a camera block is warned; a clean
     1.7 block trips nothing.
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
DEMO = json.loads((ROOT / "houses" / "demo" / "geometry.json").read_text(encoding="utf-8"))

passes = 0
failures = 0


def check(name, cond, detail=None):
    global passes, failures
    if cond:
        passes += 1
    else:
        failures += 1
        print(f"FAIL {name}" + (f" -- {detail}" if detail is not None else ""))


FULL = {
    "walk": {"speedMps": 5.5, "easeSec": 0.1833, "maxTurnDegPerSec": 500, "minMoveMs": 330, "maxMoveMs": 3000,
             "minTurnMs": 300, "lookAheadM": 1.6, "lookDownDeg": 6, "eyeHeightM": 1.6,
             "sharedSpot": {"enabled": True, "maxDistM": 1.0, "minCoverage": 0.75}},
    "preview": {"rotateSecPerLap": 120, "topHoldLaps": 1, "descentLaps": 0.4, "eyeLevelLaps": 1,
                "ascentLaps": 0.3333, "eyeHeightM": 1.7, "eyeLevelDistanceFactor": 1.5, "eyeLevelExtraM": 3},
    "flight": {"homeToRoomMs": 1200, "betweenOutsideViewsMs": 700},
}


def geo(camera, version="1.7"):
    g = copy.deepcopy(DEMO)
    g["schemaVersion"] = version
    if camera is not None:
        g["camera"] = camera
    return g


def schema_errors(g):
    r = vh.Report("t")
    vh.schema_validate(g, SCHEMA, r, "geometry.json")
    return r.errors


def run(g):
    r = vh.Report("t")
    vh.check_camera(g, r)
    return [f"{w}: {m}" for w, m in r.errors], [f"{w}: {m}" for w, m in r.warnings]


check("schema: the demo without a block validates", schema_errors(geo(None)) == [], schema_errors(geo(None)))
check("schema: the full default block validates", schema_errors(geo(FULL)) == [], schema_errors(geo(FULL)))
check("schema: an empty block validates", schema_errors(geo({})) == [])
for label, cam in [
    ("a string speed", {"walk": {"speedMps": "fast"}}),
    ("speed above its range", {"walk": {"speedMps": 100}}),
    ("speed below its range", {"walk": {"speedMps": 0}}),
    ("lap length below its range", {"preview": {"rotateSecPerLap": 1}}),
    ("a non-boolean enabled", {"walk": {"sharedSpot": {"enabled": "yes"}}}),
    ("an unknown walk key", {"walk": {"warp": 1}}),
    ("an unknown top-level key", {"zoom": {}}),
    ("an unknown sharedSpot key", {"walk": {"sharedSpot": {"x": 1}}}),
    ("coverage above 1", {"walk": {"sharedSpot": {"minCoverage": 1.5}}}),
]:
    check(f"schema: rejects {label}", schema_errors(geo(cam)) != [])

errs, warns = run(geo(FULL))
check("validator: a clean 1.7 block trips nothing", errs == [] and warns == [], (errs, warns))
errs, warns = run(geo(None, version="1.3"))
check("validator: no block, no complaint", errs == [] and warns == [])
errs, _ = run(geo({"walk": {"minMoveMs": 2000, "maxMoveMs": 1000}}))
check("validator: maxMoveMs below minMoveMs is an error", any("maxMoveMs" in e for e in errs), errs)
_, warns = run(geo(FULL, version="1.6"))
check("validator: below 1.7 is warned", any("1.7" in w for w in warns), warns)

print(f"{'FAILED' if failures else 'ok'} -- {passes} passed, {failures} failed")
sys.exit(1 if failures else 0)
