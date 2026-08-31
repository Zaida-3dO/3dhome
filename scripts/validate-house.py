#!/usr/bin/env python3
"""Validate a 3dHome house profile against houses/schema.json.

Usage:
    python scripts/validate-house.py houses/demo
    python scripts/validate-house.py houses/demo/geometry.json
    python scripts/validate-house.py houses/*/          # several at once

Pass a directory and both geometry.json and rooms.json are validated (rooms.json
is optional), plus the cross-file checks. Pass a single file and only that file
is checked.

Exit status is 0 when everything passes, 1 on any error. Warnings never fail the
run -- a half-wired house is a legitimate work-in-progress.

Requires `jsonschema` (pip install jsonschema). Without it the script still runs
the structural and cross-reference checks below and says so, so CI without the
dependency degrades rather than passing silently.
"""

import sys
import json
import glob
import math
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
SCHEMA_PATH = REPO_ROOT / "houses" / "schema.json"

RED = "\033[31m"
YELLOW = "\033[33m"
GREEN = "\033[32m"
DIM = "\033[2m"
OFF = "\033[0m"
if not sys.stdout.isatty():
    RED = YELLOW = GREEN = DIM = OFF = ""

# Compass axes: which pairs are parallel.
HORIZONTAL = {"east", "west"}     # along plan x
VERTICAL = {"north", "south"}     # along plan y


class Report:
    def __init__(self, label):
        self.label = label
        self.errors = []
        self.warnings = []

    def error(self, where, msg):
        self.errors.append((where, msg))

    def warn(self, where, msg):
        self.warnings.append((where, msg))

    @property
    def ok(self):
        return not self.errors


def load_json(path, report):
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except FileNotFoundError:
        report.error(str(path), "file not found")
    except json.JSONDecodeError as exc:
        report.error(str(path), f"invalid JSON: {exc}")
    return None


def schema_validate(doc, schema, report, where):
    """Validate against the JSON Schema. Returns True if jsonschema was available."""
    try:
        import jsonschema
    except ImportError:
        return False

    validator_cls = jsonschema.validators.validator_for(schema)
    validator_cls.check_schema(schema)
    validator = validator_cls(schema)

    errors = sorted(validator.iter_errors(doc), key=lambda e: list(e.absolute_path))
    for err in errors:
        # A `oneOf` failure reports every branch; keep the branch that matches the
        # document's own `kind` so the message points at the real problem.
        if err.validator == "oneOf" and isinstance(doc, dict) and "kind" in doc:
            best = None
            for sub in err.context or []:
                branch = sub.schema_path[0] if sub.schema_path else None
                if branch is not None and _branch_kind(schema, branch) == doc.get("kind"):
                    best = sub if best is None else best
            if best is not None:
                path = "/".join(str(p) for p in best.absolute_path) or "(root)"
                report.error(f"{where}:{path}", best.message)
                continue
        path = "/".join(str(p) for p in err.absolute_path) or "(root)"
        report.error(f"{where}:{path}", err.message)
    return True


def _branch_kind(schema, index):
    try:
        ref = schema["oneOf"][index]["$ref"].split("/")[-1]
        return schema["$defs"][ref]["properties"]["kind"]["const"]
    except (KeyError, IndexError, TypeError):
        return None


def shoelace_area_cm2(polygon):
    total = 0.0
    n = len(polygon)
    for i in range(n):
        x1, y1 = polygon[i]
        x2, y2 = polygon[(i + 1) % n]
        total += x1 * y2 - x2 * y1
    return abs(total) / 2.0


