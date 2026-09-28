# Tap-an-object popovers — plan (spike)

> **Status:** merged as #47 and refined by the follow-up batch. The sections "What already exists",
> "The mapping", "Positioning", "Keyboard and lifecycle" and the door kind describe the code as
> merged; the rest is the original spike plan and its round-2 notes, kept for the reasoning.

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
`house.furniture[]` radiator in a room bound by `sensors.climate[room]` — still derived, not a new
map. (Since sidebar v2, `sensors.climate` is keyed by room; see "The mapping" below. Tracked as item
647fc9bd.)
(The alternative, tagging radiators `keep` so they stay unmerged, costs draw calls per radiator.)
Merged furniture is already a correct OCCLUDER for the picker, and the colour-less shadow proxies
(`colorWrite: false`) are treated as see-through.

**Effort.** Spike/prototype: ~1 day (this branch). Production-ready: a further ~2 days — unit tests
for the picker and the mapping, climate wired to real radiator meshes once they render, the schema
addition reviewed, a pass on phone ergonomics against the owner's phone, and the sidebar merge.

## What already exists (and is reused)

As merged (#47, and this follow-up). The popover module is `src/tap-popovers.js`; everything it
reads or writes is handed to it by the attach block in `index.html`, which sits after the HA wiring.

| Need | Where it is | Reuse |
|---|---|---|
| Scene graph + camera | `home.scene`, `home.getCamera()` (public on the scene handle) | read-only |
| Per-frame hook | `home.onRender(fn)` — fires after every drawn frame | camera-moved detection, live refresh |
| Teardown | `home.onDispose(fn)` | `index.html` registers the popover's `dispose()` there, like the debug overlays |
| Light state + repaint | `home.lightState[room][channel]`, `home.updateLights()` | same object the sidebar mutates |
| Light → HA | `sendToHA(room, channel, state, debounce)` in `index.html` | passed in as `sendLight` |
| Light / climate raw state | `ha.getRawState(entityId)` — a read-only raw-state cache in `ha-client.js` | light availability, climate `hvac_action` |
| Curtain position | `curtainShownPct(id)` / `curtainTarget` in `index.html` (the value the sidebar row paints) | `state.curtainPct`, `state.curtainLocal` accessors |
| Curtain availability | the sidebar's `curtainAvailableState` map (fed by `ha.onCurtainAvailabilityChange`) | `state.curtainAvailable` accessor — the same `=== true` rule as `curtainSliderCommand` |
| Curtain / climate writes | the sidebar-v2 `createDragSender` instances `curtainSender` / `climateSender` (`src/room-panel.js`) | shared drag lock, dedupe, availability guards; `HAClient.coverOpenCloseCommand` / `climateTargetCommand` for presses |
| Door reading | the sidebar's `doorStatus` map — `'on' \| 'off' \| 'unavailable'`, fed by `ha.onSensorStatusChange` | `state.doorStatus` accessor |
| Climate reading | the sidebar's `climateReading` map (`HAClient.parseClimate` readings, fed by `ha.onClimateChange`) | `state.climate` accessor |
| Sidebar rect | the `#panel` element | read-only: kept out of placement bounds; toggling its `open` class closes the card |
| Bindings | `houses/<id>/rooms.json` — `rooms[room][channel]`, `sensors.curtains`, `sensors.doors`, `sensors.climate` | **the mapping is derived from these** |

## The mapping — derived, not hand-written

A tap target is `{ kind, id, entities }`, resolved from the hit mesh by walking up its ancestors:

| Kind | How the mesh is recognised | Entity source |
|---|---|---|
| light | fixture mesh `userData.roomId` + `userData.lightChannel` | `rooms.json rooms[roomId][channel]` |
| curtain | ancestor group named `curtain:<id>` (set by `wall-fittings.js`) | `sensors.curtains[id]` |
| door | door mount `userData.doorProfileId` (`doorId` holds the display label, not the id) | `sensors.doors[id]` |
| climate | a tap on any `radiator` furniture item, by where it landed (`home.furnitureItemAt`) — the room the item stands in; also the `?debug=1` seam (`__home3dTap.openAt('climate', roomId, x, y)`) | `sensors.climate[room]`, one entity per room (the sidebar's binding) |
| vacuum / plant | a tap inside a bound furniture item's world box | `sensors.vacuums[itemId]` / `sensors.plants[itemId]` |
| item | a tap inside a bound furniture item's world box, then WHERE along its width (a region card) | `sensors.items[itemId]` — one card or a list of region cards (`src/item-cards.js`) |
| clock | a tap on any `wall-clock` furniture item | none — the local time |

Only **bound** objects are targets. An unbound door or curtain falls through to the existing
tap-a-room behaviour, so nothing that works today changes.

**How a radiator is tapped.** Furniture renders merged per room, so a radiator mesh carries no
identity. A tap's first solid hit is looked up against the world boxes of the tappable furniture items
(`home.furnitureItemAt`, the vacuum's route); a `radiator` item then opens the climate card of the
room it stands in — derived from `sensors.climate`, never a hand-written map (item 647fc9bd, done).

**Furniture item cards (`sensors.items`, rooms.json 1.6).** A bound item opens a composite card of
media-player rows (power, volume, source, sound mode), light rows (on/off, brightness, colour) and
read-only reading rows. An item may carry several cards, each scoped to a `region`: cm along the
item's width from its LEFT edge as seen from its FRONT — the order a cabinet's `fronts[].cells` are
listed in. `home.furnitureItemAt` returns the item's placed origin, rotation and width so the hit can
be projected onto that axis (`widthOffsetCm`); a tap on a part no card covers is not a target, and the
room click beneath handles it. A `wall-clock` item opens a read-only card with the local time. Writes
go through the HA client under the same `writeBlocked` / `canSend` rules as every other card; with no
HA configured the rows show samples the controls move. Pure logic and its tests:
`src/item-cards.js`, `scripts/test-item-cards.mjs`.

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

Anchored to the tap point: above, then below, then right or left (whichever has room), and only
then clamped, with an 8 px margin. The bounds are the canvas within the viewport **minus the open
sidebar's rect** (`boundsExcluding`): the strip beside the sidebar that contains the tap. If the card
does not fit that strip it is clamped into it, and as a last resort it stays above the sidebar in
z-order (60 over the panel's 50), never hidden behind it. Opening or closing the sidebar while a card
is open closes the card.

## Keyboard and lifecycle

On open, focus moves to the card's first control (the card itself for the door chip); Tab cycles
within the card; Escape closes it and returns focus to where it was. Because a card is always
opened by a tap, the focus ring stays hidden until a key is pressed inside it (Chrome otherwise paints
the script-moved focus as `:focus-visible` after a pointer tap). `dispose()` is registered with
`home.onDispose`, removes every listener, and clears `window.__home3dTap`.

## Popover kinds

- **Light** — room + channel name, On/Off state, toggle, brightness slider. Drives the same
  `lightState` the sidebar reads, then `sendToHA`, then asks the sidebar to repaint.
- **Curtain** — name, open %, slider, Open / Close buttons (`cover.open_cover` / `close_cover`).
  Disabled with "Unavailable" when HA reports a motor down (same rule as the sidebar slider).
- **Climate** — current temperature, target temperature, −/+ and slider,
  `climate.set_temperature`. Needs a live entity read (current temp is not in any scene state).
- **Door** — read-only chip: Open / Closed / Unavailable / Unknown, from the sidebar's `doorStatus`
  map. "Unavailable" means the sensor reported unavailable, or HA is live and the door has never
  reported (the sidebar row says the same). "Unknown" means HA is offline and the door has never
  reported — nothing says the sensor is broken. A last-known reading is kept while offline.

## Offline / no HA

With HA disabled (the demo) or unreachable, popovers still open and drive the **local scene** —
the light visibly changes, the curtain visibly moves — under a red "Not connected" dot whose
tooltip says changes only preview on the model. This mirrors
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

## Round 2: compact redesign (implemented)

This round implements the approved visual plan, taking its proposed answer on all six open questions.

- **Green** means HA is connected. **Yellow** is either (a) syncing, the snapshot after a
  (re)connect, which pulses, or (b) HA is connected but this entity, or one curtain motor, is
  unavailable. Availability is checked while syncing too, so an unavailable curtain hides its
  controls. **Red** is either "HA offline" (a configured HA that is disconnected, or whose auth or
  sync failed), or "Not connected" when no HA is configured at all (the demo house).
- **Controls are disabled whenever a configured HA is not connected, syncing included** (#60, the
  sidebar's rule). An "HA offline" line shows on the card, and a control does nothing: no command
  and no preview on the model. When the connection returns, the client's full resync re-applies
  every reading. Only with no HA configured do changes still preview locally on the model. There is
  no 'polling' mode: since #58 the client talks to HA over the WebSocket only.
- **Tooltip:** tap the dot on touch (auto-hides after 4 s); hover on a mouse, gated by
  `(hover: hover)`.
- **Light names always carry the room:** `lightName()`.
- **The door is a one-line chip.**
- **Icons are MDI, inlined as SVG paths.**
- **Heating vs idle comes from `hvac_action`, never `state`:** `climateActivity()`. `ha-client.js`
  gained a read-only raw-state cache (`getRawState`) because `parseClimate` deliberately drops
  `hvac_action`. Folding it into `parseClimate` would repaint the sidebar row on every heating flap.
- **Placement:** above, then below, then right or left (whichever has room), and only then clamped.
  The arrow points at the tap from whichever side the card is on.

**Reconciled with sidebar v2 (#48):**
- Climate is now `sensors.climate[room]`, a single entity per room. The furniture-keyed
  `sensors.climate` from round 1 is gone.
- Door state comes from the sidebar's `doorStatus` map.
- Curtain and climate writes go through the sidebar's `curtainSender` / `climateSender`, so drag
  locks, dedupe and availability guards are shared.

**Climate was not tappable at this point.** It became tappable with the furniture item cards (see
"How a radiator is tapped" above).
