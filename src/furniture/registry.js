/**
 * registry.js - furniture `type` -> the module that builds it.
 *
 * A DATA TABLE, pre-seeded with every planned type, so a PR adding a type
 * never edits this file: it only has to create the module at the path already
 * named here. Entries are alphabetical, one per line, separated by blank lines
 * so parallel PRs never touch adjacent lines.
 *
 * Each entry:
 *   path  module file, relative to this directory
 *   key   null for a single-type module, which exports TYPE / DEFAULTS /
 *         build directly. A string for a MULTI-TYPE module (kitchen.js,
 *         small-items.js), which instead exports
 *             export const TYPES = { '<type>': { DEFAULTS, build }, ... };
 *         and `key` is the property of TYPES to use.
 *   spec  the public spec page (specs/<spec>.html) that signs the type off,
 *         or null. scripts/test-furniture-defaults.mjs fails if that page has
 *         merged but the module at `path` has not.
 *
 * Modules are loaded lazily with dynamic import(), only for types a house
 * actually uses. A module that does not exist yet is a warning and a skip,
 * never an error -- the same forward-compatibility rule as `decor`.
 *
 * scripts/validate-house.py reads this file with a regex to learn which types
 * are registered. Keep each entry on ONE line in exactly this shape.
 */

export const REGISTRY = Object.freeze({

  'bed': { path: 'bed.js', key: null, spec: 'BedSpec' },

  'box': { path: 'box.js', key: null, spec: null },

  'cabinet': { path: 'cabinet.js', key: null, spec: 'CabinetSpec' },

  'clock': { path: 'small-items.js', key: 'clock', spec: 'SmallItemsSpec' },

  'digital-piano': { path: 'digital-piano.js', key: null, spec: 'DigitalPianoSpec' },

  'fridge-freezer': { path: 'kitchen.js', key: 'fridge-freezer', spec: 'KitchenSpec' },

  'gaming-chair': { path: 'gaming-chair.js', key: null, spec: 'GamingChairSpec' },

  'kitchen-base-run': { path: 'kitchen.js', key: 'kitchen-base-run', spec: 'KitchenSpec' },

  'kitchen-wall-run': { path: 'kitchen.js', key: 'kitchen-wall-run', spec: 'KitchenSpec' },

  'mirror': { path: 'small-items.js', key: 'mirror', spec: 'SmallItemsSpec' },

  'monitor': { path: 'small-items.js', key: 'monitor', spec: 'SmallItemsSpec' },

  'pc-tower': { path: 'small-items.js', key: 'pc-tower', spec: 'SmallItemsSpec' },

  'plant': { path: 'plant.js', key: null, spec: 'PlantSpec' },

  'radiator': { path: 'radiator.js', key: null, spec: 'RadiatorSpec' },

  'shelf': { path: 'small-items.js', key: 'shelf', spec: 'SmallItemsSpec' },

  'slat-panel': { path: 'slat-panel.js', key: null, spec: 'SlatPanelSpec' },

  'sofa': { path: 'sofa.js', key: null, spec: 'SofaSpec' },

  'speaker': { path: 'small-items.js', key: 'speaker', spec: 'SmallItemsSpec' },

  'standing-desk': { path: 'standing-desk.js', key: null, spec: 'StandingDeskSpec' },

  'tv': { path: 'small-items.js', key: 'tv', spec: 'SmallItemsSpec' },

  'wall-art': { path: 'small-items.js', key: 'wall-art', spec: 'SmallItemsSpec' },

  'wall-sconce': { path: 'wall-sconce.js', key: null, spec: 'WallDecorSpec' },

  'wall-sign': { path: 'wall-sign.js', key: null, spec: 'WallDecorSpec' },

});

/** The registry entry for `type`, or null. */
export function registryEntry(type, registry) {
  const reg = registry || REGISTRY;
  return Object.prototype.hasOwnProperty.call(reg, type) ? reg[type] : null;
}

// The build placeholder, assembled so deploy/generate-config.sh's sed (which
// rewrites index.html only, but still) and any grep for it never match here.
const UNSTAMPED = '__' + 'VERSION' + '__';

