/**
 * tap-popovers.js -- tap a 3D object, get a compact popover controlling the
 * Home Assistant entity bound to it. SPIKE (docs/plans/tap-popovers.md).
 *
 * The sidebar stays the primary control surface; this is an additional,
 * direct-manipulation path. It READS the sidebar's own state (index.html's
 * doorStatus / climateReading / curtainAvailableState maps, home.lightState)
 * and WRITES through the sidebar's own send paths (sendToHA, and the shared
 * createDragSender instances for curtains and climate), so the two can never
 * disagree about what was sent or double-send.
 *
 * THE MAPPING IS DERIVED, NOT HAND-WRITTEN. A target is recognised from what
 * the scene already tags on its meshes, and bound through rooms.json:
 *
 *   light    mesh.userData.{roomId, lightChannel}  -> rooms[roomId][channel]
 *   curtain  ancestor group named 'curtain:<id>'   -> sensors.curtains[id]; the
 *            card is the ROOM's: every bound cover in the curtain's room plus
 *            their cornice lights (sensors.corniceLights), see curtainRoomGroup
 *   door     ancestor userData.doorProfileId       -> sensors.doors[id]
 *   climate  (room)                                -> sensors.climate[room]
 *   vacuum   a furniture item's world box          -> sensors.vacuums[itemId]
 *   plant    a furniture item's world box          -> sensors.plants[itemId]
 *   item     a furniture item's world box (+ where -> sensors.items[itemId], one card
 *            along its width the tap landed)          per region (src/item-cards.js)
 *   clock    a `wall-clock` item's world box        -> nothing (local time)
 *   climate  a `radiator` item's world box          -> sensors.climate[item's room]
 *
 * A robot vacuum is FURNITURE, and furniture renders merged into shared
 * buckets, so its meshes carry no identity. It is found by WHERE the tap
 * landed instead: the first solid hit's point, inside the world box of a
 * furniture item bound in sensors.vacuums (home.furnitureItemAt). Occlusion
 * is unchanged -- only the nearest solid hit is ever asked. A plant is found
 * the same way; its card is READ-ONLY (moisture, status, battery) and sends
 * nothing.
 *
 * Climate is keyed by ROOM (rooms.json 1.3, the sidebar's binding). A tap on
 * any `radiator` furniture item opens its room's climate card, found by the
 * same where-it-landed lookup (src/item-cards.js furnitureTapTarget); a room
 * with no climate binding makes its radiator a plain furniture tap. The
 * ?debug=1 seam still opens it directly (__home3dTap.openAt('climate', roomId, x, y)).
 *
 * An ITEM card (sensors.items, rooms.json 1.6) is a composite: media player
 * rows (power, volume, source, sound mode), light rows (on/off, brightness,
 * colour) and read-only reading rows, straight from each entity's raw state.
 * Its writes go through the HA client's callService / callServiceDebounced
 * under the same writeBlocked / canSend rules as every other card. A
 * `wall-clock` item opens a read-only card with the local time.
 *
 * OCCLUSION: nearest drawn, non-see-through hit wins. A faded exterior wall
 * (opacity 0.05), the ceiling seen from above (0), the room click-catchers (0)
 * and window glass (0.28) are see-through; a solid wall, a door frame or
 * furniture in front of a light BLOCKS the tap.
 *
 * The pure parts (materialOpacity, resolveTarget, pickFromHits,
 * placePopover, boundsExcluding, statusKey, doorState, curtainUnavailable,
 * lightUnavailable, hitOverlapPx, climateActivity, lightName) take no DOM and
 * are unit-tested in scripts/test-tap-popovers.mjs.
 */

import { ICONS, svgIcon } from './ui-icons.js';
import { isColorChannel, supportsColor, swatchColor, colorFromAttributes, lightServiceCall } from './light-color.js';
import { normaliseVacuumBindings, vacuumActions, vacuumCommand, vacuumSegmentCommand, vacuumStatusText,
  MOCK_VACUUM_READINGS, mockVacuumAfter } from './vacuum-control.js';
import { normalisePlantBindings, plantStatusText, agoText, batteryText, mockPlantReading } from './plant-status.js';
import { normaliseItemBindings, furnitureTapTarget, tappableFurnitureIds, mediaRowModel, lightRowModel, readingRowModel,
  rowLabel, mediaPowerCommand, mediaVolumeCommand, mediaSourceCommand, mediaSoundModeCommand, lightRowCommand,
  lightRowToggleCommand, lightColorCommand, applyCommand, mockItemState, clockText, cardEntities, cardTitle, cardIcon, rowLabelUnderTitle, bindingTitle,
  clockTitle, radiatorTitle, roomThingTitle, switchRowModel, switchCommand, cameraRowModel, cameraSnapshotUrl, cameraStreamUrl,
  createCameraFeed } from './item-cards.js';

export const OPACITY_SOLID = 0.35;   // below this a mesh is see-through for picking
export const TAP_SLOP_PX = 5;        // same rule as the scene's own room click
export const FUZZ_PX = 24;           // finger tolerance for tiny light fixtures
export const ARROW_INSET = 14;       // arrow never closer than this to a corner

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Effective opacity of the material a hit landed on (0 = not drawn). */
export function materialOpacity(material, materialIndex) {
  const m = Array.isArray(material) ? (material[materialIndex || 0] || material[0]) : material;
  if (!m) return 0;
  if (m.visible === false || m.colorWrite === false) return 0;
  return m.transparent ? m.opacity : 1;
}

/** True when the object and every ancestor are visible. */
export function isDrawn(obj) {
  for (let o = obj; o; o = o.parent) if (o.visible === false) return false;
  return true;
}

/**
 * Walk up from a hit mesh to the first thing that identifies a controllable
 * object. Returns a target when that object is BOUND in rooms.json, or null
 * (an unbound door is still a solid door -- the caller treats null as "not a
 * target", i.e. an occluder if opaque).
 *
 * @param bindings  { lights: rooms, curtains, doors } from rooms.json
 */
export function resolveTarget(obj, bindings) {
  const b = bindings || {};
  for (let o = obj; o; o = o.parent) {
    const u = o.userData || {};
    if (u.lightChannel && u.roomId) {
      const ents = ((b.lights || {})[u.roomId] || {})[u.lightChannel];
      return Array.isArray(ents) && ents.length
        ? { kind: 'light', id: u.roomId + '/' + u.lightChannel, roomId: u.roomId, channel: u.lightChannel, entities: ents, object: o }
        : null;
    }
    if (u.doorProfileId !== undefined) {
      const ents = u.doorProfileId ? (b.doors || {})[u.doorProfileId] : null;
      return Array.isArray(ents) && ents.length
        ? { kind: 'door', id: u.doorProfileId, entities: ents, object: o }
        : null;
    }
    if (typeof o.name === 'string' && o.name.indexOf('curtain:') === 0) {
      const id = o.name.slice('curtain:'.length);
      const ents = (b.curtains || {})[id];
      return Array.isArray(ents) && ents.length
        ? { kind: 'curtain', id, entities: ents, object: o }
        : null;
    }
  }
  return null;
}

/**
 * A furniture item id -> the tap target it is bound as: a robot vacuum
 * (sensors.vacuums) or a plant (sensors.plants), from their normalised
 * binding Maps; null when it is neither. A vacuum binding wins if an id were
 * bound as both.
 */
export function deviceTarget(id, vacuums, plants, object) {
  const b = vacuums && vacuums.get(id);
  if (b) return { kind: 'vacuum', id, entities: [b.entity], binding: b, object };
  const p = plants && plants.get(id);
  return p ? { kind: 'plant', id, entities: [p.moisture || p.watering], binding: p, object } : null;
}

/**
 * A furniture hit -> its tap target (what the runtime's deviceAt returns for
 * the item under the first solid hit), or null.
 *
 * PRECEDENCE: a vacuum or plant binding (deviceTarget) wins over an item
 * binding, a clock or a radiator on the same id (furnitureTapTarget). A
 * clock or a radiator may carry a title-only binding in `sensors.items`
 * (`{ "title": ... }`): it becomes the target's `label`. A clock also carries
 * its room (for "<Room> clock").
 *
 * @param it      home.furnitureItemAt's item: { id, type, room, ... }
 * @param point   the hit point (world metres)
 * @param object  the hit mesh
 * @param ctx     { vacuums, plants (normalised Maps), items (Map from
 *                normaliseItemBindings), climate (sensors.climate), rawItems
 *                (sensors.items as authored) }
 */
export function furnitureTarget(it, point, object, ctx) {
  if (!it) return null;
  const c = ctx || {};
  const t = deviceTarget(it.id, c.vacuums, c.plants, object) ||
    furnitureTapTarget(it, point, { items: c.items, climate: c.climate });
  if (t && !t.object) t.object = object;
  if (t && (t.kind === 'clock' || t.kind === 'climate')) {
    const title = bindingTitle(c.rawItems, it.id);
    if (title) t.label = title;
    if (t.kind === 'clock') t.room = it.room;
  }
  return t;
}

/**
 * The title and header icon of a furniture item card, from its row models
 * (the item view's model). The title is the binding's title, else the
 * item's short label, else its id; the LEAD row (first media, else light,
 * else switch, else reading) is relabelled in place when its label only
 * repeats the title.
 * @param rows  { media, lights, switches, readings } -- row models carrying `label` (and `role`)
 */
export function itemCardHead(card, rows, furnitureLabel, itemId) {
  const name = cardTitle(card, furnitureLabel, itemId);
  const r = rows || {};
  const lead = (r.media || [])[0] ? [r.media[0], 'media'] : (r.lights || [])[0] ? [r.lights[0], 'light']
    : (r.switches || [])[0] ? [r.switches[0], 'switch'] : (r.readings || [])[0] ? [r.readings[0], 'reading']
    : (r.cameras || [])[0] ? [r.cameras[0], 'camera'] : null;
  if (lead) lead[0].label = rowLabelUnderTitle(lead[0].label, name, lead[0].role, lead[1]);
  return { name, icon: cardIcon(card) };
}

/** A clock card's title: the title-only binding exactly as written, else "<Room> clock". */
export function clockCardName(t, roomName) {
  return clockTitle(t && t.label, t && t.room ? roomName(t.room) : '');
}

/** A radiator's climate card title (t.id is the room): the title-only binding as written, else "<Room> radiator". */
export function climateCardName(t, roomName) {
  return radiatorTitle(t && t.label, roomName(t && t.id));
}

/**
 * The item cards' send path, given its guards (injected, so the gates are
 * unit-testable). Nothing while `writeBlocked()`; with no HA configured
 * (`mockMode()`) the sample moves and nothing is sent; otherwise only when
 * `canSend()` -- a real, fully connected client -- through its
 * callServiceDebounced, followed by an optimistic repaint. `delay` > 0
 * debounces under `key` (a slider's input); a 0-delay send under the same key
 * cancels a pending one (its release), as the sidebar's senders do.
 *
 * @param d  { writeBlocked, canSend, mockMode, ha, getRaw(eid), setMock(eid, raw),
 *           setOptimistic(eid, raw) }
 * @returns (command, key, delay) => void
 */
export function createItemSender(d) {
  return function itemSend(command, key, delay) {
    if (d.writeBlocked()) return;
    const eid = command.target.entity_id;
    const cur = d.getRaw(eid);
    if (d.mockMode()) { d.setMock(eid, applyCommand(cur, command)); return; }
    if (!d.canSend()) return;
    d.ha().callServiceDebounced(command.domain, command.service, command.data, command.target, 'item:' + key + ':' + eid, delay || 0);
    d.setOptimistic(eid, applyCommand(cur, command));
  };
}

/**
 * The last level each light was seen ON at, so a light switched on with no
 * brightness (HA restores its last level) shows that level straight away --
 * never a made-up 100%. Keyed by the caller ('light:<room>/<channel>',
 * 'cornice:<curtain>', 'item:<entity>').
 *
 *   see(key, on, bri)   note a level the light REPORTED (or the user set)
 *   last(key)           that level, or null
 *   pend(key, v, ms)    a light switched on with no known level: `v` is the
 *                       stand-in the scene shows; for `ms` (or until another
 *                       level is seen) the card shows the level as unknown,
 *                       and `v` itself is never remembered as a level
 *   unknown(key, on, v) is it still that stand-in?
 *   clear(key)          the user set a level: no longer unknown
 */
export function createLevelMemory(clock) {
  const now = clock || (() => Date.now());
  const last = new Map(), pending = new Map();
  const isPending = (key, v) => { const p = pending.get(key); return !!p && p.until > now() && p.value === v; };
  return {
    see(key, on, bri) {
      if (!on || !(typeof bri === 'number' && bri > 0)) return;
      if (isPending(key, bri)) return;
      pending.delete(key);
      last.set(key, bri);
    },
    last: key => (last.has(key) ? last.get(key) : null),
    pend(key, value, ms) { pending.set(key, { value, until: now() + ms }); },
    unknown: (key, on, value) => !!on && isPending(key, value),
    clear(key) { pending.delete(key); },
  };
}

/**
 * The curtains card a tapped curtain opens: the ROOM's. Every curtain in the
 * tapped one's room (house.curtains `room`) that binds a cover
 * (sensors.curtains) is a cover row, and every one that binds a cornice light
 * (sensors.corniceLights) is a light row -- in profile order. A curtain with
 * no room is a room of its own. ONE light is one row: a curtain whose cornice
 * entities are all already on an earlier row (a curtain and a blind on one
 * window, bound to the same cornice light) adds none, and marks that row
 * `shared`.
 *
 * @param curtains        house.curtains: [{ id, name, room }] (the loader's)
 * @param coverBindings   sensors.curtains: id -> [cover entity]
 * @param corniceBindings sensors.corniceLights: id -> [light entity]
 * @returns { room, covers: [{ id, name, entities }], lights: [{ id, name, entities }] }
 */
export function curtainRoomGroup(curtainId, curtains, coverBindings, corniceBindings) {
  const list = (Array.isArray(curtains) ? curtains : []).filter(c => c && c.id);
  const me = list.find(c => c.id === curtainId);
  const room = me && me.room ? me.room : null;
  const members = list.filter(c => (room ? c.room === room : c.id === curtainId));
  if (!me) members.push({ id: curtainId, name: curtainId });
  const ents = (b, id) => { const e = b ? b[id] : null; return Array.isArray(e) && e.length ? e.slice() : null; };
  const rows = b => members.filter(c => ents(b, c.id)).map(c => ({ id: c.id, name: c.name || c.id, entities: ents(b, c.id) }));
  const lights = [];
  rows(corniceBindings).forEach(l => {
    const owner = lights.find(o => l.entities.every(e => o.entities.indexOf(e) !== -1));
    if (owner) owner.shared = true;
    else lights.push(Object.assign(l, { shared: false }));
  });
  return { room, covers: rows(coverBindings), lights };
}

/**
 * A cornice light row's state, and the level (if any) it lets the level
 * memory remember: { row: { na, on, bri, briUnknown, noReading? }, seen }.
 *
 *   just sent (opt, until HA's echo)  what was sent; a switch-on with no
 *                                     level shows the last one, else unknown
 *   HA live                           the light's raw state (lightRowModel)
 *   otherwise                         the scene's cornice strip: the demo's
 *                                     sample, or a configured HA's last
 *                                     reading while it is offline
 *
 * A configured HA that never reported this cornice leaves the scene at its
 * REST default ({ on: true, bri: 100, rest: true }): that is no reading, so the
 * row says "Unknown" (noReading) and nothing is remembered -- never an
 * invented "On · 100%".
 *
 * @param x { opt, now, last, live, raw, scene, haConfigured }
 */
export function corniceRowState(x) {
  const last = x.last;
  const lastOr100 = last != null ? last : 100;
  if (x.opt && x.opt.until > x.now) {
    return { row: { na: false, on: x.opt.on, bri: x.opt.bri != null ? x.opt.bri : lastOr100,
      briUnknown: !!x.opt.on && x.opt.bri == null && last == null }, seen: null };
  }
  if (x.live) {
    const a = (x.raw && x.raw.attributes) || {};
    const seen = x.raw && x.raw.state === 'on' && typeof a.brightness === 'number' ? Math.round(a.brightness / 2.55) : null;
    const m = lightRowModel(x.raw, false, null, seen != null ? seen : last);
    return { row: { na: m.na, on: m.on, bri: m.bri, briUnknown: m.briUnknown }, seen };
  }
  const s = x.scene;
  if (x.haConfigured && (!s || s.rest)) return { row: { na: true, noReading: true, on: false, bri: lastOr100, briUnknown: false }, seen: null };
  if (!s) return { row: { na: false, on: false, bri: 100, briUnknown: false }, seen: null };
  const seen = s.on && s.bri > 0 ? Math.round(s.bri) : null;
  return { row: { na: false, on: !!s.on, bri: seen != null ? seen : lastOr100, briUnknown: false }, seen };
}

/**
 * A row label under a card titled with the room ("Living room curtains"):
 * the room is not said twice. A label that starts with the room's WHOLE name,
 * as whole words, loses it ("Living room blinds" -> "Blinds"). Anything else
 * is kept as written -- a label that is only the room, one that merely shares
 * a word with it ("Room divider" in the "Living room"), or a shorter name for
 * the room ("Office curtain" in the "Home office").
 */
export function rowLabelInRoom(label, roomName) {
  const l = String(label || '').trim(), r = String(roomName || '').trim();
  if (!l || !r) return l;
  const lw = l.split(/\s+/), rw = r.toLowerCase().split(/\s+/);
  if (lw.length <= rw.length || !rw.every((w, k) => lw[k].toLowerCase() === w)) return l;
  const rest = lw.slice(rw.length).join(' ');
  return rest.charAt(0).toUpperCase() + rest.slice(1);
}

/** The curtains card title: "<Room> curtains", else the tapped curtain's own name. */
export function curtainCardTitle(roomName, curtainName) {
  return roomName ? roomThingTitle(roomName, 'curtains') : sentenceCase(curtainName || 'Curtains');
}

/**
 * A cornice light's HA call (every entity bound to that curtain's cornice).
 * `power`: the on/off switch -- turn_on with no brightness, so the light
 * comes back at its last level (lightServiceCall); the slider sends one.
 */