def check_geometry(geo, report):
    """Cross-reference and semantic checks a JSON Schema cannot express."""
    rooms = geo.get("rooms", [])
    room_ids = set()
    for room in rooms:
        rid = room.get("id")
        if rid in room_ids:
            report.error(f"rooms/{rid}", "duplicate room id -- room ids are the join key and must be unique")
        room_ids.add(rid)

        poly = room.get("polygon") or []
        if len(poly) >= 3:
            # Degenerate polygon: zero area.
            area_cm2 = shoelace_area_cm2(poly)
            if area_cm2 <= 0:
                report.error(f"rooms/{rid}", "polygon has zero area (collinear or self-cancelling points)")
            elif "areaSqm" in room:
                computed = area_cm2 / 10000.0
                declared = room["areaSqm"]
                if declared > 0 and abs(computed - declared) / declared > 0.02:
                    report.warn(
                        f"rooms/{rid}",
                        f"declared areaSqm {declared} differs from the polygon's {computed:.2f} m2 "
                        f"by {abs(computed - declared) / declared * 100:.1f}% -- one of them is stale",
                    )
            # First point repeated at the end is the commonest authoring mistake.
            if len(poly) > 3 and poly[0] == poly[-1]:
                report.warn(f"rooms/{rid}", "polygon repeats its first point at the end; the ring closes implicitly, drop it")

    walls = geo.get("walls", {})
    segments = walls.get("segments", [])
    wall_ids = {}
    highest = walls.get("highestIdEverAssigned")
    for w in segments:
        wid = w.get("id")
        if wid in wall_ids:
            report.error(f"walls/{wid}", "duplicate wall id -- wall numbers are permanent and must be unique")
        wall_ids[wid] = w
        if highest is not None and isinstance(wid, int) and wid > highest:
            report.error(
                f"walls/{wid}",
                f"wall id {wid} exceeds highestIdEverAssigned ({highest}) -- bump that field when minting an id",
            )
        start, end = w.get("start"), w.get("end")
        if start and end and start == end:
            report.error(f"walls/{wid}", "start and end are the same point (zero-length wall)")

    for door in geo.get("doors", []):
        did = door.get("id", "?")
        wid = door.get("wall")
        if wid not in wall_ids:
            report.error(f"doors/{did}", f"references wall {wid}, which does not exist")
        else:
            wall = wall_ids[wid]
            start, end = wall.get("start"), wall.get("end")
            if start and end:
                horizontal_wall = abs(start[1] - end[1]) < abs(start[0] - end[0])
                axis_index = 0 if horizontal_wall else 1
                lo, hi = sorted((start[axis_index], end[axis_index]))
                centre = door.get("centre")
                half = door.get("width", 0) / 2.0
                if centre is not None and not (lo - 1e-6 <= centre <= hi + 1e-6):
                    report.error(
                        f"doors/{did}",
                        f"centre {centre} is outside wall {wid}'s span ({lo}..{hi})",
                    )
                elif centre is not None and (centre - half < lo - 1e-6 or centre + half > hi + 1e-6):
                    report.warn(
                        f"doors/{did}",
                        f"opening ({centre - half:.1f}..{centre + half:.1f}) overhangs wall {wid}'s span "
                        f"({lo}..{hi}) -- the frame will run past the wall's end",
                    )
                # Hinge must lie along the wall; swing must cross it.
                hinge, swing = door.get("hinge"), door.get("swing")
                expected_hinge = HORIZONTAL if horizontal_wall else VERTICAL
                expected_swing = VERTICAL if horizontal_wall else HORIZONTAL
                orient = "east-west" if horizontal_wall else "north-south"
                if hinge and hinge not in expected_hinge:
                    report.error(
                        f"doors/{did}",
                        f"hinge '{hinge}' is not along wall {wid}, which runs {orient}; "
                        f"expected one of {sorted(expected_hinge)}",
                    )
                if swing and swing not in expected_swing:
                    report.error(
                        f"doors/{did}",
                        f"swing '{swing}' does not cross wall {wid}, which runs {orient}; "
                        f"expected one of {sorted(expected_swing)} -- a leaf swinging along its own wall "
                        f"renders embedded in it",
                    )
        rid = door.get("room")
        if rid is not None and rid not in room_ids:
            report.error(f"doors/{did}", f"room '{rid}' is not a room in this profile")
        ang = door.get("maxOpenDegrees")
        kind = door.get("kind", "standard")
        if ang is not None and kind == "cupboard" and ang > 45:
            report.warn(
                f"doors/{did}",
                f"cupboard door opens to {ang} deg -- cupboard doors are usually stopped around 25-30 deg; "
                f"check this is really unobstructed",
            )

    seen_channels = set()
    for entry in geo.get("lights", []):
        rid = entry.get("room")
        if rid not in room_ids:
            report.error(f"lights/{rid}", f"room '{rid}' is not a room in this profile")
        for fixture in entry.get("fixtures", []):
            ch = fixture.get("channel")
            key = (rid, ch)
            if key in seen_channels:
                report.error(f"lights/{rid}/{ch}", "duplicate channel for this room")
            seen_channels.add(key)
            if not fixture.get("positions") and not fixture.get("count"):
                report.warn(
                    f"lights/{rid}/{ch}",
                    "neither positions nor count given -- the engine will place a single fixture at the room centroid",
                )

    # Texture paths must exist on disk when we know the profile directory.
    profile_dir = geo.get("__dir__")
    if profile_dir:
        for w in segments:
            ft = w.get("faceTexture")
            if ft:
                _check_texture(ft.get("texture"), profile_dir, f"walls/{w.get('id')}/faceTexture", report)
                clip = ft.get("clipToRoom")
                if clip is not None and clip not in room_ids:
                    report.error(f"walls/{w.get('id')}/faceTexture", f"clipToRoom '{clip}' is not a room in this profile")
        for room in rooms:
            rug = room.get("rug") or {}
            _check_texture(rug.get("texture"), profile_dir, f"rooms/{room.get('id')}/rug", report)

    site = geo.get("site")
    if site and abs(site.get("latitude", 0)) > 0:
        lat = site["latitude"]
        # More than 3 decimal places is ~100 m precision -- that is a building, not a city.
        if len(str(lat).split(".")[-1]) > 3 and "." in str(lat):
            report.warn(
                "site/latitude",
                f"latitude {lat} is given to sub-100m precision; the sun rig only needs city-level accuracy "
                f"and a published profile should not locate a building",
            )

    return room_ids, seen_channels


