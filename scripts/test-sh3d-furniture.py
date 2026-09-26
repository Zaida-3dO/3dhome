#!/usr/bin/env python3
"""Tests for sh3d-furniture.py and furniture-apply.py.

No framework, no external dependencies for most cases; a handful of
furniture-apply.py cases run `validate-house.py --strict`, which needs
`jsonschema` installed to do anything beyond structural checks -- those cases
use --skip-furniture-schema instead, per the item's own note: the furniture schema
(PR1a) has not merged in this repo yet, so `furniture[]` is not a recognised
property and full --strict validation of a fragment-merged file cannot pass
until it does. That is documented in docs/sh3d-import.md, not hidden here.

All fixtures are synthetic: made-up names, coordinates, wall ids and offsets,
built fresh in a temp directory. Nothing here reads or depends on a real
house profile.

Usage:
    python scripts/test-sh3d-furniture.py
"""

import json
import math
import subprocess
import sys
import tempfile
import time
import zipfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
EXTRACTOR = REPO_ROOT / "scripts" / "sh3d-furniture.py"
APPLY = REPO_ROOT / "scripts" / "furniture-apply.py"

sys.path.insert(0, str(REPO_ROOT / "scripts"))
import importlib.util


def _load_module(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


sh3d_furniture = _load_module(EXTRACTOR, "sh3d_furniture")
furniture_apply = _load_module(APPLY, "furniture_apply")


PASS = 0
FAIL = 0


def check(name, condition, detail=""):
    global PASS, FAIL
    if condition:
        PASS += 1
        print(f"PASS  {name}")
    else:
        FAIL += 1
        print(f"FAIL  {name}  {detail}")


# ---------------------------------------------------------------------------
# Synthetic fixture builders
# ---------------------------------------------------------------------------
def make_synthetic_geometry(tmp_dir, extra_walls=None, extra_rooms=None):
    """A tiny, wholly invented two-room geometry.json for testing against.
    Room "north_room": a simple rectangle. Room "l_room": an L-shape, to
    exercise the wall-side probe the way plan §2.3 requires.
    """
    rooms = [
        {
            "id": "north_room",
            "label": "North Room",
            "polygon": [[0, 0], [500, 0], [500, 300], [0, 300]],
        },
        {
            # An L-shaped room shaped so wall 7's LOCAL side (probed right at
            # the wall) disagrees with the room's overall bounding-box
            # midpoint -- this is the M1 bug (plan §2.3): `wallSide()` picking
            # the room's side from the room's bounding-box midpoint gets the
            # wrong side for a wall bounding only part of an L-shaped room.
            # Shape: a narrow arm on the west side (x 0..300, y 100..400)
            # plus a wide leg below and to the east (x 0..900, y 400..900).
            # Wall 7 runs along x=300, y 100..400 -- the arm's east side. The
            # room is LOCALLY west of that wall (x<300, inside the arm), but
            # the room's bbox spans x 0..900, midpoint x=450, which is EAST
            # of wall 7 -- the naive bbox heuristic would say "east" (+1) when
            # the correct, locally-probed answer is "west" (-1).
            "id": "l_room",
            "label": "L Room",
            "polygon": [
                [0, 100], [300, 100], [300, 400], [900, 400], [900, 900], [0, 900],
            ],
        },
    ]
    if extra_rooms:
        rooms.extend(extra_rooms)

    walls = [
        {"id": 1, "start": [0, 0], "end": [500, 0], "thickness": 10.0, "exterior": True},
        {"id": 2, "start": [0, 0], "end": [0, 300], "thickness": 10.0, "exterior": True},
        # Wall 7: the L-room's arm-boundary wall, x = 300, spanning y
        # 100..400. See the l_room polygon comment above for why this is the
        # M1 fixture (plan §2.3): the room's bbox midpoint disagrees with the
        # wall's own locally-probed side.
        {"id": 7, "start": [300, 100], "end": [300, 400], "thickness": 10.0, "exterior": True},
        {"id": 8, "start": [0, 900], "end": [900, 900], "thickness": 10.0, "exterior": True},
    ]
    if extra_walls:
        walls.extend(extra_walls)

    geometry = {
        "kind": "geometry",
        "schemaVersion": "1.1",
        "id": "synthetic-test-house",
        "name": "Synthetic Test House",
        "description": "Wholly invented fixture for automated tests. Not a real home.",
        "units": "cm",
        "coordinateTransform": {"originX": 0, "originY": 0, "scale": 0.01, "planAxes": "x_east_y_south"},
        "defaults": {"wallHeight": 240, "wallThickness": 10},
        "rooms": rooms,
        "walls": {"segments": walls, "highestIdEverAssigned": 8},
        "doors": [],
        "windows": [],
        "curtains": [],
        "lights": [],
    }
    path = tmp_dir / "geometry.json"
    path.write_text(json.dumps(geometry, indent=2), encoding="utf-8")
    return path, geometry


def make_synthetic_sh3d(tmp_dir, furniture_xml_items, filename="fixture.sh3d", levels=None, nested=False):
    """Builds a minimal but well-formed Home.xml and zips it as a .sh3d.

    By default this builds the REAL SweetHome3D shape: `<level>` (when given)
    is an EMPTY sibling element, and every furniture element is a TOP-LEVEL
    child of `<home>`, referencing its level (if any) through a `level="id"`
    attribute -- not by XML nesting. A single-level plan commonly has no
    `<level>` element at all, which is the default here (`levels=None`).

    `levels`, if given, is a list of level id strings to declare as empty
    `<level id="..."/>` elements; pass more than one to build a genuine
    multi-level fixture.

    `nested=True` builds the OLD, non-standard shape this extractor used to
    assume (furniture nested inside a single `<level>`), kept as one
    regression fixture so a reader can see the difference at a glance -- it
    is not how any real SweetHome3D export looks.
    """
    if nested:
        home_xml = f"""<?xml version="1.0" encoding="UTF-8"?>
<home version="7.2">
  <level id="level-0" elevation="0.0" floorThickness="12.0" height="250.0">
    {''.join(furniture_xml_items)}
  </level>
</home>
"""
    else:
        level_elements = "".join(
            f'<level id="{lid}" elevation="{i * 250.0}" floorThickness="12.0" height="250.0" />\n'
            for i, lid in enumerate(levels or [])
        )
        home_xml = f"""<?xml version="1.0" encoding="UTF-8"?>
<home version="7.2">
  {level_elements}{''.join(furniture_xml_items)}
</home>
"""
    sh3d_path = tmp_dir / filename
    with zipfile.ZipFile(sh3d_path, "w") as zf:
        zf.writestr("Home.xml", home_xml)
    return sh3d_path


def furn_el(name, x, y, angle=0.0, width=60.0, depth=40.0, height=80.0, elevation=0.0, mirrored=False, visible=True, level=None):
    level_attr = f'level="{level}" ' if level else ""
    return (
        f'<pieceOfFurniture name="{name}" x="{x}" y="{y}" angle="{angle}" '
        f'width="{width}" depth="{depth}" height="{height}" elevation="{elevation}" '
        f'modelMirrored="{"true" if mirrored else "false"}" visible="{"true" if visible else "false"}" '
        f'{level_attr}catalogId="fixture" />\n'
    )


def group_el(name, x, y, children_xml, angle=0.0):
    """A furnitureGroup wrapping child pieceOfFurniture elements, as SH3D
    actually nests them (unlike `level`, a group DOES nest its members)."""
    return (
        f'<furnitureGroup name="{name}" x="{x}" y="{y}" angle="{angle}" '
        f'width="1" depth="1" height="1" elevation="0" modelMirrored="false" visible="true">\n'
        f'{children_xml}'
        f'</furnitureGroup>\n'
    )


# ---------------------------------------------------------------------------
# Tests: pure geometry helpers
# ---------------------------------------------------------------------------
def test_inside_poly():
    square = [[0, 0], [10, 0], [10, 10], [0, 10]]
    check("inside_poly: centre is inside", sh3d_furniture.inside_poly(square, 5, 5))
    check("inside_poly: outside is outside", not sh3d_furniture.inside_poly(square, 50, 50))


def test_wall_side_probe_l_room():
    """The core regression this extractor must not repeat: wall 7 of the
    L-room fixture must resolve to the arm's side, not the whole room's
    bounding-box midpoint (which would pick the wrong side)."""
    _, geometry = make_synthetic_geometry(Path(tempfile.mkdtemp()))
    l_room = next(r for r in geometry["rooms"] if r["id"] == "l_room")
    wall7 = next(w for w in geometry["walls"]["segments"] if w["id"] == 7)
    in_dir, reason = sh3d_furniture.wall_side_probe(wall7, l_room["polygon"], along=250)
    # The arm (x in 0..300, y in 100..400) is WEST of wall 7 (x=300), i.e.
    # smaller x -> in_dir should be -1 (room lies on the -x side of the wall).
    check("wall_side_probe: L-room arm resolves to -x (west) side of wall 7", in_dir == -1, f"got {in_dir!r}, reason={reason!r}")

    # Sanity: the OLD bbox-midpoint heuristic would get this wrong, computed
    # here from the FIXTURE'S OWN polygon (not hardcoded literals), so a
    # future edit to the fixture's shape is reflected on both sides of this
    # comparison rather than silently exercising nothing.
    xs = [p[0] for p in l_room["polygon"]]
    bbox_midpoint_x = (min(xs) + max(xs)) / 2.0
    wall7_at_x = wall7["start"][0]  # wall 7 is vertical: start/end share x
    naive_in_dir = 1 if bbox_midpoint_x >= wall7_at_x else -1
    check(
        "wall_side_probe: differs from the naive bbox-midpoint heuristic (the bug being avoided)",
        naive_in_dir != in_dir,
        f"bbox_midpoint_x={bbox_midpoint_x}, wall7_at_x={wall7_at_x}, naive={naive_in_dir}, probe={in_dir}",
    )


def test_wall_side_probe_neither_both():
    tmp = Path(tempfile.mkdtemp())
    # A wall far from any room polygon: neither side is inside.
    stray_wall = {"id": 99, "start": [1000, 1000], "end": [1100, 1000], "thickness": 10.0}
    square_room_poly = [[0, 0], [10, 0], [10, 10], [0, 10]]
    in_dir, reason = sh3d_furniture.wall_side_probe(stray_wall, square_room_poly, along=1050)
    check("wall_side_probe: neither side inside -> reason 'neither'", in_dir is None and reason == "neither")


# ---------------------------------------------------------------------------
# Tests: extractor CLI end-to-end
# ---------------------------------------------------------------------------
def run_extractor(args):
    proc = subprocess.run(
        [sys.executable, str(EXTRACTOR)] + args,
        capture_output=True, text=True,
    )
    return proc


def test_real_flat_layout_no_level_extracts_everything():
    """The finding this pins: real SH3D single-level plans have NO <level>
    element at all, and furniture is a TOP-LEVEL child of <home>, not nested.
    The old code assumed nesting and silently extracted zero items from this
    exact shape. make_synthetic_sh3d()'s default (nested=False, levels=None)
    already builds this real shape, so this is the sanity check that it
    round-trips at all -- every other extractor test relies on the same
    default, so a regression here would be caught everywhere, but this test
    names the property directly."""
    tmp = Path(tempfile.mkdtemp())
    geo_path, _ = make_synthetic_geometry(tmp)
    sh3d_path = make_synthetic_sh3d(tmp, [
        furn_el("Invented no-level lamp", x=50, y=50, width=20, depth=20, height=40),
    ])
    out_path = tmp / "out.json"
    proc = run_extractor([str(sh3d_path), "--geometry", str(geo_path), "--offset", "0,0", "--out", str(out_path)])
    check("extractor: real no-<level> flat layout runs cleanly", proc.returncode == 0, proc.stderr)
    fragment = json.loads(out_path.read_text(encoding="utf-8"))
    check("extractor: no-<level> plan extracts its item (not zero)", len(fragment["furniture"]) == 1, f"{fragment!r}")
    check("extractor: no-<level> plan gives no spurious multi-level warning", "WARNING" not in fragment["notes"])


def test_real_flat_layout_single_level_with_attribute():
    """A real single-level plan CAN declare one empty <level id="..."/> and
    reference it from every piece via level="id" -- still flat, still must
    extract everything, still no warning."""
    tmp = Path(tempfile.mkdtemp())
    geo_path, _ = make_synthetic_geometry(tmp)
    sh3d_path = make_synthetic_sh3d(
        tmp,
        [
            furn_el("Invented single-level shelf", x=60, y=60, width=30, depth=20, height=180, level="level-a"),
            furn_el("Invented single-level plant", x=80, y=80, width=25, depth=25, height=100, level="level-a"),
        ],
        levels=["level-a"],
    )
    out_path = tmp / "out.json"
    proc = run_extractor([str(sh3d_path), "--geometry", str(geo_path), "--offset", "0,0", "--out", str(out_path)])
    check("extractor: single-level-with-attribute layout runs cleanly", proc.returncode == 0, proc.stderr)
    fragment = json.loads(out_path.read_text(encoding="utf-8"))
    check("extractor: single labelled level extracts both items", len(fragment["furniture"]) == 2, f"{fragment!r}")
    check("extractor: single labelled level gives no multi-level warning", "WARNING" not in fragment["notes"])


def test_multi_level_plan_warns_and_reads_first_level_only():
    tmp = Path(tempfile.mkdtemp())
    geo_path, _ = make_synthetic_geometry(tmp)
    sh3d_path = make_synthetic_sh3d(
        tmp,
        [
            furn_el("Invented ground-floor chair", x=60, y=60, width=30, depth=30, height=90, level="level-ground"),
            furn_el("Invented upstairs bed", x=70, y=70, width=140, depth=200, height=60, level="level-upstairs"),
        ],
        levels=["level-ground", "level-upstairs"],
    )
    out_path = tmp / "out.json"
    proc = run_extractor([str(sh3d_path), "--geometry", str(geo_path), "--offset", "0,0", "--out", str(out_path)])
    check("extractor: multi-level fixture runs cleanly", proc.returncode == 0, proc.stderr)
    fragment = json.loads(out_path.read_text(encoding="utf-8"))
    names = {f["source"]["sh3d"] for f in fragment["furniture"]}
    check("extractor: multi-level plan reads only the first level's item", names == {"Invented ground-floor chair"}, f"{fragment!r}")
    check("extractor: multi-level plan warns", "WARNING" in fragment["notes"] and "level" in fragment["notes"].lower())


def test_legacy_nested_layout_still_tolerated():
    """One fixture is deliberately kept in the OLD, non-standard nested shape
    (furniture inside <level>...</level>) -- not how any real SH3D file
    looks, but harmless to tolerate since the parser walks the whole document
    regardless of nesting depth. This is NOT the layout new tests should
    copy; see make_synthetic_sh3d()'s docstring."""
    tmp = Path(tempfile.mkdtemp())
    geo_path, _ = make_synthetic_geometry(tmp)
    sh3d_path = make_synthetic_sh3d(
        tmp, [furn_el("Invented legacy-nested lamp", x=55, y=55, width=20, depth=20, height=40)], nested=True,
    )
    out_path = tmp / "out.json"
    proc = run_extractor([str(sh3d_path), "--geometry", str(geo_path), "--offset", "0,0", "--out", str(out_path)])
    check("extractor: legacy nested layout still runs cleanly", proc.returncode == 0, proc.stderr)
    fragment = json.loads(out_path.read_text(encoding="utf-8"))
    check("extractor: legacy nested layout still extracts its item", len(fragment["furniture"]) == 1, f"{fragment!r}")


def test_offset_required():
    tmp = Path(tempfile.mkdtemp())
    geo_path, _ = make_synthetic_geometry(tmp)
    sh3d_path = make_synthetic_sh3d(tmp, [furn_el("Test Radiator", 100, 100)])
    proc = run_extractor([str(sh3d_path), "--geometry", str(geo_path)])
    check("extractor: --offset is required (missing -> non-zero exit)", proc.returncode != 0)


def test_offset_no_default_in_source():
    """Constant-freshness check: the extractor module must not define ANY
    constant that looks like a default offset. This directly pins acceptance
    criterion 1 ('the offset comes only from the CLI') against silent drift --
    a future edit adding `DEFAULT_OFFSET = ...` would fail this test even if
    every CLI-path test still passed."""
    source = EXTRACTOR.read_text(encoding="utf-8")
    check(
        "extractor source: no DEFAULT_OFFSET / hardcoded offset constant",
        "DEFAULT_OFFSET" not in source and "default=" not in source.split("def parse_offset")[0].split("--offset")[-1][:200],
    )


def test_centre_and_rotation_conversion():
    tmp = Path(tempfile.mkdtemp())
    geo_path, _ = make_synthetic_geometry(tmp)
    # angle=0 -> rotation 0 (faces south/+y). angle=pi/2 -> rotation 90 (west).
    items = [
        furn_el("Invented Sofa", x=100, y=100, angle=0.0, width=60, depth=40, height=80),
        furn_el("Invented Bed", x=200, y=150, angle=math.pi / 2, width=60, depth=40, height=80),
    ]
    sh3d_path = make_synthetic_sh3d(tmp, items)
    out_path = tmp / "out.json"
    proc = run_extractor([
        str(sh3d_path), "--geometry", str(geo_path), "--offset", "10,20", "--out", str(out_path),
    ])
    check("extractor: runs cleanly on synthetic fixture", proc.returncode == 0, proc.stderr)
    fragment = json.loads(out_path.read_text(encoding="utf-8"))
    sofa = next((f for f in fragment["furniture"] if f.get("source", {}).get("sh3d") == "Invented Sofa"), None)
    check("extractor: sofa item present", sofa is not None, f"{fragment!r}")
    # Both fixtures sit ~95-155cm from the nearest wall face, well beyond
    # WALL_REVIEW_MAX_CM (40cm), so neither can snap -- both assertions below
    # are unconditional and deterministic, not "only if it didn't snap".
    check("extractor: sofa is free-anchored, not wall-snapped", "wall" not in sofa, f"{sofa!r}")
    at = sofa["at"]
    check("extractor: at = [x+DX, y+DY]", at == [110.0, 120.0], f"at={at!r}")
    bed = next((f for f in fragment["furniture"] if f.get("source", {}).get("sh3d") == "Invented Bed"), None)
    check("extractor: bed item present", bed is not None, f"{fragment!r}")
    check("extractor: bed is free-anchored, not wall-snapped", "wall" not in bed, f"{bed!r}")
    check("extractor: rotation = degrees(angle) mod 360", abs(bed["rotation"] - 90.0) < 0.01, f"rotation={bed.get('rotation')!r}")


def test_refuses_tracked_output():
    # scripts/ itself is tracked by git in this repo -- refuse writing there.
    proc = run_extractor([
        str(REPO_ROOT / "scripts" / "test-fixture-placeholder.sh3d"),  # doesn't need to exist; refusal happens first
        "--geometry", str(REPO_ROOT / "houses" / "demo" / "geometry.json"),
        "--offset", "0,0",
        "--out", str(REPO_ROOT / "scripts" / "should-not-write.json"),
    ])
    check("extractor: refuses an --out path tracked/trackable by git", proc.returncode != 0)
    check(
        "extractor: refused path was never written",
        not (REPO_ROOT / "scripts" / "should-not-write.json").exists(),
    )


def test_snapping_and_review_flags():
    tmp = Path(tempfile.mkdtemp())
    geo_path, geometry = make_synthetic_geometry(tmp)
    # Wall 1 runs along y=0 from x=0..500, thickness 10 -> room face at y=5
    # (north_room is south of it, i.e. +y side). An item with its back
    # exactly on that face (5 cm from centreline) should snap cleanly.
    # Facing south (rotation 0) means front is +y, so back is at y - depth/2.
    # Put the item so back sits at y=5: at.y = 5 + depth/2.
    depth = 40.0
    at_y_for_flush = 5 + depth / 2  # 25
    items = [
        furn_el("Flush Cabinet", x=100, y=at_y_for_flush, angle=0.0, width=60, depth=depth, height=80),
        # 25 cm further out -> should REVIEW-snap with offset 0, not fail.
        furn_el("Drifted Cabinet", x=200, y=at_y_for_flush + 25, angle=0.0, width=60, depth=depth, height=80),
    ]
    sh3d_path = make_synthetic_sh3d(tmp, items)
    out_path = tmp / "out.json"
    proc = run_extractor([str(sh3d_path), "--geometry", str(geo_path), "--offset", "0,0", "--out", str(out_path)])
    check("extractor: snapping fixture runs cleanly", proc.returncode == 0, proc.stderr)
    fragment = json.loads(out_path.read_text(encoding="utf-8"))
    flush = next((f for f in fragment["furniture"] if f.get("source", {}).get("sh3d") == "Flush Cabinet"), None)
    check("extractor: flush item snapped to a wall", flush is not None and "wall" in flush, f"{flush!r}")
    drifted = next((f for f in fragment["furniture"] if f.get("source", {}).get("sh3d") == "Drifted Cabinet"), None)
    check(
        "extractor: drifted item snapped with a REVIEW note",
        drifted is not None and "wall" in drifted and "REVIEW" in (drifted.get("notes") or ""),
        f"{drifted!r}",
    )


def test_front_facing_wall_is_not_snapped():
    """An item whose FRONT faces the wall (rather than into the room) must
    NOT be snapped -- doing so used to silently turn it 180 degrees, since a
    wall anchor's front always faces into `room` by construction. It should
    be left free and flagged REVIEW instead.
    """
    tmp = Path(tempfile.mkdtemp())
    geo_path, _ = make_synthetic_geometry(tmp)
    # Wall 1: y=0, room face at y=5 (north_room is south of it). rotation=180
    # -> front=(0,-1), i.e. facing north/away from the room, toward the wall.
    depth = 10.0
    items = [
        furn_el("Invented backwards cabinet", x=150, y=10, angle=math.pi, width=60, depth=depth, height=80),
    ]
    sh3d_path = make_synthetic_sh3d(tmp, items)
    out_path = tmp / "out.json"
    proc = run_extractor([str(sh3d_path), "--geometry", str(geo_path), "--offset", "0,0", "--out", str(out_path)])
    check("extractor: front-faces-wall fixture runs cleanly", proc.returncode == 0, proc.stderr)
    fragment = json.loads(out_path.read_text(encoding="utf-8"))
    item = next((f for f in fragment["furniture"] if f.get("source", {}).get("sh3d") == "Invented backwards cabinet"), None)
    check("extractor: front-faces-wall item present", item is not None, f"{fragment!r}")
    check("extractor: front-faces-wall item is left free, NOT snapped (would have been flipped 180deg)", item is not None and "wall" not in item, f"{item!r}")
    check("extractor: front-faces-wall item is flagged REVIEW", "REVIEW" in fragment["notes"] and "front faces wall" in fragment["notes"], f"notes={fragment['notes']!r}")


def test_snapping_uses_the_wall_side_probe_end_to_end():
    """End-to-end regression for the exact gap a reviewer's own mutation
    found: with the §2.3 probe forced to always return the naive/wrong side
    (mutation: wall_side_probe always returning +1), the CLI's snapping
    result on the L-room's own wall 7 must differ from the correct result --
    unlike test_wall_side_probe_l_room, which only calls wall_side_probe()
    directly and would keep passing even if the EXTRACTOR stopped using it.

    The L-room's arm (x in 0..300, y in 100..400) is on the -x (west) side of
    wall 7 (x=300); an item placed inside the arm, front facing west (into
    the room, rotation 90 deg per plan §1), with its back flush on the wall's
    west face, must snap normally. See test_wall_side_probe_l_room for the
    fixture's geometry.

    y=350 is used (rather than the arm's midpoint y=250) because
    make_synthetic_geometry()'s two room polygons overlap in plan space below
    y=300 -- north_room's rectangle is x[0,500] y[0,300] -- so an item's
    centre there would be assigned to north_room instead of l_room by
    convert()'s first-match room lookup. y=350 sits inside l_room's arm
    (y 100..400) and outside north_room's rectangle (y up to 300 only).
    """
    tmp = Path(tempfile.mkdtemp())
    geo_path, _ = make_synthetic_geometry(tmp)
    depth = 40.0
    wall7_face_x = 300 - 5  # thickness/2 on the -x (west) side
    at_x = wall7_face_x - depth / 2.0  # back flush on the wall's west face
    at_y = 350.0  # inside l_room's arm only -- see docstring
    items = [
        furn_el("Invented arm wardrobe", x=at_x, y=at_y, angle=math.radians(90), width=60, depth=depth, height=200),
    ]
    sh3d_path = make_synthetic_sh3d(tmp, items)
    out_path = tmp / "out.json"
    proc = run_extractor([str(sh3d_path), "--geometry", str(geo_path), "--offset", "0,0", "--out", str(out_path)])
    check("extractor: L-room wall-7 snap fixture runs cleanly", proc.returncode == 0, proc.stderr)
    fragment = json.loads(out_path.read_text(encoding="utf-8"))
    item = next((f for f in fragment["furniture"] if f.get("source", {}).get("sh3d") == "Invented arm wardrobe"), None)
    check("extractor: arm wardrobe present", item is not None, f"{fragment!r}")
    check(
        "extractor: arm wardrobe snaps to wall 7 using the LOCAL probe (would fail or snap wrong with a bbox-midpoint or forced-side probe)",
        item is not None and item.get("wall") == 7 and abs(item.get("centre", -999) - at_y) < 0.5,
        f"{item!r}",
    )


def test_kitchen_run_aggregation():
    tmp = Path(tempfile.mkdtemp())
    geo_path, _ = make_synthetic_geometry(tmp)
    depth = 40.0
    at_y = 5 + depth / 2
    items = [
        furn_el("Base cabinet unit", x=80, y=at_y, angle=0.0, width=60, depth=depth, height=85),
        furn_el("Hob module", x=150, y=at_y, angle=0.0, width=60, depth=depth, height=85),
        furn_el("Sink base", x=220, y=at_y, angle=0.0, width=60, depth=depth, height=85),
    ]
    sh3d_path = make_synthetic_sh3d(tmp, items)
    out_path = tmp / "out.json"
    proc = run_extractor([str(sh3d_path), "--geometry", str(geo_path), "--offset", "0,0", "--out", str(out_path)])
    check("extractor: kitchen fixture runs cleanly", proc.returncode == 0, proc.stderr)
    fragment = json.loads(out_path.read_text(encoding="utf-8"))
    runs = [f for f in fragment["furniture"] if f["type"] == "kitchen-base-run"]
    check("extractor: 3 kitchen items aggregate into 1 kitchen-base-run", len(runs) == 1, f"runs={runs!r}")
    if runs:
        check("extractor: aggregated run has 3 modules", len(runs[0]["params"]["modules"]) == 3, f"{runs[0]!r}")
        kinds = {m["kind"] for m in runs[0]["params"]["modules"]}
        check("extractor: module kinds include hob and sink", {"hob", "sink"} <= kinds, f"{kinds!r}")


def test_kitchen_run_centre_from_extent_not_mean_of_centres():
    """The run centre must be the MIDPOINT OF THE RUN'S EXTENT (leftmost
    module's start to rightmost module's end), not the mean of the members'
    own centres -- the mean is wrong whenever module widths differ, because
    it weights every module as if it were the same size. Uses two modules of
    very different widths so the two formulas give different answers, which
    is what makes this test able to fail.
    """
    tmp = Path(tempfile.mkdtemp())
    geo_path, _ = make_synthetic_geometry(tmp)
    depth = 40.0
    at_y = 5 + depth / 2
    # A 30cm-wide module centred at x=30 (spans 15..45) and a 90cm-wide
    # module centred at x=105 (spans 60..150). Extent midpoint = (15+150)/2
    # = 82.5. Mean of centres = (30+105)/2 = 67.5 -- a different number,
    # which is what proves the fix is doing extent-based maths.
    items = [
        furn_el("Sink base narrow", x=30, y=at_y, angle=0.0, width=30, depth=depth, height=85),
        furn_el("Oven wide", x=105, y=at_y, angle=0.0, width=90, depth=depth, height=85),
    ]
    sh3d_path = make_synthetic_sh3d(tmp, items)
    out_path = tmp / "out.json"
    proc = run_extractor([str(sh3d_path), "--geometry", str(geo_path), "--offset", "0,0", "--out", str(out_path)])
    check("extractor: asymmetric-width kitchen fixture runs cleanly", proc.returncode == 0, proc.stderr)
    fragment = json.loads(out_path.read_text(encoding="utf-8"))
    runs = [f for f in fragment["furniture"] if f["type"] == "kitchen-base-run"]
    check("extractor: asymmetric-width run present", len(runs) == 1, f"{fragment!r}")
    if runs:
        check(
            "extractor: run centre is the extent midpoint (82.5), not the mean of centres (67.5)",
            abs(runs[0]["centre"] - 82.5) < 0.5,
            f"centre={runs[0]['centre']!r}",
        )


def test_kitchen_wall_run_keeps_elevation():
    tmp = Path(tempfile.mkdtemp())
    geo_path, _ = make_synthetic_geometry(tmp)
    depth = 35.0
    at_y = 5 + depth / 2
    items = [
        furn_el("Upper cabinet unit", x=80, y=at_y, angle=0.0, width=60, depth=depth, height=70, elevation=140),
        furn_el("Extractor hood", x=150, y=at_y, angle=0.0, width=60, depth=depth, height=50, elevation=160),
    ]
    sh3d_path = make_synthetic_sh3d(tmp, items)
    out_path = tmp / "out.json"
    proc = run_extractor([str(sh3d_path), "--geometry", str(geo_path), "--offset", "0,0", "--out", str(out_path)])
    check("extractor: kitchen-wall-run fixture runs cleanly", proc.returncode == 0, proc.stderr)
    fragment = json.loads(out_path.read_text(encoding="utf-8"))
    runs = [f for f in fragment["furniture"] if f["type"] == "kitchen-wall-run"]
    check("extractor: kitchen-wall-run present", len(runs) == 1, f"{fragment!r}")
    if runs:
        check(
            "extractor: kitchen-wall-run keeps a non-zero elevation (upper cabinets don't land on the floor)",
            runs[0].get("elevation", 0) > 0,
            f"{runs[0]!r}",
        )


def test_kitchen_run_keeps_per_module_review_notes():
    tmp = Path(tempfile.mkdtemp())
    geo_path, _ = make_synthetic_geometry(tmp)
    depth = 40.0
    at_y_flush = 5 + depth / 2
    items = [
        furn_el("Base cabinet flush", x=80, y=at_y_flush, angle=0.0, width=60, depth=depth, height=85),
        # 25cm further out than flush -- individually this would earn a
        # REVIEW note from try_snap_to_wall before aggregation folds it in.
        furn_el("Oven drifted", x=150, y=at_y_flush + 25, angle=0.0, width=60, depth=depth, height=85),
    ]
    sh3d_path = make_synthetic_sh3d(tmp, items)
    out_path = tmp / "out.json"
    proc = run_extractor([str(sh3d_path), "--geometry", str(geo_path), "--offset", "0,0", "--out", str(out_path)])
    check("extractor: mixed-review kitchen fixture runs cleanly", proc.returncode == 0, proc.stderr)
    fragment = json.loads(out_path.read_text(encoding="utf-8"))
    runs = [f for f in fragment["furniture"] if f["type"] == "kitchen-base-run"]
    check("extractor: mixed-review run present", len(runs) == 1, f"{fragment!r}")
    if runs:
        check(
            "extractor: the drifted module's REVIEW note survives aggregation into the run",
            "REVIEW" in runs[0].get("notes", "") and "Oven drifted" in runs[0].get("notes", ""),
            f"{runs[0]!r}",
        )


def test_mirror_folds_into_wardrobe_on_its_front_face():
    """The realistic case the reviewer's own reproduction used: a mirror
    sitting ON THE WARDROBE'S FRONT FACE (about depth/2 from its centre),
    not at the wardrobe's centre point -- the old centre-to-centre distance
    check never folds this, because depth/2 is far more than the 2cm
    threshold. Both items are free-anchored (not wall-snapped) here; the
    wall-snapped case is covered separately below, since that is the other
    half of what the old code got wrong (mixing wall-local and plan
    coordinates).
    """
    tmp = Path(tempfile.mkdtemp())
    geo_path, _ = make_synthetic_geometry(tmp)
    depth = 60.0
    # Wardrobe faces south (rotation 0, front = (0,1)); its front face sits
    # at y = centre_y + depth/2 = 150 + 30 = 180. Far from any wall in this
    # fixture (>40cm from every wall face), so it stays free-anchored.
    items = [
        furn_el("Invented wardrobe", x=100, y=150, angle=0.0, width=100, depth=depth, height=200),
        # On the wardrobe's front face (y=180), not its centre (y=150).
        furn_el("Wall mirror panel", x=100, y=180, angle=0.0, width=100, depth=2, height=180),
    ]
    sh3d_path = make_synthetic_sh3d(tmp, items)
    out_path = tmp / "out.json"
    proc = run_extractor([str(sh3d_path), "--geometry", str(geo_path), "--offset", "0,0", "--out", str(out_path)])
    check("extractor: front-face mirror-fold fixture runs cleanly", proc.returncode == 0, proc.stderr)
    fragment = json.loads(out_path.read_text(encoding="utf-8"))
    cabinets = [f for f in fragment["furniture"] if f["type"] == "cabinet"]
    check("extractor: mirror on the front face folded away, one cabinet remains", len(cabinets) == 1, f"{fragment!r}")
    if cabinets:
        check("extractor: wardrobe gained a mirror front (front-face case)", "mirror" in cabinets[0]["params"].get("fronts", []), f"{cabinets[0]!r}")


def test_mirror_folds_into_wall_snapped_wardrobe_front():
    """The review's OWN reproduction: a wall-snapped wardrobe with a mirror
    on its front face never folded, because the old code compared a
    wall-anchored item's raw `centre` (a wall-LOCAL number) paired with a
    fake y of 0 against the mirror's plan-coordinate `at` -- two different
    coordinate systems that can never be close to each other. Uses the same
    north_room wall 1 (y=0, thickness 10, room face at y=5) as the snapping
    fixture above.
    """
    tmp = Path(tempfile.mkdtemp())
    geo_path, _ = make_synthetic_geometry(tmp)
    depth = 60.0
    wall_face_y = 5.0  # wall 1's room face
    wardrobe_at_y = wall_face_y + depth / 2.0  # back flush on the wall
    wardrobe_front_y = wardrobe_at_y + depth / 2.0  # == wall_face_y + depth
    items = [
        furn_el("Invented tall wardrobe", x=150, y=wardrobe_at_y, angle=0.0, width=100, depth=depth, height=220),
        # Sits right on the wardrobe's front face, not at its (wall-local)
        # centre. Named without "door" -- SKIP_NAME_HINTS treats any name
        # containing "door" as an actual sh3d door fixture (doorOrWindow),
        # which this mirror panel is not.
        furn_el("Wardrobe front mirror panel", x=150, y=wardrobe_front_y, angle=0.0, width=100, depth=2, height=200),
    ]
    sh3d_path = make_synthetic_sh3d(tmp, items)
    out_path = tmp / "out.json"
    proc = run_extractor([str(sh3d_path), "--geometry", str(geo_path), "--offset", "0,0", "--out", str(out_path)])
    check("extractor: wall-snapped mirror-fold fixture runs cleanly", proc.returncode == 0, proc.stderr)
    fragment = json.loads(out_path.read_text(encoding="utf-8"))
    cabinets = [f for f in fragment["furniture"] if f["type"] == "cabinet"]
    check("extractor: wardrobe is wall-snapped in this fixture", len(cabinets) == 1 and "wall" in cabinets[0], f"{fragment!r}")
    check("extractor: mirror folded into the wall-snapped wardrobe's front", cabinets and "mirror" in cabinets[0]["params"].get("fronts", []), f"{cabinets!r}")


def test_duplicate_names_get_unique_ids():
    """Two pieces sharing a name (very common -- 'Radiator' twice) must NOT
    collide on id. The plan's own convention is `<room>_<type>_<n>`; the
    second occurrence must be suffixed, not silently identical to the first.
    """
    tmp = Path(tempfile.mkdtemp())
    geo_path, _ = make_synthetic_geometry(tmp)
    items = [
        furn_el("Radiator", x=50, y=50, angle=0.0, width=70, depth=12, height=55),
        furn_el("Radiator", x=150, y=250, angle=0.0, width=70, depth=12, height=55),
    ]
    sh3d_path = make_synthetic_sh3d(tmp, items)
    out_path = tmp / "out.json"
    proc = run_extractor([str(sh3d_path), "--geometry", str(geo_path), "--offset", "0,0", "--out", str(out_path)])
    check("extractor: duplicate-name fixture runs cleanly", proc.returncode == 0, proc.stderr)
    fragment = json.loads(out_path.read_text(encoding="utf-8"))
    radiators = [f for f in fragment["furniture"] if f["type"] == "radiator"]
    check("extractor: both radiators are present as separate items", len(radiators) == 2, f"{fragment!r}")
    ids = {r["id"] for r in radiators}
    check("extractor: the two radiators got DIFFERENT ids", len(ids) == 2, f"ids={ids!r}")
    check("extractor: ids follow the <room>_<type>[_<n>] convention", all("_" in i for i in ids), f"ids={ids!r}")


def test_apply_refuses_fragment_with_duplicate_ids():
    """The other half of the same finding: even if a fragment somehow DOES
    contain a duplicate id (hand-edited, or from some other generator),
    furniture-apply.py must refuse it outright rather than silently merging
    the second occurrence into the first -- which used to happen (same
    room/type looks like a legitimate upsert) and left the live file with
    ONE item where the fragment proposed two, exit 0, no warning.
    """
    tmp = Path(tempfile.mkdtemp())
    geo_path, _ = make_synthetic_geometry(tmp)
    before = geo_path.read_bytes()
    fragment = {
        "proposedBy": "test", "basedOn": geo_path.stat().st_mtime,
        "furniture": [
            {"id": "dup-id", "room": "north_room", "type": "box", "at": [1, 1], "rotation": 0, "params": {}},
            {"id": "dup-id", "room": "north_room", "type": "box", "at": [2, 2], "rotation": 0, "params": {}},
        ],
        "notes": "",
    }
    frag_path = tmp / "fragment.json"
    frag_path.write_text(json.dumps(fragment), encoding="utf-8")

    proc = run_apply(["--geometry", str(geo_path), "--fragment", str(frag_path), "--skip-furniture-schema"])
    check("apply: refuses a fragment containing a duplicate id, even with --replace absent", proc.returncode != 0, proc.stderr)
    check("apply: live file untouched after refusing a duplicate-id fragment", geo_path.read_bytes() == before)

    proc2 = run_apply(["--geometry", str(geo_path), "--fragment", str(frag_path), "--skip-furniture-schema", "--replace"])
    check("apply: --replace does NOT bypass the duplicate-id-within-fragment refusal", proc2.returncode != 0, proc2.stderr)
    check("apply: live file still untouched with --replace too", geo_path.read_bytes() == before)


def test_furniture_group_not_double_counted():
    """A furnitureGroup wraps its member pieceOfFurniture elements in real
    SH3D XML. The group container itself must not be emitted as its own item
    (it has no meaningful params of its own here) -- only its children
    should appear, exactly once each.
    """
    tmp = Path(tempfile.mkdtemp())
    geo_path, _ = make_synthetic_geometry(tmp)
    child_xml = furn_el("Invented grouped lamp", x=52, y=52, width=20, depth=20, height=40)
    group_xml = group_el("Invented Group", x=50, y=50, children_xml=child_xml)
    sh3d_path = make_synthetic_sh3d(tmp, [group_xml])
    out_path = tmp / "out.json"
    proc = run_extractor([str(sh3d_path), "--geometry", str(geo_path), "--offset", "0,0", "--out", str(out_path)])
    check("extractor: furnitureGroup fixture runs cleanly", proc.returncode == 0, proc.stderr)
    fragment = json.loads(out_path.read_text(encoding="utf-8"))
    names = [f["source"]["sh3d"] for f in fragment["furniture"]]
    check("extractor: the group container is not emitted as an item", "Invented Group" not in names, f"{names!r}")
    check("extractor: the group's child is emitted exactly once", names.count("Invented grouped lamp") == 1, f"{names!r}")


def test_light_fixtures_are_reported_as_skipped():
    tmp = Path(tempfile.mkdtemp())
    geo_path, _ = make_synthetic_geometry(tmp)
    light_xml = '<light name="Invented ceiling lamp" x="60" y="60" angle="0" width="30" depth="30" height="10" elevation="240" modelMirrored="false" visible="true" power="100.0" />\n'
    sh3d_path = make_synthetic_sh3d(tmp, [light_xml])
    out_path = tmp / "out.json"
    proc = run_extractor([str(sh3d_path), "--geometry", str(geo_path), "--offset", "0,0", "--out", str(out_path)])
    check("extractor: light-only fixture runs cleanly", proc.returncode == 0, proc.stderr)
    fragment = json.loads(out_path.read_text(encoding="utf-8"))
    check("extractor: a <light> produces no furniture item", fragment["furniture"] == [], f"{fragment!r}")
    check("extractor: the skipped light is reported by name", "Invented ceiling lamp" in fragment["notes"], f"notes={fragment['notes']!r}")


def test_output_validates_against_schema_or_skips_with_note():
    """Acceptance criterion 8: 'Its output validates against the PR1a schema
    (the check is skipped with a note until PR1a merges).' Confirms today's
    state honestly: houses/schema.json has no furniture[] property yet, so
    the fragment's shape cannot be schema-checked directly (a fragment is not
    a full geometry document anyway) -- this asserts that condition rather
    than pretending it validates."""
    schema = json.loads((REPO_ROOT / "houses" / "schema.json").read_text(encoding="utf-8"))
    geometry_def = None
    for _, defn in schema.get("$defs", {}).items():
        props = defn.get("properties", {})
        if props.get("kind", {}).get("const") == "geometry":
            geometry_def = defn
            break
    has_furniture_prop = bool(geometry_def and "furniture" in geometry_def.get("properties", {}))
    check(
        "PR1a schema note: furniture[] is not yet a recognised property (skip is correct, not stale)",
        not has_furniture_prop,
        "PR1a has landed furniture[] in the schema -- the extractor's fragment output can now be "
        "schema-checked directly; update this test and docs/sh3d-import.md accordingly",
    )


# ---------------------------------------------------------------------------
# Tests: furniture-apply.py
# ---------------------------------------------------------------------------
def run_apply(args):
    proc = subprocess.run(
        [sys.executable, str(APPLY)] + args,
        capture_output=True, text=True,
    )
    return proc


def test_skip_furniture_schema_still_runs_structural_checks():
    """`--skip-furniture-schema` must skip ONLY the schema verdict on the
    `furniture` property -- every structural/cross-reference check in
    check_geometry must still run for real. Proven here with a geometry that
    has nothing wrong with its furniture at all, but a genuine STRUCTURAL
    defect elsewhere (a duplicate wall id) -- if the flag skipped validation
    wholesale, this would incorrectly succeed.
    """
    tmp = Path(tempfile.mkdtemp())
    geo_path, geometry = make_synthetic_geometry(tmp)
    # Corrupt: wall 8 duplicated as wall 1 too (same id twice).
    geometry["walls"]["segments"][3]["id"] = 1  # was id 8; now collides with wall 1
    geo_path.write_text(json.dumps(geometry, indent=2), encoding="utf-8")
    before = geo_path.read_bytes()

    fragment = {
        "proposedBy": "test", "basedOn": geo_path.stat().st_mtime,
        "furniture": [{"id": "invented-shelf", "room": "north_room", "type": "shelf", "at": [10, 10], "rotation": 0, "params": {}}],
        "notes": "",
    }
    frag_path = tmp / "fragment.json"
    frag_path.write_text(json.dumps(fragment), encoding="utf-8")

    proc = run_apply(["--geometry", str(geo_path), "--fragment", str(frag_path), "--skip-furniture-schema"])
    check(
        "apply: --skip-furniture-schema still catches a genuine STRUCTURAL defect (duplicate wall id)",
        proc.returncode != 0, proc.stderr,
    )
    check("apply: live file untouched when a structural check fails under --skip-furniture-schema", geo_path.read_bytes() == before)
    check("apply: --skip-furniture-schema prints its warning", "WARNING" in proc.stderr and "skip" in proc.stderr.lower())


def test_apply_upserts_and_backs_up():
    tmp = Path(tempfile.mkdtemp())
    geo_path, _ = make_synthetic_geometry(tmp)
    fragment = {
        "proposedBy": "test",
        "basedOn": geo_path.stat().st_mtime,
        "furniture": [
            {"id": "invented-lamp", "room": "north_room", "type": "box", "at": [50, 50], "rotation": 0, "params": {"width": 20, "depth": 20, "height": 40}},
        ],
        "notes": "synthetic",
    }
    frag_path = tmp / "fragment.json"
    frag_path.write_text(json.dumps(fragment), encoding="utf-8")

    proc = run_apply(["--geometry", str(geo_path), "--fragment", str(frag_path), "--skip-furniture-schema"])
    check("apply: succeeds on a clean upsert", proc.returncode == 0, proc.stderr)

    result = json.loads(geo_path.read_text(encoding="utf-8"))
    check("apply: item present in live file", any(f["id"] == "invented-lamp" for f in result.get("furniture", [])))
    check("apply: schemaVersion bumped to at least 1.2", tuple(int(p) for p in result["schemaVersion"].split(".")) >= (1, 2))

    backups = list(tmp.glob("geometry.json.bak-*"))
    check("apply: exactly one backup created", len(backups) == 1, f"{backups!r}")
    if backups:
        original = make_synthetic_geometry(Path(tempfile.mkdtemp()))[1]
        backed_up = json.loads(backups[0].read_text(encoding="utf-8"))
        check("apply: backup matches the PRE-apply content (no furniture item)", "furniture" not in backed_up or not backed_up["furniture"])


def test_apply_refuses_id_collision_without_replace():
    tmp = Path(tempfile.mkdtemp())
    geo_path, geometry = make_synthetic_geometry(tmp)
    geometry["furniture"] = [{"id": "shared-id", "room": "north_room", "type": "box", "at": [1, 1], "rotation": 0, "params": {}}]
    geo_path.write_text(json.dumps(geometry, indent=2), encoding="utf-8")

    fragment = {
        "proposedBy": "test", "basedOn": geo_path.stat().st_mtime,
        "furniture": [{"id": "shared-id", "room": "l_room", "type": "cabinet", "at": [2, 2], "rotation": 0, "params": {}}],
        "notes": "",
    }
    frag_path = tmp / "fragment.json"
    frag_path.write_text(json.dumps(fragment), encoding="utf-8")

    before = geo_path.read_bytes()
    proc = run_apply(["--geometry", str(geo_path), "--fragment", str(frag_path), "--skip-furniture-schema"])
    check("apply: refuses a room/type-changing id collision without --replace", proc.returncode != 0)
    check("apply: live file untouched after the refusal", geo_path.read_bytes() == before)

    proc2 = run_apply(["--geometry", str(geo_path), "--fragment", str(frag_path), "--skip-furniture-schema", "--replace"])
    check("apply: --replace allows the same collision", proc2.returncode == 0, proc2.stderr)
    result = json.loads(geo_path.read_text(encoding="utf-8"))
    replaced = next(f for f in result["furniture"] if f["id"] == "shared-id")
    check("apply: --replace actually replaced room/type", replaced["room"] == "l_room" and replaced["type"] == "cabinet")


def test_apply_never_overwrites_same_day_backup():
    tmp = Path(tempfile.mkdtemp())
    geo_path, _ = make_synthetic_geometry(tmp)
    date = furniture_apply.datetime.date.today().strftime("%Y%m%d")
    pre_existing_backup = tmp / f"geometry.json.bak-{date}-furniture-north_room"
    pre_existing_backup.write_text("PRE-EXISTING BACKUP CONTENT -- must survive", encoding="utf-8")

    fragment = {
        "proposedBy": "test", "basedOn": geo_path.stat().st_mtime,
        "furniture": [{"id": "invented-shelf", "room": "north_room", "type": "shelf", "at": [10, 10], "rotation": 0, "params": {}}],
        "notes": "",
    }
    frag_path = tmp / "fragment.json"
    frag_path.write_text(json.dumps(fragment), encoding="utf-8")

    proc = run_apply(["--geometry", str(geo_path), "--fragment", str(frag_path), "--skip-furniture-schema"])
    check("apply: succeeds even with a same-day backup already present", proc.returncode == 0, proc.stderr)
    check(
        "apply: pre-existing same-day backup is untouched",
        pre_existing_backup.read_text(encoding="utf-8") == "PRE-EXISTING BACKUP CONTENT -- must survive",
    )
    check("apply: a second, differently-named backup was created instead", (tmp / f"geometry.json.bak-{date}-furniture-north_room-2").exists())


def test_apply_rolls_back_on_validation_failure():
    """Forces a real --strict failure (no --skip-furniture-schema) by leaving the
    fragment's furniture[] in place against the CURRENT schema, which does not
    yet declare that property -- exactly the PR1a-not-merged-yet situation
    this script must handle safely rather than corrupt the live file over."""
    tmp = Path(tempfile.mkdtemp())
    geo_path, _ = make_synthetic_geometry(tmp)
    before = geo_path.read_bytes()

    fragment = {
        "proposedBy": "test", "basedOn": geo_path.stat().st_mtime,
        "furniture": [{"id": "invented-plant", "room": "north_room", "type": "plant", "at": [30, 30], "rotation": 0, "params": {}}],
        "notes": "",
    }
    frag_path = tmp / "fragment.json"
    frag_path.write_text(json.dumps(fragment), encoding="utf-8")

    proc = run_apply(["--geometry", str(geo_path), "--fragment", str(frag_path)])  # no --skip-furniture-schema
    check(
        "apply: --strict validation fails today (furniture[] not yet in the schema) -- exit 1",
        proc.returncode == 1, proc.stderr,
    )
    check("apply: live file is byte-identical after a validation failure", geo_path.read_bytes() == before)
    check("apply: no temp file left behind after a validation failure", not any(tmp.glob("geometry.json.tmp-*")))


def test_apply_aborts_on_mtime_change():
    tmp = Path(tempfile.mkdtemp())
    geo_path, _ = make_synthetic_geometry(tmp)
    before = geo_path.read_bytes()
    stale_mtime = geo_path.stat().st_mtime

    fragment = {
        "proposedBy": "test", "basedOn": stale_mtime,
        "furniture": [{"id": "invented-clock", "room": "north_room", "type": "clock", "at": [5, 5], "rotation": 0, "params": {}}],
        "notes": "",
    }
    frag_path = tmp / "fragment.json"
    frag_path.write_text(json.dumps(fragment), encoding="utf-8")

    # Simulate something else touching the live file after step 1 would have
    # read it, by calling apply() directly and monkeypatching the "read"
    # mtime check: easiest reliable way is to bump the file's mtime on disk
    # between the two stat() calls apply() makes. os.utime with a future time
    # guarantees a detectable change regardless of filesystem timestamp
    # resolution.
    import os as _os

    original_apply_module_apply = furniture_apply.apply

    def patched_apply(geometry_path, fragment_path, replace, skip_furniture_schema=False):
        geometry_path = Path(geometry_path)
        # Touch the file's mtime forward right after furniture_apply.apply
        # would have done its step-1 read, by wrapping load_json.
        original_load_json = furniture_apply.load_json
        call_count = {"n": 0}

        def wrapped_load_json(path):
            result = original_load_json(path)
            call_count["n"] += 1
            if call_count["n"] == 1 and Path(path) == geometry_path:
                # Bump mtime forward by a large, unambiguous amount.
                future = time.time() + 120
                _os.utime(geometry_path, (future, future))
            return result

        furniture_apply.load_json = wrapped_load_json
        try:
            return original_apply_module_apply(geometry_path, fragment_path, replace, skip_furniture_schema)
        finally:
            furniture_apply.load_json = original_load_json

    try:
        patched_apply(geo_path, frag_path, False, skip_furniture_schema=True)
        mtime_guard_raised = False
    except furniture_apply.ApplyError as exc:
        mtime_guard_raised = "mtime" in str(exc) or "modified" in str(exc)

    check("apply: aborts when the live file's mtime changed mid-run", mtime_guard_raised)
    # os.utime() only touches the mtime metadata, never the file's content, so
    # this is a real, unconditional byte-for-byte check -- not weakened to
    # "or True". If the abort path ever wrote anything before raising, this
    # is what would catch it.
    check("apply: live file untouched after an mtime-guard abort", geo_path.read_bytes() == before)


def test_apply_cleans_up_backup_on_failed_swap():
    """os.replace() can fail (PermissionError on Windows/SMB when something
    else has the live file open without FILE_SHARE_DELETE). The live file
    must stay untouched, the backup that was JUST written must be deleted
    (nothing will ever restore from it, because nothing changed), and the
    reported error must be a clean ApplyError, not a raw OSError traceback.
    """
    tmp = Path(tempfile.mkdtemp())
    geo_path, _ = make_synthetic_geometry(tmp)
    before = geo_path.read_bytes()

    fragment = {
        "proposedBy": "test", "basedOn": geo_path.stat().st_mtime,
        "furniture": [{"id": "invented-mirror", "room": "north_room", "type": "mirror", "at": [5, 5], "rotation": 0, "params": {}}],
        "notes": "",
    }
    frag_path = tmp / "fragment.json"
    frag_path.write_text(json.dumps(fragment), encoding="utf-8")

    original_replace = furniture_apply.os.replace

    def failing_replace(src, dst):
        raise OSError(5, "simulated: the process cannot access the file because it is being used by another process")

    furniture_apply.os.replace = failing_replace
    try:
        raised = None
        try:
            furniture_apply.apply(geo_path, frag_path, False, skip_furniture_schema=True)
        except furniture_apply.ApplyError as exc:
            raised = exc
    finally:
        furniture_apply.os.replace = original_replace

    check("apply: a failed os.replace raises a clean ApplyError (not a raw OSError)", isinstance(raised, furniture_apply.ApplyError), f"raised={raised!r}")
    check("apply: live file untouched after a failed swap", geo_path.read_bytes() == before)
    check("apply: no orphan backup left behind after a failed swap", not any(tmp.glob("geometry.json.bak-*")))
    check("apply: no temp file left behind after a failed swap", not any(tmp.glob("geometry.json.tmp-*")))


# ---------------------------------------------------------------------------
def main():
    tests = [
        test_inside_poly,
        test_wall_side_probe_l_room,
        test_wall_side_probe_neither_both,
        test_real_flat_layout_no_level_extracts_everything,
        test_real_flat_layout_single_level_with_attribute,
        test_multi_level_plan_warns_and_reads_first_level_only,
        test_legacy_nested_layout_still_tolerated,
        test_offset_required,
        test_offset_no_default_in_source,
        test_centre_and_rotation_conversion,
        test_refuses_tracked_output,
        test_snapping_and_review_flags,
        test_front_facing_wall_is_not_snapped,
        test_snapping_uses_the_wall_side_probe_end_to_end,
        test_kitchen_run_aggregation,
        test_kitchen_run_centre_from_extent_not_mean_of_centres,
        test_kitchen_wall_run_keeps_elevation,
        test_kitchen_run_keeps_per_module_review_notes,
        test_mirror_folds_into_wardrobe_on_its_front_face,
        test_mirror_folds_into_wall_snapped_wardrobe_front,
        test_duplicate_names_get_unique_ids,
        test_apply_refuses_fragment_with_duplicate_ids,
        test_furniture_group_not_double_counted,
        test_light_fixtures_are_reported_as_skipped,
        test_output_validates_against_schema_or_skips_with_note,
        test_skip_furniture_schema_still_runs_structural_checks,
        test_apply_upserts_and_backs_up,
        test_apply_refuses_id_collision_without_replace,
        test_apply_never_overwrites_same_day_backup,
        test_apply_rolls_back_on_validation_failure,
        test_apply_aborts_on_mtime_change,
        test_apply_cleans_up_backup_on_failed_swap,
    ]
    for t in tests:
        try:
            t()
        except Exception as exc:  # noqa: BLE001 -- a test raising IS a failure
            global FAIL
            FAIL += 1
            print(f"FAIL  {t.__name__}  raised {exc!r}")

    print(f"\n{PASS} passed, {FAIL} failed")
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
