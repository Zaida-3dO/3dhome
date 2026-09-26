#!/usr/bin/env node
/**
 * Footprint orientation: the toe must lead the walk. No framework, no
 * dependencies beyond the vendored three - `node scripts/test-footprint-orientation.mjs`.
 *
 * WHAT THIS GUARDS
 *
 * Every presence footprint used to be drawn heel-first: the ball pad (the
 * canvas draws it at the TOP, which CanvasTexture.flipY puts on the plane's
 * +Y / v=1 edge) pointed AGAINST the walking direction, so each trail read as
 * someone walking backwards. The rotation was off by exactly PI, and it is the
 * kind of error no placement test can see: every print was still in the right
 * place, on the right side of the line, just turned round.
 *
 * This builds each print exactly as home3d-scene.js does - a PlaneGeometry,
 * rotateX(-PI/2), rotateY(printYaw(dirx, diry)) - using the real vendored
 * three, then finds the vertices on the v=1 (toe) edge and checks that they
 * sit AHEAD of the print's centre along the walking direction, in eight
 * directions. On the old `-atan2(diry, dirx) + PI/2` every direction fails.
 *
 * It also checks that home3d-scene.js still calls printYaw for that rotation,
 * so this cannot pass while the scene quietly uses some other formula.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const imp = rel => import(pathToFileURL(path.join(root, rel)).href);
const THREE = await imp('vendor/three-r160/three.module.min.js');
const { printYaw, walkFootsteps } = await imp('src/footstep-walk.js');

let failures = 0;
function check(label, cond, detail) {
  if (cond) console.log(`  ok   ${label}`);
  else { failures++; console.log(`  FAIL ${label}${detail ? ` -- ${detail}` : ''}`); }
}

// World-space (x, z) of the toe edge relative to the print's centre, for a
// print walking along plan (dirx, diry). Plan x -> world +X, plan y -> world
// +Z (house-loader's tx/tz both scale by a positive S), so a correctly turned
// toe points along world (dirx, diry).
function toeOffset(dirx, diry) {
  const g = new THREE.PlaneGeometry(0.16, 0.26);
  g.rotateX(-Math.PI / 2);
  g.rotateY(printYaw(dirx, diry));
  const pos = g.attributes.position, uv = g.attributes.uv;
  let tx = 0, tz = 0, n = 0, hx = 0, hz = 0, m = 0;
  for (let i = 0; i < pos.count; i++) {
    if (uv.getY(i) === 1) { tx += pos.getX(i); tz += pos.getZ(i); n++; }
    else if (uv.getY(i) === 0) { hx += pos.getX(i); hz += pos.getZ(i); m++; }
  }
  g.dispose();
  return { toe: [tx / n, tz / n], heel: [hx / m, hz / m] };
}

console.log('toe edge leads the walking direction');
for (let k = 0; k < 8; k++) {
  const a = k * Math.PI / 4;
  const dirx = Math.cos(a), diry = Math.sin(a);
  const { toe, heel } = toeOffset(dirx, diry);
  const len = Math.hypot(toe[0], toe[1]);
  const along = (toe[0] * dirx + toe[1] * diry) / len;
  const heelAlong = heel[0] * dirx + heel[1] * diry;
  const label = `dir (${dirx.toFixed(2)}, ${diry.toFixed(2)})`;
  check(`${label}: toe points along the walk`, along > 0.999,
    `cos(angle between toe and walk) = ${along.toFixed(4)}`);
  check(`${label}: heel trails behind`, heelAlong < 0,
    `heel offset along walk = ${heelAlong.toFixed(4)}`);
}

console.log('prints still alternate either side of the walking line');
{
  // A plain rectangle, walked straight: side of the line must flip every print.
  const poly = [[0, 0], [1000, 0], [1000, 400], [0, 400]];
  const { prints } = walkFootsteps({ poly, sx: 100, sy: 200, ux: 1, uy: 0, nPrints: 6 });
  check('six prints laid', prints.length === 6, `got ${prints.length}`);
  const sides = prints.map(p => Math.sign(p.y - 200));
  const alternates = sides.every((s, i) => s !== 0 && (i === 0 || s === -sides[i - 1]));
  check('side of the walking line alternates', alternates, `sides ${JSON.stringify(sides)}`);
}

console.log('home3d-scene.js turns each print with printYaw');
{
  const src = fs.readFileSync(path.join(root, 'src/home3d-scene.js'), 'utf8');
  check('the footprint rotateY calls printYaw(p.dirx, p.diry)',
    /g\.rotateY\(printYaw\(p\.dirx, p\.diry\)\)/.test(src));
  check('no leftover inline atan2 rotation for the prints',
    !/g\.rotateY\(-Math\.atan2\(p\.diry, p\.dirx\)/.test(src));
}

if (failures) { console.log(`\n${failures} check(s) failed`); process.exit(1); }
console.log('\nall footprint orientation checks passed');
