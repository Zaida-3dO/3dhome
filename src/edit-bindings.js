/**
 * edit-bindings.js -- edit mode's Home Assistant panels (plan B3) and the
 * room sidebar editor (plan B4). The DOM half; every decision is in the pure
 * src/bindings.js (what is written where) and src/room-panel.js (which rows
 * a room shows).
 *
 * LOADED LAZILY, with src/edit-mode.js (which imports it): never at boot.
 *
 * Each mappable control gets a Static | Entity switch:
 *   - a curtain's open position: Static is geometry `curtains[].openPct`,
 *     Entity a cover (attribute + transform);
 *   - a room's light channel: Static is the fixture's geometry `static`
 *     look (on / brightness / colour), Entity a light (brightness transform);
 *   - a furniture item's tap-card rows (media / light / switch): an entity
 *     each, added and removed here, and whether the item shows in its
 *     room's sidebar.
 * Entity ids are only ever written into rooms.json (src/bindings.js);
 * static values only into geometry.json (src/edit-ops.js).
 *
 * The entity picker lists what Home Assistant has in the supported domains,
 * by friendly name. The list comes from edit mode's own get_states (the HA
 * client's listEntities), is kept only as { entity_id, friendly_name,
 * domain }, and is dropped when edit mode closes (reset()). With no Home
 * Assistant connected, an entity id can be typed instead.
 *
 * The api the controller passes:
 *   rooms() / geometry()          the working documents
 *   setRooms(doc) / setGeometry(doc)   keep an edit (marks the work unsaved)
 *   rerender()                    redraw the panel
 *   listEntities(domains)         -> Promise<[{ entity_id, friendly_name, domain }]>
 *   previewCurtain(id, pct), previewLight(room, channel, { on, bri, color }),
 *   previewSidebar(room, cfg|null)    show an edit live, before Save
 *   derivedRows(room) -> [{ key, label }]   the rows the room derives
 *   roomFurniture(room) -> [{ id, label }]
 *   lightChannels(room) -> [{ channel, label }]
 *   curtainOpen(id) -> the geometry openPct (default 100)
 *   message(text)
 */

import { PICKER_DOMAINS, CHANNEL_CHOICES, ITEM_ROW_KINDS, EXTRA_KINDS, ENTITY_RE, curtainKey, lightKey, bindingOf,
  setTargetBinding, itemRows, setItemRowEntity, addItemRow, removeItemRow, roomSidebar, setRoomSidebar,
  filterEntities, SIDEBAR_GROUPS } from './bindings.js';
import { setCurtainOpenPct, setFixtureStatic, fixtureStatic, hasFixture } from './edit-ops.js';

const CSS = `
.em-frame .em-seg { display: inline-flex; border: 1px solid rgba(255,255,255,0.22); border-radius: 7px; overflow: hidden; }
.em-frame .em-seg button { font: 600 11px/1 system-ui, sans-serif; padding: 5px 9px; border: 0; background: transparent; color: inherit; cursor: pointer; }
.em-frame .em-seg button.on { background: #6366f1; color: #fff; }
.em-frame .em-bind { margin: 8px 0 10px; padding: 8px; border-radius: 8px; background: rgba(255,255,255,0.04); }
.em-frame .em-bind-head { display: flex; align-items: center; justify-content: space-between; gap: 6px; margin-bottom: 6px; font-weight: 600; }
.em-frame .em-ent { margin: 4px 0; }
.em-frame .em-ent-cur { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
.em-frame .em-ent-name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.em-frame .em-ent-id { font: 11px/1.3 ui-monospace, monospace; opacity: 0.6; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.em-frame .em-ent-list { margin-top: 5px; max-height: 190px; overflow-y: auto; border: 1px solid rgba(255,255,255,0.12); border-radius: 7px; }
.em-frame .em-ent-list button { display: block; width: 100%; text-align: left; padding: 5px 8px; border: 0; border-bottom: 1px solid rgba(255,255,255,0.06);
  background: transparent; color: inherit; cursor: pointer; font: inherit; }
.em-frame .em-ent-list button:hover { background: rgba(99,102,241,0.25); }
.em-frame .em-mini { font-size: 11px; opacity: 0.65; margin: 3px 0; }
.em-frame .em-x-row { display: grid; grid-template-columns: 1fr auto; gap: 4px; margin: 6px 0; padding: 6px; border-radius: 7px; background: rgba(255,255,255,0.04); }
.em-frame .em-x-row .em-x-tools { display: flex; gap: 3px; }
.em-frame .em-x-row .em-x-tools button { padding: 3px 6px; font-size: 11px; }
.em-frame .em-check { display: flex; align-items: center; gap: 6px; margin: 3px 0; }
.em-frame .em-row select.em-wide, .em-frame input.em-wide { max-width: none; width: 100%; box-sizing: border-box; }
:root[data-theme="light"] .em-frame .em-bind, :root[data-theme="light"] .em-frame .em-x-row { background: rgba(0,0,0,0.04); }
:root[data-theme="light"] .em-frame .em-seg { border-color: rgba(0,0,0,0.2); }
`;

