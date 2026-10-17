#!/usr/bin/env node
/**
 * Preview orbit rise and fall (src/preview-orbit.js) -- `node scripts/test-preview-orbit.mjs`.
 * Guards: the height schedule (top hold, descent, bottom lap, ascent ~ a third
 * of a lap), eased continuity (no jumps), camera outside the footprint at the
 * bottom, aim at the house centre, reduced motion holds the top, and that the
 * scene wires it only into the autoRotate path (the interactive overview and
 * its default pose are untouched).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { previewPose, lowness, lowRadius, CYCLE_LAPS, EYE_HEIGHT_M } from '../src/preview-orbit.js';

const g = { rotateSpeed: 0.024, th0: Math.PI * 0.22, rTop: 20, phTop: Math.PI * 0.32, halfDiag: 7, midY: 1.25, still: false };
const lap = (2 * Math.PI) / g.rotateSpeed;
const at = laps => previewPose(laps * lap, g);
const near = (a, b, eps, m) => assert.ok(Math.abs(a - b) <= eps, `${m}: ${a} vs ${b}`);
let n = 0; const ok = (m) => { n++; console.log('ok -', m); };

// 1. Schedule
near(at(0).camY, g.rTop * Math.cos(g.phTop), 1e-9, 'top height is today\'s'); near(at(0).tgtY, 0, 1e-9, 'top aim is the floor centre');
near(at(0.99).camY, at(0).camY, 1e-9, 'top hold is flat for a lap');
assert.ok(at(1.2).camY < at(1).camY && at(1.2).camY > EYE_HEIGHT_M, 'descending'); 
near(at(1.4).camY, EYE_HEIGHT_M, 1e-9, 'descent takes 0.4 lap (slow)');
near(at(2.4).camY, EYE_HEIGHT_M, 1e-9, 'bottom holds a full lap');
near(at(2.0).camY, EYE_HEIGHT_M, 1e-9, 'bottom mid-lap');
assert.ok(at(2.5).camY > EYE_HEIGHT_M, 'rising after the bottom lap');
near(at(2.4 + 1 / 3).camY, at(0).camY, 1e-9, 'ascent takes a third of a lap');
assert.ok(at(2.4 + 0.3).camY < at(0).camY - 0.1, 'ascent is not shorter than a third of a lap');
near(lowness(2.4 + 1 / 6), 0.5, 1e-9, 'ascent midpoint');
near(at(CYCLE_LAPS).camY, at(0).camY, 1e-9, 'cycle repeats'); near(at(CYCLE_LAPS + 1.2).camY, at(1.2).camY, 1e-9, 'cycle repeats mid-descent');
assert.ok(CYCLE_LAPS > 2.5 && CYCLE_LAPS < 3, 'cycle length'); ok('height schedule');

// 2. Continuity, easing, monotone legs
let prev = at(0), maxStep = 0, maxDth = 0;
const dt = lap / 4000;
for (let t = dt; t < 3 * CYCLE_LAPS * lap; t += dt) {
  const p = previewPose(t, g);
  maxStep = Math.max(maxStep, Math.abs(p.camY - prev.camY), Math.abs(p.horiz - prev.horiz) * 0.5);
  maxDth = Math.max(maxDth, Math.abs(p.th - prev.th)); prev = p;
}
assert.ok(maxStep < 0.05, 'no jump in height or reach: ' + maxStep); near(maxDth, g.rotateSpeed * dt, 1e-12, 'azimuth rate unchanged');
assert.ok(lowness(1.0 + 0.4 * 0.01) < 0.01, 'eased start (smoothstep, not linear)'); assert.ok(lowness(1.0 + 0.4 * 0.99) > 0.99, 'eased end');
near(lowness(1.2), 0.5, 1e-9, 'midpoint of descent'); ok('eased continuity');

// 3. Outside the footprint (any azimuth) at the bottom; never under ground
for (let k = 0; k < 400; k++) {
  const p = at(k * CYCLE_LAPS / 400);
  assert.ok(p.camY >= EYE_HEIGHT_M - 1e-9 && Math.abs(p.r * Math.sin(p.ph) - p.horiz) < 1e-9);
  if (lowness(k * CYCLE_LAPS / 400) === 1) assert.ok(p.horiz > g.halfDiag, 'outside the footprint circle');
}
near(at(2).camY, 1.7, 1e-9, 'eye height 1.7 m'); assert.ok(lowRadius(g) > g.halfDiag + 2); 
const big = { ...g, halfDiag: 30 }; assert.ok(previewPose(2 * lap, big).horiz > 30, 'big house stays outside'); ok('outside the footprint');

// 4. Aim: the look-at is the centre; at the bottom it is mid-height; the camera sits on that line of sight
for (const laps of [0, 1.2, 2, 2.6]) {
  const p = at(laps);
  const cx = p.r * Math.sin(p.ph) * Math.cos(p.th), cz = p.r * Math.sin(p.ph) * Math.sin(p.th), cy = p.tgtY + p.r * Math.cos(p.ph);
  near(Math.hypot(cx, cz), p.horiz, 1e-9, 'camera is `horiz` from the centre axis'); near(cy, p.camY, 1e-9, 'camera height');
}
near(at(2).tgtY, g.midY, 1e-9, 'aim at mid-height at the bottom'); near(at(0).tgtY, 0, 1e-9, 'aim at the floor at the top');
assert.ok(at(2).ph > Math.PI / 2 - 0.2 && at(2).ph < Math.PI / 2 + 0.2, 'near-horizontal gaze at eye level'); ok('aim at the centre');

// 5. Reduced motion: top pose forever, azimuth still turns
const still = { ...g, still: true };
near(previewPose(2 * lap, still).camY, previewPose(0, still).camY, 1e-12, 'reduced motion holds the top');
assert.ok(previewPose(2 * lap, still).th !== previewPose(0, still).th); ok('reduced motion');

// 5b. Degenerate speeds (?rotateSpeed=0 is documented as "frozen"): never NaN, hold the top pose
for (const sp of [0, -0.024, NaN, Infinity]) {
  for (const t of [0, 1000, NaN]) {
    const p = previewPose(t, { ...g, rotateSpeed: sp });
    for (const k of ['th', 'ph', 'r', 'tgtY', 'camY', 'horiz']) assert.ok(Number.isFinite(p[k]), `speed ${sp} t ${t}: ${k} is ${p[k]}`);
  }
}
near(previewPose(0, { ...g, rotateSpeed: 0 }).camY, at(0).camY, 1e-12, 'speed 0 holds the top height');
near(previewPose(1e6, { ...g, rotateSpeed: 0 }).th, g.th0, 1e-12, 'speed 0 holds the azimuth');
near(previewPose(2 * lap, { ...g, rotateSpeed: -g.rotateSpeed }).camY, EYE_HEIGHT_M, 1e-9, 'negative speed: same cycle');
assert.ok(previewPose(5, { ...g, rotateSpeed: -g.rotateSpeed }).th < g.th0, 'negative speed turns the other way');
ok('degenerate speeds');

// 5c. Radius formula pinned: values, and the house fits the frame at eye level
near(lowRadius(g), Math.max(7 * 1.5 + 3, 0.6 * 20 * Math.sin(g.phTop)), 1e-12, 'lowRadius value');
near(lowRadius({ ...g, halfDiag: 1 }), 0.6 * 20 * Math.sin(g.phTop), 1e-12, 'small house: 0.6 top-reach floor');
assert.ok(lowRadius(g) >= 1.5 * g.halfDiag, 'eye-level camera stands back at least 1.5 half-diagonals');
ok('radius formula');

// 6. Wiring: only the autoRotate branch drives it; the interactive overview/default pose are untouched
const src = readFileSync(new URL('../src/home3d-scene.js', import.meta.url), 'utf8');
const i = src.indexOf('previewPose(autoAngle'); assert.ok(i > 0);
assert.ok(/if \(autoRotate && !orb\.drag && !orb\.pan\) \{[^}]*previewPose/s.test(src), 'only inside the autoRotate branch');
assert.equal(src.split('previewPose(').length - 1, 1, 'previewPose called once');
assert.ok(/const orb = \{[^}]*ph: Math\.PI \* 0\.32, r: _defaultDistance/.test(src), 'default overview pose unchanged');
assert.ok(/return \{ th: Math\.PI \* 0\.22, ph: Math\.PI \* 0\.32, r: _defaultDistance/.test(src), 'home view unchanged');
ok('overview unchanged'); console.log(`\n${n} groups passed`);
