#!/usr/bin/env python3
"""Apply a staged furniture fragment to a house's geometry.json -- the single
writer for `furniture[]` (plan-furniture-system-r2 §0.3, design per the round-2
amendment §A5, which replaces the original design in §4).

This script is meant to be run by whoever owns write access to the target
geometry.json (in this repo's own workflow, that is the orchestrator; nothing
here is specific to that). Crews propose changes as staging fragments; this
tool is the only thing that writes the live file.

Usage:
    python scripts/furniture-apply.py --geometry houses/demo/geometry.json \\
        --fragment staging/furniture/lounge--sh3d-draft.json

    python scripts/furniture-apply.py --geometry houses/demo/geometry.json \\
        --fragment staging/furniture/lounge--sh3d-draft.json --replace

Algorithm (§A5, replacing the original plan text -- read this, not §4):
    1. Read the current geometry.json and upsert the fragment's furniture[] in
       memory, by id. An id that already exists with a different room or type
       is refused unless --replace is given.
    2. Write the merged result to a temp file in the SAME directory:
       geometry.json.tmp-<pid>.
    3. Run validate-house.py --strict on the temp file. On any failure, delete
       the temp file, exit 1, and leave the live file byte-identical.
    4. Back up the live file to geometry.json.bak-<yyyymmdd>-furniture-<room>.
       If that name exists, append -2, -3, ... An existing backup is NEVER
       overwritten.
    5. Swap the temp file in with os.replace(temp, geometry.json), atomic on
       the same volume.
    6. If geometry.json's mtime changed between step 1 and step 5, abort
       BEFORE the swap (delete the temp file, exit 1, leave the live file
       untouched) -- a second guard alongside the single-writer convention,
       for the case where something else wrote the file while this ran.

On any failure at any step, the live file is left byte-identical to how it
started. This script never touches the .sh3d source, and never runs against a
network share -- both the geometry.json and staging fragment are ordinary
local paths given on the command line.
"""

import argparse
import datetime
import json
import os
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
VALIDATOR = REPO_ROOT / "scripts" / "validate-house.py"


class ApplyError(Exception):
    """Raised for any condition that must abort the apply with exit 1."""


def load_json(path):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def upsert_furniture(geometry, fragment_items, replace):
    """Merge fragment_items into geometry['furniture'] by id, in place.

    An id that already exists with the same room and type is overwritten
    (upsert). An id that exists with a DIFFERENT room or type is refused
    unless replace=True, because that usually means two different physical
    items were accidentally given the same id.
    """
    existing = geometry.setdefault("furniture", [])
    by_id = {item["id"]: (i, item) for i, item in enumerate(existing)}

    for new_item in fragment_items:
        iid = new_item.get("id")
        if not iid:
            raise ApplyError(f"fragment item has no id: {new_item!r}")
        if iid in by_id:
            idx, old_item = by_id[iid]
            same_room = old_item.get("room") == new_item.get("room")
            same_type = old_item.get("type") == new_item.get("type")
            if not (same_room and same_type) and not replace:
                raise ApplyError(
                    f"id '{iid}' already exists with room={old_item.get('room')!r} "
                    f"type={old_item.get('type')!r}, but the fragment gives "
                    f"room={new_item.get('room')!r} type={new_item.get('type')!r}. "
                    f"Pass --replace to overwrite it anyway."
                )
            existing[idx] = new_item
            by_id[iid] = (idx, new_item)
        else:
            existing.append(new_item)
            by_id[iid] = (len(existing) - 1, new_item)


def bump_schema_version(geometry, minimum="1.2"):
    def _parts(v):
        try:
            return tuple(int(p) for p in str(v).split(".", 1))
        except ValueError:
            return (0, 0)

    current = geometry.get("schemaVersion")
    if _parts(current) < _parts(minimum):
        geometry["schemaVersion"] = minimum


def run_validator_strict(target_path):
    """Runs validate-house.py --strict on a single file target.

    Returns (ok, output). ok is False on any validator error OR if the
    validator process itself could not be run.
    """
    if not VALIDATOR.exists():
        return False, f"validator not found at {VALIDATOR}"
    proc = subprocess.run(
        [sys.executable, str(VALIDATOR), str(target_path), "--strict"],
        capture_output=True, text=True,
    )
    output = proc.stdout + proc.stderr
    return proc.returncode == 0, output


