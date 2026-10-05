#!/usr/bin/env node
/**
 * Furniture control descriptors (edit-mode phase B-P0): src/furniture/controls.js
 * and every builder's optional CONTROLS table.
 * No framework, no install: `node scripts/test-furniture-controls.mjs`.
 *
 * WHAT THIS GUARDS
 *
 *   1. Per registry type with a module (a multi-type module through its
 *      TYPES[key]; `model` is out of scope - it needs a profile .glb):
 *        - a type whose registry entry names a spec page EXPORTS CONTROLS;
 *        - controlsFor() covers EVERY DEFAULTS key exactly once, and an
 *          explicit control never names a key that is not in DEFAULTS;
 *        - a range has finite min <= default <= max and step > 0;
 *        - a select holds its default; a colour default is a #hex colour;
 *          a toggle default is a boolean;
 *        - building with each range at its min and at its max (the others at
 *          DEFAULTS) still meets the builder contract, the same checks as
 *          scripts/test-furniture-core.mjs section 7 (bbox == params, back at
 *          z = 0, palette finishes, keep flags, low <= full triangles);
 *        - building with each select option, and each toggle flipped, builds.
 *   2. The amendment-14 edge cases of the auto-derived fallback: a ZERO
 *      default (not a collapsed 0..0), a NEGATIVE default (not an inverted
 *      range), counts and integer defaults (step 1, whole numbers), angles
 *      (-180..180), fractions, colours, finish selects, text, and nested /
 *      null params (unsupported, never a bogus slider).
 *   3. controlsFor merge rules: explicit first and in order, derived after,
 *      no duplicates, nothing mutated.
 *   4. Builders stay pure: CONTROLS is frozen-safe data, and importing
 *      controls.js into a builder does not change what it renders (the
 *      contract loop above builds every type; test-furniture-core.mjs still
 *      builds them at DEFAULTS).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const imp = rel => import(pathToFileURL(path.join(root, rel)).href);
const THREE = await imp('vendor/three-r160/three.module.min.js');
const Fin = await imp('src/furniture/finishes.js');
const R = await imp('src/furniture/registry.js');
const C = await imp('src/furniture/controls.js');

let failures = 0, passes = 0;
function check(name, cond, detail) {
  if (cond) { passes++; return; }
  failures++;
  console.error('FAIL ' + name + (detail !== undefined ? ' -- ' + JSON.stringify(detail) : ''));
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const get = (list, key) => list.find(c => c.key === key);

// ---- 2. the fallback's edge cases (amendment 14) ------------------------------
{
  const d = C.deriveNumber;
  // positive, the plain case: 0.5x .. 2x
  let c = d('widthish', 40.5);
  // 0.5x..2x (20.25..81), rounded OUTWARD to the 5 cm grid a 10..100 default takes.
  check('positive: 0.5x..2x, rounded outward', c.kind === 'range' && c.min === 20 && c.max === 85, c);
  c = d('widthish', 167.1);
  check('positive: a TV-sized default rounds to the 10 cm grid (not 83.55..334.2)', c.min === 80 && c.max === 340, c);
  c = d('widthish', 1.5);
  check('positive: the minimum never rounds down to zero', c.min === 0.75 && c.max === 3, c);
  c = d('widthish', 0.4);
  check('positive below 1: 0.1 grid', c.min === 0.2 && c.max === 0.8, c);
  c = d('widthish', 40.5);
  check('positive: step > 0', c.step > 0, c);
  check('positive fraction: step fine enough for the default', Number.isFinite(c.step) && c.step <= 0.5, c);

  // ZERO default: a 0.5x..2x range would be 0..0
  c = d('gap', 0);
  check('zero default: a real range, not 0..0', c.min < c.max && c.min <= 0 && 0 <= c.max, c);
  check('zero default: absolute 0..100', c.min === 0 && c.max === 100 && c.step > 0, c);
  c = d('bandCount', 0);
  check('zero count: 0..10 whole numbers', c.min === 0 && c.max === 10 && c.step === 1, c);

  // NEGATIVE default: 0.5x..2x would invert (min > max)
  c = d('offset', -10);
  check('negative default: symmetric, not inverted', c.min === -20 && c.max === 20 && c.min < c.max, c);
  check('negative default: default inside the range', c.min <= -10 && -10 <= c.max, c);
  c = d('shift', -0.5);
  check('negative fraction: symmetric and ordered', c.min === -1 && c.max === 1 && c.step > 0, c);

  // COUNTS and integer defaults: whole-number step
  ['count', 'n', 'numLegs', 'num', 'pillowCount'].forEach(k => {
    const r = d(k, 3.5);
    check('count key ' + k + ': step 1, whole bounds, default reachable',
      r.step === 1 && Number.isInteger(r.min) && Number.isInteger(r.max) && r.min <= 3.5 && 3.5 <= r.max, r);
  });
  c = d('stemCount', 3);
  check('count 3: step 1, 1..6', c.step === 1 && c.min === 1 && c.max === 6, c);
  c = d('cushions', 3);
  check('integer default: step 1', c.step === 1 && Number.isInteger(c.min) && Number.isInteger(c.max), c);
  c = d('count', 1);
  check('count 1: contains 1, whole', c.min <= 1 && 1 <= c.max && Number.isInteger(c.min), c);
  check('isCountKey: count / n / num* / *Count', C.isCountKey('count') && C.isCountKey('n') &&
    C.isCountKey('numTiles') && C.isCountKey('leafCount') && !C.isCountKey('counter') &&
    !C.isCountKey('width') && !C.isCountKey('nothing') && !C.isCountKey('number'),
    ['count', 'n', 'numTiles', 'leafCount'].map(C.isCountKey));

  // ANGLES: -180..180
  c = d('reclineDeg', 95);
  check('angle: -180..180 in degrees', c.min === -180 && c.max === 180 && c.unit === '°' && c.step > 0, c);
  c = d('yaw', 0);
  check('angle with a zero default: -180..180 (not 0..100)', c.min === -180 && c.max === 180, c);
  c = d('tilt', -30);
  check('angle with a negative default: -180..180', c.min === -180 && c.max === 180, c);
  c = d('spinDeg', 270);
  check('angle default beyond +-180 stays reachable', c.min <= 270 && 270 <= c.max, c);
  check('isAngleKey', C.isAngleKey('reclineDeg') && C.isAngleKey('angle') && C.isAngleKey('rotation') &&
    !C.isAngleKey('width') && !C.isAngleKey('pitch'));

  // every derived range, over a sweep of awkward defaults
  [0, 1, -1, 0.5, -0.5, 0.05, 7, -7, 12.5, 100, -100, 1e-3, 3, 225, 0.25, 2.25].forEach(v => {
    ['width', 'count', 'tiltDeg', 'n'].forEach(k => {
      const r = d(k, v);
      check('sweep ' + k + '=' + v + ': min <= default <= max, step > 0, finite',
        Number.isFinite(r.min) && Number.isFinite(r.max) && Number.isFinite(r.step) &&
        r.min <= v && v <= r.max && r.min < r.max && r.step > 0, r);
    });
  });
}

// ---- other kinds of fallback ---------------------------------------------------
{
  const dc = C.deriveControl;
  check('hex string -> colour', dc('topColor', '#aabbcc').kind === 'color');
  check('3-digit hex -> colour', dc('c', '#abc').kind === 'color');
  check('boolean -> toggle', dc('led', false).kind === 'toggle');
  let s = dc('finish', 'matte');
  check('finish -> select of the hand-switchable palette, default included, never glass/mirror/emissive',
    s.kind === 'select' && s.options.includes('matte') && !s.options.some(o => Fin.isKeptFinish(o)) &&
    same(s.options, Fin.FINISHES.filter(f => !Fin.isKeptFinish(f))), s);
  s = dc('finish', 'emissive');
  check('a kept default (a glowing tube) stays selectable, first, plus the plain finishes',
    s.kind === 'select' && s.options[0] === 'emissive' && s.options.includes('matte') && !s.options.includes('glass'), s);
  s = dc('baseFinish', 'satin');
  check('xFinish -> select', s.kind === 'select' && s.options.includes('satin'), s);
  s = dc('finish', 'not-a-finish');
  check('finish-named key with an unknown value is free text, not a select that lacks its default', s.kind === 'text', s);
  check('other string -> text', dc('line1', 'HELLO').kind === 'text');
  check('array -> unsupported', same([dc('fronts', [{ a: 1 }]).kind, dc('fronts', []).reason], ['unsupported', 'array']));
  check('object -> unsupported', same([dc('plinth', { height: 8 }).kind, dc('plinth', { height: 8 }).reason], ['unsupported', 'object']));
  check('null -> unsupported', same([dc('src', null).kind, dc('src', null).reason], ['unsupported', 'null']));
  check('NaN is not a slider', dc('x', NaN).kind === 'unsupported');
  check('humanize', C.humanize('upholsteryColor') === 'Upholstery color' && C.humanize('seat_height') === 'Seat height' &&
    C.humanize('LEDStrip') === 'Led strip', [C.humanize('upholsteryColor'), C.humanize('seat_height'), C.humanize('LEDStrip')]);
}

// ---- 3. controlsFor merge rules --------------------------------------------------
{
  const DEF = Object.freeze({ width: 100, depth: 50, color: '#112233', on: true, fronts: [1, 2], gap: 0 });
  const explicit = [C.range('depth', 'Depth', 30, 90, 1, 'cm'), C.range('width', 'Width', 60, 200, 5, 'cm')];
  const snapshot = JSON.stringify(explicit);
  const out = C.controlsFor('t', DEF, explicit);
  check('explicit first, in their own order', same(out.slice(0, 2).map(c => c.key), ['depth', 'width']), out.map(c => c.key));
  check('derived follow in DEFAULTS order', same(out.slice(2).map(c => c.key), ['color', 'on', 'fronts', 'gap']), out.map(c => c.key));
  check('explicit range is used as written, not derived', get(out, 'width').min === 60 && get(out, 'width').step === 5, get(out, 'width'));
  check('covers every DEFAULTS key exactly once', same(out.map(c => c.key).sort(), Object.keys(DEF).sort()), out.map(c => c.key));
  check('explicit input is not mutated', JSON.stringify(explicit) === snapshot);
  out[0].min = -999;
  check('result is a copy: editing it leaves CONTROLS alone', explicit[0].min === 30);
  const dup = C.controlsFor('t', DEF, [C.range('width', 'A', 1, 2, 1), C.range('width', 'B', 3, 4, 1)]);
  check('a repeated key keeps its first entry only', dup.filter(c => c.key === 'width').length === 1 && get(dup, 'width').label === 'A');
  const ghost = C.controlsFor('t', DEF, [C.range('nope', 'Nope', 1, 2, 1)]);
  check('an explicit key absent from DEFAULTS is dropped', !get(ghost, 'nope') && ghost.length === Object.keys(DEF).length);
  check('no CONTROLS: all derived', C.controlsFor('t', DEF).length === Object.keys(DEF).length);
  check('garbage CONTROLS / DEFAULTS do not throw',
    C.controlsFor('t', null, null).length === 0 && C.controlsFor('t', DEF, [null, 3, {}, { key: 7 }]).length === Object.keys(DEF).length);
  check('label defaults to a humanised key', get(C.controlsFor('t', DEF, [{ key: 'gap', kind: 'range', min: 0, max: 5, step: 1 }]), 'gap').label === 'Gap');
}

// ---- 1. every registry type ----------------------------------------------------------
function bboxCm(group) {
  group.updateMatrixWorld(true);
  const b = new THREE.Box3().setFromObject(group);
  return { minX: b.min.x * 100, maxX: b.max.x * 100, minY: b.min.y * 100, maxY: b.max.y * 100, minZ: b.min.z * 100, maxZ: b.max.z * 100 };
}
function triangles(group) {
  let n = 0;
  group.traverse(o => {
    if (!o.isMesh || !o.geometry) return;
    const g = o.geometry;
    const count = g.index ? g.index.count : (g.attributes.position ? g.attributes.position.count : 0);
    n += (count / 3) * (o.isInstancedMesh ? o.count : 1);
  });
  return n;
}
function meshParts(group) {
  const parts = [];
  group.traverse(o => {
    if (!o.isMesh) return;
    (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => parts.push({ mesh: o, material: m }));
  });
  return parts;
}
/** The builder contract, as in scripts/test-furniture-core.mjs section 7. */
function checkContract(tag, build, p) {
  let full, low;
  try {
    full = build(THREE, p, { detail: 'full' });
    low = build(THREE, p, { detail: 'low' });
  } catch (e) {
    check(tag + ': builds without throwing', false, String(e && e.stack || e));
    return;
  }
  check(tag + ': build() returns a THREE.Group', !!full && full.isGroup === true);
  if (!full || !full.isObject3D) return;
  const b = bboxCm(full);
  check(tag + ': width == params within 0.5 cm', Math.abs((b.maxX - b.minX) - p.width) <= 0.5, { bbox: b, width: p.width });
  check(tag + ': centred on x', Math.abs((b.maxX + b.minX) / 2) <= 0.5, b);
  check(tag + ': bottom at y = 0', Math.abs(b.minY) <= 0.5, b);
  check(tag + ': height == params within 0.5 cm', Math.abs(b.maxY - b.minY - p.height) <= 0.5, { bbox: b, height: p.height });
  check(tag + ': back at z = 0', Math.abs(b.minZ) <= 0.5, b);
  check(tag + ': depth == params within 0.5 cm', Math.abs(b.maxZ - b.minZ - p.depth) <= 0.5, { bbox: b, depth: p.depth });
  const parts = meshParts(full);
  check(tag + ': has meshes', parts.length > 0);
  const named = x => (x.mesh.name || x.mesh.type);
  const badFinish = parts.map(x => ({ x, r: Fin.partFinish(x.mesh, x.material) })).filter(o => o.r.error);
  check(tag + ': every part has a palette finish', badFinish.length === 0, badFinish.map(o => named(o.x) + ': ' + o.r.error));
  const badKeep = parts.map(x => ({ x, r: Fin.partKeep(x.mesh, x.material) })).filter(o => o.r.error);
  check(tag + ': keep flags agree', badKeep.length === 0, badKeep.map(o => named(o.x) + ': ' + o.r.error));
  const unkept = parts.filter(x => {
    const f = Fin.partFinish(x.mesh, x.material).finish;
    return f && Fin.isKeptFinish(f) && Fin.partKeep(x.mesh, x.material).keep !== true;
  });
  check(tag + ': glass/mirror/emissive parts are marked keep', unkept.length === 0, unkept.map(named));
  if (low && low.isObject3D) {
    const tf = triangles(full), tl = triangles(low);
    check(tag + ': detail low has no more triangles than full', tl <= tf, { full: tf, low: tl });
  } else {
    check(tag + ": detail 'low' returns a Group", false);
  }
}

