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

Requires `jsonschema` (pip install jsonschema) for full schema validation. Without
it the script still runs the structural and cross-reference checks below and
prints PARTIAL rather than PASS, so the word on screen always matches what
actually ran. PARTIAL still exits 0 by default -- the checks that did run are
real -- unless --strict is given, which turns a missing jsonschema into a
failure (exit 1). Pass --strict wherever "green means fully checked" matters,
e.g. a pre-commit hook on a machine that may not have the dependency.
"""

import sys
import json
import glob
import math
import re
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


def check_geometry(geo, report, schema=None):
    """Cross-reference and semantic checks a JSON Schema cannot express.

    `schema` is only read for the furniture types' `default` params (footprint
    checks); without it those checks are skipped with a warning.
    """
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

    rooms_by_id = {r.get("id"): r for r in rooms}
    check_wall_fittings(geo, wall_ids, room_ids, report, rooms_by_id)
    check_furniture(geo, wall_ids, rooms_by_id, report, schema)

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


def _wall_axis(wall):
    """(horizontal, lo, hi) for an axis-aligned wall, or None for a diagonal one."""
    start, end = wall.get("start"), wall.get("end")
    if not start or not end:
        return None
    dx, dy = abs(start[0] - end[0]), abs(start[1] - end[1])
    if dx >= 0.5 and dy >= 0.5:
        return None
    horizontal = dy < dx
    i = 0 if horizontal else 1
    lo, hi = sorted((start[i], end[i]))
    return horizontal, lo, hi


def check_wall_fittings(geo, wall_ids, room_ids, report, rooms_by_id=None):
    """Windows and curtains: the references the schema cannot follow.

    Both are positioned like a door (wall id + centre along it), so the same
    failures apply -- a wall that does not exist, a centre off the end of it, a
    room that is not in the profile. The engine skips a broken entry with a
    console warning; this makes the same mistake visible before deploy.
    """
    windows = geo.get("windows", [])
    curtains = geo.get("curtains", [])
    if not windows and not curtains:
        return

    # Same reasoning as the `sensors` version check below: the schema accepts
    # these keys whatever version a profile declares, so this warning is the
    # only signal that a profile claims an older version than it uses.
    version = str(geo.get("schemaVersion") or "")
    try:
        major, minor = (int(part) for part in version.split(".", 1))
    except ValueError:
        major = minor = -1
    if (major, minor) < (1, 1):
        report.warn(
            "geometry.json/schemaVersion",
            f"`windows`/`curtains` need schemaVersion 1.1 or newer, but this profile declares '{version}' -- bump it",
        )

    for kind, items in (("windows", windows), ("curtains", curtains)):
        seen = set()
        for item in items:
            iid = item.get("id", "?")
            where = f"{kind}/{iid}"
            if iid in seen:
                report.error(where, f"duplicate {kind[:-1]} id")
            seen.add(iid)
            rid = item.get("room")
            if rid is not None and rid not in room_ids:
                report.error(where, f"room '{rid}' is not a room in this profile")
            wid = item.get("wall")
            if wid not in wall_ids:
                report.error(where, f"references wall {wid}, which does not exist")
                continue
            axis = _wall_axis(wall_ids[wid])
            if axis is None:
                report.error(where, f"wall {wid} is not axis-aligned; openings can only be cut in walls along x or y")
                continue
            horizontal, lo, hi = axis
            centre = item.get("centre")
            half = item.get("width", 0) / 2.0
            if centre is not None and not (lo - 1e-6 <= centre <= hi + 1e-6):
                report.error(where, f"centre {centre} is outside wall {wid}'s span ({lo}..{hi})")
            elif centre is not None and (centre - half < lo - 1e-6 or centre + half > hi + 1e-6):
                report.warn(
                    where,
                    f"span ({centre - half:.1f}..{centre + half:.1f}) overhangs wall {wid}'s span ({lo}..{hi})",
                )
            room = (rooms_by_id or {}).get(rid)
            if room is not None:
                check_wall_side(where, room, wall_ids[wid], centre, item.get("width"), geo, report)
            if kind == "windows":
                for tid in item.get("throughWalls", []):
                    if tid not in wall_ids:
                        report.error(where, f"throughWalls names wall {tid}, which does not exist")
                        continue
                    t_axis = _wall_axis(wall_ids[tid])
                    if t_axis is None or t_axis[0] != horizontal:
                        report.error(where, f"throughWalls wall {tid} is not parallel to wall {wid}")
                side = item.get("doorSide")
                if side is not None:
                    if item.get("kind") != "balcony":
                        report.warn(where, "doorSide is only used by kind 'balcony' -- ignored")
                    elif side not in (HORIZONTAL if horizontal else VERTICAL):
                        report.error(
                            where,
                            f"doorSide '{side}' is not an end of wall {wid}; expected one of "
                            f"{sorted(HORIZONTAL if horizontal else VERTICAL)}",
                        )
            else:
                pleats = item.get("outerPleats", 5) + item.get("innerPleats", 2)
                if pleats < 2:
                    report.error(where, "outerPleats + innerPleats must be at least 2")


# --- The wall-side probe ----------------------------------------------------
# A port of probeWallSide() in src/house-loader.js -- keep the two in step.
# Which side of an axis-aligned wall a room is on is found by stepping a short
# way off each face AT THE ITEM'S POSITION along the wall and asking which of
# the two points is inside the room polygon. The old rule (the side the room's
# bounding-box midpoint is on) put items on the wrong face of any wall that
# bounds one arm of an L-shaped room.
WALL_SIDE_PROBE_CM = (5, 10, 20, 40)


def inside_poly(poly, px, py):
    """Even-odd ray cast; the same test as insidePoly() in src/footstep-walk.js."""
    inside = False
    j = len(poly) - 1
    for i in range(len(poly)):
        xi, yi = poly[i][0], poly[i][1]
        xj, yj = poly[j][0], poly[j][1]
        if (yi > py) != (yj > py) and px < (xj - xi) * (py - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


WALL_SIDE_CONTACT_CM = 10


def face_gap(poly, horizontal, face, probe, along):
    """Port of faceGap() in house-loader.js: how far the room's boundary stops
    short of the wall face, on the perpendicular at `along`. 0 if it reaches."""
    lo, hi = min(face, probe), max(face, probe)
    crossing = None
    j = len(poly) - 1
    for i in range(len(poly)):
        ui, vi = (poly[i][0], poly[i][1]) if horizontal else (poly[i][1], poly[i][0])
        uj, vj = (poly[j][0], poly[j][1]) if horizontal else (poly[j][1], poly[j][0])
        j = i
        if (ui > along) == (uj > along):
            continue
        v = vi + (vj - vi) * (along - ui) / (uj - ui)
        if v < lo or v > hi:
            continue
        if crossing is None or abs(v - probe) < abs(crossing - probe):
            crossing = v
    return 0.0 if crossing is None else abs(crossing - face)


def probe_wall_side(poly, horizontal, at, thickness, span, centre, width=None):
    """Returns (result, gap_or_None): result is 'plus' | 'minus' | 'both' |
    'neither', or 'far-plus' / 'far-minus' when the only hit is a room that
    stops more than WALL_SIDE_CONTACT_CM short of the face. See probeWallSide()
    in house-loader.js."""
    lo, hi = min(span), max(span)

    def clamp(v):
        return max(lo, min(hi, v))

    c = centre if isinstance(centre, (int, float)) else (lo + hi) / 2.0
    alongs = [clamp(c)]
    if isinstance(width, (int, float)) and width > 2:
        alongs += [clamp(c - (width / 2.0 - 1)), clamp(c + (width / 2.0 - 1))]
    saw_both = False
    far = None
    for along in alongs:
        for d in WALL_SIDE_PROBE_CM:
            e = thickness / 2.0 + d
            if horizontal:
                in_plus, in_minus = inside_poly(poly, along, at + e), inside_poly(poly, along, at - e)
            else:
                in_plus, in_minus = inside_poly(poly, at + e, along), inside_poly(poly, at - e, along)
            if in_plus != in_minus:
                s = 1 if in_plus else -1
                gap = face_gap(poly, horizontal, at + s * thickness / 2.0, at + s * e, along)
                name = "plus" if in_plus else "minus"
                if gap <= WALL_SIDE_CONTACT_CM:
                    return name, gap
                if far is None:
                    far = ("far-" + name, gap)
                continue
            if in_plus and in_minus:
                saw_both = True
    if far is not None:
        return far
    return ("both" if saw_both else "neither"), None


def _wall_thickness(wall, geo):
    t = wall.get("thickness")
    if t is None:
        t = (geo.get("defaults") or {}).get("wallThickness", 10)
    return t


def wall_side(room, wall, centre, width, geo):
    """(result, inDir, gap) with the engine's fallback applied: 'both' takes the
    side of the room's bounding-box midpoint, 'neither' gives inDir 0."""
    poly = room.get("polygon") or []
    axis = _wall_axis(wall)
    if len(poly) < 3 or axis is None:
        return "neither", 0, None
    horizontal, lo, hi = axis
    at = wall["start"][1] if horizontal else wall["start"][0]
    result, gap = probe_wall_side(poly, horizontal, at, _wall_thickness(wall, geo), (lo, hi), centre, width)
    if result in ("plus", "far-plus"):
        return result, 1, gap
    if result in ("minus", "far-minus"):
        return result, -1, gap
    if result == "both":
        ks = [p[1] if horizontal else p[0] for p in poly]
        return result, (1 if (min(ks) + max(ks)) / 2.0 >= at else -1), None
    return result, 0, None