def next_backup_path(geometry_path, room_label):
    date = datetime.date.today().strftime("%Y%m%d")
    base = geometry_path.parent / f"{geometry_path.name}.bak-{date}-furniture-{room_label}"
    if not base.exists():
        return base
    n = 2
    while True:
        candidate = geometry_path.parent / f"{base.name}-{n}"
        if not candidate.exists():
            return candidate
        n += 1


def infer_room_label(fragment):
    rooms = sorted({item.get("room", "unknown") for item in fragment.get("furniture", [])})
    if not rooms:
        return "unknown"
    if len(rooms) == 1:
        return rooms[0]
    return "multi"


def apply(geometry_path, fragment_path, replace, skip_schema_check=False):
    geometry_path = Path(geometry_path)
    fragment_path = Path(fragment_path)

    if not geometry_path.exists():
        raise ApplyError(f"geometry file not found: {geometry_path}")
    if not fragment_path.exists():
        raise ApplyError(f"fragment file not found: {fragment_path}")

    # Step 1: read current state and the mtime we're basing this run on.
    mtime_before = geometry_path.stat().st_mtime
    geometry = load_json(geometry_path)
    fragment = load_json(fragment_path)

    based_on = fragment.get("basedOn")
    if based_on is not None:
        try:
            if float(based_on) < mtime_before - 1e-6:
                print(
                    f"WARNING: fragment's basedOn ({based_on}) is older than "
                    f"{geometry_path}'s current mtime ({mtime_before}) -- it may "
                    f"have been staged against an older version of the file",
                    file=sys.stderr,
                )
        except (TypeError, ValueError):
            pass

    upsert_furniture(geometry, fragment.get("furniture", []), replace)
    bump_schema_version(geometry)

    # Step 2: write to a temp file in the SAME directory (so os.replace in
    # step 5 is same-volume and therefore atomic).
    temp_path = geometry_path.parent / f"{geometry_path.name}.tmp-{os.getpid()}"
    try:
        temp_path.write_text(json.dumps(geometry, indent=2) + "\n", encoding="utf-8")

        # Step 3: validate the temp copy with --strict. Never the live file.
        if not skip_schema_check:
            ok, output = run_validator_strict(temp_path)
            if not ok:
                print(output, file=sys.stderr)
                raise ApplyError("validation of the merged result failed -- live file untouched")

        # Step 4: back up the live file. Never overwrite an existing backup.
        room_label = infer_room_label(fragment)
        backup_path = next_backup_path(geometry_path, room_label)

        # Step 6: abort BEFORE the swap if the live file changed underneath us.
        mtime_now = geometry_path.stat().st_mtime
        if mtime_now != mtime_before:
            raise ApplyError(
                f"{geometry_path} was modified during this run (mtime changed from "
                f"{mtime_before} to {mtime_now}) -- aborting before the swap; re-run "
                f"against the current file"
            )

        backup_path.write_bytes(geometry_path.read_bytes())

        # Step 5: atomic swap.
        os.replace(temp_path, geometry_path)
    finally:
        if temp_path.exists():
            temp_path.unlink()

    return backup_path


def build_arg_parser():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--geometry", required=True, help="path to the live geometry.json")
    p.add_argument("--fragment", required=True, help="path to the staged furniture fragment")
    p.add_argument("--replace", action="store_true", help="allow overwriting an id that exists with a different room or type")
    p.add_argument(
        "--skip-schema-check", action="store_true",
        help="skip the validate-house.py --strict run (for use only until PR1a's furniture "
             "schema has merged; see docs/sh3d-import.md)",
    )
    return p


def main(argv):
    args = build_arg_parser().parse_args(argv[1:])
    try:
        backup_path = apply(args.geometry, args.fragment, args.replace, args.skip_schema_check)
    except ApplyError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1
    print(f"applied {args.fragment} to {args.geometry} (backup: {backup_path})")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
