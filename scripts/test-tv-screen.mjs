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
 *   6. The scene's TV controller (createTvScreens), driven for real: a
 *      reading before the furniture attaches is applied on attach, and a
 *      repaint is asked for only when a look actually changed. Then the
 *      wiring that cannot run in Node (Home3DScene needs WebGL; index.html
 *      is a page): the scene delegates to that controller, index.html feeds
 *      it through tvScreenOn -- checked on whitespace-stripped source.
 *   7. The off-glass sheen: a faint, neutral, uniform-driven term spliced
 *      into the real three.js standard fragment shader, one program for
 *      every TV, zero when on.
 *   8. The spec page lights the TV by default (setTvScreensIn).
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
  // Two cards on one item, each with a role:"tv" row: the FIRST card wins.
  const two = TV.tvEntityBindings({ twin: [
    { title: 'Panel', media: [{ entity: 'media_player.demo_first_tv', role: 'tv' }] },
    { title: 'Again', media: [{ entity: 'media_player.demo_later_tv', role: 'tv' }] }
  ] });
  check('binding: the first card with a tv row wins over a later one', two.get('twin') === 'media_player.demo_first_tv', [...two]);
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
  vertexColors: m.vertexColors, alphaTest: m.alphaTest, side: m.side, flatShading: m.flatShading, defines: m.defines || null,
  key: m.customProgramCacheKey(), hook: String(m.onBeforeCompile)
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

// ---- 6. the scene's TV controller, and the wiring around it -----------------
{
  const built = { a: SI.TYPES.tv.build(THREE, {}, { detail: 'full' }), b: SI.TYPES.tv.build(THREE, { bezelStyle: 'picture-frame' }, { detail: 'full' }) };
  const dyn = { a: { group: built.a }, b: { group: built.b }, clock: { group: new THREE.Group() } };
  const matOf = id => screensOf(built[id])[0].material;
  let repaints = 0;
  const tvs = TV.createTvScreens(() => { repaints++; });
  tvs.set('a', true);   // HA reports before the furniture has attached
  check('controller: a reading before attach paints nothing yet', repaints === 0 && matOf('a').emissiveIntensity === 0);
  const changed = tvs.attach(dyn);
  check('controller: attach applies the earlier reading', matOf('a').emissiveIntensity === TV.ON_INTENSITY && matOf('a').userData.tvOn === true);
  check('controller: attach leaves an unreported TV dark', matOf('b').emissiveIntensity === 0 && matOf('b').userData.tvOn === false);
  check('controller: attach reports that a look changed', changed === true);
  check('controller: indexes exactly the screens', tvs.entries().map(e => e[0]).sort().join() === 'a,b', tvs.entries().map(e => e[0]));
  repaints = 0;
  tvs.set('a', true);
  check('controller: the same reading again asks for no repaint', repaints === 0);
  tvs.set('a', false);
  check('controller: a real change repaints exactly once', repaints === 1 && matOf('a').emissiveIntensity === 0);
  tvs.set('b', 'yes');   // truthy -> on
  check('controller: another TV lights on its own', repaints === 2 && matOf('b').emissiveIntensity === TV.ON_INTENSITY &&
    matOf('a').emissiveIntensity === 0);
  tvs.set('nowhere', true);
  check('controller: an id with no built TV asks for no repaint', repaints === 2);
  check('controller: attaching the same state again changes nothing', tvs.attach(dyn) === false);
  tvs.clear();
  tvs.set('a', true);
  check('controller: after clear, nothing is touched or repainted', repaints === 2 && matOf('a').emissiveIntensity === 0);
  tvs.attach(dyn);
  check('controller: ...and a re-attach applies what was reported meanwhile', matOf('a').emissiveIntensity === TV.ON_INTENSITY);
  tvs.attach({ b: dyn.b });   // a rebuild without TV "a"
  check('controller: a new build replaces the old index', tvs.entries().map(e => e[0]).join() === 'b', tvs.entries().map(e => e[0]));

  // Wiring that cannot run in Node: Home3DScene needs a WebGL renderer and
  // index.html is a page. Checked on source with all whitespace removed, so
  // reformatting does not break it; the behaviour is the controller above.
  const squash = t => t.replace(/\s+/g, '');
  const scene = squash(read('src/home3d-scene.js'));
  check('scene: builds the controller with requestRender as its repaint',
    scene.includes("import{createTvScreens}from'./furniture/tv-screen.js'") &&
    scene.includes('consttvScreens=createTvScreens(()=>requestRender());'));
  check('scene: attach hands the build\'s dynamic parts to the controller', scene.includes('tvScreens.attach(result.dynamicByItemId);'));
  check('scene: setTvScreen delegates to the controller', scene.includes('setTvScreen(itemId,on){tvScreens.set(itemId,on);}'));
  check('scene: dispose forgets the screens', /disposeFurniture\(furnitureResult\);furnitureResult=null;\}tvScreens\.clear\(\);/.test(scene));
  const src = squash(read('index.html'));
  check('index: imports the mapping and the binding',
    src.includes("import{tvBindings,tvScreenOn,tvScreenMode}from'./src/furniture/tv-screen.js?v=__VERSION__';"));
  // The TV's own entity OR its art condition's entity changing re-derives
  // the screen's mode from BOTH raw states (tvScreenMode; tested in
  // scripts/test-frame-art.mjs).
  check('index: HA item changes drive setTvScreen through tvScreenMode',
    src.includes('ha.onItemEntityChange(entityId=>tvScreenBindings.forEach((b,itemId)=>{if(b.entity!==entityId&&!(b.art&&b.art.entity===entityId))return;' +
      'home.setTvScreen(itemId,tvScreenMode(ha.getRawState(b.entity),b.art,b.art&&ha.getRawState(b.art.entity)));'));
  check('index: the ?debug=1 seam can flip a TV, art included',
    src.includes("tv:(itemId,on)=>home.setTvScreen(itemId,on==='art'?'art':typeofon==='string'?tvScreenOn(on):!!on),"));
}