def check_wall_side(where, room, wall, centre, width, geo, report):
    """Error on 'neither side', warn on 'both'. Returns inDir (1/-1), or 0 for neither."""
    result, in_dir, gap = wall_side(room, wall, centre, width, geo)
    if result.startswith("far-"):
        report.warn(
            where,
            f"room '{room.get('id')}' only reaches to {gap:.1f} cm from wall {wall.get('id')}'s face at centre "
            f"{centre} -- the engine uses that side, but the room may not be on this wall; check it",
        )
    if result == "neither":
        report.error(
            where,
            f"room '{room.get('id')}' is on neither side of wall {wall.get('id')} at centre {centre} -- "
            f"the wall does not bound this room there, and the engine skips the item",
        )
    elif result == "both":
        report.warn(
            where,
            f"room '{room.get('id')}' is on both sides of wall {wall.get('id')} at centre {centre} -- "
            f"the engine falls back to the room's bounding-box midpoint to pick the side; check it",
        )
    return in_dir


# --- Furniture (schemaVersion 1.2) -------------------------------------------

REGISTRY_PATH = REPO_ROOT / "src" / "furniture" / "registry.js"
# One registry entry per line, exactly as registry.js documents:
#   'type': { path: 'x.js', key: ..., spec: ... },
# scripts/test-furniture-defaults.mjs asserts this regex finds every entry.
REGISTRY_LINE_RE = re.compile(r"^\s*'([a-z][a-z0-9-]*)':\s*\{\s*path:\s*'([^']+)'", re.M)


