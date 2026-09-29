#!/usr/bin/env node
/**
 * Frame TVs: an item card's `actions` row (a button that runs a script) and a
 * TV row's `art` condition (the card reads "Art", the 3D screen shows an art
 * picture). No framework, no install: `node scripts/test-frame-art.mjs`.
 *
 *   1. script-call.js -- the shared guarded sender and the single-tap
 *      button: the exact call, every gate, Sent / Not sent, a tap while
 *      "Sent" shows is ignored, nothing sent while not writable.
 *   2. item-cards.js -- actions normalised (a non-script or a list of
 *      variables drops the row), the art condition kept on tv rows only,
 *      recorded (cardEntities) and its attribute watched; the TV row reads
 *      "Art" only while the TV is on and the condition holds.
 *   3. tv-screen.js -- the art condition's rules, the screen's mode, and
 *      the BUILT screen in the art look: the art picture swapped in as the
 *      emissive map on the same material with no program change, matte,
 *      dimmer; the controller applies 'art' set before attach and repaints
 *      once per real change.
 *   4. ha-client.js against the fake HA socket (never a real HA): the art
 *      entity is recorded, and a change of its watched attribute fires
 *      onItemEntityChange; an unwatched attribute does not.
 *   5. tap-popovers.js markup: action buttons in each state, disabled while
 *      offline; the TV row in art mode. Plus the click wiring and index.html
 *      (source, whitespace-stripped: neither can run in node).
 *
 * Fictional entity ids only -- this repo is public.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { installFakeHA } from './fake-ha-websocket.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const imp = rel => import(pathToFileURL(path.join(root, rel)).href);
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');
const THREE = await imp('vendor/three-r160/three.module.min.js');
const SC = await imp('src/script-call.js');
const IC = await imp('src/item-cards.js');
const TV = await imp('src/furniture/tv-screen.js');
const SI = await imp('src/furniture/small-items.js');
const { HAClient } = await imp('src/ha-client.js');

let passes = 0, failures = 0;
function check(name, ok, detail) {
  if (ok) { passes++; return; }
  failures++;
  console.error('FAIL ' + name + (detail !== undefined ? ' -- ' + JSON.stringify(detail) : ''));
}
const quiet = fn => { const w = console.warn, l = console.log; console.warn = () => {}; console.log = () => {}; try { return fn(); } finally { console.warn = w; console.log = l; } };

// ---- 1. the shared guarded sender and the single-tap button --------------------
{
  const b = { entity: 'script.demo_tv_art', variables: { tv: 'media_player.demo_tv', n: 2 } };
  const cmd = SC.scriptCommand(b);
  check('command: script.turn_on with the variables, targeting the script',
    JSON.stringify(cmd) === JSON.stringify({ domain: 'script', service: 'turn_on', data: { variables: { tv: 'media_player.demo_tv', n: 2 } },
      target: { entity_id: 'script.demo_tv_art' } }), cmd);
  check('command: the variables are a copy', cmd.data.variables !== b.variables);
  check('command: no variables -> an empty object', JSON.stringify(SC.scriptCommand({ entity: 'script.demo_x' }).data) === '{"variables":{}}');
  check('command: a non-script entity -> none', SC.scriptCommand({ entity: 'light.demo_x' }) === null &&
    SC.scriptCommand({ entity: 'script.Demo-x' }) === null && SC.scriptCommand(null) === null);
  // The room script's command IS this one.
  const RS = await imp('src/room-script.js');
  check('command: the room script uses the same command', JSON.stringify(RS.roomScriptCommand(b)) === JSON.stringify(cmd));

  const calls = [];
  const client = { callService: (...a) => { calls.push(a); return true; } };
  check('send: goes out, returns the client\'s answer', SC.sendScript(client, b, () => true) === true && calls.length === 1 &&
    calls[0][0] === 'script' && calls[0][1] === 'turn_on' && calls[0][3].entity_id === 'script.demo_tv_art', calls);
  check('send: not writable -> nothing', SC.sendScript(client, b, () => false) === false && calls.length === 1);
  check('send: no client -> nothing', SC.sendScript(null, b, () => true) === false);
  check('send: a non-script binding -> nothing', SC.sendScript(client, { entity: 'switch.demo_x' }, () => true) === false && calls.length === 1);
  check('send: a client that drops it -> false', SC.sendScript({ callService: () => false }, b, () => true) === false);
  // Only an explicit `true` counts as sent: a client answering undefined,
  // 1 or an object did not confirm the call went out.
  check('send: only callService\'s === true is "sent"', [undefined, null, 1, 'ok', {}].every(v =>
    SC.sendScript({ callService: () => v }, b, () => true) === false));

  // The button, with a hand-cranked timer.
  let timers = [];
  const setTimer = (fn, ms) => { const t = { ms }; t.fn = () => { timers = timers.filter(x => x !== t); fn(); }; timers.push(t); return t; };
  const clearTimer = t => { timers = timers.filter(x => x !== t); };
  let sends = 0, ok = true, writable = true;
  const states = [];
  const btn = SC.createActionButton({ send: () => { sends++; return ok; }, writable: () => writable,
    onChange: s => states.push(s), setTimer, clearTimer, resultMs: 2500 });
  check('button: starts idle, nothing sent', btn.state === 'idle' && sends === 0);
  check('button: a tap sends once and shows sent', btn.press() === true && sends === 1 && btn.state === 'sent');
  check('button: a tap while "Sent" shows is ignored (a double tap is one launch)', btn.press() === false && sends === 1);
  check('button: back to idle after resultMs', timers.length === 1 && timers[0].ms === 2500 && (timers[0].fn(), btn.state === 'idle'));
  ok = false;
  check('button: a failed send shows failed', btn.press() === false && sends === 2 && btn.state === 'failed');
  ok = true;
  check('button: failed can retry at once', btn.press() === true && sends === 3 && btn.state === 'sent');
  check('button: a retry replaced the old timer', timers.length === 1, timers.length);
  btn.reset();
  writable = false;
  check('button: not writable -> nothing sent, state unchanged', btn.press() === false && sends === 3 && btn.state === 'idle');
  check('button: onChange saw each state', states.join() === 'sent,idle,failed,sent,idle', states);
  // HELD ENTER: the key auto-repeats a click every ~30 ms on the focused
  // button (the card keeps focus on it across redraws). Over 10 s that must
  // be ONE send; releasing and pressing again is a second.
  {
    let now = 0, due = [], n = 0;
    const setT = (fn, ms) => { const t = { at: now + ms, fn }; due.push(t); return t; };
    const clearT = t => { due = due.filter(x => x !== t); };
    const advance = to => {
      for (;;) { due.sort((a, c) => a.at - c.at); const t = due[0]; if (!t || t.at > to) break; due.shift(); now = t.at; t.fn(); }
      now = to;
    };
    const held = SC.createActionButton({ send: () => { n++; return true; }, writable: () => true, setTimer: setT, clearTimer: clearT, resultMs: 2500 });
    const intent = SC.createKeyIntent();
    const keyRepeatClick = () => { intent.keyDown('Enter'); held.press({ keyboard: intent.click(0) }); };
    for (let t = 0; t <= 10000; t += 30) { advance(t); keyRepeatClick(); }
    check('held Enter for 10 s: exactly one send', n === 1, n);
    check('held Enter: the button went back to idle meanwhile (only the key guard stopped it)', held.state === 'idle', held.state);
    held.keyUp();
    keyRepeatClick();
    check('release, then Enter again: a second send', n === 2, n);
    advance(now + 3000);
    check('a pointer tap is never blocked by the key guard', held.press() === true && n === 3, n);
    held.keyUp(); advance(now + 3000);
    // A keyboard press refused because HA is offline does not arm the guard.
    let w = false;
    const off = SC.createActionButton({ send: () => { n++; return true; }, writable: () => w, setTimer: setT, clearTimer: clearT });
    off.press({ keyboard: true });
    w = true;
    check('an offline keyboard press leaves the next one free to send', off.press({ keyboard: true }) === true && n === 4, n);
    // A failed keyboard send also waits for the release (no resend loop).
    let m = 0;
    const bad = SC.createActionButton({ send: () => { m++; return false; }, writable: () => true, setTimer: setT, clearTimer: clearT });
    bad.press({ keyboard: true }); bad.press({ keyboard: true });
    check('a failed keyboard send is not retried by the held key', m === 1, m);
    bad.keyUp();
    check('...but is after a release', bad.press({ keyboard: true }) === false && m === 2, m);
  }
  check('keys: Enter and Space activate, others do not', SC.isActivationKey('Enter') && SC.isActivationKey(' ') && !SC.isActivationKey('a'));
  check('button text', SC.actionButtonText('Art mode', 'idle') === 'Art mode' && SC.actionButtonText('Art mode', 'sent') === 'Sent' &&
    SC.actionButtonText('Art mode', 'sent', true) === 'Sent (sample)' && /^Not sent/.test(SC.actionButtonText('Art mode', 'failed')));
}

// ---- 2. item-cards: actions and the art condition ------------------------------
const ART = { entity: 'remote.demo_stick', attribute: 'current_activity', value: 'example.photo.frame' };
{
  const acts = IC.normaliseActions([
    { entity: 'script.demo_tv_art', label: 'Art mode', icon: 'art', variables: { tv: 'media_player.demo_tv' } },
    { entity: 'script.demo_plain' },
    { entity: 'light.demo_not_a_script', label: 'Nope' },
    { entity: 'script.demo_bad_vars', variables: ['x'] },
    { entity: 'script.demo_bad_icon', icon: '<b>' },
    null
  ]);
  check('actions: a non-script row and a list of variables are dropped', acts.map(a => a.entity).join() ===
    'script.demo_tv_art,script.demo_plain,script.demo_bad_icon', acts.map(a => a.entity));
  check('actions: label, icon and variables kept', acts[0].label === 'Art mode' && acts[0].icon === 'art' && acts[0].variables.tv === 'media_player.demo_tv');
  check('actions: missing variables -> {}, a bad icon -> null', JSON.stringify(acts[1].variables) === '{}' && acts[2].icon === null);
  check('actions: nothing -> []', IC.normaliseActions(undefined).length === 0);
  const card = IC.normaliseCard({ title: 'Frame TV', media: [
    { entity: 'media_player.demo_tv', role: 'tv', art: ART },
    { entity: 'media_player.demo_cast', role: 'cast', art: ART }
  ], actions: [{ entity: 'script.demo_tv_art' }] }, 0);
  check('card: the tv row keeps its art condition', !!card.media[0].art && card.media[0].art.value === 'example.photo.frame');
  check('card: a non-tv row\'s art is ignored', card.media[1].art === null);
  check('card: actions carried', card.actions.length === 1);
  check('card: an actions-only card is a card', !!IC.normaliseCard({ actions: [{ entity: 'script.demo_x' }] }, 0));
  check('card: a malformed art condition -> none', IC.normaliseCard({ media: [{ entity: 'media_player.demo_tv', role: 'tv',
    art: { entity: 'remote.demo_stick' } }] }, 0).media[0].art === null);
  const map = IC.normaliseItemBindings({ frame: { media: [{ entity: 'media_player.demo_tv', role: 'tv', art: ART }],
    actions: [{ entity: 'script.demo_tv_art' }] } });
  const ents = IC.itemBindingEntities(map);
  check('record: the art entity is read like any bound entity', ents.has('remote.demo_stick') && ents.has('media_player.demo_tv'), [...ents]);
  check('record: a script is not read (nothing to show)', !ents.has('script.demo_tv_art'));
  const watched = IC.itemWatchedAttributes(map);
  check('watch: the art attribute is watched', JSON.stringify([...watched]) === JSON.stringify([['remote.demo_stick', ['current_activity']]]), [...watched]);
  check('watch: a state-compare condition watches no attribute', IC.itemWatchedAttributes(IC.normaliseItemBindings({ f: { media: [
    { entity: 'media_player.demo_tv', role: 'tv', art: { entity: 'select.demo_mode', value: 'art' } }] } })).size === 0);

  const tvOn = { state: 'on', attributes: {} };
  const inArt = { state: 'on', attributes: { current_activity: 'example.photo.frame' } };
  const home = { state: 'on', attributes: { current_activity: 'example.launcher' } };
  const art = IC.normaliseItemBindings({ f: { media: [{ entity: 'media_player.demo_tv', role: 'tv', art: ART }] } }).get('f')[0].media[0].art;
  const m1 = IC.mediaRowModel(tvOn, art, inArt);
  check('row: on + the condition -> "Art"', m1.art === true && m1.stateText === 'Art' && m1.on === true, m1);
  check('row: on, another app -> On', IC.mediaRowModel(tvOn, art, home).art === false && IC.mediaRowModel(tvOn, art, home).stateText === 'On');
  check('row: off stays Off whatever the condition', IC.mediaRowModel({ state: 'off', attributes: {} }, art, inArt).stateText === 'Off' &&
    IC.mediaRowModel({ state: 'off', attributes: {} }, art, inArt).art === false);
  check('row: unavailable stays Offline', IC.mediaRowModel({ state: 'unavailable' }, art, inArt).stateText === 'Offline');
  check('row: no condition -> never art', IC.mediaRowModel(tvOn).art === false);
  check('row: the demo\'s sample art entity is off', IC.mockItemState('art', {}, 0).state === 'off');
}

// ---- 3. tv-screen: the condition, the mode, the built screen -------------------
{
  const cond = TV.normaliseArtCondition(ART);
  check('condition: kept', !!cond && cond.attribute === 'current_activity');
  check('condition: malformed -> null', TV.normaliseArtCondition({ entity: 'remote.demo_x' }) === null &&
    TV.normaliseArtCondition({ entity: 'Remote X', value: 'a' }) === null && TV.normaliseArtCondition({ entity: 'remote.demo_x', value: 'a', attribute: '' }) === null &&
    TV.normaliseArtCondition(['x']) === null);
  check('holds: on + attribute match', TV.artHolds(cond, { state: 'on', attributes: { current_activity: 'example.photo.frame' } }) === true);
  check('holds: NOT when the entity is off, even with the attribute', TV.artHolds(cond, { state: 'off', attributes: { current_activity: 'example.photo.frame' } }) === false);
  check('holds: NOT for another value / no reading', TV.artHolds(cond, { state: 'on', attributes: { current_activity: 'x' } }) === false &&
    TV.artHolds(cond, null) === false);
  const byState = TV.normaliseArtCondition({ entity: 'select.demo_mode', value: 'art' });
  check('holds: with no attribute, the STATE is compared', TV.artHolds(byState, { state: 'art', attributes: {} }) === true &&
    TV.artHolds(byState, { state: 'on', attributes: {} }) === false);
  const inArt = { state: 'on', attributes: { current_activity: 'example.photo.frame' } };
  check('mode: off TV -> off, whatever the art says', TV.tvScreenMode({ state: 'off' }, cond, inArt) === 'off' &&
    TV.tvScreenMode({ state: 'standby' }, cond, inArt) === 'off' && TV.tvScreenMode(null, cond, inArt) === 'off');
  check('mode: on + holds -> art', TV.tvScreenMode({ state: 'on' }, cond, inArt) === 'art' && TV.tvScreenMode({ state: 'idle' }, cond, inArt) === 'art');
  check('mode: on, no condition / not holding -> on', TV.tvScreenMode({ state: 'playing' }, null, null) === 'on' &&
    TV.tvScreenMode({ state: 'on' }, cond, { state: 'off', attributes: {} }) === 'on');
  check('tvMode: art / truthy / off', TV.tvMode('art') === 'art' && TV.tvMode(true) === 'on' && TV.tvMode('on') === 'on' &&
    TV.tvMode(false) === 'off' && TV.tvMode('off') === 'off' && TV.tvMode(undefined) === 'off');
  const tb = TV.tvBindings({ f: { media: [{ entity: 'media_player.demo_tv', role: 'tv', art: ART }] }, g: { media: [{ entity: 'media_player.demo_g', role: 'tv' }] } });
  check('bindings: the tv entity and its condition', tb.get('f').entity === 'media_player.demo_tv' && tb.get('f').art.value === 'example.photo.frame' &&
    tb.get('g').art === null);
  check('bindings: tvEntityBindings still maps to the entity', TV.tvEntityBindings({ f: { media: [{ entity: 'media_player.demo_tv', role: 'tv', art: ART }] } }).get('f') === 'media_player.demo_tv');

  // The BUILT screen in each look.
  const screenOf = g => { let s = null; g.traverse(o => { if (o.isMesh && o.userData.tvScreen) s = o; }); return s; };
  const shape = m => JSON.stringify({ type: m.type, map: !!m.map, emissiveMap: !!m.emissiveMap, transparent: m.transparent,
    vertexColors: m.vertexColors, key: m.customProgramCacheKey(), hook: String(m.onBeforeCompile),
    texKind: m.emissiveMap && m.emissiveMap.constructor.name, cs: m.emissiveMap && m.emissiveMap.colorSpace,
    flipY: m.emissiveMap && m.emissiveMap.flipY, gen: m.emissiveMap && m.emissiveMap.generateMipmaps });
  for (const params of [{}, { bezelStyle: 'picture-frame' }]) {
    const label = params.bezelStyle || 'thin';
    const s = screenOf(SI.TYPES.tv.build(THREE, params, { detail: 'full' }));
    const mat = s.material, home = TV.tvHomeTexture(THREE), artTex = TV.tvArtTexture(THREE);
    const shape0 = shape(mat);
    check(label + ': built with the home picture, both pictures attached', mat.emissiveMap === home &&
      mat.userData.tvPictures.home === home && mat.userData.tvPictures.art === artTex && home !== artTex);
    check(label + ': ART lights the ART picture', TV.applyTvScreenLook(mat, 'art') === true && mat.emissiveMap === artTex &&
      mat.emissiveIntensity === TV.ART_INTENSITY && mat.emissive.getHex() === 0xffffff && mat.userData.tvMode === 'art' && mat.userData.tvOn === true);
    check(label + ': art is matte and has no sheen', mat.roughness === TV.ART_ROUGHNESS &&
      ['r', 'g', 'b'].every(k => mat.userData.tvSheen.value[k] === 0));
    check(label + ': art is dimmer than the home screen', TV.ART_INTENSITY < TV.ON_INTENSITY && TV.ART_INTENSITY > 0.3);
    check(label + ': ART keeps the program shape (same material, a map of the same kind)', shape(mat) === shape0 && s.material === mat,
      { before: shape0, after: shape(mat) });
    check(label + ': ART again is no change', TV.applyTvScreenLook(mat, 'art') === false);
    mat.emissiveMap = home;   // the picture swapped behind its back
    check(label + ': a wrong picture under the same mode is a change, and is put right', TV.applyTvScreenLook(mat, 'art') === true &&
      mat.emissiveMap === artTex);
    check(label + ': ON swaps the home picture back, glossy', TV.applyTvScreenLook(mat, 'on') === true && mat.emissiveMap === home &&
      mat.emissiveIntensity === TV.ON_INTENSITY && mat.roughness === TV.GLASS_ROUGHNESS && mat.userData.tvMode === 'on');
    check(label + ': art -> OFF is black glass', (TV.applyTvScreenLook(mat, 'art'), TV.applyTvScreenLook(mat, 'off')) === true &&
      mat.emissiveIntensity === 0 && mat.emissive.getHex() === 0 && mat.emissiveMap === home && mat.userData.tvOn === false &&
      mat.userData.tvSheen.value.r === TV.OFF_SHEEN);
  }
  check('pictures: one of each, shared by every TV', screenOf(SI.TYPES.tv.build(THREE, {}, {})).material.userData.tvPictures.art === TV.tvArtTexture(THREE));

  // The controller: 'art' before attach, one repaint per real change.
  const g = SI.TYPES.tv.build(THREE, {}, {});
  const mat = screenOf(g).material;
  let repaints = 0;
  const tvs = TV.createTvScreens(() => { repaints++; });
  tvs.set('f', 'art');
  check('controller: art before attach paints nothing yet', repaints === 0 && mat.userData.tvMode === 'off');
  tvs.attach({ f: { group: g } });
  check('controller: attach applies art', mat.userData.tvMode === 'art' && mat.emissiveMap === TV.tvArtTexture(THREE));
  tvs.set('f', 'art');
  check('controller: art again, no repaint', repaints === 0);
  tvs.set('f', true);
  check('controller: art -> on repaints once', repaints === 1 && mat.userData.tvMode === 'on');
  tvs.set('f', 'art');
  check('controller: on -> art repaints once', repaints === 2 && mat.userData.tvMode === 'art');
  check('spec helper: setTvScreensIn takes art', TV.setTvScreensIn(g, 'art') === 1 && mat.userData.tvMode === 'art');

  // The art picture draws something across the frame, with no words.
  const calls = [], texts = [];
  const ctx = new Proxy({}, {
    get(t, k) {
      if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => ({ addColorStop() {} });
      if (k === 'fillText' || k === 'strokeText') return s => texts.push(String(s));
      if (k in t) return t[k];
      return () => calls.push(k);
    },
    set(t, k, v) { t[k] = v; return true; }
  });
  TV.drawTvArt(ctx, TV.HOME_W, TV.HOME_H);
  check('art picture: many strokes and fills, no text', calls.filter(c => c === 'fill' || c === 'stroke').length > 500 && texts.length === 0,
    { n: calls.length, texts });
}

// ---- 4. ha-client: the art entity and its watched attribute --------------------
{
  const E = 'media_player.demo_frame_tv', R = 'remote.demo_frame_stick';
  const fake = installFakeHA({ states: [
    { entity_id: E, state: 'on', attributes: {} },
    { entity_id: R, state: 'on', attributes: { current_activity: 'example.launcher', battery: 90 } }
  ] });
  try {
    const ha = quiet(() => HAClient.create({ url: 'http://ha.invalid', token: 't', rooms: {}, wsReconnectMs: 10000,
      sensors: { items: { frame: { media: [{ entity: E, role: 'tv', art: { entity: R, attribute: 'current_activity', value: 'example.photo.frame' } }],
        actions: [{ entity: 'script.demo_tv_art' }] } } } }));
    const got = [];
    ha.onItemEntityChange((eid, raw) => got.push(eid + '=' + raw.state + '/' + (raw.attributes.current_activity || '')));
    const log = console.log; console.log = () => {};
    try { ha.connect(); await fake.whenConnected(ha); } finally { console.log = log; }
    check('ha: the snapshot reports the TV and the art entity', got.length === 2 && got.some(g => g.startsWith(R)), got);
    check('ha: the art entity is recorded', ha.getRawState(R) && ha.getRawState(R).attributes.current_activity === 'example.launcher');
    const sock = fake.sockets[fake.sockets.length - 1];
    const settle = () => new Promise(r => setTimeout(r, 20));
    sock.emitStateChanged({ entity_id: R, state: 'on', attributes: { current_activity: 'example.photo.frame', battery: 90 } }); await settle();
    check('ha: the watched attribute changing fires (state unchanged)', got[2] === R + '=on/example.photo.frame', got);
    sock.emitStateChanged({ entity_id: R, state: 'on', attributes: { current_activity: 'example.photo.frame', battery: 80 } }); await settle();
    check('ha: an unwatched attribute changing does not fire', got.length === 3, got);
    sock.emitStateChanged({ entity_id: E, state: 'on', attributes: { current_activity: 'nope', volume_level: 0.5 } }); await settle();
    check('ha: the TV\'s own attributes are not watched', got.length === 3, got);
    // What index.html then derives: art.
    const b = TV.tvBindings({ frame: { media: [{ entity: E, role: 'tv', art: { entity: R, attribute: 'current_activity', value: 'example.photo.frame' } }] } }).get('frame');
    check('ha -> screen: the recorded states give art', TV.tvScreenMode(ha.getRawState(E), b.art, ha.getRawState(R)) === 'art');
    check('ha: nothing was sent', fake.calls.length === 0, fake.calls);
    quiet(() => ha.disconnect());
  } finally { fake.restore(); }
}

// ---- 5. markup, click wiring, index.html ----------------------------------------
{
  const T = await imp('src/tap-popovers.js');
  const { ICONS } = await imp('src/ui-icons.js');
  const dot = k => '<i data-st="' + k + '"></i>';
  const tvRow = Object.assign({ label: 'TV', role: 'tv' }, IC.mediaRowModel({ state: 'on', attributes: {} }, ART,
    { state: 'on', attributes: { current_activity: 'example.photo.frame' } }));
  const act = (state, disabled) => ({ entity: 'script.demo_tv_art', label: 'Art mode', icon: 'art', state,
    text: SC.actionButtonText('Art mode', state), disabled });
  const html = (a, haOff) => T.popoverHtml.item({ name: 'Frame TV', status: 'ok', haOff: !!haOff, media: [tvRow], lights: [], readings: [], actions: [a] }, dot);
  const idle = html(act('idle', false));
  check('markup: the TV row reads Art', /<small class="on">Art<\/small>/.test(idle), idle.slice(0, 400));
  const mediaRow = (idle.match(/<div class="tp-irow" data-row="media">[\s\S]*?<\/div><\/div>/) || [''])[0];
  check('markup: ...with the picture-frame icon on the TV row itself', mediaRow.includes(ICONS.art) && !mediaRow.includes(ICONS.tv), mediaRow.slice(0, 200));
  check('markup: one action button, its label, enabled', (idle.match(/data-a="act"/g) || []).length === 1 && />Art mode<\/button>/.test(idle) &&
    !/data-a="act"[^>]*disabled/.test(idle));
  const sent = html(act('sent', false));
  check('markup: sent -> "Sent", aria-disabled, announced', />Sent<\/button>/.test(sent) && /class="tp-vb sent"/.test(sent) &&
    /aria-disabled="true"/.test(sent) && /role="status"[^>]*>Art mode: sent\.</.test(sent));
  check('markup: failed -> "Not sent", retry allowed', /Not sent/.test(html(act('failed', false))) && !/aria-disabled/.test(html(act('failed', false))));
  check('markup: disabled while offline', /data-a="act"[^>]*disabled/.test(html(act('idle', true), true)));
  check('markup: an unknown icon falls back to play', html(Object.assign(act('idle', false), { icon: 'nosuch' })).includes(ICONS.play));
  check('markup: the label is escaped', T.popoverHtml.item({ name: 'X', status: 'ok', haOff: false, media: [], lights: [], readings: [],
    actions: [Object.assign(act('idle', false), { label: '<b>', text: '<b>' })] }, dot).includes('&lt;b&gt;'));

  // CSS: no hover / press rule may repaint a Sent or Not sent button. With
  // the pointer still on the clicked button, a :hover background used to
  // outrank .sent (white "Sent" on near-white in the light theme). Every
  // rule that styles .tp-vb under :hover or :active must exclude both.
  const rules = [...T.STYLE.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(m => ({ sel: m[1].replace(/@media[^{]*\{/g, '').trim(), body: m[2] }));
  const interactive = rules.flatMap(r => r.sel.split(',').map(x => x.trim()).filter(x => /\.tp-vb\b/.test(x) && /:(hover|active)/.test(x) &&
    !/\.primary/.test(x) && /background/.test(r.body)));
  check('css: there are .tp-vb hover/press rules to check (dark, light, press)', interactive.length >= 3, interactive);
  check('css: none of them repaints a Sent / Not sent button', interactive.every(x => x.includes(':not(.sent)') && x.includes(':not(.failed)')),
    interactive);
  check('css: Sent is green with white text in both themes', /\.tp-vb\.sent \{ background: #15803d;[^}]*color: #fff;/.test(T.STYLE) &&
    /:root\[data-theme="light"\] \.tp-vb\.sent \{ background: #15803d;[^}]*color: #fff;/.test(T.STYLE));
  const tp = read('src/tap-popovers.js').replace(/\s+/g, '');
  check('wiring: a tap presses the row\'s button (click only), saying whether a key drove it',
    tp.includes("at('act',(b,i)=>{constintent=createKeyIntent();b.addEventListener('keydown',e=>intent.keyDown(e.key));" +
      "b.addEventListener('blur',()=>intent.blur());b.addEventListener('click',e=>{constkeyboard=intent.click(e.detail);" +
      "if(b.disabled)return;actionButtonFor(t,i).press({keyboard});});});"));
  check('wiring: a key release ANYWHERE frees the held-key guard (the button is redrawn under the key)',
    tp.includes('constonActionKeyUp=e=>{if(isActivationKey(e.key))actionButtons.forEach(b=>b.keyUp());};' +
      "window.addEventListener('keyup',onActionKeyUp,true);") &&
    tp.includes("window.removeEventListener('keyup',onActionKeyUp,true);"));
  check('wiring: the button sends through sendScript, gated on HA connected; the demo only previews',
    tp.includes('send:()=>(itemMockMode()?true:sendScript(ha(),row,()=>!writeBlocked()&&canSend())),'));
  check('wiring: the button is writable only when HA is connected (or the demo)',
    tp.includes('constactionWritable=()=>itemMockMode()||(!writeBlocked()&&canSend());'));
  check('wiring: the model reads the state, never presses', /constactions=\(card\.actions\|\|\[\]\)\.map\(\(row,i\)=>\{constst=actionButtonFor\(t,i\)\.state;/.test(tp) &&
    (tp.match(/actionButtonFor\(t,i\)\.press\(/g) || []).length === 1);
  check('wiring: the TV row gets its art entity\'s raw state', tp.includes("constar=row.art?itemRaw(row.art.entity,'art',row,base+i):null;") &&
    tp.includes('mediaRowModel(r,row.art,ar)'));
  const idx = read('index.html').replace(/\s+/g, '');
  check('index: the kill room sends through the same sendScript',
    idx.includes("send:()=>sendScript(ha,roomScriptBindings().get(rid),()=>roomScriptHaState()==='ok'),"));
}

console.log((failures ? 'FAIL' : 'ok') + ' -- ' + passes + ' passed, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
