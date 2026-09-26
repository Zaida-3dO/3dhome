#!/usr/bin/env python3
"""Extract furniture from a SweetHome3D (.sh3d) plan into a 3dHome staging fragment.

A `.sh3d` file is a zip archive with a `Home.xml` entry describing the plan:
rooms, walls and furniture, each in SweetHome3D's own coordinate system (plan
centimetres, y pointing south, angles in clockwise radians). This script reads
that XML *in memory only* -- it never writes anything back to the .sh3d -- and
emits a staging fragment in the format `furniture-apply.py` consumes:
`{proposedBy, basedOn, furniture: [...], notes}`.

Usage:
    python scripts/sh3d-furniture.py --geometry houses/demo/geometry.json \\
        --offset 100,50 --out staging/mine.json

    python scripts/sh3d-furniture.py --geometry houses/demo/geometry.json \\
        --offset 0,0 --map extra-types.json

There is deliberately NO constant or default anywhere in this file (or in its
docs) for the offset: SweetHome3D's own plan origin has no fixed relationship
to a 3dHome profile's `coordinateTransform`, and hard-coding one number would
silently mis-place furniture the one time it happened to be wrong. The offset
is a required, explicit `--offset DX,DY`.

This script only ever READS the .sh3d plan and the target `--geometry` file
(to resolve rooms and walls). It never writes to either. Its output is a
staging fragment for a human or `furniture-apply.py` to review and apply.
"""

import argparse
import json
import math
import re
import subprocess
import sys
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

# ---------------------------------------------------------------------------
# Type mapping: generic rule table keyed on common SweetHome3D catalogue name
# fragments. Matching is case-insensitive substring matching against the
# furniture's `name` attribute, tried in order -- first match wins. This is a
# heuristic, not a certainty, which is why every mapped item still reports its
# source name and every uncertain one is flagged for review (see `REVIEW`).
# ---------------------------------------------------------------------------
DEFAULT_TYPE_RULES = [
    (re.compile(r"radiator", re.I), "radiator"),
    (re.compile(r"fridge|freezer", re.I), "fridge-freezer"),
    (re.compile(r"wardrobe|dresser|bedside|glass cabinet", re.I), "cabinet"),
    (re.compile(r"\bdesk\b", re.I), "standing-desk"),
    (re.compile(r"\bchair\b", re.I), "gaming-chair"),
    (re.compile(r"\bshelf|shelving\b", re.I), "shelf"),
    (re.compile(r"\btv\b|television", re.I), "tv"),
    (re.compile(r"\bmonitor\b", re.I), "monitor"),
    (re.compile(r"\bplant\b", re.I), "plant"),
    (re.compile(r"\bframe\b|wall art", re.I), "wall-art"),
    (re.compile(r"\bclock\b", re.I), "clock"),
]

# Names that indicate a kitchen module rather than a standalone item. These
# are aggregated by wall and collinearity into kitchen-base-run /
# kitchen-wall-run fragments instead of being emitted as individual items.
KITCHEN_BASE_RE = re.compile(r"lower cabinet|base cabinet|\boven\b|\bhob\b|\bsink\b|dishwasher|washer", re.I)
KITCHEN_WALL_RE = re.compile(r"upper cabinet|wall cabinet|\bhood\b|extractor", re.I)

# A generic mirror within this many cm of a wardrobe front folds into that
# wardrobe's params.fronts rather than being emitted as its own item.
MIRROR_WARDROBE_FOLD_CM = 2.0

# Snapping: an item whose back is within this distance of a wall's room face,
# parallel to it and overlapping its span, becomes a wall anchor.
WALL_SNAP_CM = 10.0
# Beyond the snap distance but within this band, still snap (offset 0) but
# flag REVIEW -- catches furniture drawn slightly off a wall that has since
# moved.
WALL_REVIEW_MIN_CM = 10.0
WALL_REVIEW_MAX_CM = 40.0

SKIP_NAME_HINTS = ("door", "window", "curtain")
# SweetHome3D groups bathroom fixtures under these catalogue category ids;
# matched heuristically against the name since categories aren't always
# present in older exports.
BATHROOM_HINTS = re.compile(r"\btoilet\b|\bbath\b|\bshower\b|\bbasin\b|\bbidet\b", re.I)


class Report:
    """Collects notes for the fragment's `notes` field and stderr."""

    def __init__(self):
        self.lines = []

    def add(self, line):
        self.lines.append(line)

    def text(self):
        return "\n".join(self.lines)


