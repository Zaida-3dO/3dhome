/**
 * json-layout.js -- write a JSON document back in the layout it was read in.
 *
 * A house profile is hand-laid-out JSON: most of it is two-space indented,
 * but furniture and fixtures are written one object per line, short arrays
 * stay on one line, and so on. JSON.stringify(doc, null, 2) would rewrite
 * every line of it, and the maintainer reviews the diff of an export before copying
 * it to the server -- a diff that touches every line hides the one change
 * that matters.
 *
 * So the serialiser SPLICES: it parses the original text keeping each
 * value's source span, then walks the new document beside it.
 *   - a value equal to the original's (deep) is copied byte for byte;
 *   - an object or array that changed keeps its own brackets and the exact
 *     separators between its members, and recurses into each member;
 *   - a member that is new is appended after the last one, using the
 *     separator the container already uses between members, and written
 *     inline (`{ "a": 1, "b": 2 }`, the profile's one-object-per-line style)
 *     when short or when its container is itself on one line;
 *   - a member that was removed takes its separator with it.
 * An unedited document therefore comes back byte-identical, and an edit
 * changes only the lines it touches. Pure: no DOM, no I/O.
 *
 * Arrays of objects that all carry a unique string `id` are matched BY ID,
 * so deleting one furniture item does not re-emit every item after it.
 * If a container's surviving members were REORDERED the splice gives up on
 * that container (only) and writes it fresh.
 */

// ---- Parsing with spans --------------------------------------------------

/**
 * Parse `text` into a span tree. Nodes:
 *   { t: 'obj', s, e, v, m: [{ k, ks, ke, n }] }   ks/ke the key's quoted span
 *   { t: 'arr', s, e, v, items: [node] }
 *   { t: 'val', s, e, v }                          string, number, literal
 * `s`/`e` are offsets into `text` (end exclusive). Throws on invalid JSON.
 */
export function parseWithSpans(text) {
  let i = 0;
  const n = text.length;
  const ws = () => { while (i < n && (text[i] === ' ' || text[i] === '\t' || text[i] === '\n' || text[i] === '\r')) i++; };
  const fail = msg => { throw new SyntaxError('json-layout: ' + msg + ' at offset ' + i); };
  function str() {
    const s = i;
    if (text[i] !== '"') fail('expected a string');
    i++;
    while (i < n && text[i] !== '"') { if (text[i] === '\\') i++; i++; }
    if (i >= n) fail('unterminated string');
    i++;
    return { t: 'val', s, e: i, v: JSON.parse(text.slice(s, i)) };
  }
  function value() {
    ws();
    const c = text[i];
    if (c === '{') {
      const s = i; i++;
      const m = [], v = {};
      ws();
      if (text[i] === '}') { i++; return { t: 'obj', s, e: i, v, m }; }
      for (;;) {
        ws();
        const key = str();
        ws();
        if (text[i] !== ':') fail('expected ":"');
        i++;
        const node = value();
        m.push({ k: key.v, ks: key.s, ke: key.e, n: node });
        v[key.v] = node.v;
        ws();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === '}') { i++; break; }
        fail('expected "," or "}"');
      }
      return { t: 'obj', s, e: i, v, m };
    }
    if (c === '[') {
      const s = i; i++;
      const items = [];
      ws();
      if (text[i] === ']') { i++; return { t: 'arr', s, e: i, v: [], items }; }
      for (;;) {
        items.push(value());
        ws();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === ']') { i++; break; }
        fail('expected "," or "]"');
      }
      return { t: 'arr', s, e: i, v: items.map(x => x.v), items };
    }
    if (c === '"') return str();
    const s = i;
    while (i < n && /[-+0-9.eEtruefalsn]/.test(text[i])) i++;
    if (s === i) fail('unexpected character');
    return { t: 'val', s, e: i, v: JSON.parse(text.slice(s, i)) };
  }
  const root = value();
  ws();
  if (i !== n) fail('trailing content');
  return root;
}