// Types whose spec page (BathroomFittingsSpec, SmallItemsSpec) has no slider / colour /
// select for them: their CONTROLS may be empty and controlsFor() derives everything.
const NO_SLIDER_SPEC = ['monitor', 'pc-tower', 'subwoofer', 'shower-tray', 'towel-rail'];
const REASONS = ['array', 'object', 'null', 'derived', 'coupled', 'fixed'];
const ENVELOPE_KEYS = ['width', 'depth', 'height'];
/**
 * The structural half of the contract: what must hold whatever a control did to
 * the shape. Builds at both detail levels without throwing, returns a Group of
 * meshes with a finite, non-degenerate box, every part has a palette finish,
 * glass/mirror/emissive parts are kept, low <= full triangles. `quiet` also
 * fails if the builder warned (a select option it rejects and falls back from).
 */
function checkStructure(tag, build, p, quiet) {
  const warnings = [];
  const w = console.warn;
  console.warn = m => warnings.push(String(m));
  let full, low;
  try {
    full = build(THREE, p, { detail: 'full' });
    low = build(THREE, p, { detail: 'low' });
  } catch (e) {
    console.warn = w;
    check(tag + ': builds without throwing', false, String(e && e.stack || e));
    return;
  }
  console.warn = w;
  if (quiet) check(tag + ': the builder accepts the value without a warning', warnings.length === 0, warnings);
  check(tag + ': build() returns a THREE.Group', !!full && full.isGroup === true);
  if (!full || !full.isObject3D) return;
  const b = bboxCm(full);
  const finite = Object.values(b).every(Number.isFinite);
  check(tag + ': finite, non-degenerate box', finite && b.maxX > b.minX && b.maxY > b.minY && b.maxZ >= b.minZ, b);
  const parts = meshParts(full);
  check(tag + ': has meshes', parts.length > 0);
  const named = x => (x.mesh.name || x.mesh.type);
  const badFinish = parts.map(x => ({ x, r: Fin.partFinish(x.mesh, x.material) })).filter(o => o.r.error);
  check(tag + ': every part has a palette finish', badFinish.length === 0, badFinish.map(o => named(o.x) + ': ' + o.r.error));
  const unkept = parts.filter(x => {
    const f = Fin.partFinish(x.mesh, x.material).finish;
    return f && Fin.isKeptFinish(f) && Fin.partKeep(x.mesh, x.material).keep !== true;
  });
  check(tag + ': glass/mirror/emissive parts are marked keep', unkept.length === 0, unkept.map(named));
  if (low && low.isObject3D) check(tag + ': detail low has no more triangles than full', triangles(low) <= triangles(full), { full: triangles(full), low: triangles(low) });
  else check(tag + ": detail 'low' returns a Group", false);
}