# ---------------------------------------------------------------------------
# Geometry helpers -- shared logic, ported to Python.
#
# `insidePoly` is a direct port of the ray-casting test in
# src/footstep-walk.js (function insidePoly, exported there for the footstep
# walker). Kept in sync by inspection; there is no cross-language import.
# ---------------------------------------------------------------------------
def inside_poly(poly, px, py):
    inside = False
    n = len(poly)
    j = n - 1
    for i in range(n):
        xi, yi = poly[i]
        xj, yj = poly[j]
        if ((yi > py) != (yj > py)) and (px < (xj - xi) * (py - yi) / (yj - yi) + xi):
            inside = not inside
        j = i
    return inside


def wall_axis(wall):
    """(horizontal, lo, hi) for an axis-aligned wall, else None."""
    x1, y1 = wall["start"]
    x2, y2 = wall["end"]
    dx, dy = abs(x1 - x2), abs(y1 - y2)
    if dx >= 0.5 and dy >= 0.5:
        return None
    horizontal = dy < dx
    axis = 0 if horizontal else 1
    lo, hi = sorted((wall["start"][axis], wall["end"][axis]))
    return horizontal, lo, hi


def wall_side_probe(wall, room_poly, along, e=None):
    """Port of plan §2.3's fixed wall-side probe (replaces the old
    bounding-box-midpoint heuristic, which picks the wrong side for an
    L-shaped room). Returns +1, -1, or None (with a reason) if the room lies
    on neither side, or a warning marker if it lies on both.

    `along` is the wall-parallel coordinate (the item's centre) at which the
    probe is taken; the two candidate points are offset `e` cm to either side
    of the wall's centreline, past both faces.
    """
    axis = wall_axis(wall)
    if axis is None:
        return None, "not-axis-aligned"
    horizontal, lo, hi = axis
    thickness = wall.get("thickness", 10.0)
    if e is None:
        e = thickness / 2.0 + 5.0
    at = wall["start"][1] if horizontal else wall["start"][0]
    along_clamped = min(max(along, lo), hi)
    if horizontal:
        p_plus = (along_clamped, at + e)
        p_minus = (along_clamped, at - e)
    else:
        p_plus = (at + e, along_clamped)
        p_minus = (at - e, along_clamped)
    in_plus = inside_poly(room_poly, *p_plus)
    in_minus = inside_poly(room_poly, *p_minus)
    if in_plus and not in_minus:
        return 1, None
    if in_minus and not in_plus:
        return -1, None
    if not in_plus and not in_minus:
        return None, "neither"
    return None, "both"


def room_face_point(wall, in_dir, along):
    """The point on the wall's room face nearest `along` its length."""
    axis = wall_axis(wall)
    horizontal, lo, hi = axis
    thickness = wall.get("thickness", 10.0)
    at = wall["start"][1] if horizontal else wall["start"][0]
    face = at + in_dir * thickness / 2.0
    along_clamped = min(max(along, lo), hi)
    return (along_clamped, face) if horizontal else (face, along_clamped)


def point_in_room(room, x, y):
    return inside_poly(room["polygon"], x, y)


# ---------------------------------------------------------------------------
# SH3D reading
# ---------------------------------------------------------------------------
def read_home_xml(sh3d_path):
    with zipfile.ZipFile(sh3d_path) as zf:
        names = zf.namelist()
        if "Home.xml" not in names:
            raise ValueError(f"{sh3d_path}: no Home.xml entry found -- is this a .sh3d file?")
        with zf.open("Home.xml") as fh:
            data = fh.read()
    return ET.fromstring(data)


