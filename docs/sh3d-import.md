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
- **Reads the real SweetHome3D layout.** `pieceOfFurniture` and
  `furnitureGroup` elements are **top-level children of `<home>`**, each
  optionally naming its level through a `level="<id>"` attribute; `<level>`
  itself, when present, is an **empty sibling element** with no nested
  children. A plan with only one level commonly has no `<level>` element and
  no `level` attribute at all. A `furnitureGroup`'s own container is not
  emitted as an item -- only its member `pieceOfFurniture` children are (SH3D
  bakes each child's absolute position, so the group's own transform is
  never applied a second time). A plan with more than one distinct level is
  read from its first level only, **with a warning**; a single-level or
  no-level plan extracts everything with no spurious warning. SH3D `<light>`
  (lamp) fixtures are reported as skipped by name, same as any other
  unsupported piece.
- **Converts** each piece of furniture:
  - `at = [x + DX, y + DY]` (SH3D's `x`/`y` are already the footprint centre)
  - `rotation = degrees(angle) mod 360`
  - `width`/`depth`/`height` become `params.width/depth/height`; `elevation`
    is copied
  - `modelMirrored="true"` becomes `params.mirrored: true`, noted in the
    report
  - `id` follows the plan's `<room>_<type>` convention (e.g.
    `office_radiator`); a second item that maps to the same room and type
    gets a numbered suffix (`office_radiator_2`, ...) so two source pieces
    sharing a name can never collide on id.
- **Assigns a room** by testing which room polygon contains the item's centre.
  An item that falls inside no room is left unassigned and flagged for review.
- **Snaps to a wall** when the item's back edge is parallel to an
  axis-aligned wall's room face, overlaps its span, and is within about 10 cm
  of it -- it becomes a `wall`/`centre`/`offset` item instead of a free `at`
  item. An item 10-40 cm off a face is still snapped, with `offset: 0`, but
  is flagged `REVIEW` in its `notes` field -- this is what catches furniture
  that was drawn against a wall that has since moved. `centre` is clamped to
  the wall's own span (and flagged `REVIEW` if clamping moved it) rather than
  ever being proposed outside it, which the schema will reject. An item whose
  **front faces the wall** (rather than into the room) is left free and
  flagged `REVIEW` instead of being snapped -- snapping it would silently
  turn it 180 degrees, since a wall anchor's front always faces into `room`
  by construction.

  The wall-side test used here (which side of the wall the room is actually
  on) is the fixed probe from plan §2.3: a point is checked a few cm past
  each face of the wall at the item's own position, rather than comparing
  against the room's overall bounding-box midpoint. The old bbox-midpoint
  approach picks the wrong side for a wall that only borders part of an
  L-shaped room. **PR1a (item 10b5faa1) has since merged** and now carries
  its own copy of this probe in both `src/house-loader.js` and
  `scripts/validate-house.py`. This script's copy was written before that
  landed and has not been consolidated with PR1a's -- porting or importing
  from there instead of maintaining two Python copies is a known follow-up,
  out of this PR's own territory (`scripts/validate-house.py` belongs to
  10b5faa1).
- **Maps common SweetHome3D catalogue names to 3dHome types** through a
  small, editable rule table (`--map` adds to it, checked first): radiators,
  fridges, wardrobes/dressers/bedside tables/glass cabinets to `cabinet`,
  desks to `standing-desk`, chairs to `gaming-chair`, shelves, TVs, monitors,
  plants, picture frames to `wall-art`, clocks. Kitchen lower-cabinet, oven,
  hob, sink, dishwasher and washer entries on the same wall are **aggregated**
  into a single `kitchen-base-run` item with an ordered `modules` list; upper
  cabinets and hoods aggregate the same way into `kitchen-wall-run`, which
  keeps a representative (maximum) `elevation` across its members so upper
  cabinets don't collapse to the floor. Each run's `centre` is the midpoint of
  its own extent (leftmost module's start to rightmost module's end), not the
  mean of the members' centres, which would be wrong whenever module widths
  differ. A folded module's own `REVIEW` note (e.g. from snapping slightly
  off the wall) is carried into the run's `notes` rather than dropped.

  A mirror found within about 2 cm of a wardrobe's **front-face plane**
  (measured in one consistent plan-coordinate system for both anchor forms,
  and only when the mirror's own position projects within that face's span)
  is folded into that wardrobe's `params.fronts` instead of becoming its own
  item. Anything that matches nothing becomes a generic `box` with
  `priority: "minor"`, flagged for review.