const schema = JSON.parse(fs.readFileSync(path.join(root, 'houses/schema.json'), 'utf8'));
const HEXRE = /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/;
const covered = [];
const specTypes = [];
const summary = [];
for (const [type, entry] of Object.entries(R.REGISTRY)) {
  if (type === 'model') continue;                       // out of scope: needs a .glb
  if (!fs.existsSync(path.join(root, 'src/furniture', entry.path))) continue;
  const mod = await imp('src/furniture/' + entry.path);
  const impl = entry.key ? (mod.TYPES && mod.TYPES[entry.key]) : mod;
  if (!impl || !impl.DEFAULTS || typeof impl.build !== 'function') { check(type + ': module exports a builder', false); continue; }
  covered.push(type);
  const D = impl.DEFAULTS;

  // loadBuilder passes CONTROLS through
  const lb = await R.loadBuilder(type);
  check(type + ': loadBuilder passes CONTROLS through', !impl.CONTROLS || lb.CONTROLS === impl.CONTROLS);

  if (entry.spec) {
    specTypes.push(type);
    check(type + ': has a spec page (' + entry.spec + ') so exports CONTROLS', Array.isArray(impl.CONTROLS));
    // An EMPTY table is only honest where the spec page really has no control for the type.
    if (!NO_SLIDER_SPEC.includes(type)) check(type + ': its spec page has controls, so CONTROLS is not empty', impl.CONTROLS && impl.CONTROLS.length > 0);
  }
  const explicit = Array.isArray(impl.CONTROLS) ? impl.CONTROLS : [];
  explicit.forEach(c => check(type + ': explicit control "' + c.key + '" names a DEFAULTS key',
    Object.prototype.hasOwnProperty.call(D, c.key), c));
  explicit.forEach(c => (c.mirror || []).forEach(k => check(type + '.' + c.key + ': mirror key "' + k + '" is in DEFAULTS', k in D)));
  const keys = explicit.map(c => c.key);
  check(type + ': explicit CONTROLS name each key once', new Set(keys).size === keys.length, keys);

  const list = C.controlsFor(type, D, impl.CONTROLS);
  const got = list.map(c => c.key);
  check(type + ': controlsFor covers every DEFAULTS key exactly once',
    same(got.slice().sort(), Object.keys(D).sort()), { missing: Object.keys(D).filter(k => !got.includes(k)), extra: got.filter(k => !(k in D)) });

  let nRange = 0, nBuilds = 0;
  for (const c of list) {
    const tag = type + '.' + c.key + ' (' + c.kind + ')';
    check(tag + ': has a label', typeof c.label === 'string' && c.label.length > 0);
    const dv = D[c.key];
    if (c.kind === 'range') {
      nRange++;
      check(tag + ': default is a number', typeof dv === 'number', dv);
      check(tag + ': min <= default <= max', Number.isFinite(c.min) && Number.isFinite(c.max) && c.min <= dv && dv <= c.max, { min: c.min, dv, max: c.max });
      check(tag + ': step > 0', Number.isFinite(c.step) && c.step > 0, c.step);
      // The schema is the validator's truth: a slider must not offer a value the
      // house profile would then reject (a minimum, a maximum, an integer).
      const sp = (schema.$defs['furnitureParams_' + type] || {}).properties;
      const sk = sp && sp[c.key];
      if (sk && typeof sk.minimum === 'number') check(tag + ': min respects the schema minimum', c.min >= sk.minimum, { min: c.min, schema: sk.minimum });
      if (sk && typeof sk.maximum === 'number') check(tag + ': max respects the schema maximum', c.max <= sk.maximum, { max: c.max, schema: sk.maximum });
      if (sk && sk.type === 'integer') check(tag + ': an integer param has an integer step and bounds', Number.isInteger(c.step) && Number.isInteger(c.min) && Number.isInteger(c.max), c);
      if (!(c.min <= dv && dv <= c.max && c.step > 0)) continue;
      for (const v of [c.min, c.max]) {
        nBuilds++;
        const p = Object.assign({}, D, { [c.key]: v });
        (c.mirror || []).forEach(k => { p[k] = v; });
        // The envelope contract (bbox == width/depth/height) is only meaningful
        // for the controls that ARE the envelope: width / depth / height, or a
        // control that declares it mirrors them. Every other control moves the
        // envelope as a side effect and gets the structural contract.
        if (ENVELOPE_KEYS.includes(c.key) || (c.mirror && c.mirror.length)) checkContract(type + ' ' + c.key + '=' + v, impl.build, p);
        else checkStructure(type + ' ' + c.key + '=' + v, impl.build, p);
      }
    } else if (c.kind === 'select') {
      const vals = (c.options || []).map(C.optionValue);
      check(tag + ': options non-empty', vals.length > 0);
      check(tag + ': options contain the default', vals.includes(dv), { vals, dv });
      for (const v of vals) {
        if (v === dv) continue;
        nBuilds++;
        checkStructure(type + ' ' + c.key + '=' + v, impl.build, Object.assign({}, D, { [c.key]: v }), true);
      }
    } else if (c.kind === 'color') {
      check(tag + ': default is a #hex colour', typeof dv === 'string' && HEXRE.test(dv), dv);
    } else if (c.kind === 'toggle') {
      check(tag + ': default is a boolean', typeof dv === 'boolean', dv);
      nBuilds++;
      checkStructure(type + ' ' + c.key + '=' + !dv, impl.build, Object.assign({}, D, { [c.key]: !dv }), true);
    } else if (c.kind === 'text') {
      check(tag + ': default is a string', typeof dv === 'string', dv);
    } else if (c.kind === 'unsupported') {
      check(tag + ': says why, with a known reason', REASONS.includes(c.reason), c);
    } else {
      check(tag + ': a known kind', false, c.kind);
    }
  }
  summary.push(type + ' (' + explicit.length + ' explicit / ' + list.length + ' total, ' + nRange + ' ranges, ' + nBuilds + ' extreme builds)');
}
check('the loop reached the expected number of types', covered.length >= 40, covered.length);
console.log('controls checked for ' + covered.length + ' types:\n  ' + summary.join('\n  '));
console.log('spec-page types exporting CONTROLS: ' + specTypes.length);

console.log((failures ? 'FAILED' : 'ok') + ' - ' + passes + ' passed, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
