#!/usr/bin/env node
/**
 * src/render-rig.js -- the ONE lighting/render setup the house and the spec
 * pages share (item 7938c4e3). No framework, no install:
 * `node scripts/test-render-rig.mjs`.
 *
 * What this checks:
 *   1. The rig's values are the house's: renderer settings, the sky fill and
 *      sun as built, every sun-shadow setting, the room shadow light and the
 *      colour-temperature ramp. They are pinned as literals HERE (the values
 *      src/home3d-scene.js hard-coded before they moved), so changing one in
 *      the module fails, not just re-derives.
 *   2. BOTH CONSUMERS USE IT, and neither lights on its own: the house
 *      imports and calls every piece; specs/spec-three.jsx loads the module
 *      and calls the same pieces; neither constructs its own sun, sky,
 *      ambient or key light, sets its own tone mapping or exposure, or
 *      installs an environment map. Then a live check: a sky rig lit the
 *      house's way and one lit the spec page's way (same preset) carry
 *      identical light colours, intensities and shadow settings -- only the
 *      frustum's sides differ.
 *   3. Time-of-day presets: the house's morning / noon / night are exactly
 *      what its currentSun() used to compute, and evening mirrors morning
 *      about solar noon.
 *   4. fitSunShadow: every caster corner AND its shadow on the floor land
 *      inside the frustum (the second by construction: a shadow lies along
 *      the light's view axis from its caster), checked through three's own DirectionalLightShadow
 *      matrices (not a re-derivation), and the fit is tight.
 *   5. Finishes: applyLiveFinishes gives a spec page's palette-finish parts
 *      exactly the texel values the house's palette texture holds
 *      (merge.makePaletteTexture), leaves glass, emissive and untagged
 *      materials alone, and is idempotent.
 *
 * MUTATIONS (each fails at least one check): change SUN_SHADOW.bias, RENDER's
 * exposure or SKY.hemiIntensity; re-add `ren.toneMappingExposure = 0.85` to
 * the house or a `new THREE.DirectionalLight` to spec-three.jsx; drop the
 * margin sign or flip the right axis in fitSunShadow; change the evening
 * sign in presetSun; drop the 8-bit quantisation in liveFinishTexel.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const imp = rel => import(pathToFileURL(path.join(root, rel)).href);
const THREE = await imp('vendor/three-r160/three.module.min.js');
const R = await imp('src/render-rig.js');
const Sun = await imp('src/sun-position.js');
const Fin = await imp('src/furniture/finishes.js');
const M = await imp('src/furniture/merge.js');

let passes = 0, failures = 0;
function check(name, ok, detail) {
  if (ok) { passes++; return; }
  failures++;
  console.log('FAIL: ' + name + (detail !== undefined ? '\n      ' + JSON.stringify(detail) : ''));
}
const near = (a, b, eps) => Math.abs(a - b) <= (eps || 1e-12);

// ------------------------------------------------------------ 1. the values
{
  // A stand-in renderer: applyRendererSettings only writes properties.
  const ren = { shadowMap: { type: null }, toneMapping: null, toneMappingExposure: null, outputColorSpace: null };
  R.applyRendererSettings(THREE, ren);
  check('renderer: ACES filmic tone mapping', ren.toneMapping === THREE.ACESFilmicToneMapping, ren.toneMapping);
  check('renderer: exposure 0.85 (the house)', ren.toneMappingExposure === 0.85, ren.toneMappingExposure);
  check('renderer: sRGB output (three r160 default, what the house draws in)', ren.outputColorSpace === THREE.SRGBColorSpace);
  check('renderer: PCF shadows (three default, what the house uses; the spec viewer used PCFSoft)',
    ren.shadowMap.type === THREE.PCFShadowMap);

  const { hemi, sun } = R.createSkyRig(THREE, { castShadow: true, shadowMapScale: 1 });
  check('sky fill is a HemisphereLight 0xd9d9e6 / 0xd9d9e6 at 0.12', hemi.isHemisphereLight &&
    hemi.color.getHex() === 0xd9d9e6 && hemi.groundColor.getHex() === 0xd9d9e6 && hemi.intensity === 0.12);
  check('sun is a DirectionalLight 0xffeedd at 0.25 as built', sun.isDirectionalLight &&
    sun.color.getHex() === 0xffeedd && sun.intensity === 0.25);
  const sc = sun.shadow.camera;
  check('sun shadow: 2048 map, bias -0.0005, normalBias 0', sun.castShadow && sun.shadow.mapSize.width === 2048 &&
    sun.shadow.mapSize.height === 2048 && sun.shadow.bias === -0.0005 && sun.shadow.normalBias === 0,
    { map: sun.shadow.mapSize, bias: sun.shadow.bias, nb: sun.shadow.normalBias });
  check('sun shadow camera: +-15 m, near 0.5, far 40 (the house frustum)',
    sc.left === -15 && sc.right === 15 && sc.top === 15 && sc.bottom === -15 && sc.near === 0.5 && sc.far === 40);
  const low = R.createSkyRig(THREE, { castShadow: false, shadowMapScale: 0.25 });
  check('shadowMapScale 0.25 -> 512 map; castShadow follows the option',
    low.sun.shadow.mapSize.width === 512 && low.sun.castShadow === false);

  check('SUN_SHADOW.lightDistance is 25 m (the depth range the bias is measured on)', R.SUN_SHADOW.lightDistance === 25);

  // The room shadow light exactly as the house built it inline before.
  const w = 3.7, d = 5.2, WH = 2.5, cx = 1.3, cz = -2.1;
  const l = R.createRoomShadowLight(THREE, { cx, cz, w, d, floorY: 0, ceiling: WH, shadowMapScale: 1 });
  const spotY = 0 + WH - 0.15;
  const halfDiag = Math.sqrt(w * w + d * d) / 2;
  const angle = Math.min(Math.atan2(halfDiag * 1.15, spotY), 1.40);
  const range = Math.max(w, d) * 1.2;
  check('room shadow light: downward SpotLight, 0xfff4cc 0.4, house range/angle/penumbra/decay',
    l.isSpotLight && l.color.getHex() === 0xfff4cc && l.intensity === 0.4 && l.distance === range &&
    l.angle === angle && l.penumbra === 0.8 && l.decay === 1.5, { distance: l.distance, angle: l.angle });
  check('room shadow light: at the ceiling over the room, aimed straight down',
    l.position.x === cx && l.position.y === spotY && l.position.z === cz &&
    l.target.position.x === cx && l.target.position.y === 0 && l.target.position.z === cz);
  check('room shadow light: 1024 map, bias -0.0008, near 0.1, far = range', l.castShadow &&
    l.shadow.mapSize.width === 1024 && l.shadow.bias === -0.0008 && l.shadow.camera.near === 0.1 && l.shadow.camera.far === range);

  // The house's k2h, as it was.
  const k2h = k => { const t = Math.max(0, Math.min(1, (k - 2700) / 3800)); return (Math.round(255 - t * 30) << 16) | (Math.round(215 + t * 30) << 8) | Math.round(160 + t * 90); };
  check('kelvinToHex is the house ramp', [2000, 2700, 3000, 4000, 5000, 6500, 9000].every(k => R.kelvinToHex(k) === k2h(k)));
  check('room main light gain 0.6, 4000 K default', R.ROOM_LIGHT.mainGain === 0.6 && R.ROOM_LIGHT.defaultTemp === 4000);

  // Night room 'spots': the house's spot-cluster light (ONE PointLight at
  // intensity 0.6, range 2 x the longer side, decay 1.5, 18 cm under the
  // ceiling -- home3d-scene.js addSpotMesh + syncLights) and the shadow spot.
  const [main, spot] = R.createGenericRoomLights(THREE, { kind: 'spots' });
  check('night room spots: the spot-cluster light at the house main gain, 4000 K, and the shadow spot driven the same',
    main.isPointLight && main.intensity === 0.6 && main.color.getHex() === k2h(4000) && main.decay === 1.5 &&
    near(main.distance, 4.4 * 2) && near(main.position.y, 2.5 - 0.18) &&
    spot.isSpotLight && spot.intensity === 0.6 && spot.color.getHex() === k2h(4000) && spot.castShadow);
  // In FRONT of the item (front face at z = 0, facing +z), never over it:
  // a front face lit from over its own top gets nothing (review 88739b91).
  for (const kind of ['spots', 'downlights']) {
    const ls = R.createGenericRoomLights(THREE, { kind });
    check(kind + ': every room light hangs >= 0.5 m in front of the item front, at ceiling height',
      ls.every(l => l.position.z >= 0.5 && l.position.y > 2.2), ls.map(l => l.position.toArray()));
    R.placeGenericRoomLights(ls, 2, -1);
    check(kind + ': placing onto an item moves every light (and the spot target) by the item offset',
      ls.every(l => near(l.position.x - 2, l.userData.rel[0]) && near(l.position.z + 1, l.userData.rel[1])) &&
      ls.filter(l => l.target).every(l => near(l.target.position.x, l.position.x) && near(l.target.position.z, l.position.z)));
  }
  // 'downlights': six fixtures merged by collapseEmitters exactly as the house
  // merges a channel -- here into two lights, one per end of the grid, each
  // carrying its three fixtures' gain.
  const dl = R.createGenericRoomLights(THREE, { kind: 'downlights' });
  const mains = dl.filter(l => l.isPointLight);
  check('downlights: two merged lights, decay 1.8, gain ~2.8 each (as the house merges six downlights)',
    mains.length === 2 && mains.every(l => l.decay === 1.8 && l.userData.gain > 2.5 && l.userData.gain < 3.1 &&
      near(l.intensity, 0.6 * l.userData.gain, 1e-9)), mains.map(l => [l.userData.gain, l.decay]));
  check('downlights: the two sit either side of the item along the wall', mains[0].position.x * mains[1].position.x < 0);
}

// ------------------------------------------------------------ 2. both consumers
{
  const house = fs.readFileSync(path.join(root, 'src/home3d-scene.js'), 'utf8');
  const spec = fs.readFileSync(path.join(root, 'specs/spec-three.jsx'), 'utf8');
  const code = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"])\/\/.*$/gm, '$1'); // strip comments
  const H = code(house), S = code(spec);

  check('house imports the rig', /from '\.\/render-rig\.js'/.test(H));
  for (const fn of ['applyRendererSettings(THREE, ren)', 'createSkyRig(THREE', 'presetSun(sunMode', 'applyDaylight(skyRig', 'applyNight(skyRig)', 'createRoomShadowLight(THREE']) {
    check('house calls ' + fn, H.includes(fn));
  }
  check('spec harness loads ../src/render-rig.js relative to its own script', /new URL\('\.\.\/src\/render-rig\.js', tag \? tag\.src/.test(S));
  for (const fn of ['R.applyRendererSettings(THREE, renderer)', 'R.createSkyRig(THREE', 'R.presetSun(lit.preset', 'R.applyDaylight(lit.sky',
    'R.createGenericRoomLights(THREE', 'R.applyLiveFinishes(sceneRoot)', 'lit.rig.fitSunShadow(lit.sky.sun']) {
    check('spec harness calls ' + fn, S.includes(fn));
  }
  // Neither lights on its own.
  const own = [
    [/new THREE\.(DirectionalLight|HemisphereLight|AmbientLight)\(/, 'constructs its own sun / sky / ambient light'],
    [/toneMapping\s*=/, 'sets its own tone mapping'],
    [/toneMappingExposure\s*=/, 'sets its own exposure'],
    [/shadowMap\.type\s*=/, 'sets its own shadow-map type'],
    [/\.shadow\.(bias|normalBias)\s*=/, 'sets its own shadow bias'],
  ];
  for (const [re, what] of own) {
    check('house never ' + what, !re.test(H), (H.match(re) || [])[0]);
    check('spec harness never ' + what, !re.test(S), (S.match(re) || [])[0]);
  }
  check('spec harness installs no environment map (the house has none)',
    !/scene\.environment\s*=/.test(S) && !/CubeCamera|WebGLCubeRenderTarget/.test(S));
  check('spec harness has no spec-only rig left (ambient / key / fill)', !/\b(ambient|key|fill)\.intensity/.test(S));

  // Live: the same preset lit the house's way and the spec page's way.
  const a = R.createSkyRig(THREE, { castShadow: true }), b = R.createSkyRig(THREE, { castShadow: true });
  for (const mode of ['morning', 'noon', 'evening', 'night']) {
    const s = R.presetSun(mode, { hasSite: false });
    R.applyDaylight(a, s, { northOffset: 0, centre: [7.5, -3.2], shadowed: true });   // a house centre
    R.applyDaylight(b, s, { centre: [0, 0], shadowed: true });                         // a spec item
    check(mode + ': house and spec sun colour, intensity; sky colours, intensity identical',
      a.sun.color.equals(b.sun.color) && a.sun.intensity === b.sun.intensity && a.hemi.color.equals(b.hemi.color) &&
      a.hemi.groundColor.equals(b.hemi.groundColor) && a.hemi.intensity === b.hemi.intensity);
    const da = a.sun.position.clone().sub(new THREE.Vector3(7.5, 0, -3.2)), db = b.sun.position.clone();
    check(mode + ': same sun direction and distance from its target', da.distanceTo(db) < 1e-9, [da, db]);
  }
  check('shadow settings identical on both (map, bias, normalBias, near, far)',
    a.sun.shadow.mapSize.equals(b.sun.shadow.mapSize) && a.sun.shadow.bias === b.sun.shadow.bias &&
    a.sun.shadow.normalBias === b.sun.shadow.normalBias && a.sun.shadow.camera.near === b.sun.shadow.camera.near &&
    a.sun.shadow.camera.far === b.sun.shadow.camera.far);
  // The house's daylight at noon has sun; night has none and the NIGHT fill.
  const n = R.createSkyRig(THREE, {});
  R.applyDaylight(n, R.presetSun('night', {}), { shadowed: true });
  check('night preset: no sun, the NIGHT fill', n.sun.intensity === 0 && near(n.hemi.intensity, Sun.NIGHT.fill, 1e-9), n.sun.intensity);
  R.applyNight(n);
  check('applyNight: sun off, NIGHT fill, ground colour = sky colour', n.sun.intensity === 0 &&
    n.hemi.intensity === Sun.NIGHT.fill && n.hemi.color.equals(n.hemi.groundColor) && near(n.hemi.color.r, Sun.NIGHT.fillColor[0], 1e-6));
  // The steep hold without shadows, the 3 deg floor with.
  const lowSun = { azimuth: 200, elevation: 1 };
  R.applyDaylight(n, lowSun, { shadowed: true });
  const el3 = Math.asin(n.sun.position.y / 25) * 180 / Math.PI;
  R.applyDaylight(n, lowSun, { shadowed: false });
  const el60 = Math.asin(n.sun.position.y / 25) * 180 / Math.PI;
  check('a 1 deg sun is held at 3 deg with shadows, 60 deg without', near(el3, 3, 1e-9) && near(el60, 60, 1e-9), [el3, el60]);
}

// ------------------------------------------------------------ 3. presets
{
  const place = { hasSite: true, latitude: 51.5, longitude: -0.12, now: new Date('2026-09-28T08:15:00Z') };
  // What the house's currentSun() computed before the move.
  const noon = Sun.solarNoon(place.now, place.longitude);
  const old = {
    noon: Sun.solarPosition(noon, place.latitude, place.longitude),
    morning: Sun.solarPosition(new Date(noon.getTime() - 3.5 * 3600000), place.latitude, place.longitude)
  };
  for (const m of ['noon', 'morning']) {
    const p = R.presetSun(m, place);
    check(m + ' with a site: exactly the house\'s old preset', p.azimuth === old[m].azimuth && p.elevation === old[m].elevation && p.source === 'preset', p);
  }
  const ev = R.presetSun('evening', place), mo = R.presetSun('morning', place), no = R.presetSun('noon', place);
  // (solarNoon ignores the equation of time, up to ~16 min, so the two are
  // only roughly symmetric: a few degrees.)
  check('evening mirrors morning about solar noon (elevation within 4 deg, azimuth either side of noon\'s)',
    Math.abs(ev.elevation - mo.elevation) < 4 && mo.azimuth < no.azimuth && ev.azimuth > no.azimuth, { mo, no, ev });
  const exp = Sun.solarPosition(new Date(noon.getTime() + 3.5 * 3600000), place.latitude, place.longitude);
  check('evening is solar noon + 3.5 h', ev.azimuth === exp.azimuth && ev.elevation === exp.elevation);
  check('night: az 0, el -20', JSON.stringify(R.presetSun('night', place)) === JSON.stringify({ azimuth: 0, elevation: -20, source: 'preset' }));
  check('no site: noon 180/50, morning 110/16 (the house\'s), evening 250/16',
    JSON.stringify(['noon', 'morning', 'evening'].map(m => { const p = R.presetSun(m, {}); return [p.azimuth, p.elevation]; })) ===
    JSON.stringify([[180, 50], [110, 16], [250, 16]]));
  check('auto / unknown -> null (the house then follows the clock)', R.presetSun('auto', place) === null && R.presetSun('dusk', place) === null);
  check('SUN_PRESETS lists the four in control order', R.SUN_PRESETS.join() === 'morning,noon,evening,night');
}

// ------------------------------------------------------------ 4. shadow frustum fit
{
  // Project with three's OWN shadow matrices (DirectionalLightShadow.updateMatrices).
  function inFrustum(sun, pts) {
    sun.updateMatrixWorld(true); sun.target.updateMatrixWorld(true);
    sun.shadow.updateMatrices(sun);
    const m = sun.shadow.matrix; // bias * proj * view: [0,1] texture space
    let worst = 0;
    for (const p of pts) {
      const v = new THREE.Vector4(p[0], p[1], p[2], 1).applyMatrix4(m);
      worst = Math.max(worst, -v.x, v.x - 1, -v.y, v.y - 1, -v.z, v.z - 1);
    }
    return worst; // <= 0: every point inside
  }
  const box = (x0, y0, z0, x1, y1, z1) => {
    const pts = [];
    for (let i = 0; i < 8; i++) pts.push([i & 1 ? x1 : x0, i & 2 ? y1 : y0, i & 4 ? z1 : z0]);
    return pts;
  };
  const shadowOf = (sun, p) => { // where the sun ray through p meets y = 0
    const to = sun.position.clone().sub(sun.target.position).normalize();
    const k = p[1] / to.y;
    return [p[0] - to.x * k, 0, p[2] - to.z * k];
  };
  const item = box(-0.49, 0, -0.06, 0.49, 0.6, 0.06);   // a radiator
  for (const mode of ['morning', 'noon', 'evening']) {
    const rig = R.createSkyRig(THREE, { castShadow: true });
    R.applyDaylight(rig, R.presetSun(mode, {}), { centre: [0, 0], shadowed: true });
    const f = R.fitSunShadow(rig.sun, item);
    const shadows = item.filter(p => p[1] > 0).map(p => shadowOf(rig.sun, p));
    check(mode + ': every caster corner inside the fitted frustum', inFrustum(rig.sun, item) <= 1e-9, inFrustum(rig.sun, item));
    check(mode + ': every shadow the item throws on the floor inside it too', inFrustum(rig.sun, shadows) <= 1e-9, inFrustum(rig.sun, shadows));
    const w = f.right - f.left, h = f.top - f.bottom;
    check(mode + ': tight -- far smaller than the house\'s 30 m frustum (< 3 m a side)', w < 3 && h < 3 && w > 0.5, f);
    // tight on every side: shrink any side by 2x the margin and something falls out
    const cam = rig.sun.shadow.camera;
    for (const side of ['left', 'right', 'top', 'bottom']) {
      const keep = cam[side];
      cam[side] += (side === 'left' || side === 'bottom' ? 1 : -1) * 2 * R.SHADOW_FIT_MARGIN;
      cam.updateProjectionMatrix();
      check(mode + ': the ' + side + ' side is tight', inFrustum(rig.sun, item.concat(shadows)) > 0);
      cam[side] = keep; cam.updateProjectionMatrix();
    }
    check(mode + ': near/far/bias stay the shared ones', cam.near === 0.5 && cam.far === 40 && rig.sun.shadow.bias === -0.0005);
  }
  // A very low sun: the long shadow across the floor is still inside, and
  // the frustum stays small (no world-sized fallback).
  const rig = R.createSkyRig(THREE, { castShadow: true });
  R.applyDaylight(rig, { azimuth: 250, elevation: 3 }, { centre: [0, 0], shadowed: true });
  // (Depth still bounds it, exactly as in the house: near/far 0.5-40 m with
  // the light 25 m out reach ~15 m past the target, so a 0.6 m item's 11 m
  // shadow is inside and a 2.2 m item's 42 m one is cut there, as it is in
  // the house.)
  const tall = box(-0.5, 0, -0.5, 0.5, 0.6, 0.5);
  const f = R.fitSunShadow(rig.sun, tall);
  check('3 deg sun: the 11 m shadow of a 0.6 m item lands inside the fit', inFrustum(rig.sun, tall.filter(p => p[1] > 0).map(p => shadowOf(rig.sun, p))) <= 1e-9);
  check('3 deg sun: the fit stays item-sized', (f.right - f.left) < 3 && (f.top - f.bottom) < 3, f);
  // An off-centre item.
  const r2 = R.createSkyRig(THREE, { castShadow: true });
  R.applyDaylight(r2, R.presetSun('noon', {}), { centre: [3, -2], shadowed: true });
  r2.sun.target.position.set(3, 0, -2);
  const off = box(2.5, 0, -2.3, 3.5, 0.8, -1.7);
  R.fitSunShadow(r2.sun, off, {});
  check('an off-centre item is inside its own fit', inFrustum(r2.sun, off) <= 1e-9);
  check('no points -> the house extent, not NaN', (() => { const r3 = R.createSkyRig(THREE, {}); const g = R.fitSunShadow(r3.sun, [], {}); return g.right === 15 + R.SHADOW_FIT_MARGIN; })());
}

// ------------------------------------------------------------ 5. finishes
{
  const tex = M.makePaletteTexture(THREE);
  const d = tex.image.data;
  for (const f of R.LIVE_PALETTE_FINISHES) {
    const i = M.PALETTE_FINISHES.indexOf(f);
    const t = R.liveFinishTexel(f);
    check(f + ': spec texel == the house palette texel (roughness G, metalness B)',
      i >= 0 && t.roughness === d[i * 4 + 1] / 255 && t.metalness === d[i * 4 + 2] / 255, { t, g: d[i * 4 + 1], b: d[i * 4 + 2] });
  }
  tex.dispose();
  const g = new THREE.Group();
  const add = (mat, tagMesh) => { const m = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.1), mat); if (tagMesh) m.userData.finish = tagMesh; g.add(m); return mat; };
  const metal = add(Fin.makeFinish(THREE, 'metal', '#c3c6c9'));
  const mirror = add(Fin.makeFinish(THREE, 'mirror'));
  const matte = add(Fin.makeFinish(THREE, 'matte', '#ffffff'));
  const glass = add(Fin.makeFinish(THREE, 'glass', '#ffffff'));
  const glow = add(Fin.makeFinish(THREE, 'emissive', '#ffffff'));
  const bare = add(new THREE.MeshStandardMaterial({ roughness: 0.3, metalness: 0.9 }));
  const meshTagged = add(new THREE.MeshStandardMaterial({ roughness: 0.35, metalness: 0.9 }), 'metal');
  const n = R.applyLiveFinishes(g);
  const L = f => R.liveFinishTexel(f);
  check('metal part: the house\'s live metal', metal.metalness === L('metal').metalness && metal.roughness === L('metal').roughness, [metal.roughness, metal.metalness]);
  check('mirror part: the house\'s silvered grey, not a black mirror', mirror.metalness === L('mirror').metalness && mirror.metalness < 0.5);
  check('matte part: unchanged in value (texel of 0.8/0)', matte.roughness === L('matte').roughness && matte.metalness === 0);
  check('glass and emissive untouched', glass.roughness === Fin.FINISH_PARAMS.glass.roughness && glow.roughness === Fin.FINISH_PARAMS.emissive.roughness &&
    !glass.userData.liveFinish && !glow.userData.liveFinish);
  check('untagged material untouched (hand-made fittings keep their own)', bare.metalness === 0.9 && bare.roughness === 0.3);
  check('a finish tagged on the MESH is honoured too (partFinish)', meshTagged.metalness === L('metal').metalness);
  check('changed count: metal, mirror, matte and the mesh-tagged metal', n === 4, n);
  check('idempotent: a second pass changes nothing', R.applyLiveFinishes(g) === 0 && metal.metalness === L('metal').metalness);
}

console.log(`test-render-rig: ${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
