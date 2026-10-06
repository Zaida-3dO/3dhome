#!/usr/bin/env node
/**
 * hub-screen.js: a smart display shows what its speaker is playing.
 * No framework, no install: `node scripts/test-hub-screen.mjs`.
 *
 *   1. State -> screen content, a pure function: only `playing` lights the
 *      card; paused/idle/off/unavailable are the built look; buffering holds.
 *      Artwork URLs: absolute passes, a path joins HA's base, junk is refused.
 *   2. The player comes from sensors.soundMenu.openFrom.
 *   3. The controller redraws (and repaints) ONLY when what the screen shows
 *      changed -- not on a repeat, not on HA's rotating proxy token.
 *   4. Artwork: loaded -> drawn; failed or tainted -> the text card, and a
 *      failed URL is not retried; a stale load never draws.
 *   5. The builder: a Hub screen is a dynamic `hubScreen` part that always
 *      carries an emissive map; idle restores its built look exactly.
 *   6. ha-client fires onSoundMenuChange on an artist / picture change
 *      (fake Home Assistant only).
 *   7. index.html wires it (HA and the demo sample).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { installFakeHA } from './fake-ha-websocket.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const imp = rel => import(pathToFileURL(path.join(root, rel)).href);
const THREE = await imp('vendor/three-r160/three.module.min.js');
const H = await imp('src/furniture/hub-screen.js');
const S = await imp('src/furniture/smart-display.js');
const { HAClient } = await imp('src/ha-client.js');

let failures = 0, passes = 0;
function check(name, cond, detail) {
  if (cond) { passes++; return; }
  failures++;
  console.error('FAIL ' + name + (detail !== undefined ? ' -- ' + JSON.stringify(detail) : ''));
}
const quiet = fn => { const l = console.log, w = console.warn; console.log = console.warn = () => {}; try { return fn(); } finally { console.log = l; console.warn = w; } };

const BASE = 'https://ha.example.invalid';
const PROXY = '/api/media_player_proxy/media_player.demo_hub?token=abc123&cache=f00d';

// ---- 1. state -> content --------------------------------------------------------
{
  const play = attrs => ({ state: 'playing', attributes: attrs });
  const c = H.hubScreenContent(play({ media_title: ' Song A ', media_artist: 'Band B', entity_picture: PROXY }), BASE);
  check('playing -> card', c.mode === 'playing' && c.title === 'Song A' && c.artist === 'Band B', c);
  check('playing: a proxy path joins the HA base', c.art === BASE + PROXY, c.art);
  check('paused -> built look', H.hubScreenContent({ state: 'paused', attributes: { media_title: 'x' } }, BASE).mode === 'idle');
  ['idle', 'off', 'standby', 'unavailable', 'unknown', 'on'].forEach(st =>
    check(st + ' -> built look', H.hubScreenContent({ state: st, attributes: { media_title: 'x' } }, BASE).mode === 'idle'));
  check('no reading -> built look', H.hubScreenContent(null, BASE).mode === 'idle');
  check('buffering holds', H.hubScreenContent({ state: 'buffering', attributes: {} }, BASE).mode === 'hold');
  check('album artist when no artist', H.hubScreenContent(play({ media_title: 't', media_album_artist: 'AA' }), BASE).artist === 'AA');
  check('absolute art passes through', H.hubScreenContent(play({ entity_picture: 'https://cdn.example.invalid/i/1.jpg' }), BASE).art === 'https://cdn.example.invalid/i/1.jpg');
  check('entity_picture_local when no entity_picture', H.hubScreenContent(play({ entity_picture_local: PROXY }), BASE).art === BASE + PROXY);
  check('no picture -> art null (text card)', H.hubScreenContent(play({ media_title: 't' }), BASE).art === null);
  check('a path with no base -> null', H.hubArtUrl('', PROXY) === null);
  check('protocol-relative refused', H.hubArtUrl(BASE, '//evil.invalid/x.png') === null);
  check('javascript: refused', H.hubArtUrl(BASE, 'javascript:alert(1)') === null);
  check('base trailing slash joined once', H.hubArtUrl(BASE + '/', '/a.png') === BASE + '/a.png');
  // The rotating token is not a change; the track is.
  const k1 = H.hubContentKey({ mode: 'playing', title: 't', artist: 'a', art: BASE + '/api/media_player_proxy/m?token=AAA&cache=1' });
  const k2 = H.hubContentKey({ mode: 'playing', title: 't', artist: 'a', art: BASE + '/api/media_player_proxy/m?token=BBB&cache=1' });
  const k3 = H.hubContentKey({ mode: 'playing', title: 't', artist: 'a', art: BASE + '/api/media_player_proxy/m?token=BBB&cache=2' });
  check('token rotation is not a content change', k1 === k2, [k1, k2]);
  check('a new cache key is a content change', k2 !== k3);
  check('caption', H.hubCaption({ mode: 'playing', title: 'T', artist: 'A' }) === 'Now playing · T — A');
}

// ---- 2. the player comes from openFrom --------------------------------------------
{
  const menu = {
    selection: 'input_text.demo_sel', toggleScript: 'script.demo_toggle', sound: 'input_select.demo_sound', catalogue: 'sensor.demo_cat',
    speakers: [{ entity: 'media_player.demo_a' }, { entity: 'media_player.demo_b' }],
    openFrom: { demo_hub: 'media_player.demo_b', demo_puck: 'media_player.demo_a', demo_odd: 'media_player.demo_not_a_speaker' }
  };
  const b = H.hubDisplayBindings(menu);
  check('openFrom: hub -> its player', b.get('demo_hub') === 'media_player.demo_b');
  check('openFrom: every valid entry', b.size === 2 && b.get('demo_puck') === 'media_player.demo_a', [...b]);
  check('openFrom: a non-speaker maps to nothing', !b.has('demo_odd'));
  check('no sound menu -> no bindings', H.hubDisplayBindings(null).size === 0 && H.hubDisplayBindings({ openFrom: { x: 'media_player.y' } }).size === 0);
  // The demo house carries a hub mapped this way.
  const rooms = JSON.parse(fs.readFileSync(path.join(root, 'houses/demo/rooms.json'), 'utf8'));
  const geo = JSON.parse(fs.readFileSync(path.join(root, 'houses/demo/geometry.json'), 'utf8'));
  const hubs = (geo.furniture || []).filter(f => f.type === 'smart-display' && (!f.params || f.params.kind !== 'nest-mini-stand'));
  const db = H.hubDisplayBindings(rooms.sensors && rooms.sensors.soundMenu);
  check('demo: a smart display is mapped in openFrom', hubs.some(f => db.has(f.id)), hubs.map(f => f.id));
}

// ---- fakes for the controller --------------------------------------------------------
function fakeCanvas(log) {
  const ctx = new Proxy({ taint: false }, {
    get(t, k) {
      if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => ({ addColorStop() {} });
      if (k === 'measureText') return s => ({ width: String(s).length * 10 });
      if (k === 'fillText') return s => log.texts.push(String(s));
      if (k === 'drawImage') return img => log.images.push(img);
      if (k === 'getImageData') return () => { if (log.taint) throw new Error('SecurityError'); return { data: [0, 0, 0, 255] }; };
      if (k in t) return t[k];
      return () => {};
    },
    set(t, k, v) { t[k] = v; return true; }
  });
  return (w, h) => ({ width: w, height: h, getContext: () => ctx });
}
function rig(opts) {
  const log = { texts: [], images: [], taint: false, loads: [], repaints: 0 };
  const loader = (url, ok, fail) => { const L = { url, ok, fail, aborted: false }; log.loads.push(L); return () => { L.aborted = true; }; };
  const hs = H.createHubScreens(Object.assign({ THREE, repaint: () => log.repaints++, makeCanvas: fakeCanvas(log), loadImage: loader }, opts || {}));
  const g = S.build(THREE, { kind: 'nest-hub-max' });
  let mesh = null;
  g.traverse(o => { if (o.userData.hubScreen) mesh = o; });
  hs.attach({ demo_hub: { group: g } });
  return { hs, log, mesh, mat: mesh.material };
}
const PLAY = (title, art) => ({ mode: 'playing', title, artist: 'Band', art });

// ---- 3. redraw only on change ----------------------------------------------------------
{
  const { hs, log, mat } = rig();
  check('attach: idle needs no repaint', log.repaints === 0 && hs.stats.draws === 0);
  const blank = mat.emissiveMap;
  check('set idle on idle: no change', hs.set('demo_hub', { mode: 'idle' }) === false && log.repaints === 0);
  hs.set('demo_hub', PLAY('One', null));
  const st = hs.state('demo_hub');
  check('playing: drawn once, one repaint', hs.stats.draws === 1 && log.repaints === 1 && st.mode === 'playing', [hs.stats.draws, log.repaints]);
  check('playing: the map is the canvas texture', mat.emissiveMap === st.texture && st.texture.isCanvasTexture && mat.emissiveMap !== blank);
  check('playing: glows', mat.emissiveIntensity === H.HUB_ON_INTENSITY && mat.emissive.getHex() === 0xffffff);
  const v = st.version;
  hs.set('demo_hub', PLAY('One', null));
  check('same content: no redraw, no repaint, texture not re-uploaded', hs.stats.draws === 1 && log.repaints === 1 && hs.state('demo_hub').version === v);
  hs.set('demo_hub', PLAY('Two', null));
  check('new title: redrawn, re-uploaded, same texture object', hs.stats.draws === 2 && log.repaints === 2 && hs.state('demo_hub').version > v && hs.state('demo_hub').texture === st.texture);
  // Token rotation: the art URL changes only in its token.
  hs.set('demo_hub', PLAY('Two', BASE + '/api/media_player_proxy/m?token=A&cache=1'));
  const d = hs.stats.draws, r = log.repaints;
  hs.set('demo_hub', PLAY('Two', BASE + '/api/media_player_proxy/m?token=B&cache=1'));
  check('token rotation: no redraw', hs.stats.draws === d && log.repaints === r);
  // Stop: the built look, texture freed.
  let disposed = false;
  const tex = hs.state('demo_hub').texture;
  tex.addEventListener('dispose', () => { disposed = true; });
  hs.set('demo_hub', { mode: 'idle' });
  const off = mat.userData.hubOff;
  check('idle: built look restored', mat.emissive.getHex() === off.emissive && mat.color.getHex() === off.color && mat.emissiveIntensity === off.intensity);
  check('idle: the blank map is back, the canvas texture disposed', mat.emissiveMap === blank && disposed);
  check('idle: one repaint', log.repaints === r + 1);
  check('hold changes nothing', hs.set('demo_hub', { mode: 'hold' }) === false && log.repaints === r + 1);
  // Before attach: remembered, applied at attach.
  const late = H.createHubScreens({ THREE, makeCanvas: fakeCanvas({ texts: [], images: [] }), loadImage: () => () => {} });
  late.set('demo_hub', PLAY('Early', null));
  const g2 = S.build(THREE, { kind: 'nest-hub' });
  late.attach({ demo_hub: { group: g2 } });
  check('set before attach: applied on attach', late.state('demo_hub').mode === 'playing');
  check('a non-hub item is ignored', late.set('demo_box', PLAY('x', null)) === false && late.entries().length === 1);
  late.clear();
  check('clear: forgets meshes', late.entries().length === 0);
}

// ---- 4. artwork and the text fallback -----------------------------------------------------
{
  const ART = 'https://cdn.example.invalid/cover/1.jpg';
  const { hs, log } = rig();
  hs.set('demo_hub', PLAY('Song', ART));
  check('art: a text card first, while it loads', hs.state('demo_hub').art === 'loading' && log.images.length === 0 && log.texts.includes('NOW PLAYING'));
  check('art: one load, the URL as given', log.loads.length === 1 && log.loads[0].url === ART);
  const img = { width: 300, height: 300 };
  log.loads[0].ok(img);
  check('art: loaded -> drawn with the image, repainted', hs.state('demo_hub').art === 'ok' && log.images.includes(img) && log.repaints === 2);
  hs.set('demo_hub', { mode: 'idle' });
  hs.set('demo_hub', PLAY('Song', ART));
  check('art: cached, no second load', log.loads.length === 1 && hs.state('demo_hub').art === 'ok');
}
{
  const ART = BASE + '/api/media_player_proxy/m?token=Z&cache=9';
  const { hs, log } = rig();
  hs.set('demo_hub', PLAY('Song', ART));
  log.texts.length = 0;
  const d = hs.stats.draws;
  log.loads[0].fail();
  check('art fails: text card stays, no redraw, no image', hs.state('demo_hub').art === 'failed' && log.images.length === 0 && hs.stats.draws === d);
  hs.set('demo_hub', { mode: 'idle' });
  hs.set('demo_hub', PLAY('Song', ART.replace('token=Z', 'token=Y')));
  check('art failed: not retried (token rotation included)', log.loads.length === 1 && hs.state('demo_hub').art === 'failed');
  check('art failed: the text card says now playing and the title', log.texts.includes('NOW PLAYING') && log.texts.some(t => t.includes('Song')), log.texts);
}
{
  // A load that "succeeds" but taints the canvas -> text.
  const { hs, log } = rig();
  hs.set('demo_hub', PLAY('Song', 'https://cdn.example.invalid/t.jpg'));
  log.taint = true;
  log.loads[0].ok({ width: 10, height: 10 });
  check('tainted: falls back to text', hs.state('demo_hub').art === 'failed', hs.state('demo_hub'));
}
{
  // Stale: the track changed before the first cover arrived.
  const { hs, log } = rig();
  hs.set('demo_hub', PLAY('First', 'https://cdn.example.invalid/a.jpg'));
  hs.set('demo_hub', PLAY('Second', 'https://cdn.example.invalid/b.jpg'));
  check('stale: the first load was aborted', log.loads[0].aborted === true && log.loads.length === 2);
  const d = hs.stats.draws, r = log.repaints;
  log.loads[0].ok({ width: 1, height: 1 });
  check('stale: a late first cover draws nothing', hs.stats.draws === d && log.repaints === r);
}
{
  // The demo sample: a generated cover, drawn at once, never loaded.
  const { hs, log } = rig();
  hs.set('demo_hub', H.DEMO_NOW_PLAYING);
  check('demo: drawn with its gradient cover, no load', hs.state('demo_hub').art === 'ok' && log.loads.length === 0 && log.texts.includes('Sample track'));
}

// ---- 5. the builder ---------------------------------------------------------------------------
{
  for (const kind of ['nest-hub-max', 'nest-hub']) {
    for (const screenOn of [false, true]) {
      const g = S.build(THREE, { kind, screenOn });
      let m = null;
      g.traverse(o => { if (o.name === 'smartDisplayScreen') m = o; });
      check(kind + ': screen is a dynamic hubScreen part', m && m.userData.dynamic === true && m.userData.hubScreen === true);
      check(kind + ': always has an emissive map', m && m.material.emissiveMap === H.hubBlankTexture(THREE));
      check(kind + ': records its built look', m && m.material.userData.hubOff.emissive === m.material.emissive.getHex());
      check(kind + ': canvas follows the screen aspect', m && m.userData.hubAspect > 1.4 && m.userData.hubAspect < 2.4, m && m.userData.hubAspect);
    }
  }
  let any = false;
  S.build(THREE, { kind: 'nest-mini-stand' }).traverse(o => { if (o.userData.hubScreen) any = true; });
  check('mini stand: no screen to draw on', !any);
  check('canvas height clamps', H.hubCanvasHeight(1.94) === 264 && H.hubCanvasHeight(100) === H.CANVAS_H_MIN && H.hubCanvasHeight(0.5) === H.CANVAS_H_MAX);
}

// ---- 6. ha-client: the sound menu callback carries artist and picture changes ----------
{
  const E = 'media_player.demo_hub_speaker';
  const menu = {
    selection: 'input_text.demo_sel', toggleScript: 'script.demo_toggle', sound: 'input_select.demo_sound', catalogue: 'sensor.demo_cat',
    speakers: [{ entity: E }], openFrom: { demo_hub: E }
  };
  const fake = installFakeHA({ states: [{ entity_id: E, state: 'playing', attributes: { media_title: 't', media_artist: 'a' } }] });
  try {
    const ha = quiet(() => HAClient.create({ url: 'http://ha.invalid', token: 't', rooms: {}, wsReconnectMs: 10000, sensors: { soundMenu: menu } }));
    const got = [];
    ha.onSoundMenuChange((eid, raw) => got.push(raw.attributes.media_artist + '|' + (raw.attributes.entity_picture || '')));
    const log = console.log; console.log = () => {};
    try { ha.connect(); await fake.whenConnected(ha); } finally { console.log = log; }
    const sock = fake.sockets[fake.sockets.length - 1];
    const settle = () => new Promise(r => setTimeout(r, 20));
    sock.emitStateChanged({ entity_id: E, state: 'playing', attributes: { media_title: 't', media_artist: 'b' } }); await settle();
    check('ha: an artist change fires', got[got.length - 1] === 'b|', got);
    sock.emitStateChanged({ entity_id: E, state: 'playing', attributes: { media_title: 't', media_artist: 'b', entity_picture: '/p?token=1' } }); await settle();
    check('ha: a picture change fires', got[got.length - 1] === 'b|/p?token=1', got);
    const n = got.length;
    sock.emitStateChanged({ entity_id: E, state: 'playing', attributes: { media_title: 't', media_artist: 'b', entity_picture: '/p?token=1', media_position: 42 } }); await settle();
    check('ha: a position tick does not fire', got.length === n, got);
    // What index.html derives from it.
    const c = H.hubScreenContent(ha.getRawState(E), 'http://ha.invalid');
    check('ha -> content', c.mode === 'playing' && c.artist === 'b' && c.art === 'http://ha.invalid/p?token=1', c);
    check('ha: nothing was sent', fake.calls.length === 0, fake.calls);
    quiet(() => ha.disconnect());
  } finally { fake.restore(); }
}

// ---- 7. index.html wiring --------------------------------------------------------------------
{
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  check('index: imports hub-screen', /import \{[^}]*hubDisplayBindings[^}]*\} from '\.\/src\/furniture\/hub-screen\.js/.test(html));
  check('index: HA path feeds setHubScreen from onSoundMenuChange',
    /ha\.onSoundMenuChange\(\(entityId, raw\) => hubBindings\.forEach[\s\S]{0,200}home\.setHubScreen\(itemId, hubScreenContent\(raw, ha\.activeUrl\)\)/.test(html));
  check('index: no HA -> the demo sample', /hubDisplayBindings\(sensors && sensors\.soundMenu\)\.forEach\([\s\S]{0,80}DEMO_NOW_PLAYING/.test(html));
  const scene = fs.readFileSync(path.join(root, 'src/home3d-scene.js'), 'utf8');
  check('scene: attaches and clears the hub screens', /hubScreens\.attach\(result\.dynamicByItemId\)/.test(scene) && /hubScreens\.clear\(\)/.test(scene));
}

console.log((failures ? 'FAILED' : 'OK') + ' -- ' + passes + ' passed, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
