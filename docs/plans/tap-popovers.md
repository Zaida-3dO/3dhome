# Tap-an-object popovers — plan (spike)

**Verdict: doable, with caveats.** Three of the four popover kinds (light, curtain, door) can be
reached by tapping the 3D object today, on both houses, with no new hand-written map. The fourth
(climate) is fully buildable but has **no 3D object to tap on `main`**: the radiator model lives on
the unmerged `feat/radiator-spec` branch (the registry names `radiator.js`, which is absent on
`main`). The popover itself is built and exercised through a `?debug=1` seam.

**Finding (late, after the furniture renderer merged as #37):** rendered furniture is **merged into
per-room buckets** (`src/furniture.js` / `furniture/merge.js`), so a radiator's meshes will NOT carry
an individual `userData.furnitureId`, and the ancestor-tag resolution below cannot identify one. The
production route is to resolve a hit on a merged furniture mesh by its **hit point**: convert it to
plan coordinates and test it against the oriented footprint and height of each climate-bound
`house.furniture[]` item. That is still derived from `sensors.climate[furnitureId]`, not a new map.
(The alternative, tagging radiators `keep` so they stay unmerged, costs draw calls per radiator.)
Merged furniture is already a correct OCCLUDER for the picker, and the colour-less shadow proxies
(`colorWrite: false`) are treated as see-through.

**Effort.** Spike/prototype: ~1 day (this branch). Production-ready: a further ~2 days — unit tests
for the picker and the mapping, climate wired to real radiator meshes once they render, the schema
addition reviewed, a pass on phone ergonomics against the owner's phone, and the sidebar merge.

## What already exists (and is reused)

| Need | Where it is | Reuse |
|---|---|---|
| Scene graph + camera | `home.scene`, `home.getCamera()` (public on the scene handle) | read-only |
| Per-frame hook | `home.onRender(fn)` — fires after every drawn frame | camera-moved detection, live refresh |
| Light state + repaint | `home.lightState[room][channel]`, `home.updateLights()` | same object the sidebar mutates |
| Light → HA | `sendToHA(room, channel, state, debounce)` in `index.html` | passed into the popover module |
| Curtain state | `home.getCurtainOpen(id)`, `home.setCurtainOpen(id, pct)` | direct |
| Cover command | `HAClient.coverPositionCommand(pct, entities)` + `ha.callServiceDebounced` | same debounce key as the sidebar (`curtain-<id>`) so the two never double-send |
| Curtain availability | `ha.getCurtainAvailable(id)` | direct |
| Door reading | `doorSensorOpen` map in `index.html` (fed by `ha.onDoorChange` and the `?debug=1` seam) | passed in as an accessor |
| Bindings | `houses/<id>/rooms.json` — `rooms[room][channel]`, `sensors.curtains`, `sensors.doors` | **the mapping is derived from these** |

## The mapping — derived, not hand-written

A tap target is `{ kind, id, entities }`, resolved from the hit mesh by walking up its ancestors:

| Kind | How the mesh is recognised | Entity source |
|---|---|---|
| light | fixture mesh `userData.roomId` + **`userData.lightChannel`** (new, one line in the scene) | `rooms.json rooms[roomId][channel]` |
| curtain | ancestor group named `curtain:<id>` (already set by `wall-fittings.js`) | `sensors.curtains[id]` |
| door | door mount **`userData.doorProfileId`** (new; the existing `doorId` holds the display label, not the id) | `sensors.doors[id]` |
| climate | *spike:* ancestor `userData.furnitureId`; *production:* hit point inside a climate-bound item's footprint (furniture is merged, see above) | **new** `sensors.climate[furnitureId]` |

Only **bound** objects are targets. An unbound door or curtain falls through to the existing
tap-a-room behaviour, so nothing that works today changes.

`sensors.climate` is the one new key. `houses/schema.json` has `additionalProperties: false` on
`sensors`, so it needs a schema entry (added on this branch).

## Picking — nearest visible hit only

`Raycaster.intersectObjects(scene.children, true)` returns hits sorted by distance. Walk them:

1. Skip anything not drawn: an invisible object or ancestor, a non-mesh (labels, sprites, lines),
   and **anything whose effective opacity is < 0.35** — the faded exterior walls (0.05), the
   ceiling when viewed from above (0), the room click-catchers (0), window glass (0.28).
2. The first remaining hit decides. If it resolves to a tap target, that is the answer. If it is
   anything else — a wall, furniture, a door frame — **the tap is occluded and nothing opens**.
3. A tap target is accepted regardless of its own opacity (an OFF ambient strip is 0.15 opaque and
   must still be tappable to turn it on).

**Finger tolerance.** Ceiling discs are ~12 cm across — a few pixels at the default zoom. If the
exact ray finds no target, targets whose projected anchor lies within 24 CSS px of the tap are
tried nearest-first, each **re-tested for occlusion with its own ray** to its anchor. A light
behind a wall is still rejected, because that ray hits the wall first.

**Cost.** One recursive raycast per tap (not per move). Measured on this branch — see the
verification section. No per-frame raycasting is added.

## Gestures

**Recommendation: single tap, not double-tap.** The container is `touch-action: none`, so a double
tap would not zoom the page, but it would add a ~300 ms wait to every single tap (to rule out a
second one) and collide with the existing single-tap-selects-a-room. A single tap on a *bound
object* opens its popover and **suppresses** the room selection for that tap (on a phone the room
panel is full-width and would cover the popover); a tap anywhere else behaves exactly as before.

Tap detection mirrors the scene's own rule (≤ 5 px travel between down and up), plus: a gesture
that ever had two pointers down is never a tap (pinch end).

The popover module listens on `window` in the **capture** phase, so it decides before the scene's
own `click` handler and can stop that event — no change to the scene's input code.

## Dismissal

- pointerdown anywhere outside the popover (tap-away, and the start of every orbit/pan/pinch);
- `wheel` on the canvas;
- the camera moving for any other reason (compared per frame in `onRender`: covers `?camera=`
  presets, resize, anything programmatic);
- `Escape`.

## Positioning

Anchored to the tap point, preferring **above** it (a finger covers what is below), offset 14 px,
clamped to the viewport with an 8 px margin; flips below when there is no room above; in the
wide-screen layout it is clamped to the canvas, not under the always-open 300 px panel.

## Popover kinds

- **Light** — room + channel name, On/Off state, toggle, brightness slider. Drives the same
  `lightState` the sidebar reads, then `sendToHA`, then asks the sidebar to repaint.
- **Curtain** — name, open %, slider, Open / Close buttons (`cover.open_cover` / `close_cover`).
  Disabled with "Unavailable" when HA reports a motor down (same rule as the sidebar slider).
- **Climate** — current temperature, target temperature, −/+ and slider,
  `climate.set_temperature`. Needs a live entity read (current temp is not in any scene state).
- **Door** — read-only: Open / Closed / Unavailable. Live readings come from the same
  `doorSensorOpen` map the sidebar uses. **`ha-client.js` folds `unavailable` into "closed"**, so
  the popover does a one-shot `GET /api/states/<entity>` on open to tell the two apart.

## Offline / no HA

With HA disabled (the demo) or unreachable, popovers still open and drive the **local scene** —
the light visibly changes, the curtain visibly moves — and say "Offline preview". This mirrors
what the sidebar does for lights. It is not live control and is not claimed as such.

## Risks

| Risk | Grade | Mitigation |
|---|---|---|
| Merge conflict with the in-flight sidebar rework | Medium-low | All popover code in new files (`src/tap-popovers.js`). `index.html` gets one import and one ~20-line attach block placed after the HA wiring, away from `renderPanel()`. Two one-line tags in `home3d-scene.js`. The sidebar rework will touch `renderPanel()` and possibly door/curtain/climate state — whoever lands second rebases a small block. |
| Door status and climate semantics diverge from the sidebar's | Low | Both read the same HA entities; once the sidebar has a door-status/climate helper, the popover should call it rather than keep its own. |
| Tiny targets on a phone | Low | 24 px screen-space tolerance with per-candidate occlusion. |
| Phone GPU limit (256 fragment uniforms) | None | The popover is DOM; it adds no lights, no materials, no shader variants. |
| Raycast cost on the real house | Low | Per tap only; measured. |
| Climate unreachable by tap on `main` | Known gap | Waits on radiator rendering. Exercised through a `?debug=1` seam meanwhile. |

## Out of scope

The sidebar, merging, deploying, the server-side real house profile, HA config, radiator models.