def load_registry():
    """{type: module path relative to src/furniture/}, or None if unreadable."""
    try:
        text = REGISTRY_PATH.read_text(encoding="utf-8")
    except OSError:
        return None
    return dict(REGISTRY_LINE_RE.findall(text))


def schema_param_defaults(schema, ftype):
    """The `default` of every param in $defs/furnitureParams_<type>."""
    block = ((schema or {}).get("$defs") or {}).get(f"furnitureParams_{ftype}") or {}
    props = block.get("properties") or {}
    return {k: v["default"] for k, v in props.items() if isinstance(v, dict) and "default" in v}


def _front(rot):
    r = math.radians(rot)
    return (-math.sin(r), math.cos(r))


def footprint_rect(bx, by, rot, width, depth):
    """Port of footprintRect() in src/furniture/place.js: BL, BR, FR, FL."""
    r = math.radians(rot)
    f, u = _front(rot), (math.cos(r), math.sin(r))
    hw = width / 2.0
    bl = (bx - u[0] * hw, by - u[1] * hw)
    br = (bx + u[0] * hw, by + u[1] * hw)
    return [bl, br, (br[0] + f[0] * depth, br[1] + f[1] * depth), (bl[0] + f[0] * depth, bl[1] + f[1] * depth)]


def overlap_depth(a, b):
    """Separating-axis test for two convex quads: penetration in cm, <= 0 if apart."""
    depth = float("inf")
    for poly in (a, b):
        for i in range(len(poly)):
            p, q = poly[i], poly[(i + 1) % len(poly)]
            ex, ey = q[0] - p[0], q[1] - p[1]
            ln = math.hypot(ex, ey)
            if ln < 1e-9:
                continue
            nx, ny = -ey / ln, ex / ln
            pa = [pt[0] * nx + pt[1] * ny for pt in a]
            pb = [pt[0] * nx + pt[1] * ny for pt in b]
            ov = min(max(pa), max(pb)) - max(min(pa), min(pb))
            if ov <= 0:
                return ov
            depth = min(depth, ov)
    return depth