export function corniceCommand(entities, state, power) {
  const c = lightServiceCall('cornice', state, { power: !!power });
  return { domain: 'light', service: c.service, data: c.data, target: { entity_id: (entities || []).slice() } };
}

/**
 * The cornice rows' send path, gates injected (as createItemSender): nothing
 * while `writeBlocked()`; the model is previewed (the scene's cornice strip,
 * the row's optimistic state) and only then, with `canSend()` -- a fully
 * connected client -- the command goes out, debounced under
 * 'cornice-<curtainId>' for `delay` ms.
 * @param d  { writeBlocked, canSend, ha, preview(curtainId, state, power) }
 */
export function createCorniceSender(d) {
  return function sendCornice(curtainId, entities, state, power, delay) {
    if (d.writeBlocked()) return;
    d.preview(curtainId, state, power);
    if (!d.canSend()) return;
    const c = corniceCommand(entities, state, power);
    d.ha().callServiceDebounced(c.domain, c.service, c.data, c.target, 'cornice-' + curtainId, delay || 0);
  };
}

/**
 * What a card's periodic repaint does: 'rebuild' its markup, 'patch' it in
 * place (a view with a `patch`, e.g. the clock's ticking time), or 'none'.
 * A view may give a `sig(model)` that leaves out what `patch` updates, so a
 * change there alone never rebuilds the card (a rebuild restarts the title
 * marquee and moves focus). Nothing repaints under a drag unless forced.
 * @returns { action, sig } -- sig is what the card was last built from
 */
export function repaintAction(view, model, prevSig, extra, force, dragging) {
  const sig = JSON.stringify(view.sig ? view.sig(model) : model) + extra;
  if (force) return { action: 'rebuild', sig };
  if (dragging) return { action: 'none', sig: prevSig };
  if (sig !== prevSig) return { action: 'rebuild', sig };
  return { action: view.patch ? 'patch' : 'none', sig };
}

/**
 * Decide a tap from raycast hits (sorted nearest-first). Returns
 * { target, hit } for a target, { target:null, hit } when the first solid
 * thing is not a target (OCCLUDED), or { target:null, hit:null }.
 *
 * @param deviceAt  optional (hit) => target|null, asked about the FIRST
 *   SOLID hit only: a device found by where it was hit rather than by what
 *   mesh was hit (a robot vacuum inside a merged furniture bucket).
 */
export function pickFromHits(hits, bindings, deviceAt) {
  for (let i = 0; i < hits.length; i++) {
    const h = hits[i];
    const o = h.object;
    if (!o || !(o.isMesh)) continue;
    if (!isDrawn(o)) continue;
    const t = resolveTarget(o, bindings);
    if (t) return { target: t, hit: h };
    if (materialOpacity(o.material, h.face ? h.face.materialIndex : 0) < OPACITY_SOLID) continue;
    const d = typeof deviceAt === 'function' ? deviceAt(h) : null;
    if (d) return { target: d, hit: h };
    return { target: null, hit: h };
  }
  return { target: null, hit: null };
}

/**
 * Where to put a w x h popover for a tap at (x, y), inside `bounds`
 * ({left, top, right, bottom}). Boundary-aware, in this order:
 *   1. ABOVE the tap (a finger covers what is below it);
 *   2. BELOW it;
 *   3. to the RIGHT or LEFT of it, whichever has room (the larger if both) --
 *      the case a short landscape phone viewport hits, where neither above
 *      nor below fits and the old clamp put the card over the finger;
 *   4. only then clamped inside the bounds ('clamped', no arrow).
 * The arrow points at the tap from whichever side the card is on; its
 * offset is along that edge, kept ARROW_INSET from the corners.
 *
 * @returns {{left, top, placement, arrow: null | {side, offset}}}
 */
export function placePopover(x, y, w, h, bounds, gap, margin) {
  const g = gap == null ? 12 : gap;
  const m = margin == null ? 8 : margin;
  const minL = bounds.left + m, maxL = bounds.right - m - w;
  const minT = bounds.top + m, maxT = bounds.bottom - m - h;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, hi));
  const along = (pos, size) => clamp(pos, ARROW_INSET, Math.max(ARROW_INSET, size - ARROW_INSET));
  const out = (left, top, placement, side) => {
    left = Math.round(left); top = Math.round(top);
    const arrow = side === 'bottom' || side === 'top'
      ? { side, offset: Math.round(along(x - left, w)) }
      : side ? { side, offset: Math.round(along(y - top, h)) } : null;
    return { left, top, placement, arrow };
  };
  const hLeft = clamp(x - w / 2, minL, Math.max(minL, maxL));
  if (y - g - h >= minT) return out(hLeft, y - g - h, 'above', 'bottom');
  if (y + g + h <= bounds.bottom - m) return out(hLeft, y + g, 'below', 'top');
  const roomRight = bounds.right - m - (x + g);   // space for the card right of the tap
  const roomLeft = (x - g) - (bounds.left + m);
  const vTop = clamp(y - h / 2, minT, Math.max(minT, maxT));
  const fitsR = roomRight >= w, fitsL = roomLeft >= w;
  if (fitsR && (!fitsL || roomRight >= roomLeft)) return out(x + g, vTop, 'right', 'left');
  if (fitsL) return out(x - g - w, vTop, 'left', 'right');
  return out(clamp(x - w / 2, minL, Math.max(minL, maxL)), clamp(y - g - h, minT, Math.max(minT, maxT)), 'clamped', null);
}

/**
 * Is the HA client reaching Home Assistant at all? 'connected' and 'syncing'
 * (socket open, snapshot in flight) are. This drives what the card SAYS about
 * an entity (unavailable vs unknown); whether its controls work is
 * haOfflineConn() below. There is no 'polling' mode any more: since #58 the
 * client is WebSocket-only and never sets it.
 */
export function isLive(conn) {
  return conn === 'connected' || conn === 'syncing';
}

/**
 * A CONFIGURED Home Assistant that is not fully connected -- disconnected,
 * syncing, auth or sync failed. Every control is then disabled and does
 * nothing: no command and no preview on the model, the sidebar's rule
 * (haOffline in src/room-panel.js). `conn` null means there is no client at
 * all (HA not configured -- the demo house), which is NOT offline: there the
 * controls stay a local preview on the model.
 */
export function haOfflineConn(conn) {
  return conn != null && conn !== 'connected';
}

/**
 * The status dot for one popover:
 *   ok          green   HA connected, entity reporting
 *   connecting  yellow  syncing: the socket is up, snapshot pending (pulses);
 *                       controls disabled until it lands
 *   na          yellow  connected, but this entity is unavailable/unknown
 *   motor       yellow  connected, but a curtain motor is unavailable
 *   haOffline   red     a configured HA is disconnected / auth or sync failed;
 *                       controls disabled
 *   offline     red     no client at all (demo): changes only preview
 *   offlineMock red     no client, showing sample values (climate)
 *
 * Syncing outranks an entity-unavailable flag: until the first snapshot
 * lands, "this device isn't responding" would be a claim nothing supports.
 *
 * @param conn    HA client status string, or null when there is no client
 * @param entityUnavailable  true when HA is live but this entity is not
 */
export function statusKey(kind, conn, entityUnavailable, mock) {
  if (conn == null) return mock ? 'offlineMock' : 'offline';
  if (conn === 'syncing') return 'connecting';
  if (conn !== 'connected') return 'haOffline';
  if (entityUnavailable) return kind === 'curtain' ? 'motor' : 'na';
  return 'ok';
}

/**
 * The door chip's body, from the sidebar's doorStatus value ('on' | 'off' |
 * 'unavailable' | null = never heard from) and the connection:
 *   open / closed  the last reading, live or not (last-known while offline)
 *   na             "Unavailable": the sensor itself reported unavailable, or
 *                  HA is live and the door has never reported
 *   unknown        "Unknown": HA is offline and the door has never reported --
 *                  nothing says the sensor is broken, we just have no reading
 */
export function doorState(status, conn) {
  if (status === 'on') return 'open';
  if (status === 'off') return 'closed';
  if (status === 'unavailable') return 'na';
  return isLive(conn) ? 'na' : 'unknown';
}

/**
 * A curtain's controls are hidden ("Motor unavailable") whenever HA is live
 * and the sidebar's availability map does not say TRUE -- in every live mode,
 * the same rule the sidebar slider and curtainSliderCommand apply. Offline,
 * the controls stay as a preview on the model.
 */
export function curtainUnavailable(conn, available) {
  return isLive(conn) && available !== true;
}

/**
 * A light is unavailable when HA is live and its first bound entity's raw
 * state is missing, 'unavailable' or 'unknown'.
 */
export function lightUnavailable(conn, rawState) {
  return isLive(conn) && (!rawState || isUnavailableState(rawState.state));
}
export const isUnavailableState = st => !st || st === 'unavailable' || st === 'unknown';

/**
 * Placement bounds with the sidebar taken OUT: the visible scene area
 * (`bounds`) minus the open sidebar's rect. The sidebar is an opaque panel
 * over the canvas, so a card placed under it is hidden (or, above it in
 * z-order, covers the controls). Returns the strip of `bounds` left of,
 * right of, above or below the sidebar that CONTAINS the tap (x, y); if the
 * tap is in none of them, the largest strip. A sidebar that does not overlap
 * `bounds` (closed: translated off-screen) changes nothing.
 *
 * @param sidebar  {left, top, right, bottom} or null
 */
export function boundsExcluding(bounds, sidebar, x, y) {
  const b = bounds;
  if (!sidebar) return b;
  const ix = Math.min(b.right, sidebar.right) - Math.max(b.left, sidebar.left);
  const iy = Math.min(b.bottom, sidebar.bottom) - Math.max(b.top, sidebar.top);
  if (ix <= 0 || iy <= 0) return b;
  const strips = [
    { left: b.left, top: b.top, right: Math.min(b.right, sidebar.left), bottom: b.bottom },
    { left: Math.max(b.left, sidebar.right), top: b.top, right: b.right, bottom: b.bottom },
    { left: b.left, top: b.top, right: b.right, bottom: Math.min(b.bottom, sidebar.top) },
    { left: b.left, top: Math.max(b.top, sidebar.bottom), right: b.right, bottom: b.bottom },
  ].filter(r => r.right > r.left && r.bottom > r.top);
  if (!strips.length) return b;   // sidebar covers everything: last resort, stay on top of it
  const inside = strips.filter(r => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom);
  const area = r => (r.right - r.left) * (r.bottom - r.top);
  return (inside.length ? inside : strips).sort((p, q) => area(q) - area(p))[0];
}

/**
 * Is a radiator firing? From `hvac_action` (heating / idle / off), NEVER from
 * the entity's `state` -- state is the MODE ('heat' means "set to heat", not
 * "heating now"). A thermostat at target reads state 'heat', hvac_action
 * 'idle'. Returns 'heating' | 'idle' | 'off' | null (not reported).
 */
export function climateActivity(hvacAction, off) {
  if (off) return 'off';
  if (hvacAction === 'heating' || hvacAction === 'preheating') return 'heating';
  if (hvacAction === 'off') return 'off';
  if (typeof hvacAction === 'string' && hvacAction) return 'idle';
  return null;
}

/**
 * A light's popover name. Always carries the room, since the popover no
 * longer has a room subtitle: "Hall ceiling" stays as is, a bare channel
 * becomes "{Room} light", and a label lacking the room gets it prefixed
 * ("Cove" -> "Lounge cove"). Sentence case: Capitalised words after the
 * first are lowered, ALL-CAPS words (TV, LED) are kept.
 *
 * The prefix never repeats a word the label already starts with: a label
 * that begins with the END of the room name overlaps it rather than being
 * glued on after it ("Home office" + "Office ambience" -> "Home office
 * ambience", not "Home office office ambience").
 */
export function lightName(roomName, channel, label) {
  const room = String(roomName || '').trim();
  let base = String(label || '').trim();
  if (!base || base.toLowerCase() === room.toLowerCase()) {
    base = channel === 'main' ? 'light' : channel === 'ambient' ? 'ambient light' : String(channel || 'light');
  }
  return sentenceCase(room ? joinRoomName(room, base) : base);
}

/**
 * Prefix `room` to `label` unless the label already names the room, merging
 * the longest run of words that ends the room name and starts the label.
 * Case-insensitive; whole words only ("Hall" does not overlap "Hallway").
 */
export function joinRoomName(room, label) {
  const r = String(room || '').trim(), l = String(label || '').trim();
  if (!r) return l;
  if (!l) return r;
  const rw = r.split(/\s+/), lw = l.split(/\s+/);
  const low = a => a.map(w => w.toLowerCase());
  const rl = low(rw), ll = low(lw);
  // Already contains the whole room name as consecutive words: keep as is.
  for (let i = 0; i + rl.length <= ll.length; i++) {
    if (rl.every((w, k) => ll[i + k] === w)) return l;
  }
  for (let n = Math.min(rl.length, ll.length); n > 0; n--) {
    const tail = rl.slice(rl.length - n), head = ll.slice(0, n);
    if (tail.every((w, k) => w === head[k])) return rw.concat(lw.slice(n)).join(' ');
  }
  return r + ' ' + l;
}

/**
 * The popover title's marquee, decided from measured widths (CSS px):
 *   fit     the name fits: it does not move
 *   wrap    it overflows and the user prefers reduced motion: wrap to two
 *           lines instead of scrolling
 *   scroll  it overflows: pause, slide left by `distance` to reveal the
 *           end, pause, slide back, repeat. `duration` is one full cycle
 *           (ms); `offsets` are the Web Animations keyframe offsets of
 *           [start, end of first pause, end of slide, end of second pause,
 *           back home].
 * A 1px tolerance absorbs sub-pixel rounding so a name that just fits
 * never twitches.
 */
export function marqueePlan(textW, boxW, opts) {
  const o = opts || {};
  const pause = o.pauseMs == null ? 1500 : o.pauseMs;
  const speed = o.pxPerSec == null ? 30 : o.pxPerSec;
  const over = Math.ceil((+textW || 0) - (+boxW || 0));
  if (!(over > 1)) return { mode: 'fit', distance: 0 };
  if (o.reducedMotion) return { mode: 'wrap', distance: 0 };
  const slide = Math.max(400, Math.round(over / speed * 1000));
  const duration = 2 * pause + 2 * slide;
  const r = v => Math.round(v / duration * 1e4) / 1e4;
  return { mode: 'scroll', distance: over, duration,
    offsets: [0, r(pause), r(pause + slide), r(2 * pause + slide), 1] };
}

/** "Living Room Radiator" -> "Living room radiator"; ALL-CAPS words kept. */
export function sentenceCase(text) {
  return String(text || '').trim().split(/\s+/).map((wd, i) => {
    if (i === 0) return wd.charAt(0).toUpperCase() + wd.slice(1);
    return /^[A-Z][a-z]/.test(wd) ? wd.charAt(0).toLowerCase() + wd.slice(1) : wd;
  }).join(' ');
}

// ---------------------------------------------------------------------------
// Runtime (browser)
// ---------------------------------------------------------------------------

// MDI icon paths: shared with the sidebar (src/ui-icons.js).
const I = ICONS;
const svg = svgIcon;
const ico = (p, cls) => svg(p, 'tp-ico ' + (cls || ''));

const STATUS = {
  ok: ['ok', 'Live', 'Connected to Home Assistant.'],
  connecting: ['warn pulse', 'Connecting…', 'Syncing with Home Assistant. Controls are disabled until it finishes.'],
  na: ['warn', 'Entity unavailable', 'Home Assistant is reachable, but this device isn’t responding.'],
  motor: ['warn', 'Motor unavailable', 'One of this curtain’s motors isn’t responding in Home Assistant.'],
  haOffline: ['bad', 'HA offline', 'Home Assistant is not connected. Controls are disabled until it reconnects.'],
  offline: ['bad', 'Not connected', 'No Home Assistant configured. Changes only preview on the model.'],
  offlineMock: ['bad', 'Not connected', 'No Home Assistant configured. Showing sample temperatures; changes only preview.'],
  offlineSample: ['bad', 'Not connected', 'No Home Assistant configured. Showing a sample robot; the buttons only preview.'],
  offlinePlant: ['bad', 'Not connected', 'No Home Assistant configured. Showing a sample plant reading.'],
  offlineItem: ['bad', 'Not connected', 'No Home Assistant configured. Showing sample devices; changes only preview.'],
};

/**
 * Control-row geometry (CSS px) for the two pointer sizes. The buttons'
 * and switch's invisible ::after hit areas reach BELOW the row; the slider
 * starts `rangeGap` below the row. They may touch, never overlap -- a tap
 * meant for the slider's top edge must not press Close/Open (or toggle the
 * light). `hitOverlapPx` checks that; the CSS below is built from these.
 *   ibH / swH       button / switch height (the row is ibH tall, the switch
 *                   is centred in it)
 *   ibHitY / swHitY how far each ::after extends below its control
 *   rangeGap        the slider's margin-top below the row
 */
export const GEOM = {
  fine:   { ibH: 28, ibHitY: 4, swH: 20, swHitY: 12, rangeGap: 8, rangeH: 24 },
  coarse: { ibH: 34, ibHitY: 5, swH: 24, swHitY: 10, rangeGap: 5, rangeH: 44 },
};
/** Pixels by which a control's hit area overlaps the slider below (<= 0: none). */
export function hitOverlapPx(g) {
  const ib = g.ibHitY;                          // below the row's bottom edge
  const sw = g.swHitY - (g.ibH - g.swH) / 2;    // switch is centred in the row
  return Math.max(ib, sw) - g.rangeGap;
}