// ---- Helpers -------------------------------------------------------------

export function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') {
    return typeof a === 'number' && typeof b === 'number' && Number.isNaN(a) && Number.isNaN(b);
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    for (let k = 0; k < a.length; k++) if (!deepEqual(a[k], b[k])) return false;
    return true;
  }
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  // Key ORDER counts: the file is text, and a reorder is a change.
  for (let k = 0; k < ka.length; k++) if (ka[k] !== kb[k] || !deepEqual(a[ka[k]], b[kb[k]])) return false;
  return true;
}

/** The leading whitespace of the line holding offset `pos`. */
function lineIndent(text, pos) {
  let b = pos;
  while (b > 0 && text[b - 1] !== '\n') b--;
  let e = b;
  while (e < text.length && (text[e] === ' ' || text[e] === '\t')) e++;
  return text.slice(b, e);
}

const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

/** One-line form: `{ "a": 1, "b": [1, 2] }`, `[1, 2]`, `{}`, `[]`. */
export function inlineJson(v) {
  if (Array.isArray(v)) return v.length ? '[' + v.map(inlineJson).join(', ') + ']' : '[]';
  if (isPlainObject(v)) {
    const ks = Object.keys(v).filter(k => v[k] !== undefined);
    return ks.length ? '{ ' + ks.map(k => JSON.stringify(k) + ': ' + inlineJson(v[k])).join(', ') + ' }' : '{}';
  }
  return JSON.stringify(v);
}

// Long enough that a full camera `view` (about 120 characters) stays on one line.
const INLINE_MAX = 140;

/** A value with no original text: inline when short (or forced), else 2-space blocks. */
// The line ending of the file being written (a Windows checkout may be CRLF).
// Set by serializePreserving for the duration of one synchronous call.
let EOL = '\n';
function fresh(v, indent, forceInline) {
  const one = inlineJson(v);
  if (forceInline || one.length <= INLINE_MAX || v === null || typeof v !== 'object') return one;
  return JSON.stringify(v, null, 2).split('\n').map((l, k) => (k ? indent + l : l)).join(EOL);
}

/** Match new array elements to original nodes: by unique string id, else by index. */
function matchItems(items, arr) {
  const byId = items.length && items.every(x => isPlainObject(x.v) && typeof x.v.id === 'string');
  if (byId) {
    const ids = new Set(items.map(x => x.v.id));
    if (ids.size === items.length) {
      const map = new Map(items.map((x, k) => [x.v.id, k]));
      return arr.map(v => (isPlainObject(v) && typeof v.id === 'string' && map.has(v.id) ? map.get(v.id) : -1));
    }
  }
  return arr.map((v, k) => (k < items.length ? k : -1));
}

// ---- Emitting ------------------------------------------------------------

function emit(text, node, v, opts) {
  if (node && opts.copyEqual && deepEqual(node.v, v)) return text.slice(node.s, node.e);
  if (node && node.t === 'obj' && isPlainObject(v) && node.m.length) return emitObject(text, node, v, opts);
  if (node && node.t === 'arr' && Array.isArray(v) && node.items.length) return emitArray(text, node, v, opts);
  if (node && node.t === 'val' && deepEqual(node.v, v)) return text.slice(node.s, node.e);
  return fresh(v, node ? lineIndent(text, node.s) : '', false);
}

/**
 * Splice a container. `parts` are the original members in order, each
 * { s, e, key? }: s/e the member's span (for an object, key through value).
 * `kept` lists, in output order, { orig: index, text } for members carried
 * over and { orig: -1, text } for new ones (always after the kept ones).
 */
