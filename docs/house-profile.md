# The house profile format

A **house profile** is how 3dHome knows what your home looks like. The engine
(`src/`) contains no geometry at all; every room, wall, door and light comes from
a profile directory under `houses/`.

```
houses/
  demo/                 ← the committed example house
    geometry.json       ← the physical model: rooms, walls, doors, lights, materials
    rooms.json          ← Home Assistant entity bindings (optional)
    textures/           ← any wallpaper images this house references
  myhouse/              ← yours
```

Select one with `HOME3D_HOUSE=myhouse` or `?house=myhouse`.

Both files are described by a single JSON Schema, `houses/schema.json`
(draft 2020-12). Validate at any time:

```
python scripts/validate-house.py houses/myhouse
```

---

## Why two files

`geometry.json` describes **shapes**. It is safe to publish, fork, diff and share
— a floor plan with no address on it.

`rooms.json` describes **your devices**: which Home Assistant entity switches
which light in which room, and where your Home Assistant lives. That is an
inventory of the hardware installed in your home, and it is exactly the half you
would not want to put in a public repository.

Keeping them apart means you can share a house model without handing over the
device list, and it means `rooms.json` can be bind-mounted or generated at
deploy time and left out of git entirely, while the geometry stays version
controlled where diffs are useful.

The access token is in **neither** file. It comes from runtime configuration
only. Never put a token in a house profile.

---

## Units — read this before you type any numbers

There are two coordinate systems and it matters which one you are in.

**Plan space** is what you author. Every position, length and thickness in a
profile is in **centimetres**, in whatever coordinate frame your floor plan
happens to use. `x` increases **east**, `y` increases **south**. These are
literally the numbers a Sweet Home 3D export gives you — you paste them in
unchanged.

**World space** is what the renderer draws in: **metres**, with `+X` east and
`+Z` south. You never write world coordinates.

The bridge is `coordinateTransform`:

```
worldX = (planX - originX) * scale
worldZ = (planY - originY) * scale
```

Only two numbers in the whole format are metres, and both say so in the schema:
a camera preset's `distance`, and a texture's `repeatMetres`. Everything else is
centimetres. This is deliberate — allowing a second unit for plan geometry would
double the number of places a conversion can be forgotten, and the source data is
centimetres anyway.

Note that `y` increasing *south* means plan `y` is **not** a mathematical y-axis.
A room's north edge has a *smaller* y than its south edge. This trips everyone up
once. It is kept because it matches Sweet Home 3D and matches how floor plans are
drawn on screen (top of the image = north = small y).

---

## Deriving the transform from a Sweet Home 3D export

`coordinateTransform` **must** be in your profile. It cannot be a constant in the
engine, because a Sweet Home 3D plan's origin is wherever the author happened to
start drawing — every export has different offsets. A house profile with someone
else's transform renders off-centre, or at the wrong scale, or both.

1. **Scale.** Sweet Home 3D works in centimetres. Your profile is in centimetres.
   So `scale` is `0.01` — the cm-to-metres factor the renderer applies. If your
   plan is in millimetres, convert the numbers to cm first rather than setting
   `scale` to `0.001`; keeping one unit in the file is worth the find-and-replace.

2. **Origin.** Pick any convenient point in your plan and make it world zero.
   The two sane choices are:

   - **A corner of the building.** Read the smallest x and smallest y across all
     your walls (the north-west corner of the bounding box) and use those. Simple,
     and puts the whole house in the positive quadrant.
   - **The centre of the footprint.** Average the min and max x, and the min and
     max y. This puts the house *around* the origin, which is what the default
     camera framing and the ground plane assume, so it usually looks better with
     no further tuning.

   The choice only shifts where the model sits relative to the world origin. It
   does not change the shape of anything.

   Worked example, using the reference house's own numbers: its walls span
   x ≈ 273 … 1311 and y ≈ −20 … 792. The profile uses `originX: 299,
   originY: 13` — near the north-west interior corner, chosen because that is
   what the original export produced. Centre-of-footprint would have been
   `originX: 792, originY: 386` instead; both are correct.

3. **North.** If your plan is not drawn with true north at the top, set
   `site.northOffsetDegrees` to the rotation (degrees clockwise from plan-north
   to true north). The daylight rig uses it to put the sun in the right place; get
   it wrong and light comes through the wrong windows at the wrong time of day.

---

## `geometry.json`

### Top level

| Field | Required | What it is |
|---|---|---|
| `kind` | yes | `"geometry"`. Tells the validator which half of the schema to apply. |
| `schemaVersion` | yes | Which version of the schema you wrote against, `"MAJOR.MINOR"`. `rooms.json` is at `"1.10"`: `1.1` added the optional `sensors` block, `1.2` its `curtains`/`corniceLights` keys, `1.3` its `climate` key, `1.4` its `vacuums` key, `1.5` its `plants` key, `1.6` its `items` key, `1.7` its `roomScripts` key, `1.8` the `switches` rows of an item card, `1.9` its `cameras` rows and `1.10` its `actions` rows and a TV row's `art` condition. `geometry.json` is at `"1.4"`: `1.1` added the optional `windows` and `curtains`, `1.2` the optional `furniture`, `1.3` a wall's optional `finishes`, and `1.4` the optional camera-focus `view` on a room, a furniture item or a curtain. Older profiles still load. The engine refuses a MAJOR it does not know and may migrate an older MINOR. |
| `id` | yes | Profile id; should match the directory name, since that is what `HOME3D_HOUSE` selects. |
| `name` | yes | Display name. |
| `units` | no | `"cm"`. The only value. |
| `coordinateTransform` | yes | See above. |
| `defaults` | no | House-wide fallbacks (wall height, wall thickness, door height…) so you are not repeating `250` a hundred times. |
| `materials` | no | House-wide finishes: wall paint colour, ceiling, door slab. |
| `viewCentre` | no | Point the default cameras look at. Defaults to the footprint's middle. |
| `decor` | no | Bespoke decoration this house asks for by name — see below. |
| `site` | no | Latitude for the daylight rig. **Give a city-level latitude, not a rooftop one** — the sun calculation cannot tell the difference, and a shared profile then does not locate a building. |
| `rooms` | yes | The rooms. |
| `walls` | yes | The walls. |
| `slabs` | no | Hand-traced floor and ceiling outlines. Omit and both are derived from rooms + wall footprints — see below. |
| `doors` | no | The doors. |
| `windows` | no | Windows and balcony glazing, each carving its own opening — see below. |
| `curtains` | no | Curtains, blackout or sheer, hung on the room face of a wall — see below. |
| `furniture` | no | Placed furniture, free-standing or wall-anchored — see below. Needs `schemaVersion` `1.2`. |
| `lights` | no | The light fixtures, grouped by room. |
| `cameraPresets` | no | Per-house camera overrides. Usually omit — see below. |

### Room id is the join key

Every room has an `id` and a `label`.

`label` is what a human reads ("Living Room"). Change it whenever you like.

`id` is the identity of that room everywhere else in the project:

- `doors[].room` — which room's slider drives this door
- `lights[].room` — which room these fixtures are in
- `rooms.json`'s `rooms` map — which entities light this room
- the debug overlays, and the engine's per-room state

Renaming an `id` breaks all of those silently-ish (the validator will catch the
dangling references, which is why you should run it). Pick ids once — lowercase,
`snake_case` — and keep them.

### Rooms

A room is a **polygon**, not a rectangle. Real rooms have notches for pillars,
L-shaped returns and chamfered corners, and a bounding rectangle would put walls
through the middle of them. List the outline as an ordered ring of `[x, y]`
points and **do not repeat the first point at the end** — the ring closes
implicitly.

Leave `areaSqm` out. The engine computes the area from the polygon by the
shoelace formula, which means it can never go stale. Supply it only if the
authoritative figure genuinely differs from the polygon (a surveyed area that
excludes a chimney breast your polygon includes); the validator will warn if the
two disagree by more than 2%, which is usually how you discover a polygon edit
that nobody propagated.

#### `footstepZone` — manually confining the presence footstep trail

By default the engine derives where a room's presence-footstep trail walks
entirely from the room polygon and its doors: the door with the longest clear
run inside the room decides the start point and direction, and the walk turns
once around a corner if the room is L-shaped. No configuration is needed for
this, and most rooms should never need `footstepZone` at all.

That automatic placement reads the polygon as empty floor, which a real,
furnished room often is not. A kitchen's polygon says nothing about the run of
counters along one wall or the table in the middle of the room; a hallway's
polygon says nothing about which end reads as "the store" rather than "the
hall". `footstepZone` gives the room a rectangle to confine the walk to instead
of the full polygon, for exactly the rooms where the automatic placement looks
wrong once you can see it rendered.

```json
{
  "id": "kitchen",
  "label": "Kitchen",
  "polygon": [[0, 0], [400, 0], [400, 300], [0, 300]],
  "footstepZone": {
    "from": [40, 40],
    "to": [280, 140],
    "relativeTo": "room"
  }
}
```

**Coordinates are relative to the room's own derived bounding-box min corner**
(its smallest x and smallest y), not absolute plan coordinates — so a zone
keeps working if the room's polygon is later nudged during authoring, and so
you can write one by looking at the room in isolation without re-deriving the
house's global origin. `from` and `to` are opposite corners; the engine sorts
them, so `from` need not be the top-left one. `relativeTo` is required and
must be the literal string `"room"` — the only anchoring this engine
understands today — spelled out explicitly so a future zone anchored some
other way (to a fixture, say) can never be confused with this one.

**Treat the numbers as a starting point, not a computed answer.** Unlike
everything else the loader derives, nobody gets a footstep zone right from
measurements alone on the first try — it wants tuning by eye against the
rendered scene. Pick an obviously wrong-looking rectangle to start from rather
than a carefully measured one; you will be adjusting it anyway.

A room with no `footstepZone` renders exactly as it did before the field
existed — this is purely an opt-in override.

#### `footstepPath` — an authored route for the footstep trail

When you know the route people actually take — along the middle of a corridor
to the radiator, under the dining table toward the counters — give the room a
`footstepPath`: an ordered list of waypoints the trail walks along.

```json
"footstepPath": {
  "points": [[195, 218], [265, 218], [265, 85], [55, 80]],
  "relativeTo": "room",
  "smooth": true
}
```

- **Waypoint order is the direction of travel.** The first print sits on the
  first waypoint and the last print on the last waypoint; in between they are
  evenly spaced at the stride nearest 34 cm that fits the path exactly,
  alternating left and right of the line and facing along it. There is no
  count cap: the length you draw is the length you get.
- **Coordinates are relative to the room's bbox min corner**, exactly as for
  `footstepZone`, and `relativeTo` must be `"room"`.
- **Every waypoint must lie inside the room polygon.** If any does not, the
  whole path is ignored with a console warning and the room falls back to its
  `footstepZone` or to automatic placement. `scripts/validate-house.py`
  reports the offending waypoint as an error, and WARNS when a segment between
  two waypoints leaves the room (add a waypoint to route round the corner) or
  when the door gap would leave the path with no prints at all.
- `smooth` (default `true`) rounds the corners between waypoints; the
  endpoints never move. Set it to `false` for a sharp turn.
- **It takes precedence over `footstepZone`**, so a room with a path needs no
  zone.

The demo house's L-shaped study carries one.

#### The door gap — applies to every trail

No footprint is ever laid within **40 cm** (`DOOR_GAP_CM` in
`src/footstep-walk.js`) of any door opening, measured from the print's centre
to the nearest point of the opening. This applies to authored paths and to
automatic placement alike, so a trail always reads as squarely inside one
room instead of standing in a doorway. Prints inside the gap are simply not
drawn — so start and end a path a little way clear of doors.

### Walls

One entry per straight run, given as **centreline** endpoints plus a thickness:

```json
{ "id": 6, "start": [648.7, 752.6], "end": [648.7, 6.4], "thickness": 10.0, "exterior": false }
```

Interior and exterior walls live in the **same list**, distinguished only by the
`exterior` flag. There is no separate "exterior walls" array. That is a
deliberate choice: two parallel arrays is the classic setup for editing a wall in
one and forgetting the other.

`exterior: true` means "part of the outer shell" and controls the **camera-facing
fade** — exterior walls go transparent when you look into the house from outside,
so you can see in. It is a rendering role, not a structural claim. A pillar in
the middle of a room may be marked `exterior: false` purely to keep it solid
while the shell behind it fades.

**Pillars and stub returns are ordinary walls**: a short segment with a big
thickness. There is no separate pillar type.

**Wall ids are permanent.** The id is what a person says out loud ("wall 22 has
the wallpaper") and what the debug overlay prints on screen, so it must not be
derived from array position — deleting one wall would silently renumber every
later one, and every screenshot and note referring to "wall 22" would then point
somewhere else. Record the highest id you have ever used in
`walls.highestIdEverAssigned`, mint new ids above it, and never reuse a retired
one. The validator enforces this.

**Wall finishes** (`schemaVersion` `1.3`). `finishes` puts a procedural
finish — `brick` or `tile` — on **one long face** of a wall, optionally over
only a height band and a span. Each entry names its face by `side`
(`"exterior"`, or a compass side) or by `room` (the face fronting that room,
found the same way a window finds its room face); give exactly one.

```json
{ "id": 3, "start": [900, 700], "end": [0, 700], "thickness": 20.0, "exterior": true,
  "finishes": [ { "finish": "brick", "side": "exterior" } ] }

{ "id": 14, "start": [420, 380], "end": [420, 700], "thickness": 10.0,
  "finishes": [ { "finish": "tile", "room": "bathroom", "to": 120 },
                { "finish": "tile", "room": "bathroom", "from": 120, "along": [540, 700] } ] }
```

- `from` / `to` — cm above the floor. Omit for the whole height (an exterior
  wall's goes down through the slab).
- `along` — `[start, end]` in plan cm on the wall's long axis, the same numbers
  as a door's `centre`. Omit for the whole length.
- `gridAnchor` — where the grid starts vertically. `"floor"` (the default) puts
  the joints at 0, 25, 50 … cm above the floor for the default tile, whatever
  `from` is, so every band on every wall courses together. `"from"` starts the
  grid at the band's own `from`, so a whole tile sits exactly on it — one row
  of tile straight off a 93 cm countertop is:

  ```json
  { "finish": "tile", "room": "bathroom", "from": 93, "to": 118, "gridAnchor": "from" }
  ```

  With the default anchor that same band would show a joint at 100 — a 7 cm
  sliver under an 18 cm piece. The grid's start **along** the wall is not
  anchored (column joints run from the wall's start), and a reveal courses with
  the face it returns from.
- `brick` is the running-bond buff brick from the WindowSpec and
  BalconyWindowSpec pages, at real UK brick size. `tile` is the bathroom spec
  pages' tile: a 40 × 25 cm landscape tile in a 0.4 cm joint, greige
  (`#cdc2b1`) with a darker grout (`#a89c87`), flat — the same tile the vanity
  counter draws.
- `look` (tile only) changes the tile. Every property is optional:

  | Property | Default | Meaning |
  |---|---|---|
  | `size` | `[40, 25]` | One tile's width and height in cm, joint included. |
  | `grout` | `0.4` | The joint, cm. `0` for butt-jointed. |
  | `colour` | `"#cdc2b1"` | The tile face. |
  | `groutColour` | `"#a89c87"` | The joint. |
  | `relief` | `0` | `0` is a flat tile. Otherwise the face is embossed with a grid of squares about this many cm across, each its own shade, with a faint highlight between them — not grout. `5` on the default tile is an 8 × 5 grid. |
  | `roughness` | `0.55` | The material's roughness (the embossed wet-area tile is `0.35`). |

  ```json
  { "finish": "tile", "side": "west", "from": 0, "look": { "relief": 5, "roughness": 0.35 } }
  ```

  A bad value is warned about and falls back to its default; the tile is still
  drawn. Each distinct look is its own small canvas (256 × 160 px for the
  default tile, never over 512 a side).
- `exterior` is the long face pointing away from the house footprint's centre.
  For a wall in the notch of an L-shaped house that is wrong — name the compass
  side instead.
- A compass side that points **along** the wall names that **end** face: the
  north face of a pillar drawn as a short north–south segment is
  `"side": "north"`. `"start"` / `"end"` name the ends by the segment's own
  authored points. `along` does not apply to an end face.
- `reveals` wraps the finish round the jambs of the wall's doors and windows
  and round its own ends (as brick returns into a window opening). On by
  default for `"side": "exterior"`, off otherwise.

A finish fades with its wall and costs **one draw per finish look per wall**:
all of a wall's faces in one finish and look are one mesh laid 1.5 mm over the
painted wall, skipping its doors and windows. Two looks on one wall are two
draws.

### Slabs — the floor and the ceiling

A house has exactly **one floor** and exactly **one ceiling**. Each is a single
continuous solid of `thickness` centimetres, and the two are deliberately **not
the same outline**:

- the **floor** is traced to the **inner** (room-facing) faces of the exterior
  walls — the shell stands *on* the floor and runs down through it, so there is
  no seam where a wall meets the ground;
- the **ceiling** is traced to their **outer** faces — the full building
  envelope — so it **caps over** the shell out to its outer edge.

```json
"slabs": {
  "floor":   [[303.3, 748.8], [303.3, 10.2], [1028.7, 10.2],
              [1028.7, 95.0], [1281.5, 95.0], [1281.5, 748.8]],
  "ceiling": [[273.3, 791.8], [273.3, -19.8], [1058.7, -19.8],
              [1058.7, 65.0], [1311.5, 65.0], [1311.5, 791.8]],
  "thickness": 15
}
```

Both are ordered rings of `[x, y]` plan points in the same coordinate space as
rooms and walls, in centimetres, and — like a room polygon — **do not repeat the
first point at the end**. Each must be a *simple* ring: `THREE.Shape` describes
one closed loop, and a self-intersecting figure-of-eight triangulates into
nonsense rather than failing loudly. `thickness` serves both surfaces; the floor
grows downward from the walking surface and the ceiling upward from the wall
head, so you never see it, but it is what stops the model reading as paper at a
cut edge — and it is how far below zero the exterior walls run to meet the
floor's underside.

**The whole block is optional.** Omit it and the engine derives both surfaces
from what you have already authored: the union of every room polygon **with
every wall footprint** (each wall's centreline expanded by half its thickness).
The wall footprints are the part that matters. Rooms stop at the wall faces, so
between any two rooms lies a strip exactly one wall thick that no room polygon
covers — lay down only the rooms and you get a visible slot in the floor under
every internal wall. Adding the wall rectangles fills precisely those strips.

So the derived floor is gap-free, but it reaches the **outer** face of the shell
rather than the inner one: fractionally larger than a hand-trace, and invisible
from any angle because the walls cover it. What the derivation *cannot* produce
is the floor/ceiling asymmetry above — it has one outline and uses it twice.

State the block when you have measured your shell and want the real rings; leave
it out while a plan is still moving, and nothing goes wrong. `floor` and
`ceiling` are independent, so authoring one and deriving the other is legal, if
rarely what you want.

### Doors

Position is given the way a floor plan gives it — *in this wall, this far along,
this wide* — rather than as a free-floating 3D transform, so a door stays
attached when its wall moves:

```json
{
  "id": "utility_closet", "label": "Utility closet",
  "wall": 15, "centre": 45.2, "width": 58,
  "hinge": "north", "swing": "east",
  "maxOpenDegrees": 28, "kind": "cupboard",
  "room": "utility"
}
```

`wall` is a wall **id**, not a coordinate. Move the wall, the door follows.

**`hinge` and `swing` are different things and you need both.**

- `hinge` — which **end** of the opening the leaf is attached to.
- `swing` — which **side** of the wall it opens into, i.e. which room it swings
  into.

They are independent. The same hinge end with the opposite swing is a door that
opens the other way — which, in a real house, is the difference between clearing
the cupboard and hitting it. Both are compass directions so you can read them
straight off an annotated plan.

They must be **perpendicular**. A wall running east-west hinges east or west and
swings north or south; a north-south wall is the other way round. A parallel pair
is always an authoring mistake (it renders as a leaf embedded in its own wall) and
the validator rejects it.

**`maxOpenDegrees` is per door, and you should set it from the real door.**
Doors genuinely differ: a front door or an internal room door swings about 90°,
while a small cupboard or utility door is stopped by an adjacent wall or its own
return at roughly 25–30°. This is the *intended* maximum — the engine may reduce
it further at load time if two open leaves would collide with each other, but it
will never open a door wider than you said. Do not rely on `kind` to imply an
angle; `kind` only styles the leaf and decides who yields in a collision (a
`standard` door gives way before a `cupboard` one).

### Windows

Placed exactly like a door: a wall **id**, a `centre` along it and a `width`.
Which face of the wall is the inside is **derived from `room`** (the side of the
wall the room lies on), so there is no inside/outside field to get wrong.

**How the side is derived.** The loader steps a short way off each face of the
wall *at the window's own position along it* (5, 10, 20 and then 40 cm past the
face, nearest first) and asks which of the two points is inside the room's
polygon. If the window's centre is ambiguous, it tries again a centimetre in
from each end of the window. If the room is on **neither** side there, the
window is skipped with a warning, and the validator reports an error. If it is
on **both** sides (the room wraps round a stub wall), the loader falls back to
the side of the room's bounding-box midpoint and warns. A side found only by a
far step, where the room's outline stops more than 10 cm short of the wall face,
is still used, but it warns, because that room is probably not on this wall at
all. The same rule applies to curtains and to wall-anchored furniture.

(It used to be the side the room's bounding-box midpoint lay on. That is wrong
for an L-shaped room: the midpoint of an L can sit on the far side of a wall
that bounds one of its arms.)

```json
{
  "id": "lounge_balcony", "label": "Lounge balcony doors", "kind": "balcony",
  "room": "lounge", "wall": 1, "centre": 150, "width": 220,
  "sill": 6, "height": 205, "doorSide": "west"
}
```

- `sill` is the height of the bottom of the glass above the floor; `height` is
  measured **up from the sill** (the Sweet Home 3D elevation + height
  convention). The wall is carved to the glazing plus a 4 cm frame reveal on
  every side, leaving wall below the cill and a lintel above.
- `kind: "window"` (the default) is WindowSpec: a fixed lower pane under a
  centre-pivot top sash, split at `topSplit` of the glazed height.
  `kind: "balcony"` is the Balcony window on WindowSpec: a wide fixed pane beside a glass door
  that swings **outward**, at the `doorSide` end of the run (and hinged on it).
- The frame sits flush with the wall's **outer** face; the room side shows a
  plain reveal the depth of the wall. A **cavity wall** modelled as two parallel
  segments — an inner leaf and an outer skin — names the frame's leaf in `wall`
  and the other in `throughWalls`: the opening is cut through both, and the
  cill spans the whole sandwich.
- On an exterior wall the frame fades with the wall when you look in from
  outside. The glass is translucent anyway and is left out of the fade.

### Curtains

Also placed like a door (wall id + `centre` + `width`), on the **room** face of
the wall. Which face that is comes from the same probe as for windows (see above). Each is a CurtainSpec pair: floor-to-ceiling, centre-parted, two-tone
pinch-pleat, under a white cornice with a glowing strip light.

```json
{
  "id": "bedroom_curtain", "room": "bedroom", "wall": 3,
  "centre": 620, "width": 288, "openPct": 60,
  "outerColor": "#d98aa8", "innerColor": "#5f86c4",
  "stackWidth": 34
}
```

- **Colours are data.** `outerColor` is the pleats from each end inward,
  `innerColor` the pleats toward the centre part (`outerPleats` / `innerPleats`
  of each, 5 and 2 by default). For a single-colour curtain give both the same
  value.
- `openPct` is the resting pose: 0 = drawn closed, 100 (the default) =
  gathered into a stack at each end, each half toward its own wall end. Bind a
  Home Assistant `cover.*` to the curtain's `id` in `rooms.json`
  (`sensors.curtains`) and the curtain follows it, animated.
- **How wide the open stack is** depends on how much fabric is in it, not on
  the curtain's width: by default **4.7 cm per pleat per side** (a 5 + 2 pleat
  half stacks to 32.9 cm). Two optional overrides, in this order of precedence:
  `stackWidth` — the measured stack per side in cm, which wins outright — and
  `stackPerPleat` — cm per pleat, for a fabric that bunches thicker or thinner.
  A stack is never wider than a closed half. The daylight uses the same width,
  so a wide stack keeps shading the edge of the glass when fully open.
- **Daylight comes in through the window** and a curtain in front of it gates
  that light: fully open lets it all in, a closed blackout lets almost none
  through, and a closed sheer lets in a dim share tinted toward its own colour.
  It follows the same sun as the rest of the scene. A window's light is an
  unlit floor patch on every GPU tier, plus one unshadowed light per room with
  windows on the mid and ultra tiers.
- **A sheer** is a curtain with `opacity` below 1 — one translucent layer, no
  lining. To hang one behind a blackout, give it a smaller `offset` (its
  distance from the wall, cm) and `"cornice": { "enabled": false }` so it shares
  the blackout's cornice. Curtains on the same wall are stacked automatically:
  each one's folds are limited so they can never pass through the wall or
  through a curtain hung behind it.
- `cornice.sideFaces: false` gives a wall-to-wall cornice spanning the whole
  room along that wall instead of a box just wider than the curtain.
- Every cornice has a **lid**: the top of the box, just under the ceiling, so
  looking down with the ceiling hidden shows a closed pelmet, not the fabric
  heading and the LED strip. The box is built light-tight: the lid overhangs
  the front and side faces and runs into the wall, and a wall-to-wall cornice
  runs into both side walls. A curtain hanging in a cornice (its own, or a
  sheer behind a blackout) stops 1.4 cm short of the ceiling, under the lid.
- The strip light glows (emissive) and, on the mid and ultra tiers, throws
  light through a row of **unshadowed downlights** — 3 on a cornice under
  250 cm wide, 5 on one 250 cm or wider — spaced along the strip. They are
  aimed down and back out of the cornice's open bottom onto the curtain
  heading and the wall, with a cone that clears the front face, the lid and
  the side faces, so the cornice itself never glows from the room. They reach
  1.2 m. The mid tier caps the house at 12 of them (the fullest cornices give
  lights up first); the low tier (256 fragment uniforms) keeps the glowing
  strip but adds no light.
  Bind its own light entity in
  `rooms.json` (`sensors.corniceLights`). **Do not also list the cornice as a
  strip under the room's `ambient` channel**: the cornice is already drawn by
  the curtain, so that would draw and drive it twice (the validator warns).

### Furniture

Added in `schemaVersion` `1.2`. The validator reports an error for `furniture`
in a profile that declares an older version. An engine older than 1.2 ignores
the key.

Every item names a `room`, a `type` and **exactly one** of two anchors.

**Free anchor: `at` + `rotation`.** `at` is the **centre of the footprint** in
plan centimetres. `rotation` is in degrees, **clockwise in plan** (as drawn,
with y pointing south). At 0 the item's front faces **south** (+y), at 90 it
faces **west**, at 180 **north** and at 270 **east**. The front direction is
`(-sin r, cos r)`. This is exactly Sweet Home 3D's convention: its piece `x`/`y`
is the footprint centre, and `rotation` is its `angle` in degrees.

```json
{ "id": "armchair", "room": "lounge", "type": "box",
  "at": [240, 310], "rotation": 90,
  "params": { "width": 80, "depth": 85, "height": 95 } }
```

**Wall anchor: `wall` + `centre` + `offset`.** The item's **back** sits `offset`
cm (default 0) off the **room** face of `wall`. The back's centre is at `centre`
along the wall, which is an x coordinate for an east-west wall and a y
coordinate for a north-south one. The item faces into `room`. Which face is the
room's is found by the same probe as for windows. `rotation` is not allowed
with this anchor.

```json
{ "id": "hall_crate", "room": "hall", "type": "box",
  "wall": 12, "centre": 415, "offset": 2, "elevation": 30,
  "params": { "width": 60, "depth": 30, "height": 40, "finish": "gloss" } }
```

Other fields:

| Field | Default | What it is |
|---|---|---|
| `elevation` | `0` | Floor to the bottom of the item, cm. Wall-mounted items use this. |
| `params` | `{}` | The builder's own options: `width`, `depth` and `height` (cm), plus a colour, a `finish` and anything type-specific. Anything you leave out falls back to the builder's `DEFAULTS`. |
| `fade` | `"auto"` | `"auto"`: an item taller than 100 cm fades with its host wall if that wall is exterior, or, if it is free-standing, with the nearest exterior wall it stands against (within 30 cm). `"never"`: never fades. `{ "wall": <id> }`: fades with that wall, which must exist and be exterior. |
| `priority` | `"normal"` | `"minor"` items are dropped on the low GPU tier. |
| `label`, `notes`, `source` | — | Documentation only. |

The loader skips an item, with a warning, if it names a missing room or wall,
sits on a wall that is not axis-aligned, has a `centre` beyond the ends of its wall, gives both anchors or neither, gives
`rotation` with `wall`, or names a `fade.wall` that does not exist. An
**unknown or not-yet-built `type`** is skipped with a warning too. That is the
same forward-compatibility rule `decor` follows.

**Rugs and fitted carpet are not furniture.** Use the room's `rug` (with
`inset: 0` for a fitted carpet).

#### How furniture renders

`src/furniture.js` builds each item with its builder and places it: the group
sits at the item's back-centre, `elevation` cm up, turned by `-rotation` about
the vertical (plan rotation is clockwise, three.js's is anticlockwise).
`src/furniture/merge.js` then folds the whole house's parts into a few
**buckets**. The camera almost always frames the whole house, so buckets are
house-wide, not per room:

- **Opaque parts** (`matte`, `gloss`, `satin`, `metal`, and a kept part whose
  material is exactly a palette one, such as a plain mirror) become ONE
  vertex-coloured mesh per fade wall, for every finish at once. Each vertex
  carries its finish as a uv into a small palette texture, read through the
  material's roughness and metalness maps, so a gloss handle on a matte
  carcass still looks gloss.
- **Glowing parts** (the `emissive` finish, opaque and untextured: screens,
  LED edges, bulbs) become ONE unlit, vertex-coloured mesh per fade wall.
  Each glows at its emissive colour plus its base colour, which stands in for
  the room light a lit material would add. It adds no light to the room.
- **Everything else kept** (glass, translucent parts, textured parts, and
  parts marked `keep` whose material is not a palette one) keeps **its
  builder's own material**: type, opacity, `transparent`, `side`,
  `depthWrite`, emissive intensity and maps all survive. These merge only with
  parts whose material is equivalent, one mesh per material and fade wall.
- A double-sided part gets its own bucket, and parts keep any vertex colours
  they carry.

The opaque and glowing buckets are created `transparent` at full opacity and
drawn first among transparent objects. The fade needs its copy of each to be
transparent, and three.js compiles a separate shader for an opaque material,
so this keeps one shader each. `bucketScope: 'room'` (a `buildFurnitureSync`
option) restores per-room buckets for measuring.

**Shadows.** Furniture meshes receive shadows but never cast them directly.
Instead one **shadow proxy** is built for the whole house (two when some rooms
drop to low detail): a copy of the geometry of every caster, drawn with a
material that writes neither colour nor depth. It is invisible in the picture
and casts in every shadow pass. An item casts when it stands low (`elevation`
under 30 cm) and is at least 40 cm tall; wall-hung things and glass do not. A
room whose casters come to over 15,000 triangles, or a house over 60,000 in
all (largest rooms first), takes its casters from the builders'
`detail: 'low'` output instead, in the second proxy. No proxies are built on
the low GPU tier, or when the scene has no shadows at all.

**Fade.** An item fades with **one** wall, chosen by `fade` (above). It fades
exactly as the wall does. Glass, and anything else translucent, never fades:
the wall fade drives opacity back to fully opaque, which would turn it solid,
so it keeps its own opacity, as window glass does. Translucent parts also
receive and cast no shadow.

**The low GPU tier** asks every builder for `detail: 'low'` and drops
`priority: "minor"` items.

**Timing.** Furniture is built after the house's own shader precompile has
finished, **time-sliced**: the build hands the main thread back every few
milliseconds, so a full house never becomes one long task. It is then
compiled and attached in one go, and never delays the first picture. `?furniture=0` hides it (see `docs/url-parameters.md`).

**Clicks.** Furniture is not clickable. A click on a piece of furniture selects
the room it stands in, as a click on the floor there would.

#### Types, builders and the registry

A type is drawn by a builder module, `src/furniture/<module>.js`.
`src/furniture/registry.js` maps each type to its module. The registry is a
data table pre-seeded with every planned type, so adding a type means creating
the module at the path already named there. Modules are loaded with a dynamic
`import()`, and only for the types a house actually uses. The `box` type
(`src/furniture/box.js`) is a plain box, built in, and useful for minor
clutter.

**The builder contract.** A builder is pure ESM, with `THREE` passed in (no
`import 'three'`), so it loads in Node tests, the live scene and the spec pages
alike. A single-type module exports:

- `TYPE`
- `DEFAULTS`: frozen, in centimetres, and including `width`, `depth` and `height`
- `build(THREE, params, { detail: 'full' | 'low' })`, which returns a `THREE.Group`

The group's local frame is in **metres**. `y = 0` is the item's bottom, x is
centred along the width, the **back face is at `z = 0`**, and the front faces
+z. Every material comes from `makeFinish(THREE, finish, color)` in
`src/furniture/finishes.js`. That is a closed palette of `matte`, `gloss`,
`metal`, `glass`, `mirror` and `emissive`, and each material is stamped with
`material.userData.finish` so the renderer can merge a room's furniture into a
few draws.

**Finish and keep tags: the mesh or the material.** Every mesh part must say
which palette finish it is. A builder may put the tag on the mesh
(`mesh.userData.finish`) or on its material (`material.userData.finish`, which
`makeFinish()` sets for you). Either passes. If both are set, they must agree,
and a mismatch fails the contract test. Every `glass`, `mirror` and `emissive`
part must also be marked `keep: true`, on the mesh or on the material, with the
same agreement rule. Nothing reads these tags directly. The contract test
(`scripts/test-furniture-core.mjs`) and the renderer's merge both go through
`partFinish()` and `partKeep()` in `src/furniture/finishes.js`, so what is
tested and what is drawn cannot diverge.

**The contract test** builds every type whose module exists at its `DEFAULTS`
and checks all of the following:
- the bounding box equals `width`/`depth`/`height` within 0.5 cm
- x is centred, the bottom is at y = 0 and the back is at z = 0
- every finish tag is in the palette, and the kept finishes are marked keep
- `detail: 'low'` has no more triangles than `'full'`
- the module never imports three itself, whether by `'three'`, a `vendor/`
  path or a dynamic `import()`
- the builder runs in Node, so it cannot use the DOM (`document`, a canvas)

**Async assets: `prepare()`.** `build()` is synchronous, because it runs inside
the time-sliced build. A type that needs a file first may also export
`prepare(items, ctx)`, which returns a promise. `loadFurnitureModules` awaits
it (for that type's items only) while the builders load, in parallel with the
house's shader precompile and before the first build slice. It never rejects:
a `prepare()` that throws or takes over 15 s is a warning, and its items fail
at build time and are skipped. `build()` also receives `opts.assetBase`, the
profile directory, for a type that resolves files under it. Only `model` uses
either today.

#### Furniture: `model` (a .glb from the profile)

`type: "model"` draws an item from a glTF binary file that lives **in the
house profile**, not in this repo. It is for a real product model a house may
not redistribute (a vendor model, a scan): the engine stays generic and
public, and the file stays wherever the profile is.

```json
{ "id": "reading_chair", "room": "study", "type": "model",
  "wall": 1, "centre": 420, "offset": 1,
  "params": { "src": "assets/models/chair/lod.glb", "width": 90, "depth": 92, "height": 100 } }
```

| Param | Default | What it is |
|---|---|---|
| `src` | — | Profile-relative path to a `.glb`. No leading slash, no `..`, no URL scheme, and `.glb` only (a `.gltf` names further files). Required. |
| `width`, `depth`, `height` | 60 | The envelope, cm. The model is fitted into it, so placement works exactly as for any other type. |
| `fit` | `"stretch"` | `stretch` scales each axis to its own dimension, so the bounding box IS the envelope (what Sweet Home 3D does when a model is resized). `contain` uses one uniform scale, the largest that fits. |
| `yaw` | `0` | Degrees, anticlockwise from above, applied before fitting. It turns the file's front to glTF's +z, which becomes the item's front. |
| `finish` | `"matte"` | The palette finish for every part. |
| `color` | `null` | Overrides the file's colours (and tints vertex colours). |
| `gain` | `1` | Multiplies every part's colour (the file's, or `color`). A tint can only darken, so this is how you **brighten** a file whose colours are too dark, typically a vendor model with studio lighting baked into its textures. It rides on the material colour: nothing extra for a vertex-coloured file; a textured part with a different gain is its own (kept) material. On the `emissive` finish it scales the glow too. Similar to `scripts/model-lod --gain` without re-exporting, except that model-lod clamps each baked channel at 1 and `gain` does not. |
| `maxTriangles` | `5000` | A file heavier than this, per level of detail, is refused and skipped. |

- **Loading.** The file is fetched and parsed once per page, however many
  items use it, by the vendored three.js r160 `GLTFLoader`
  (`vendor/three-r160/addons/`). It loads only when a house uses `model`. A
  missing, refused, unparseable or over-cap file, or one that takes over
  10 s, is one console warning, and that item is skipped. The rest of the
  furniture builds.
- **Materials.** The file's own materials are not used. Every part draws with
  the palette finish. A part with **vertex colours** (`COLOR_0`) joins the
  house's merged palette bucket, so it costs no extra draw and no extra
  shader. A part with a **base-colour texture** keeps that texture as its own
  kept draw, shared by every item using the file. That costs a draw and GPU
  memory (see the furniture perf budget), so prefer vertex colours.
- **Levels of detail.** A root node named `low` is used on the low GPU tier
  (and for a room's low-detail shadow proxy). Every other root node is the
  full model.
- **Making the file.** `scripts/model-lod/` turns a heavy GLB into a two-LOD
  one: it drops the nodes you name, bakes textures into vertex colours,
  simplifies to a triangle budget (meshoptimizer), and writes `full` + `low`.
  See its README.
- **The validator** checks the path's shape (schema) and warns when the file
  is not there.
- **The demo** (`houses/demo`, the lounge armchair) uses
  `houses/demo/models/test-armchair.glb`, generated by
  `scripts/make-test-model.mjs` and dedicated CC0.
- **Keep originals out of the served tree.** Everything under a profile
  directory is served to anyone who can load the house. Store a full-size or
  licensed source model somewhere else, and put only the decimated file in
  the profile.

**Multi-type modules.** A module that builds several related types, such as
`kitchen.js` or `small-items.js`, exports one object instead:

```js
export const TYPES = {
  'kitchen-base-run': { DEFAULTS, build },
  'kitchen-wall-run': { DEFAULTS, build },
};
```

Its registry entries name the property to use in `key`:

```js
'kitchen-base-run': { path: 'kitchen.js', key: 'kitchen-base-run', spec: 'KitchenSpec' },
```

A single-type module has `key: null`.

**Bathroom fittings** (`bathroom.js`, spec page `BathroomFittingsSpec`):
`bathtub`, `toilet`, `vanity-counter`, `shower-set`, `shower-screen`,
`shower-tray` and `towel-rail`. A mirror cabinet is a `cabinet` with
`mirror` fronts and `plinth: { "height": 0 }`. Three of these have a derived
envelope:
- `vanity-counter`: `depth` is where the basin's front stands, and `height` is
  the tap's top. `vanityEnvelope()` gives both.
- `toilet`: `height` is the flush plate's top.
- `shower-set`: it is authored by floor heights (`valveHeight`, `riserFrom`,
  `riserTo`, `spoutHeight`). Its `width`/`depth`/`height`, and the
  `elevation` to hang it at, are outputs of `showerSetEnvelope()`. The spec
  page's Copy JSON fills them in. Give it `fade: "never"` when it hangs on a
  pillar near an exterior wall, or it fades with that wall.

**Cache-busting.** Every builder URL the registry imports carries the app
version as `?v=`, just as `index.html` does for the scripts it names and
`deploy/generate-config.sh` does for every static relative import. Otherwise
a browser could keep running the previous release's builders. The version comes from the `?v=` the registry itself was
imported with, then from `window.HOME3D_CONFIG.version`, or it can be passed
explicitly.

**Schema params and the drift test.** Each type has a
`$defs/furnitureParams_<type>` block in `houses/schema.json`. `furnitureItem`'s
`allOf` rules check an item's `params` against it. The block's `default`s must
equal the builder's `DEFAULTS`, because the validator cannot run JavaScript and
reads those defaults to compute footprints. `scripts/test-furniture-defaults.mjs`
fails when:

- a registered type has no block or no `allOf` rule, or a block or rule exists
  for an unregistered type
- a type's spec page (`specs/<Spec>.html`, or a `SPEC_PAGES` entry in
  `index.html`) has merged but its module has not
- a module exists at a type's registry path while its schema block is still a
  **placeholder** (`"x-placeholder": true`). Every planned type is pre-seeded
  with a placeholder, which is allowed only until its module lands. The PR that
  adds a module replaces its placeholder with the real params in the same PR.
- a `DEFAULTS` value differs from the schema `default`, or either side has a
  key the other lacks
- a module exports `defaultsFor(params)` (a type whose kinds differ in size:
  wall-clock `diy-words`, wall-sconce `up-down`) and, for some kind, the schema
  defaults overlaid with the block's `x-kindDefaults[kind]` give a different
  width/depth/height. An item that names only its `kind` is built from that
  kind's defaults, and the validator sizes it from `x-kindDefaults`.

### Lights

Lights are grouped by room, and within a room by **channel**:

```json
{
  "room": "bedroom",
  "fixtures": [
    { "channel": "main",    "fixtureType": "spot", "count": 5 },
    { "channel": "ambient", "fixtureType": "strip", "positions": [ … ] },
    { "channel": "galaxy",  "fixtureType": "projector", "count": 1 }
  ]
}
```

A **channel** is one independently switchable group — the thing that maps 1:1 to
a Home Assistant light entity. `main` is the room's ceiling light; `ambient` is
indirect/accent lighting; anything else is a named special (the reference house
has a `galaxy` star projector in its bedroom). The pair *(room id, channel)* is
the composite key that `rooms.json` binds entities to.

**List the positions.** You can give `count` and let the engine auto-place
fixtures on a grid over the room polygon, which is fine while you are getting
started, but the result is generic. Real ceilings are not grids: downlights avoid
the extractor, strips run along the specific cornice the curtain track is on, and
one light is under each desk. Each position takes a `label` in your own words
("under the left desk", "behind TV", "curtain cornice"), which is what makes the
list readable a year later.

`heightCm` is measured from that room's floor. Omit it for a ceiling fixture and
the engine tucks it just under the ceiling; you need it for a wall strip or an
under-desk light. `size` (a `[length, height, depth]` in centimetres) applies to
`strip` fixtures so a 2 m cornice run reads as a line rather than a point.

### Materials and textures

`materials.wallColor` is your interior paint. If you know only the product name,
put the name in `wallPaintName` and approximate the hex — retail paint
manufacturers rarely publish authoritative hex values, and recording the name
alongside the approximation at least documents what the approximation is *of*.

Wallpaper goes on a **single face of a single wall**:

```json
"faceTexture": {
  "side": "west",
  "clipToRoom": "hallway",
  "texture": { "path": "textures/monstera.png", "fit": "stretch" }
}
```

`side` is a compass direction, so you name the face the way you would standing in
the room ("the west face"), not in the renderer's local axes.

`clipToRoom` matters more than it looks. A long wall usually runs past several
rooms while the wallpaper covers only one of them; without the clip the image
stretches across the entire run, through rooms that do not have it.

`fit: "stretch"` maps one copy of the image across the whole target face — right
for a mural, which is a single picture. `fit: "tile"` repeats it every
`repeatMetres`, right for a pattern.

Texture `path` is **relative to the house profile directory**, so
`"textures/monstera.png"` means `houses/myhouse/textures/monstera.png`. Absolute
URLs and paths containing `..` are rejected: a profile must not be able to point
the engine at an arbitrary host. This keeps a house directory self-contained —
copy the directory, you have copied the house.

If you share a profile, fill in `texture.credit`. A shared house profile carrying
an unlicensed photograph is a licensing problem, and a photo of your own wall is
also a photo of your own wall.

### Camera focus views

Tapping a room flies the camera to a fixed showcase view of that room; tapping a
device flies in on the device (see [`?focus`](url-parameters.md#focus)). With
nothing authored, every view is **derived**, so any house works unchanged:

- **A room** is framed from the house's own home angle (the `iso` preset's
  azimuth and polar, which `cameraPresets.iso` overrides), aimed at a point
  inside its polygon (the centroid, or for an L-shaped room whose centroid falls
  outside it, the middle of its widest part), at the smallest distance that
  keeps the whole room on screen, floor to ceiling (so its ceiling lights are in frame too).
- **A furniture item** is framed whole and close: the distance fits its world box
  to the screen. The angle is its front if nothing stands in the way; otherwise
  the nearest of a few dozen candidate angles (up to 90° round, and up to nearly
  top-down) from which no other furniture, wall or fixture blocks the view. Below
  wall height the camera stays inside the item's room. A curtain is treated the
  same way, preferred from the room side; a light, from the current azimuth.

When a derived view is not the one you want, add `view` to the room, the
furniture item or the curtain (`schemaVersion` `"1.4"`):

```json
"rooms": [{ "id": "lounge", "label": "Lounge", "polygon": [...],
            "view": { "target": [520, 310], "targetHeight": 90,
                      "azimuth": 0.69, "polar": 0.95, "distance": 6.5, "fov": 50 } }]
```

| Key | Required | Meaning |
|-----|----------|---------|
| `azimuth` | yes | Orbit angle, radians, as in `cameraPresets` (0 = camera on the east side). |
| `polar` | yes | Angle from straight up, radians (π/2 = eye level). |
| `distance` | yes | Camera distance from the target, **metres**. |
| `target` | no | Plan point (cm) to look at. Omitted: the derived target. |
| `targetHeight` | no | Height of `target` above the floor, cm. Default 0. |
| `fov` | no | Vertical field of view, degrees. Default 50. |

The loader compiles it with the coordinate transform applied, and the runtime
prefers it over the derived view. It is shape data — a camera pose — so it lives
in `geometry.json`, which is safe to share. The validator warns when a `view`
appears in a profile below `"1.4"`; an older engine ignores the key and derives.

### Camera presets — why they are optional

`cameraPresets` is optional and usually you should leave it out. The reasoning:

The presets that matter are **directions** — top-down, the four corner
three-quarter views, the four elevations. A direction is house-independent; "look
at it from the south-east, from above" means the same thing for any building. So
the engine ships that direction set as its defaults, and every house gets ten
sensible named views for free without writing anything. That matters for the
person modelling their first house, who has enough to do already.

The one thing that genuinely varies with the house is **framing distance**, and
the engine does not need to be told it: it already derives the footprint bounding
box from the walls, so it can fit that box to the field of view and compute the
distance itself. A hardcoded distance is in fact a bug for any house that is not
the same size as the one it was tuned on — which is precisely what the reference
implementation had (`r: 13` metres, correct for a ~10 × 7.4 m flat and wrong for
anything else).

But it is not purely an engine concern either, which is why the field exists. A
long thin house wants its `iso` angle rotated to look down its length rather than
across it. A house built around a courtyard may want a target that is not the
footprint centre. Those are facts about the house, not about the renderer.

So: **engine defaults, per-house override.** Any preset you list — wholly or
partially — replaces the corresponding engine default; keys you omit from a
partial override fall back to the default. Write one only when the default framing
is actually wrong for your house.

There is one more reason to write them out, worth naming because it looks like
the anti-pattern above: **reproducing another renderer exactly.** The derived
distance is a *better* number than any constant, but it is not the *same*
number, and a house whose job is to match a reference render pixel for pixel
needs the reference's framing, not a better one. That is a deliberate, stated
choice in a profile — not a default anyone else should copy.

### `viewCentre`

The point the default cameras look at, and the centre of the ground plane and
the cloud field. Defaults to the middle of the wall footprint.

```json
"viewCentre": [790, 400]
```

Set it when the geometric middle is not the point you want framed. A long thin
projection — a hallway arm, an outhouse, an integral garage — drags the
footprint's midpoint away from the part of the house anyone actually looks at,
and the whole model then sits slightly off-centre in every view.

---

## `rooms.json`

```json
{
  "kind": "rooms",
  "schemaVersion": "1.1",
  "house": "myhouse",
  "homeAssistant": { "enabled": true, "wsReconnectMs": 5000, "pollIntervalMs": 5000 },
  "rooms": {
    "kitchen": {
      "main":    ["light.kitchen_ceiling"],
      "ambient": ["light.kitchen_cove"]
    }
  },
  "sensors": {
    "presence": {
      "kitchen": ["binary_sensor.example_kitchen_motion"]
    },
    "doors": {
      "store_door": ["binary_sensor.example_store_door_contact"]
    }
  }
}
```

`house` must match the geometry profile's `id` — it stops you pairing one house's
geometry with another's entity map.

Each room maps channel names to lists of Home Assistant entity ids. Several
entities on one channel are switched together as a group.

The room ids must exist in the geometry profile; the validator errors if they do
not. Channels *should* match a fixture channel in the geometry — the validator
warns, rather than errors, in both mismatched directions (entities with no
fixtures, fixtures with no entities), because a half-wired house is a perfectly
normal work-in-progress.

### `sensors` — non-light bindings

`rooms` is specifically *room → light channel → entities*, and it is joined to
the geometry's `lights[].fixtures[].channel`. Entities that are not lights do not
belong in it: they would be driven as if they were lamps and would trip the
validator's missing-fixture warning forever. They go in `sensors` instead.

Both keys are optional, and so is the whole block. A profile with no `sensors`
renders exactly as it did before — both features simply stay dark.

| Key | Keyed by | Meaning |
|-----|----------|---------|
| `presence` | **room id**, from the geometry's `rooms` | The room shows footsteps on its floor while occupied |
| `doors` | **door id**, from the geometry's `doors[].id` | The door swings open while the contact reads open |
| `curtains` | **curtain id**, from the geometry's `curtains[].id` | The curtain follows the `cover.*` entity's `current_position` (0 closed, 100 open), and the window's daylight with it |
| `corniceLights` | **curtain id** | The curtain's cornice strip follows the light entity: on/off, brightness and colour |
| `climate` | **room id** | ONE `climate.*` entity (a string, not a list) for the room panel's temperature row |
| `vacuums` | **furniture item id**, from the geometry's `furniture[].id` | A robot vacuum: click the item for its control card; the sidebar's Controls view shows the same block |
| `plants` | **furniture item id** | A plant: tap the item for its read-only moisture card; the sidebar's Controls view lists every plant |
| `roomScripts` | **room id** | ONE `script.*` the room panel offers as a two-step "Kill room" button |

Several entities on one target are OR-ed: any one of them reading `on` means
occupied, or open. `unavailable` and `unknown` count as `off`, so a sensor that
drops out reads as empty or closed rather than sticking at its last value.

`doors` is keyed by **door id and not by room** because a door belongs to a wall
rather than to a room: a room may have several doors, and a door need not name a
room at all. Keying on the room would make every door after the first
unaddressable.

Presence footsteps **fade in** when a room becomes occupied and **fade out** when
it empties; in between they are simply drawn, and the scene renders no frames at
all. A door driven by a contact sensor swings to a modest fraction of its travel
rather than flying fully open — the sensor reports only that the door is off the
latch, never how far, so rendering it wide open would be inventing detail the
sensor does not carry.

#### What the room panel shows

Each room panel is built from these bindings, and a row whose entity the room
lacks is simply not shown:

- **Door** — a status line, `Door: open`, `Door: closed` or `Door: unavailable`,
  for each door in the room (the geometry's `door.room`) that `doors` binds. There
  is no door slider: the 3D door follows its sensor. A door with no sensor rests
  closed.
- **Motion** — `Motion detected` when ANY of the room's `presence` sensors is
  `on`, `No motion` otherwise, and `Unavailable` only when every one of them is
  `unavailable`/`unknown` (or has never reported).
- **Curtains** — per bound curtain, Open and Close buttons (`cover.open_cover` /
  `cover.close_cover`) and a 0–100 % position slider (`cover.set_cover_position`).
- **Temperature** — the `climate` entity's current and target temperature, and a
  target slider (`climate.set_temperature`) whose limits come from the entity's
  `min_temp`, `max_temp` and `target_temp_step` (step defaults to `0.5`). A
  thermostat that is `off`, or reports no target, shows "off" with the slider
  disabled.
- **Kill room** — last, under a divider: the room's `roomScripts` button (see
  below).

Every control that sends a command is disabled while its entity is unavailable.

Presence room ids and door ids are both checked against the paired geometry, and
a binding that names something the geometry does not have is an **error** — a
sensor bound to a room or door that does not exist can never drive anything.

`sensors` requires `schemaVersion` `"1.1"` or newer. The bump is additive: the
engine gates on MAJOR only, so a `1.1` profile loads in an older engine (which
ignores `sensors`) and a `1.0` profile loads in a newer one.

#### Curtains and cornice lights

```json
"sensors": {
  "curtains":      { "lounge_curtain": ["cover.example_lounge_curtain"] },
  "corniceLights": { "lounge_curtain": ["light.example_lounge_cornice"] }
}
```

A cover's `current_position` sets the curtain's openness. While the cover
reports `opening` or `closing` the curtain runs toward that end stop at a
motor-like pace, and the settled position corrects it when it arrives.
`unavailable` keeps the curtain where it was rather than snapping it somewhere
invented. Several covers on one curtain are averaged.

The cornice light is keyed by the **curtain**, not the room, and is bound to
the cornice's **own** entity. If your cornice is also a member of a room
"ambience" light group, that is fine — keep the group on the room's `ambient`
channel for the room's other strips, and remove the cornice's own strip from
that channel in `geometry.json`, so each light is drawn and driven exactly once.

**Tapping a curtain** opens one card for its **room**: the cornice light of
every curtain in that room first (on/off and brightness -- switching it on
brings it back at its last level), then every bound cover in the room, each
with its own position slider and Open / Close buttons, labelled with the
curtain's `label`. So a room with a curtain and a blind on one window shows
both, and its cornice light, whichever of them you tap. One light is one row:
a cornice light bound under both the curtain and the blind shows once, as the
room's curtain light. The card is titled
"<Room> curtains".

`curtains` and `corniceLights` need `schemaVersion` `"1.2"`: an engine older
than that rejects the unknown keys, so upgrade the engine before the profile.

#### A desk strip (or any accent light on its own entity)

Draw it as a room light fixture on its **own named channel**, and bind that
channel to the strip's own entity in `rooms`, exactly like `main` and
`ambient`:

```json
// geometry.json, lights[] for the room
{ "channel": "desk_strip", "label": "Desk strip", "fixtureType": "strip",
  "positions": [
    { "at": [240, 115], "heightCm": 71.5, "size": [78.8, 1, 1.2], "label": "desk left" },
    { "at": [200, 175], "heightCm": 71.5, "size": [1.2, 1, 120],  "label": "desk front" },
    { "at": [240, 235], "heightCm": 71.5, "size": [78.8, 1, 1.2], "label": "desk right" }
  ] }
// rooms.json
"study": { "main": ["light.example_study"], "ambient": ["light.example_study_ambience"],
           "desk_strip": ["light.example_desk_strip"] }
```

A strip's `size` is `[east-west extent, height, north-south extent]` in cm, and
`heightCm` is the strip's CENTRE -- put it half its height below the desktop's
underside. A named channel follows its entity's on/off, brightness and colour,
and it gets **no sidebar row**: the room's one Ambient row still switches the
room's `ambient` group (which in Home Assistant may well contain the strip).
Like every accent channel it is dropped on the low GPU tier.

The Ambient row comes from the room's `rooms.<id>.ambient` binding, not from a
geometry fixture, so a room whose ambient light is only a lit cornice and a desk
strip needs no `ambient` fixture at all -- and should not have one: a fixture
with no `positions` is auto-placed in the room.

#### Kitchen LED strips

The same pattern, several times over in one room: one `strip` fixture per
strip **entity**, each on its own named channel, and the room's `ambient`
binding left as the group that switches them all. A kitchen whose plinth,
under-cabinet and top strips are three entities under one ambience group:

```json
// geometry.json, lights[] for the kitchen -- no `ambient` fixture at all
{ "channel": "strip_top",    "fixtureType": "strip", "positions": [
    { "at": [170, 20],   "heightCm": 210.5, "size": [340, 1, 0.8], "label": "on the wall units" } ] },
{ "channel": "strip_under",  "fixtureType": "strip", "positions": [
    { "at": [165, 28],   "heightCm": 154.5, "size": [110, 1, 0.8], "label": "under the wall units" } ] },
{ "channel": "strip_plinth", "fixtureType": "strip", "positions": [
    { "at": [164, 67.6], "heightCm": 12.1,  "size": [223, 1, 0.8], "label": "plinth, north run" },
    { "at": [52.4, 118], "heightCm": 12.1,  "size": [0.8, 1, 102], "label": "plinth, west run" } ] }
// rooms.json
"kitchen": { "main": ["light.example_kitchen"], "ambient": ["light.example_kitchen_ambience"],
             "strip_top": ["light.example_top"], "strip_under": ["light.example_under"],
             "strip_plinth": ["light.example_plinth"] }
```

Put each strip where the real one is, which is **back**, under or behind a
cabinet's lip -- not on its front edge:

- **plinth**: on the plinth's face (a base run's plinth sits 8 cm behind its
  front), just under the carcass. From standing height the doors hide it and
  you see only the glow on the floor.
- **under the wall units**: hanging 1 cm under their underside, well behind
  the doors (a 30 cm unit's doors are 27.5 cm off the wall; 18 cm is a good
  line).
- **on top**: on the units' top, set back toward the wall.

A strip cannot be rotated: one that runs along the plan's y axis gives its
length as the third `size` value (`[0.8, 1, 102]`). Each position is one
point light (strips are never merged), so draw one position per straight run
rather than one per cabinet. Then turn the kitchen builders' own
`plinthLed` / `underLed` / `topLed` off: they are a static preview glow, and
left on they draw each line a second time in a colour that follows nothing.
Like every accent channel, the strips are dropped on the low GPU tier.

#### Bedside table LED strips

The LED bedside tables (the `cabinet` presets with light-channel rows) have
one strip per drawer level. Each level is a real light on its **own channel**,
bound to that level's own entity, as for the kitchen. Two tables with a top
and a bottom level make four channels. The room's `ambient` binding stays the
group that switches them all, and there is no `ambient` fixture. Two pieces
make one level:

- **The table draws the strip and the wash.** Name the channel on the
  table's channel row with `light`. The level's strip and the wash on the
  drawer below become live parts driven by that channel's state. The wash is
  one unlit quad just off the drawer face whose alpha falls smoothly from the
  channel down. When the level is on, the strip shows in the light's colour
  and the top of the drawer front below is washed in it, more strongly the
  brighter it is (brightness scales the wash's gradient, down to nothing at
  0; its opacity stays fixed, so a wall fade can own it). When it is off, the strip and the wash are hidden and the
  front is plain: just the recess.
- **White reads white with `gain`.** A `#ffffff` body renders light grey
  under the scene's tone mapping. The LED bedside presets set `gain: 1.5`,
  which multiplies the body colour: carcass, fronts, top, plinth and channel
  recesses (not the LEDs, glass, mirror, metal, door frames or a display
  section's lining, wood and contents).
- **A room light fixture gives the light.** Add a `strip` fixture on the same
  channel with `"drawn": false` (the light only, no line of its own, since the
  table draws it), a short `reachCm`, and `aim` pointing out of the table's
  front. An aimed light is a shadowless spot over the whole half-space in
  front (`spreadDeg`, default 90). It lights the floor in front and the bed
  beside the table, not the room, and it never reaches the other level's
  channel.

```json
// geometry.json furniture[] -- the table, each channel naming its light
{ "id": "bedside_north", "room": "bedroom", "type": "cabinet", "wall": 7, "centre": 120, "offset": 0,
  "params": { "...": "the preset", "fronts": [
    { "height": 21, "cells": [{ "kind": "drawer", "width": 50 }] },
    { "height": 2, "channel": { "color": "#dbe8ff", "light": "bedside_north_top" } },
    { "height": 18, "cells": [{ "kind": "drawer", "width": 50 }] },
    { "height": 2, "channel": { "color": "#ffb347", "light": "bedside_north_bottom" } },
    { "height": 15, "cells": [{ "kind": "drawer", "width": 50 }] } ] } }
// geometry.json, lights[] for the bedroom -- one light per level
{ "channel": "bedside_north_top",    "fixtureType": "strip", "positions": [
    { "at": [461.8, 120], "heightCm": 38, "drawn": false, "reachCm": 90, "aim": [-1, 0] } ] },
{ "channel": "bedside_north_bottom", "fixtureType": "strip", "positions": [
    { "at": [461.8, 120], "heightCm": 18, "drawn": false, "reachCm": 90, "aim": [-1, 0] } ] }
// rooms.json
"bedroom": { "main": ["light.example_bedroom"], "ambient": ["light.example_bedroom_ambience"],
             "bedside_north_top": ["light.example_north_top"],
             "bedside_north_bottom": ["light.example_north_bottom"] }
```

Take each fixture from `channelStripBoxes(params)` in `src/furniture/cabinet.js`
rather than measuring it. Per channel row, top first, it returns the box the
table's own strip fills and `lightAt`, where the light goes: in the channel at
the level's height, in the plane of the drawer fronts' back faces. Every face
of the other level's channel lies on or behind that plane, so a light there,
aimed out of the table, cannot reach it without a shadow map. All values are
in the table's frame, in cm: x across the width, y up from its bottom, z from
its back. Map `lightAt` to the plan the
way the table is placed. The example is the wide table standing against an
east wall at x = 500, facing west, so `aim` is `[-1, 0]` and `at` is
`[500 - lightAt.z, tableCentre + lightAt.x]` and `heightCm` is
`elevation + lightAt.y`.

One position per level is one light per level. A per-table group in Home
Assistant needs no binding of its own. The levels get no sidebar row. Like
every accent channel, the lights are dropped on the low GPU tier.

#### Climate

```json
"sensors": {
  "climate": { "lounge": "climate.example_lounge_thermostat" }
}
```

Deliberately **one string per room**. A room with two climate devices — a room
thermostat and a radiator valve, say — names the one its panel row drives here,
so switching between them is a one-value edit. `climate` needs `schemaVersion`
`"1.3"`.

#### Robot vacuums

```json
"sensors": {
  "vacuums": {
    "kitchen_robot": {
      "entity":   "vacuum.example_robot",
      "battery":  "sensor.example_robot_battery_level",
      "segments": { "kitchen": 7, "lounge": 8 }
    }
  }
}
```

Keyed by the **furniture item** that draws the robot and its dock (a
`robot-vacuum` item in `geometry.json`). Furniture renders merged, so the
item is found by where a tap lands: a tap whose first solid hit falls inside
that item's box opens the vacuum's card. The card, and a matching block in the
sidebar's Controls view, show:

- the status (the integration's own `status` attribute when it has one,
  `Charging completed` say, else the vacuum state) and the battery, from
  `battery` or, without it, the vacuum's `battery_level` attribute;
- **Start** (`vacuum.start`; **Resume** while paused), **Pause**
  (`vacuum.pause`) and **Dock** (`vacuum.return_to_base`). Each is enabled
  only when it would change something: no Start while cleaning, no Dock while
  docked, no Pause unless cleaning or returning;
- one **clean this room** button per `segments` entry: room id -> the
  integration's own room number, sent as `segments: [n]` to
  `segmentService` (default `dreame_vacuum.vacuum_clean_segment`, the Dreame
  integration's; name another integration's service there).

Every button is disabled while Home Assistant is offline or the vacuum is
unavailable. A house with no Home Assistant (the demo) shows a sample robot
that the buttons move, and sends nothing. `vacuums` needs `schemaVersion`
`"1.4"`; the validator errors on an item id or a segment room the geometry
does not have.

#### Plants

```json
"sensors": {
  "plants": {
    "lounge_fern": {
      "moisture":    "sensor.example_fern_soil_moisture",
      "battery":     "sensor.example_fern_battery",
      "status":      "binary_sensor.example_fern_dry",
      "temperature": "sensor.example_fern_temperature",
      "name":        "Fern"
    },
    "hall_cactus": { "watering": "sensor.example_cactus_watering_countdown" }
  }
}
```

Keyed by the **furniture item** that draws the plant (a `plant` item in
`geometry.json`), found by where a tap lands, exactly like a robot vacuum.
The card is **read-only** -- nothing is ever sent -- and shows:

- the moisture % from `moisture`, and a status: **Dry** below `dryBelow`
  (default 20), **Wet** above `wetAbove` (default 80), else **OK**. A bound
  `status` helper decides instead when it reports something usable: a
  `binary_sensor` (on = dry) or a `sensor` warning (none / ok, dry / low /
  alarm, wet / high);
- when Home Assistant last heard from the sensor, the battery (a % or a
  high / low gauge) and the temperature, each only when bound;
- **Offline**, never 0%, when the moisture sensor is `unavailable` or
  `unknown`. Battery soil sensors drop off a Zigbee mesh often, and a 0%
  would say "water me" about a plant that may be fine.

A plant with no probe can bind `watering` instead of `moisture`: a countdown
helper (100 = watered today, 0 = due), shown as "Countdown N%" with **Water
due** at 0. `moisture` or `watering` is required. The sidebar's Controls view
lists every bound plant with the same reading. A house with no Home Assistant
(the demo) shows sample readings, labelled as such. `plants` needs
`schemaVersion` `"1.5"`; the validator errors on an item id the geometry does
not have and on `dryBelow` not below `wetAbove`.

#### Furniture item cards

```json
"sensors": {
  "items": {
    "bedroom_tv": {
      "media": [
        { "entity": "media_player.example_tv",      "label": "TV",   "role": "tv" },
        { "entity": "media_player.example_tv_cast", "label": "Cast", "role": "cast" }
      ]
    },
    "lounge_tv_console": [
      { "title": "Cupboard", "region": { "from": 0, "to": 50 },
        "readings": [
          { "entity": "sensor.example_router_temperature", "label": "Router",
            "humidity": "sensor.example_router_humidity" }
        ] },
      { "title": "Sound system", "region": { "from": 50, "to": 130 },
        "media": [ { "entity": "media_player.example_receiver", "role": "receiver" } ],
        "readings": [ { "entity": "sensor.example_shelf_temperature" } ] }
    ],
    "bedroom_bedside": {
      "lights": [
        { "entity": "light.example_bedside_all", "label": "All drawers" },
        { "entity": "light.example_bedside_top", "label": "Top drawer" }
      ]
    }
  }
}
```

Keyed by the **furniture item** that is tapped, found by where the tap lands,
exactly like a robot vacuum. The value is **one card**, or a **list of cards**
each scoped to a `region` of the item. A card has a `title` and any of five row
lists, at least one of them. **Give every card a short `title`** ("Living room
TV", "Sound system"): without one the card falls back to the item's `label` cut
at its first ` (` or ` - `, and a real house's labels are usually authoring
notes. When the first row's label would only repeat the title, the row shows
what it is instead (Television, Cast, Receiver). The header icon follows the
first row (a receiver card gets a speaker, not a TV). The rows:

- **`media`** -- a `media_player.*` row: its state (Off / On / Idle / Playing
  with the title / **Offline**), a **power switch** (`media_player.turn_on` /
  `turn_off`, disabled when the device reports it cannot), a **volume** slider
  while it is on and takes volume (`volume_set`; a device that has not reported
  a level shows an empty slider marked **?** -- unknown, never 0), and **source** and **sound
  mode** pickers when it lists them (`select_source`, `select_sound_mode` -- an
  AV receiver). `role` (`tv` / `cast` / `receiver` / `speaker`) picks the icon.
  On a `tv` item, the first `role: "tv"` row also drives the **screen**: lit
  with a generic home screen while the set is `on`, `idle`, `playing`,
  `paused` or `buffering`, and black glass when it is `off`, `standby`,
  unavailable or has not reported (a TV with no such row stays dark).

  **Art mode.** A `role: "tv"` row may say when the TV is showing art -- a
  photo-frame app on its streaming stick, say -- with an `art` condition. It
  holds when `entity` is `on` and its `attribute` equals `value`, or, with no
  `attribute`, when the entity's state equals `value`. While the TV is on and
  it holds, the row reads **Art** (with a picture-frame icon) and the 3D
  screen shows a generic painting in a mat instead of the home screen; a TV
  that is off stays black whatever the condition says. The condition's
  entity is read like any other bound entity; an `art` on a row of another
  role is ignored (and warned). Needs `schemaVersion` `"1.10"`:

  ```json
  "lounge_tv": { "title": "Lounge TV", "media": [
    { "entity": "media_player.example_tv", "label": "TV", "role": "tv",
      "art": { "entity": "remote.example_stick", "attribute": "current_activity", "value": "example.photo.frame" } }
  ] }
  ```
- **`lights`** -- a `light.*` row: on/off and brightness, plus a colour square
  when the light's `supported_color_modes` include a colour mode. Switching a
  light on sends no brightness, so it comes back at its last level (as the
  room's own light switches do); only the slider sets a level. A colour picked
  while it is off turns it on at its last level too. Until Home Assistant
  reports the level back, the card shows the last level it saw the light at,
  or "On" with an empty slider when it has seen none -- never a made-up 100%.
- **`switches`** -- a `switch.*` (or `input_boolean.*`) row for a socket or a
  device: its state (On / Off / **Offline**) and a **power switch**
  (`turn_on` / `turn_off` in the entity's own domain). Bind `power` to its
  power-draw `sensor.*` and the row shows the live draw (`41.5 W`); an offline
  power sensor shows nothing, never 0 W. Needs `schemaVersion` `"1.8"`:

  ```json
  "desk": { "title": "Desk", "switches": [
    { "entity": "switch.example_desk_monitor", "label": "Monitor", "power": "sensor.example_desk_monitor_power" }
  ] }
  ```
- **`cameras`** -- a `camera.*` row: the camera's snapshot, refreshed every
  `refreshMs` (default `2000`, 500-60000) while the card is open, paused while
  the tab is hidden and stopped when the card closes. A camera that can stream
  gets a **Live** toggle (Home Assistant's MJPEG proxy), streaming only while
  the card is open and Live is on. A snapshot that cannot be refreshed keeps
  the last frame, dimmed, and retries with a growing back-off; there is never
  a broken-image icon. The picture comes from the entity's `entity_picture`
  (a short-lived, rotating token), fetched as a plain image -- no library.
  Needs `schemaVersion` `"1.9"`:

  ```json
  "crate": { "title": "Crate", "cameras": [
    { "entity": "camera.example_crate", "label": "Crate cam", "refreshMs": 2000 }
  ] }
  ```
- **`actions`** -- a button that runs a `script.*`: one tap sends
  `script.turn_on` targeting the script with the row's `variables` -- the
  same guarded call as the sidebar's room script -- and the button says
  **Sent** (or **Not sent -- try again**) for a moment. It is a single tap
  with no confirm, so bind only what is safe to run by mistake (launching an
  app, say, not switching a room off). `label` is the button's text; `icon`
  names a built-in card icon (`art`, `play`, `tv`, ...). Disabled while Home
  Assistant is not connected; nothing is ever sent on render or on a
  reconnect. The demo house previews it ("Sent (sample)") and sends nothing.
  Needs `schemaVersion` `"1.10"`:

  ```json
  "lounge_tv": { "title": "Lounge TV", "actions": [
    { "entity": "script.example_tv_art", "label": "Art mode", "icon": "art",
      "variables": { "tv": "media_player.example_tv" } }
  ] }
  ```
- **`readings`** -- a read-only `sensor.*` row: the value with its
  `unit_of_measurement`, and an optional `humidity` partner beside it. An
  unavailable sensor reads **Offline**, never 0.

**Regions.** `region: { from, to }` is in **cm along the item's width,
measured from its LEFT edge as seen from its FRONT** -- standing in front of the
item, facing it. That is the order a cabinet's `fronts[].cells` are listed in,
so a 180 cm console authored as cells `[door 50, stack 80, door 50]` has its
left door at `0`-`50`, the stack at `50`-`130` and its right door at
`130`-`180`. A tap picks the card whose region holds it (the first listed on a
shared edge), else a card with no region (the whole item), else nothing: a tap
on a part no card covers is a plain furniture tap and selects the room as
before.

Two kinds of furniture need **no entry here**: any `wall-clock` item opens a
card with the local time and date, titled "<Room> clock" (never the item's
label), and any `radiator` item opens the climate card of the room it stands in
(`climate` above; nothing if that room has none). To name either, give it a
**title-only** entry: `"office_clock": { "title": "Gold clock" }` (the
validator warns about a title-only entry on any other item, where it has nothing
to show, and on a radiator whose room has no `climate` binding, where nothing
opens). Temperatures read with one decimal (`31.0°C`), as the climate card
does. A light channel drawn on an item (a bedside table's LED strip) is still
its own light tap and wins over the item's card.

Every control is disabled while Home Assistant is offline and nothing is sent;
a house with no Home Assistant (the demo) shows sample devices that the
controls move. `items` needs `schemaVersion` `"1.6"`; the validator errors on
an item id the geometry does not have and on a region whose `from` is not below
its `to`, and warns on a region past the item's `params.width` and on two
overlapping regions.

#### Room scripts ("Kill room")

```json
"sensors": {
  "roomScripts": {
    "lounge":  { "entity": "script.example_room_off", "variables": { "area": "lounge_and_kitchen" } },
    "kitchen": { "entity": "script.example_room_off", "variables": { "area": "lounge_and_kitchen" } },
    "study":   { "entity": "script.example_room_off", "variables": { "area": "study" },
                 "label": "Switch room off" }
  }
}
```

Keyed by **room id**. Each bound room's panel ends with one red, full-width
button — **Kill room** unless `label` says otherwise — that runs `entity` with
that room's `variables`. It is meant for a script that switches the room off
(lights, curtains, TVs), so a mis-tap must not fire it:

1. The first tap **arms** it: the button turns solid red and reads "Tap again
   to kill room". Left alone for about 4 seconds, it goes back to idle. A
   second tap within 0.4 s of the first is ignored, so a double-tap is not a
   confirm.
2. The second tap sends **one** `script.turn_on`, targeting `entity`, with
   `variables` as its `variables`, and the button reads **Sent** (or **Not
   sent — try again** when the call could not go out) for a moment.

Nothing is sent on render, on a reconnect or on a resync — only from that
second tap. The button is disabled while Home Assistant is not connected
(losing the connection also disarms it), and in a house with no Home Assistant
(the demo), where there is nothing to run it on. Leaving the room or closing
the sidebar disarms it.

From the keyboard, Enter or Space arms it and a second, separate press
confirms. The button keeps focus between the two, and a status region
announces "Armed" and then "Sent" to a screen reader. Holding Enter down never
confirms: after a keyboard arm, the key has to be released before a keyboard
press can count. A screen reader's or switch device's activation (no key
events reach the page) works like a tap: the first arms, a second one
confirms, sending after half a second with no further activation. Holding a
switch that repeats its activation does not confirm. Three or more evenly
spaced activations within 1.5 s, or any activation inside that half-second
wait, cancel the arm, and nothing counts until activations pause for a full
second. This guard is inferred from the timing of the clicks. It has **not**
been verified with real NVDA, VoiceOver or switch-access hardware.

`script.turn_on` rather than the script's own service (`script.<name>`):
`turn_on` is Home Assistant's way to start a script **by entity id** with
`variables`, and it returns as soon as the script has started instead of
waiting for it to finish. **Sent** therefore means Home Assistant accepted the
call, not that every device has already switched off.

One script can serve every room: bind it to each room with the value that
room's variables need. Several rooms may pass **identical** variables — two
rooms the script treats as one area — and the validator does not report that.
`roomScripts` needs `schemaVersion` `"1.7"`; the validator errors on a room id
the geometry does not have, and the schema requires a `script.*` entity.

Leave `url` and `fallbackUrl` out of a committed profile. A hostname in a
tracked file discloses infrastructure; supply them through runtime config
instead. And, again: **the token is never in this file.**

---

## A minimal worked example

One room, one door, one light. This is a complete, valid profile.

`houses/minimal/geometry.json`:

```json
{
  "kind": "geometry",
  "schemaVersion": "1.0",
  "id": "minimal",
  "name": "One-room example",
  "units": "cm",

  "coordinateTransform": { "originX": 200, "originY": 200, "scale": 0.01 },

  "defaults": { "wallHeight": 250, "wallThickness": 10, "doorHeight": 203 },
  "materials": { "wallColor": "#ece9e1", "doorSlabColor": "#ece4d4" },
  "site": { "latitude": 51.5, "locationLabel": "London, UK" },

  "rooms": [
    {
      "id": "studio",
      "label": "Studio",
      "polygon": [[0, 0], [400, 0], [400, 300], [0, 300]],
      "floorColor": "#9e8b72",
      "floorMaterial": "wood"
    }
  ],

  "walls": {
    "highestIdEverAssigned": 4,
    "segments": [
      { "id": 1, "start": [0, 0],     "end": [400, 0],   "exterior": true, "thickness": 30 },
      { "id": 2, "start": [400, 0],   "end": [400, 300], "exterior": true, "thickness": 30 },
      { "id": 3, "start": [400, 300], "end": [0, 300],   "exterior": true, "thickness": 30 },
      { "id": 4, "start": [0, 300],   "end": [0, 0],     "exterior": true, "thickness": 30 }
    ]
  },

  "doors": [
    {
      "id": "front_door",
      "label": "Front door",
      "wall": 1,
      "centre": 200,
      "width": 90,
      "hinge": "west",
      "swing": "south",
      "maxOpenDegrees": 90,
      "kind": "front",
      "room": "studio"
    }
  ],

  "lights": [
    {
      "room": "studio",
      "fixtures": [
        {
          "channel": "main",
          "label": "Studio ceiling",
          "fixtureType": "downlight",
          "colorTemperatureK": 2700,
          "positions": [
            { "at": [140, 150] },
            { "at": [260, 150] }
          ]
        }
      ]
    }
  ]
}
```

Reading it back: the room is a 4 m × 3 m rectangle whose north-west corner is the
plan origin. `originX: 200, originY: 200` is the centre of that rectangle, so the
house sits centred on the world origin. Wall 1 is the north wall (both endpoints
at `y = 0`, and remember small y is north). The front door sits in it, centred
200 cm along, hinged at its west end, opening south — into the studio, which is
south of the north wall. Two downlights, a third of the way in from each end.

`houses/minimal/rooms.json`:

```json
{
  "kind": "rooms",
  "schemaVersion": "1.0",
  "house": "minimal",
  "homeAssistant": { "enabled": false },
  "rooms": {
    "studio": { "main": ["light.studio_ceiling"] }
  }
}
```

`enabled: false` renders the house as a static model with no Home Assistant
connection — the right default for an example.

Check it:

```
$ python scripts/validate-house.py houses/minimal
PASS  houses/minimal
```

---

## Validating

```
python scripts/validate-house.py houses/myhouse          # a profile directory
python scripts/validate-house.py houses/myhouse/geometry.json   # one file
python scripts/validate-house.py houses/*/               # all of them
```

Exit code 0 on success, 1 on any error. Warnings never fail the run.

The validator does two passes. First it checks the documents against
`houses/schema.json` (this needs `pip install jsonschema`; without it the script
still runs, reports `PARTIAL` instead of `PASS`, and does the second pass anyway
rather than passing silently — pass `--strict` to make a missing `jsonschema`
a hard failure instead). Then it runs the cross-reference and semantic checks
that a JSON Schema cannot express:

- room ids and wall ids unique; wall ids within `highestIdEverAssigned`
- doors referencing walls and rooms that exist
- a door's opening actually lying within its wall's span
- `hinge` along the wall and `swing` across it
- a cupboard door claiming a suspiciously wide swing
- a declared `areaSqm` that has drifted from its polygon
- texture files that are actually present on disk
- `rooms.json` room ids matching the geometry, and channels lining up with
  fixtures in both directions
- `sensors` presence room ids and door ids resolving against the geometry, and
  `sensors` appearing only in a profile that declares `schemaVersion` 1.1+
- `sensors.curtains` / `sensors.corniceLights` curtain ids resolving against the
  geometry, a cornice light bound only to a curtain with a lit cornice, a
  warning when that cornice is ALSO listed as a strip under a light channel, and
  both appearing only in a profile that declares `schemaVersion` 1.2+
- `sensors.climate` room ids resolving against the geometry, each value a single
  `climate.*` id, and appearing only in a profile that declares `schemaVersion` 1.3+
- `sensors.vacuums` item ids resolving against the geometry's furniture, their
  `segments` room ids against its rooms, and appearing only in a profile that
  declares `schemaVersion` 1.4+
- `sensors.plants` item ids resolving against the geometry's furniture, `dryBelow`
  below `wetAbove`, and appearing only in a profile that declares `schemaVersion` 1.5+
- `sensors.items` item ids resolving against the geometry's furniture, each
  region's `from` below its `to` (a warning past the item's width or overlapping
  another region), and appearing only in a profile that declares `schemaVersion` 1.6+
- a `site.latitude` precise enough to locate a building rather than a city
- which side of its wall each window, curtain and wall-anchored item faces,
  using the same probe the engine uses: **error** if the room is on neither
  side there, warning if it is on both
- `furniture`: an **error** for `furniture` in a profile below `1.2`, a
  duplicate id, a missing room or wall, a host wall that is not axis-aligned, a
  `centre` outside the wall's span, or a `fade.wall` that is missing or not
  exterior. A **warning** for a footprint outside the room's polygon, two items
  overlapping in plan whose height ranges also overlap, a top above the ceiling,
  an unregistered or not-yet-built type, a type with no schema defaults (the
  footprint checks are then skipped), and a worktop overlap of more than 1 cm
  between two `kitchen-base-run`s

Run it before you commit a profile, and wire it into CI.

## Loading a profile — how the engine gets its house

The renderer holds no house of its own. `src/house-loader.js` fetches a profile
and compiles it into the flat structures `src/home3d-scene.js` draws from, and
the scene is created against that. Two call shapes:

```js
// 1. You already have a profile: create() is synchronous, as it always was.
const house = await HouseLoader.load('demo');
const scene = Home3DScene.create(container, { house, interactive: true });

// 2. Give it an id and let the engine fetch: create() returns a Promise.
const scene = await Home3DScene.create(container, { houseId: 'demo' });
```

`opts.house` takes a compiled profile; `opts.houseId` takes a profile id under
`houses/` and implies the fetch. Passing neither throws, on purpose — an engine
that silently rendered *some* house would be the bug this whole format exists to
remove.

**Which house a deployment loads** comes from configuration, not from code:
`HOME3D_HOUSE` (via `deploy/generate-config.sh`), a `config.json`, or
`config.example.json` — see `src/config-loader.js` for the precedence chain.
`index.html` reads it from there and calls `HouseLoader.loadWithFallback()`.

### Failure is not a blank screen — and not a different house either

`loadWithFallback(id, 'demo')` **never substitutes another house for `id`.** If
the named profile cannot be loaded — a mistyped `HOME3D_HOUSE`, a profile
directory that was not mounted, a malformed `geometry.json` — it rejects, and
`index.html` turns that rejection into an on-screen error card naming the house
that failed and how to fix it.

It used to render the demo house instead. That was reversed on 2026-09-12: the
profile is bind-mounted read-only into the container, so a permissions change or
a mount that does not come back makes every `houses/<id>` request 404 *while the
container still reports healthy* — and the result was a wall tablet showing a
fictional flat as if it were the real home, with Home Assistant wiring real
entities to fake rooms. A visible error beats a plausible wrong answer. An unset
`HOME3D_HOUSE` still defaults to `demo`, and an explicit `demo` still loads the
demo house; only substitution for an explicitly-named house is refused.

The blank-screen principle still runs through the rest of the loader, where the
failure is partial rather than "this is not the house you asked for":

- a **texture that 404s or is empty** leaves the wall painted, rather than
  rendering an unlit black panel that reads as a hole in the building
- a **door in a wall that does not exist**, or with `hinge` parallel to `swing`,
  is skipped with a warning rather than drawn embedded in its own wall
- a **room with no `lights` entry** simply has no lights
- a profile with **no `site`** gets a fixed neutral daylight, rather than the
  engine picking a latitude on the author's behalf

Every one of these logs through `console.warn` with the profile field at fault,
and the compiled profile carries the same list on `house.warnings`.

### Refusing a profile it cannot render correctly

The loader hard-refuses a `schemaVersion` whose MAJOR it does not know: a newer
major may redefine a field the engine already reads, and rendering it anyway
would be silently wrong. A newer MINOR loads, because the schema's own contract
says minors are additive.

### What the engine exports about the loaded house

`Home3DScene.ROOMS`, `.LIGHTS`, `.WALL_SEGMENTS_WORLD`, `.DOOR_LABELS_WORLD`,
`.FOOTPRINT_BOUNDS`, `.COORD_TRANSFORM`, `.WALL_HEIGHT`, `.FURNITURE` (the
compiled placements) and `.HOUSE` describe
**the house currently loaded**. They are consumed by the debug overlays in
`src/overlays/` and by embedders. The object identity is stable, so a reference
captured at load time stays valid — but they are empty until a house is bound,
so read them *after* `create()` resolves.

`WALL_SEGMENTS_WORLD` and `FOOTPRINT_BOUNDS` derive from the **corner-extended**
wall centrelines, not the authored ones. At a genuine L-corner the engine runs
both walls half a thickness past the joint so their boxes overlap instead of
leaving a notch; the overlays draw over what is actually rendered. The profile
stores the authored centrelines because the extension is a rendering artifact,
not a fact about the building.

### Decoration that no other field describes

`decor` is an opt-in list of bespoke geometry, named rather than described —
currently only `'acoustic-panels'`, vertical oak slat panelling keyed to
particular wall ids. It is furniture, not building fabric; do not reach for it
to model something the profile could already express.

```json
"decor": ["acoustic-panels"]
```

The living-room panel on wall 1 takes its span from that wall's optional
`slats` field — `[start, end]` in plan cm on the wall's long axis, the same
convention as a finish's `along`. The step return onto wall 3 is drawn at the
higher end. Without it the panel keeps its original span, 353.4 to 707.8.

```json
{ "id": 1, "start": [288.3, -19.8], "end": [288.3, 791.8], "slats": { "along": [289.2, 707.8] } }
```

**It belongs in `geometry.json`, because it is a fact about the house.** A house
that owns slat panelling owns it wherever the profile is loaded — the embedding
page should not have to know, and a page that forgets would silently render a
different building. An earlier version of this engine took decor *only* as an
`opts.decor` argument to `create()`, with no profile field at all, so a house
could not ask for its own panelling: the panels were simply absent from every
load, and 158 meshes of the model went missing without any error.

`opts.decor` still exists and is unioned with the profile's list, for an
embedder that wants to add decoration on top of what the house declares.

A house that says nothing gets nothing. Asking for it in a house without the
wall ids it needs is a quiet no-op, and an unrecognised name is ignored rather
than rejected — so a profile written for a newer engine still loads on an older
one.

### Overlay scripts a profile brings with it

`extraOverlays` names JavaScript files, shipped inside the profile directory,
that the page loads after the engine and the house are ready.

```json
"extraOverlays": ["overlays/proposed-layout.js"]
```

It looks like `decor` and is doing something quite different. `decor` names
geometry **this engine already contains**, from a closed enum — the profile is
only choosing to switch it on. `extraOverlays` points at code the engine does
*not* contain and cannot validate beyond its path. The mechanism is generic; the
overlay is the profile author's own.

The reason it exists is privacy. An overlay of this kind usually draws something
true about **one particular building** — a renovation plan, a survey annotation,
a furniture layout resolved against photographs of a real interior. That drawing
should not have to live in a public engine repository in order to be usable, and
this is the supported way to keep it out: a private profile directory holds its
geometry and its overlay together, and is mounted next to a public checkout that
ships neither. The demo house declares no overlays, and a profile without the
field behaves exactly as it did before the field existed.

**The contract for a loaded script** is deliberately small, so a profile author
writes an overlay rather than an integration:

* It is a classic (non-module) script, loaded *after* `Home3DScene` exports are
  populated, so it can read `COORD_TRANSFORM`, `WALL_SEGMENTS_WORLD`,
  `FOOTPRINT_BOUNDS`, `ROOMS` and the rest directly.
* **`THREE` is available as a global**, and will stay that way. The page itself
  is an ES module and loads three.js with `import * as THREE from 'three'`,
  which does *not* create a global — so `index.html` publishes `window.THREE`
  deliberately, immediately before loading these scripts, for exactly this
  contract. A classic script cannot `import`, so this is the only way an
  overlay can reach three.js, and it is covered by a CI check
  (`scripts/test-extra-overlay-global.mjs`) rather than left to convention.
* If it assigns a function to `window.__home3dOverlayRegister`, the page calls
  it once with `(scene, { transform, wallHeight, requestRender })` — the same
  options the built-in overlays in `src/overlays/` receive — and keeps whatever
  handle it returns. A script that would rather do everything itself can simply
  register nothing.
* It owns its own keyboard shortcuts and URL parameters. The engine reserves
  none on its behalf, so an overlay is free to claim a key the engine does not
  use (the built-ins take `D`, `Shift+D` and `G`).

**Failure is contained.** A script that 404s or throws is logged and skipped —
the house still renders, because a missing decoration must never cost you the
building. Scripts load sequentially, so a profile listing several gets a
deterministic order and each one's `attach` runs before the next is fetched.

**Path rule, and what it does not protect you from.** An entry must be
profile-relative, with no leading slash, no `..` and no absolute URL — the same
rule textures follow — so a profile cannot point the engine at an arbitrary
host. Understand the limit of that guard: a script named here runs with the full
privileges of the page, so **the profile directory must be trusted exactly as
much as the page is**. Do not load a house profile you would not run code from.

### Spec pages a profile brings with it

`specPages` names HTML documents, shipped inside the profile directory, that
become buttons in the Settings panel — appended after the engine's own built-in
spec list, and opened in a new tab.

```json
"specPages": [
  { "name": "BathroomSpec", "path": "specs/BathroomSpec.html", "group": "Home fittings" }
]
```

The argument is the one `extraOverlays` already makes, applied to documents
instead of code. A spec page describes how one particular fitting in **one
particular building** is built — a bathroom's tiling and fixtures, an en-suite's
layout, measured against a real room. That is house data, not engine data, so it
belongs to the profile and travels with it, rather than living in a public
engine repository that has no business knowing about it.

The engine keeps its own `specs/` directory for pages that describe *generic*
components — a door, a window, a curtain — which any house can reuse. The test
is whether the document would still make sense for a different building.

**Each entry needs both `name` and `path`.** `name` is the button label; `path`
is profile-relative, under the same rule as textures and overlays: no leading
slash, no `..`, no absolute URL. An entry missing a field, or failing the path
guard, is dropped with a console warning rather than failing the load — the same
"warn and carry on" rule as everywhere else in this file, because a missing
document must never cost you the building.

**`group` is optional and purely presentational.** It decides which collapsible
section of the Settings > Specs list the button renders under. The headings are
*departments* — what a thing is part of — never rooms, because a wardrobe or a
plant can be in any room:

| Heading | Holds |
|---|---|
| Doors & Windows | the building's openings, and what covers them |
| Home fittings | things fixed to the building: radiators, wall panels, a fitted kitchen, a bathroom |
| Furniture | free-standing pieces you could carry to another room |
| Decor & accessories | small things and plants |

A room spec a profile brings, like a bathroom, belongs under **Home fittings**.
Anything absent or unrecognised is bucketed into an "Other" section at the end,
so a typo in a group name can never hide a spec page; it just lands in the wrong
bucket.

A spec page is a **family** of objects, not one object: the engine's own pages
declare their objects in a `<script type="application/json" id="spec-manifest">`
block and use the shared picker in `specs/tweaks-panel.jsx` (`SpecPage` for the
objects, `SpecVariants` for each object's presets). A profile page with one
object and no presets needs neither; see that file's header if yours has more.

Unlike an overlay script, **nothing here executes in the page's origin**. A spec
page is opened as an ordinary link, so it cannot read the page's state or act on
its behalf, and the trust it requires is correspondingly lower. The path guard
is identical anyway: a profile naming an arbitrary host is wrong regardless of
how dangerous that particular asset would be.

The demo house declares no spec pages, and a profile without the field behaves
exactly as it did before the field existed.
