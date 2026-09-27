#!/usr/bin/env node
/**
 * sofa.js: geometry decisions a contract-gate screenshot cannot pin.
 * No framework, no install: `node scripts/test-sofa.mjs`.
 *
 * scripts/test-furniture-core.mjs already checks the generic builder
 * contract at DEFAULTS for every registered type, `sofa` included. This file
 * checks the sofa-specific decisions, each with the mutation it catches:
 *
 *   1. The default L builds to 275 x 197 x 88 (and every preset / odd param
 *      set still builds to its own bbox within 0.5 cm).
 *   2. chaise 'right' puts the chaise cushion at +x, 'left' at -x.
 *   3. 'none' has an arm at both ends; an L has one arm, at the non-chaise end.
 *   4. Seat top = seatHeight, back top = height, arm top = armHeight.
 *   5. Finishes: fabric matte, plinth the baseFinish; no lights.
 *   6. Triangle caps: full <= 2500, low <= 800, low <= 0.6 x full.
 *   7. toFurnitureJSON emits only the non-default keys.
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const imp = rel => import(pathToFileURL(path.join(root, rel)).href);
const THREE = await imp('vendor/three-r160/three.module.min.js');
const Sofa = await imp('src/furniture/sofa.js');

let failures = 0, passes = 0;
function check(name, cond, detail) {
  if (cond) { passes++; return; }
  failures++;
  console.error('FAIL ' + name + (detail !== undefined ? ' -- ' + JSON.stringify(detail) : ''));
}
const near = (a, b, eps) => Math.abs(a - b) <= eps;

function bboxCm(obj) {
  obj.updateMatrixWorld(true);
  const b = new THREE.Box3().setFromObject(obj);
  return { minX: b.min.x * 100, maxX: b.max.x * 100, minY: b.min.y * 100, maxY: b.max.y * 100, minZ: b.min.z * 100, maxZ: b.max.z * 100 };
}
function triangles(group) {
  let n = 0;
  group.traverse(o => {
    if (!o.isMesh) return;
    const g = o.geometry;
    n += (g.index ? g.index.count : g.attributes.position.count) / 3;
  });
  return n;
}
const parts = (g, re) => g.children.filter(c => c.isMesh && re.test(c.name));
const build = (params, detail) => {
  const g = Sofa.build(THREE, Object.assign({}, Sofa.DEFAULTS, params), { detail: detail || 'full' });
  g.updateMatrixWorld(true);
  return g;
};

// ---- exports ------------------------------------------------------------------
check('TYPE is "sofa"', Sofa.TYPE === 'sofa');
check('DEFAULTS frozen with numeric width/depth/height', Object.isFrozen(Sofa.DEFAULTS) &&
  ['width', 'depth', 'height'].every(k => typeof Sofa.DEFAULTS[k] === 'number'));

// ---- 1. envelope ------------------------------------------------------------------
// Mutation: change DEFAULTS.depth to 180 (or drop the chaise plinth) -> fails.
{
  const b = bboxCm(build({}));
  check('default L is 275 wide within 1 cm', near(b.maxX - b.minX, 275, 1), b);
  check('default L is 197 deep within 1 cm', near(b.maxZ - b.minZ, 197, 1), b);
  check('default L is 88 tall within 1 cm', near(b.maxY - b.minY, 88, 1), b);
}
// Every shape, plus params that fight each other, keeps the 0.5 cm contract.
// Mutation: remove the seatDepth clamp (mainD = seatDepth) -> the 'deep seat'
// case builds deeper than `depth` and fails.
const CASES = [
  {},
  { chaise: 'left' },
  { chaise: 'none', width: 220, depth: 97 },
  { chaise: 'none' },
  { width: 180, depth: 90, height: 70, seatDepth: 150, chaiseWidth: 300, armWidth: 80 },
  { seatHeight: 120, armHeight: 200, baseHeight: 100, backDepth: 90 },
  { cushions: 4 }, { cushions: 1 }, { chaise: 'none', cushions: 4 }
];
for (const c of CASES) {
  const p = Object.assign({}, Sofa.DEFAULTS, c);
  for (const d of ['full', 'low']) {
    const b = bboxCm(build(c, d));
    const tag = JSON.stringify(c) + ' ' + d;
    check(tag + ': width within 0.5', near(b.maxX - b.minX, p.width, 0.5) && near(b.minX + b.maxX, 0, 0.5), b);
    check(tag + ': depth within 0.5, back at z=0', near(b.maxZ - b.minZ, p.depth, 0.5) && near(b.minZ, 0, 0.5), b);
    check(tag + ': height within 0.5, bottom at y=0', near(b.maxY - b.minY, p.height, 0.5) && near(b.minY, 0, 0.5), b);
  }
}

// ---- 2. chaise side ---------------------------------------------------------------
// Mutation: flip `sgn` (right -> -1) in build() -> both checks fail.
{
  const centreX = g => { const b = bboxCm(parts(g, /^chaiseCushion$/)[0]); return (b.minX + b.maxX) / 2; };
  const cr = build({ chaise: 'right' }), cl = build({ chaise: 'left' });
  check("chaise 'right' has one chaise cushion", parts(cr, /^chaiseCushion$/).length === 1);
  check("chaise 'right': chaise cushion centre at +x", centreX(cr) > 50, centreX(cr));
  check("chaise 'left': chaise cushion centre at -x", centreX(cl) < -50, centreX(cl));
  // The chaise runs forward to the full depth; the main-leg seat does not.
  const chb = bboxCm(parts(cr, /^chaiseCushion$/)[0]);
  check('chaise cushion reaches the front (z = depth)', near(chb.maxZ, 197, 1), chb);
  const seatMaxZ = Math.max(...parts(cr, /^seatCushion_/).map(m => bboxCm(m).maxZ));
  check('main-leg seat ends at seatDepth', near(seatMaxZ, 97, 1), seatMaxZ);
  // Back cushions run the full back length, behind the chaise too.
  const backs = parts(cr, /^backCushion_/).map(bboxCm);
  const backMaxX = Math.max(...backs.map(b => b.maxX)), backMinX = Math.min(...backs.map(b => b.minX));
  check('back cushions reach the chaise end (+x edge)', near(backMaxX, 137.5, 1), backMaxX);
  check('back cushions start at the arm (inner face)', near(backMinX, -137.5 + 20, 1), backMinX);
}

// ---- 3. arms -----------------------------------------------------------------------
// Mutation: armSides = [sgn] (arm on the chaise end) -> the L checks fail;
// armSides = [-sgn] for 'none' too -> the 'none' check fails.
{
  const arms = g => parts(g, /^armPad_/).map(m => m.name);
  const straight = build({ chaise: 'none', width: 220, depth: 97 });
  check("'none' has two arms, L and R", JSON.stringify(arms(straight).sort()) === '["armPad_L","armPad_R"]', arms(straight));
  check("'none' has no chaise cushion", parts(straight, /^chaiseCushion$/).length === 0);
  check("chaise 'right': one arm, on the left (non-chaise) end", JSON.stringify(arms(build({ chaise: 'right' }))) === '["armPad_L"]',
    arms(build({ chaise: 'right' })));
  check("chaise 'left': one arm, on the right (non-chaise) end", JSON.stringify(arms(build({ chaise: 'left' }))) === '["armPad_R"]',
    arms(build({ chaise: 'left' })));
  const padMesh = parts(build({}), /^armPad_L$/)[0];
  const pad = padMesh ? bboxCm(padMesh) : null;
  check('the left arm sits at the -x edge', !!pad && near(pad.minX, -137.5, 0.5), pad);
}

// ---- 4. heights ---------------------------------------------------------------------
// Mutations: seat cushion y1 = baseH + seatH; back y1 = H - 5; pad top = armH - 2.
for (const c of [{}, { seatHeight: 40, armHeight: 60, height: 84 }, { chaise: 'none', width: 220, depth: 97 }]) {
  const p = Object.assign({}, Sofa.DEFAULTS, c);
  const g = build(c);
  const tag = JSON.stringify(c);
  const seatTop = Math.max(...parts(g, /^(seatCushion_|chaiseCushion)/).map(m => bboxCm(m).maxY));
  const seatTopMin = Math.min(...parts(g, /^(seatCushion_|chaiseCushion)/).map(m => bboxCm(m).maxY));
  check(tag + ': every seat cushion top = seatHeight +-1', near(seatTop, p.seatHeight, 1) && near(seatTopMin, p.seatHeight, 1), { seatTop, seatTopMin });
  const backTop = Math.max(...parts(g, /^backCushion_/).map(m => bboxCm(m).maxY));
  check(tag + ': back cushion top = height +-0.5', near(backTop, p.height, 0.5), backTop);
  const armTop = Math.max(...parts(g, /^armPad_/).map(m => bboxCm(m).maxY));
  check(tag + ': arm top = armHeight +-1', near(armTop, p.armHeight, 1), armTop);
  const plinthTop = bboxCm(parts(g, /^plinth$/)[0]).maxY;
  check(tag + ': plinth top = baseHeight +-1', near(plinthTop, p.baseHeight, 1), plinthTop);
}

// ---- 5. finishes and lights -----------------------------------------------------------
// Mutations: build the fabric with 'gloss'; ignore baseFinish; add a PointLight.
{
  for (const d of ['full', 'low']) {
    const g = build({}, d);
    let lights = 0, untagged = 0;
    g.traverse(o => { if (o.isLight) lights++; if (o.isMesh && !(o.material.userData && o.material.userData.finish)) untagged++; });
    check(d + ': no lights', lights === 0, lights);
    check(d + ': every mesh has a finish tag', untagged === 0, untagged);
  }
  const g = build({});
  const cushionFin = parts(g, /^(seatCushion_|chaiseCushion|backCushion_|armPad_)/).map(m => m.material.userData.finish);
  check('fabric parts are matte', cushionFin.length > 0 && cushionFin.every(f => f === 'matte'), cushionFin);
  const baseFin = parts(g, /^(plinth|armBody_)/).map(m => m.material.userData.finish);
  check('plinth and arm body take baseFinish (satin by default)', baseFin.length >= 3 && baseFin.every(f => f === 'satin'), baseFin);
  const gg = build({ baseFinish: 'gloss' });
  check('baseFinish: gloss is honoured', parts(gg, /^plinth$/)[0].material.userData.finish === 'gloss');
  const plinthCol = parts(g, /^plinth$/)[0].material.color.getHex();
  check('plinth takes baseColor', plinthCol === parseInt(Sofa.DEFAULTS.baseColor.slice(1), 16), plinthCol.toString(16));
}

// ---- 6. triangle caps -------------------------------------------------------------------
// Mutation: seg = 6 on the rounded parts -> full exceeds 2500; building low
// with rounded boxes -> low exceeds 0.6 x full.
for (const c of [{}, { chaise: 'left' }, { chaise: 'none', width: 220, depth: 97 }, { cushions: 4 }, { chaise: 'none', cushions: 4 }]) {
  const tf = triangles(build(c, 'full')), tl = triangles(build(c, 'low'));
  const tag = JSON.stringify(c);
  check(tag + ': full <= 2500 triangles', tf <= 2500, tf);
  check(tag + ': low <= 800 triangles', tl <= 800, tl);
  check(tag + ': low <= 0.6 x full', tl <= 0.6 * tf, { tf, tl });
  if (!c.chaise && !c.cushions) console.log('sofa triangles at DEFAULTS: full ' + tf + ', low ' + tl);
}
// Full detail must actually be rounded (not a box), or "soft upholstery" is a lie.
// Mutation: `if (!full || true) geo = BoxGeometry` -> fails.
{
  const cushion = parts(build({}), /^seatCushion_0$/)[0];
  const t = (cushion.geometry.index ? cushion.geometry.index.count : cushion.geometry.attributes.position.count) / 3;
  check('full-detail seat cushion is rounded (> 12 triangles)', t > 12, t);
}

// ---- 7. toFurnitureJSON -------------------------------------------------------------------
// Mutation: drop the `!== DEFAULTS[k]` test -> the defaults case emits every key.
{
  const j0 = Sofa.toFurnitureJSON(Object.assign({}, Sofa.DEFAULTS));
  check('toFurnitureJSON(DEFAULTS) is empty params', j0.type === 'sofa' && Object.keys(j0.params).length === 0, j0);
  const j1 = Sofa.toFurnitureJSON(Object.assign({}, Sofa.DEFAULTS, { chaise: 'left', width: 250 }));
  check('toFurnitureJSON emits only the changed keys', JSON.stringify(j1.params) === JSON.stringify({ width: 250, chaise: 'left' }), j1);
}

// ---- registry wiring -------------------------------------------------------------------------
{
  const { REGISTRY } = await imp('src/furniture/registry.js');
  // The sofa is signed off on Beds & Sofas (BedSpec); SofaSpec.html is a redirect stub.
  check('registry: sofa -> sofa.js, BedSpec', REGISTRY.sofa && REGISTRY.sofa.path === 'sofa.js' && REGISTRY.sofa.key === null && REGISTRY.sofa.spec === 'BedSpec', REGISTRY.sofa);
}

console.log((failures ? 'FAILED' : 'ok') + ' -- ' + passes + ' passed, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
