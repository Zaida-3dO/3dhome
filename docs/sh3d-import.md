# Importing furniture from a SweetHome3D plan

Two scripts turn a SweetHome3D (`.sh3d`) plan into `furniture[]` entries on a
3dHome house profile, and apply them safely:

```
houses/<house>/geometry.json  <--apply--  staging fragment  <--extract--  plan.sh3d
```

- **`scripts/sh3d-furniture.py`** reads a `.sh3d` plan and a target
  `geometry.json` (to resolve room and wall ids against), and writes a
  **staging fragment** -- a proposal, not a change to any live file.
- **`scripts/furniture-apply.py`** is the only thing that writes a live
  `geometry.json`. It takes a staging fragment, merges it in, validates the
  result, and swaps it in atomically.

Every number in this document is invented for illustration. Neither script
ships with, or needs, any real house's coordinates.

---

## `scripts/sh3d-furniture.py`

```
python scripts/sh3d-furniture.py plan.sh3d \
  --geometry houses/example-house/geometry.json \
  --offset 120,45 \
  --out staging/furniture/lounge--sh3d-draft--20260101.json
```

### Arguments

| Flag | Required | Meaning |
|---|---|---|
| `plan.sh3d` (positional, or `--sh3d`) | yes | the SweetHome3D plan to read |
| `--geometry <path>` | yes | the target house's `geometry.json`, used to resolve room polygons and wall ids -- never written to |
| `--offset DX,DY` | **yes, always** | cm added to every extracted item's plan position |
| `--map <path.json>` | no | a JSON file of `{"name fragment": "type"}` rules, checked before the built-in table |
| `--out <path>` | no (default: stdout) | where to write the staging fragment |
| `--proposed-by <name>` | no | recorded in the fragment's `proposedBy` field |

**There is no default offset**, in code or in this document, and there never
will be: a SweetHome3D plan's own origin has no fixed relationship to a
3dHome profile's `coordinateTransform`. A wrong offset silently mis-places
every item it touches, so it is required on every run rather than assumed.

### What it does

- **Reads** `Home.xml` from inside the `.sh3d` zip, in memory, with the
  standard library only (`zipfile` + `xml.etree.ElementTree`). It never
  writes back to the `.sh3d` file.