// Sizes as CSS variables; the coarse set is emitted twice -- under
// (pointer: coarse), and under .tp-force-coarse for the ?debug=1 seam, since
// a desktop browser cannot be made to report a coarse pointer.
const GC = GEOM.coarse, GF = GEOM.fine;
const MARQ_PAD = 6;   // px the marquee's fade reaches past the title box
const COARSE = '--w:216px;--ib-w:38px;--ib-h:' + GC.ibH + 'px;--sw-w:40px;--sw-h:' + GC.swH + 'px;--thumb:26px;--track-h:8px;';
const coarseRules = sel => `
${sel} .tp-pop { ${COARSE} }
${sel} .tp-pop[data-kind=vacuum], ${sel} .tp-pop[data-kind=curtain] { --w: 236px; }
${sel} .tp-pop[data-kind=plant] { --w: 220px; }
${sel} .tp-pop[data-kind=item] { --w: 252px; }
${sel} .tp-status::after { inset: -14px; }
${sel} .tp-btns { gap: 6px; }
${sel} .tp-ib::after { inset: -${GC.ibHitY}px -3px; }
${sel} .tp-sw::after { inset: -${GC.swHitY}px -2px; }
${sel} .tp-range { height: ${GC.rangeH}px; margin: ${GC.rangeGap}px 0 ${-(GC.rangeGap + 12)}px; }
${sel} .tp-crow { gap: 12px; margin: ${GC.rangeGap}px 0 ${-(GC.rangeGap + 12)}px; }
${sel} .tp-crow .tp-range { margin: 0; }
${sel} .tp-color { --sq: 20px; --pad: 12px; }
${sel} .tp-pop.chip { padding: 10px 12px; }`;

export const STYLE = `
.tp-pop { --w:200px; --ib-w:30px; --ib-h:${GF.ibH}px; --sw-w:36px; --sw-h:${GF.swH}px; --thumb:20px; --track-h:6px;
  --ink:#fff; --ink-2:rgba(255,255,255,0.62); --accent:#6366f1; --ok:#22c55e; --warn:#eab308; --bad:#ef4444;
  --amber:#ffd43b; --heat:#ff8a3d; --door-open:#f59e0b; --wet:#60a5fa;
  /* The card and its pointer diamond paint from these same two variables. */
  --pop-bg: rgba(10,10,20,0.94); --pop-border: rgba(255,255,255,0.10);
  /* Range parts -- see the .tp-range block below. */
  --range-track: rgba(255,255,255,0.30); --range-thumb: #fff;
  /* Dark is declared, so the browser's own controls render dark, and so Chrome's
     auto dark theme and Samsung Internet's dark web pages leave the card alone
     instead of re-colouring parts of it. */
  color-scheme: dark;
  position: fixed; z-index: 60; width: var(--w); padding: 10px 12px; border-radius: 10px;
  background: var(--pop-bg); backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px);
  border: 1px solid var(--pop-border); box-shadow: 0 6px 20px rgba(0,0,0,0.45);
  color: var(--ink); font: 12px/1.3 'Segoe UI', system-ui, sans-serif; touch-action: manipulation; box-sizing: border-box; }
.tp-pop *, .tp-pop *::before, .tp-pop *::after { box-sizing: border-box; }
.tp-pop:focus { outline: none; }   /* the card itself holds focus only as a fallback; its controls show rings */
.tp-arrow { position: absolute; width: 11px; height: 11px; background: var(--pop-bg); border: 0 solid var(--pop-border); }
.tp-arrow.bottom { bottom: -6px; transform: translateX(-50%) rotate(45deg); border-right-width: 1px; border-bottom-width: 1px; }
.tp-arrow.top { top: -6px; transform: translateX(-50%) rotate(45deg); border-left-width: 1px; border-top-width: 1px; }
.tp-arrow.left { left: -6px; transform: translateY(-50%) rotate(45deg); border-left-width: 1px; border-bottom-width: 1px; }
.tp-arrow.right { right: -6px; transform: translateY(-50%) rotate(45deg); border-right-width: 1px; border-top-width: 1px; }
.tp-head { display: flex; align-items: center; gap: 7px; min-height: 20px; }
.tp-ico { width: 16px; height: 16px; flex: none; fill: rgba(255,255,255,0.72); }
.tp-ico.light-on { fill: var(--amber); filter: drop-shadow(0 0 4px rgba(255,212,59,0.55)); }
.tp-ico.heat { fill: var(--heat); filter: drop-shadow(0 0 4px rgba(255,138,61,0.5)); }
.tp-ico.d-open { fill: var(--door-open); }
.tp-ico.d-closed { fill: var(--ok); }
.tp-ico.dim { fill: rgba(255,255,255,0.4); }
.tp-name { flex: 1; min-width: 0; font-size: 13px; font-weight: 600; white-space: nowrap; overflow: hidden; }
.tp-name-in { display: inline-block; white-space: nowrap; will-change: transform; }
/* Overflowing title (see fitTitle): the box reaches ${MARQ_PAD}px into the gaps on
   either side so the edge fades fall on empty space while the text is at
   rest, and on the text only as it slides through. Never an ellipsis. */
.tp-name.marq { margin: 0 -${MARQ_PAD}px; padding: 0 ${MARQ_PAD}px;
  -webkit-mask-image: linear-gradient(to right, transparent 0, #000 ${MARQ_PAD}px, #000 calc(100% - ${MARQ_PAD}px), transparent 100%);
  mask-image: linear-gradient(to right, transparent 0, #000 ${MARQ_PAD}px, #000 calc(100% - ${MARQ_PAD}px), transparent 100%); }
/* Reduced motion: no marquee -- wrap onto a second line instead. */
.tp-name.wrap { white-space: normal; line-height: 1.25; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
.tp-name.wrap .tp-name-in { display: inline; white-space: normal; }
.tp-status { position: relative; flex: none; width: 16px; height: 16px; margin-right: -4px; display: grid; place-items: center;
  border: 0; background: none; cursor: help; padding: 0; }
.tp-status::after { content: ''; position: absolute; inset: -8px; border-radius: 50%; }
.tp-status i { width: 8px; height: 8px; border-radius: 50%; display: block; }
.tp-status.ok i { background: var(--ok); box-shadow: 0 0 6px var(--ok); }
.tp-status.warn i { background: var(--warn); box-shadow: 0 0 6px var(--warn); }
.tp-status.bad i { background: var(--bad); box-shadow: 0 0 6px var(--bad); }
.tp-status.warn.pulse i { animation: tp-pulse 1.2s ease-in-out infinite; }
@keyframes tp-pulse { 50% { opacity: 0.35; } }
@media (prefers-reduced-motion: reduce) { .tp-status.warn.pulse i { animation: none; } }
.tp-tip { position: absolute; top: calc(100% + 8px); right: -6px; z-index: 5; width: max-content; max-width: 200px;
  padding: 6px 9px; border-radius: 7px; background: #1d1d2e; border: 1px solid rgba(255,255,255,0.16);
  box-shadow: 0 4px 14px rgba(0,0,0,0.5); font-size: 12px; line-height: 1.35; color: #fff; text-align: left;
  font-weight: 400; pointer-events: none; opacity: 0; transform: translateY(-2px); transition: opacity .12s, transform .12s; }
.tp-tip b { font-weight: 600; }
.tp-tip small { display: block; color: var(--ink-2); font-size: 12px; margin-top: 2px; }
@media (hover: hover) { .tp-status:hover .tp-tip { opacity: 1; transform: none; transition-delay: .15s; } }
.tp-status:focus-visible .tp-tip, .tp-status.tip-open .tp-tip { opacity: 1; transform: none; }
.tp-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 8px; min-height: var(--ib-h); }
.tp-val { font-size: 12px; color: var(--ink-2); white-space: nowrap; font-variant-numeric: tabular-nums; }
.tp-val b { font-size: 13px; font-weight: 600; color: var(--ink); }
.tp-val.muted b { color: var(--ink-2); }
.tp-temp { display: flex; align-items: center; gap: 7px; min-width: 0; }
.tp-temp small { display: flex; flex-direction: column; font-size: 12px; line-height: 1.2; color: var(--ink-2); white-space: nowrap; }
.tp-temp small .heat { color: var(--heat); }
.tp-val .big { font-size: 18px; font-weight: 600; color: var(--ink); letter-spacing: -0.01em; }
.tp-btns { display: flex; gap: 4px; flex: none; }
.tp-ib { position: relative; width: var(--ib-w); height: var(--ib-h); border-radius: 7px; display: grid; place-items: center;
  border: 1px solid rgba(255,255,255,0.12); background: rgba(255,255,255,0.07); color: #fff; cursor: pointer; padding: 0; }
.tp-ib svg { width: 18px; height: 18px; fill: currentColor; }
.tp-ib::after { content: ''; position: absolute; inset: -${GF.ibHitY}px -2px; }
.tp-ib:active:not(:disabled) { background: rgba(99,102,241,0.35); }
.tp-ib:disabled { opacity: 0.35; cursor: not-allowed; }
@media (hover: hover) {
  .tp-ib:hover:not(:disabled) { background: rgba(255,255,255,0.14); }
  .tp-ib[data-tip]:hover::before { content: attr(data-tip); position: absolute; bottom: calc(100% + 6px); left: 50%; transform: translateX(-50%);
    white-space: nowrap; padding: 4px 7px; border-radius: 6px; background: #1d1d2e; border: 1px solid rgba(255,255,255,0.16); font-size: 12px; z-index: 5; }
}
.tp-ib:focus-visible, .tp-sw:focus-visible, .tp-status:focus-visible, .tp-range:focus-visible { outline: 2px solid #a5b4fc; outline-offset: 2px; }
/* Opened by a tap: focus is placed on the first control for keyboard users,
   but Chrome paints a script-moved focus as :focus-visible even after a
   pointer tap. No ring until a key is pressed inside the card. */
.tp-pop.tp-ptr :focus-visible { outline: none; }
.tp-sw { position: relative; width: var(--sw-w); height: var(--sw-h); border-radius: 999px; border: 0; padding: 0; cursor: pointer;
  background: rgba(255,255,255,0.18); flex: none; transition: background .2s; }
.tp-sw::after { content: ''; position: absolute; inset: -${GF.swHitY}px -4px; }
.tp-sw i { position: absolute; top: 2px; left: 2px; width: calc(var(--sw-h) - 4px); height: calc(var(--sw-h) - 4px); border-radius: 50%; background: #fff; transition: left .2s; }
.tp-sw.on { background: var(--accent); }
.tp-sw.on i { left: calc(var(--sw-w) - var(--sw-h) + 2px); }
.tp-sw:disabled { opacity: 0.35; cursor: not-allowed; }
.tp-range:disabled { opacity: 0.35; cursor: not-allowed; }
.tp-offline { display: flex; align-items: center; gap: 6px; margin-top: 6px; font-size: 11px; color: #fecaca; }
.tp-offline::before { content: ''; flex: none; width: 6px; height: 6px; border-radius: 50%; background: #ef4444; }
.tp-range { --p: 50%; display: block; width: 100%; height: ${GF.rangeH}px; margin: ${GF.rangeGap}px 0 -4px; background: transparent;
  -webkit-appearance: none; appearance: none; cursor: pointer; outline: none; accent-color: var(--fill, var(--accent)); }
/* EVERY part of the range is styled here, in both engines. A part left to the
   browser renders its own way -- thumb, track and colours differ between
   Chrome, Android Chrome, Samsung Internet, Safari and a WebView -- which is
   why the same card looked different on each device. Filled part: --fill up
   to --p (set from the value in JS); the rest: --range-track. Thumb: white
   disc with a ring in the fill colour and a dark halo, so it separates from
   the card, the fill and the unfilled track alike. */
.tp-range::-webkit-slider-runnable-track { height: var(--track-h); border-radius: 999px; border: 0;
  background: linear-gradient(to right, var(--fill, var(--accent)) var(--p), var(--range-track) var(--p)); }
.tp-range::-moz-range-track { height: var(--track-h); border-radius: 999px; border: 0; background: var(--range-track); }
.tp-range::-moz-range-progress { height: var(--track-h); border-radius: 999px; border: 0; background: var(--fill, var(--accent)); }
.tp-range::-webkit-slider-thumb { -webkit-appearance: none; appearance: none; box-sizing: border-box;
  width: var(--thumb); height: var(--thumb); border-radius: 50%; margin-top: calc((var(--track-h) - var(--thumb)) / 2);
  background: var(--range-thumb); border: 3px solid var(--fill, var(--accent));
  box-shadow: 0 0 0 1px rgba(0,0,0,0.45), 0 2px 6px rgba(0,0,0,0.55); }
.tp-range::-moz-range-thumb { box-sizing: border-box; width: var(--thumb); height: var(--thumb); border-radius: 50%;
  background: var(--range-thumb); border: 3px solid var(--fill, var(--accent));
  box-shadow: 0 0 0 1px rgba(0,0,0,0.45), 0 2px 6px rgba(0,0,0,0.55); }
.tp-range.temp { --fill: var(--heat); }
/* Accent light: colour square inline with the brightness slider. The input's
   box is the hit area; its padding insets the visible swatch, and matching
   negative margins keep the layout at the swatch's size. */
.tp-crow { display: flex; align-items: center; gap: 8px; margin: ${GF.rangeGap}px 0 -4px; }
.tp-crow .tp-range { flex: 1 1 auto; width: auto; min-width: 0; margin: 0; }
.tp-color { --sq: 18px; --pad: 4px; flex: none; width: calc(var(--sq) + 2 * var(--pad)); height: calc(var(--sq) + 2 * var(--pad));
  margin: calc(-1 * var(--pad)); padding: 0; border: 0; background: none; cursor: pointer; -webkit-appearance: none; appearance: none; }
.tp-color::-webkit-color-swatch-wrapper { padding: var(--pad); }
.tp-color::-webkit-color-swatch { border: 1px solid rgba(255,255,255,0.35); border-radius: 5px; }
.tp-color::-moz-color-swatch { border: 1px solid rgba(255,255,255,0.35); border-radius: 5px; }
.tp-color:disabled { opacity: 0.35; cursor: not-allowed; }
.tp-color:focus-visible { outline: 2px solid #a5b4fc; outline-offset: -2px; }
.tp-range.off { --fill: rgba(255,255,255,0.55); }
/* Robot vacuum card: a status line with the battery, three labelled buttons,
   then one chip per bound room. */
.tp-pop[data-kind=vacuum] { --w: 236px; }
.tp-vstat { font-size: 13px; font-weight: 600; color: var(--ink); min-width: 0; line-height: 1.25; }
.tp-vstat.err { color: #fca5a5; }
.tp-vstat.muted { color: var(--ink-2); }
.tp-batt { display: inline-flex; align-items: center; gap: 3px; flex: none; font-size: 12px; color: var(--ink-2); font-variant-numeric: tabular-nums; }
.tp-batt svg { width: 14px; height: 14px; fill: currentColor; }
.tp-batt.low { color: #fca5a5; }
.tp-vbtns { display: grid; grid-template-columns: repeat(3, 1fr); gap: 5px; margin-top: 8px; }
.tp-vb { position: relative; display: flex; align-items: center; justify-content: center; gap: 4px; height: var(--ib-h); padding: 0 4px;
  border-radius: 7px; border: 1px solid rgba(255,255,255,0.12); background: rgba(255,255,255,0.07); color: #fff; cursor: pointer;
  font: 600 12px/1 'Segoe UI', system-ui, sans-serif; }
.tp-vb svg { width: 15px; height: 15px; fill: currentColor; flex: none; }
.tp-vb::after { content: ''; position: absolute; inset: -${GF.ibHitY}px -2px; }
.tp-vb:disabled { opacity: 0.35; cursor: not-allowed; }
.tp-vb:active:not(:disabled) { background: rgba(99,102,241,0.35); }
.tp-vb.primary:not(:disabled) { background: var(--accent); border-color: transparent; }
@media (hover: hover) { .tp-vb:hover:not(:disabled) { background: rgba(255,255,255,0.14); } .tp-vb.primary:hover:not(:disabled) { background: #7c7ff2; } }
.tp-vb:focus-visible, .tp-vroom:focus-visible { outline: 2px solid #a5b4fc; outline-offset: 2px; }
.tp-vrooms-h { margin-top: 9px; font-size: 11px; color: var(--ink-2); }
.tp-vrooms { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; }
.tp-vroom { border: 1px solid rgba(255,255,255,0.14); background: transparent; color: var(--ink); border-radius: 999px; padding: 4px 9px;
  font: 12px/1.2 'Segoe UI', system-ui, sans-serif; cursor: pointer; }
.tp-vroom:disabled { opacity: 0.35; cursor: not-allowed; }
@media (hover: hover) { .tp-vroom:hover:not(:disabled) { background: rgba(255,255,255,0.1); } }
/* Plant card (read-only): the moisture big, a status pill, then one muted
   line with when HA last heard from it, the battery and the temperature. */
.tp-pop[data-kind=plant] { --w: 220px; }
.tp-ico.p-ok { fill: var(--ok); }
.tp-ico.p-dry, .tp-ico.p-due { fill: var(--door-open); }
.tp-ico.p-wet { fill: var(--wet); }
.tp-pmoist { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; color: var(--ink-2); font-variant-numeric: tabular-nums; min-width: 0; }
.tp-pmoist svg { width: 16px; height: 16px; flex: none; fill: var(--wet); }
.tp-pmoist b { font-size: 20px; font-weight: 600; color: var(--ink); letter-spacing: -0.01em; }
.tp-pmoist.muted b { font-size: 15px; color: var(--ink-2); }
.tp-pmoist.muted svg { fill: rgba(255,255,255,0.35); }
.tp-pst { flex: none; padding: 3px 9px; border-radius: 999px; font-size: 12px; font-weight: 600; line-height: 1.2;
  border: 1px solid transparent; }
.tp-pst.ok { color: #bbf7d0; background: rgba(34,197,94,0.16); border-color: rgba(34,197,94,0.4); }
.tp-pst.dry, .tp-pst.due { color: #fde68a; background: rgba(245,158,11,0.18); border-color: rgba(245,158,11,0.45); }
.tp-pst.wet { color: #bfdbfe; background: rgba(96,165,250,0.16); border-color: rgba(96,165,250,0.45); }
.tp-pmeta { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; margin-top: 6px; font-size: 11px; color: var(--ink-2); font-variant-numeric: tabular-nums; }
.tp-pmeta .tp-batt { font-size: 11px; }
.tp-pmeta .tp-batt svg { width: 12px; height: 12px; }
.tp-pnote { margin-top: 5px; font-size: 11px; color: var(--ink-2); line-height: 1.3; }
/* Furniture item card (src/item-cards.js): a stack of rows -- media players,
   lights, readings -- each a label line with its own control, divided by a
   hairline. */
.tp-pop[data-kind=item] { --w: 252px; }
.tp-pop[data-kind=item] .tp-name { flex: 1 1 auto; }
.tp-irow { margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--pop-border); }
.tp-head + .tp-irow { border-top: 0; padding-top: 0; margin-top: 6px; }
.tp-irow .tp-row { margin-top: 0; }
.tp-ilab { display: flex; align-items: center; gap: 7px; min-width: 0; flex: 1 1 auto; }
.tp-ilab > span { display: flex; flex-direction: column; min-width: 0; }
/* Row labels wrap rather than ellipsise (the card's rule: never an ellipsis). */
.tp-ilab b { font-size: 12px; font-weight: 600; color: var(--ink); line-height: 1.25; overflow-wrap: anywhere; }
.tp-ilab small { font-size: 11px; color: var(--ink-2); line-height: 1.25; overflow-wrap: anywhere; }
.tp-ilab small.on { color: var(--ok); }
.tp-ilab .tp-ico { width: 18px; height: 18px; }
.tp-ico.m-on { fill: var(--accent); }
.tp-ico.sw-on { fill: var(--ok); }
.tp-ipow { display: inline-flex; align-items: center; gap: 2px; flex: none; font-size: 11px; color: var(--ink-2);
  font-variant-numeric: tabular-nums; white-space: nowrap; }
.tp-ipow svg { width: 12px; height: 12px; fill: var(--amber); }
/* Camera row: the snapshot (or Live stream) in a 4:3 box. The <img> is the
   runtime's own element, re-attached across rebuilds (see attachCameras). A
   frame that could not be refreshed stays, dimmed; before the first frame
   the box is empty -- never a broken-image icon. */
.tp-cam { position: relative; margin-top: 6px; border-radius: 7px; overflow: hidden; aspect-ratio: 4 / 3; background: rgba(0,0,0,0.35); }
.tp-cam img { display: block; width: 100%; height: 100%; object-fit: cover; transition: opacity .2s; }
.tp-cam img.stale { opacity: 0.45; filter: grayscale(0.6); }
.tp-ib.tp-live[aria-pressed=true] { background: var(--bad); border-color: transparent; color: #fff; }
/* Curtains card: the room's cornice light(s) then its covers, one row each. */
.tp-pop[data-kind=curtain] { --w: 236px; }
.tp-pop[data-kind=curtain] .tp-name { flex: 1 1 auto; }
.tp-ireading { display: flex; align-items: baseline; gap: 6px; flex: none; font-variant-numeric: tabular-nums; white-space: nowrap; }
.tp-ireading b { font-size: 14px; font-weight: 600; color: var(--ink); }
.tp-ireading.muted b { font-size: 12px; color: var(--ink-2); font-weight: 500; }
.tp-ireading .hum { display: inline-flex; align-items: center; gap: 2px; font-size: 11px; color: var(--ink-2); }
.tp-ireading .hum svg { width: 11px; height: 11px; fill: var(--wet); }
.tp-ivol { display: flex; align-items: center; gap: 6px; margin: 6px 0 -2px; }
.tp-ivol svg { width: 14px; height: 14px; flex: none; fill: var(--ink-2); }
.tp-ivol .tp-range { flex: 1 1 auto; width: auto; min-width: 0; margin: 0; }
/* Volume not reported: an empty track, no thumb, "?" beside it -- unknown,
   never a level. Moving it sets a level (and it becomes an ordinary slider). */
.tp-range.unknown::-webkit-slider-runnable-track { background: var(--range-track); }
.tp-range.unknown::-moz-range-progress { background: transparent; }
.tp-range.unknown::-webkit-slider-thumb { opacity: 0; }
.tp-range.unknown::-moz-range-thumb { opacity: 0; }
.tp-ivol-q { flex: none; font-size: 11px; color: var(--ink-2); }
.tp-isel { display: flex; gap: 5px; margin-top: 7px; }
.tp-selw { flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.tp-selw > span { font-size: 11px; color: var(--ink-2); line-height: 1.2; }
.tp-selw .tp-select { flex: none; width: 100%; }
.tp-select { flex: 1 1 0; min-width: 0; height: var(--ib-h); padding: 0 6px; border-radius: 7px; cursor: pointer;
  border: 1px solid rgba(255,255,255,0.14); background: rgba(255,255,255,0.07); color: var(--ink);
  font: 12px/1.2 'Segoe UI', system-ui, sans-serif; }
.tp-select:disabled { opacity: 0.35; cursor: not-allowed; }
.tp-select:focus-visible { outline: 2px solid #a5b4fc; outline-offset: 2px; }
/* Clock card (read-only): the time big, the date beneath. */
.tp-pop[data-kind=clock] { --w: 200px; }
.tp-clock { margin-top: 6px; font-variant-numeric: tabular-nums; }
.tp-clock b { font-size: 30px; font-weight: 600; letter-spacing: -0.02em; color: var(--ink); }
.tp-clock small { font-size: 15px; color: var(--ink-2); margin-left: 2px; }
.tp-clock-date { font-size: 12px; color: var(--ink-2); margin-top: 1px; }
.tp-pop.chip { width: auto; max-width: 240px; padding: 8px 10px; border-radius: 999px; }
.tp-pop.chip .tp-name { flex: 0 1 auto; }
.tp-pop.chip .sep { color: var(--ink-2); }
.tp-pop.chip .st { font-weight: 600; white-space: nowrap; }
.tp-pop.chip .st.open { color: var(--door-open); }
.tp-pop.chip .st.closed { color: #4ade80; }
.tp-pop.chip .st.na, .tp-pop.chip .st.unknown { color: var(--ink-2); font-weight: 500; }
.tp-pop.chip .tp-status { margin-left: 2px; margin-right: 0; }
@media (pointer: coarse) { ${coarseRules('')} }
${coarseRules('.tp-force-coarse')}
/* Light theme (<html data-theme="light">, src/theme.js). The tokens carry most
   of it; the rest re-colours the literal white-on-dark parts. The diamond
   follows the card through --pop-bg / --pop-border. */
:root[data-theme="light"] .tp-pop { color-scheme: only light;
  /* State colours darkened to at least 3:1 on the near-white card. */
  --ink:#1a1d29; --ink-2:rgba(26,29,41,0.64); --amber:#b37f00; --heat:#e8590c; --door-open:#c77700; --ok:#15803d; --wet:#3b82f6;
  --pop-bg: rgba(250,251,253,0.96); --pop-border: rgba(0,0,0,0.12); --range-track: rgba(0,0,0,0.18);
  box-shadow: 0 6px 20px rgba(0,0,0,0.22); }
/* :where() keeps this at .tp-ico's own weight (0,1,0): it re-colours the
   plain icon, but every state class (.light-on, .heat, .d-open, .p-ok, ...)
   still outranks it and shows its colour, from the light-theme tokens above. */
:where(:root[data-theme="light"]) .tp-ico { fill: rgba(0,0,0,0.62); }
:root[data-theme="light"] .tp-ico.light-on, :root[data-theme="light"] .tp-ico.heat { filter: none; }
:root[data-theme="light"] .tp-ico.dim { fill: rgba(0,0,0,0.3); }
:root[data-theme="light"] .tp-ib, :root[data-theme="light"] .tp-vb { background: rgba(0,0,0,0.04); border-color: rgba(0,0,0,0.14); color: #1a1d29; }
:root[data-theme="light"] .tp-vb.primary:not(:disabled) { background: var(--accent); color: #fff; }
:root[data-theme="light"] .tp-vroom { border-color: rgba(0,0,0,0.16); }
@media (hover: hover) {
  :root[data-theme="light"] .tp-ib:hover:not(:disabled), :root[data-theme="light"] .tp-vb:hover:not(:disabled) { background: rgba(0,0,0,0.09); }
  :root[data-theme="light"] .tp-vroom:hover:not(:disabled) { background: rgba(0,0,0,0.06); }
  :root[data-theme="light"] .tp-ib[data-tip]:hover::before { background: #fff; border-color: rgba(0,0,0,0.14); color: #1a1d29; }
}
:root[data-theme="light"] .tp-sw { background: rgba(0,0,0,0.20); }
:root[data-theme="light"] .tp-sw.on { background: var(--accent); }
:root[data-theme="light"] .tp-sw i { box-shadow: 0 1px 3px rgba(0,0,0,0.35); }
:root[data-theme="light"] .tp-range.off { --fill: rgba(0,0,0,0.38); }
:root[data-theme="light"] .tp-range::-webkit-slider-thumb { box-shadow: 0 0 0 1px rgba(0,0,0,0.25), 0 1px 4px rgba(0,0,0,0.3); }
:root[data-theme="light"] .tp-range::-moz-range-thumb { box-shadow: 0 0 0 1px rgba(0,0,0,0.25), 0 1px 4px rgba(0,0,0,0.3); }
:root[data-theme="light"] .tp-tip { background: #fff; border-color: rgba(0,0,0,0.14); color: #1a1d29; box-shadow: 0 4px 14px rgba(0,0,0,0.2); }
:root[data-theme="light"] .tp-color::-webkit-color-swatch { border-color: rgba(0,0,0,0.25); }
:root[data-theme="light"] .tp-color::-moz-color-swatch { border-color: rgba(0,0,0,0.25); }
:root[data-theme="light"] .tp-offline { color: #b91c1c; }
:root[data-theme="light"] .tp-vstat.err, :root[data-theme="light"] .tp-batt.low { color: #b91c1c; }
:root[data-theme="light"] .tp-pop.chip .st.closed { color: #15803d; }
:root[data-theme="light"] .tp-pmoist svg { fill: #1d4ed8; }
:root[data-theme="light"] .tp-pmoist.muted svg { fill: #6b6f7b; }
:root[data-theme="light"] .tp-pst.ok { color: #166534; background: rgba(34,197,94,0.14); border-color: rgba(21,128,61,0.45); }
:root[data-theme="light"] .tp-pst.dry, :root[data-theme="light"] .tp-pst.due { color: #92400e; background: rgba(245,158,11,0.16); border-color: rgba(180,83,9,0.45); }
:root[data-theme="light"] .tp-pst.wet { color: #1e40af; background: rgba(59,130,246,0.14); border-color: rgba(29,78,216,0.45); }
:root[data-theme="light"] .tp-ico.m-on { fill: var(--accent); }
:root[data-theme="light"] .tp-select { background: rgba(0,0,0,0.04); border-color: rgba(0,0,0,0.16); }
:root[data-theme="light"] .tp-ireading .hum svg { fill: #1d4ed8; }
:root[data-theme="light"] .tp-ivol svg { fill: rgba(0,0,0,0.5); }
:root[data-theme="light"] .tp-cam { background: rgba(0,0,0,0.08); }
`;

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fillPct = r => ((+r.value - +r.min) / ((+r.max - +r.min) || 1) * 100) + '%';