def _check_texture(texture, profile_dir, where, report):
    if not texture:
        return
    path = texture.get("path")
    if not path:
        return
    resolved = Path(profile_dir) / path
    if not resolved.exists():
        report.error(where, f"texture '{path}' not found (looked for {resolved})")


def check_rooms_binding(rooms_doc, geo, report):
    if geo is None:
        return
    geo_room_ids = {r.get("id") for r in geo.get("rooms", [])}
    geo_channels = set()
    for entry in geo.get("lights", []):
        for fixture in entry.get("fixtures", []):
            geo_channels.add((entry.get("room"), fixture.get("channel")))

    if rooms_doc.get("house") != geo.get("id"):
        report.error(
            "rooms.json/house",
            f"house '{rooms_doc.get('house')}' does not match the geometry profile's id '{geo.get('id')}'",
        )

    for rid, channels in (rooms_doc.get("rooms") or {}).items():
        if rid not in geo_room_ids:
            report.error(f"rooms.json/rooms/{rid}", f"room '{rid}' has no matching room in geometry.json")
            continue
        for ch in channels:
            if (rid, ch) not in geo_channels:
                report.warn(
                    f"rooms.json/rooms/{rid}/{ch}",
                    "entities bound to a channel with no fixtures in geometry.json -- "
                    "the entity will switch nothing visible",
                )

    for rid, ch in sorted(x for x in geo_channels if x[0] is not None):
        bound = (rooms_doc.get("rooms") or {}).get(rid, {})
        if ch not in bound:
            report.warn(
                f"geometry.json/lights/{rid}/{ch}",
                "fixtures with no entity binding in rooms.json -- they will render as permanently off",
            )


def validate_target(target, schema):
    target = Path(target)
    report = Report(str(target))

    if target.is_dir():
        geo_path = target / "geometry.json"
        rooms_path = target / "rooms.json"
        geo = load_json(geo_path, report)
        used_schema = False
        if geo is not None:
            used_schema = schema_validate(geo, schema, report, "geometry.json")
            geo["__dir__"] = str(target)
            check_geometry(geo, report)
            geo.pop("__dir__", None)
        if rooms_path.exists():
            rooms_doc = load_json(rooms_path, report)
            if rooms_doc is not None:
                schema_validate(rooms_doc, schema, report, "rooms.json")
                check_rooms_binding(rooms_doc, geo, report)
        else:
            report.warn(str(target), "no rooms.json -- the house will render with no Home Assistant binding")
        return report, used_schema

    doc = load_json(target, report)
    used_schema = False
    if doc is not None:
        used_schema = schema_validate(doc, schema, report, target.name)
        if doc.get("kind") == "geometry":
            doc["__dir__"] = str(target.parent)
            check_geometry(doc, report)
            doc.pop("__dir__", None)
    return report, used_schema


def main(argv):
    if len(argv) < 2:
        print(__doc__)
        return 2

    with open(SCHEMA_PATH, encoding="utf-8") as fh:
        schema = json.load(fh)

    targets = []
    for arg in argv[1:]:
        expanded = glob.glob(arg)
        targets.extend(expanded or [arg])

    any_schema = False
    failed = 0
    for target in targets:
        report, used_schema = validate_target(target, schema)
        any_schema = any_schema or used_schema
        for where, msg in report.warnings:
            print(f"{YELLOW}warn {OFF} {where}: {msg}")
        for where, msg in report.errors:
            print(f"{RED}ERROR{OFF} {where}: {msg}")
        if report.ok:
            counts = f" ({len(report.warnings)} warning{'s' if len(report.warnings) != 1 else ''})" if report.warnings else ""
            print(f"{GREEN}PASS {OFF} {report.label}{counts}")
        else:
            print(f"{RED}FAIL {OFF} {report.label} -- {len(report.errors)} error(s)")
            failed += 1

    if not any_schema:
        print(
            f"{YELLOW}note {OFF} jsonschema is not installed, so only the structural and cross-reference "
            f"checks ran. Install it (pip install jsonschema) for full schema validation."
        )

    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
