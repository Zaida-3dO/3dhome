/**
 * tap-popovers.js -- tap a 3D object, get a tiny popover controlling the Home
 * Assistant entity bound to it. SPIKE (see docs/plans/tap-popovers.md).
 *
 * The sidebar is untouched and stays the primary control surface; this is an
 * additional, direct-manipulation path. Everything the popover changes goes
 * through the same state the sidebar reads (home.lightState, the curtain
 * setters) and the same HA send paths, and then asks the sidebar to repaint.
 *
 * THE MAPPING IS DERIVED, NOT HAND-WRITTEN. A target is recognised from what
 * the scene already tags on its meshes, and bound through rooms.json:
 *
 *   light    mesh.userData.{roomId, lightChannel}  -> rooms[roomId][channel]
 *   curtain  ancestor group named 'curtain:<id>'   -> sensors.curtains[id]
 *   door     ancestor userData.doorProfileId       -> sensors.doors[id]
 *   climate  ancestor userData.furnitureId         -> sensors.climate[id]
 *
 * Only BOUND objects are targets. Anything else behaves exactly as before
 * (a tap selects the room).
 *
 * OCCLUSION: nearest drawn, non-see-through hit wins. A faded exterior wall
 * (opacity 0.05), the ceiling seen from above (0), the room click-catchers (0)
 * and window glass (0.28) are see-through and skipped; a solid wall, a door
 * frame or a piece of furniture in front of a light BLOCKS the tap. A target
 * itself is accepted whatever its own opacity (an OFF accent strip is 0.15).
 *
 * The pure parts (materialOpacity, resolveTarget, pickFromHits,
 * placePopover) take no DOM and no THREE and are unit-tested in
 * scripts/test-tap-popovers.mjs.
 */

export const OPACITY_SOLID = 0.35;   // below this a mesh is see-through for picking
export const TAP_SLOP_PX = 5;        // same rule as the scene's own room click
export const FUZZ_PX = 24;           // finger tolerance for tiny light fixtures

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
 * object. Returns a target ({kind, id, entities, ...}) when that object is
 * BOUND in rooms.json, or null (an unbound door is still a solid door -- the
 * caller treats null as "not a target", i.e. an occluder if opaque).
 *
 * @param obj       the hit object
 * @param bindings  { lights: rooms, curtains, doors, climate } from rooms.json
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
    if (u.furnitureId) {
      const ents = (b.climate || {})[u.furnitureId];
      if (Array.isArray(ents) && ents.length) return { kind: 'climate', id: u.furnitureId, entities: ents, object: o };
      return null;
    }
  }
  return null;
}

/**
 * Decide a tap from raycast hits (sorted nearest-first, as three returns
 * them). Returns { target, hit } for a target, { target:null, hit } when the
 * first solid thing is not a target (OCCLUDED), or { target:null, hit:null }
 * when the ray met nothing solid at all.
 */
export function pickFromHits(hits, bindings) {
  for (let i = 0; i < hits.length; i++) {
    const h = hits[i];
    const o = h.object;
    if (!o || !(o.isMesh)) continue;
    if (!isDrawn(o)) continue;
    const t = resolveTarget(o, bindings);
    if (t) return { target: t, hit: h };
    if (materialOpacity(o.material, h.face ? h.face.materialIndex : 0) < OPACITY_SOLID) continue;
    return { target: null, hit: h };
  }
  return { target: null, hit: null };
}

/**
 * Where to put a w x h popover for a tap at (x, y), inside `bounds`
 * ({left, top, right, bottom}). Prefers ABOVE the tap (a finger covers what
 * is below it), flips below when there is no room, and clamps horizontally.
 */
export function placePopover(x, y, w, h, bounds, gap, margin) {
  const g = gap == null ? 14 : gap;
  const m = margin == null ? 8 : margin;
  let left = x - w / 2;
  left = Math.max(bounds.left + m, Math.min(left, bounds.right - m - w));
  let top = y - g - h;
  let placement = 'above';
  if (top < bounds.top + m) {
    top = y + g;
    placement = 'below';
    if (top + h > bounds.bottom - m) top = Math.max(bounds.top + m, bounds.bottom - m - h);
  }
  return { left: Math.round(left), top: Math.round(top), placement };
}