// ---- Popover markup (pure: model in, HTML out) -----------------------------
// Module-level so scripts/test-ha-resync.mjs can render each card for a
// given model and check which controls are disabled. `dot` renders the
// status dot (it reads the card's tooltip state, so the caller supplies it).
const offlineLine = m => (m.haOff ? '<div class="tp-offline" data-offline>HA offline</div>' : '');
// The title sits in two spans: .tp-name clips (and fades its edges while it
// scrolls), .tp-name-in is what the marquee moves (see fitTitle).
const nameHtml = name => '<span class="tp-name"><span class="tp-name-in">' + esc(name) + '</span></span>';
const shellWith = dot => (icon, name, st, body) =>
  '<div class="tp-head">' + icon + nameHtml(name) + dot(st) + '</div>' + body;
export const popoverHtml = {
  light(m, dot) {
    const shell = shellWith(dot);
    const on = m.on && !m.na;
    // Just switched on with no level known yet: "On", an indeterminate slider.
    const val = m.na ? '<span class="tp-val muted"><b>Unavailable</b></span>'
      : '<span class="tp-val" data-v><b>' + (m.on ? 'On' : 'Off') + '</b>' + (m.on && !m.briUnknown ? ' · ' + m.bri + '%' : '') + '</span>';
    const range = '<input class="tp-range' + (m.on ? (m.briUnknown ? ' unknown' : '') : ' off') + '" data-a="bri" type="range" min="5" max="100" value="' +
      m.bri + '"' + (m.on && m.briUnknown ? ' aria-valuetext="Unknown"' : '') + ' aria-label="Brightness"' + (m.haOff ? ' disabled' : '') + '>';
    // Accent channels: the colour square sits inline, left of the slider.
    const colour = m.colorable
      ? '<input class="tp-color" data-a="color" type="color" value="' + esc(swatchColor(m.color)) +
        '" aria-label="Colour" title="Colour"' + (m.haOff ? ' disabled' : '') + '>'
      : '';
    return shell(ico(on ? I.bulb : I.bulbOff, on ? 'light-on' : (m.na ? 'dim' : '')), m.name, m.status,
      '<div class="tp-row">' + val + '<button class="tp-sw' + (m.on ? ' on' : '') + '" data-a="power" role="switch" aria-checked="' +
      m.on + '" aria-label="Power"' + (m.na || m.haOff ? ' disabled' : '') + '><i></i></button></div>' +
      (m.na ? '' : colour ? '<div class="tp-crow">' + colour + range + '</div>' : range) + offlineLine(m));
  },
  /**
   * The room's curtains card. m: { name, status, haOff, lights: [{ id, label,
   * na, on, bri }], covers: [{ id, label, na, pct }] } -- the cornice lights
   * first, then the covers. Every control carries data-a (what) and data-c
   * (which curtain).
   */
  curtain(m, dot) {
    const shell = shellWith(dot);
    const off = m.haOff;
    const rows = [];
    (m.lights || []).forEach(l => {
      const c = ' data-c="' + esc(l.id) + '"';
      const on = l.on && !l.na;
      const unk = l.on && l.briUnknown;
      const sub = l.na ? (l.noReading ? 'Unknown' : 'Unavailable') : l.on ? (unk ? 'On' : 'On · ' + l.bri + '%') : 'Off';
      let body = '<div class="tp-row"><span class="tp-ilab">' + ico(on ? I.bulb : I.bulbOff, on ? 'light-on' : (l.na ? 'dim' : '')) +
        '<span><b>' + esc(l.label) + '</b><small data-v>' + esc(sub) + '</small></span></span>' +
        '<button class="tp-sw' + (l.on ? ' on' : '') + '" data-a="cpower"' + c + ' role="switch" aria-checked="' + !!l.on +
        '" aria-label="Power: ' + esc(l.label) + '"' + (l.na || off ? ' disabled' : '') + '><i></i></button></div>';
      if (!l.na) {
        body += '<input class="tp-range' + (l.on ? (unk ? ' unknown' : '') : ' off') + '" data-a="cbri"' + c + ' type="range" min="5" max="100" value="' + l.bri +
          '"' + (unk ? ' aria-valuetext="Unknown"' : '') + ' aria-label="Brightness: ' + esc(l.label) + '"' + (off ? ' disabled' : '') + '>';
      }
      rows.push('<div class="tp-irow" data-row="cornice"' + c + '>' + body + '</div>');
    });
    (m.covers || []).forEach(cv => {
      const c = ' data-c="' + esc(cv.id) + '"';
      const dis = cv.na || off ? ' disabled' : '';
      const sub = cv.na ? '<small>Motor unavailable</small>' : '<small data-v>Open ' + cv.pct + '%</small>';
      rows.push('<div class="tp-irow" data-row="cover"' + c + '><div class="tp-row"><span class="tp-ilab">' +
        ico(cv.pct > 0 ? I.curtains : I.curtainsClosed, cv.na ? 'dim' : '') + '<span><b>' + esc(cv.label) + '</b>' + sub + '</span></span>' +
        '<span class="tp-btns">' +
        '<button class="tp-ib" data-a="close"' + c + ' data-tip="Close" aria-label="Close: ' + esc(cv.label) + '"' + dis + '>' + svg(I.cClose) + '</button>' +
        '<button class="tp-ib" data-a="open"' + c + ' data-tip="Open" aria-label="Open: ' + esc(cv.label) + '"' + dis + '>' + svg(I.cOpen) + '</button>' +
        '</span></div>' +
        (cv.na ? '' : '<input class="tp-range" data-a="pos"' + c + ' type="range" min="0" max="100" value="' + cv.pct +
          '" aria-label="Open percentage: ' + esc(cv.label) + '"' + dis + '>') + '</div>');
    });
    const anyOpen = (m.covers || []).some(cv => cv.pct > 0);
    return shell(ico(anyOpen ? I.curtains : I.curtainsClosed), m.name, m.status, rows.join('') + offlineLine(m));
  },
  /**
   * Robot vacuum. m: { name, status, haOff, reading, actions, rooms:
   * [{ roomId, name }] } -- `actions` from vacuumActions; every button is
   * also disabled while HA is offline.
   */
  vacuum(m, dot) {
    const shell = shellWith(dot);
    const r = m.reading;
    const na = !r || !r.available || !r.state;
    const off = m.haOff;
    const dis = ok => (!ok || off ? ' disabled' : '');
    const a = m.actions || {};
    const cls = na ? ' muted' : r.state === 'error' ? ' err' : '';
    const batt = r && r.battery != null
      ? '<span class="tp-batt' + (r.battery <= 20 ? ' low' : '') + '" data-batt>' + svg(I.battery) + r.battery + '%</span>' : '';
    const primaryStart = a.start && !a.pause;
    const btns = na ? '' : '<div class="tp-vbtns">' +
      '<button class="tp-vb' + (primaryStart ? ' primary' : '') + '" data-a="start" aria-label="' + (a.resume ? 'Resume' : 'Start') + ' cleaning"' + dis(a.start) + '>' +
        svg(I.play) + (a.resume ? 'Resume' : 'Start') + '</button>' +
      '<button class="tp-vb" data-a="pause" aria-label="Pause"' + dis(a.pause) + '>' + svg(I.pause) + 'Pause</button>' +
      '<button class="tp-vb" data-a="dock" aria-label="Return to dock"' + dis(a.dock) + '>' + svg(I.home) + 'Dock</button>' +
      '</div>';
    const rooms = na || !(m.rooms && m.rooms.length) ? '' :
      '<div class="tp-vrooms-h">Clean a room</div><div class="tp-vrooms">' +
      m.rooms.map(rm => '<button class="tp-vroom" data-a="room" data-room="' + esc(rm.roomId) + '"' + dis(a.rooms) + '>' + esc(rm.name) + '</button>').join('') +
      '</div>';
    return shell(ico(I.robot, na ? 'dim' : ''), m.name, m.status,
      '<div class="tp-row"><span class="tp-vstat' + cls + '" data-v>' + esc(vacuumStatusText(r)) + '</span>' + batt + '</div>' +
      btns + rooms + offlineLine(m));
  },
  /**
   * Plant (read-only). m: { name, status, haOff, reading, ago } -- reading
   * from parsePlant (or a sample), ago the "updated" text. Unavailable reads
   * "Offline", never 0%.
   */
  plant(m, dot) {
    const shell = shellWith(dot);
    const r = m.reading;
    const level = r && r.level ? r.level : 'none';
    const live = !!(r && r.available);
    const watering = live && r.moisture == null && r.watering != null;
    const val = live
      ? '<span class="tp-pmoist" data-v>' + svg(I.drop) + (watering ? 'Countdown <b>' + r.watering + '%</b>' : '<b>' + r.moisture + '%</b>') + '</span>'
      : '<span class="tp-pmoist muted" data-v>' + svg(I.drop) + '<b>' + (level === 'offline' ? 'Offline' : 'No reading') + '</b></span>';
    const tip = !live ? '' : r.fromHa ? ' title="From Home Assistant"' : watering ? ' title="A countdown to the next watering"' :
      ' title="From the moisture reading"';
    const pill = !live ? '' :
      '<span class="tp-pst ' + level + '" data-level="' + level + '"' + tip + '>' + esc(plantStatusText(r)) + '</span>';
    const bt = batteryText(r);
    const meta = [];
    if (m.ago) meta.push('<span data-ago>' + (live ? 'Updated ' : 'Last reading ') + esc(m.ago) + '</span>');
    if (bt) meta.push('<span class="tp-batt' + (r.batteryLow ? ' low' : '') + '" data-batt>' + svg(I.battery) + esc(bt) + '</span>');
    if (r && r.temperature != null) meta.push('<span data-temp>' + r.temperature.toFixed(1) + '°</span>');
    const note = level === 'offline'
      ? '<div class="tp-pnote" data-offline-note>The sensor is not reporting. Soil sensors often drop off; a press of its button usually brings it back.</div>' : '';
    return shell(ico(I.plant, live ? 'p-' + level : 'dim'), m.name, m.status,
      '<div class="tp-row">' + val + pill + '</div>' +
      (meta.length ? '<div class="tp-pmeta">' + meta.join('') + '</div>' : '') + note + offlineLine(m));
  },
  /**
   * Furniture item card (src/item-cards.js). m: { name, status, haOff,
   * media: [row], lights: [row], switches: [row], readings: [row], cameras:
   * [row] } -- each row its label and its mediaRowModel / lightRowModel /
   * switchRowModel / readingRowModel / cameraRowModel fields. Every
   * control carries data-a (what it does) and data-i (which row).
   */
  item(m, dot) {
    const shell = shellWith(dot);
    const off = m.haOff;
    const rows = [];
    const lab = (icon, label, sub, subOn) => '<span class="tp-ilab">' + icon + '<span><b>' + esc(label) + '</b>' +
      (sub ? '<small' + (subOn ? ' class="on"' : '') + '>' + esc(sub) + '</small>' : '') + '</span></span>';
    const sw = (a, i, on, dis, label) => '<button class="tp-sw' + (on ? ' on' : '') + '" data-a="' + a + '" data-i="' + i +
      '" role="switch" aria-checked="' + !!on + '" aria-label="' + esc(label) + '"' + (dis ? ' disabled' : '') + '><i></i></button>';
    // Each picker sits under a small visible caption (its <label>), so a
    // source list and a sound-mode list are told apart without a tooltip.
    const select = (a, i, list, cur, label, caption) => '<label class="tp-selw"><span>' + esc(caption) + '</span>' +
      '<select class="tp-select" data-a="' + a + '" data-i="' + i + '" aria-label="' + esc(label) + '"' +
      (off ? ' disabled' : '') + '>' + (cur != null && list.indexOf(cur) === -1 ? '<option value="" selected disabled>' + esc(cur) + '</option>' : '') +
      list.map(v => '<option value="' + esc(v) + '"' + (v === cur ? ' selected' : '') + '>' + esc(v) + '</option>').join('') + '</select></label>';
    (m.media || []).forEach((r, i) => {
      const icon = ico(r.role === 'receiver' || r.role === 'speaker' ? I.speaker : r.role === 'cast' ? I.cast : I.tv,
        r.na ? 'dim' : r.on ? 'm-on' : '');
      const sub = r.title ? r.stateText + ' · ' + r.title : r.stateText;
      let body = '<div class="tp-row">' + lab(icon, r.label, sub, r.on && !r.na) +
        sw('mpower', i, r.on, r.na || off || !r.canPower, 'Power: ' + r.label) + '</div>';
      if (r.volume != null) {
        body += '<div class="tp-ivol">' + svg(I.volume) + '<input class="tp-range" data-a="mvol" data-i="' + i +
          '" type="range" min="0" max="100" value="' + r.volume + '" aria-label="Volume: ' + esc(r.label) + '"' + (off ? ' disabled' : '') + '></div>';
      } else if (r.volumeUnknown) {
        // Takes a volume but has not reported one: UNKNOWN, never 0.
        body += '<div class="tp-ivol" data-vol-unknown>' + svg(I.volume) + '<input class="tp-range unknown" data-a="mvol" data-i="' + i +
          '" type="range" min="0" max="100" value="50" aria-valuetext="Unknown" aria-label="Volume (not reported): ' + esc(r.label) + '"' +
          (off ? ' disabled' : '') + '><span class="tp-ivol-q" role="img" aria-label="Volume not reported" title="Volume not reported">?</span></div>';
      }
      const sels = (r.sources.length ? select('msrc', i, r.sources, r.source, 'Source: ' + r.label, 'Source') : '') +
        (r.soundModes.length ? select('mmode', i, r.soundModes, r.soundMode, 'Sound mode: ' + r.label, 'Sound mode') : '');
      if (sels) body += '<div class="tp-isel">' + sels + '</div>';
      rows.push('<div class="tp-irow" data-row="media">' + body + '</div>');
    });
    (m.lights || []).forEach((r, i) => {
      const on = r.on && !r.na;
      const unk = r.on && r.briUnknown;
      const sub = r.na ? 'Unavailable' : r.on ? (unk ? 'On' : 'On · ' + r.bri + '%') : 'Off';
      let body = '<div class="tp-row">' + lab(ico(on ? I.bulb : I.bulbOff, on ? 'light-on' : (r.na ? 'dim' : '')), r.label, sub, false) +
        sw('lpower', i, r.on, r.na || off, 'Power: ' + r.label) + '</div>';
      if (!r.na) {
        const range = '<input class="tp-range' + (r.on ? (unk ? ' unknown' : '') : ' off') + '" data-a="lbri" data-i="' + i + '" type="range" min="5" max="100" value="' +
          r.bri + '"' + (unk ? ' aria-valuetext="Unknown"' : '') + ' aria-label="Brightness: ' + esc(r.label) + '"' + (off ? ' disabled' : '') + '>';
        body += r.colorable
          ? '<div class="tp-crow"><input class="tp-color" data-a="lcolor" data-i="' + i + '" type="color" value="' + esc(swatchColor(r.color)) +
            '" aria-label="Colour: ' + esc(r.label) + '" title="Colour"' + (off ? ' disabled' : '') + '>' + range + '</div>'
          : range;
      }
      rows.push('<div class="tp-irow" data-row="light">' + body + '</div>');
    });
    (m.switches || []).forEach((r, i) => {
      const on = r.on && !r.na;
      const pw = r.power ? '<span class="tp-ipow" data-power title="Power draw">' + svg(I.flash) + esc(r.power) + '</span>' : '';
      rows.push('<div class="tp-irow" data-row="switch"><div class="tp-row">' +
        lab(ico(I.plug, r.na ? 'dim' : on ? 'sw-on' : ''), r.label, r.stateText, on) + pw +
        sw('spower', i, r.on, r.na || off, 'Power: ' + r.label) + '</div></div>');
    });
    (m.readings || []).forEach(r => {
      const val = '<span class="tp-ireading' + (r.na ? ' muted' : '') + '" data-v><b>' + esc(r.text) + '</b>' +
        (r.humidity ? '<span class="hum" title="Humidity">' + svg(I.drop) + esc(r.humidity) + '</span>' : '') + '</span>';
      rows.push('<div class="tp-irow" data-row="reading"><div class="tp-row">' + lab(ico(I.thermometer, r.na ? 'dim' : ''), r.label) + val + '</div></div>');
    });
    // Camera rows: the label and a Live toggle; the picture goes in the
    // [data-cam] box, filled by the runtime (no URL or token in this markup).
    (m.cameras || []).forEach((r, i) => {
      const liveBtn = r.canLive ? '<button class="tp-ib tp-live" data-a="clive" data-i="' + i + '" aria-pressed="false" data-tip="Live" aria-label="Live: ' +
        esc(r.label) + '"' + (off ? ' disabled' : '') + '>' + svg(I.play) + '</button>' : '';
      rows.push('<div class="tp-irow" data-row="camera"><div class="tp-row">' + lab(ico(I.camera, r.na ? 'dim' : ''), r.label, r.stateText) + liveBtn +
        '</div><div class="tp-cam" data-cam="' + i + '"></div></div>');
    });
    const first = I[m.icon] || ((m.media || []).length ? I.tv : (m.lights || []).length ? I.bulb : I.thermometer);
    return shell(ico(first), m.name, m.status, rows.join('') + offlineLine(m));
  },
  /** Clock (read-only, no Home Assistant). m: { name, time, seconds, date }. */
  clock(m) {
    return '<div class="tp-head">' + ico(I.clock) + nameHtml(m.name) + '</div>' +
      '<div class="tp-clock" data-v><b data-time>' + esc(m.time) + '</b><small data-sec>:' + esc(m.seconds) + '</small></div>' +
      '<div class="tp-clock-date" data-date>' + esc(m.date) + '</div>';
  },
  climate(m, dot) {
    const shell = shellWith(dot);
    const f = v => (typeof v === 'number' && isFinite(v) ? v.toFixed(1) + '°' : '–');
    const live = !m.na && !m.off && typeof m.target === 'number';
    const dis = m.haOff ? ' disabled' : '';
    const icon = m.na ? ico(I.radiatorIdle, 'dim') : ico(I.radiator, m.activity === 'heating' ? 'heat' : '');
    const act = m.activity === 'heating' ? '<span class="heat">heating</span>' : m.activity ? '<span>' + m.activity + '</span>' : '';
    const val = m.na ? '<span class="tp-val muted"><b>Unavailable</b></span>'
      : m.off ? '<span class="tp-val tp-temp"><span class="big">Off</span><small><span>now ' + f(m.current) + '</span></small></span>'
      : '<span class="tp-val tp-temp" data-v><span class="big" data-t>' + f(m.target) + '</span><small><span>now ' + f(m.current) + '</span>' + act + '</small></span>';
    return shell(icon, m.name, m.status,
      '<div class="tp-row">' + val + (live ? '<span class="tp-btns">' +
        '<button class="tp-ib" data-a="down" data-tip="−' + m.step + '°" aria-label="Lower target"' + dis + '>' + svg(I.minus) + '</button>' +
        '<button class="tp-ib" data-a="up" data-tip="+' + m.step + '°" aria-label="Raise target"' + dis + '>' + svg(I.plus) + '</button></span>' : '') +
      '</div>' +
      (live ? '<input class="tp-range temp" data-a="set" type="range" min="' + m.min + '" max="' + m.max + '" step="' + m.step +
        '" value="' + m.target + '" aria-label="Target temperature"' + dis + '>' : '') + offlineLine(m));
  },
};

