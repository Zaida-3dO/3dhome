#!/usr/bin/env node
/**
 * Camera focus (src/camera-focus.js) -- the view maths, the selection
 * reducer, the batching controller and the device-tap generation gate; plus
 * the house-loader pass-through of a profile `view` and the wiring in
 * index.html / tap-popovers.js / home3d-scene.js that a parse cannot see.
 * No framework, no install -- `node scripts/test-camera-focus.mjs`.
 *
 * WHAT THIS GUARDS
 *   1. Azimuth interpolation takes the shortest arc (350 deg -> 10 deg turns
 *      20 deg, not 340); distance interpolates in log space; ease-in-out.
 *   2. An L-shaped room's aim point is INSIDE the room (its centroid is not).
 *   3. A derived room view keeps every polygon vertex on screen, at the
 *      house's FIXED home angle (not the current azimuth), and frames beside
 *      a sidebar that covers the right of the canvas.
 *   4. A device view faces the item's front.
 *   5. Reducer: home captured on the way out of "nothing selected" and
 *      restored exactly on click-away; room A -> device -> close card returns
 *      to room A; room A -> room B -> click-away returns to the ORIGINAL home;
 *      a gesture-driven deselect never flies and forgets home.
 *   6. Controller: a card closing and a room selected in one batch is ONE
 *      room flight (amendment 4); a drag in the hold makes the batch a gesture.
 *   7. Gate: a newer tap supersedes an older one; a stale await never opens a
 *      card for the earlier target (amendment 3).
 *   8. Loader: a profile `view` compiles with the transform applied; a room
 *      without one compiles to null.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const imp = rel => import(pathToFileURL(path.join(root, rel)).href);
// CRLF-normalised: a Windows checkout has CRLF, CI has LF.
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8').replace(/\r\n/g, '\n');

let passes = 0, failures = 0;
function check(name, ok, detail) {
  if (ok) { passes++; console.log('  ok   ' + name); }
  else { failures++; console.error('  FAIL ' + name + (detail !== undefined ? '\n       ' + JSON.stringify(detail) : '')); }
}
const near = (a, b, eps) => Math.abs(a - b) <= (eps == null ? 1e-9 : eps);

const F = await imp('src/camera-focus.js');
const { insidePoly } = await imp('src/footstep-walk.js');

// ---- 1. interpolation ------------------------------------------------------
console.log('interpolation');
{
  const deg = d => d * Math.PI / 180;
  const a = { th: deg(350), ph: 1, r: 2, tgt: [0, 0, 0], fov: 50 };
  const b = { th: deg(10), ph: 1, r: 32, tgt: [10, 0, -10], fov: 50 };
  const mid = F.lerpPose(a, b, 0.5);
  check('shortest arc: 350 deg -> 10 deg passes through 360, not 180', near(((mid.th % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI), 0, 1e-9), mid.th);
  check('shortest arc: the end is 10 deg (mod 360)', near(Math.cos(F.lerpPose(a, b, 1).th), Math.cos(deg(10))) && near(Math.sin(F.lerpPose(a, b, 1).th), Math.sin(deg(10))));
  check('shortest arc the other way: 10 -> 350 turns -20 deg', near(F.shortestArc(deg(10), deg(350)), deg(-20)));
  check('distance is log-space: halfway from 2 to 32 is 8', near(mid.r, 8, 1e-9), mid.r);
  check('target is linear', near(mid.tgt[0], 5) && near(mid.tgt[2], -5));
  check('t=0 is the start, t=1 the end', near(F.lerpPose(a, b, 0).r, 2) && near(F.lerpPose(a, b, 1).r, 32));
  check('easeInOut: 0, 0.5, 1 fixed points; slow start', F.easeInOut(0) === 0 && near(F.easeInOut(0.5), 0.5) && F.easeInOut(1) === 1 && F.easeInOut(0.1) < 0.1);
}

// ---- 2. interior point -------------------------------------------------------
console.log('interior point');
// An L: a 600 x 600 square with its 400 x 400 north-east corner cut away.
// The centroid falls in the cut-away corner's diagonal band -- outside.
const L = [[0, 0], [200, 0], [200, 400], [600, 400], [600, 600], [0, 600]];
{
  const c = F.polygonCentroid(L);
  check('the L fixture is a real trap: its centroid is OUTSIDE the room', !insidePoly(L, c[0], c[1]), c);
  const p = F.interiorPoint(L);
  check('interiorPoint of the L is inside it', insidePoly(L, p[0], p[1]), p);
  const sq = [[0, 0], [400, 0], [400, 300], [0, 300]];
  const q = F.interiorPoint(sq);
  check('interiorPoint of a rectangle is its centre', near(q[0], 200) && near(q[1], 150), q);
}

// ---- 3. room view ------------------------------------------------------------
console.log('room view');
// Project world points with a pinhole camera at the pose, the same maths as
// the scene's updCam + a PerspectiveCamera; returns NDC.
function project(pose, aspect, p) {
  const b = F.backVector(pose.th, pose.ph);
  const eye = [pose.tgt[0] + b[0] * pose.r, pose.tgt[1] + b[1] * pose.r, pose.tgt[2] + b[2] * pose.r];
  const { right, up } = F.cameraBasis(pose.th, pose.ph);
  const fwd = [-b[0], -b[1], -b[2]];
  const q = [p[0] - eye[0], p[1] - eye[1], p[2] - eye[2]];
  const z = q[0] * fwd[0] + q[1] * fwd[1] + q[2] * fwd[2];
  const tv = Math.tan(pose.fov * Math.PI / 360);
  return { x: (q[0] * right[0] + q[1] * right[1] + q[2] * right[2]) / (z * tv * aspect), y: (q[0] * up[0] + q[1] * up[1] + q[2] * up[2]) / (z * tv), z };
}
{
  const toWorld = (x, y) => [(x - 300) * 0.01, (y - 300) * 0.01];
  const HOME_TH = Math.PI * 0.22, HOME_PH = Math.PI * 0.32;
  for (const aspect of [1280 / 800, 390 / 844]) {
    const v = F.deriveRoomView({ poly: L, toWorld, th: HOME_TH, ph: HOME_PH, fov: 50, aspect, minR: 0 });
    const ndc = L.map(p => { const w = toWorld(p[0], p[1]); return project(v, aspect, [w[0], 0, w[1]]); });
    const worst = Math.max(...ndc.map(n => Math.max(Math.abs(n.x), Math.abs(n.y))));
    check('L room: every vertex on screen at aspect ' + aspect.toFixed(2), worst <= 1 + 1e-9 && ndc.every(n => n.z > 0), worst);
    check('L room: framed tight, not from orbit (largest |ndc| > 0.8) at aspect ' + aspect.toFixed(2), worst > 0.8, worst);
  }
  const v1 = F.deriveRoomView({ poly: L, toWorld, th: HOME_TH, ph: HOME_PH, fov: 50, aspect: 1.6 });
  check('room view uses the FIXED home angle given, whatever the camera is doing', v1.th === HOME_TH && v1.ph === HOME_PH);
  check('room view target is at floor level, inside the room', v1.tgt[1] === 0);
  // Sidebar inset: frame in the uncovered left part; the room's vertices
  // land left of the covered strip.
  const W = 1280, H = 800, inset = { right: 300, width: W, height: H };
  const vi = F.deriveRoomView({ poly: L, toWorld, th: HOME_TH, ph: HOME_PH, fov: 50, aspect: W / H, inset, minR: 0 });
  const xs = L.map(p => { const w = toWorld(p[0], p[1]); return (project(vi, W / H, [w[0], 0, w[1]]).x + 1) / 2 * W; });
  check('with a 300px sidebar the room stays in the uncovered 980px', Math.max(...xs) <= W - 300 + 1 && Math.min(...xs) >= -1, xs.map(Math.round));
  check('minimum distance is honoured', F.deriveRoomView({ poly: [[0, 0], [10, 0], [10, 10], [0, 10]], toWorld, th: 1, ph: 1, fov: 50, aspect: 1 }).r === F.ROOM_VIEW.minR);
  check('maxR clamps a huge room', F.deriveRoomView({ poly: L.map(p => [p[0] * 100, p[1] * 100]), toWorld, th: 1, ph: 1, fov: 50, aspect: 1, maxR: 20 }).r === 20);
}

// ---- 4. item view ------------------------------------------------------------
console.log('item view');
{
  // rotation 0: front faces +y (south) -> plan (0, 1) -> world +Z -> th = PI/2.
  const f0 = F.frontFromRotation(0);
  check('rotation 0 faces +y (south)', near(f0[0], 0) && near(f0[1], 1));
  const f90 = F.frontFromRotation(90);
  check('rotation 90 faces west (-x)', near(f90[0], -1) && near(f90[1], 0, 1e-12));
  const box = { min: [0, 0, 0], max: [1, 1, 1] };
  const v = F.deriveItemView({ box, front: f0, th: 0 });
  check('item view faces the front: camera on +Z side (th = PI/2)', near(v.th, Math.PI / 2));
  check('item view target is the box centre', near(v.tgt[0], 0.5) && near(v.tgt[1], 0.5) && near(v.tgt[2], 0.5));
  check('item view distance is diag x 2.2', near(v.r, Math.sqrt(3) * 2.2));
  const tiny = F.deriveItemView({ box: { min: [0, 0, 0], max: [0.1, 0.1, 0.1] }, front: null, th: 1.25 });
  check('no front: keeps the given azimuth; tiny item gets the 1.2 m minimum', tiny.th === 1.25 && tiny.r === 1.2);
}

// ---- 5. reducer ----------------------------------------------------------------
console.log('reducer');
const HOME = { th: 0.7, ph: 1.0, r: 12.345678, tgt: [0.1, 0, -0.2], fov: 50 };
const VIEWS = { 'r:room_a': { th: 1, ph: 1, r: 4, tgt: [1, 0, 1], fov: 50 }, 'r:room_b': { th: 1, ph: 1, r: 5, tgt: [2, 0, 2], fov: 50 },
  'd:light:room_a/main': { th: 2, ph: 1, r: 1.5, tgt: [1, 2, 1], fov: 50 } };
const resolve = sel => VIEWS[F.focusKey(sel)] || null;
const DEV = { kind: 'light', id: 'room_a/main' };
{
  let st = F.FOCUS_INITIAL;
  let res = F.focusReduce(st, { room: 'room_a' }, 'explicit', HOME, resolve);
  check('nothing -> room: flies to the room view', res.fly === VIEWS['r:room_a']);
  check('nothing -> room: captures the current pose as home', res.state.home && res.state.home.r === HOME.r && res.state.home !== HOME);
  st = res.state;
  res = F.focusReduce(st, { room: 'room_a', device: DEV }, 'explicit', VIEWS['r:room_a'], resolve);
  check('room -> device: flies to the device; home unchanged', res.fly === VIEWS['d:light:room_a/main'] && res.state.home.r === HOME.r);
  st = res.state;
  res = F.focusReduce(st, { room: 'room_a', device: null }, 'explicit', VIEWS['d:light:room_a/main'], resolve);
  check('close the card: back to room A, not home', res.fly === VIEWS['r:room_a']);
  st = res.state;
  res = F.focusReduce(st, { room: 'room_b' }, 'explicit', VIEWS['r:room_a'], resolve);
  check('room A -> room B: flies to B, home still the ORIGINAL pose', res.fly === VIEWS['r:room_b'] && res.state.home.r === HOME.r);
  st = res.state;
  res = F.focusReduce(st, { room: null }, 'explicit', VIEWS['r:room_b'], resolve);
  check('click-away: flies to the original home pose, exactly', res.fly && res.fly.th === HOME.th && res.fly.ph === HOME.ph &&
    res.fly.r === HOME.r && res.fly.tgt.every((x, i) => x === HOME.tgt[i]), res.fly);
  check('click-away: home is forgotten', res.state.home === null);
  // Same selection again: nothing.
  const same = F.focusReduce({ room: 'room_a', device: null, home: HOME }, { room: 'room_a' }, 'explicit', HOME, resolve);
  check('no change, no flight', same.fly === null && same.state.home === HOME);
  // Amendment 1: a gesture-driven deselect never flies, and forgets home.
  const g = F.focusReduce({ room: 'room_a', device: null, home: HOME }, { room: null }, 'gesture', VIEWS['r:room_a'], resolve);
  check('gesture deselect: no flight', g.fly === null);
  check('gesture deselect: home cleared', g.state.home === null);
  // ...and the NEXT selection captures a new home: wherever the user left it.
  const here = { th: 3, ph: 0.5, r: 7, tgt: [0, 0, 0], fov: 50 };
  const n2 = F.focusReduce(g.state, { room: 'room_b' }, 'explicit', here, resolve);
  check('after a gesture deselect the next selection captures a fresh home', n2.state.home.th === 3);
  const gk = F.focusReduce({ room: 'room_a', device: DEV, home: HOME }, { room: 'room_a', device: null }, 'gesture', HOME, resolve);
  check('gesture closing a card with the room still selected: no flight, home kept', gk.fly === null && gk.state.home === HOME);
}

// ---- 6. controller ---------------------------------------------------------------
console.log('controller');
{
  const flights = [];
  let pose = HOME;
  const queue = [];
  const ctl = F.createFocusController({
    getPose: () => pose, fly: p => { flights.push(p); pose = p; return Promise.resolve('landed'); },
    resolveView: resolve, schedule: fn => queue.push(fn),
  });
  const drain = () => { while (queue.length) queue.shift()(); };
  // Amendment 4: room A, device, then a tap on room B while the card is open.
  // The pointer down closes the card (device -> null) and the click selects
  // room B, inside one hold: ONE flight, to room B.
  ctl.request({ room: 'room_a' }, 'explicit'); drain();
  ctl.request({ device: DEV }, 'explicit'); await ctl.flushNow();
  check('setup: two flights (room A, then device)', flights.length === 2, flights.length);
  ctl.hold();
  ctl.request({ device: null }, 'explicit');   // the card closes on pointer down
  ctl.request({ room: 'room_b' }, 'explicit'); // the click selects room B
  drain();
  check('nothing is decided while the pointer is held', flights.length === 2);
  await ctl.release('explicit');
  check('card close + room B in one batch: exactly ONE more flight', flights.length === 3, flights.length);
  check('...and it goes to room B (not room A, not home)', flights[2] === VIEWS['r:room_b']);
  check('home is still the original pose', ctl.state().home.r === HOME.r);
  // A drag in the hold: the sidebar closing clears the room as a gesture.
  ctl.hold();
  ctl.request({ room: null }, 'explicit');
  ctl.markGesture();
  await ctl.release('gesture');
  check('drag after a room tap: no return flight (amendment 1)', flights.length === 3, flights.length);
  check('drag after a room tap: home forgotten', ctl.state().home === null);
  // A burst outside a hold is decided on the next task, together.
  ctl.request({ room: 'room_a' }, 'explicit');
  ctl.request({ room: 'room_b' }, 'explicit');
  check('outside a hold: deferred to the next task', flights.length === 3);
  drain();
  check('a synchronous burst is one flight, to the last selection', flights.length === 4 && flights[3] === VIEWS['r:room_b']);
  // Click away, then select again BEFORE the return flight lands: home is
  // the original pose, not wherever the return flight had got to.
  {
    let resolveHome, cur = HOME;
    const fl = [];
    const c2 = F.createFocusController({
      getPose: () => cur,
      fly: p => { fl.push(p); return p.r === HOME.r ? new Promise(r => { resolveHome = r; }) : Promise.resolve('landed'); },
      resolveView: resolve, schedule: fn => fn(),
    });
    c2.request({ room: 'room_a' }, 'explicit'); cur = VIEWS['r:room_a'];
    c2.request({ room: null }, 'explicit');            // flying home...
    check('click-away starts the return flight', fl.length === 2 && fl[1].r === HOME.r);
    cur = { th: 9, ph: 9, r: 99, tgt: [9, 9, 9], fov: 50 };   // ...mid-flight pose
    c2.request({ room: 'room_b' }, 'explicit');
    check('re-selecting mid-return captures the ORIGINAL home, not the mid-flight pose', c2.state().home.r === HOME.r, c2.state().home);
    resolveHome('superseded');
    // The next tap's pointer down CANCELS the return flight before that tap
    // selects: home must still be the original, not the mid-flight pose.
    let resolve3;
    const c3 = F.createFocusController({
      getPose: () => cur,
      fly: p => (p.r === HOME.r ? new Promise(r => { resolve3 = r; }) : Promise.resolve('landed')),
      resolveView: resolve, schedule: fn => fn(),
    });
    cur = HOME;
    c3.request({ room: 'room_a' }, 'explicit'); cur = VIEWS['r:room_a'];
    c3.request({ room: null }, 'explicit');
    cur = { th: 8, ph: 8, r: 88, tgt: [8, 8, 8], fov: 50 };
    resolve3('cancelled'); await Promise.resolve(); await Promise.resolve();
    c3.request({ room: 'room_b' }, 'explicit');
    check('return flight cancelled by the next tap: home is still the original', c3.state().home.r === HOME.r, c3.state().home);
    // ...but a drag/wheel in between forgets it: the user moved the camera.
    c3.request({ room: null }, 'explicit');
    c3.markGesture();
    c3.request({ room: 'room_a' }, 'explicit');
    check('a drag after click-away: the next selection captures where the user left it', c3.state().home.r === 88, c3.state().home);
  }
  ctl.reset();
  check('reset forgets selection and home', ctl.state().home === null && !ctl.selection().room);
}

// ---- 7. generation gate ------------------------------------------------------------
console.log('generation gate');
{
  const gate = F.createFocusGate();
  const opened = [], abandoned = [];
  let r1, r2;
  const p1 = F.focusThenOpen(gate, () => new Promise(r => { r1 = r; }), () => opened.push('first'), () => abandoned.push('first'));
  const p2 = F.focusThenOpen(gate, () => new Promise(r => { r2 = r; }), () => opened.push('second'), () => abandoned.push('second'));
  r2('landed'); await p2;
  r1('superseded'); await p1;   // the older flight resolves LAST
  check('a newer tap supersedes: only its card opens', opened.length === 1 && opened[0] === 'second', opened);
  check('the stale await never opens the earlier target (it is abandoned)', abandoned.length === 1 && abandoned[0] === 'first', abandoned);
  let r3;
  const p3 = F.focusThenOpen(gate, () => new Promise(r => { r3 = r; }), () => opened.push('third'), () => abandoned.push('third'));
  gate.invalidate();   // a pointer down elsewhere / Escape while it flies
  r3('cancelled'); await p3;
  check('invalidated while flying (pointer down elsewhere): no card', !opened.includes('third') && abandoned.includes('third'));
  const p4 = F.focusThenOpen(gate, () => Promise.resolve('cancelled'), () => opened.push('fourth'));
  await p4;
  check('a flight cancelled by something that did not supersede it still opens the card', opened.includes('fourth'));
}

// ---- 8. loader pass-through ----------------------------------------------------------
console.log('loader');
{
  const { HouseLoader } = await imp('src/house-loader.js');
  const geo = JSON.parse(read('houses/demo/geometry.json'));
  const ct = geo.coordinateTransform;
  const room = geo.rooms[0];
  const other = geo.rooms[1];
  room.view = { target: [ct.originX + 100, ct.originY + 200], targetHeight: 90, azimuth: 0.69, polar: 0.95, distance: 6.5, fov: 40 };
  if (geo.furniture && geo.furniture[0]) geo.furniture[0].view = { azimuth: 1.1, polar: 1.2, distance: 2 };
  geo.schemaVersion = '1.4';
  const warn = console.warn; console.warn = () => {};
  let house;
  try { house = HouseLoader.compile(geo, 'houses/demo/'); } finally { console.warn = warn; }
  const v = house.rooms[room.id].view;
  check('room view compiled', !!v, v);
  check('room view target has the transform applied (plan cm -> world m)', v && near(v.tgt[0], 100 * ct.scale) && near(v.tgt[2], 200 * ct.scale), v && v.tgt);
  check('targetHeight cm -> metres', v && near(v.tgt[1], 0.9));
  check('orbit terms and fov pass through', v && v.th === 0.69 && v.ph === 0.95 && v.r === 6.5 && v.fov === 40);
  check('a room without a view compiles to null (derived at runtime)', house.rooms[other.id].view === null);
  if (geo.furniture && geo.furniture[0]) {
    const fv = house.furniture.find(f => f.id === geo.furniture[0].id).view;
    check('furniture view compiled; no target -> null tgt (the item centre is used)', fv && fv.tgt === null && fv.r === 2 && fv.fov === 50, fv);
  }
  const bad = F.compileFocusView({ azimuth: 1, polar: 1 }, x => x, y => y);
  check('a view without a distance is rejected', bad === null);
}

// ---- 9. wiring (a parse cannot see these) ----------------------------------------------
console.log('wiring');
{
  const html = read('index.html');
  const scene = read('src/home3d-scene.js');
  const tap = read('src/tap-popovers.js');
  check('index imports the controller with a stamped ?v=', /from '\.\/src\/camera-focus\.js\?v=__VERSION__'/.test(html));
  check('?focus=0 switches it off', /params\.get\('focus'\) === '0'/.test(html) && /focusAllowed = !isPreview && !focusParamOff/.test(html));
  check('preview mode never focuses', /focusAllowed = !isPreview/.test(html));
  check('the pointer hold is registered before the tap popovers attach',
    html.indexOf("window.addEventListener('pointerdown', e => {\n          if (!focusOn()) return;") > 0 &&
    html.indexOf("window.addEventListener('pointerdown', e => {\n          if (!focusOn()) return;") < html.indexOf('attachTapPopovers({'));
  check('a drag/scroll closing the sidebar is a gesture', /cause === 'cameraStart' \|\| cause === 'scroll' \? 'gesture' : 'explicit'/.test(html));
  check('a wheel / camera move / resize closing a card is a gesture', /why === 'wheel' \|\| why === 'camera' \|\| why === 'resize'/.test(html));
  check('a wheel / pinch on the canvas marks a gesture (forgets a cancelled return)',
    /container\.addEventListener\('wheel', \(\) => focusCtl\.markGesture\(\)/.test(html) &&
    /e\.touches\.length >= 2\) focusCtl\.markGesture\(\)/.test(html));
  check('the Settings switch exists and persists', /id="panel-focus-toggle"/.test(html) && /home3d\.cameraFocus/.test(html));
  check('scene: pointerdown, wheel, touchstart, resize and setOrbit cancel a flight',
    (scene.match(/cancelFlight\(\);/g) || []).length >= 6);
  check('scene: the flight feeds `animating` (zero frames after landing)', /if \(flightMoving\) animating = true;/.test(scene));
  check('scene: reduced motion jumps', /prefers-reduced-motion: reduce/.test(scene) && /reducedMotion\(\)\) \{ applyPose\(pose\)/.test(scene));
  check('tap-popovers: the card opens through the generation gate', /focusThenOpen\(focusGate/.test(tap));
  check('tap-popovers: every close reports why', !/[^.]close\(\);/.test(tap.slice(tap.indexOf('export function attachTapPopovers'))));
}

console.log('\n' + passes + ' passed, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