// ---------------------------------------------------------------------------
// Runtime (browser)
// ---------------------------------------------------------------------------

const STYLE = `
.tp-pop { position: fixed; z-index: 60; width: 224px; padding: 12px 14px 12px;
  border-radius: 12px; background: rgba(10,10,20,0.94); backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px); border: 1px solid rgba(255,255,255,0.12);
  box-shadow: 0 8px 28px rgba(0,0,0,0.5); color: #fff; font-size: 12px;
  font-family: 'Segoe UI', system-ui, sans-serif; touch-action: manipulation; }
.tp-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 8px; }
.tp-title { font-size: 13px; font-weight: 600; line-height: 1.25; }
.tp-sub { font-size: 10px; opacity: 0.5; margin-top: 1px; }
.tp-state { font-size: 11px; opacity: 0.75; margin-bottom: 6px; }
.tp-state b { font-weight: 600; }
.tp-row { margin-top: 8px; }
.tp-lbl { font-size: 11px; opacity: 0.55; margin-bottom: 5px; }
.tp-slider { width: 100%; height: 6px; border-radius: 3px; -webkit-appearance: none; appearance: none;
  background: rgba(255,255,255,0.15); outline: none; }
.tp-slider::-webkit-slider-thumb { -webkit-appearance: none; width: 20px; height: 20px; border-radius: 50%; background: #fff; }
.tp-slider::-moz-range-thumb { width: 20px; height: 20px; border-radius: 50%; background: #fff; border: none; }
.tp-slider:disabled { opacity: 0.35; }
.tp-btns { display: flex; gap: 6px; margin-top: 10px; }
.tp-btn { flex: 1; padding: 8px 0; border-radius: 8px; border: 1px solid rgba(255,255,255,0.14);
  background: rgba(255,255,255,0.07); color: #fff; font-size: 12px; cursor: pointer; }
.tp-btn:disabled { opacity: 0.35; cursor: not-allowed; }
.tp-toggle { width: 44px; height: 26px; border-radius: 13px; border: none; cursor: pointer; position: relative;
  background: rgba(255,255,255,0.18); padding: 0; flex-shrink: 0; transition: background 0.2s; }
.tp-toggle.on { background: #6366f1; }
.tp-toggle i { position: absolute; top: 3px; left: 3px; width: 20px; height: 20px; border-radius: 50%; background: #fff; transition: left 0.2s; }
.tp-toggle.on i { left: 21px; }
.tp-temp { display: flex; align-items: baseline; justify-content: space-between; margin: 2px 0 4px; }
.tp-temp .big { font-size: 22px; font-weight: 600; }
.tp-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; background: #666; vertical-align: 0; }
.tp-dot.open { background: #f59e0b; box-shadow: 0 0 6px #f59e0b; }
.tp-dot.closed { background: #22c55e; }
.tp-note { font-size: 10px; opacity: 0.45; margin-top: 8px; }
`;

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/**
 * Attach the popover layer.
 *
 * @param {Object} o
 * @param o.THREE, o.home, o.container, o.Home3DScene, o.house
 * @param o.rooms           rooms.json `rooms` (room -> channel -> entities)
 * @param o.sensors         rooms.json `sensors`
 * @param o.getHa           () => HAClient instance or null
 * @param o.HAClient        the HAClient module (coverPositionCommand)
 * @param o.sendLight       (roomId, channel, state, debounceMs) -- index.html's sendToHA
 * @param o.getDoorReading  (doorId) => true | false | null (no reading yet)
 * @param o.fetchEntityState (entityId) => Promise<raw HA state | null>
 * @param o.onChange        () => void -- repaint the sidebar
 * @param o.debug           expose window.__home3dTap
 */