function splice(text, node, parts, kept) {
  const open = text.slice(node.s, parts[0].s);
  const close = text.slice(parts[parts.length - 1].e, node.e);
  const sepBefore = k => text.slice(parts[k - 1].e, parts[k].s);
  const addSep = parts.length >= 2 ? sepBefore(parts.length - 1)
    : (/\n/.test(open) ? ',' + open.slice(open.lastIndexOf('\n')) : ', ');
  if (!kept.length) return text.slice(node.s, node.s + 1) + text.slice(node.e - 1, node.e);
  let out = open;
  kept.forEach((x, idx) => {
    // The first member sits after the open's own whitespace; a kept member
    // keeps the separator that preceded it; a new one uses the house style.
    if (idx > 0) out += x.orig > 0 ? sepBefore(x.orig) : addSep;
    out += x.text;
  });
  return out + close;
}

function inlineContext(text, node, parts) {
  // A container written on one line keeps new members on that line too.
  return !/\n/.test(text.slice(node.s, node.e)) || (parts.length >= 2 && !/\n/.test(text.slice(parts[0].e, parts[1].s)));
}

function emitObject(text, node, v, opts) {
  const keys = Object.keys(v).filter(k => v[k] !== undefined);
  const origKeys = node.m.map(m => m.k);
  const survivors = origKeys.filter(k => keys.includes(k));
  const survivorsInNew = keys.filter(k => origKeys.includes(k));
  if (survivors.join('\u0000') !== survivorsInNew.join('\u0000')) return fresh(v, lineIndent(text, node.s), false);
  const parts = node.m.map(m => ({ s: m.ks, e: m.n.e }));
  const kept = [];
  node.m.forEach((m, k) => {
    if (!keys.includes(m.k)) return;
    kept.push({ orig: k, text: text.slice(m.ks, m.n.s) + emit(text, m.n, v[m.k], opts) });
  });
  const colon = text.slice(node.m[0].ke, node.m[0].n.s);
  const inline = inlineContext(text, node, parts);
  const memberIndent = lineIndent(text, node.m[node.m.length - 1].ks);
  keys.filter(k => !origKeys.includes(k)).forEach(k => {
    kept.push({ orig: -1, text: JSON.stringify(k) + colon + fresh(v[k], memberIndent, inline) });
  });
  return splice(text, node, parts, kept);
}

function emitArray(text, node, v, opts) {
  const match = matchItems(node.items, v);
  const seen = match.filter(k => k >= 0);
  for (let k = 1; k < seen.length; k++) if (seen[k] <= seen[k - 1]) return fresh(v, lineIndent(text, node.s), false);
  // New elements must come after every kept one (appends); anything else is written fresh.
  const firstNew = match.indexOf(-1);
  if (firstNew >= 0 && match.slice(firstNew).some(k => k >= 0)) return fresh(v, lineIndent(text, node.s), false);
  const parts = node.items.map(x => ({ s: x.s, e: x.e }));
  const inline = inlineContext(text, node, parts);
  const itemIndent = lineIndent(text, node.items[node.items.length - 1].s);
  const kept = v.map((x, k) => (match[k] >= 0
    ? { orig: match[k], text: emit(text, node.items[match[k]], x, opts) }
    : { orig: -1, text: fresh(x, itemIndent, inline || isPlainObject(x)) }));
  return splice(text, node, parts, kept);
}

/**
 * Serialise `value` in the layout of `baseText`.
 * @param baseText  the original file's text (may be null: then plain 2-space JSON)
 * @param value     the new document
 * @param o.copyEqual  default true. false never copies a whole unchanged
 *                     container, so every container goes through the splice
 *                     path -- the test uses it to prove the splice itself
 *                     reproduces the file.
 * @returns the text, with the original's leading/trailing whitespace (final newline)
 */
export function serializePreserving(baseText, value, o) {
  const opts = { copyEqual: !(o && o.copyEqual === false) };
  let root = null;
  if (typeof baseText === 'string') {
    try { root = parseWithSpans(baseText); } catch (e) { root = null; }
  }
  if (!root) return JSON.stringify(value, null, 2) + '\n';
  EOL = /\r\n/.test(baseText) ? '\r\n' : '\n';
  try {
    return baseText.slice(0, root.s) + emit(baseText, root, value, opts) + baseText.slice(root.e);
  } finally { EOL = '\n'; }
}