def _furniture_placement(item, wall_ids, room, geo, where, report):
    """(backX, backY, rotationDeg), or None after reporting why not."""
    if "wall" in item:
        wid = item.get("wall")
        wall = wall_ids.get(wid)
        if wall is None:
            report.error(where, f"references wall {wid}, which does not exist")
            return None
        axis = _wall_axis(wall)
        if axis is None:
            report.error(where, f"wall {wid} is not axis-aligned; a wall-anchored item needs a wall along x or y")
            return None
        horizontal, lo, hi = axis
        centre = item.get("centre")
        if not isinstance(centre, (int, float)):
            report.error(where, "wall-anchored but has no numeric `centre`")
            return None
        if not (lo - 1e-6 <= centre <= hi + 1e-6):
            report.error(where, f"centre {centre} is outside wall {wid}'s span ({lo}..{hi})")
            return None
        if room is None:
            return None
        width_hint = (item.get("params") or {}).get("width")
        in_dir = check_wall_side(where, room, wall, centre, width_hint, geo, report)
        if in_dir == 0:
            return None
        at = wall["start"][1] if horizontal else wall["start"][0]
        perp = at + in_dir * (_wall_thickness(wall, geo) / 2.0 + (item.get("offset") or 0))
        if horizontal:
            return centre, perp, (0 if in_dir > 0 else 180)
        return perp, centre, (270 if in_dir > 0 else 90)
    at = item.get("at")
    if not (isinstance(at, list) and len(at) == 2):
        return None
    return at[0], at[1], (item.get("rotation") or 0) % 360   # CENTRE; moved to the back below