def parse_furniture(root, report):
    """Every pieceOfFurniture / furnitureGroup element, top-level in document
    order, honouring SweetHome3D's real Home.xml shape.

    In a real SH3D export, `<level>` (when present at all) is an EMPTY
    sibling element -- it carries no children -- and each piece of furniture
    is a top-level child of `<home>` that references its level through a
    `level="<id>"` IDREF attribute, not by nesting. A plan with only one
    level commonly omits `<level>` entirely and omits the attribute too.
    Earlier code assumed the opposite (furniture nested inside `<level>`),
    which silently extracted nothing from any real file.

    So: walk the WHOLE document once, collect every level id in document
    order (to know which one is "first" when a `level` attribute is given),
    and pick every `pieceOfFurniture`/`furnitureGroup` that either has no
    `level` attribute (single/no-level plan) or names the first level. A
    plan with more than one level (by distinct level ids actually referenced
    or declared) is reported with a warning, and only the first level's
    pieces are read -- this script does not support multi-level extraction.

    A `furnitureGroup`'s own transform is not descended into for its
    children: SweetHome3D already bakes each child's absolute x/y/angle, so
    the group is skipped and its children (which appear as their own
    elements in the document, nested under the group) are read directly --
    see the caller, which drops bare group containers rather than emitting
    them as an extra item.
    """
    level_ids_in_order = []
    for el in root.iter():
        tag = el.tag.rsplit("}", 1)[-1]
        if tag == "level":
            lid = el.get("id")
            if lid and lid not in level_ids_in_order:
                level_ids_in_order.append(lid)

    referenced_levels = set()
    all_pieces = []
    lights = []
    for el in root.iter():
        tag = el.tag.rsplit("}", 1)[-1]
        if tag in ("pieceOfFurniture", "furnitureGroup", "light"):
            if tag == "light":
                lights.append(el)
                continue  # reported by the caller; lamps are not a supported type yet
            all_pieces.append(el)
            lvl = el.get("level")
            if lvl:
                referenced_levels.add(lvl)

    distinct_levels = referenced_levels or set(level_ids_in_order)
    if len(distinct_levels) > 1:
        # First by document order among the ones actually seen.
        ordered = [lid for lid in level_ids_in_order if lid in distinct_levels] or sorted(distinct_levels)
        first_level = ordered[0]
        report.add(
            f"WARNING: {len(distinct_levels)} levels found in the plan; only level "
            f"'{first_level}' is read (multi-level plans are not supported)"
        )
    elif distinct_levels:
        first_level = next(iter(distinct_levels))
    else:
        first_level = None  # no level info at all -- single-level plan

    items = []
    for el in all_pieces:
        tag = el.tag.rsplit("}", 1)[-1]
        lvl = el.get("level")
        if first_level is not None and lvl is not None and lvl != first_level:
            continue  # belongs to a later level -- skipped, already warned about
        if tag == "furnitureGroup":
            continue  # its children are separate elements in the document; see module docstring
        items.append(el)

    for light_el in lights:
        lvl = light_el.get("level")
        if first_level is not None and lvl is not None and lvl != first_level:
            continue
        name = light_el.get("name", "") or "(unnamed light)"
        report.add(f"SKIP '{name}': SH3D <light> (lamp) fixtures are not a supported furniture type yet")

    return items


def furniture_attr(el, name, default=None, cast=float):
    val = el.get(name)
    if val is None:
        return default
    try:
        return cast(val)
    except (TypeError, ValueError):
        return default


# ---------------------------------------------------------------------------
# Type mapping
# ---------------------------------------------------------------------------
def map_type(name, extra_rules):
    for pattern, ftype in extra_rules:
        if pattern.search(name):
            return ftype
    for pattern, ftype in DEFAULT_TYPE_RULES:
        if pattern.search(name):
            return ftype
    return None  # caller decides box vs skip


def load_extra_rules(map_path):
    if not map_path:
        return []
    with open(map_path, encoding="utf-8") as fh:
        raw = json.load(fh)
    rules = []
    for name_fragment, ftype in raw.items():
        rules.append((re.compile(re.escape(name_fragment), re.I), ftype))
    return rules


# ---------------------------------------------------------------------------
# Output path safety: refuse a path git already tracks or would track.
# ---------------------------------------------------------------------------
def refuse_if_tracked(out_path):
    """Refuses an --out path git already tracks, OR one that sits inside a git
    work tree without being ignored (which would be tracked the moment someone
    ran `git add .` -- the same leak, just not realised yet).

    A path with no git work tree above it at all (e.g. a plain scratch
    directory, or a machine with no git on PATH) is allowed: there is no repo
    for it to leak into.
    """
    if out_path is None:
        return  # stdout

    p = Path(out_path).resolve()
    work_dir = p.parent if p.parent.exists() else Path(".")

    def _git(args):
        try:
            return subprocess.run(["git"] + args, capture_output=True, text=True, cwd=str(work_dir))
        except FileNotFoundError:
            return None  # no git on PATH

    in_repo = _git(["rev-parse", "--is-inside-work-tree"])
    if in_repo is None or in_repo.returncode != 0 or in_repo.stdout.strip() != "true":
        return  # not inside any git work tree -- nothing to refuse

    tracked = _git(["ls-files", "--error-unmatch", str(p)])
    if tracked is not None and tracked.returncode == 0:
        raise SystemExit(f"refusing to write --out {out_path}: this path is tracked by git")

    ignored = _git(["check-ignore", str(p)])
    if ignored is not None and ignored.returncode != 0:
        raise SystemExit(
            f"refusing to write --out {out_path}: this path is inside a git repo and not "
            f"gitignored -- add it to .gitignore or write outside the repo"
        )