const ATTR_LABEL = { current_position: 'Position', current_tilt_position: 'Tilt position', brightness: 'Brightness', rgb_color: 'Colour (rgb)' };
const TRANSFORM_LABEL = { identity: 'As reported', pct255: '0-255 to %', invert: 'Inverted (100 - value)', onOff: 'On / off', rgb: 'RGB to colour' };
const ROW_KIND_LABEL = { media: 'Media player', light: 'Light', switch: 'Switch' };
const EXTRA_KIND_LABEL = { light: 'Light', cover: 'Cover', switch: 'Switch', script: 'Script button' };

export function createBindingPanels(api) {
  if (typeof document !== 'undefined' && !document.getElementById('em-b-style')) {
    const st = document.createElement('style'); st.id = 'em-b-style'; st.textContent = CSS; document.head.appendChild(st);
  }
  // The picker's list: fetched once per edit session, dropped on exit.
  let entities = null, entitiesErr = null, entitiesLoading = null;
  const modeOf = new Map();     // binding key -> 'static'|'entity' chosen but not yet bound
  const openPicker = { id: null };
  const extrasDraft = new Map();  // room -> the extra rows being edited (incomplete ones included)
  const timers = new Map();

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function later(key, ms, fn) {
    if (timers.has(key)) clearTimeout(timers.get(key));
    timers.set(key, setTimeout(() => { timers.delete(key); fn(); }, ms));
  }
  function guard(fn) {
    try { fn(); return true; } catch (e) { api.message('Not kept: ' + e.message); return false; }
  }
  const nameOf = id => {
    const e = entities && entities.find(x => x.entity_id === id);
    return e ? e.friendly_name : null;
  };

  function loadEntities() {
    if (entities) return Promise.resolve(entities);
    if (entitiesLoading) return entitiesLoading;
    entitiesErr = null;
    entitiesLoading = Promise.resolve()
      .then(() => api.listEntities(PICKER_DOMAINS.slice()))
      .then(list => { entities = Array.isArray(list) ? list : []; return entities; },
        e => { entitiesErr = (e && e.message) || 'Home Assistant is not connected'; return null; })
      .finally(() => { entitiesLoading = null; });
    return entitiesLoading;
  }

  function seg(options, value, onPick) {
    const box = el('div', 'em-seg');
    options.forEach(([v, label]) => {
      const b = el('button', v === value ? 'on' : '', label);
      b.type = 'button';
      b.dataset.mode = v;
      b.setAttribute('aria-pressed', String(v === value));
      b.addEventListener('click', () => { if (v !== value) onPick(v); });
      box.append(b);
    });
    return box;
  }

  /**
   * An entity field: what is bound (friendly name + id) and a Choose button
   * that opens the searchable list, filtered to `domains`. `id` names the
   * field so a re-render keeps the list open.
   */
  function entityPicker({ id, domains, value, onPick, emptyText }) {
    const box = el('div', 'em-ent'); box.dataset.picker = id;
    const cur = el('div', 'em-ent-cur');
    const txt = el('div');
    txt.style.minWidth = '0';
    const nm = el('div', 'em-ent-name', value ? (nameOf(value) || value) : (emptyText || 'No entity chosen'));
    txt.append(nm);
    if (value) txt.append(el('div', 'em-ent-id', value));
    const btn = el('button', 'em-btn', openPicker.id === id ? 'Close' : value ? 'Change' : 'Choose…');
    btn.type = 'button';
    btn.dataset.pickerOpen = id;
    cur.append(txt, btn);
    box.append(cur);
    const list = el('div');
    box.append(list);
    btn.addEventListener('click', () => { openPicker.id = openPicker.id === id ? null : id; api.rerender(); });
    if (openPicker.id !== id) return box;
    const q = el('input', 'em-search'); q.type = 'search'; q.placeholder = 'Search ' + domains.join(' / ') + '…';
    q.setAttribute('aria-label', 'Search Home Assistant entities');
    q.dataset.pickerSearch = id;
    const res = el('div', 'em-ent-list');
    const pick = e => { openPicker.id = null; onPick(e); };
    const paint = () => {
      res.textContent = '';
      if (!entities) {
        res.append(el('div', 'em-mini', entitiesLoading ? 'Asking Home Assistant…'
          : (entitiesErr || 'Home Assistant is not connected') + '. Type an entity id instead:'));
        if (!entitiesLoading) {
          const row = el('div', 'em-ent-cur');
          const inp = el('input', 'em-search'); inp.placeholder = domains[0] + '.example'; inp.dataset.pickerManual = id;
          const use = el('button', 'em-btn', 'Use'); use.type = 'button';
          use.addEventListener('click', () => {
            const v = inp.value.trim();
            if (!ENTITY_RE.test(v) || domains.indexOf(v.split('.')[0]) === -1) { api.message('That is not a ' + domains.join(' / ') + ' entity id.'); return; }
            pick(v);
          });
          row.append(inp, use);
          res.append(row);
        }
        return;
      }
      const found = filterEntities(entities, q.value, domains);
      if (!found.length) { res.append(el('div', 'em-mini', 'Nothing matches.')); return; }
      found.slice(0, 80).forEach(e => {
        const b = el('button'); b.type = 'button'; b.dataset.entity = e.entity_id;
        b.append(el('div', 'em-ent-name', e.friendly_name), el('div', 'em-ent-id', e.entity_id));
        b.addEventListener('click', () => pick(e.entity_id));
        res.append(b);
      });
      if (found.length > 80) res.append(el('div', 'em-mini', (found.length - 80) + ' more: search to narrow.'));
    };
    q.addEventListener('input', paint);
    list.append(q, res);
    paint();
    if (!entities && !entitiesErr) loadEntities().then(paint);
    setTimeout(() => { try { q.focus({ preventScroll: true }); } catch (e) { /* old browser */ } }, 0);
    return box;
  }

  function select(options, value, onChange, labelOf) {
    const s = el('select');
    options.forEach(o => {
      const opt = el('option', null, labelOf ? labelOf(o) : String(o));
      opt.value = o == null ? '' : String(o);
      if (o === value || (o == null && value == null)) opt.selected = true;
      s.append(opt);
    });
    s.addEventListener('change', () => onChange(s.value === '' ? null : s.value));
    return s;
  }
  function inlineRow(label, control) {
    const r = el('div', 'em-row inline');
    r.append(el('label', null, label), control);
    return r;
  }
  function rangeRow(id, label, min, max, value, unit, onInput) {
    const r = el('div', 'em-row');
    const lab = el('label');
    const val = el('span', 'em-val', Math.round(value) + unit);
    lab.append(el('span', null, label), val);
    const inp = el('input', 'slider');
    Object.assign(inp, { type: 'range', min, max, step: 1, id });
    inp.value = String(value);
    inp.setAttribute('aria-label', label);
    const paint = () => inp.style.setProperty('--p', ((+inp.value - min) / ((max - min) || 1) * 100) + '%');
    paint();
    inp.addEventListener('input', () => { val.textContent = inp.value + unit; paint(); onInput(+inp.value); });
    r.append(lab, inp);
    return r;
  }
  function sourceNote(b) {
    if (!b) return null;
    const where = b.source === 'legacy' ? 'its usual rooms.json slot' : 'rooms.json `bindings`';
    const more = b.entities.length > 1 ? ' (with ' + (b.entities.length - 1) + ' more entit' + (b.entities.length > 2 ? 'ies' : 'y') + ', kept)' : '';
    return el('div', 'em-mini', 'Saved in ' + where + more + '.');
  }

  // ---- Curtain: open position --------------------------------------------------
  function curtainSection(into, id) {
    const key = curtainKey(id);
    const b = bindingOf(api.rooms(), key);
    const mode = modeOf.get(key) || (b ? 'entity' : 'static');
    const box = el('div', 'em-bind'); box.id = 'em-bind-curtain';
    const head = el('div', 'em-bind-head');
    head.append(el('span', null, 'Open position'), seg([['static', 'Static'], ['entity', 'Entity']], mode, m => {
      if (m === 'static' && b) { if (!guard(() => api.setRooms(setTargetBinding(api.rooms(), key, null)))) return; }
      modeOf.set(key, m);
      api.rerender();
    }));
    box.append(head);
    if (mode === 'static') {
      box.append(rangeRow('em-b-openpct', 'Open', 0, 100, api.curtainOpen(id), '%', v => {
        api.previewCurtain(id, v);
        later('curtain:' + id, 150, () => guard(() => api.setGeometry(setCurtainOpenPct(api.geometry(), id, v))));
      }));
      box.append(el('div', 'em-mini', 'How it hangs. Saved in geometry.json; no Home Assistant entity.'));
    } else {
      const ch = b ? b.channels.openPct : null;
      const write = patch => guard(() => {
        const next = Object.assign({ attribute: 'current_position', transform: 'identity' }, ch || {}, patch);
        api.setRooms(setTargetBinding(api.rooms(), key, { openPct: next }));
        modeOf.delete(key);
        api.rerender();
      });
      box.append(entityPicker({ id: 'curtain:' + id, domains: ['cover'], value: ch && ch.entity, onPick: e => write({ entity: e }) }));
      if (ch) {
        const c = CHANNEL_CHOICES['curtain.openPct'];
        box.append(inlineRow('Reads', select(c.attributes, ch.attribute, v => write({ attribute: v }), a => ATTR_LABEL[a] || a)));
        box.append(inlineRow('Transform', select(c.transforms, ch.transform, v => write({ transform: v }), t => TRANSFORM_LABEL[t] || t)));
        const n = sourceNote(b); if (n) box.append(n);
      }
    }
    into.append(box);
  }

  // ---- Light channels ----------------------------------------------------------------
  function lightBlock(into, room, channel, label) {
    const key = lightKey(room, channel);
    const b = bindingOf(api.rooms(), key);
    const mode = modeOf.get(key) || (b ? 'entity' : 'static');
    const box = el('div', 'em-bind'); box.dataset.light = key;
    const head = el('div', 'em-bind-head');
    head.append(el('span', null, label), seg([['static', 'Static'], ['entity', 'Entity']], mode, m => {
      if (m === 'static' && b) { if (!guard(() => api.setRooms(setTargetBinding(api.rooms(), key, null)))) return; }
      modeOf.set(key, m);
      api.rerender();
    }));
    box.append(head);
    if (mode === 'static') {
      if (!hasFixture(api.geometry(), room, channel)) {
        box.append(el('div', 'em-mini', 'Nothing is drawn on this channel, so it has no static look. Bind it to an entity to give it a sidebar switch.'));
        into.append(box);
        return;
      }
      const st = Object.assign({ on: false, brightness: 100, color: '#ffb46b' }, fixtureStatic(api.geometry(), room, channel) || {});
      const write = patch => {
        const next = Object.assign({}, st, patch);
        Object.assign(st, patch);
        api.previewLight(room, channel, { on: next.on, bri: next.brightness, color: next.color });
        later('light:' + key, 150, () => guard(() => api.setGeometry(setFixtureStatic(api.geometry(), room, channel,
          channel === 'main' ? { on: next.on, brightness: next.brightness } : next))));
      };
      const on = el('input'); on.type = 'checkbox'; on.checked = !!st.on;
      on.addEventListener('change', () => write({ on: on.checked }));
      box.append(inlineRow('On', on));
      box.append(rangeRow('em-b-bri-' + channel, 'Brightness', 0, 100, st.brightness, '%', v => write({ brightness: v })));
      if (channel !== 'main') {
        const c = el('input'); c.type = 'color'; c.value = st.color;
        c.addEventListener('input', () => write({ color: c.value }));
        box.append(inlineRow('Colour', c));
      }
      box.append(el('div', 'em-mini', 'Shown while no entity drives it. Saved in geometry.json.'));
    } else {
      const ch = b ? b.channels : null;
      const write = (entity, briT) => guard(() => {
        const e = entity || (ch && ch.on.entity);
        if (!e) return;
        const t = briT || (ch && ch.brightness ? ch.brightness.transform : 'pct255');
        api.setRooms(setTargetBinding(api.rooms(), key, { on: { entity: e }, brightness: { entity: e, transform: t }, color: { entity: e } }));
        modeOf.delete(key);
        api.rerender();
      });
      box.append(entityPicker({ id: key, domains: ['light'], value: ch && ch.on.entity, onPick: e => write(e) }));
      if (ch) {
        box.append(inlineRow('Brightness', select(CHANNEL_CHOICES['light.brightness'].transforms, ch.brightness.transform,
          v => write(null, v), t => TRANSFORM_LABEL[t] || t)));
        box.append(el('div', 'em-mini', 'On / off from its state, colour from rgb_color.'));
        const n = sourceNote(b); if (n) box.append(n);
      }
    }
    into.append(box);
  }
  function roomLightsSection(into, room) {
    const chans = api.lightChannels(room);
    if (!chans.length) { into.append(el('div', 'em-mini', 'This room has no light channels.')); return; }
    chans.forEach(c => lightBlock(into, room, c.channel, c.label));
  }

  // ---- A furniture item's tap-card rows ------------------------------------------------
  function itemSection(into, itemId, room) {
    const rows = itemRows(api.rooms(), itemId);
    const box = el('div'); box.id = 'em-bind-item';
    if (!rows.length) box.append(el('div', 'em-mini', 'Not bound: tapping it opens no card. Add a row to bind it.'));
    rows.forEach((r, i) => {
      const line = el('div', 'em-x-row');
      const left = el('div');
      left.append(el('div', 'em-mini', ROW_KIND_LABEL[r.kind] + (r.label ? ' · ' + r.label : '')));
      left.append(entityPicker({ id: 'item:' + itemId + ':' + i, domains: ITEM_ROW_KINDS[r.kind].domains, value: r.entity,
        onPick: e => { if (guard(() => api.setRooms(setItemRowEntity(api.rooms(), itemId, r, e)))) api.rerender(); } }));
      const tools = el('div', 'em-x-tools');
      const rm = el('button', 'em-btn danger', '✕'); rm.type = 'button'; rm.title = 'Remove this row'; rm.setAttribute('aria-label', 'Remove this row');
      rm.addEventListener('click', () => { if (guard(() => api.setRooms(removeItemRow(api.rooms(), itemId, r)))) api.rerender(); });
      tools.append(rm);
      line.append(left, tools);
      box.append(line);
    });
    // Add a row: a kind, then an entity.
    const addKey = 'item-add:' + itemId;
    const kind = modeOf.get(addKey) || 'light';
    const add = el('div', 'em-bind');
    add.append(inlineRow('Add a row', select(Object.keys(ITEM_ROW_KINDS), kind, v => { modeOf.set(addKey, v); api.rerender(); }, k => ROW_KIND_LABEL[k])));
    add.append(entityPicker({ id: addKey, domains: ITEM_ROW_KINDS[kind].domains, value: null, emptyText: 'Pick its entity',
      onPick: e => { if (guard(() => api.setRooms(addItemRow(api.rooms(), itemId, kind, e)))) api.rerender(); } }));
    box.append(add);
    // Show in the room's sidebar (opt-in: off unless chosen).
    const cfg = roomSidebar(api.rooms(), room);
    const k = 'item:' + itemId;
    const lab = el('label', 'em-check');
    const cb = el('input'); cb.type = 'checkbox'; cb.id = 'em-b-show'; cb.checked = cfg.show.indexOf(k) !== -1; cb.disabled = !rows.length;
    lab.append(cb, document.createTextNode('Show in the room sidebar'));
    cb.addEventListener('change', () => {
      const show = cb.checked ? cfg.show.concat([k]) : cfg.show.filter(x => x !== k);
      writeSidebar(room, Object.assign({}, cfg, { show }));
    });
    box.append(lab);
    if (!rows.length) box.append(el('div', 'em-mini', 'A row needs an entity before it can show in the sidebar.'));
    into.append(box);
  }

  // ---- The room sidebar editor (B4) ------------------------------------------------------
  function writeSidebar(room, cfg) {
    const extras = (cfg.extra || []).filter(x => x && x.kind && x.entity && x.label && x.label.trim());
    const clean = { hide: cfg.hide || [], show: cfg.show || [], extra: extras };
    if (!guard(() => api.setRooms(setRoomSidebar(api.rooms(), room, clean)))) return;
    api.previewSidebar(room, roomSidebar(api.rooms(), room));
  }
  function sidebarSection(into, room) {
    const cfg = roomSidebar(api.rooms(), room);
    if (!extrasDraft.has(room)) extrasDraft.set(room, cfg.extra.map(x => Object.assign({}, x)));
    const extras = extrasDraft.get(room);
    const box = el('div'); box.id = 'em-sidebar-editor';
    const save = () => writeSidebar(room, { hide: cfg.hide, show: cfg.show, extra: extras });

    // Derived rows.
    box.append(el('div', 'em-group', 'Rows from this room\'s devices'));
    const derived = api.derivedRows(room);
    if (!derived.length) box.append(el('div', 'em-mini', 'None.'));
    const groupOf = key => { const i = key.indexOf(':'); return i > 0 ? SIDEBAR_GROUPS[key.slice(0, i)] || null : null; };
    const hidden = key => cfg.hide.indexOf(key) !== -1 || (groupOf(key) && cfg.hide.indexOf(groupOf(key)) !== -1);
    derived.forEach(d => {
      const lab = el('label', 'em-check');
      const cb = el('input'); cb.type = 'checkbox'; cb.checked = !hidden(d.key); cb.dataset.row = d.key;
      cb.addEventListener('change', () => {
        let hide = cfg.hide.slice();
        const g = groupOf(d.key);
        if (cb.checked) {
          if (g && hide.indexOf(g) !== -1) {
            hide = hide.filter(h => h !== g);
            derived.forEach(o => { if (o.key !== d.key && groupOf(o.key) === g && hide.indexOf(o.key) === -1) hide.push(o.key); });
          }
          hide = hide.filter(h => h !== d.key);
        } else if (hide.indexOf(d.key) === -1) hide.push(d.key);
        cfg.hide = hide;
        save();
      });
      lab.append(cb, document.createTextNode(d.label));
      box.append(lab);
    });

    // Opt-in item rows.
    const bound = api.roomFurniture(room).filter(f => itemRows(api.rooms(), f.id).length);
    box.append(el('div', 'em-group', 'Furniture rows (off unless chosen)'));
    if (!bound.length) box.append(el('div', 'em-mini', 'No furniture in this room is bound to Home Assistant.'));
    bound.forEach(f => {
      const k = 'item:' + f.id;
      const lab = el('label', 'em-check');
      const cb = el('input'); cb.type = 'checkbox'; cb.checked = cfg.show.indexOf(k) !== -1; cb.dataset.row = k;
      cb.addEventListener('change', () => {
        cfg.show = cb.checked ? cfg.show.concat([k]) : cfg.show.filter(x => x !== k);
        save();
      });
      lab.append(cb, document.createTextNode(f.label));
      box.append(lab);
    });

    // Extra rows.
    box.append(el('div', 'em-group', 'Extra rows'));
    if (!extras.length) box.append(el('div', 'em-mini', 'Add a light group, a cover, a switch or a script button that no single device owns.'));
    extras.forEach((x, i) => {
      const line = el('div', 'em-x-row'); line.dataset.extra = String(i);
      const left = el('div');
      const kindSel = select(Object.keys(EXTRA_KINDS), x.kind, v => {
        x.kind = v;
        if (x.entity && EXTRA_KINDS[v].indexOf(x.entity.split('.')[0]) === -1) x.entity = '';
        if (v !== 'script') delete x.confirm;
        save(); api.rerender();
      }, k => EXTRA_KIND_LABEL[k]);
      kindSel.className = 'em-wide';
      left.append(kindSel);
      const lbl = el('input', 'em-search em-wide'); lbl.placeholder = 'Label, e.g. Kill room'; lbl.value = x.label || '';
      lbl.setAttribute('aria-label', 'Row label');
      lbl.addEventListener('change', () => { x.label = lbl.value.trim(); save(); });
      left.append(lbl);
      left.append(entityPicker({ id: 'extra:' + room + ':' + i, domains: EXTRA_KINDS[x.kind], value: x.entity || null,
        onPick: e => { x.entity = e; save(); api.rerender(); } }));
      if (x.kind === 'script') {
        const lab = el('label', 'em-check');
        const cb = el('input'); cb.type = 'checkbox'; cb.checked = !!x.confirm;
        cb.addEventListener('change', () => { x.confirm = cb.checked; save(); });
        lab.append(cb, document.createTextNode('Tap twice to confirm (like Kill room)'));
        left.append(lab);
      }
      if (!x.entity || !x.label) left.append(el('div', 'em-mini', 'Needs a label and an entity before it is saved.'));
      const tools = el('div', 'em-x-tools');
      const mk = (txt, title, fn, dis) => {
        const b = el('button', 'em-btn', txt); b.type = 'button'; b.title = title; b.setAttribute('aria-label', title); b.disabled = !!dis;
        b.addEventListener('click', fn); tools.append(b);
      };
      mk('↑', 'Move up', () => { extras.splice(i - 1, 0, extras.splice(i, 1)[0]); save(); api.rerender(); }, i === 0);
      mk('↓', 'Move down', () => { extras.splice(i + 1, 0, extras.splice(i, 1)[0]); save(); api.rerender(); }, i === extras.length - 1);
      mk('✕', 'Remove', () => { extras.splice(i, 1); save(); api.rerender(); });
      line.append(left, tools);
      box.append(line);
    });
    const add = el('button', 'em-btn em-add', 'Add a row'); add.type = 'button'; add.id = 'em-extra-add';
    add.addEventListener('click', () => { extras.push({ kind: 'light', label: '', entity: '' }); api.rerender(); });
    box.append(add);
    into.append(box);
  }

  return {
    curtainSection, lightBlock, roomLightsSection, itemSection, sidebarSection,
    /** Edit mode closed: drop the entity list and every half-made edit. */
    reset() {
      entities = null; entitiesErr = null; entitiesLoading = null;
      modeOf.clear(); extrasDraft.clear(); openPicker.id = null;
      timers.forEach(t => clearTimeout(t)); timers.clear();
    },
    /** The rooms document changed under the editor (Save / Discard): re-read the extras. */
    resync() { extrasDraft.clear(); },
    hasEntityList: () => !!entities,
  };
}