export function attachTapPopovers(o) {
  const { THREE, home, container, Home3DScene } = o;
  const bindings = {
    lights: o.rooms || {},
    curtains: (o.sensors && o.sensors.curtains) || {},
    doors: (o.sensors && o.sensors.doors) || {},
    climate: (o.sensors && o.sensors.climate) || {},
  };
  const curtainNames = new Map(((o.house && o.house.curtains) || []).map(c => [c.id, c.name || c.id]));
  const doorNames = new Map(((o.house && o.house.doors) || []).map(d => [d.id, d.name || d.id]));
  const ha = () => (o.getHa ? o.getHa() : null);
  const onChange = () => { try { o.onChange && o.onChange(); } catch (e) { /* sidebar repaint must not break us */ } };

  const styleEl = document.createElement('style');
  styleEl.textContent = STYLE;
  document.head.appendChild(styleEl);

  const rc = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const tmpV = new THREE.Vector3();

  // Tiny fixtures are hard to hit with a finger, so lights also get a
  // screen-space tolerance. Collected once: fixture meshes never change.
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

  // Is `t` the first solid thing along the ray from the camera to `point`?
  function unoccluded(t, point) {
    const cam = home.getCamera();
    const origin = cam.position;
    const dir = tmpV.copy(point).sub(origin);
    const dist = dir.length();
    dir.normalize();
    rc.set(origin, dir);
    rc.far = dist + 0.05;
    const res = pickFromHits(rc.intersectObjects(home.scene.children, true), bindings);
    rc.far = Infinity;
    if (res.target) return res.target.id === t.id && res.target.kind === t.kind;
    return !res.hit; // nothing solid in the way
  }

  let lastPickMs = 0;
  /** Resolve a tap at client coords -> { target } | { occludedBy } | null. */
  function pickAt(clientX, clientY) {
    const t0 = performance.now();
    const res = pickFromHits(raycastAt(clientX, clientY), bindings);
    let out;
    if (res.target) {
      out = { target: res.target, point: res.hit.point };
    } else {
      // Fuzzy fallback for small light fixtures, each re-tested for occlusion.
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

  // ---- popover DOM ------------------------------------------------------
  let pop = null;          // { el, target, x, y, camSnap, refresh }
  function close() {
    if (!pop) return;
    if (pop.el.parentNode) pop.el.parentNode.removeChild(pop.el);
    pop = null;
  }

  function camSnapshot() {
    const cam = home.getCamera();
    cam.updateMatrixWorld();
    return cam.matrixWorld.elements.slice();
  }
  function camMoved(snap) {
    const e = home.getCamera().matrixWorld.elements;
    for (let i = 0; i < 16; i++) if (Math.abs(e[i] - snap[i]) > 1e-6) return true;
    return false;
  }

  function position(el, x, y) {
    const r = canvasRect();
    const bounds = {
      left: Math.max(0, r.left), top: Math.max(0, r.top),
      right: Math.min(window.innerWidth, r.right), bottom: Math.min(window.innerHeight, r.bottom),
    };
    const p = placePopover(x, y, el.offsetWidth, el.offsetHeight, bounds);
    el.style.left = p.left + 'px';
    el.style.top = p.top + 'px';
    el.dataset.placement = p.placement;
  }

  function open(target, x, y) {
    close();
    const el = document.createElement('div');
    el.className = 'tp-pop';
    el.dataset.kind = target.kind;
    el.dataset.target = target.id;
    el.setAttribute('role', 'dialog');
    document.body.appendChild(el);
    const view = VIEWS[target.kind](target, el);
    pop = { el, target, x, y, camSnap: camSnapshot(), refresh: view.refresh || (() => {}) };
    position(el, x, y);
    home.requestRender();
  }

  // ---- views --------------------------------------------------------------
  const roomName = id => ((Home3DScene.ROOMS || {})[id] || {}).name || id;
  const channelName = (roomId, ch) => {
    const lc = ((Home3DScene.LIGHTS || {})[roomId] || {})[ch];
    if (lc && lc.name) return lc.name;
    return ch === 'main' ? 'Main light' : ch.charAt(0).toUpperCase() + ch.slice(1);
  };
  const offlineNote = () => (ha() ? '' : '<div class="tp-note">Home Assistant offline &middot; preview only</div>');

  const VIEWS = {
    light(t, el) {
      const s = () => (home.lightState[t.roomId] || {})[t.channel];
      el.innerHTML =
        '<div class="tp-head"><div><div class="tp-title">' + esc(channelName(t.roomId, t.channel)) + '</div>' +
        '<div class="tp-sub">' + esc(roomName(t.roomId)) + '</div></div>' +
        '<button class="tp-toggle" data-a="toggle" aria-label="On/off"><i></i></button></div>' +
        '<div class="tp-state" data-a="state"></div>' +
        '<div class="tp-row"><div class="tp-lbl" data-a="bri-lbl"></div>' +
        '<input class="tp-slider" type="range" min="5" max="100" data-a="bri"></div>' + offlineNote();
      const tog = el.querySelector('[data-a=toggle]');
      const slider = el.querySelector('[data-a=bri]');
      let dragging = false;
      const refresh = () => {
        const st = s(); if (!st) return;
        tog.classList.toggle('on', !!st.on);
        el.querySelector('[data-a=state]').innerHTML = 'State: <b>' + (st.on ? 'On' : 'Off') + '</b>';
        el.querySelector('[data-a=bri-lbl]').textContent = 'Brightness: ' + (st.bri != null ? st.bri : 0) + '%';
        if (!dragging) slider.value = String(st.bri != null ? st.bri : 100);
      };
      tog.addEventListener('click', () => {
        const st = s(); if (!st) return;
        st.on = !st.on;
        if (st.on && !st.bri) st.bri = 100;
        home.updateLights(); o.sendLight(t.roomId, t.channel, st, 0); onChange(); refresh();
      });
      slider.addEventListener('input', () => {
        const st = s(); if (!st) return;
        dragging = true;
        st.bri = +slider.value; st.on = true;
        home.updateLights(); o.sendLight(t.roomId, t.channel, st, 200); refresh();
      });
      slider.addEventListener('change', () => { dragging = false; onChange(); });
      refresh();
      return { refresh };
    },

    curtain(t, el) {
      el.innerHTML =
        '<div class="tp-head"><div><div class="tp-title">' + esc(curtainNames.get(t.id) || t.id) + '</div>' +
        '<div class="tp-sub">Curtain</div></div></div>' +
        '<div class="tp-state" data-a="state"></div>' +
        '<div class="tp-row"><input class="tp-slider" type="range" min="0" max="100" data-a="pos"></div>' +
        '<div class="tp-btns"><button class="tp-btn" data-a="close">Close</button>' +
        '<button class="tp-btn" data-a="open">Open</button></div>' + offlineNote();
      const slider = el.querySelector('[data-a=pos]');
      let dragging = false;
      // Live HA: needs a reading and every motor up (same rule as the sidebar).
      // No HA at all: drive the local scene as a preview.
      const available = () => { const h = ha(); return !h || h.getCurtainAvailable(t.id) === true; };
      const send = (pct, debounce) => {
        const h = ha(); if (!h) return;
        const cmd = o.HAClient.coverPositionCommand(pct, t.entities);
        if (cmd) h.callServiceDebounced(cmd.domain, cmd.service, cmd.data, cmd.target, 'curtain-' + t.id, debounce);
      };
      const refresh = () => {
        const pct = home.getCurtainOpen(t.id);
        const ok = available();
        el.querySelector('[data-a=state]').innerHTML = ok
          ? 'Open: <b>' + Math.round(pct || 0) + '%</b>'
          : '<b>Unavailable</b>';
        slider.disabled = !ok;
        el.querySelectorAll('.tp-btn').forEach(b => { b.disabled = !ok; });
        if (!dragging && pct != null) slider.value = String(Math.round(pct));
      };
      slider.addEventListener('input', () => {
        dragging = true;
        const pct = +slider.value;
        home.setCurtainOpen(t.id, pct, null); send(pct, 200);
        el.querySelector('[data-a=state]').innerHTML = 'Open: <b>' + pct + '%</b>';
      });
      slider.addEventListener('change', () => { dragging = false; send(+slider.value, 0); onChange(); });
      const endStop = (pct, service) => {
        const h = ha();
        if (h) h.callServiceDebounced('cover', service, {}, { entity_id: t.entities }, 'curtain-' + t.id, 0);
        home.setCurtainOpen(t.id, pct, null);
        onChange(); refresh();
      };
      el.querySelector('[data-a=open]').addEventListener('click', () => endStop(100, 'open_cover'));
      el.querySelector('[data-a=close]').addEventListener('click', () => endStop(0, 'close_cover'));
      refresh();
      return { refresh };
    },

    door(t, el) {
      el.innerHTML =
        '<div class="tp-head"><div><div class="tp-title">' + esc(doorNames.get(t.id) || t.id) + '</div>' +
        '<div class="tp-sub">Door sensor</div></div></div>' +
        '<div class="tp-state" style="font-size:13px;opacity:1" data-a="state"></div>' + offlineNote();
      // null = not asked yet / could not ask; otherwise the raw HA state string.
      let raw = null;
      const refresh = () => {
        const reading = o.getDoorReading ? o.getDoorReading(t.id) : null;
        let label, cls;
        if (raw === 'unavailable' || raw === 'unknown') { label = 'Unavailable'; cls = ''; }
        else if (reading === true || raw === 'on') { label = 'Open'; cls = 'open'; }
        else if (reading === false || raw === 'off') { label = 'Closed'; cls = 'closed'; }
        else { label = 'Unavailable'; cls = ''; }
        el.querySelector('[data-a=state]').innerHTML = '<span class="tp-dot ' + cls + '"></span><b>' + label + '</b>';
      };
      // ha-client folds 'unavailable' into closed, so ask HA directly once.
      if (o.fetchEntityState && ha()) {
        o.fetchEntityState(t.entities[0]).then(s => { if (s && s.state) { raw = s.state; refresh(); } }).catch(() => {});
      }
      refresh();
      return { refresh };
    },

    climate(t, el) {
      // Offline preview values, kept per target so a change survives reopen.
      const mock = climateMock.get(t.id) || { current: 19.5, target: 21, min: 7, max: 30, step: 0.5, mode: 'heat' };
      climateMock.set(t.id, mock);
      let st = ha() ? null : Object.assign({}, mock);
      el.innerHTML =
        '<div class="tp-head"><div><div class="tp-title">' + esc(t.label || 'Radiator') + '</div>' +
        '<div class="tp-sub">Climate</div></div></div>' +
        '<div class="tp-temp"><span><span class="tp-lbl">Current</span><br><span class="big" data-a="cur">&ndash;</span></span>' +
        '<span style="text-align:right"><span class="tp-lbl">Target</span><br><span class="big" data-a="tgt">&ndash;</span></span></div>' +
        '<div class="tp-row"><input class="tp-slider temp" type="range" data-a="set"></div>' +
        '<div class="tp-btns"><button class="tp-btn" data-a="down">&minus;</button><button class="tp-btn" data-a="up">+</button></div>' +
        (ha() ? '' : '<div class="tp-note">Home Assistant offline &middot; preview with mock values</div>');
      const slider = el.querySelector('[data-a=set]');
      const fmt = v => (v == null || isNaN(v) ? '–' : (+v).toFixed(1) + '°');
      const refresh = () => {
        const ok = !!st;
        el.querySelector('[data-a=cur]').textContent = ok ? fmt(st.current) : '–';
        el.querySelector('[data-a=tgt]').textContent = ok ? fmt(st.target) : '–';
        slider.disabled = !ok;
        el.querySelectorAll('.tp-btn').forEach(b => { b.disabled = !ok; });
        if (ok) { slider.min = st.min; slider.max = st.max; slider.step = st.step; slider.value = st.target; }
      };
      const setTarget = v => {
        if (!st) return;
        st.target = Math.max(st.min, Math.min(st.max, Math.round(v / st.step) * st.step));
        const h = ha();
        if (h) h.callServiceDebounced('climate', 'set_temperature', { temperature: st.target }, { entity_id: t.entities }, 'climate-' + t.id, 400);
        else mock.target = st.target;
        refresh();
      };
      slider.addEventListener('input', () => setTarget(+slider.value));
      el.querySelector('[data-a=down]').addEventListener('click', () => setTarget(st.target - st.step));
      el.querySelector('[data-a=up]').addEventListener('click', () => setTarget(st.target + st.step));
      if (ha() && o.fetchEntityState) {
        o.fetchEntityState(t.entities[0]).then(s => {
          if (!s || !s.attributes || s.state === 'unavailable') return;
          const a = s.attributes;
          st = { current: a.current_temperature, target: a.temperature, min: a.min_temp != null ? a.min_temp : 7,
            max: a.max_temp != null ? a.max_temp : 30, step: a.target_temp_step || 0.5, mode: s.state };
          refresh();
        }).catch(() => {});
      }
      refresh();
      return { refresh };
    },
  };
  const climateMock = new Map();

  // ---- input --------------------------------------------------------------
  // Window CAPTURE phase: runs before the scene's own handlers on the
  // container, so a tap on a bound object can stop the room-select click.
  const pointers = new Set();
  let downX = 0, downY = 0, multi = false;
  const inCanvas = e => container.contains(e.target);

  const onPointerDown = e => {
    // Any press outside the popover dismisses it: tap-away, and the start of
    // every orbit / pan / pinch.
    if (pop && !pop.el.contains(e.target)) close();
    if (!inCanvas(e)) return;
    pointers.add(e.pointerId);
    if (pointers.size === 1) { downX = e.clientX; downY = e.clientY; multi = false; }
    else multi = true;
  };
  const onPointerEnd = e => { pointers.delete(e.pointerId); };
  const onClick = e => {
    if (!inCanvas(e)) return;
    if (multi) return;
    if (Math.abs(e.clientX - downX) > TAP_SLOP_PX || Math.abs(e.clientY - downY) > TAP_SLOP_PX) return;
    const res = pickAt(e.clientX, e.clientY);
    if (res && res.target) {
      e.stopPropagation();   // this tap is ours: no room selection underneath
      open(res.target, e.clientX, e.clientY);
    }
  };
  const onWheel = e => { if (pop && inCanvas(e)) close(); };
  const onKey = e => { if (e.key === 'Escape') close(); };
  const onResize = () => close();

  window.addEventListener('pointerdown', onPointerDown, true);
  window.addEventListener('pointerup', onPointerEnd, true);
  window.addEventListener('pointercancel', onPointerEnd, true);
  window.addEventListener('click', onClick, true);
  window.addEventListener('wheel', onWheel, { capture: true, passive: true });
  window.addEventListener('keydown', onKey);
  window.addEventListener('resize', onResize);

  // Camera moved for any reason -> dismiss. Otherwise refresh live values
  // (an HA update repaints the scene, which lands here).
  const unsub = home.onRender(() => {
    if (!pop) return;
    if (camMoved(pop.camSnap)) { close(); return; }
    try { pop.refresh(); } catch (e) { /* never break the render loop */ }
  });

  const api = {
    pickAt(x, y) {
      const r = pickAt(x, y);
      if (!r) return null;
      if (r.target) return { kind: r.target.kind, id: r.target.id, fuzzy: !!r.fuzzy };
      const ob = r.occludedBy;
      return { occludedBy: (ob && (ob.name || ob.type)) || 'mesh', occluderOpacity: ob ? materialOpacity(ob.material) : null };
    },
    /** Open a popover without a tap (debug seam; the only route to climate on main). */
    openAt(kind, id, x, y, extra) {
      const ents = kind === 'light' ? ((bindings.lights[id.split('/')[0]] || {})[id.split('/')[1]])
        : (bindings[kind === 'climate' ? 'climate' : kind + 's'] || {})[id];
      if (!ents) return false;
      const t = Object.assign({ kind, id, entities: ents }, extra || {});
      if (kind === 'light') { t.roomId = id.split('/')[0]; t.channel = id.split('/')[1]; }
      open(t, x, y);
      return true;
    },
    close,
    isOpen: () => !!pop,
    current: () => (pop ? { kind: pop.target.kind, id: pop.target.id, rect: pop.el.getBoundingClientRect().toJSON() } : null),
    lastPickMs: () => lastPickMs,
    /** Bound light fixtures with their current screen position. */
    lightTargets() {
      const r = canvasRect(); const cam = home.getCamera();
      return lightTargets.map(t => {
        t.object.getWorldPosition(tmpV); tmpV.project(cam);
        return { id: t.id, x: Math.round(r.left + (tmpV.x + 1) / 2 * r.width), y: Math.round(r.top + (1 - tmpV.y) / 2 * r.height) };
      });
    },
    dispose() {
      close(); unsub();
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('pointerup', onPointerEnd, true);
      window.removeEventListener('pointercancel', onPointerEnd, true);
      window.removeEventListener('click', onClick, true);
      window.removeEventListener('wheel', onWheel, { capture: true });
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onResize);
      if (styleEl.parentNode) styleEl.parentNode.removeChild(styleEl);
    },
  };
  if (o.debug) window.__home3dTap = api;
  return api;
}