- **Converts** each piece of furniture:
  - `at = [x + DX, y + DY]` (SH3D's `x`/`y` are already the footprint centre)
  - `rotation = degrees(angle) mod 360`
  - `width`/`depth`/`height` become `params.width/depth/height`; `elevation`
    is copied
  - `modelMirrored="true"` becomes `params.mirrored: true`, noted in the
    report
- **Assigns a room** by testing which room polygon contains the item's centre.
  An item that falls inside no room is left unassigned and flagged for review.
- **Snaps to a wall** when the item's back edge is parallel to an
  axis-aligned wall's room face, overlaps its span, and is within about 10 cm
  of it -- it becomes a `wall`/`centre`/`offset` item instead of a free `at`
  item. An item 10-40 cm off a face is still snapped, with `offset: 0`, but
  is flagged `REVIEW` in its `notes` field -- this is what catches furniture
  that was drawn against a wall that has since moved.

  The wall-side test used here (which side of the wall the room is actually
  on) is the fixed probe from plan §2.3: a point is checked a few cm past
  each face of the wall at the item's own position, rather than comparing
  against the room's overall bounding-box midpoint. The old bbox-midpoint
  approach picks the wrong side for a wall that only borders part of an
  L-shaped room. **As of this PR, the schema/loader work that lands this fix
  in `src/house-loader.js` and `scripts/validate-house.py` (plan PR1a) has
  not merged yet**, so this probe is implemented directly in this script
  rather than shared with them. Once PR1a lands the same probe in
  `validate-house.py`, the duplication should be resolved by importing or
  porting from there instead of maintaining two copies.
- **Maps common SweetHome3D catalogue names to 3dHome types** through a
  small, editable rule table (`--map` adds to it, checked first): radiators,
  fridges, wardrobes/dressers/bedside tables/glass cabinets to `cabinet`,
  desks to `standing-desk`, chairs to `gaming-chair`, shelves, TVs, monitors,
  plants, picture frames to `wall-art`, clocks. Kitchen lower-cabinet, oven,
  hob, sink, dishwasher and washer entries on the same wall are **aggregated**
  into a single `kitchen-base-run` item with an ordered `modules` list; upper
  cabinets and hoods aggregate the same way into `kitchen-wall-run`. A mirror
  found within about 2 cm of a wardrobe's front is folded into that
  wardrobe's `params.fronts` instead of becoming its own item. Anything that
  matches nothing becomes a generic `box` with `priority: "minor"`, flagged
  for review.
- **Skips**, with the reason recorded in the report: doors, windows,
  curtains, bathroom fixtures, anything marked `visible="false"`, and
  anything named as a rug (rugs become a suggested `rooms[].rug.polygon`
  instead of a furniture entry -- not implemented by this pass; the note in
  the report says so). A plan with more than one level is read from its
  first level only, with a warning.
- **Refuses a `--out` path that git would ever track.** If the path is
  already tracked, or sits inside a git work tree and is not covered by
  `.gitignore`, the script exits with an error rather than writing -- this
  repo is public, and this is the one guard against a real extracted plan
  landing in it by accident. Writing outside any git work tree, or to
  stdout, is always allowed.

### Output

A JSON object:

```json
{
  "proposedBy": "sh3d-furniture.py",
  "basedOn": 1767225600.0,
  "furniture": [
    { "id": "invented-radiator", "room": "example-room", "type": "radiator",
      "wall": 3, "centre": 210.5, "offset": 0,
      "params": { "width": 70, "height": 55, "depth": 10 },
      "priority": "normal", "source": { "sh3d": "Invented Radiator" } }
  ],
  "notes": "SKIP 'Invented Door': door/window/curtain, handled elsewhere\n..."
}
```

`basedOn` is the target `geometry.json`'s mtime at read time, which
`furniture-apply.py` compares against the live file's mtime before applying,
warning if the fragment appears to be stale.

The `notes` field (and a stderr echo) list every `SKIP`, `REVIEW` and `NOTE`
produced during the run -- read them before applying. This script never
applies anything itself.

### Testing

`scripts/test-sh3d-furniture.py` builds a synthetic `.sh3d` (a hand-built
`Home.xml`, zipped, in a fresh temp directory) with made-up names,
coordinates and offsets, and a synthetic `geometry.json` fixture with an
L-shaped room specifically to exercise the wall-side probe against the case
it exists to fix. Nothing here reads a real house or a real `.sh3d`.

---

## `scripts/furniture-apply.py`

The **single writer** for a house's `furniture[]` (plan §0.3): the only
script that is allowed to modify a live `geometry.json`. Everything else
(the extractor above, or a hand-edited staging file) only ever proposes a
fragment for this tool to apply.

```
python scripts/furniture-apply.py \
  --geometry houses/example-house/geometry.json \
  --fragment staging/furniture/lounge--sh3d-draft--20260101.json
```

| Flag | Required | Meaning |
|---|---|---|
| `--geometry <path>` | yes | the live file to update |
| `--fragment <path>` | yes | the staging fragment to apply |
| `--replace` | no | allow overwriting an id that already exists with a **different** room or type |
| `--skip-schema-check` | no | skip the `validate-house.py --strict` run (see below) |

### Algorithm

This is the design from the plan's round-2 amendment, §A5, which **replaces**
the original `furniture-apply.py` design in plan §4:

1. Read the current `geometry.json` and upsert the fragment's items into it
   **in memory**, by `id`. An id that already exists with a different room or
   type is refused unless `--replace` is given -- that mismatch usually means
   two different physical items were accidentally given the same id.
2. Write the merged result to a **temp file in the same directory**:
   `geometry.json.tmp-<pid>`.
3. Run `validate-house.py --strict` on the **temp file only**. On any
   failure, delete the temp file, exit 1, and leave the live file untouched.
4. Back up the live file to `geometry.json.bak-<yyyymmdd>-furniture-<room>`.
   If that name already exists, `-2`, `-3`, ... are tried instead. **An
   existing backup is never overwritten.**
5. Swap the temp file in with `os.replace(temp, geometry.json)`, which is
   atomic on the same volume.
6. If the live file's mtime changed between step 1 and step 5, the run
   **aborts before the swap** -- a second guard alongside the single-writer
   convention, for the case where something else wrote the file while this
   one was running.

On any failure at any step, the live file is left byte-identical to how it
started.

### Why `--skip-schema-check` exists, and when to use it

The furniture schema itself (`furniture[]`, its `$defs`, the 1.2 version
bump) is being built in parallel, in plan PR1a, and had not merged as of this
PR. Until it has, `houses/schema.json` does not recognise a `furniture`
property at all (its geometry definition uses `additionalProperties: false`),
so `validate-house.py --strict` on **any** file carrying `furniture[]`
fails schema validation today, correctly -- not a bug in this tool. Passing
`--skip-schema-check` runs every other check in `apply()` (upsert rules,
temp-file write, backup-never-overwritten, atomic swap, mtime guard) without
that one. **Once PR1a merges, drop `--skip-schema-check` from normal use** --
the real gate is `validate-house.py --strict` running for real, and this flag
existing at all is a stopgap for the parallel-PR window, not a permanent
escape hatch.

### Testing

`scripts/test-sh3d-furniture.py` (the same file as the extractor's tests,
since the two tools work on the same synthetic fixtures) covers: a clean
upsert with a schema-version bump; a same-room/type id upsert; a
different-room/type id collision refused without `--replace` and allowed
with it; a same-day backup that already exists being left untouched while a
`-2` backup is created instead; a forced `--strict` validation failure (using
today's real schema, which does not yet know `furniture[]`) leaving the live
file byte-identical and no temp file behind; and an mtime change between the
initial read and the swap aborting before anything is written. All of it runs
against synthetic geometry fixtures built fresh in a temp directory.
