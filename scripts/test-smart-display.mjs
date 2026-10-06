#!/usr/bin/env node
/**
 * smart-display.js: what the generic contract test cannot pin.
 * No framework, no install: `node scripts/test-smart-display.mjs`.
 *
 *   1. The envelope is EXACTLY the kind's published size (Hub Max 25 x 10.1 x
 *      18.3, Hub 17.74 x 6.98 x 12.05, Mini stand 9.8 x 8 x 15), back at z = 0,
 *      bottom at y = 0, at both details.
 *   2. The screen is a kept, emissive part: near-black off, brighter on; it
 *      leans back.
 *   3. The Max has a camera dot at the top centre of the bezel; the Hub has none.
 *   4. Colourways differ (chalk vs charcoal fabric and front).
 *   5. Mini stand: puck centred over the post, status dots optional and tiny.
 *   6. Triangle caps; low <= full.
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const imp = rel => import(pathToFileURL(path.join(root, rel)).href);
const THREE = await imp('vendor/three-r160/three.module.min.js');
const S = await imp('src/furniture/smart-display.js');

let failures = 0, passes = 0;
function check(name, cond, detail) {
  if (cond) { passes++; return; }
  failures++;
  console.error('FAIL ' + name + (detail !== undefined ? ' -- ' + JSON.stringify(detail) : ''));
}
const near = (a, b, e = 0.05) => Math.abs(a - b) <= e;
const bb = o => { o.updateMatrixWorld(true); const b = new THREE.Box3().setFromObject(o); return { b, w: (b.max.x - b.min.x) * 100, h: (b.max.y - b.min.y) * 100, d: (b.max.z - b.min.z) * 100 }; };
const tris = o => { let n = 0; o.traverse(m => { if (m.isMesh) n += (m.geometry.index ? m.geometry.index.count : m.geometry.attributes.position.count) / 3; }); return n; };
const part = (o, name) => { let r = null; o.traverse(m => { if (m.name === name) r = m; }); return r; };
const hex = m => m.color.getHex();

const KINDS = { 'nest-hub-max': [25, 10.1, 18.3], 'nest-hub': [17.74, 6.98, 12.05], 'nest-mini-stand': [9.8, 8, 15] };
for (const [kind, [w, d, h]] of Object.entries(KINDS)) {
  const D = S.defaultsFor({ kind });
  check(kind + ': defaultsFor gives the published envelope', D.width === w && D.depth === d && D.height === h, [D.width, D.depth, D.height]);
  for (const detail of ['full', 'low']) {
    const g = S.build(THREE, { kind }, { detail });
    const e = bb(g);
    check(kind + '/' + detail + ': width', near(e.w, w), e.w);
    check(kind + '/' + detail + ': depth', near(e.d, d), e.d);
    check(kind + '/' + detail + ': height', near(e.h, h), e.h);
    check(kind + '/' + detail + ': back at z = 0', near(e.b.min.z * 100, 0), e.b.min.z);
    check(kind + '/' + detail + ': bottom at y = 0', near(e.b.min.y * 100, 0), e.b.min.y);
  }
  check(kind + ': low <= full triangles', tris(S.build(THREE, { kind }, { detail: 'low' })) <= tris(S.build(THREE, { kind }, { detail: 'full' })));
}
check('default kind is the Hub Max in chalk', S.DEFAULTS.kind === 'nest-hub-max' && S.DEFAULTS.colorway === 'chalk');

// ---- hubs
{
  const off = S.build(THREE, { kind: 'nest-hub-max' });
  const on = S.build(THREE, { kind: 'nest-hub-max', screenOn: true });
  const so = part(off, 'smartDisplayScreen'), sn = part(on, 'smartDisplayScreen');
  check('screen is a kept emissive part', so && so.userData.keep === true && so.material.userData.finish === 'emissive');
  const lum = m => { const c = m.emissive || m.color; return c.r + c.g + c.b; };
  check('screen off is near black', lum(so.material) < 0.05, lum(so.material));
  check('screen on glows brighter than off', lum(sn.material) > lum(so.material) * 5, [lum(sn.material), lum(so.material)]);
  const slab = part(off, 'smartDisplaySlab');
  check('the slab leans BACK (top towards z = 0)', slab.rotation.x < -0.05 && slab.rotation.x > -0.4, slab.rotation.x);
  off.updateMatrixWorld(true);
  const cam = part(off, 'smartDisplayCamera');
  const cb = new THREE.Box3().setFromObject(cam), sb = new THREE.Box3().setFromObject(off);
  const cx = (cb.min.x + cb.max.x) / 2, cy = (cb.min.y + cb.max.y) / 2;
  check('Max camera dot on the centre line', Math.abs(cx) < 0.0005, cx);
  check('Max camera dot is in the top 15% of the height', cy > sb.max.y * 0.85 && cy < sb.max.y, [cy, sb.max.y]);
  check('the 2nd-gen Hub has no camera', part(S.build(THREE, { kind: 'nest-hub' }), 'smartDisplayCamera') === null);
  const chalk = S.build(THREE, { colorway: 'chalk' }), char = S.build(THREE, { colorway: 'charcoal' });
  check('chalk base is lighter than charcoal', hex(part(chalk, 'smartDisplayBase').material) > hex(part(char, 'smartDisplayBase').material));
  check('chalk bezel is light, charcoal bezel is dark', (hex(part(chalk, 'smartDisplayBezel').material) & 0xff) > 0xc0 && (hex(part(char, 'smartDisplayBezel').material) & 0xff) < 0x40);
  check('Hub Max <= 700 triangles full, <= 250 low', tris(off) <= 700 && tris(S.build(THREE, {}, { detail: 'low' })) <= 250, [tris(off)]);
}

// ---- mini on a stand
{
  const g = S.build(THREE, { kind: 'nest-mini-stand' });
  const puck = part(g, 'miniPuck'), post = part(g, 'miniStandPost'), base = part(g, 'miniStandBase');
  const pb = new THREE.Box3().setFromObject(puck);
  check('puck is 9.8 wide, ~4.2 deep, round (width == height)', near((pb.max.x - pb.min.x) * 100, 9.8) && near((pb.max.y - pb.min.y) * 100, 9.8) && near((pb.max.z - pb.min.z) * 100, 4.2, 0.1),
    [(pb.max.x - pb.min.x) * 100, (pb.max.z - pb.min.z) * 100]);
  check('puck top is the envelope top (15 cm)', near(pb.max.y * 100, 15));
  check('puck, post and base share one z centre', near((pb.min.z + pb.max.z) * 50, base.position.z * 100) && near(post.position.z * 100, base.position.z * 100));
  check('default Mini: charcoal puck on a black matte stand', hex(puck.material) < 0x606060 && hex(base.material) < 0x303030 && base.material.userData.finish === 'matte', [hex(puck.material).toString(16), hex(base.material).toString(16)]);
  check('stand colours differ', hex(part(S.build(THREE, { kind: 'nest-mini-stand', standColor: 'white' }), 'miniStandBase').material) > 0xd0d0d0 &&
    hex(part(S.build(THREE, { kind: 'nest-mini-stand', standColor: 'silver' }), 'miniStandBase').material) > 0x909090);
  check('no status dots by default', part(g, 'miniLed') === null);
  const l = S.build(THREE, { kind: 'nest-mini-stand', leds: true });
  let n = 0, tiny = true, kept = true;
  l.traverse(m => { if (m.name === 'miniLed') { n++; const b = new THREE.Box3().setFromObject(m); if ((b.max.x - b.min.x) > 0.004) tiny = false; if (!m.userData.keep) kept = false; } });
  check('leds: four, each under 4 mm wide, kept', n === 4 && tiny && kept, { n, tiny, kept });
  check('Mini <= 800 triangles full, <= 350 low', tris(g) <= 800 && tris(S.build(THREE, { kind: 'nest-mini-stand' }, { detail: 'low' })) <= 350, tris(g));
}

console.log((failures ? 'FAILED' : 'ok') + ' -- ' + passes + ' passed, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