def check_furniture(geo, wall_ids, rooms_by_id, report, schema):
    """furniture[]: the checks a JSON Schema cannot express. See docs/house-profile.md."""
    items = geo.get("furniture") or []
    if not items:
        return

    # The schema accepts `furniture` whatever version a profile declares, so
    # this is the only check tying the key to 1.2. An error, not a warning (as
    # windows/curtains are): an engine older than 1.2 silently draws none of it.
    version = str(geo.get("schemaVersion") or "")
    try:
        major, minor = (int(part) for part in version.split(".", 1))
    except ValueError:
        major = minor = -1
    if (major, minor) < (1, 2):
        report.error(
            "geometry.json/schemaVersion",
            f"`furniture` needs schemaVersion 1.2 or newer, but this profile declares '{version}' -- bump it",
        )

    registry = load_registry()
    if registry is None:
        report.warn("furniture", "could not read src/furniture/registry.js -- type checks skipped")
    defaults = geo.get("defaults") or {}
    ceiling = defaults.get("ceilingHeight", defaults.get("wallHeight", 250))

    seen = set()
    placed = []   # (where, id, type, footprint, bottom, top)
    for item in items:
        iid = item.get("id", "?")
        where = f"furniture/{iid}"
        if iid in seen:
            report.error(where, "duplicate furniture id")
        seen.add(iid)
        ftype = item.get("type")
        rid = item.get("room")
        room = rooms_by_id.get(rid)
        if room is None:
            report.error(where, f"room '{rid}' is not a room in this profile")

        if ("at" in item) == ("wall" in item):
            report.error(where, "give exactly one anchor: `at` (free) or `wall` + `centre` (wall-anchored)")
            continue
        if "wall" in item and "rotation" in item:
            report.error(where, "`rotation` is not allowed with a wall anchor -- the item always faces into its room")

        fade = item.get("fade")
        if isinstance(fade, dict) and "wall" in fade:
            fw = wall_ids.get(fade["wall"])
            if fw is None:
                report.error(where, f"fade.wall {fade['wall']} does not exist")
            elif not fw.get("exterior"):
                report.error(where, f"fade.wall {fade['wall']} is not an exterior wall -- only exterior walls fade")

        if registry is not None and ftype is not None:
            if ftype not in registry:
                report.warn(where, f"type '{ftype}' is not registered in src/furniture/registry.js -- the engine skips it")
            elif not (REGISTRY_PATH.parent / registry[ftype]).exists():
                report.warn(
                    where, f"type '{ftype}' has no builder yet (src/furniture/{registry[ftype]}) -- the engine skips it"
                )

        if ftype == "model":
            # The path's shape is the schema's job (furnitureParams_model.src);
            # whether the file is there is this one's. A warning, not an error:
            # the engine skips a model whose file is missing and draws the rest.
            src = (item.get("params") or {}).get("src")
            profile_dir = geo.get("__dir__")
            if not src:
                report.warn(where, "a `model` item needs params.src -- the engine skips it")
            elif profile_dir and not (Path(profile_dir) / src).is_file():
                report.warn(where, f"model file '{src}' not found (looked for {Path(profile_dir) / src}) -- the engine skips it")

        placement = _furniture_placement(item, wall_ids, room, geo, where, report)
        if placement is None:
            continue

        # The footprint checks need a width, depth and height: authored in
        # params, or the type's schema defaults (kept equal to the builder's
        # DEFAULTS by scripts/test-furniture-defaults.mjs).
        dims = dict(schema_param_defaults(schema, ftype))
        dims.update(item.get("params") or {})
        w, d, h = dims.get("width"), dims.get("depth"), dims.get("height")
        if not all(isinstance(v, (int, float)) for v in (w, d, h)):
            report.warn(
                where,
                f"type '{ftype}' has no schema defaults for width/depth/height and params do not give them "
                f"-- footprint, overlap and ceiling checks skipped",
            )
            continue
        x, y, rot = placement
        if "at" in item:
            f = _front(rot)
            x, y = x - f[0] * d / 2.0, y - f[1] * d / 2.0
        rect = footprint_rect(x, y, rot, w, d)
        bottom = item.get("elevation") or 0
        top = bottom + h
        if top > ceiling + 1e-6:
            report.warn(where, f"top at {top:g} cm is above the ceiling ({ceiling:g} cm)")
        if room is not None and len(room.get("polygon") or []) >= 3:
            # Pull each corner 1 cm toward the footprint centre first: a
            # wall-anchored back sits ON the wall face, and a room polygon is
            # often traced a hair off it.
            cx = sum(p[0] for p in rect) / 4.0
            cy = sum(p[1] for p in rect) / 4.0
            inset = []
            for px, py in rect:
                ln = math.hypot(cx - px, cy - py) or 1.0
                inset.append((px + (cx - px) / ln, py + (cy - py) / ln))
            if not all(inside_poly(room["polygon"], px, py) for px, py in inset):
                report.warn(where, f"footprint reaches outside room '{rid}'s polygon")
        placed.append((where, iid, ftype, rect, bottom, top))

    for i in range(len(placed)):
        for j in range(i + 1, len(placed)):
            wa, _ia, ta, ra, a0, a1 = placed[i]
            _wb, ib, tb, rb, b0, b1 = placed[j]
            depth = overlap_depth(ra, rb)
            if ta == "kitchen-base-run" and tb == "kitchen-base-run":
                # Two runs meeting at a corner: the non-owning run should stop
                # at the owner's front face, so any real overlap is a worktop
                # passing through a worktop.
                if depth > 1.0:
                    report.warn(
                        wa,
                        f"worktop overlaps kitchen run '{ib}' by {depth:.1f} cm -- the run that does not own "
                        f"the corner should stop at the owner's front face",
                    )
                continue
            if depth > 0.5 and min(a1, b1) - max(a0, b0) > 0.5:
                report.warn(wa, f"overlaps '{ib}' ({depth:.1f} cm in plan, and their heights intersect)")


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

    check_sensor_binding(rooms_doc, geo, geo_room_ids, report)