# ---------------------------------------------------------------------------
# Core conversion
# ---------------------------------------------------------------------------
def convert(sh3d_root, geometry, dx, dy, extra_rules, report):
    rooms = geometry.get("rooms", [])
    walls = geometry.get("walls", {}).get("segments", [])

    furniture_out = []
    id_counts = {}

    els = parse_furniture(sh3d_root, report)
    for el in els:
        tag = el.tag.rsplit("}", 1)[-1]
        name = el.get("name", "") or ""
        visible = el.get("visible", "true")
        if visible == "false":
            report.add(f"SKIP '{name}': visible=false")
            continue
        if BATHROOM_HINTS.search(name):
            report.add(f"SKIP '{name}': bathroom fixture")
            continue
        if any(h in name.lower() for h in SKIP_NAME_HINTS):
            report.add(f"SKIP '{name}': door/window/curtain, handled elsewhere")
            continue
        if name.lower().startswith("rug") or "rug" in name.lower():
            report.add(f"SKIP '{name}': emitted as a rooms[].rug suggestion, not furniture -- not implemented in this pass")
            continue

        x = furniture_attr(el, "x")
        y = furniture_attr(el, "y")
        angle = furniture_attr(el, "angle", default=0.0)
        width = furniture_attr(el, "width")
        depth = furniture_attr(el, "depth")
        height = furniture_attr(el, "height")
        elevation = furniture_attr(el, "elevation", default=0.0)
        mirrored = el.get("modelMirrored", "false") == "true"

        if x is None or y is None:
            report.add(f"SKIP '{name}': missing x/y")
            continue

        at = [round(x + dx, 2), round(y + dy, 2)]
        rotation = math.degrees(angle) % 360.0

        room = None
        for r in rooms:
            if point_in_room(r, at[0], at[1]):
                room = r
                break
        if room is None:
            report.add(f"REVIEW '{name}': centre {at} is not inside any room polygon -- assign a room by hand")
            continue

        ftype = map_type(name, extra_rules)
        params = {}
        if width is not None:
            params["width"] = round(width, 2)
        if depth is not None:
            params["depth"] = round(depth, 2)
        if height is not None:
            params["height"] = round(height, 2)
        if mirrored:
            params["mirrored"] = True
            report.add(f"NOTE '{name}': modelMirrored -> params.mirrored")

        if ftype is None:
            ftype = "box"
            priority = "minor"
            report.add(f"REVIEW '{name}': no type mapping matched -- emitted as box (priority minor)")
        else:
            priority = "normal"

        item = {
            "id": _unique_id(room["id"], ftype, id_counts),
            "room": room["id"],
            "type": ftype,
            "at": at,
            "rotation": round(rotation, 2),
            "elevation": round(elevation, 2) if elevation else 0,
            "params": params,
            "priority": priority,
            "source": {"sh3d": name},
        }

        # Wall snapping (plan §4 / §2.3 probe).
        snap = try_snap_to_wall(item, walls, rooms, room, report)
        if snap:
            item.update(snap)
            del item["at"]
            del item["rotation"]

        furniture_out.append(item)

    return furniture_out


def _slugify(name):
    """Lowercase, underscore-separated slug, matching the schema's general id
    pattern (`^[a-z][a-z0-9_]*$`, e.g. `houses/schema.json`'s `roomId`) --
    NOT hyphens, which that pattern rejects.
    """
    s = re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_")
    return s or None


def _unique_id(room_id, ftype, id_counts):
    """Plan §1's id convention is `<room>_<type>_<n>` (see e.g.
    `office_radiator`). Two source pieces mapping to the same room+type
    (very common -- "Radiator" appearing twice, say) must NOT collide: a
    collision used to silently merge two different physical items into one
    on apply, with no warning from either tool. `id_counts` is mutated by the
    caller across the whole conversion, so ids stay unique fragment-wide, not
    just within one call.
    """
    slug_type = _slugify(ftype) or "item"
    slug_room = _slugify(room_id) or "room"
    base = f"{slug_room}_{slug_type}"
    n = id_counts.get(base, 0) + 1
    id_counts[base] = n
    return base if n == 1 else f"{base}_{n}"