/**
 * The clock card ticks every second. Only its TIME is patched in place; the
 * card is rebuilt only when its title changes -- a rebuild would restart the
 * title's marquee, reset its aria-label and move focus, every second.
 */
export const clockTick = {
  sig: m => ({ name: m.name }),
  patch(el, m) {
    const set = (sel, text) => { const e = el.querySelector(sel); if (e && e.textContent !== text) e.textContent = text; };
    set('[data-time]', m.time); set('[data-sec]', ':' + m.seconds); set('[data-date]', m.date);
  },
};

/**
 * Attach the popover layer.
 *
 * @param {Object} o
 * @param o.THREE, o.home, o.container, o.Home3DScene, o.house, o.HAClient
 * @param o.rooms           rooms.json `rooms` (room -> channel -> entities)
 * @param o.sensors         rooms.json `sensors`
 * @param o.getHa           () => HAClient instance or null
 * @param o.sendLight       (roomId, channel, state, debounceMs, withColor) -- index.html's sendToHA
 * @param o.onObjectTap     (target) => void -- called when a tap lands on a
 *                          target, BEFORE its card opens (the page closes an
 *                          unpinned sidebar here; the card still opens)
 * @param o.state           accessors onto the sidebar's own maps:
 *   doorStatus(id) 'on'|'off'|'unavailable'|null, curtainAvailable(id) bool|null,
 *   curtainPct(id), curtainLocal(id, pct), climate(roomId) parseClimate reading|null,
 *   climateEntity(roomId)
 * @param o.curtainSender, o.climateSender  the sidebar's createDragSender instances
 * @param o.onChange        () => void -- repaint the sidebar
 * @param o.sidebar         the room panel element (read-only): its on-screen
 *                          rect is kept out of placement bounds, and toggling
 *                          its 'open' class closes the card
 * @param o.debug           expose window.__home3dTap (removed again on dispose)
 */