def check_sensor_binding(rooms_doc, geo, geo_room_ids, report):
    """Join rooms.json's `sensors` block against the paired geometry.

    Presence is keyed by room id and doors by DOOR id -- a door belongs to a
    wall, not a room, and a room may have several doors -- so the two halves
    are checked against different id sets. An id that matches nothing in the
    geometry is an error rather than a warning: unlike a light channel, where
    a half-wired house is a legitimate work-in-progress state, a sensor bound
    to a room or door that does not exist can never drive anything at all.
    """
    sensors = rooms_doc.get("sensors") or {}
    if not sensors:
        return

    # The schema does NOT couple schemaVersion to `sensors` at all -- `sensors`
    # is a declared property of roomsProfile, so a 1.0 profile carrying it
    # passes schema validation cleanly. This check is the ONLY signal that a
    # profile is declaring a version older than the feature it actually uses;
    # deleting it would remove that signal entirely, not just make it redundant.
    version = str(rooms_doc.get("schemaVersion") or "")
    try:
        major, minor = (int(part) for part in version.split(".", 1))
    except ValueError:
        major = minor = -1
    if (major, minor) < (1, 1):
        report.warn(
            "rooms.json/schemaVersion",
            f"`sensors` needs schemaVersion 1.1 or newer, but this profile declares '{version}' -- "
            "bump it; the schema does not enforce this coupling, so this warning is the only check",
        )

    for rid in (sensors.get("presence") or {}):
        if rid not in geo_room_ids:
            report.error(
                f"rooms.json/sensors/presence/{rid}",
                f"presence sensor bound to room '{rid}', which has no matching room in geometry.json",
            )

    geo_door_ids = {d.get("id") for d in geo.get("doors", [])}
    for did in (sensors.get("doors") or {}):
        if did not in geo_door_ids:
            report.error(
                f"rooms.json/sensors/doors/{did}",
                f"door sensor bound to door '{did}', which has no matching door in geometry.json",
            )

    check_curtain_binding(rooms_doc, geo, sensors, (major, minor), report)
    check_climate_binding(rooms_doc, sensors, geo_room_ids, (major, minor), report)


def check_climate_binding(rooms_doc, sensors, geo_room_ids, version, report):
    """`sensors.climate`: room id -> ONE climate entity for the sidebar's
    temperature row. A binding to a room that does not exist can never be
    shown, so it is an error, like presence. The schema already enforces the
    single-string shape and the `climate.` domain.
    """
    climate = sensors.get("climate") or {}
    if not climate:
        return
    if version < (1, 3):
        report.warn(
            "rooms.json/schemaVersion",
            "`sensors.climate` needs schemaVersion 1.3 or newer, but this profile "
            f"declares '{rooms_doc.get('schemaVersion')}' -- bump it; nothing else enforces this coupling",
        )
    for rid in climate:
        if rid not in geo_room_ids:
            report.error(
                f"rooms.json/sensors/climate/{rid}",
                f"climate entity bound to room '{rid}', which has no matching room in geometry.json",
            )