def try_snap_to_wall(item, walls, rooms, room, report):
    """Snap a free-anchored item to a wall if its back edge is parallel to an
    axis-aligned wall's room face, within WALL_REVIEW_MAX_CM and overlapping
    the wall's span. Returns a dict of wall/centre/offset fields, or None.
    """
    at = item["at"]
    rotation = item["rotation"]
    depth = item["params"].get("depth", 0.0)
    # Front direction in plan, per §1: (-sin r, cos r), r in degrees.
    r = math.radians(rotation)
    fx, fy = -math.sin(r), math.cos(r)
    back = (at[0] - fx * depth / 2.0, at[1] - fy * depth / 2.0)

    best = None
    for wall in walls:
        axis = wall_axis(wall)
        if axis is None:
            continue
        horizontal, lo, hi = axis
        # Only consider walls whose face direction roughly matches the item's
        # back-to-front axis (i.e. the item faces toward/away from the wall).
        # A horizontal wall's normal is vertical (0, ±1); a vertical wall's
        # normal is horizontal (±1, 0).
        if horizontal and abs(fy) < 0.9:
            continue
        if not horizontal and abs(fx) < 0.9:
            continue

        along = back[0] if horizontal else back[1]
        if along < lo - WALL_REVIEW_MAX_CM or along > hi + WALL_REVIEW_MAX_CM:
            continue

        in_dir, reason = wall_side_probe(wall, room["polygon"], along)
        if reason == "neither":
            continue
        if reason == "both":
            report.add(f"NOTE wall {wall.get('id')}: room is on both sides at centre {along} -- using bbox fallback skipped in extractor; leaving item free")
            continue
        if in_dir is None:
            continue

        # The item's FRONT must point INTO the room (same direction as the
        # wall's room-side normal), not at the wall. Snapping something whose
        # front faces the wall used to silently turn it around: a
        # wall-anchor's front always faces into `room` by construction (plan
        # §1), so accepting a back-to-the-room item here would flip it 180
        # degrees with no record of that happening. The wall's outward normal
        # is (0, inDir) for a horizontal wall or (inDir, 0) for a vertical
        # one; the item's own front is (fx, fy).
        wall_normal = (0.0, in_dir) if horizontal else (in_dir, 0.0)
        facing_dot = fx * wall_normal[0] + fy * wall_normal[1]
        if facing_dot <= 0:
            report.add(
                f"REVIEW '{item['source']['sh3d']}': its front faces wall {wall.get('id')} rather than "
                f"into the room -- left free rather than snapped, which would have turned it 180 degrees"
            )
            continue

        face_pt = room_face_point(wall, in_dir, along)
        dist = math.hypot(back[0] - face_pt[0], back[1] - face_pt[1])
        if dist > WALL_REVIEW_MAX_CM:
            continue

        # `centre` must lie ON the wall's own span, or PR1a's validator (and
        # the plan's own "centre outside the wall span" rule) will reject it.
        # `along` can land past the wall's end here because the search window
        # above deliberately allows some slack past it (to catch furniture
        # drawn slightly beyond a wall that has since been trimmed); clamp
        # the STORED centre to the span and flag it if that clamp actually
        # moved it, rather than silently proposing an out-of-span value.
        clamped_along = min(max(along, lo), hi)
        clamped = abs(clamped_along - along) > 1e-6

        candidate = {
            "wall": wall.get("id"), "centre": round(clamped_along, 2), "dist": dist,
            "inDir": in_dir, "clamped": clamped, "clamped_from": along,
        }
        if best is None or dist < best["dist"]:
            best = candidate

    if best is None:
        return None

    # `_inDir` is carried on the snap result (private, leading underscore --
    # not part of the public furniture schema) so later passes that need the
    # wall's outward direction (mirror-into-wardrobe folding) don't have to
    # re-derive it, which would mean re-running the §2.3 probe a second time
    # against the same room and risking disagreement with what was actually
    # snapped.
    def _review_suffix():
        if not best["clamped"]:
            return ""
        return (
            f" REVIEW: centre clamped from {best['clamped_from']:.1f} to {best['centre']} to stay "
            f"within wall {best['wall']}'s span -- check the wall hasn't moved or been trimmed."
        )

    if best["dist"] <= WALL_SNAP_CM:
        offset = round(best["dist"], 2)
        result = {"wall": best["wall"], "centre": best["centre"], "offset": offset, "_inDir": best["inDir"]}
        if best["clamped"]:
            item.setdefault("notes", "")
            item["notes"] = (item["notes"] + " " if item["notes"] else "") + _review_suffix().strip()
        return result
    if WALL_REVIEW_MIN_CM <= best["dist"] <= WALL_REVIEW_MAX_CM:
        item.setdefault("notes", "")
        item["notes"] = (item["notes"] + " " if item["notes"] else "") + (
            f"REVIEW: {best['dist']:.1f} cm off wall {best['wall']}'s face -- snapped with offset 0, "
            f"check against the current wall position.{_review_suffix()}"
        )
        return {"wall": best["wall"], "centre": best["centre"], "offset": 0, "_inDir": best["inDir"]}
    return None