export function attachTapPopovers(o) {
  const { THREE, home, container, Home3DScene } = o;
  const S = o.state || {};
  const bindings = {
    lights: o.rooms || {},
    curtains: (o.sensors && o.sensors.curtains) || {},
    doors: (o.sensors && o.sensors.doors) || {},
  };
  const vacuums = normaliseVacuumBindings(o.sensors && o.sensors.vacuums);
  const plants = normalisePlantBindings(o.sensors && o.sensors.plants);
  const rawItems = (o.sensors && o.sensors.items) || {};
  const itemBindings = normaliseItemBindings(rawItems);
  const furnitureRooms = new Map(((o.house && o.house.furniture) || []).map(f => [f.id, f.room || null]));
  const climateBinding = (o.sensors && o.sensors.climate) || {};
  const deviceIds = new Set([...vacuums.keys(), ...plants.keys(),
    ...tappableFurnitureIds(o.house && o.house.furniture, itemBindings, climateBinding)]);
  const furnitureLabels = new Map(((o.house && o.house.furniture) || []).map(f => [f.id, f.label || null]));
  // A robot vacuum, a plant, a bound item, a clock or a radiator is found by
  // where the tap landed (see the header). A vacuum / plant binding wins over
  // an item binding on the same id; a bound item's tap that lands on a part
  // of it no card covers is not a target.
  const deviceCtx = { vacuums, plants, items: itemBindings, climate: climateBinding, rawItems };
  const deviceAt = !deviceIds.size || typeof home.furnitureItemAt !== 'function' ? null : h => {
    const it = h && h.point ? home.furnitureItemAt(h.point, deviceIds) : null;
    return it ? furnitureTarget(it, h.point, h.object, deviceCtx) : null;
  };
  const curtainNames = new Map(((o.house && o.house.curtains) || []).map(c => [c.id, c.name || c.id]));
  const doorNames = new Map(((o.house && o.house.doors) || []).map(d => [d.id, d.name || d.id]));
  const ha = () => (o.getHa ? o.getHa() : null);
  const onChange = () => { try { o.onChange && o.onChange(); } catch (e) { /* sidebar repaint must not break us */ } };

  // Debug-only overrides (?debug=1): a desktop browser has no Home Assistant
  // here, so the connection status and raw entity states can be SIMULATED to
  // exercise the green / yellow states. Never set outside the seam.
  const sim = { status: undefined, raw: new Map() };
  const conn = () => (sim.status !== undefined ? sim.status : (ha() ? ha().status : null));
  const raw = eid => (sim.raw.has(eid) ? sim.raw.get(eid) : (ha() && ha().getRawState ? ha().getRawState(eid) : null));
  // Commands go out only through a real client that is fully connected.
  // writeBlocked(): a configured HA that is not connected (the real status,
  // or a ?debug=1 simulated one) -- every write handler returns at once:
  // no command AND no preview on the model. With no client at all (the demo
  // house) nothing is blocked and changes preview locally, as before.
  const canSend = () => { const h = ha(); return !!h && h.status === 'connected'; };
  const writeBlocked = () => { const h = ha(); return haOfflineConn(conn()) || (!!h && h.status !== 'connected'); };

  const styleEl = document.createElement('style');
  styleEl.textContent = STYLE;
  document.head.appendChild(styleEl);

  const rc = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const tmpV = new THREE.Vector3();

  const lightTargets = [];
  home.scene.traverse(obj => {
    if (!obj.isMesh || !obj.userData || !obj.userData.lightChannel) return;
    const t = resolveTarget(obj, bindings);
    if (t) lightTargets.push(t);
  });

  function canvasRect() { return container.getBoundingClientRect(); }

  function raycastAt(clientX, clientY) {
    const r = canvasRect();
    ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    rc.setFromCamera(ndc, home.getCamera());
    return rc.intersectObjects(home.scene.children, true);
  }

  function unoccluded(t, point) {
    const origin = home.getCamera().position;
    const dir = tmpV.copy(point).sub(origin);
    const dist = dir.length();
    dir.normalize();
    rc.set(origin, dir);
    rc.far = dist + 0.05;
    const res = pickFromHits(rc.intersectObjects(home.scene.children, true), bindings, deviceAt);
    rc.far = Infinity;
    if (res.target) return res.target.id === t.id && res.target.kind === t.kind;
    return !res.hit;
  }

  let lastPickMs = 0;
  function pickAt(clientX, clientY) {
    const t0 = performance.now();
    const res = pickFromHits(raycastAt(clientX, clientY), bindings, deviceAt);
    let out;
    if (res.target) {
      out = { target: res.target, point: res.hit.point };
    } else {
      const r = canvasRect();
      const cam = home.getCamera();
      const cands = [];
      lightTargets.forEach(t => {
        t.object.getWorldPosition(tmpV);
        const wp = tmpV.clone();
        tmpV.project(cam);
        if (tmpV.z > 1 || tmpV.z < -1) return;
        const sx = r.left + (tmpV.x + 1) / 2 * r.width;
        const sy = r.top + (1 - tmpV.y) / 2 * r.height;
        const d = Math.hypot(sx - clientX, sy - clientY);
        if (d <= FUZZ_PX) cands.push({ t, d, wp });
      });
      cands.sort((a, b) => a.d - b.d);
      const hit = cands.find(c => unoccluded(c.t, c.wp));
      if (hit) out = { target: hit.t, point: hit.wp, fuzzy: true };
      else out = res.hit ? { occludedBy: res.hit.object } : null;
    }
    lastPickMs = performance.now() - t0;
    return out;
  }

  // ---- views: model() -> data, html(m) -> inner markup, bind(el) ---------
  const roomName = id => ((Home3DScene.ROOMS || {})[id] || {}).name || id;
  const dot = k => {
    const s = STATUS[k];
    return '<button class="tp-status ' + s[0] + (tipOpen ? ' tip-open' : '') + '" type="button" data-a="status" data-st="' + k +
      '" aria-label="Connection status: ' + esc(s[1]) + '"><i></i><span class="tp-tip" role="tooltip"><b>' + esc(s[1]) +
      '</b><small>' + esc(s[2]) + '</small></span></button>';
  };
  const climateMock = new Map();
  // Robot vacuum: the live reading from the client (or the ?debug=1 seam's
  // simulated one); with no HA configured, a sample that the buttons move.
  const vacuumMock = new Map();
  const vacuumSim = new Map();
  const vacuumReading = id => {
    if (vacuumSim.has(id)) return vacuumSim.get(id);
    const h = ha();
    if (h && h.getVacuum) return h.getVacuum(id);
    return null;
  };
  // Plant: the live reading from the client (or the ?debug=1 seam's); with
  // no HA configured, the page's sample (S.plantMock) or this module's own.
  const plantSim = new Map();
  const plantOrder = new Map([...plants.keys()].map((id, i) => [id, i]));
  const plantMock = new Map();
  const plantReading = id => {
    if (plantSim.has(id)) return plantSim.get(id);
    const h = ha();
    if (h && h.getPlant) return h.getPlant(id);
    return null;
  };

  // Furniture item cards: the raw state each row shows. With a client it is
  // the client's raw cache (or the ?debug=1 seam's simulated state), briefly
  // overridden after a send by what the command will make it (so a switch
  // does not flick back before HA's echo lands); with no HA configured, a
  // sample the controls move (src/item-cards.js mockItemState).
  const itemMock = new Map();
  const itemOptimistic = new Map();
  const OPTIMISTIC_MS = 3000;
  const itemMockMode = () => !ha() && sim.status === undefined;
  const levels = createLevelMemory();
  const restoreSample = (eid, r) => {
    if (!r || r.state !== 'on' || eid.indexOf('light.') !== 0 || typeof (r.attributes || {}).brightness === 'number') return r;
    const last = levels.last('item:' + eid);
    return { state: r.state, attributes: Object.assign({}, r.attributes, { brightness: Math.round((last != null ? last : 100) * 2.55) }) };
  };
  function itemRaw(eid, kind, row, i) {
    const opt = itemOptimistic.get(eid);
    if (opt && opt.until > Date.now()) return opt.raw;
    if (sim.raw.has(eid) || !itemMockMode()) return raw(eid);
    if (!itemMock.has(eid)) itemMock.set(eid, mockItemState(kind, row, i));
    return itemMock.get(eid);
  }
  // Send one item-row command (createItemSender: the writeBlocked / mock /
  // canSend gates, then an optimistic repaint).
  const itemSend = createItemSender({ writeBlocked, canSend, mockMode: itemMockMode, ha,
    // A sample light switched on with no level restores its last one (else full), as HA would.
    getRaw: eid => itemRaw(eid), setMock: (eid, r) => itemMock.set(eid, restoreSample(eid, r)),
    setOptimistic: (eid, r) => itemOptimistic.set(eid, { raw: r, until: Date.now() + OPTIMISTIC_MS }) });

  // The curtains card (curtainRoomGroup): the tapped curtain's room.
  const corniceBindings = (o.sensors && o.sensors.corniceLights) || {};
  const curtainGroup = t => curtainRoomGroup(t.id, o.house && o.house.curtains, bindings.curtains, corniceBindings);
  // A cornice light row: HA's raw state while live (its 'unavailable'
  // included), else the scene's cornice strip -- the demo, or a configured
  // HA that is offline (controls disabled; the last state shown). For a few
  // seconds after a send, what was sent (until HA's echo lands).
  const corniceOptimistic = new Map();
  function corniceRow(l, c) {
    const key = 'cornice:' + l.id;
    const r = corniceRowState({ opt: corniceOptimistic.get(l.id), now: Date.now(), last: levels.last(key), live: isLive(c),
      raw: raw(l.entities[0]), scene: typeof home.getCorniceLight === 'function' ? home.getCorniceLight(l.id) : null, haConfigured: !!ha() });
    if (r.seen != null) levels.see(key, true, r.seen);
    return r.row;
  }
  const sendCornice = createCorniceSender({ writeBlocked, canSend, ha,
    preview(id, st) {
      const now = typeof home.getCorniceLight === 'function' ? home.getCorniceLight(id) : null;
      // A switch-on carries no level: HA restores the last one. Show the last
      // one seen; with none, the scene a stand-in and the card "unknown".
      const key = 'cornice:' + id, last = levels.last(key);
      if (st.bri != null) levels.see(key, true, st.bri);
      const bri = st.bri != null ? st.bri : last;
      // Every curtain whose cornice is this light (one light shared by a curtain and a blind).
      const mine = corniceBindings[id] || [];
      const same = Object.keys(corniceBindings).filter(k => k === id || ((corniceBindings[k] || []).length &&
        corniceBindings[k].every(e => mine.indexOf(e) !== -1)));
      if (typeof home.setCorniceLight === 'function') same.forEach(k => home.setCorniceLight(k, { on: !!st.on, bri: bri != null ? bri : 100, color: now ? now.color : null }));
      if (ha()) corniceOptimistic.set(id, { on: !!st.on, bri: st.on ? (bri != null ? Math.round(bri) : null) : 100, until: Date.now() + OPTIMISTIC_MS });
    } });

  const VIEWS = {
    light: {
      model(t) {
        const st = (home.lightState[t.roomId] || {})[t.channel] || { on: false, bri: 100 };
        const c = conn();
        const r = raw(t.entities[0]);
        const na = lightUnavailable(c, r);
        const lc = ((Home3DScene.LIGHTS || {})[t.roomId] || {})[t.channel];
        const key = 'light:' + t.id;
        levels.see(key, !!st.on, st.bri);
        return { status: statusKey('light', c, na), na, haOff: haOfflineConn(c), on: !!st.on, bri: st.bri != null ? st.bri : 100,
          briUnknown: levels.unknown(key, !!st.on, st.bri),
          // A colour square only for an accent channel whose entity can take
          // a colour (supported_color_modes; unknown counts as yes).
          colorable: isColorChannel(t.channel) && supportsColor(r && r.attributes),
          color: isColorChannel(t.channel) ? swatchColor(st.color) : undefined,
          name: lightName(roomName(t.roomId), t.channel, lc && lc.name) };
      },
      html(m) { return popoverHtml.light(m, dot); },
      bind(t, el, ctl) {
        const s = () => (home.lightState[t.roomId] || {})[t.channel];
        const key = 'light:' + t.id;
        // Switched on with no level: the scene shows the last one seen (else
        // 100) while HA restores the real one; with none seen, the card says
        // the level is unknown until HA reports it.
        const restoreLevel = st => {
          const last = levels.last(key);
          st.bri = last != null ? last : 100;
          if (last == null && canSend()) levels.pend(key, st.bri, OPTIMISTIC_MS);
        };
        const sw = el.querySelector('[data-a=power]');
        if (sw) sw.addEventListener('click', () => {
          if (writeBlocked()) return;
          const st = s(); if (!st) return;
          st.on = !st.on;
          if (st.on && !st.bri) restoreLevel(st);
          // power: turn_on with no brightness -- HA restores the last level.
          home.updateLights(); o.sendLight(t.roomId, t.channel, st, 0, false, true); onChange(); ctl.refresh(true);
        });
        const r = el.querySelector('[data-a=bri]');
        if (r) {
          r.addEventListener('input', () => {
            if (writeBlocked()) return;
            const st = s(); if (!st) return;
            ctl.dragging = true;
            st.bri = +r.value; st.on = true; levels.clear(key);
            home.updateLights(); o.sendLight(t.roomId, t.channel, st, 200);
            r.style.setProperty('--p', fillPct(r)); r.classList.remove('off', 'unknown'); r.removeAttribute('aria-valuetext');
            const v = el.querySelector('[data-v]'); if (v) v.innerHTML = '<b>On</b> · ' + st.bri + '%';
            sw.classList.add('on'); sw.setAttribute('aria-checked', 'true');
            const ic = el.querySelector('.tp-ico'); if (ic) ic.outerHTML = ico(I.bulb, 'light-on');
          });
          // 'change' ends the drag at once and repaints the sidebar (the
          // value itself went out on 'input', debounced, as the sidebar's own
          // light slider does). pointerup PRECEDES 'change', so its rebuild is
          // deferred a tick (the sidebar's rule, see curtainSender's onRelease
          // in index.html) -- rebuilding synchronously replaced the input and
          // lost the 'change' listener.
          const finish = () => { if (ctl.dragging) { ctl.dragging = false; onChange(); ctl.refresh(); } };
          r.addEventListener('change', finish);
          const end = () => setTimeout(finish, 0);
          r.addEventListener('pointerup', end); r.addEventListener('pointercancel', end);
        }
        // Colour square (accent channels): the native picker. 'input' fires
        // as the user moves through the picker -- debounced through the same
        // sendLight path as the slider; the card is held still meanwhile
        // (ctl.dragging) so a rebuild never replaces the input under an open
        // picker. 'change' / blur end it.
        const cp = el.querySelector('[data-a=color]');
        if (cp) {
          // A pick on a light that was OFF when it began turns it on at its
          // LAST level: the colour goes out with no brightness (sendLight's
          // power flag), for the whole pick.
          let restoring = null;
          cp.addEventListener('input', () => {
            if (writeBlocked()) return;
            const st = s(); if (!st) return;
            ctl.dragging = true;
            if (restoring === null) restoring = !st.on;
            st.color = cp.value; st.on = true; if (!st.bri) restoreLevel(st);
            home.updateLights(); o.sendLight(t.roomId, t.channel, st, 200, true, restoring);
            if (r) r.classList.remove('off');
            const v = el.querySelector('[data-v]'); if (v) v.innerHTML = '<b>On</b>' + (levels.unknown(key, true, st.bri) ? '' : ' · ' + st.bri + '%');
            if (sw) { sw.classList.add('on'); sw.setAttribute('aria-checked', 'true'); }
          });
          const done = () => { restoring = null; if (ctl.dragging) { ctl.dragging = false; onChange(); ctl.refresh(); } };
          cp.addEventListener('change', done);
          cp.addEventListener('blur', done);
        }
      },
    },

    curtain: {
      model(t) {
        const c = conn();
        const g = curtainGroup(t);
        const rn = g.room ? roomName(g.room) : '';
        const covers = g.covers.map(cv => {
          const avail = S.curtainAvailable ? S.curtainAvailable(cv.id) : null;
          return { id: cv.id, label: rowLabelInRoom(sentenceCase(cv.name), rn), na: curtainUnavailable(c, avail),
            pct: Math.round((S.curtainPct ? S.curtainPct(cv.id) : home.getCurtainOpen(cv.id)) || 0) };
        });
        // Row labels do not repeat the room the title names. A light shared by
        // several of the room's curtains is the room's "Curtain light".
        const lights = g.lights.map(l => Object.assign({ id: l.id,
          label: l.shared && g.room ? 'Curtain light' : rowLabelInRoom(sentenceCase(l.name + ' light'), rn) }, corniceRow(l, c)));
        const coverNa = covers.some(r => r.na), lightNa = lights.some(r => r.na);
        return { status: coverNa ? statusKey('curtain', c, true) : statusKey('light', c, lightNa), haOff: haOfflineConn(c),
          name: curtainCardTitle(rn, curtainNames.get(t.id) || t.id), lights, covers };
      },
      html(m) { return popoverHtml.curtain(m, dot); },
      bind(t, el, ctl) {
        const g = curtainGroup(t);
        const sender = o.curtainSender;
        const rowOf = (c, id) => el.querySelector('[data-row="' + c + '"][data-c="' + id + '"]');
        // Covers: the sidebar's own drag sender, per curtain id -- one lock,
        // one dedupe, one debounce key, whichever surface moved it.
        el.querySelectorAll('[data-a=pos]').forEach(r => {
          const id = r.dataset.c;
          if (!g.covers.some(cv => cv.id === id)) return;
          const local = pct => { if (S.curtainLocal) S.curtainLocal(id, pct); else home.setCurtainOpen(id, pct, null); };
          r.addEventListener('input', () => {
            if (writeBlocked()) return;
            ctl.dragging = true;
            const pct = +r.value;
            local(pct);
            if (canSend() && sender) sender.input(id, pct);
            r.style.setProperty('--p', fillPct(r));
            const row = rowOf('cover', id), v = row && row.querySelector('[data-v]'); if (v) v.textContent = 'Open ' + pct + '%';
          });
          r.addEventListener('change', () => {
            if (canSend() && sender) sender.commit(id, +r.value);
            ctl.dragging = false; onChange(); ctl.refresh();
          });
          // Deferred a tick, as for the light: 'change' (commit) follows pointerup.
          const end = () => {
            if (sender) sender.end(id);
            setTimeout(() => { if (ctl.dragging) { ctl.dragging = false; ctl.refresh(); } }, 0);
          };
          r.addEventListener('pointerup', end); r.addEventListener('pointercancel', end);
        });
        const press = (cv, cmd) => {
          if (writeBlocked()) return;
          if (canSend() && sender) sender.press(cv.id, o.HAClient.coverOpenCloseCommand(cmd, cv.entities));
          else if (S.curtainLocal) S.curtainLocal(cv.id, cmd === 'open' ? 100 : 0);   // no HA configured (demo): preview on the model
          else home.setCurtainOpen(cv.id, cmd === 'open' ? 100 : 0, null);
          onChange(); ctl.refresh(true);
        };
        el.querySelectorAll('[data-a=open],[data-a=close]').forEach(b => {
          const cv = g.covers.find(x => x.id === b.dataset.c);
          if (cv) b.addEventListener('click', () => { if (!b.disabled) press(cv, b.dataset.a); });
        });
        // Cornice lights: the switch turns on at the last level; the slider sets one.
        const cur = id => (VIEWS.curtain.model(t).lights.find(x => x.id === id) || null);
        el.querySelectorAll('[data-a=cpower]').forEach(b => {
          const l = g.lights.find(x => x.id === b.dataset.c);
          if (l) b.addEventListener('click', () => {
            const st = cur(l.id); if (!st || st.na) return;
            sendCornice(l.id, l.entities, { on: !st.on }, true, 0); onChange(); ctl.refresh(true);
          });
        });
        el.querySelectorAll('[data-a=cbri]').forEach(r => {
          const l = g.lights.find(x => x.id === r.dataset.c);
          if (!l) return;
          r.addEventListener('input', () => {
            if (writeBlocked()) return;
            ctl.dragging = true; r.style.setProperty('--p', fillPct(r)); r.classList.remove('off', 'unknown'); r.removeAttribute('aria-valuetext');
            sendCornice(l.id, l.entities, { on: true, bri: +r.value }, false, 200);
            const row = rowOf('cornice', l.id);
            const sw = row && row.querySelector('[data-a=cpower]'); if (sw) { sw.classList.add('on'); sw.setAttribute('aria-checked', 'true'); }
            const v = row && row.querySelector('[data-v]'); if (v) v.textContent = 'On · ' + r.value + '%';
          });
          r.addEventListener('change', () => sendCornice(l.id, l.entities, { on: true, bri: +r.value }, false, 0));
          const done = () => setTimeout(() => { if (ctl.dragging) { ctl.dragging = false; onChange(); ctl.refresh(); } }, 0);
          r.addEventListener('change', done); r.addEventListener('pointerup', done); r.addEventListener('pointercancel', done);
        });
      },
    },

    climate: {
      model(t) {
        const c = conn();
        const eid = t.entities[0];
        let reading = S.climate ? S.climate(t.id) : null;
        const r = raw(eid);
        let mock = false, action;
        if (c == null && !reading) {
          // No HA configured (demo): sample values, clearly marked (red dot
          // tooltip). A configured HA that is merely offline gets no samples:
          // its card says "HA offline" with the controls disabled.
          if (!climateMock.has(t.id)) climateMock.set(t.id, { available: true, off: false, current: 19.5, target: 21, min: 7, max: 30, step: 0.5, action: 'heating' });
          reading = climateMock.get(t.id); mock = true; action = reading.action;
        } else {
          action = r && r.attributes ? r.attributes.hvac_action : undefined;
        }
        // The dot says whether HA is live; the BODY says what we last knew. A
        // last reading of 'unavailable' reads "Unavailable" even while offline,
        // never "Off" (parseClimate folds a null target into off).
        const readingNa = !mock && (!reading || !reading.available);
        const na = readingNa && (isLive(c) || !!reading);
        const off = !na && !!(reading && reading.off);
        return { status: statusKey('climate', c, readingNa && isLive(c), mock), na, mock, off, haOff: haOfflineConn(c),
          current: reading ? reading.current : null, target: reading ? reading.target : null,
          min: reading ? reading.min : 7, max: reading ? reading.max : 30, step: reading ? reading.step : 0.5,
          activity: climateActivity(action, off), name: climateCardName(t, roomName) };
      },
      html(m) { return popoverHtml.climate(m, dot); },
      bind(t, el, ctl) {
        const sender = o.climateSender;
        const m0 = () => VIEWS.climate.model(t);
        const show = v => {
          const e = el.querySelector('[data-t]'); if (e) e.textContent = v.toFixed(1) + '°';
          const r = el.querySelector('[data-a=set]'); if (r) { r.value = v; r.style.setProperty('--p', fillPct(r)); }
        };
        const apply = (v, how) => {
          if (writeBlocked()) return;
          const m = m0();
          v = Math.max(m.min, Math.min(m.max, Math.round(v / m.step) * m.step));
          if (m.mock) { climateMock.get(t.id).target = v; show(v); return; }
          if (canSend() && sender) {
            if (how === 'input') sender.input(t.id, v);
            else if (how === 'commit') sender.commit(t.id, v);
            else sender.press(t.id, o.HAClient.climateTargetCommand(v, t.entities[0], S.climate ? S.climate(t.id) : null));
          }
          show(v);   // optimistic; HA's echo repaints via the reading
        };
        const r = el.querySelector('[data-a=set]');
        if (r) {
          r.addEventListener('input', () => { ctl.dragging = true; apply(+r.value, 'input'); });
          r.addEventListener('change', () => { apply(+r.value, 'commit'); ctl.dragging = false; onChange(); });
          const end = () => { if (sender) sender.end(t.id); ctl.dragging = false; };
          r.addEventListener('pointerup', end); r.addEventListener('pointercancel', end);
        }
        const step = d => { const m = m0(); const cur = r ? +r.value : m.target; apply(cur + d * m.step, 'press'); onChange(); };
        const dn = el.querySelector('[data-a=down]'), up = el.querySelector('[data-a=up]');
        if (dn) dn.addEventListener('click', () => step(-1));
        if (up) up.addEventListener('click', () => step(1));
      },
    },

    vacuum: {
      model(t) {
        const c = conn();
        let reading = vacuumReading(t.id), mock = false;
        if (c == null && !reading) {
          // The page may share one sample robot with its sidebar (S.vacuumMock).
          if (S.vacuumMock) reading = S.vacuumMock(t.id);
          else {
            if (!vacuumMock.has(t.id)) vacuumMock.set(t.id, MOCK_VACUUM_READINGS.docked);
            reading = vacuumMock.get(t.id);
          }
          mock = true;
        }
        const na = !mock && (!reading || !reading.available);
        const b = t.binding || vacuums.get(t.id) || { segments: [] };
        return { status: mock ? 'offlineSample' : statusKey('vacuum', c, na && isLive(c), false), mock, haOff: haOfflineConn(c), reading,
          actions: vacuumActions(reading),
          rooms: b.segments.map(sg => ({ roomId: sg.roomId, name: roomName(sg.roomId) })),
          name: t.label || furnitureLabels.get(t.id) || 'Robot vacuum' };
      },
      html(m) { return popoverHtml.vacuum(m, dot); },
      bind(t, el, ctl) {
        const b = t.binding || vacuums.get(t.id);
        const send = (action, roomId) => {
          if (writeBlocked() || !b) return;
          const m = VIEWS.vacuum.model(t);
          if (m.mock) {
            // No HA configured: the sample robot moves, nothing is sent.
            const next = mockVacuumAfter(action, m.reading);
            if (next) { if (S.setVacuumMock) S.setVacuumMock(t.id, next); else vacuumMock.set(t.id, next); }
          } else if (canSend()) {
            const seg = roomId != null ? b.segments.find(s => s.roomId === roomId) : null;
            const cmd = action === 'room'
              ? (seg ? vacuumSegmentCommand(b.entity, seg.segment, m.reading, b.segmentService) : null)
              : vacuumCommand(action, b.entity, m.reading);
            if (cmd) ha().callService(cmd.domain, cmd.service, cmd.data, cmd.target);
          }
          onChange(); ctl.refresh(true);
        };
        el.querySelectorAll('[data-a=start],[data-a=pause],[data-a=dock]').forEach(btn =>
          btn.addEventListener('click', () => { if (!btn.disabled) send(btn.dataset.a); }));
        el.querySelectorAll('[data-a=room]').forEach(btn =>
          btn.addEventListener('click', () => { if (!btn.disabled) send('room', btn.dataset.room); }));
      },
    },

    plant: {
      model(t) {
        const c = conn();
        let reading = plantReading(t.id), mock = false;
        if (c == null && !reading) {
          if (S.plantMock) reading = S.plantMock(t.id);
          else {
            if (!plantMock.has(t.id)) plantMock.set(t.id, mockPlantReading(plantOrder.get(t.id) || 0, plants.get(t.id)));
            reading = plantMock.get(t.id);
          }
          mock = true;
        }
        const b = t.binding || plants.get(t.id) || {};
        const na = !mock && (!reading || !reading.available);
        return { status: mock ? 'offlinePlant' : statusKey('plant', c, na && isLive(c), false), mock, haOff: haOfflineConn(c),
          reading, ago: reading ? agoText(reading.updated) : '',
          name: t.label || b.name || furnitureLabels.get(t.id) || 'Plant' };
      },
      html(m) { return popoverHtml.plant(m, dot); },
      bind() {},   // read-only: nothing to wire, nothing to send
    },

    item: {
      model(t) {
        const c = conn();
        const card = t.card;
        const base = card.index * 3;
        const media = card.media.map((row, i) => {
          const r = itemRaw(row.entity, 'media', row, base + i);
          return Object.assign({ entity: row.entity, role: row.role, label: rowLabel(row, r) }, mediaRowModel(r));
        });
        const lights = card.lights.map((row, i) => {
          const r = itemRaw(row.entity, 'light', row, base + i);
          const a = (r && r.attributes) || {};
          // A colour square only for a light that SAYS it takes colour: an
          // item row has no channel to fall back on (supportsColor treats
          // "no modes reported" as yes, for the ambient channel's sake).
          const colorable = Array.isArray(a.supported_color_modes) && supportsColor(a);
          const key = 'item:' + row.entity;
          const opt = itemOptimistic.get(row.entity);
          if (!(opt && opt.until > Date.now()) && r && r.state === 'on' && typeof a.brightness === 'number') levels.see(key, true, Math.round(a.brightness / 2.55));
          return Object.assign({ entity: row.entity, label: rowLabel(row, r) }, lightRowModel(r, colorable, colorFromAttributes(a), levels.last(key)));
        });
        const switches = (card.switches || []).map((row, i) => {
          const r = itemRaw(row.entity, 'switch', row, base + i);
          let pr = row.power ? itemRaw(row.power, 'power', row, base + i) : null;
          // The demo's sample socket draws nothing while it is off.
          if (pr && itemMockMode() && !sim.raw.has(row.power) && r && r.state === 'off') pr = { state: '0', attributes: pr.attributes };
          return Object.assign({ entity: row.entity, label: rowLabel(row, r) }, switchRowModel(r, pr));
        });
        const readings = card.readings.map((row, i) => {
          const r = itemRaw(row.entity, 'reading', row, base + i);
          const hr = row.humidity ? itemRaw(row.humidity, 'humidity', row, base + i) : null;
          return Object.assign({ entity: row.entity, label: rowLabel(row, r) }, readingRowModel(r, hr));
        });
        // A camera row carries no URL and no token (cameraRowModel): the
        // token rotates, and the model is the card's render signature.
        const cameras = (card.cameras || []).map((row, i) => {
          const r = itemRaw(row.entity, 'camera', row, base + i);
          const cm = cameraRowModel(r);
          return Object.assign({ entity: row.entity, label: rowLabel(row, r) }, cm,
            { canLive: cm.canLive && !itemMockMode() && c === 'connected' });
        });
        const anyNa = media.some(r => r.na) || lights.some(r => r.na) || switches.some(r => r.na) || readings.some(r => r.na) ||
          cameras.some(r => r.na);
        // The first row never just repeats the title ("TV" over "TV").
        const head = itemCardHead(card, { media, lights, switches, readings, cameras }, furnitureLabels.get(t.itemId), t.itemId);
        return { status: itemMockMode() ? 'offlineItem' : statusKey('item', c, anyNa && isLive(c), false), haOff: haOfflineConn(c),
          name: head.name, icon: head.icon, media, lights, switches, readings, cameras };
      },
      html(m) { return popoverHtml.item(m, dot); },
      bind(t, el, ctl) {
        const card = t.card;
        const at = (a, cb) => el.querySelectorAll('[data-a=' + a + ']').forEach(c => cb(c, +c.dataset.i));
        const hold = c => {
          // A drag / an open picker holds the card still: a rebuild would
          // replace the control under the pointer (the light card's rule).
          c.addEventListener('pointerdown', () => { ctl.dragging = true; });
          const done = () => setTimeout(() => { if (ctl.dragging) { ctl.dragging = false; onChange(); ctl.refresh(); } }, 0);
          c.addEventListener('change', done); c.addEventListener('blur', done);
          c.addEventListener('pointerup', done); c.addEventListener('pointercancel', done);
        };
        const model = () => VIEWS.item.model(t);
        at('mpower', (b, i) => b.addEventListener('click', () => {
          const r = model().media[i]; if (!r || r.na) return;
          itemSend(mediaPowerCommand(card.media[i].entity, !r.on), 'power', 0); onChange(); ctl.refresh(true);
        }));
        at('mvol', (r, i) => {
          r.addEventListener('input', () => {
            ctl.dragging = true; r.style.setProperty('--p', fillPct(r));
            if (r.classList.contains('unknown')) { r.classList.remove('unknown'); r.removeAttribute('aria-valuetext'); }
            itemSend(mediaVolumeCommand(card.media[i].entity, +r.value), 'vol', 200);
          });
          r.addEventListener('change', () => itemSend(mediaVolumeCommand(card.media[i].entity, +r.value), 'vol', 0));
          hold(r);
        });
        at('msrc', (sel, i) => {
          sel.addEventListener('change', () => { if (sel.value) itemSend(mediaSourceCommand(card.media[i].entity, sel.value), 'src', 0); });
          hold(sel); sel.addEventListener('focus', () => { ctl.dragging = true; });
        });
        at('mmode', (sel, i) => {
          sel.addEventListener('change', () => { if (sel.value) itemSend(mediaSoundModeCommand(card.media[i].entity, sel.value), 'mode', 0); });
          hold(sel); sel.addEventListener('focus', () => { ctl.dragging = true; });
        });
        at('lpower', (b, i) => b.addEventListener('click', () => {
          const r = model().lights[i]; if (!r || r.na) return;
          // No brightness on a switch-on: HA restores the light's last level.
          itemSend(lightRowToggleCommand(card.lights[i].entity, r), 'light', 0); onChange(); ctl.refresh(true);
        }));
        at('lbri', (r, i) => {
          r.addEventListener('input', () => {
            ctl.dragging = true; r.style.setProperty('--p', fillPct(r)); r.classList.remove('off', 'unknown'); r.removeAttribute('aria-valuetext');
            itemSend(lightRowCommand(card.lights[i].entity, { on: true, bri: +r.value }), 'light', 200);
            const sw = el.querySelector('[data-a=lpower][data-i="' + i + '"]');
            if (sw) { sw.classList.add('on'); sw.setAttribute('aria-checked', 'true'); }
          });
          r.addEventListener('change', () => itemSend(lightRowCommand(card.lights[i].entity, { on: true, bri: +r.value }), 'light', 0));
          hold(r);
        });
        at('clive', (b, i) => b.addEventListener('click', () => {
          const cam = pop && pop.cams && pop.cams.get(i);
          if (!cam || b.disabled) return;
          const on = cam.feed.setLive(!cam.feed.state().live);
          b.setAttribute('aria-pressed', String(on));
        }));
        at('spower', (b, i) => b.addEventListener('click', () => {
          const r = model().switches[i]; if (!r || r.na) return;
          itemSend(switchCommand(card.switches[i].entity, !r.on), 'switch', 0); onChange(); ctl.refresh(true);
        }));
        at('lcolor', (cp, i) => {
          // A pick on a light that was OFF when it began: no brightness (its last level), for the whole pick.
          let restoring = null;
          cp.addEventListener('input', () => {
            ctl.dragging = true;
            const cur = model().lights[i] || {};
            if (restoring === null) restoring = !cur.on;
            itemSend(lightColorCommand(card.lights[i].entity, cur, cp.value, restoring), 'light', 200);
          });
          const reset = () => { restoring = null; };
          cp.addEventListener('change', reset); cp.addEventListener('blur', reset);
          hold(cp);
        });
      },
    },

    clock: {
      model(t) {
        // Never the raw furniture label (an authoring note in a real house).
        return Object.assign({ name: clockCardName(t, roomName) }, clockText(new Date()));
      },
      html(m) { return popoverHtml.clock(m); },
      bind() {},   // read-only
      // The time is patched in place each tick; only a new title rebuilds.
      sig: clockTick.sig,
      patch: clockTick.patch,
    },

    door: {
      chip: true,
      model(t) {
        const c = conn();
        const state = doorState(S.doorStatus ? S.doorStatus(t.id) : null, c);
        return { status: statusKey('door', c, state === 'na'), state, name: doorNames.get(t.id) || t.id };
      },
      html(m) {
        const map = { open: [I.doorOpen, 'd-open', 'Open'], closed: [I.doorClosed, 'd-closed', 'Closed'], na: [I.doorClosed, 'dim', 'Unavailable'],
          unknown: [I.doorClosed, 'dim', 'Unknown'] }[m.state];
        return '<div class="tp-head">' + ico(map[0], map[1]) + nameHtml(m.name) + '<span class="sep">·</span>' +
          '<span class="st ' + m.state + '">' + map[2] + '</span>' + dot(m.status) + '</div>';
      },
      bind() {},
    },
  };

  // ---- camera rows ------------------------------------------------------
  // One persistent <img> and refresh loop (createCameraFeed) per camera row
  // of the OPEN card, kept on `pop.cams` and re-attached to the card's
  // [data-cam] box after every rebuild, so a rebuild never reloads the
  // picture. Started when the card opens, stopped (image cleared, timers
  // cancelled) when it closes, paused while the tab is hidden.
  const CAM_W = 320, CAM_H = 240;
  // The demo camera (no HA configured): a drawn frame with the time on it.
  function demoCameraFrame(label, when) {
    const cv = document.createElement('canvas');
    cv.width = CAM_W; cv.height = CAM_H;
    const g = cv.getContext('2d');
    if (!g) return null;
    const grad = g.createLinearGradient(0, 0, 0, CAM_H);
    grad.addColorStop(0, '#2b2f36'); grad.addColorStop(1, '#14161a');
    g.fillStyle = grad; g.fillRect(0, 0, CAM_W, CAM_H);
    g.strokeStyle = '#8a8f98'; g.lineWidth = 3;
    g.strokeRect(70, 70, 180, 120);
    for (let x = 90; x < 250; x += 20) { g.beginPath(); g.moveTo(x, 70); g.lineTo(x, 190); g.stroke(); }
    const s = when.getSeconds();
    g.fillStyle = '#c9a26b'; g.beginPath(); g.ellipse(160 + 30 * Math.sin(s / 3), 165, 34, 16, 0, 0, Math.PI * 2); g.fill();
    g.fillStyle = 'rgba(0,0,0,0.55)'; g.fillRect(0, CAM_H - 26, CAM_W, 26);
    g.fillStyle = '#fff'; g.font = '14px system-ui, sans-serif';
    g.fillText((label || 'Demo camera') + '  ' + when.toLocaleTimeString(), 8, CAM_H - 8);
    return cv.toDataURL('image/jpeg', 0.7);
  }
  function makeCamera(row) {
    const img = document.createElement('img');
    img.alt = row.label || 'Camera';
    img.draggable = false;
    img.style.visibility = 'hidden';
    const eid = row.entity;
    const base = () => (ha() && ha().activeUrl) || '';
    const feed = createCameraFeed({
      refreshMs: row.refreshMs,
      snapshotUrl: bust => (itemMockMode() ? demoCameraFrame(row.label, new Date(bust)) : ha() ? cameraSnapshotUrl(base(), raw(eid), bust) : null),
      streamUrl: () => (!itemMockMode() && conn() === 'connected' ? cameraStreamUrl(base(), eid, raw(eid)) : null),
      probe(src, ok, fail) {
        const im = new Image();
        im.onload = ok; im.onerror = fail; im.src = src;
        return () => { im.onload = im.onerror = null; im.src = ''; };   // abort: ends the request
      },
      show(src) { img.src = src || ''; img.style.visibility = src ? '' : 'hidden'; },
      stale(s) { img.classList.toggle('stale', !!s); },
      schedule: (fn, ms) => setTimeout(fn, ms),
      cancel: h => clearTimeout(h),
      now: () => Date.now(),
    });
    // Only a Live stream loads into the visible <img> directly; its failure
    // drops back to snapshots (backing off). A snapshot never errors here: it
    // is shown only after it loaded off-screen.
    img.addEventListener('error', () => feed.streamFailed());
    feed.hidden(document.hidden);
    return { img, feed };
  }
  function attachCameras(p) {
    const cams = p.target.kind === 'item' && p.target.card ? (p.target.card.cameras || []) : [];
    if (!cams.length) return;
    if (!p.cams) p.cams = new Map();
    cams.forEach((row, i) => {
      const box = p.el.querySelector('[data-cam="' + i + '"]');
      if (!box) return;
      let cam = p.cams.get(i);
      if (!cam) { cam = makeCamera(row); p.cams.set(i, cam); cam.feed.start(); }
      box.appendChild(cam.img);
      // No Live toggle rendered (HA not connected, or no token): Live ends,
      // and is not resumed on its own when the toggle comes back.
      const b = p.el.querySelector('[data-a=clive][data-i="' + i + '"]');
      cam.feed.allowLive(!!b);
      if (b) b.setAttribute('aria-pressed', String(cam.feed.state().live));
    });
  }
  function stopCameras(p) {
    if (!p || !p.cams) return;
    p.cams.forEach(cam => cam.feed.stop());
    p.cams = null;
  }
  const onVisibility = () => { if (pop && pop.cams) pop.cams.forEach(cam => cam.feed.hidden(document.hidden)); };
  document.addEventListener('visibilitychange', onVisibility);

  // ---- popover lifecycle ------------------------------------------------
  let pop = null;          // { el, target, x, y, camSnap, sig, ctl, timer, returnTo }
  let tipOpen = false, tipTimer = 0;
  /** @param restoreFocus  put keyboard focus back where it was before open
   *  (Escape). A tap-away close leaves focus wherever the tap put it. */
  function close(restoreFocus) {
    if (!pop) return;
    const p = pop;
    clearInterval(p.timer); clearTimeout(tipTimer); tipOpen = false;
    stopCameras(p);   // no camera request after the card closes
    if (p.marq) { p.marq.cancel(); p.marq = null; }
    const hadFocus = p.el.contains(document.activeElement);
    if (p.el.parentNode) p.el.parentNode.removeChild(p.el);
    pop = null;
    if (restoreFocus === true && hadFocus) {
      const back = p.returnTo;
      if (back && back !== document.body && back.isConnected && typeof back.focus === 'function') back.focus({ preventScroll: true });
      else if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    }
  }
  // Focusable controls inside the card, in DOM order (disabled ones skipped).
  const focusables = el => Array.from(el.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled])'));
  // The control keyboard focus lands on at open: the first real control, not
  // the status dot (which leads the header); the card itself for the
  // read-only door chip.
  function focusFirst(el) {
    const f = focusables(el).filter(c => c.dataset.a !== 'status');
    (f[0] || el).focus({ preventScroll: true });
  }

  // The room sidebar (#panel) is an opaque layer over the right of the
  // canvas. Its rect when it is actually on screen, else null (closed, it is
  // translated off the right edge).
  function sidebarRect() {
    const sb = o.sidebar;
    if (!sb || !sb.getBoundingClientRect) return null;
    // Closing: it is sliding off (0.25 s transition) and about to be gone --
    // the card must not dodge a panel that is leaving.
    if (sb.classList && !sb.classList.contains('open')) return null;
    const r = sb.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0 || r.left >= window.innerWidth || r.right <= 0) return null;
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
  }
  function camSnapshot() { const cam = home.getCamera(); cam.updateMatrixWorld(); return cam.matrixWorld.elements.slice(); }
  function camMoved(snap) {
    const e = home.getCamera().matrixWorld.elements;
    for (let i = 0; i < 16; i++) if (Math.abs(e[i] - snap[i]) > 1e-6) return true;
    return false;
  }

  function position() {
    const el = pop.el;
    const r = canvasRect();
    // The visible scene: the canvas within the viewport, minus the sidebar
    // when it is open. If the card does not fit the leftover space it is
    // clamped into it, and z-index 60 (> the panel's 50) keeps it on top.
    const bounds = boundsExcluding({
      left: Math.max(0, r.left), top: Math.max(0, r.top),
      right: Math.min(window.innerWidth, r.right), bottom: Math.min(window.innerHeight, r.bottom),
    }, sidebarRect(), pop.x, pop.y);
    const p = placePopover(pop.x, pop.y, el.offsetWidth, el.offsetHeight, bounds);
    el.style.left = p.left + 'px';
    el.style.top = p.top + 'px';
    el.dataset.placement = p.placement;
    const a = el.querySelector('.tp-arrow');
    if (a) {
      a.className = 'tp-arrow' + (p.arrow ? ' ' + p.arrow.side : '');
      a.style.display = p.arrow ? '' : 'none';
      a.style.left = a.style.top = '';
      if (p.arrow && (p.arrow.side === 'top' || p.arrow.side === 'bottom')) a.style.left = p.arrow.offset + 'px';
      else if (p.arrow) a.style.top = p.arrow.offset + 'px';
    }
  }

  function render(force) {
    if (!pop) return;
    const v = VIEWS[pop.target.kind];
    const m = v.model(pop.target);
    const next = repaintAction(v, m, pop.sig, tipOpen, force, pop.ctl.dragging);
    if (next.action === 'patch') v.patch(pop.el, m);
    if (next.action !== 'rebuild') return;
    pop.sig = next.sig;
    // A rebuild replaces every control: keep keyboard focus on the same one.
    const ae = document.activeElement;
    const refocus = pop.el.contains(ae) ? (ae === pop.el ? '' : (ae.dataset && ae.dataset.a) || '') : null;
    const refocusI = refocus && ae.dataset && ae.dataset.i != null ? ae.dataset.i : null;
    pop.el.innerHTML = v.html(m) + '<span class="tp-arrow"></span>';
    pop.el.setAttribute('aria-label', m.name);
    pop.el.querySelectorAll('.tp-range').forEach(r => r.style.setProperty('--p', fillPct(r)));
    v.bind(pop.target, pop.el, pop.ctl);
    attachCameras(pop);   // the SAME <img> elements, never reloaded by a rebuild
    fitTitle(pop);
    position();
    if (refocus !== null) {
      const c = refocus && pop.el.querySelector('[data-a="' + refocus + '"]' + (refocusI != null ? '[data-i="' + refocusI + '"]' : ''));
      (c && !c.disabled ? c : pop.el).focus({ preventScroll: true });
    }
  }

  // ---- title marquee ------------------------------------------------------
  // A name too long for the card slides (marqueePlan): it never changes the
  // card's width and never ellipsises. Paused while the pointer is over the
  // card or a slider is held; reduced motion wraps it to two lines instead.
  const reducedMotion = () => typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  function syncMarq(p) {
    if (!p || !p.marq) return;
    if (p.hover || p.hold || p.ctl.dragging) p.marq.pause(); else p.marq.play();
  }
  function fitTitle(p) {
    if (p.marq) { p.marq.cancel(); p.marq = null; }
    const box = p.el.querySelector('.tp-name');
    const inner = box && box.querySelector('.tp-name-in');
    if (!inner) return;
    box.classList.remove('marq', 'wrap');
    const plan = marqueePlan(inner.scrollWidth, box.clientWidth, { reducedMotion: reducedMotion() });
    box.dataset.marquee = plan.mode;
    if (plan.mode === 'wrap') { box.classList.add('wrap'); return; }
    if (plan.mode !== 'scroll' || typeof inner.animate !== 'function') return;
    box.classList.add('marq');
    const at = (px, offset, easing) => ({ transform: 'translateX(' + px + 'px)', offset, easing: easing || 'linear' });
    const d = -plan.distance, f = plan.offsets;
    p.marq = inner.animate([at(0, f[0]), at(0, f[1], 'ease-in-out'), at(d, f[2]), at(d, f[3], 'ease-in-out'), at(0, f[4])],
      { duration: plan.duration, iterations: Infinity });
    syncMarq(p);
  }

  function open(target, x, y) {
    const returnTo = pop ? pop.returnTo : document.activeElement;
    close();
    const el = document.createElement('div');
    el.className = 'tp-pop' + (VIEWS[target.kind].chip ? ' chip' : '');
    el.dataset.kind = target.kind;
    el.dataset.target = target.id;
    el.setAttribute('role', 'dialog');
    el.tabIndex = -1;   // focus target for the door chip, and after a rebuild
    document.body.appendChild(el);
    pop = { el, target, x, y, camSnap: camSnapshot(), sig: null, ctl: { dragging: false }, returnTo };
    pop.ctl.refresh = f => render(!!f);
    const p0 = pop;
    // Mouse hover pauses the title marquee; so does holding a slider (the
    // window-level pointerup below releases it, wherever the drag ends).
    el.addEventListener('pointerenter', e => { if (e.pointerType === 'mouse') { p0.hover = true; syncMarq(p0); } });
    el.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse') { p0.hover = false; syncMarq(p0); } });
    el.addEventListener('pointerdown', e => {
      if (e.target.closest && e.target.closest('.tp-range, .tp-color')) { p0.hold = true; syncMarq(p0); }
    });
    // Status dot: tap toggles its tooltip (touch; auto-hides after 4 s),
    // mouse gets it on hover through CSS. Delegated, so it survives rebuilds.
    el.addEventListener('click', e => {
      const st = e.target.closest && e.target.closest('[data-a=status]');
      if (st) {
        tipOpen = !tipOpen; st.classList.toggle('tip-open', tipOpen);
        clearTimeout(tipTimer);
        if (tipOpen) tipTimer = setTimeout(() => { tipOpen = false; if (pop) { const d = pop.el.querySelector('[data-a=status]'); if (d) d.classList.remove('tip-open'); } }, 4000);
        return;
      }
      if (tipOpen) { tipOpen = false; const d = el.querySelector('[data-a=status]'); if (d) d.classList.remove('tip-open'); }
    });
    // Tab cycles within the card (it is appended at the end of <body>, so
    // tabbing off its last control would leave for the browser chrome);
    // Escape (onKey) closes it and returns focus.
    el.classList.add('tp-ptr');
    el.addEventListener('keydown', e => {
      el.classList.remove('tp-ptr');   // keyboard in use: show focus rings
      if (e.key !== 'Tab') return;
      const f = focusables(el);
      if (!f.length) { e.preventDefault(); return; }
      const i = f.indexOf(document.activeElement);
      if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && (i === -1 || i === f.length - 1)) { e.preventDefault(); f[0].focus(); }
    });
    render(true);
    focusFirst(el);
    // Most live changes repaint the scene (-> onRender below); a reading that
    // moves nothing requests no frame, so a slow DOM-only tick covers it.
    pop.timer = setInterval(() => { try { render(false); } catch (e) { /* ignore */ } }, 1000);
    home.requestRender();
  }

  // ---- input --------------------------------------------------------------
  const pointers = new Set();
  let downX = 0, downY = 0, multi = false;
  const inCanvas = e => container.contains(e.target);
  const onPointerDown = e => {
    if (pop && !pop.el.contains(e.target)) close();
    if (!inCanvas(e)) return;
    pointers.add(e.pointerId);
    if (pointers.size === 1) { downX = e.clientX; downY = e.clientY; multi = false; }
    else multi = true;
  };
  const onPointerEnd = e => {
    pointers.delete(e.pointerId);
    if (pop && pop.hold) { pop.hold = false; setTimeout(() => syncMarq(pop), 0); }
  };
  const onClick = e => {
    if (!inCanvas(e)) return;
    if (multi) return;
    if (Math.abs(e.clientX - downX) > TAP_SLOP_PX || Math.abs(e.clientY - downY) > TAP_SLOP_PX) return;
    const res = pickAt(e.clientX, e.clientY);
    if (res && res.target) {
      e.stopPropagation();   // this tap is ours: no room selection underneath
      // Tell the page first (an unpinned sidebar closes on an object tap),
      // THEN open. The sidebar-toggle rule below ("opening or closing the
      // sidebar closes the card") must not kill the card this same tap is
      // opening, so the class flip the hook just made is absorbed here.
      if (typeof o.onObjectTap === 'function') {
        try { o.onObjectTap(res.target); } catch (err) { /* the page's hook must not cost the tap */ }
        syncSidebarOpen();
      }
      open(res.target, e.clientX, e.clientY);
    }
  };
  const onWheel = e => { if (pop && inCanvas(e)) close(); };
  const onKey = e => { if (e.key === 'Escape' && pop) close(true); };
  const onResize = () => close();

  window.addEventListener('pointerdown', onPointerDown, true);
  window.addEventListener('pointerup', onPointerEnd, true);
  window.addEventListener('pointercancel', onPointerEnd, true);
  window.addEventListener('click', onClick, true);
  window.addEventListener('wheel', onWheel, { capture: true, passive: true });
  window.addEventListener('keydown', onKey);
  window.addEventListener('resize', onResize);

  // Opening or closing the sidebar moves the space the card was placed in:
  // close it rather than leave it over (or under) the panel.
  let sidebarOpen = o.sidebar && o.sidebar.classList ? o.sidebar.classList.contains('open') : false;
  const sidebarObs = o.sidebar && typeof MutationObserver === 'function' ? new MutationObserver(() => {
    const now = o.sidebar.classList.contains('open');
    if (now !== sidebarOpen) { sidebarOpen = now; close(); }
  }) : null;
  if (sidebarObs) sidebarObs.observe(o.sidebar, { attributes: true, attributeFilter: ['class'] });
  function syncSidebarOpen() {
    if (sidebarObs) sidebarObs.takeRecords();   // drop the pending mutation: it is accounted for
    if (o.sidebar && o.sidebar.classList) sidebarOpen = o.sidebar.classList.contains('open');
  }

  // Every frame the scene draws (a light change requests one), note each
  // room light's level while it is on, so a light switched on later from a
  // card shows the level it will come back at (createLevelMemory).
  const noteLevels = () => {
    const ls = home.lightState || {};
    Object.keys(ls).forEach(rid => Object.keys(ls[rid] || {}).forEach(ch => {
      const st = ls[rid][ch]; if (st) levels.see('light:' + rid + '/' + ch, !!st.on, st.bri);
    }));
  };
  const unsub = home.onRender(() => {
    try { noteLevels(); } catch (e) { /* never break the render loop */ }
    if (!pop) return;
    if (camMoved(pop.camSnap)) { close(); return; }
    try { render(false); } catch (e) { /* never break the render loop */ }
  });

  const api = {
    pickAt(x, y) {
      const r = pickAt(x, y);
      if (!r) return null;
      if (r.target) return { kind: r.target.kind, id: r.target.id, fuzzy: !!r.fuzzy };
      const ob = r.occludedBy;
      let size = null;
      if (ob && ob.geometry) {
        ob.geometry.computeBoundingBox();
        const s = ob.geometry.boundingBox.getSize(new THREE.Vector3());
        size = [+s.x.toFixed(2), +s.y.toFixed(2), +s.z.toFixed(2)];
      }
      return { occludedBy: (ob && (ob.name || (ob.parent && ob.parent.name) || ob.geometry && ob.geometry.type)) || 'mesh',
        occluderSize: size, occluderOpacity: ob ? materialOpacity(ob.material) : null };
    },
    /** Open without a tap (debug seam; the only route to climate on main). */
    openAt(kind, id, x, y, extra) {
      let ents;
      if (kind === 'light') ents = (bindings.lights[id.split('/')[0]] || {})[id.split('/')[1]];
      else if (kind === 'climate') ents = typeof climateBinding[id] === 'string' ? [climateBinding[id]] : null;
      else if (kind === 'vacuum') ents = vacuums.has(id) ? [vacuums.get(id).entity] : null;
      else if (kind === 'plant') ents = plants.has(id) ? deviceTarget(id, null, plants).entities : null;
      else if (kind === 'item' || kind === 'clock') {
        // extra: { card: <the card's index in the binding's list> } picks a
        // region card (the tap route picks it by where the tap landed).
        let t = null;
        if (kind === 'item' && itemBindings.has(id)) {
          const cards = itemBindings.get(id);
          const card = cards.find(c => c.index === ((extra && extra.card) || 0)) || cards[0];
          t = { kind: 'item', id: cards.length > 1 ? id + '#' + card.index : id, itemId: id, card, entities: cardEntities(card) };
        } else if (kind === 'clock') {
          t = { kind: 'clock', id, itemId: id, entities: [], room: furnitureRooms.get(id) || null };
          const title = bindingTitle(rawItems, id);
          if (title) t.label = title;
        }
        if (!t) return false;
        open(t, x, y);
        return true;
      }
      else ents = (bindings[kind + 's'] || {})[id];
      if (!ents) return false;
      const t = Object.assign({ kind, id, entities: ents }, extra || {});
      if (kind === 'light') { t.roomId = id.split('/')[0]; t.channel = id.split('/')[1]; }
      if (kind === 'vacuum') t.binding = vacuums.get(id);
      if (kind === 'plant') t.binding = plants.get(id);
      open(t, x, y);
      return true;
    },
    /** SIMULATE a connection status / raw entity states (debug only). */
    simulate(spec) {
      if (spec && 'status' in spec) sim.status = spec.status;
      if (spec && spec.raw) Object.keys(spec.raw).forEach(k => sim.raw.set(k, spec.raw[k]));
      // vacuum: { <itemId>: reading } -- a parseVacuum-shaped reading.
      if (spec && spec.vacuum) Object.keys(spec.vacuum).forEach(k => vacuumSim.set(k, spec.vacuum[k]));
      // plant: { <itemId>: reading } -- a parsePlant-shaped reading.
      if (spec && spec.plant) Object.keys(spec.plant).forEach(k => plantSim.set(k, spec.plant[k]));
      if (spec && spec.reset) { sim.status = undefined; sim.raw.clear(); vacuumSim.clear(); plantSim.clear(); }
      render(false);
    },
    /** Repaint an open card from the shared state now (never under a drag). */
    refresh: () => render(false),
    close: () => close(),
    isOpen: () => !!pop,
    current: () => (pop ? { kind: pop.target.kind, id: pop.target.id, entities: pop.target.entities.slice(), placement: pop.el.dataset.placement,
      status: (pop.el.querySelector('[data-a=status]') || {}).dataset?.st, rect: pop.el.getBoundingClientRect().toJSON() } : null),
    lastPickMs: () => lastPickMs,
    lightTargets() {
      const r = canvasRect(); const cam = home.getCamera();
      return lightTargets.map(t => {
        t.object.getWorldPosition(tmpV); tmpV.project(cam);
        return { id: t.id, x: Math.round(r.left + (tmpV.x + 1) / 2 * r.width), y: Math.round(r.top + (1 - tmpV.y) / 2 * r.height) };
      });
    },
    /** Idempotent: index.html registers it with home.onDispose. */
    dispose() {
      if (disposed) return;
      disposed = true;
      close(); unsub();
      if (sidebarObs) sidebarObs.disconnect();
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('pointerup', onPointerEnd, true);
      window.removeEventListener('pointercancel', onPointerEnd, true);
      window.removeEventListener('click', onClick, true);
      window.removeEventListener('wheel', onWheel, { capture: true });
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onResize);
      document.removeEventListener('visibilitychange', onVisibility);
      if (styleEl.parentNode) styleEl.parentNode.removeChild(styleEl);
      if (window.__home3dTap === api) delete window.__home3dTap;
      document.documentElement.classList.remove('tp-force-coarse');
    },
  };
  let disposed = false;
  if (o.debug) {
    window.__home3dTap = api;
    // ?tpCoarse=1 forces touch sizing on a fine-pointer browser (verification only).
    if (new URLSearchParams(location.search).get('tpCoarse') === '1') document.documentElement.classList.add('tp-force-coarse');
  }
  return api;
}