// ---- 7. the off-glass sheen ------------------------------------------------------
{
  const g1 = SI.TYPES.tv.build(THREE, {}, { detail: 'full' }), g2 = SI.TYPES.tv.build(THREE, {}, { detail: 'low' });
  const m1 = screensOf(g1)[0].material, m2 = screensOf(g2)[0].material;
  const sh = m1.userData.tvSheen && m1.userData.tvSheen.value;
  // Every channel equal to `v` -- neutral grey, never a tint.
  const grey = (c, v) => !!c && c.r === v && c.g === v && c.b === v;
  check('sheen: built off with OFF_SHEEN, neutral', grey(sh, TV.OFF_SHEEN), sh);
  // FAINT, from the shader itself: the weights the GLSL actually carries,
  // parsed out of it, times OFF_SHEEN, must stay under SHEEN_PEAK_MAX.
  const m = /totalEmissiveRadiance \+= tvSheen \* \( ([\d.]+) \+ ([\d.]+) \* tvq\.y \+ ([\d.]+) \* tvBand \+ ([\d.]+) \* tvRim \);/.exec(TV.TV_SHEEN_GLSL);
  const w = TV.SHEEN_WEIGHTS;
  check('sheen: the GLSL carries exactly SHEEN_WEIGHTS', !!m && +m[1] === w.base && +m[2] === w.top && +m[3] === w.band && +m[4] === w.rim,
    m && m.slice(1));
  const peak = m ? TV.OFF_SHEEN * (+m[1] + +m[2] + +m[3] + +m[4]) : Infinity;
  check('sheen: faint -- its brightest point (OFF_SHEEN x the shader\'s weights) stays under SHEEN_PEAK_MAX',
    TV.OFF_SHEEN > 0 && peak <= TV.SHEEN_PEAK_MAX && Math.abs(TV.sheenPeak() - peak) < 1e-12, { peak, max: TV.SHEEN_PEAK_MAX });
  check('sheen: the cap itself is a few sRGB levels, not a glow', TV.SHEEN_PEAK_MAX <= 0.012);
  check('sheen: each TV its own uniform', m1.userData.tvSheen !== m2.userData.tvSheen);
  check('sheen: one program for every TV', m1.customProgramCacheKey() === m2.customProgramCacheKey());
  TV.applyTvScreenLook(m1, true);
  check('sheen: none while ON', grey(sh, 0), sh);
  check('sheen: the other TV keeps its own', grey(m2.userData.tvSheen.value, TV.OFF_SHEEN));
  TV.applyTvScreenLook(m1, false);
  check('sheen: back when OFF, neutral', grey(sh, TV.OFF_SHEEN), sh);
  // Several flips, every channel checked after each one.
  let flipsNeutral = true;
  [true, false, true, true, false, false].forEach(on => {
    TV.applyTvScreenLook(m1, on);
    if (!grey(sh, on ? 0 : TV.OFF_SHEEN)) flipsNeutral = false;
  });
  check('sheen: neutral grey after every flip', flipsNeutral, sh);
  // Through onBeforeCompile, on the REAL three.js standard shader.
  const shader = { uniforms: {}, vertexShader: THREE.ShaderLib.standard.vertexShader,
    fragmentShader: THREE.ShaderLib.standard.fragmentShader };
  m1.onBeforeCompile(shader);
  check('sheen: the shader gets the material\'s own uniform', shader.uniforms.tvSheen === m1.userData.tvSheen);
  const fs = shader.fragmentShader;
  check('sheen: declares the uniform after <common>', fs.indexOf('uniform vec3 tvSheen;') > fs.indexOf('#include <common>'));
  const at = fs.indexOf('#include <emissivemap_fragment>'), add = fs.indexOf('totalEmissiveRadiance += tvSheen');
  check('sheen: added right after the emissive map, before lighting', at > 0 && add > at && add < fs.indexOf('#include <lights_fragment_begin>'), { at, add });
  check('sheen: a shader without the anchor is left alone', TV.injectTvSheen('void main(){}') === 'void main(){}');
  check('sheen: a TV screen still flips with a sheen and no program change', (() => {
    const before = programShape(m2); TV.applyTvScreenLook(m2, true); const after = programShape(m2); TV.applyTvScreenLook(m2, false);
    return before === after;
  })());
}