def check_curtain_binding(rooms_doc, geo, sensors, version, report):
    """`sensors.curtains` (covers) and `sensors.corniceLights`, joined to the
    geometry's curtains. Like a door sensor, a binding to a curtain that does
    not exist can never drive anything, so it is an error. A cornice light
    bound to a curtain whose cornice is not lit is an error for the same
    reason. And a bound cornice whose room ALSO lists a 'cornice' strip under
    a light channel is warned about: that strip would then be drawn and driven
    twice, once by the room's group and once by the cornice's own entity.
    """
    covers = sensors.get("curtains") or {}
    cornices = sensors.get("corniceLights") or {}
    if not covers and not cornices:
        return
    if version < (1, 2):
        report.warn(
            "rooms.json/schemaVersion",
            "`sensors.curtains`/`sensors.corniceLights` need schemaVersion 1.2 or newer, but this profile "
            f"declares '{rooms_doc.get('schemaVersion')}' -- bump it; nothing else enforces this coupling",
        )
    geo_curtains = {c.get("id"): c for c in geo.get("curtains", [])}
    for cid in covers:
        if cid not in geo_curtains:
            report.error(
                f"rooms.json/sensors/curtains/{cid}",
                f"cover bound to curtain '{cid}', which has no matching curtain in geometry.json",
            )
    for cid in cornices:
        cur = geo_curtains.get(cid)
        if cur is None:
            report.error(
                f"rooms.json/sensors/corniceLights/{cid}",
                f"cornice light bound to curtain '{cid}', which has no matching curtain in geometry.json",
            )
            continue
        cn = cur.get("cornice") or {}
        if cn.get("enabled") is False or cn.get("light") is False:
            report.error(
                f"rooms.json/sensors/corniceLights/{cid}",
                f"curtain '{cid}' has no lit cornice (cornice disabled or light:false), so this binding drives nothing",
            )
            continue
        room = cur.get("room")
        for group in geo.get("lights", []):
            if group.get("room") != room:
                continue
            for fx in group.get("fixtures", []):
                for pos in fx.get("positions") or []:
                    if "cornice" in str(pos.get("label", "")).lower():
                        report.warn(
                            f"rooms.json/sensors/corniceLights/{cid}",
                            f"room '{room}' also lists a '{pos.get('label')}' strip under light channel "
                            f"'{fx.get('channel')}' -- the cornice is now drawn and driven by curtain '{cid}', so "
                            "remove that position or it is drawn and driven twice",
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
            check_geometry(geo, report, schema)
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
            check_geometry(doc, report, schema)
            doc.pop("__dir__", None)
    return report, used_schema


def main(argv):
    args = [a for a in argv[1:] if a != "--strict"]
    strict = len(args) != len(argv[1:])

    if len(args) < 1:
        print(__doc__)
        return 2

    with open(SCHEMA_PATH, encoding="utf-8") as fh:
        schema = json.load(fh)

    targets = []
    for arg in args:
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
            if used_schema:
                print(f"{GREEN}PASS {OFF} {report.label}{counts}")
            else:
                print(f"{YELLOW}PARTIAL{OFF} {report.label}{counts}")
        else:
            print(f"{RED}FAIL {OFF} {report.label} -- {len(report.errors)} error(s)")
            failed += 1

    if not any_schema:
        print(
            f"{YELLOW}note {OFF} jsonschema is not installed, so only the structural and cross-reference "
            f"checks ran. Install it (pip install jsonschema) for full schema validation."
        )
        if strict:
            print(
                f"{RED}ERROR{OFF} --strict was given and jsonschema is not installed, "
                f"so schema validation could not run. Install it (pip install jsonschema)."
            )
            return 1

    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
