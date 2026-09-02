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
| `schemaVersion` | yes | Which version of the schema you wrote against, `"MAJOR.MINOR"`. Currently `"1.0"`. The engine refuses a MAJOR it does not know and may migrate an older MINOR. |
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
  "schemaVersion": "1.0",
  "house": "myhouse",
  "homeAssistant": { "enabled": true, "wsReconnectMs": 5000, "pollIntervalMs": 5000 },
  "rooms": {
    "kitchen": {
      "main":    ["light.kitchen_ceiling"],
      "ambient": ["light.kitchen_cove"]
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
still runs, says so, and does the second pass anyway rather than passing
silently). Then it runs the cross-reference and semantic checks that a JSON
Schema cannot express:

- room ids and wall ids unique; wall ids within `highestIdEverAssigned`
- doors referencing walls and rooms that exist
- a door's opening actually lying within its wall's span
- `hinge` along the wall and `swing` across it
- a cupboard door claiming a suspiciously wide swing
- a declared `areaSqm` that has drifted from its polygon
- texture files that are actually present on disk
- `rooms.json` room ids matching the geometry, and channels lining up with
  fixtures in both directions
- a `site.latitude` precise enough to locate a building rather than a city

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

### Failure is not a blank screen

`loadWithFallback(id, 'demo')` renders the demo house if `id` cannot be loaded —
a mistyped `HOME3D_HOUSE`, a profile directory that was not mounted, a malformed
`geometry.json` — and logs what went wrong and how to fix it. It only rejects if
the fallback itself is unreachable. The same principle runs through the loader:

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