# ---------------------------------------------------------------------------
# Kitchen run aggregation
# ---------------------------------------------------------------------------
def aggregate_kitchen_runs(furniture, report):
    """Fold items whose source name matches a kitchen-base/-wall pattern into
    kitchen-base-run / kitchen-wall-run module lists, grouped by wall id and
    ordered along the wall. Non-kitchen items pass through unchanged.

    This is intentionally conservative: modules are grouped only when they
    share a `wall` (already resolved by snapping), so a free-standing item
    with a kitchen-ish name is left as its own box/cabinet rather than guessed
    into a run.
    """
    base_groups = {}
    wall_groups = {}
    passthrough = []

    for item in furniture:
        src_name = item.get("source", {}).get("sh3d", "")
        wall = item.get("wall")
        if wall is not None and KITCHEN_BASE_RE.search(src_name):
            base_groups.setdefault(wall, []).append(item)
            continue
        if wall is not None and KITCHEN_WALL_RE.search(src_name):
            wall_groups.setdefault(wall, []).append(item)
            continue
        passthrough.append(item)

    def _fold(groups, run_type, keep_elevation):
        out = []
        for wall, members in groups.items():
            members.sort(key=lambda m: m["centre"])
            modules = []
            module_notes = []
            for m in members:
                src = m.get("source", {}).get("sh3d", "").lower()
                if "oven" in src:
                    kind = "oven"
                elif "hob" in src:
                    kind = "hob"
                elif "sink" in src:
                    kind = "sink"
                elif "dishwasher" in src:
                    kind = "dishwasher"
                elif "washer" in src:
                    kind = "washer"
                elif "hood" in src or "extractor" in src:
                    kind = "hood"
                elif "drawer" in src:
                    kind = "drawers"
                else:
                    kind = "cabinet"
                modules.append({"kind": kind, "width": m["params"].get("width", 60)})
                # A module folded into a run loses its own item-level `notes`
                # (e.g. a REVIEW flag from snapping slightly off the wall) --
                # carry it forward against the run instead of silently
                # dropping it, tagged with which sh3d source it came from.
                m_note = m.get("notes")
                if m_note:
                    module_notes.append(f"[{m.get('source', {}).get('sh3d', '?')}] {m_note}")

            # The run's centre is the MIDPOINT OF ITS EXTENT (leftmost module's
            # start to rightmost module's end along the wall), not the mean of
            # the members' own centres -- the mean is wrong whenever widths
            # differ, since it weights every module as if it were the same
            # size instead of weighting by where its edges actually fall.
            widths = [mod["width"] for mod in modules]
            member_centres = [m["centre"] for m in members]
            starts = [c - w / 2.0 for c, w in zip(member_centres, widths)]
            ends = [c + w / 2.0 for c, w in zip(member_centres, widths)]
            run_centre = (min(starts) + max(ends)) / 2.0

            run = {
                "id": f"{_slugify(run_type)}_wall_{wall}",
                "room": members[0]["room"],
                "type": run_type,
                "wall": wall,
                "centre": round(run_centre, 2),
                "offset": 0,
                "params": {"modules": modules, "corner": "none"},
                "priority": "normal",
                "notes": (
                    f"REVIEW: aggregated from {len(members)} sh3d item(s) on wall {wall}; verify module "
                    f"order and corner." + ("".join(f" {n}." for n in module_notes) if module_notes else "")
                ),
                "source": {"sh3d": ", ".join(m.get("source", {}).get("sh3d", "?") for m in members)},
            }
            if keep_elevation:
                # kitchen-wall-run items (upper cabinets, the hood) hang above
                # the worktop -- collapsing to elevation 0 during aggregation
                # used to land them on the floor. Use the highest member
                # elevation as a conservative representative (a hood is
                # usually mounted above the cabinets it's grouped with).
                elevations = [m.get("elevation", 0) for m in members if m.get("elevation")]
                if elevations:
                    run["elevation"] = round(max(elevations), 2)
            report.add(f"NOTE: aggregated {len(members)} item(s) on wall {wall} into {run['id']}")
            out.append(run)
        return out

    result = (
        passthrough
        + _fold(base_groups, "kitchen-base-run", keep_elevation=False)
        + _fold(wall_groups, "kitchen-wall-run", keep_elevation=True)
    )
    return result