/**
 * The app version to cache-bust builder URLs with.
 *
 * WHY. nginx serves src/ with a one-year immutable cache, and index.html
 * busts it with `?v=<version>` on every script it names. A builder loaded by
 * a bare dynamic import() would carry no ?v= at all, so after a deploy a
 * browser would keep running LAST release's builder against this release's
 * data, indefinitely. So every builder URL carries the version too.
 *
 * Resolution order: an explicit `opts.version`; else the `?v=` this module
 * was itself imported with; else window.HOME3D_CONFIG.version (written by
 * deploy/generate-config.sh). An unstamped placeholder counts as none.
 */
export function appVersion(opts) {
  const ok = v => typeof v === 'string' && v !== '' && v !== UNSTAMPED;
  if (opts && ok(opts.version)) return opts.version;
  try {
    const own = new URL(import.meta.url).searchParams.get('v');
    if (ok(own)) return own;
  } catch (e) { /* not a parseable URL: fall through */ }
  const cfg = typeof globalThis !== 'undefined' ? globalThis.HOME3D_CONFIG : null;
  if (cfg && ok(cfg.version)) return cfg.version;
  return null;
}

/**
 * The URL to import `type`'s module from, cache-busted, or null if the type
 * is not registered.
 *
 * @param {string} type
 * @param {{version?: string, registry?: Object, baseUrl?: string}} [opts]
 */
export function moduleUrl(type, opts) {
  const entry = registryEntry(type, opts && opts.registry);
  if (!entry) return null;
  const base = (opts && opts.baseUrl) || import.meta.url;
  const url = new URL('./' + entry.path, base);   // drops this module's own query
  const v = appVersion(opts);
  if (v) url.searchParams.set('v', v);
  return url.href;
}

/**
 * Load the builder for one type.
 *
 * Resolves to { type, DEFAULTS, build } or to null (with a warning pushed to
 * `opts.warnings` and the console) when the type is unregistered, its module
 * does not exist yet, or the module does not export what the contract says.
 * Never rejects: one missing builder must not cost the house its furniture.
 *
 * @param {string} type
 * @param {{version?: string, registry?: Object, baseUrl?: string,
 *          warnings?: string[], importer?: function(string): Promise<Object>}} [opts]
 */
export async function loadBuilder(type, opts) {
  const o = opts || {};
  const warn = msg => {
    if (Array.isArray(o.warnings)) o.warnings.push(msg);
    console.warn('[furniture] ' + msg);
  };
  const entry = registryEntry(type, o.registry);
  if (!entry) {
    warn('type "' + type + '" is not registered -- its items are skipped');
    return null;
  }
  const url = moduleUrl(type, o);
  let mod;
  try {
    mod = await (o.importer ? o.importer(url) : import(url));
  } catch (e) {
    warn('type "' + type + '" has no builder yet (' + entry.path + ' did not load: ' +
      (e && e.message ? e.message : e) + ') -- its items are skipped');
    return null;
  }
  const impl = entry.key ? (mod && mod.TYPES ? mod.TYPES[entry.key] : null) : mod;
  if (!impl || typeof impl.build !== 'function' || !impl.DEFAULTS || typeof impl.DEFAULTS !== 'object') {
    warn('type "' + type + '": ' + entry.path + (entry.key ? ' TYPES["' + entry.key + '"]' : '') +
      ' does not export DEFAULTS and build() -- its items are skipped');
    return null;
  }
  return { type: type, DEFAULTS: impl.DEFAULTS, build: impl.build };
}

/**
 * Load the builders for every distinct type in `types` (in parallel).
 * @returns {Promise<Map<string, {type, DEFAULTS, build}>>} only the ones that loaded
 */
export async function loadBuilders(types, opts) {
  const unique = Array.from(new Set(types));
  const loaded = await Promise.all(unique.map(t => loadBuilder(t, opts)));
  const out = new Map();
  loaded.forEach((b, i) => { if (b) out.set(unique[i], b); });
  return out;
}
