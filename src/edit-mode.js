/**
 * edit-mode.js -- the edit-mode shell: the draft banner and "Frame the view".
 *
 * LOADED LAZILY. index.html reaches this module only through a dynamic
 * import(), when the user enters edit mode from Settings or when this device
 * already holds a draft to show the banner for. A plain view-mode load (no
 * draft) never fetches it, so the wall tablet pays nothing for editing.
 * scripts/test-edit-mode-boot.mjs holds that line.
 *
 * WHAT IT DOES (plan A2 + plan B shell S1-S3):
 *   - The banner: "EDIT MODE" / "DRAFT on this device, not live", with
 *     Export, Discard and Done/Edit, and a warning when the served profile
 *     changed under the draft (its baseHash no longer matches).
 *   - Frame the view: with a room (sidebar or a tap) or a device selected,
 *     orbit as normal, fine-tune Distance / Aim height / Lens, then
 *     "Use this view" writes the camera's pose as that owner's `view` into
 *     the draft, and "Reset to derived" removes it. Both apply to the running
 *     house at once (home.setAuthoredView): no reload.
 *
 * Plan B's later phases (move/add items, bindings, sidebar config) add their
 * panels beside the frame panel and write through the same draft helpers
 * (`saveGeometry` below); the banner and Export/Discard are theirs as-is.
 *
 * Everything that decides anything is in the pure modules: the draft store
 * (src/profile-draft.js), the export (src/profile-export.js, layout-
 * preserving via src/json-layout.js). This file is the DOM around them.
 *
 * The context the page passes (index.html, loadEditMode):
 *   home          the scene handle
 *   houseId       the profile id; houseDir 'houses/<id>/'
 *   storage       localStorage (or null when blocked)
 *   draftApplied  the page rendered a stored draft at boot
 *   draftBroken   a stored draft failed to compile; the served house is shown
 *   resolveOwner(device) -> { kind: 'furniture'|'curtain', id, label } | null
 *   roomLabel(id) -> string
 *   viewFor(owner) -> the pose the page would fly to for it (authored or derived)
 *   flyTo(pose)   fly the camera (the page's focus flight)
 *   debug         expose window.__home3dEdit for checks
 */

import { readDraft, writeDraft, clearDraft, makeDraft, baseHashOf, poseToFocusView,
  setOwnerView, clearOwnerView, findOwner } from './profile-draft.js';
import { exportProfile } from './profile-export.js';

const CSS = `
.em-banner { position: fixed; top: 10px; left: 50%; transform: translateX(-50%); z-index: 70;
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap; justify-content: center;
  max-width: calc(100vw - 20px); box-sizing: border-box; padding: 7px 10px 7px 12px; border-radius: 10px;
  background: rgba(120, 53, 15, 0.94); color: #fff7ed; border: 1px solid rgba(251, 191, 36, 0.55);
  font: 500 12px/1.3 system-ui, -apple-system, Segoe UI, sans-serif; box-shadow: 0 4px 16px rgba(0,0,0,0.35); }
.em-banner .em-tag { font-weight: 800; letter-spacing: 0.08em; color: #fde68a; }
.em-banner .em-text { opacity: 0.95; }
.em-banner .em-warn { flex-basis: 100%; text-align: center; color: #fecaca; font-weight: 600; }
.em-btn { font: 600 12px/1 system-ui, -apple-system, Segoe UI, sans-serif; padding: 7px 10px; border-radius: 7px;
  border: 1px solid rgba(255,255,255,0.28); background: rgba(255,255,255,0.10); color: inherit; cursor: pointer; }
.em-btn:hover:not(:disabled) { background: rgba(255,255,255,0.2); }
.em-btn:disabled { opacity: 0.45; cursor: default; }
.em-btn.primary { background: #6366f1; border-color: #6366f1; color: #fff; }
.em-btn.primary:hover:not(:disabled) { background: #4f46e5; }
.em-frame { position: fixed; top: 64px; left: 12px; z-index: 60; width: 272px; box-sizing: border-box;
  padding: 12px 14px 14px; border-radius: 12px; background: rgba(10,10,20,0.92); color: #fff;
  border: 1px solid rgba(255,255,255,0.10); backdrop-filter: blur(16px);
  font: 400 12px/1.35 system-ui, -apple-system, Segoe UI, sans-serif; box-shadow: 0 6px 24px rgba(0,0,0,0.4); }
.em-frame .em-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 2px; }
.em-frame .em-kicker { font-size: 10px; font-weight: 700; letter-spacing: 0.1em; opacity: 0.55; }
.em-frame h2 { margin: 0 0 6px; font-size: 16px; font-weight: 650; }
.em-frame .em-x { background: none; border: 0; color: inherit; opacity: 0.6; font-size: 18px; cursor: pointer; padding: 2px 6px; }
.em-frame .em-target { font-size: 13px; font-weight: 600; }
.em-frame .em-sub { opacity: 0.6; margin: 2px 0 10px; }
.em-frame .em-row { margin: 8px 0 12px; }
.em-frame .em-row label { display: flex; justify-content: space-between; font-size: 11px; opacity: 0.75; margin-bottom: 6px; }
.em-frame .em-actions { display: flex; gap: 8px; margin-top: 12px; }
.em-frame .em-actions .em-btn { flex: 1; padding: 9px 8px; }
.em-frame .em-msg { min-height: 1.3em; margin-top: 8px; font-size: 11px; opacity: 0.8; }
.em-frame .em-empty { opacity: 0.7; margin: 4px 0 2px; }
:root[data-theme="light"] .em-frame { background: rgba(248,249,252,0.96); color: #1a1d29; border-color: rgba(0,0,0,0.10); }
:root[data-theme="light"] .em-frame .em-btn:not(.primary) { border-color: rgba(0,0,0,0.18); background: rgba(0,0,0,0.04); }
@media (max-width: 600px) {
  .em-banner { top: auto; bottom: 8px; left: 8px; right: 8px; transform: none; max-width: none; }
  /* Above the banner, whatever its wrapped height (--em-banner-h, kept by a ResizeObserver). */
  .em-frame { top: auto; bottom: calc(var(--em-banner-h, 56px) + 16px); left: 8px; right: 8px; width: auto;
    max-height: calc(100vh - var(--em-banner-h, 56px) - 90px); overflow-y: auto; }
}
`;

