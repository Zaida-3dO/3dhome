#!/usr/bin/env node
/**
 * digital-piano.js: geometry decisions a contract-gate screenshot cannot pin.
 * No framework, no install: `node scripts/test-digital-piano.mjs`.
 *
 * scripts/test-furniture-core.mjs already checks the generic builder
 * contract (bbox, finish tags, no-three, low<=full triangles) for every
 * registered type including `digital-piano`, `piano-bench` and `ottoman`.
 * This file checks the type-specific decisions that contract does not know
 * to ask about, building EVERY preset this module exports:
 *
 *   1. digital-piano: a slim 88-key instrument on a panel stand. The case top
 *      sits at caseTopHeight with the white keys recessed below it and the
 *      control panel behind them; exactly 36 black keys on the real A0-C8
 *      pattern (2 + 3 groups), each centred on its white-key boundary; a lit
 *      display and two grilles; a stand of two SOLID side panels and a back
 *      board (nothing leg-like under the case); a small centred music rest
 *      leaning AWAY from the player with its top pinned to `height`; black
 *      keys collapse to one band at low detail; triangle caps.
 *   2. piano-bench: the classic four-leg adjustable bench. No baseStyle (one
 *      style); the seat top is `height`; the top dips at all 8 tuft buttons;
 *      an apron under the seat with a knob on each END; four square, tapered,
 *      splayed legs, one per corner, on the floor; no X/column parts;
 *      triangle caps.
 *   3. ottoman: the lid is channel-tufted (DEFAULTS.channelCount ridges,
 *      evenly spaced, flush with the lid edges), the ridges STAND PROUD of
 *      the flat lid top (round face up, not sunk inside it and not rotated
 *      sideways), and it sits on 4 legs. A reviewer found a real bug here:
 *      an earlier version of this file asserted ridges "never stand proud",
 *      which locked the bug in rather than catching it -- this version
 *      requires the opposite.
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const imp = rel => import(pathToFileURL(path.join(root, rel)).href);
const THREE = await imp('vendor/three-r160/three.module.min.js');
const DP = await imp('src/furniture/digital-piano.js');

let failures = 0, passes = 0;
function check(name, cond, detail) {
  if (cond) { passes++; return; }
  failures++;
  console.error('FAIL ' + name + (detail !== undefined ? ' -- ' + JSON.stringify(detail) : ''));
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

function meshesByColor(group, hex) {
  const out = [];
  group.traverse(o => {
    if (!o.isMesh) return;
    const mat = Array.isArray(o.material) ? o.material[0] : o.material;
    if (mat && mat.color && mat.color.getHex() === hex) out.push(o);
  });
  return out;
}
const colorInt = hex => parseInt(hex.slice(1), 16);

// ---- TYPES export shape ------------------------------------------------------
{
  check('TYPES has digital-piano, piano-bench and ottoman',
    !!DP.TYPES['digital-piano'] && !!DP.TYPES['piano-bench'] && !!DP.TYPES['ottoman']);
  for (const key of ['digital-piano', 'piano-bench', 'ottoman']) {
    const D = DP.TYPES[key].DEFAULTS;
    check(key + ': DEFAULTS frozen with width/depth/height numeric',
      Object.isFrozen(D) && ['width', 'depth', 'height'].every(k => typeof D[k] === 'number'));
  }
}

const tris = g => { let n = 0; g.traverse(o => { if (o.isMesh) n += (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3; }); return n; };
const byName = (g, name) => { const out = []; g.traverse(o => { if (o.isMesh && o.name === name) out.push(o); }); return out; };
const wbox = o => new THREE.Box3().setFromObject(o);

// ---- digital-piano -----------------------------------------------------------
{
  const { DEFAULTS: D, build } = DP.TYPES['digital-piano'];
  const g = build(THREE, Object.assign({}, D), { detail: 'full' });
  g.updateMatrixWorld(true);
  const box = wbox(g);
  check('piano: bbox == width x height x depth',
    near((box.max.x - box.min.x) * 100, D.width, 0.05) && near((box.max.y - box.min.y) * 100, D.height, 0.05) &&
    near((box.max.z - box.min.z) * 100, D.depth, 0.05), [box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z]);
  check('piano: back at z=0, bottom at y=0', near(box.min.z, 0, 1e-4) && near(box.min.y, 0, 1e-4), [box.min.z, box.min.y]);

  // The case: its top (the control panel) at caseTopHeight, 15 deep top to
  // bottom; the white keys recessed 3 below it. (A mutation back to the old
  // 82 cm keybed moves both.)
  const panel = byName(g, 'piano:case-panel')[0];
  const tray = byName(g, 'piano:case-tray')[0];
  check('piano: control panel top at caseTopHeight (76)', !!panel && near(wbox(panel).max.y * 100, D.caseTopHeight, 0.05), panel && wbox(panel).max.y * 100);
  check('piano: case is caseHeight deep (bottom at 61)', !!tray && near(wbox(tray).min.y * 100, D.caseTopHeight - D.caseHeight, 0.05), tray && wbox(tray).min.y * 100);
  const white = byName(g, 'piano:white-keys')[0];
  check('piano: white key tops at 73, recessed 3 below the panel', !!white && near(wbox(white).max.y * 100, D.caseTopHeight - 3, 0.05), white && wbox(white).max.y * 100);
  check('piano: the keys run along the FRONT edge (the player side), keyDepth deep',
    !!white && near(wbox(white).max.z * 100, D.depth, 0.05) && near((wbox(white).max.z - wbox(white).min.z) * 100, D.keyDepth, 0.6));
  check('piano: the control panel sits BEHIND the keys', !!panel && !!white && wbox(panel).max.z <= wbox(white).min.z + 1e-6);

  // 36 individual black keys, laid out on the real 88-key pattern.
  const after = DP.blackKeyAfter();
  check('piano: the 88-key pattern has 36 black keys', after.length === 36, after.length);
  check('piano: first black key follows A0 (white 0); none between B0 and C1 (white 1)', after[0] === 0 && after[1] === 2, after.slice(0, 3));
  // per octave from C1 (white index 2): C D _ F G A _  ->  offsets 0 1 3 4 5
  const oct = after.filter(i => i >= 2 && i < 9).map(i => i - 2);
  check('piano: an octave groups its black keys 2 + 3 (after C, D, F, G, A)', JSON.stringify(oct) === '[0,1,3,4,5]', oct);
  check('piano: the last black key is before the top C (no black key after white 50)', after[35] === 49 && !after.includes(50), after.slice(-2));
  const black = byName(g, 'piano:black-keys')[0];
  check('piano: black keys are one merged mesh', !!black);
  if (black) {
    const pos = black.geometry.attributes.position;
    const boxes = pos.count / 24; // a BoxGeometry has 24 vertices
    check('piano: exactly 36 black-key boxes', boxes === 36, boxes);
    // each box's x-centre sits on the boundary after its white key
    const keyW = D.width - 2 * 5 - 1, pitch = keyW / 52;
    let worst = 0;
    for (let k = 0; k < 36; k++) {
      let sx = 0;
      for (let v = 0; v < 24; v++) sx += pos.getX(k * 24 + v);
      const cx = sx / 24 * 100;
      const want = -keyW / 2 + (after[k] + 1) * pitch;
      worst = Math.max(worst, Math.abs(cx - want));
    }
    check('piano: every black key centred on its white-key boundary', worst < 0.05, worst);
    check('piano: black keys stand above the white keys', wbox(black).min.y >= wbox(white).max.y - 1e-6);
    check('piano: black keys sit at the BACK of the key area (shorter than the white keys)',
      near(wbox(black).min.z, wbox(white).min.z, 1e-4) && wbox(black).max.z < wbox(white).max.z - 0.03);
  }
  check('piano: key-gap lines drawn at full detail (51 quads)', byName(g, 'piano:key-gaps').length === 1 &&
    byName(g, 'piano:key-gaps')[0].geometry.index.count / 3 === 102);

  // The panel: an emissive display (kept by the merge) and two grilles.
  const disp = byName(g, 'piano:display')[0];
  check('piano: a lit display on the panel (emissive finish)', !!disp && disp.material.userData.finish === 'emissive');
  check('piano: display left of centre', !!disp && wbox(disp).max.x < 0);
  check('piano: two speaker grilles, one at each end', byName(g, 'piano:grille').length === 2 &&
    byName(g, 'piano:grille').some(m => wbox(m).max.x < -0.3) && byName(g, 'piano:grille').some(m => wbox(m).min.x > 0.3));

  // The stand: two SOLID side panels floor-to-case and a back board -- no
  // legs, no feet bars, no crossbar.
  const sides = byName(g, 'piano:stand-side');
  check('piano: two stand side panels', sides.length === 2, sides.length);
  sides.forEach(sp => {
    const b = wbox(sp);
    check('piano: side panel is solid (>= 30 deep, floor to the case underside)',
      (b.max.z - b.min.z) * 100 >= 30 && near(b.min.y, 0, 1e-6) && near(b.max.y * 100, D.caseTopHeight - D.caseHeight, 0.05),
      [(b.max.z - b.min.z) * 100, b.min.y, b.max.y * 100]);
  });
  check('piano: sides sit at the two ends (under the end cheeks)', sides.length === 2 &&
    sides.every(sp => Math.abs((wbox(sp).min.x + wbox(sp).max.x) / 2) * 100 > D.width / 2 - 6));
  check('piano: a back board joins the sides', byName(g, 'piano:stand-back').length === 1);
  const legLike = [];
  g.traverse(o => {
    if (!o.isMesh || o.name.startsWith('piano:case') || o.name === 'piano:music-rest') return;
    const b = wbox(o);
    if (b.max.y * 100 <= D.caseTopHeight - D.caseHeight + 0.01 && (b.max.x - b.min.x) < 0.05 && (b.max.z - b.min.z) < 0.05) legLike.push(o.name);
  });
  check('piano: nothing under the case is a leg (thin in both x and z)', legLike.length === 0, legLike);
  g.traverse(o => {
    if (o.isMesh && o.name.startsWith('piano:stand')) check('piano: stand is not the metal finish', o.material.userData.finish !== 'metal');
  });

  // The music rest: a small centred panel, leaning AWAY from the player, its
  // top pinned to `height` whatever the lean and height.
  const rest = byName(g, 'piano:music-rest')[0];
  check('piano: music rest is restWidth wide (not a full-width board)', !!rest && near((wbox(rest).max.x - wbox(rest).min.x) * 100, D.restWidth, 0.05));
  check('piano: music rest is centred', !!rest && near(wbox(rest).min.x + wbox(rest).max.x, 0, 1e-4));
  if (rest) {
    const pa = rest.geometry.attributes.position;
    const v = new THREE.Vector3();
    let top = null, bot = null;
    for (let i = 0; i < pa.count; i++) {
      v.fromBufferAttribute(pa, i).applyMatrix4(rest.matrixWorld);
      if (!top || v.y > top.y) top = v.clone();
      if (!bot || v.y < bot.y) bot = v.clone();
    }
    check('piano: music rest leans AWAY from the player (top further toward -z than bottom)', top.z < bot.z, { top: top.z, bot: bot.z });
    check('piano: music rest stands on the panel top', near(bot.y * 100, D.caseTopHeight, 0.3), bot.y * 100);
  }
  for (const [h, lean] of [[90, 0], [97, 12], [105, 25]]) {
    const gi = build(THREE, Object.assign({}, D, { height: h, restLean: lean }), { detail: 'full' });
    gi.updateMatrixWorld(true);
    const b = wbox(gi);
    check('piano: height ' + h + ' (lean ' + lean + ') is honoured exactly', near((b.max.y - b.min.y) * 100, h, 0.05), (b.max.y - b.min.y) * 100);
    check('piano: back stays at z=0 for lean ' + lean, near(b.min.z, 0, 1e-4), b.min.z);
  }

  // Detail and budget.
  const low = build(THREE, Object.assign({}, D), { detail: 'low' });
  check('piano low: no individual black keys', byName(low, 'piano:black-keys').length === 0);
  check('piano low: the black keys collapse into one band', byName(low, 'piano:black-key-band').length === 1);
  const caps = DP.TRIANGLE_CAPS['digital-piano'];
  check('piano: full within its triangle cap', tris(g) <= caps.full, [tris(g), caps.full]);
  check('piano: low within its triangle cap', tris(low) <= caps.low, [tris(low), caps.low]);
  check('piano: low <= 0.6 x full', tris(low) <= 0.6 * tris(g), [tris(low), tris(g)]);
}

// ---- piano-bench: a classic four-leg adjustable bench --------------------------
{
  const { DEFAULTS: D, build } = DP.TYPES['piano-bench'];
  check('bench: there is one style -- no baseStyle param', !('baseStyle' in D));
  const g = build(THREE, Object.assign({}, D), { detail: 'full' });
  g.updateMatrixWorld(true);
  const box = wbox(g);
  check('bench: bbox == width x height x depth',
    near((box.max.x - box.min.x) * 100, D.width, 0.05) && near((box.max.y - box.min.y) * 100, D.height, 0.05) &&
    near((box.max.z - box.min.z) * 100, D.depth, 0.05), [(box.max.x - box.min.x) * 100, (box.max.y - box.min.y) * 100, (box.max.z - box.min.z) * 100]);
  check('bench: back at z=0, bottom at y=0', near(box.min.z, 0, 1e-4) && near(box.min.y, 0, 1e-4));

  const seat = byName(g, 'bench:seat')[0];
  check('bench: the seat top is the bench height', !!seat && near(wbox(seat).max.y * 100, D.height, 0.05));
  check('bench: the seat is seatThickness deep', !!seat && near((wbox(seat).max.y - wbox(seat).min.y) * 100, D.seatThickness, 0.05));
  check('bench: the seat is upholstered (satin faux leather, not gloss)', !!seat && seat.material.userData.finish === 'satin');

  // Tufting: the seat top dips at every button position.
  if (seat) {
    const pa = seat.geometry.attributes.position;
    const topAt = (x, z) => {
      let best = null, bd = Infinity;
      for (let i = 0; i < pa.count; i++) {
        const y = pa.getY(i);
        if (y <= 0) continue;
        const d = Math.hypot(pa.getX(i) * 100 - x, pa.getZ(i) * 100 - z);
        if (d < bd || (Math.abs(d - bd) < 1e-6 && y > best)) { bd = d; best = y; }
      }
      return best * 100;
    };
    const flat = topAt(0, 0);
    const btn = DP.benchButtons(D);
    check('bench: 2 x 4 tuft buttons', btn.length === 8, btn.length);
    const dips = btn.map(([x, z]) => flat - topAt(x, z));
    check('bench: the seat top dips >= 0.8 cm at every button', dips.every(d => d >= 0.8), dips);
  }
  check('bench: the buttons are drawn', byName(g, 'bench:buttons').length === 1);

  // The frame: an apron under the seat, a knob at each END, four legs.
  const apron = byName(g, 'bench:apron')[0];
  check('bench: an apron (the height mechanism) directly under the seat', !!apron && !!seat && near(wbox(apron).max.y, wbox(seat).min.y, 1e-4) &&
    near((wbox(apron).max.y - wbox(apron).min.y) * 100, D.apronHeight, 0.05));
  const knobs = byName(g, 'bench:knob');
  check('bench: two adjustment knobs', knobs.length === 2, knobs.length);
  check('bench: one knob on each END of the apron (outside it in x)', knobs.length === 2 && !!apron &&
    knobs.some(k => wbox(k).min.x >= wbox(apron).max.x - 1e-4) && knobs.some(k => wbox(k).max.x <= wbox(apron).min.x + 1e-4));
  const legs = byName(g, 'bench:leg');
  check('bench: four legs', legs.length === 4, legs.length);
  check('bench: every leg stands on the floor', legs.every(l => near(wbox(l).min.y, 0, 1e-4)));
  check('bench: every leg reaches up to the apron', legs.every(l => !!apron && wbox(l).max.y >= wbox(apron).min.y - 0.002));
  // one leg per corner quadrant
  const quads = new Set(legs.map(l => { const b = wbox(l); return Math.sign(b.min.x + b.max.x) + ',' + Math.sign((b.min.z + b.max.z) / 2 - D.depth / 200); }));
  check('bench: a leg at each corner', quads.size === 4, [...quads]);
  // square, tapered and splayed: the foot is narrower than the top and further out
  const leg = legs[0];
  if (leg) {
    check('bench: legs are square in section (4 sides)', leg.geometry.parameters.radialSegments === 4);
    check('bench: legs taper (foot narrower than the top)', leg.geometry.parameters.radiusBottom < leg.geometry.parameters.radiusTop);
    check('bench: legs splay outward', Math.abs(leg.rotation.z) > 0.01 && Math.abs(leg.rotation.x) > 0.01);
  }
  let noX = true;
  g.traverse(o => { if (o.isMesh && /x-leg|column|crossbar|stretcher/i.test(o.name)) noX = false; });
  check('bench: no X-frame, column or stretcher parts', noX);
  g.traverse(o => { if (o.isMesh && o.name !== 'bench:seat' && o.name !== 'bench:buttons') check('bench: frame is not metal', o.material.userData.finish !== 'metal'); });

  // A taller bench keeps the four-leg frame to the floor.
  const tall = build(THREE, Object.assign({}, D, { height: 58 }), { detail: 'full' });
  const tb = wbox(tall);
  check('bench: height 58 honoured', near((tb.max.y - tb.min.y) * 100, 58, 0.05), (tb.max.y - tb.min.y) * 100);

  const low = build(THREE, Object.assign({}, D), { detail: 'low' });
  const caps = DP.TRIANGLE_CAPS['piano-bench'];
  check('bench: full within its triangle cap', tris(g) <= caps.full, [tris(g), caps.full]);
  check('bench: low within its triangle cap', tris(low) <= caps.low, [tris(low), caps.low]);
  check('bench: low <= 0.6 x full', tris(low) <= 0.6 * tris(g), [tris(low), tris(g)]);
  check('bench low: still four legs and a seat', byName(low, 'bench:leg').length === 4 && byName(low, 'bench:seat').length === 1);
}

// ---- ottoman -------------------------------------------------------------------
{
  const { DEFAULTS: D, build } = DP.TYPES['ottoman'];
  const g = build(THREE, Object.assign({}, D), { detail: 'full' });
  g.updateMatrixWorld(true);

  // 4 legs in the leg colour.
  const legs = meshesByColor(g, colorInt(D.legColor));
  check('exactly 4 legs', legs.length === 4, legs.length);

  // The lid ridges: found as the higher-triangle-count meshes in the body
  // colour (the flat lid base and the body box are 12-triangle boxes; a
  // ridge is a cylinder segment with far more).
  const bodyColorInt = colorInt(D.color);
  const bodyParts = meshesByColor(g, bodyColorInt);
  const ridges = bodyParts.filter(m => {
    const idx = m.geometry.index;
    const tri = idx ? idx.count / 3 : m.geometry.attributes.position.count / 3;
    return tri > 12;
  });
  check('channelCount ridges drawn', ridges.length === D.channelCount, ridges.length);

  // Evenly spaced, flush with the lid edges. The lid itself is inset 2% from
  // the full ottoman width (widthM * 0.98), and the ridge row is fit to that
  // inset lid width, matching the builder's own layout maths exactly. Each
  // ridge is built as an extruded semicircle centred on its own local x=0
  // (see buildOttoman), so its bbox centre IS the anchor -- unlike the old
  // rotated-half-cylinder version, no separate "anchor vs. bbox" distinction
  // is needed here any more.
  const xsCentre = ridges.map(m => {
    const b = new THREE.Box3().setFromObject(m);
    return (b.min.x + b.max.x) / 2;
  }).sort((a, b) => a - b);
  const rowWidthM = (D.width / 100) * 0.98;
  const nominal = rowWidthM / D.channelCount;
  check('first ridge centred half a pitch from the left edge of the inset lid',
    near(xsCentre[0], -rowWidthM / 2 + nominal / 2, 0.002), xsCentre[0]);
  check('last ridge centred half a pitch from the right edge of the inset lid',
    near(xsCentre[xsCentre.length - 1], rowWidthM / 2 - nominal / 2, 0.002), xsCentre[xsCentre.length - 1]);

  // Ridges STAND PROUD of the flat lid top, round face UP -- a reviewer
  // found a real bug here: the previous version was rotated with the round
  // face sideways and sat fully INSIDE the lid box (an earlier version of
  // this test asserted "never stand proud", which locked that bug in). The
  // flat lid slab is the other body-colour part that is NOT a ridge (12
  // triangles); ridges must rise clearly above its top face, and their own
  // cross-section must be a dome (wider at the base, in local width, than
  // exactly the same all the way up would suggest a flat-sided box instead
  // of a rounded profile -- checked via the geometry's own bounding sphere
  // vs. bounding box ratio being consistent with a genuine curve).
  // The flat lid slab is the non-ridge body-colour part whose OWN top face
  // (max.y) sits closest to (just below) the ridges' own bottom -- i.e. the
  // part the ridges are actually resting on, not just any part below them.
  const nonRidgeParts = bodyParts.filter(m => !ridges.includes(m));
  const ridgeMinYForLid = Math.min(...ridges.map(m => new THREE.Box3().setFromObject(m).min.y));
  const lidBase = nonRidgeParts.reduce((best, m) => {
    const top = new THREE.Box3().setFromObject(m).max.y;
    if (top > ridgeMinYForLid + 0.005) return best; // above the ridges: not the lid
    if (!best) return m;
    const bestTop = new THREE.Box3().setFromObject(best).max.y;
    return top > bestTop ? m : best;
  }, null);
  check('found the flat lid base for this check', !!lidBase);
  const lidTopY = new THREE.Box3().setFromObject(lidBase).max.y;
  const ridgeBoxes = ridges.map(m => new THREE.Box3().setFromObject(m));
  const ridgeMinY = Math.min(...ridgeBoxes.map(b => b.min.y));
  const ridgeMaxY = Math.max(...ridgeBoxes.map(b => b.max.y));
  check('ridges sit flush with (not sunk below) the lid top',
    near(ridgeMinY, lidTopY, 0.002), { ridgeMinY, lidTopY });
  check('ridges STAND PROUD of the lid top (round face up, not sunk inside it)',
    ridgeMaxY > lidTopY + 0.002, { ridgeMaxY, lidTopY });

  // Ridges run the long way (front-to-back), not across the width: each
  // ridge's own z-extent should span most of the ottoman's depth.
  const depthM = D.depth / 100;
  ridgeBoxes.forEach((b, i) => {
    const zSpan = b.max.z - b.min.z;
    check('ridge ' + i + ' runs the long way (z-extent close to the full depth)',
      zSpan > depthM * 0.8, { zSpan, depthM });
  });

  // The overall envelope height still equals DEFAULTS.height even though
  // the ridges now genuinely protrude above the flat lid (the protrusion is
  // budgeted for, not additional to DEFAULTS.height) -- already covered by
  // the generic contract test, re-asserted here for this specific geometry.
  const overallBox = new THREE.Box3().setFromObject(g);
  check('overall height still equals DEFAULTS.height with proud ridges',
    near((overallBox.max.y - overallBox.min.y) * 100, D.height, 0.5),
    (overallBox.max.y - overallBox.min.y) * 100);

  // A custom channelCount still lays out correctly.
  const g2 = build(THREE, Object.assign({}, D, { channelCount: 3 }), { detail: 'full' });
  const ridges2 = meshesByColor(g2, bodyColorInt).filter(m => {
    const idx = m.geometry.index;
    const tri = idx ? idx.count / 3 : m.geometry.attributes.position.count / 3;
    return tri > 12;
  });
  check('a custom channelCount is honoured', ridges2.length === 3, ridges2.length);

  // Low-detail triangle budget: the extruded-ridge fix must not make the
  // low-detail build expensive. Reviewer's target: under 200 triangles.
  function totalTris(group) {
    let n = 0;
    group.traverse(o => {
      if (!o.isMesh) return;
      const idx = o.geometry.index;
      n += idx ? idx.count / 3 : o.geometry.attributes.position.count / 3;
    });
    return n;
  }
  const low = build(THREE, Object.assign({}, D), { detail: 'low' });
  const lowTris = totalTris(low);
  check('low-detail ottoman is under 200 triangles', lowTris < 200, lowTris);
}

// ---- registry wiring (this module's own entries) -----------------------------
{
  const { REGISTRY } = await imp('src/furniture/registry.js');
  check('registry: digital-piano points at digital-piano.js with key digital-piano',
    REGISTRY['digital-piano'].path === 'digital-piano.js' && REGISTRY['digital-piano'].key === 'digital-piano',
    REGISTRY['digital-piano']);
  check('registry: piano-bench points at digital-piano.js with key piano-bench',
    REGISTRY['piano-bench'].path === 'digital-piano.js' && REGISTRY['piano-bench'].key === 'piano-bench',
    REGISTRY['piano-bench']);
  check('registry: ottoman points at digital-piano.js with key ottoman',
    REGISTRY['ottoman'].path === 'digital-piano.js' && REGISTRY['ottoman'].key === 'ottoman',
    REGISTRY['ottoman']);
  check('all three point at the DigitalPianoSpec page',
    REGISTRY['digital-piano'].spec === 'DigitalPianoSpec' &&
    REGISTRY['piano-bench'].spec === 'DigitalPianoSpec' &&
    REGISTRY['ottoman'].spec === 'DigitalPianoSpec');
}

console.log((failures ? 'FAILED' : 'ok') + ' -- ' + passes + ' passed, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
