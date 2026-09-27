#!/usr/bin/env python3
"""validate-house.py's footstepPath checks. Run: python scripts/test-validate-footstep-path.py

WHAT THIS GUARDS
  1. A waypoint outside the room polygon is an ERROR (the engine ignores the
     whole path).
  2. A segment that leaves the room between two in-room waypoints (cutting a
     notch) is a WARNING.
  3. A path the 40cm door gap strips of EVERY print -- which the engine
     renders as nothing, silently -- is a WARNING.
  4. A clean path trips none of them, so a check that fires on everything
     fails too.

Every number here is synthetic.
"""

import copy
import importlib.util
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("validate_house", ROOT / "scripts" / "validate-house.py")
vh = importlib.util.module_from_spec(spec)
spec.loader.exec_module(vh)

passes = failures = 0


def check(name, cond, detail=None):
    global passes, failures
    if cond:
        passes += 1
        print(f"PASS {name}")
    else:
        failures += 1
        print(f"FAIL {name}" + (f" -- {detail}" if detail is not None else ""))


# An L: 600 x 150 east-west leg along y 2000..2150, and a 150-wide leg rising
# south at the east end (x 2450..2600, y 2000..2600). One door in the WEST
# wall (x=2000), centred y=2075.
BASE = {
    "kind": "geometry", "schemaVersion": "1.2", "id": "t", "name": "T", "units": "cm",
    "coordinateTransform": {"originX": 0, "originY": 0, "scale": 0.01},
    "defaults": {"wallHeight": 250, "wallThickness": 10},
    "rooms": [{"id": "r", "label": "R", "polygon": [
        [2000, 2000], [2600, 2000], [2600, 2600], [2450, 2600], [2450, 2150], [2000, 2150]]}],
    "walls": {"segments": [
        {"id": 1, "start": [2000, 2000], "end": [2000, 2150], "thickness": 10},
    ]},
    "doors": [{"id": "d", "wall": 1, "centre": 2075, "width": 80, "hinge": "north",
               "swing": "east", "maxOpenDegrees": 90, "room": "r"}],
}


def run(path):
    geo = copy.deepcopy(BASE)
    geo["rooms"][0]["footstepPath"] = dict(path, relativeTo="room")
    rep = vh.Report("t")
    vh.check_geometry(geo, rep)
    fp = [(w, m) for w, m in rep.errors if "footstepPath" in w]
    wp = [(w, m) for w, m in rep.warnings if "footstepPath" in w]
    return fp, wp


# Relative to the bbox min corner (2000, 2000).
clean_e, clean_w = run({"points": [[100, 75], [525, 75], [525, 550]]})
check("clean L path: no footstepPath errors", not clean_e, clean_e)
check("clean L path: no footstepPath warnings", not clean_w, clean_w)

out_e, _ = run({"points": [[100, 75], [300, 400]]})
check("waypoint outside the room is an ERROR", any("points/1" in w for w, _ in out_e), out_e)

_, cut_w = run({"points": [[100, 75], [525, 550]], "smooth": False})
check("segment cutting the notch WARNS", any("leaves the room" in m for _, m in cut_w), cut_w)

gap_e, gap_w = run({"points": [[5, 70], [25, 80]]})
check("path wholly inside the door gap WARNS 'no print survives'",
      any("NO footsteps" in m for _, m in gap_w), gap_w)
check("...and is not an error", not gap_e, gap_e)

_, part_w = run({"points": [[10, 75], [300, 75]]})
check("path partly in the door gap WARNS how many prints are dropped",
      any("door gap" in m and "not drawn" in m for _, m in part_w), part_w)
check("...but not 'no print survives'", not any("NO footsteps" in m for _, m in part_w), part_w)

print(f"\n{passes} passed, {failures} failed")
sys.exit(1 if failures else 0)