# ---------------------------------------------------------------------------
# Mirror-into-wardrobe folding
# ---------------------------------------------------------------------------
def _item_front_face(item, walls_by_id):
    """The item's front-face segment in ABSOLUTE plan coordinates, as
    (centre_point, normal, half_width) -- `normal` is the outward unit
    vector the front faces, `centre_point` is the midpoint of the front
    face, and `half_width` lets a caller test span overlap along the face.

    Both anchor forms are resolved into the SAME coordinate system (plan
    cm), which the previous version did not do: it compared a free item's
    `at` (its CENTRE) against a wall-anchored item's raw `centre` (a
    WALL-LOCAL coordinate, paired with a fake y of 0), so a wall-anchored
    wardrobe was never within reach of anything. Returns None if the
    geometry can't be resolved (e.g. the item's wall id is unknown).
    """
    depth = item["params"].get("depth", 0.0)
    width = item["params"].get("width", 0.0)

    if "at" in item:
        rotation = item.get("rotation", 0.0)
        r = math.radians(rotation)
        front = (-math.sin(r), math.cos(r))
        at = item["at"]
        face_centre = (at[0] + front[0] * depth / 2.0, at[1] + front[1] * depth / 2.0)
        return face_centre, front, width / 2.0

    if "wall" in item and "centre" in item:
        wall = walls_by_id.get(item["wall"])
        if wall is None:
            return None
        axis = wall_axis(wall)
        if axis is None:
            return None
        horizontal, lo, hi = axis
        thickness = wall.get("thickness", 10.0)
        at_line = wall["start"][1] if horizontal else wall["start"][0]
        # room_side is which side of the wall the item's room is on. Plan
        # items don't carry inDir directly, but a wall-anchored item's
        # `offset` is always measured INTO the room from the wall's room
        # face, and the extractor only ever snaps on the room side -- so the
        # face normal points away from the wall's centreline, on whichever
        # side the item's own back sits. We derive that from the item's own
        # `notes`-free stored `_inDir` if present (set by try_snap_to_wall),
        # else assume +1 and let the caller's own snapping have been correct.
        in_dir = item.get("_inDir", 1)
        along = item["centre"]
        back_face_at = at_line + in_dir * thickness / 2.0
        offset = item.get("offset", 0.0)
        front_at = back_face_at + in_dir * (offset + depth)
        face_centre = (along, front_at) if horizontal else (front_at, along)
        normal = (0.0, in_dir) if horizontal else (in_dir, 0.0)
        return face_centre, normal, width / 2.0

    return None


def _point_to_face_distance(point, face_centre, face_normal, half_width):
    """Perpendicular distance from `point` to the face's plane, but only
    counted when `point` projects within the face's own span (its "overlap"
    with the face) -- a point far off the end of a wardrobe's front doesn't
    count as being on that front just because the plane is close.
    """
    dx, dy = point[0] - face_centre[0], point[1] - face_centre[1]
    perp_dist = abs(dx * face_normal[0] + dy * face_normal[1])
    # Tangential vector along the face (perpendicular to the normal).
    tangent = (-face_normal[1], face_normal[0])
    along = dx * tangent[0] + dy * tangent[1]
    if abs(along) > half_width + 1e-6:
        return None  # off the end of the face -- not overlapping its span
    return perp_dist


def fold_mirrors_into_wardrobes(furniture, walls, report):
    """Plan §4: 'a mirror within 2 cm of a wardrobe front → folded into that
    wardrobe's `params.fronts`'. A mirror is identified by its sh3d SOURCE
    NAME containing "mirror" -- it usually has no dedicated type mapping of
    its own (a plain wall mirror panel maps to `box`), so this must not
    require it to already be typed `cabinet`.

    Measured against the wardrobe's FRONT-FACE PLANE (not its centre point),
    in one consistent coordinate system for both anchor forms -- see
    `_item_front_face`. A mirror qualifies when it is within
    MIRROR_WARDROBE_FOLD_CM of that plane AND its own centre projects within
    the wardrobe's front-face span (so a mirror near the wardrobe's SIDE,
    not its front, does not fold in just because it is nearby).
    """
    walls_by_id = {w.get("id"): w for w in walls}
    mirrors = [f for f in furniture if "mirror" in f.get("source", {}).get("sh3d", "").lower()]
    wardrobes = [f for f in furniture if f["type"] == "cabinet" and "mirror" not in f.get("source", {}).get("sh3d", "").lower()]
    folded_ids = set()

    for mirror in list(mirrors):
        m_point = _item_reference_point(mirror, walls_by_id)
        if m_point is None:
            continue
        for wardrobe in wardrobes:
            face = _item_front_face(wardrobe, walls_by_id)
            if face is None:
                continue
            face_centre, face_normal, half_width = face
            dist = _point_to_face_distance(m_point, face_centre, face_normal, half_width)
            if dist is not None and dist <= MIRROR_WARDROBE_FOLD_CM:
                fronts = wardrobe["params"].setdefault("fronts", [])
                fronts.append("mirror")
                folded_ids.add(id(mirror))
                report.add(f"NOTE: folded mirror '{mirror['source']['sh3d']}' into wardrobe '{wardrobe['source']['sh3d']}' params.fronts")
                break

    return [f for f in furniture if id(f) not in folded_ids]