- **Skips**, with the reason recorded in the report: doors, windows,
  curtains, bathroom fixtures, anything marked `visible="false"`, SH3D
  `<light>` fixtures, and anything named as a rug (rugs become a suggested
  `rooms[].rug.polygon` instead of a furniture entry -- not implemented by
  this pass; the note in the report says so).
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
| `--skip-furniture-schema` | no | skip *only* the schema-validation verdict on the `furniture` property (see below) |

### Algorithm

This is the design from the plan's round-2 amendment, §A5, which **replaces**
the original `furniture-apply.py` design in plan §4:

1. Read the current `geometry.json` and upsert the fragment's items into it
   **in memory**, by `id`. **The fragment is refused outright if it contains
   the same id twice**, before any merging happens -- a same-id collision
   used to be merged silently (the second occurrence overwrote the first,
   since matching room/type looks like a legitimate update), which left the
   live file with one item where the fragment proposed two, with no warning.
   An id that already exists **in the live file** with a different room or
   type is refused unless `--replace` is given -- that mismatch usually means
   two different physical items were accidentally given the same id.
2. Write the merged result to a **temp file in the same directory**:
   `geometry.json.tmp-<pid>`.
3. Run `validate-house.py` on the **temp file only**. On any failure, delete
   the temp file, exit 1, and leave the live file untouched.
4. Back up the live file to `geometry.json.bak-<yyyymmdd>-furniture-<room>`.
   If that name already exists, `-2`, `-3`, ... are tried instead. **An
   existing backup is never overwritten.**
5. Swap the temp file in with `os.replace(temp, geometry.json)`, which is
   atomic on the same volume (including an SMB share -- see "Running against
   a network share" below). **If the swap itself fails** (see below), the
   backup just written is deleted (nothing will ever restore from it, since
   nothing changed) and a clean one-line error is reported, not a raw
   traceback.
6. If the live file's mtime changed between step 1 and step 5, the run
   **aborts before the swap** -- a second guard alongside the single-writer
   convention, for the case where something else wrote the file while this
   one was running.

On any failure at any step, the live file is left byte-identical to how it
started.

### Running against a network share

The real target, `X:/projects/3dhome/house/geometry.json`, is on an **SMB
mount**, not a local disk. `os.replace()`'s atomicity guarantee holds there
too, for the same reason it holds locally: the temp file is always written
into the **same directory** as the live file (never a different mount), so
the rename-with-replace is a single filesystem operation on one share.

If something else has the live file open without `FILE_SHARE_DELETE` (an
editor with the file open, or a backup/antivirus tool scanning it at the
wrong moment -- a common situation on Windows and SMB alike), `os.replace()`
raises `PermissionError` (Windows error 5) rather than silently doing nothing
or corrupting the file. This tool catches that, cleans up the orphaned
backup, and reports one line telling you to close whatever has the file open
and re-run. The live file itself is untouched either way.

### `--skip-furniture-schema`: no longer needed for normal use

This flag was written while the furniture schema itself (`furniture[]`, its
`$defs`, the 1.2 version bump) was being built in parallel, in plan PR1a.
**PR1a has since merged**, so `houses/schema.json` now recognises `furniture`
as a normal property, and a well-formed fragment validates in full with no
flag at all -- that is the default, recommended path.

The flag is kept as a **documented fallback**, not removed, because it still
does something real: it skips *only* the schema-validation verdict on the
`furniture` property, while every other check still runs against a copy of
the merged file with `furniture` stripped out (duplicate room/wall ids, a
door or window referencing a non-existent wall, a centre outside a wall's
span, and everything else `validate-house.py`'s structural and
cross-reference checks catch). It prints a `WARNING` line every time it is
used, so a run with it enabled is never silently indistinguishable from a
fully-validated one. Reach for it only when debugging a furniture-schema
false positive or running against an older schema checkout -- not as a
routine part of applying a fragment.

### Testing

`scripts/test-sh3d-furniture.py` (the same file as the extractor's tests,
since the two tools work on the same synthetic fixtures) covers: a clean
upsert with a schema-version bump; a same-room/type id upsert; a
different-room/type id collision refused without `--replace` and allowed
with it; a fragment containing a duplicate id refused outright, with or
without `--replace`; a same-day backup that already exists being left
untouched while a `-2` backup is created instead; a forced validation
failure (using today's real schema, which does not yet know `furniture[]`)
leaving the live file byte-identical and no temp file behind; `--skip-
furniture-schema` still catching a genuine structural defect (a duplicate
wall id) that has nothing to do with the furniture schema gap; an mtime
change between the initial read and the swap aborting before anything is
written; and a simulated `os.replace()` failure leaving the live file
untouched with the orphaned backup cleaned up. All of it runs against
synthetic geometry fixtures built fresh in a temp directory.
