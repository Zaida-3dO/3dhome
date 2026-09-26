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
| `schemaVersion` | yes | Which version of the schema you wrote against, `"MAJOR.MINOR"`. `rooms.json` is at `"1.1"`, which added the optional `sensors` block. `geometry.json` is at `"1.2"`: `1.1` added the optional `windows` and `curtains`, and `1.2` added the optional `furniture`. Older geometry still loads. The engine refuses a MAJOR it does not know and may migrate an older MINOR. |
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
  `kind: "balcony"` is BalconyWindowSpec: a wide fixed pane beside a glass door
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
  "outerColor": "#d98aa8", "innerColor": "#5f86c4"
}
```

- **Colours are data.** `outerColor` is the pleats from each end inward,
  `innerColor` the pleats toward the centre part (`outerPleats` / `innerPleats`
  of each, 5 and 2 by default). For a single-colour curtain give both the same
  value.
- `openPct` is a static pose: 0 = drawn closed, 100 (the default) = gathered
  into a stack at each end. There is no animation and no Home Assistant binding
  yet; the `id` is what a future `cover.*` binding will key on.
- **A sheer** is a curtain with `opacity` below 1 — one translucent layer, no
  lining. To hang one behind a blackout, give it a smaller `offset` (its
  distance from the wall, cm) and `"cornice": { "enabled": false }` so it shares
  the blackout's cornice. Curtains on the same wall are stacked automatically:
  each one's folds are limited so they can never pass through the wall or
  through a curtain hung behind it.
- `cornice.sideFaces: false` gives a wall-to-wall cornice spanning the whole
  room along that wall instead of a box just wider than the curtain.
- The strip light is emissive only. It adds no light source to the scene — the
  spec page's three point lights per cornice would overrun the mobile GPU
  budget the quality tiers protect.

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

**Cache-busting.** Every builder URL the registry imports carries the app
version as `?v=`, just as `index.html` does for the scripts it names.
Otherwise nginx's one-year immutable cache would keep serving the previous
release's builders. The version comes from the `?v=` the registry itself was
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

A door with a sensor bound gets a **"Use real value"** checkbox in the room
panel, checked by default. While it is checked the door follows Home Assistant
and the openness slider is disabled; unchecking it hands the slider back so the
door can still be swung by hand. A door with no sensor bound shows no checkbox
and behaves exactly as before.

Presence room ids and door ids are both checked against the paired geometry, and
a binding that names something the geometry does not have is an **error** — a
sensor bound to a room or door that does not exist can never drive anything.

`sensors` requires `schemaVersion` `"1.1"` or newer. The bump is additive: the
engine gates on MAJOR only, so a `1.1` profile loads in an older engine (which
ignores `sensors`) and a `1.0` profile loads in a newer one.

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
`.FOOTPRINT_BOUNDS`, `.COORD_TRANSFORM`, `.WALL_HEIGHT` and `.HOUSE` describe
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
section of the Settings > Specs list the button renders under. The page
recognises a fixed set of names — Doors & Windows, Home fittings, Living room,
Kitchen, Bedroom, Home office, Hallway, Store — and buckets anything absent or
unrecognised into an "Other" section at the end, so a typo in a group name can
never hide a spec page; it just lands in the wrong bucket. The engine's own
built-in specs (DoorSpec, WindowSpec, etc.) all declare `"group": "Doors &
Windows"`.

Unlike an overlay script, **nothing here executes in the page's origin**. A spec
page is opened as an ordinary link, so it cannot read the page's state or act on
its behalf, and the trust it requires is correspondingly lower. The path guard
is identical anyway: a profile naming an arbitrary host is wrong regardless of
how dangerous that particular asset would be.

The demo house declares no spec pages, and a profile without the field behaves
exactly as it did before the field existed.
