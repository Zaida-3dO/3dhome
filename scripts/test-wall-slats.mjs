#!/usr/bin/env node
/**
 * The living-room slat panel's span comes from the house: wall 1's optional
 * `slats: { along: [start, end] }`. No framework, no install:
 * `node scripts/test-wall-slats.mjs`.
 *
 * WHAT THIS GUARDS
 *
 *   1. The schema declares `slats` on a wall (walls are
 *      additionalProperties:false, so an undeclared field fails every profile
 *      using it), with `along` a required pair of numbers.
 *   2. The loader passes a good span through, ordered low to high, and drops
 *      a bad one (not a pair, empty, or off the wall) with a warning, so the
 *      builder falls back to its default rather than losing the panel.
 *   3. The panel builder reads the span from wall 1 -- its north stop and
 *      step are no longer fixed numbers -- and keeps the old span as the
 *      fallback.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { HouseLoader } = await import(pathToFileURL(path.join(root, 'src/house-loader.js')).href);

let failures = 0, passes = 0;
function check(name, cond, detail) {
  if (cond) { passes++; return; }
  failures++;
  console.error('FAIL ' + name + (detail !== undefined ? ' -- ' + JSON.stringify(detail) : ''));
}
function compile(slats) {
  const warnings = [];
  const w = console.warn;
  console.warn = m => warnings.push(String(m));
  const seg1 = { id: 1, start: [0, 0], end: [0, 800], exterior: true, thickness: 20 };
  if (slats !== undefined) seg1.slats = slats;
  const doc = {
    kind: 'geometry', schemaVersion: '1.3', id: 't', name: 't', units: 'cm',
    coordinateTransform: { originX: 0, originY: 0, scale: 0.01 },
    defaults: { wallHeight: 250, wallThickness: 10 },
    walls: { segments: [
      seg1,
      { id: 2, start: [0, 800], end: [600, 800], exterior: true, thickness: 20 },
      { id: 3, start: [600, 800], end: [600, 0], exterior: true, thickness: 20 },
      { id: 4, start: [600, 0], end: [0, 0], exterior: true, thickness: 20 }
    ] },
    rooms: [{ id: 'living_room', label: 'Living', polygon: [[0, 0], [600, 0], [600, 800], [0, 800]] }]
  };
  try {
    const house = HouseLoader.compile(doc, '');
    return { wall1: house.walls.find(x => x.id === 1), warnings };
  } finally { console.warn = w; }
}

// ---- 1. Schema -----------------------------------------------------------
const schema = JSON.parse(fs.readFileSync(path.join(root, 'houses/schema.json'), 'utf8'));
const slatsDef = schema.$defs.wall.properties.slats;
check('schema declares wall.slats', !!slatsDef);
check('slats.along is required', slatsDef && JSON.stringify(slatsDef.required) === '["along"]', slatsDef && slatsDef.required);
check('slats.along is a pair of numbers', slatsDef && slatsDef.properties.along.minItems === 2 &&
  slatsDef.properties.along.maxItems === 2 && slatsDef.properties.along.items.type === 'number');
check('slats refuses unknown keys', slatsDef && slatsDef.additionalProperties === false);

// ---- 2. Loader -----------------------------------------------------------
{
  const r = compile();
  check('no slats -> null', r.wall1.slats === null, r.wall1.slats);
  check('no slats -> no warning', r.warnings.filter(m => /slats/.test(m)).length === 0, r.warnings);
}
{
  const r = compile({ along: [289.2, 707.8] });
  check('a good span passes through', JSON.stringify(r.wall1.slats) === JSON.stringify({ along: [289.2, 707.8] }), r.wall1.slats);
  check('a good span does not warn', r.warnings.filter(m => /slats/.test(m)).length === 0, r.warnings);
}
{
  const r = compile({ along: [707.8, 289.2] });
  check('a reversed span is ordered low to high', JSON.stringify(r.wall1.slats) === JSON.stringify({ along: [289.2, 707.8] }), r.wall1.slats);
}
for (const [label, bad] of [
  ['not a pair', { along: [289.2] }],
  ['not numbers', { along: ['a', 707.8] }],
  ['empty', { along: [300, 300] }],
  ['off the wall', { along: [-50, 707.8] }],
  ['past the far end', { along: [289.2, 900] }]
]) {
  const r = compile(bad);
  check('bad span (' + label + ') -> null', r.wall1.slats === null, r.wall1.slats);
  check('bad span (' + label + ') warns', r.warnings.some(m => /wall 1 slats/.test(m)), r.warnings);
}

// ---- 3. The builder reads it ---------------------------------------------
const scene = fs.readFileSync(path.join(root, 'src/home3d-scene.js'), 'utf8');
const fnStart = scene.indexOf('function buildAcousticPanelLivingRoomWall1Wall3(');
const fn = scene.slice(fnStart, scene.indexOf('\n  }\n', fnStart));
check('builder found', fnStart !== -1);
check('builder takes its span from wall 1', /const span = \(wall1\.slats && wall1\.slats\.along\) \|\| SLAT_PANEL_DEFAULT_ALONG;/.test(fn));
check('north stop is span[0]', /const seg1NorthZ = tz\(span\[0\]\);/.test(fn));
check('step is span[1]', /const stepZ = tz\(span\[1\]\);/.test(fn));
check('no fixed north stop left in the builder', !/tz\(353\.4\)/.test(fn));
check('default span is the old one', /const SLAT_PANEL_DEFAULT_ALONG = \[353\.4, 707\.8\];/.test(scene));

console.log((failures ? 'FAILED' : 'ok') + ' -- ' + passes + ' passed, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