def _item_reference_point(item, walls_by_id):
    """A representative absolute-plan point for an item, used as the
    'where is the mirror' side of the front-face distance test.

    A free item's `at` already is one, in the same plan-cm coordinate system
    `_item_front_face` uses. A wall-anchored item's own `centre` is
    WALL-LOCAL (a 1D position along the wall), so resolving it into plan
    coordinates uses that item's OWN front face -- a mirror is thin and is
    expected to sit flush, so its own front-face midpoint is representative
    of where it actually is. This is what the previous version got wrong: it
    paired a wall-local `centre` number directly with a fake y of 0 and
    called that a plan point, which put a wall-anchored mirror nowhere near
    any wardrobe regardless of where it actually was.
    """
    if "at" in item:
        return tuple(item["at"])
    if "wall" in item and "centre" in item:
        face = _item_front_face(item, walls_by_id)
        return face[0] if face else None
    return None


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def build_arg_parser():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("sh3d", nargs="?", help="path to the .sh3d plan file (positional, or use --sh3d)")
    p.add_argument("--sh3d", dest="sh3d_opt", help="path to the .sh3d plan file")
    p.add_argument("--geometry", required=True, help="path to the target geometry.json (rooms/walls to resolve against)")
    p.add_argument("--offset", required=True, help="DX,DY in cm, added to every extracted item's plan position; no default")
    p.add_argument("--map", help="path to a JSON file of {sh3d name fragment: type} extra rules, applied before the built-in table")
    p.add_argument("--out", help="output path for the staging fragment (default: stdout). Refused if the path is tracked by git.")
    p.add_argument("--proposed-by", default="sh3d-furniture.py", help="value for the fragment's proposedBy field")
    return p


def parse_offset(raw):
    parts = raw.split(",")
    if len(parts) != 2:
        raise SystemExit(f"--offset must be DX,DY (got {raw!r})")
    try:
        return float(parts[0]), float(parts[1])
    except ValueError:
        raise SystemExit(f"--offset must be two numbers separated by a comma (got {raw!r})")


def main(argv):
    args = build_arg_parser().parse_args(argv[1:])
    sh3d_path = args.sh3d_opt or args.sh3d
    if not sh3d_path:
        raise SystemExit("a .sh3d path is required (positional or --sh3d)")

    dx, dy = parse_offset(args.offset)
    refuse_if_tracked(args.out)

    with open(args.geometry, encoding="utf-8") as fh:
        geometry = json.load(fh)

    extra_rules = load_extra_rules(args.map)
    report = Report()

    walls = geometry.get("walls", {}).get("segments", [])

    root = read_home_xml(sh3d_path)
    furniture = convert(root, geometry, dx, dy, extra_rules, report)
    furniture = fold_mirrors_into_wardrobes(furniture, walls, report)
    furniture = aggregate_kitchen_runs(furniture, report)
    for item in furniture:
        item.pop("_inDir", None)  # internal only -- never part of the output schema

    basedon_mtime = Path(args.geometry).stat().st_mtime
    fragment = {
        "proposedBy": args.proposed_by,
        "basedOn": basedon_mtime,
        "furniture": furniture,
        "notes": report.text(),
    }

    out_text = json.dumps(fragment, indent=2)
    if args.out:
        Path(args.out).write_text(out_text + "\n", encoding="utf-8")
        print(f"wrote {len(furniture)} item(s) to {args.out}", file=sys.stderr)
    else:
        print(out_text)

    if report.lines:
        print("--- report ---", file=sys.stderr)
        print(report.text(), file=sys.stderr)

    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