const KIND_LABEL = { room: 'Room', furniture: 'Furniture item', curtain: 'Curtain' };

let ctl = null;   // the one controller per page

/** Show the draft banner (a draft is rendered on this device). */
export function mountDraftBanner(ctx) { return controller(ctx).showBanner(); }

/** Enter edit mode: banner + Frame the view. Returns the controller. */
export function enterEditMode(ctx) { const c = controller(ctx); c.enter(); return c; }

export function editController() { return ctl; }

function controller(ctx) {
  if (!ctl) ctl = createController(ctx);
  return ctl;
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function createController(ctx) {
  const { home, houseId, storage } = ctx;
  const dir = ctx.houseDir || ('houses/' + houseId + '/');
  let active = false;
  let banner = null, frame = null;
  let target = null;       // { kind, id, label } | { kind: 'none', label, reason }
  let served = null;       // { geometryText, roomsText, hash } once fetched
  let unRender = null;
  let dragging = null;     // the slider being dragged (not overwritten by camera sync)
  let draft = storage ? readDraft(storage, houseId) : null;

  if (!document.getElementById('em-style')) {
    const st = el('style'); st.id = 'em-style'; st.textContent = CSS; document.head.appendChild(st);
  }

  async function loadServed() {
    if (served) return served;
    const get = async name => {
      const r = await fetch(dir + name, { cache: 'no-store' });
      if (!r.ok) { if (name === 'rooms.json' && r.status === 404) return null; throw new Error(name + ': HTTP ' + r.status); }
      return r.text();
    };
    const [g, rm] = await Promise.all([get('geometry.json'), get('rooms.json')]);
    served = { geometryText: g, roomsText: rm, hash: baseHashOf(g, rm) };
    return served;
  }

  // ---- Draft writes ------------------------------------------------------
  async function ensureDraft() {
    if (draft) return draft;
    const s = await loadServed();
    draft = makeDraft({ houseId, baseHash: s.hash, geometry: JSON.parse(s.geometryText), rooms: s.roomsText ? JSON.parse(s.roomsText) : null });
    return draft;
  }
  /** Replace the draft's geometry document and store it. Plan B's editors write through this. */
  async function saveGeometry(geometry) {
    const d = await ensureDraft();
    draft = writeDraft(storage, Object.assign({}, d, { geometry }));
    renderBanner();
    return draft;
  }

  // ---- Banner ------------------------------------------------------------
  function renderBanner() {
    if (!banner) {
      banner = el('div', 'em-banner'); banner.setAttribute('role', 'status'); banner.id = 'em-banner'; document.body.appendChild(banner);
      // The phone layout stacks the frame panel above the banner: publish its height.
      const b = banner;
      const publish = () => document.documentElement.style.setProperty('--em-banner-h', b.offsetHeight + 'px');
      if (typeof ResizeObserver === 'function') new ResizeObserver(publish).observe(b);
      requestAnimationFrame(publish);
    }
    banner.textContent = '';
    const tag = el('span', 'em-tag', active ? 'EDIT MODE' : 'DRAFT');
    const text = el('span', 'em-text', draft
      ? (active ? 'DRAFT on this device, not live' : 'on this device, not live')
      : 'edits save as a draft on this device, not live');
    banner.append(tag, text);
    const exp = el('button', 'em-btn', 'Export'); exp.id = 'em-export'; exp.disabled = !draft;
    exp.title = 'Download geometry.json and rooms.json to apply to the server';
    exp.addEventListener('click', () => doExport());
    const dis = el('button', 'em-btn', 'Discard'); dis.id = 'em-discard'; dis.disabled = !draft;
    dis.title = 'Delete the draft on this device and show the served profile';
    dis.addEventListener('click', () => doDiscard());
    const mode = el('button', 'em-btn primary', active ? 'Done' : 'Edit'); mode.id = 'em-mode';
    mode.addEventListener('click', () => (active ? exit() : enter()));
    banner.append(exp, dis, mode);
    if (ctx.draftBroken) banner.append(el('span', 'em-warn', 'This draft could not be rendered; the served profile is shown. Export or Discard it.'));
    if (draft && served && draft.baseHash && served.hash !== draft.baseHash) {
      const w = el('span', 'em-warn', 'The served profile changed since this draft began. Export would overwrite those changes; Discard to start from the new one.');
      w.id = 'em-stale';
      banner.append(w);
    }
    if (!draft && !active) { banner.remove(); banner = null; }
  }

  async function showBanner() {
    renderBanner();
    try { await loadServed(); renderBanner(); } catch (e) { console.warn('[edit-mode] could not read the served profile: ' + e.message); }
  }

  // ---- Frame the view ----------------------------------------------------
  function sliderRow(key, label, min, max, step, unit) {
    const row = el('div', 'em-row');
    const lab = el('label');
    const name = el('span', null, label), val = el('span', 'em-val'); val.id = 'em-val-' + key;
    lab.append(name, val);
    const inp = el('input', 'slider');
    Object.assign(inp, { type: 'range', min, max, step, id: 'em-' + key });
    inp.setAttribute('aria-label', label);
    inp.addEventListener('pointerdown', () => { dragging = key; });
    const stop = () => { if (dragging === key) dragging = null; };
    inp.addEventListener('pointerup', stop); inp.addEventListener('change', stop); inp.addEventListener('blur', stop);
    inp.addEventListener('input', () => applySlider(key, parseFloat(inp.value)));
    row.append(lab, inp);
    row.dataset.unit = unit;
    return row;
  }
  function applySlider(key, v) {
    const p = home.getPose();
    if (key === 'distance') p.r = v;
    else if (key === 'height') p.tgt = [p.tgt[0], v / 100, p.tgt[2]];
    else if (key === 'fov') p.fov = v;
    home.flyTo(p, { ms: 0 });
    syncSliders(true);
  }
  function setRange(key, v, text) {
    const inp = frame && frame.querySelector('#em-' + key);
    if (!inp) return;
    if (key === 'distance' && v > parseFloat(inp.max)) inp.max = String(Math.ceil(v * 1.5));
    if (dragging !== key) inp.value = String(v);
    inp.style.setProperty('--p', ((parseFloat(inp.value) - inp.min) / (inp.max - inp.min) * 100) + '%');
    const lab = frame.querySelector('#em-val-' + key);
    if (lab) lab.textContent = text;
  }
  function syncSliders() {
    if (!frame || !target || target.kind === 'none') return;
    const p = home.getPose();
    setRange('distance', p.r, p.r.toFixed(2) + ' m');
    setRange('height', Math.round(p.tgt[1] * 100), Math.round(p.tgt[1] * 100) + ' cm');
    setRange('fov', p.fov, Math.round(p.fov) + '°');
  }
  function message(text) { const m = frame && frame.querySelector('.em-msg'); if (m) m.textContent = text || ''; }

  function renderFrame() {
    if (!active) { if (frame) { frame.remove(); frame = null; } return; }
    if (!frame) { frame = el('div', 'em-frame'); frame.id = 'em-frame'; document.body.appendChild(frame); }
    frame.textContent = '';
    const head = el('div', 'em-head');
    head.append(el('span', 'em-kicker', 'EDIT LAYOUT'));
    frame.append(head, el('h2', null, 'Frame the view'));
    if (!target) {
      frame.append(el('div', 'em-empty', 'Pick a room (tap it, or choose it in the sidebar) or tap a device to frame the view the camera flies to.'));
      return;
    }
    const x = el('button', 'em-x', '×'); x.setAttribute('aria-label', 'Stop framing'); x.title = 'Stop framing';
    x.addEventListener('click', () => { target = null; renderFrame(); });
    head.append(x);
    frame.append(el('div', 'em-target', target.label || target.id));
    if (target.kind === 'none') {
      frame.append(el('div', 'em-sub', target.reason));
      return;
    }
    const authored = !!(draft && findOwner(draft.geometry, target) && findOwner(draft.geometry, target).view) ||
      (typeof home.hasAuthoredView === 'function' && home.hasAuthoredView(target.kind, target.id));
    const sub = el('div', 'em-sub', KIND_LABEL[target.kind] + ' · ' + (authored ? 'authored view' : 'derived view'));
    sub.id = 'em-view-kind';
    frame.append(sub, el('div', 'em-sub', 'Orbit and zoom as normal, then fine-tune:'));
    frame.append(sliderRow('distance', 'Distance', 0.5, 30, 0.05, 'm'), sliderRow('height', 'Aim height', 0, 300, 1, 'cm'),
      sliderRow('fov', 'Lens (field of view)', 20, 90, 1, 'deg'));
    const acts = el('div', 'em-actions');
    const use = el('button', 'em-btn primary', 'Use this view'); use.id = 'em-use';
    use.addEventListener('click', () => useThisView());
    const reset = el('button', 'em-btn', 'Reset to derived'); reset.id = 'em-reset'; reset.disabled = !authored;
    reset.addEventListener('click', () => resetToDerived());
    acts.append(use, reset);
    const msg = el('div', 'em-msg'); msg.setAttribute('aria-live', 'polite');
    frame.append(acts, msg);
    syncSliders();
  }

  async function useThisView() {
    if (!target || target.kind === 'none') return;
    try {
      const d = await ensureDraft();
      const view = poseToFocusView(home.getPose(), d.geometry.coordinateTransform);
      await saveGeometry(setOwnerView(d.geometry, target, view));
      home.setAuthoredView(target.kind, target.id, view);
      renderFrame();
      message('Saved to the draft. This view now applies when it is selected.');
    } catch (e) { message('Could not save: ' + e.message); }
  }
  async function resetToDerived() {
    if (!target || target.kind === 'none') return;
    try {
      const d = await ensureDraft();
      await saveGeometry(clearOwnerView(d.geometry, target));
      home.setAuthoredView(target.kind, target.id, null);
      renderFrame();
      const pose = ctx.viewFor ? ctx.viewFor(target) : null;
      if (pose && ctx.flyTo) ctx.flyTo(pose);
      message('Back to the derived view (saved to the draft).');
    } catch (e) { message('Could not reset: ' + e.message); }
  }

  // ---- Export / Discard --------------------------------------------------
  async function exportTexts() {
    const s = await loadServed();
    const d = draft || { geometry: JSON.parse(s.geometryText), rooms: s.roomsText ? JSON.parse(s.roomsText) : null };
    return exportProfile(s, d);
  }
  function download(name, text) {
    const a = el('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
  async function doExport() {
    try {
      const t = await exportTexts();
      download('geometry.json', t.geometry);
      if (t.rooms != null) setTimeout(() => download('rooms.json', t.rooms), 400);
    } catch (e) { window.alert('Export failed: ' + e.message); }
  }
  function doDiscard() {
    if (!window.confirm('Discard the draft on this device? The served profile will be shown again.')) return;
    if (storage) clearDraft(storage, houseId);
    draft = null;
    window.location.reload();
  }

  // ---- Mode ----------------------------------------------------------------
  function enter() {
    if (active) return;
    active = true;
    renderBanner();
    renderFrame();
    if (typeof home.onRender === 'function' && !unRender) unRender = home.onRender(() => { if (active) syncSliders(); });
    loadServed().then(renderBanner, e => console.warn('[edit-mode] could not read the served profile: ' + e.message));
    if (ctx.onModeChange) ctx.onModeChange(true);
  }
  function exit() {
    if (!active) return;
    active = false;
    target = null;
    if (unRender) { unRender(); unRender = null; }
    renderFrame();
    renderBanner();
    if (ctx.onModeChange) ctx.onModeChange(false);
  }
  function selectRoom(id) {
    if (!active || !id) return;
    if (target && target.kind === 'room' && target.id === id) return;
    target = { kind: 'room', id, label: ctx.roomLabel ? ctx.roomLabel(id) : id };
    renderFrame();
  }
  function selectDevice(device, point) {
    if (!active || !device) return;
    const owner = ctx.resolveOwner ? ctx.resolveOwner(Object.assign({}, device, { focusPoint: point || null })) : null;
    target = owner || { kind: 'none', label: device.label || device.id,
      reason: 'This device has no profile entry that can hold a view (a light frames from its fixture). Frame its room instead.' };
    renderFrame();
  }

  const api = {
    enter, exit, showBanner, selectRoom, selectDevice, saveGeometry,
    isActive: () => active,
    target: () => target,
    draft: () => draft,
    exportTexts,
  };
  if (ctx.debug) window.__home3dEdit = api;
  return api;
}
