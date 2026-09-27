#!/usr/bin/env node
/**
 * Furniture drift test: the registry, the schema's per-type params blocks and
 * the builder modules must agree. No framework, no install:
 * `node scripts/test-furniture-defaults.mjs`.
 *
 * WHY. A type's defaults live in two places on purpose: the builder's
 * DEFAULTS (what it actually draws) and the schema's `default`s in
 * $defs/furnitureParams_<type> (what scripts/validate-house.py reads to
 * compute footprints -- the validator cannot run JavaScript). Two copies drift
 * unless something fails when they do. This is that something.
 *
 * THE RULES
 *
 *   1. Every registered type has exactly one $defs/furnitureParams_<type>
 *      block and one allOf rule in $defs/furnitureItem pointing its params at
 *      it -- and no block or rule exists for an unregistered type.
 *   2. A merged spec page means a merged module. If a registry entry's spec
 *      page (specs/<Spec>.html, or a SPEC_PAGES entry in index.html) exists,
 *      the module at the entry's registry path MUST exist. It is not enough to
 *      check only the types whose module happens to exist -- a module that
 *      went missing, or was committed under the wrong name, would then pass
 *      by being skipped.
 *   3. A PLACEHOLDER block ("x-placeholder": true) is allowed only while no
 *      module exists at the type's registry path. The PR that adds the module
 *      replaces the placeholder in the same PR.
 *   4. For every type whose module exists: the module (or its TYPES[key]
 *      entry, for a multi-type module) exports DEFAULTS with numeric width,
 *      depth and height and a build() function; every DEFAULTS key has a
 *      schema property whose `default` deep-equals it; and every schema
 *      `default` is a DEFAULTS key.
 *   5. scripts/validate-house.py finds registry types with a regex. Every
 *      entry must match it, or the validator would call a real type
 *      "unregistered".
 *   6. A module exporting defaultsFor(params) (per-kind DEFAULTS, item
 *      7c056b3e): for every kind in the schema's `kind` enum, the schema
 *      defaults overlaid with the block's `x-kindDefaults[kind]` give the
 *      same width/depth/height as defaultsFor({kind}). That is what
 *      validate-house.py sizes a kind's footprint from.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { REGISTRY } = await import(pathToFileURL(path.join(root, 'src/furniture/registry.js')).href);
const schema = JSON.parse(fs.readFileSync(path.join(root, 'houses/schema.json'), 'utf8'));

let failures = 0, passes = 0;
function check(name, cond, detail) {
  if (cond) { passes++; return; }
  failures++;
  console.error('FAIL ' + name + (detail !== undefined ? ' -- ' + JSON.stringify(detail) : ''));
}
function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every(k => deepEqual(a[k], b[k]));
}

const defs = schema.$defs || {};
const types = Object.keys(REGISTRY);
const item = defs.furnitureItem || {};
const rules = Array.isArray(item.allOf) ? item.allOf : [];

// ---- 1. registry <-> schema blocks and allOf rules ---------------------------
const ruleTypes = rules.map(r => r && r.if && r.if.properties && r.if.properties.type && r.if.properties.type.const);
types.forEach(t => {
  check(t + ': has $defs/furnitureParams_' + t, !!defs['furnitureParams_' + t]);
  const i = ruleTypes.indexOf(t);
  check(t + ': has exactly one allOf rule', i !== -1 && ruleTypes.lastIndexOf(t) === i, ruleTypes);
  const ref = i !== -1 && rules[i].then && rules[i].then.properties && rules[i].then.properties.params &&
    rules[i].then.properties.params.$ref;
  check(t + ': its rule points params at its own block', ref === '#/$defs/furnitureParams_' + t, ref);
});
Object.keys(defs).filter(k => k.startsWith('furnitureParams_')).forEach(k => {
  check(k + ': belongs to a registered type', types.includes(k.slice('furnitureParams_'.length)));
});
ruleTypes.forEach(t => check('allOf rule for ' + t + ': is a registered type', types.includes(t)));

// ---- 2-4. spec pages, placeholders, DEFAULTS <-> schema defaults -------------
const indexHtml = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const specPagesBlock = (indexHtml.match(/const SPEC_PAGES = \[([\s\S]*?)\];/) || [])[1] || '';
const specMerged = spec => !!spec && (
  fs.existsSync(path.join(root, 'specs', spec + '.html')) ||
  new RegExp("name:\\s*'" + spec + "'").test(specPagesBlock));

const modules = {};
async function loadModule(p) {
  if (!(p in modules)) modules[p] = await import(pathToFileURL(path.join(root, 'src/furniture', p)).href);
  return modules[p];
}

for (const t of types) {
  const entry = REGISTRY[t];
  const file = path.join(root, 'src/furniture', entry.path);
  const exists = fs.existsSync(file);
  const block = defs['furnitureParams_' + t] || {};
  const placeholder = block['x-placeholder'] === true;

  if (specMerged(entry.spec)) {
    check(t + ': spec page ' + entry.spec + ' has merged, so src/furniture/' + entry.path + ' must exist', exists);
  }
  if (!exists) continue;

  check(t + ': src/furniture/' + entry.path + ' exists, so its schema block must not be a placeholder', !placeholder);

  let impl;
  try {
    const mod = await loadModule(entry.path);
    impl = entry.key ? (mod.TYPES && mod.TYPES[entry.key]) : mod;
  } catch (e) {
    check(t + ': module loads', false, String(e));
    continue;
  }
  check(t + ': module exports ' + (entry.key ? 'TYPES["' + entry.key + '"] with ' : '') + 'DEFAULTS and build()',
    !!impl && !!impl.DEFAULTS && typeof impl.build === 'function');
  if (!impl || !impl.DEFAULTS) continue;
  if (!entry.key) check(t + ': module TYPE matches the registry key', impl.TYPE === t, impl.TYPE);
  const D = impl.DEFAULTS;
  ['width', 'depth', 'height'].forEach(k => check(t + ': DEFAULTS.' + k + ' is a number', typeof D[k] === 'number', D[k]));
  if (placeholder) continue;

  const props = block.properties || {};
  Object.keys(D).forEach(k => {
    const prop = props[k];
    check(t + ': DEFAULTS.' + k + ' has a schema property', !!prop);
    if (prop) check(t + ': schema default for ' + k + ' equals DEFAULTS', deepEqual(prop.default, D[k]), { schema: prop.default, DEFAULTS: D[k] });
  });
  Object.keys(props).forEach(k => {
    if (props[k] && Object.prototype.hasOwnProperty.call(props[k], 'default')) {
      check(t + ': schema default for ' + k + ' is a DEFAULTS key', Object.prototype.hasOwnProperty.call(D, k));
    }
  });

  // Rule 6: per-kind envelopes. A module exporting defaultsFor(params)
  // starts a house item of that kind from the kind's own DEFAULTS
  // (src/furniture.js, item 7c056b3e); the validator reads the same numbers
  // from the block's `x-kindDefaults` (it cannot run JavaScript). For every
  // kind in the schema's enum, the schema defaults overlaid with
  // x-kindDefaults[kind] must give the width/depth/height defaultsFor does.
  const perKind = block['x-kindDefaults'] || {};
  const kindEnum = (props.kind && Array.isArray(props.kind.enum)) ? props.kind.enum : [];
  Object.keys(perKind).forEach(kind => {
    check(t + ': x-kindDefaults.' + kind + ' is a kind in the enum', kindEnum.includes(kind), kindEnum);
    Object.keys(perKind[kind] || {}).forEach(k => check(t + ': x-kindDefaults.' + kind + '.' + k + ' is width/depth/height',
      ['width', 'depth', 'height'].includes(k)));
  });
  if (Object.keys(perKind).length) {
    check(t + ': has x-kindDefaults, so the module must export defaultsFor()', typeof impl.defaultsFor === 'function');
  }
  if (typeof impl.defaultsFor === 'function') {
    kindEnum.forEach(kind => {
      const want = impl.defaultsFor({ kind });
      const schemaDims = {};
      ['width', 'depth', 'height'].forEach(k => {
        schemaDims[k] = perKind[kind] && Object.prototype.hasOwnProperty.call(perKind[kind], k)
          ? perKind[kind][k] : (props[k] && props[k].default);
      });
      ['width', 'depth', 'height'].forEach(k => check(t + ' kind ' + kind + ': schema ' + k +
        ' (with x-kindDefaults) equals defaultsFor', schemaDims[k] === want[k], { schema: schemaDims[k], defaultsFor: want[k] }));
    });
  }
}

// ---- 5. the validator's regex finds every registry entry -----------------------
{
  // Same pattern as REGISTRY_LINE_RE in scripts/validate-house.py.
  const re = /^\s*'([a-z][a-z0-9-]*)':\s*\{\s*path:\s*'([^']+)'/gm;
  const src = fs.readFileSync(path.join(root, 'src/furniture/registry.js'), 'utf8');
  const found = {};
  let m;
  while ((m = re.exec(src))) found[m[1]] = m[2];
  types.forEach(t => check(t + ': registry line matches the validator regex', found[t] === REGISTRY[t].path, found[t]));
  check('validator regex finds nothing extra', Object.keys(found).length === types.length, Object.keys(found));
}

console.log((failures ? 'FAILED' : 'ok') + ' -- ' + passes + ' passed, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
