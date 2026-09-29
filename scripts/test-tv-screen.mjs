#!/usr/bin/env node
/**
 * TV screens follow their set: black glass when off, a lit home screen when
 * on (src/furniture/tv-screen.js, the `tv` builder in small-items.js, the
 * scene's setTvScreen and ha-client's onItemEntityChange).
 * No framework, no install: `node scripts/test-tv-screen.mjs`.
 *
 *   1. The state mapping: which media_player states light the panel.
 *   2. The binding: sensors.items -> the item's `role: "tv"` media row.
 *   3. The BUILT TV, for every bezel style x detail: exactly one screen mesh,
 *      a dynamic part, built dark; applyTvScreenLook lights and darkens THAT
 *      material by uniforms only (same material, same emissive map, same
 *      program-shaping flags), each TV its own material, one shared picture.
 *   4. Through the real furniture pipeline: the screen reaches the scene as
 *      a dynamic part (never in a merged bucket) and joins its wall's fade.
 *   5. ha-client: onItemEntityChange fires on the first report and on a
 *      state change of a sensors.items entity, never on an attribute-only
 *      republish -- against the fake HA socket, never a real HA.
 *   6. index.html wires those callbacks to setTvScreen through tvScreenOn,
 *      and the ?debug=1 seam can flip a TV.
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
const TV = await imp('src/furniture/tv-screen.js');
const SI = await imp('src/furniture/small-items.js');
const F = await imp('src/furniture.js');
const { HouseLoader } = await imp('src/house-loader.js');
const { HAClient } = await imp('src/ha-client.js');

let passes = 0, failures = 0;
function check(name, ok, detail) {
  if (ok) { passes++; return; }
  failures++;
  console.error('FAIL ' + name + (detail !== undefined ? ' -- ' + JSON.stringify(detail) : ''));
}
function quietly(fn) {
  const w = console.warn, l = console.log;
  console.warn = () => {}; console.log = () => {};
  try { return fn(); } finally { console.warn = w; console.log = l; }
}

// ---- 1. state -> lit? -------------------------------------------------------
{
  const lit = ['on', 'idle', 'playing', 'paused', 'buffering'];
  const dark = ['off', 'standby', 'unavailable', 'unknown', '', 'ON', 'opening'];
  lit.forEach(s => check('lit: ' + s, TV.tvScreenOn({ state: s }) === true && TV.tvScreenOn(s) === true));
  dark.forEach(s => check('dark: ' + JSON.stringify(s), TV.tvScreenOn({ state: s }) === false && TV.tvScreenOn(s) === false));
  check('dark: no reading', TV.tvScreenOn(null) === false && TV.tvScreenOn(undefined) === false && TV.tvScreenOn({}) === false);
}

// ---- 2. binding --------------------------------------------------------------
{
  const b = TV.tvEntityBindings({
    lounge_tv: { media: [
      { entity: 'media_player.demo_cast', role: 'cast' },
      { entity: 'media_player.demo_lounge_tv', role: 'tv' },
      { entity: 'media_player.demo_second_tv', role: 'tv' }
    ] },
    console: [
      { title: 'Cupboard', readings: [{ entity: 'sensor.demo_t' }] },
      { title: 'TV', media: [{ entity: 'media_player.demo_console_tv', role: 'tv' }] }
    ],
    speaker_only: { media: [{ entity: 'media_player.demo_speaker', role: 'speaker' }] },
    no_role: { media: [{ entity: 'media_player.demo_norole' }] },
    wrong_domain: { media: [{ entity: 'light.demo_tv', role: 'tv' }] },
    empty: null
  });
  check('binding: the first role:"tv" row, not the cast row before it', b.get('lounge_tv') === 'media_player.demo_lounge_tv', [...b]);
  check('binding: found in a later card of a list', b.get('console') === 'media_player.demo_console_tv');
  check('binding: no tv row -> no binding', !b.has('speaker_only') && !b.has('no_role') && !b.has('empty'));
  check('binding: a non-media_player entity is ignored', !b.has('wrong_domain'));
  check('binding: nothing -> empty', TV.tvEntityBindings(null).size === 0 && TV.tvEntityBindings(undefined).size === 0);
}

// ---- 3. the built TV ---------------------------------------------------------
const screensOf = g => { const out = []; g.traverse(o => { if (o.isMesh && o.userData.tvScreen) out.push(o); }); return out; };
// What decides a three.js program for this material: if any of these changed
// between the two looks, flipping a TV would compile a new shader.
const programShape = m => JSON.stringify({
  type: m.type, map: !!m.map, emissiveMap: m.emissiveMap && m.emissiveMap.uuid, transparent: m.transparent,
  vertexColors: m.vertexColors, alphaTest: m.alphaTest, side: m.side, flatShading: m.flatShading, defines: m.defines || null
});
const variants = [
  ['thin', {}], ['thin on a stand', { stand: true, height: 106 }],
  ['picture-frame', { bezelStyle: 'picture-frame' }]
];
const allScreens = [];
for (const [name, params] of variants) {
  for (const detail of ['full', 'low']) {
    const label = name + '/' + detail;
    const g = SI.TYPES.tv.build(THREE, params, { detail });
    const screens = screensOf(g);
    check(label + ': exactly one screen mesh', screens.length === 1, screens.length);
    if (screens.length !== 1) continue;
    const s = screens[0], mat = s.material;
    allScreens.push(s);
    check(label + ': the screen is a dynamic part (never merged)', s.userData.dynamic === true);
    check(label + ': named tvScreen', s.name === 'tvScreen');
    check(label + ': finish stays the emissive palette entry', mat.userData.finish === 'emissive');
    check(label + ': carries the home-screen picture as its emissive map',
      !!(mat.emissiveMap && mat.emissiveMap.isTexture && mat.emissiveMap.userData.tvHome));
    // Built OFF: black glass. No glow at all, a smooth surface for the sheen.
    check(label + ': built dark -- emissive black, intensity 0',
      mat.emissive.getHex() === 0 && mat.emissiveIntensity === 0 && mat.userData.tvOn === false,
      { e: mat.emissive.getHex(), i: mat.emissiveIntensity });
    const hex = mat.color.getHex();   // sRGB, as authored
    check(label + ': dark glass is near-black', [16, 8, 0].every(sh => ((hex >> sh) & 0xff) < 0x10), hex.toString(16));
    check(label + ': glass is smooth enough to catch a highlight', mat.roughness <= 0.4, mat.roughness);
    // The screen faces the room: its front at the TV's front face (max z).
    const gb = new THREE.Box3().setFromObject(g), sb = new THREE.Box3().setFromObject(s);
    check(label + ': the screen is at the front (within 3 mm of it)', gb.max.z - sb.max.z < 0.003,
      { s: sb.max.z, g: gb.max.z });

    const shape0 = programShape(mat), map0 = mat.emissiveMap;
    const changedOn = TV.applyTvScreenLook(mat, true);
    check(label + ': ON -> the same mesh keeps the same material', s.material === mat);
    check(label + ': ON -> emissive white x ON_INTENSITY',
      mat.emissive.getHex() === 0xffffff && mat.emissiveIntensity === TV.ON_INTENSITY && mat.userData.tvOn === true);
    check(label + ': ON reports a change', changedOn === true);
    check(label + ': ON leaves the program shape alone (no recompile)', programShape(mat) === shape0 && mat.emissiveMap === map0);
    check(label + ': ON again is not a change (no repaint)', TV.applyTvScreenLook(mat, true) === false);
    const changedOff = TV.applyTvScreenLook(mat, false);
    check(label + ': OFF -> black again', mat.emissive.getHex() === 0 && mat.emissiveIntensity === 0 && changedOff === true);
    check(label + ': OFF leaves the program shape alone', programShape(mat) === shape0);
  }
}
if (allScreens.length > 1) {
  check('every TV has its OWN screen material', new Set(allScreens.map(s => s.material)).size === allScreens.length);
  check('...and they all share ONE picture', new Set(allScreens.map(s => s.material.emissiveMap)).size === 1);
  TV.applyTvScreenLook(allScreens[0].material, true);
  check('lighting one TV leaves another dark', allScreens[1].material.emissiveIntensity === 0);
  TV.applyTvScreenLook(allScreens[0].material, false);
}
check('the ON look is visibly lit, the OFF look is not',
  TV.tvScreenLook(true).emissiveIntensity >= 0.8 && TV.tvScreenLook(false).emissiveIntensity === 0 &&
  TV.tvScreenLook(false).emissive === 0);
check('the picture is 16:9', Math.abs(TV.HOME_W / TV.HOME_H - 16 / 9) < 0.01);

// The drawing itself, against a recording 2D context: deterministic, draws
// something across the whole frame, and writes no brand name.
{
  const calls = [], texts = [];
  const ctx = new Proxy({}, {
    get(t, k) {
      if (k === 'measureText') return s => ({ width: String(s).length * 7 });
      if (k === 'createLinearGradient') return () => ({ addColorStop() {} });
      if (k === 'fillText') return s => texts.push(String(s));
      if (k in t) return t[k];
      return (...a) => calls.push(k);
    },
    set(t, k, v) { t[k] = v; return true; }
  });
  TV.drawTvHome(ctx, TV.HOME_W, TV.HOME_H);
  check('picture: draws many shapes', calls.filter(c => c === 'fill').length > 30, calls.length);
  check('picture: only generic menu words', texts.every(t => ['Home', 'Live', 'Apps', 'Library'].includes(t)), texts);
}

// ---- 4. through the furniture pipeline --------------------------------------
{
  const house = {
    kind: 'geometry', schemaVersion: '1.2', id: 't', name: 't', units: 'cm',
    coordinateTransform: { originX: 0, originY: 0, scale: 0.01 },
    defaults: { wallHeight: 250, wallThickness: 10 },
    walls: { segments: [
      { id: 1, start: [95, 95], end: [505, 95], exterior: true },
      { id: 2, start: [95, 405], end: [505, 405], exterior: true },
      { id: 3, start: [95, 95], end: [95, 405] },
      { id: 4, start: [505, 95], end: [505, 405], exterior: true }
    ] },
    rooms: [{ id: 'r', label: 'R', polygon: [[100, 100], [500, 100], [500, 400], [100, 400]] }],
    furniture: [
      { id: 'tv_a', room: 'r', type: 'tv', wall: 1, centre: 200, offset: 0, elevation: 85, params: { width: 123, height: 71 } },
      { id: 'tv_b', room: 'r', type: 'tv', wall: 1, centre: 380, offset: 0, elevation: 85,
        params: { width: 97, height: 57, bezelStyle: 'picture-frame' } }
    ]
  };
  const h = quietly(() => HouseLoader.compile(house, ''));
  const builders = new Map([['tv', SI.TYPES.tv]]);
  const res = quietly(() => F.buildFurnitureSync(THREE, h.furniture, builders,
    { tx: x => x * 0.01, tz: y => y * 0.01, quality: { tier: 'ultra', sunShadow: true, roomShadowLights: true }, walls: h.walls }));
  ['tv_a', 'tv_b'].forEach(id => {
    const dyn = res.dynamicByItemId[id];
    const screen = dyn && dyn.group.getObjectByName('tvScreen');
    check(id + ': the screen reaches the scene as a dynamic part', !!screen);
    check(id + ': ...under the furniture root', !!dyn && dyn.group.parent === res.root);
    let inBucket = false;
    res.beauty.forEach(b => { if (b.material === (screen && screen.material)) inBucket = true; });
    check(id + ': no merged bucket carries the screen material', !inBucket);
    check(id + ': its host wall fades it (wall 1 is exterior)', dyn && dyn.fadeWallId === 1, dyn && dyn.fadeWallId);
    const reg = screen && F.fadeRegistrations(res).find(r => r.mesh === screen);
    check(id + ': registered with the wall fade at its own opacity 1', !!reg && reg.baseOpacity === 1 && reg.wallId === 1);
    // What the scene does on setTvScreen: flip THIS mesh's material.
    if (screen) {
      check(id + ': still the emissive picture material after the pipeline',
        !!screen.material.emissiveMap && screen.material.emissiveIntensity === 0);
      TV.applyTvScreenLook(screen.material, true);
      check(id + ': lights in place', screen.material.emissiveIntensity === TV.ON_INTENSITY);
    }
  });
  F.disposeFurniture(res);
}

// ---- 5. ha-client: onItemEntityChange ----------------------------------------
{
  const E = 'media_player.demo_bedroom_tv', CAST = 'media_player.demo_bedroom_cast', OTHER = 'media_player.demo_unbound';
  const fake = installFakeHA({ states: [
    { entity_id: E, state: 'off', attributes: {} },
    { entity_id: OTHER, state: 'playing', attributes: {} }
  ] });
  try {
    const LIGHT = 'light.demo_bedroom_main';
    const ha = quietly(() => HAClient.create({ url: 'http://ha.invalid', token: 't', rooms: { bedroom: { main: [LIGHT] } },
      sensors: { items: { bedroom_tv: { media: [{ entity: E, role: 'tv' }, { entity: CAST, role: 'cast' }] } } },
      wsReconnectMs: 10000 }));
    const got = [];
    ha.onItemEntityChange((eid, raw) => got.push(eid + '=' + raw.state));
    await quietly(async () => { ha.connect(); await fake.whenConnected(ha); });
    check('ha: the snapshot reports the bound TV once', got.join() === E + '=off', got);
    const sock = fake.sockets[fake.sockets.length - 1];
    const settle = () => new Promise(r => setTimeout(r, 20));
    sock.emitStateChanged({ entity_id: E, state: 'on', attributes: {} }); await settle();
    check('ha: a power change fires', got.join() === [E + '=off', E + '=on'].join(), got);
    sock.emitStateChanged({ entity_id: E, state: 'on', attributes: { volume_level: 0.3 } }); await settle();
    check('ha: an attribute-only republish does not fire', got.length === 2, got);
    sock.emitStateChanged({ entity_id: OTHER, state: 'off', attributes: {} }); await settle();
    check('ha: an entity no item binds does not fire', got.length === 2, got);
    sock.emitStateChanged({ entity_id: LIGHT, state: 'on', attributes: {} }); await settle();
    check('ha: a room light (recorded raw, not an item) does not fire', got.length === 2, got);
    sock.emitStateChanged({ entity_id: CAST, state: 'playing', attributes: {} }); await settle();
    check('ha: any sensors.items entity fires (the page filters to the tv row)', got[2] === CAST + '=playing', got);
    quietly(() => ha.disconnect());
  } finally { fake.restore(); }
}

// ---- 6. index.html wiring (source level) -------------------------------------
{
  const src = read('index.html');
  check('index: imports the mapping and the binding',
    /import \{ tvEntityBindings, tvScreenOn \} from '\.\/src\/furniture\/tv-screen\.js\?v=__VERSION__'/.test(src));
  check('index: HA item changes drive setTvScreen through tvScreenOn',
    /ha\.onItemEntityChange\(\(entityId, raw\) => tvBindings\.forEach\(\(tvEntity, itemId\) => \{\s*if \(tvEntity === entityId\) home\.setTvScreen\(itemId, tvScreenOn\(raw\)\);/.test(src));
  check('index: the ?debug=1 seam can flip a TV', /\btv: \(itemId, on\) => home\.setTvScreen\(/.test(src));
  const scene = read('src/home3d-scene.js');
  check('scene: setTvScreen repaints only on a change',
    /setTvScreen\(itemId, on\) \{\s*tvScreenOn\.set\(itemId, !!on\);\s*if \(applyTvScreen\(itemId\)\) requestRender\(\);/.test(scene));
  check('scene: attach puts every built screen in its last-reported look',
    /tvScreens\.set\(itemId, o\);[\s\S]{0,40}\}\);\s*applyTvScreen\(itemId\);/.test(scene));
}

console.log((failures ? 'FAIL' : 'ok') + ' -- ' + passes + ' passed, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