// ---- 8. the spec page shows the TV ON ------------------------------------------
{
  const g = SI.TYPES.tv.build(THREE, { stand: true, height: 106 }, { detail: 'full' });
  check('spec helper: lights every screen in a group', TV.setTvScreensIn(g, true) === 1 && screensOf(g)[0].material.emissiveIntensity === TV.ON_INTENSITY);
  check('spec helper: and darkens them', TV.setTvScreensIn(g, false) === 1 && screensOf(g)[0].material.emissiveIntensity === 0);
  check('spec helper: nothing to do on a group with no TV', TV.setTvScreensIn(new THREE.Group(), true) === 0 && TV.setTvScreensIn(null, true) === 0);
  const spec = read('specs/SmallItemsSpec.html').replace(/\s+/g, '');
  check('spec: loads tv-screen.js for the page', spec.includes("import*asTvScreenfrom'../src/furniture/tv-screen.js';window.TvScreen=TvScreen;"));
  check('spec: the screen preview defaults to ON', spec.includes('const[tv,setTv]=React.useState({on:true});'));
  check('spec: the build lights the screen from that state', spec.includes('if(t.tv&&window.TvScreen)window.TvScreen.setTvScreensIn(built,t.tv.on);'));
  check('spec: only a TV carries the preview state', spec.includes("tv:type==='tv'?tv:null"));
}

console.log((failures ? 'FAIL' : 'ok') + ' -- ' + passes + ' passed, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
