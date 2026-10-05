#!/usr/bin/env node
/**
 * Layout-preserving JSON serialiser (src/json-layout.js) -- what an edit-mode
 * export is written with. No framework, no install:
 * `node scripts/test-json-layout.mjs`.
 *
 * WHAT THIS GUARDS
 *   1. No-op round trip of every committed profile file is BYTE-IDENTICAL,
 *      both with the equal-subtree shortcut and WITHOUT it (copyEqual:false
 *      forces every container through the splice path, so this proves the
 *      splice itself reproduces the file, not just the shortcut).
 *   2. An edit changes only the lines it touches: a new `view` on a room is
 *      one added line, on a one-line furniture item it stays on that line, a
 *      changed param changes one line, a removed key takes its separator.
 *   3. The output always parses back to exactly the new document.
 *   4. Arrays of objects with ids match by id: deleting an item re-emits
 *      nothing else; appending one adds it in the siblings' style.
 *   5. CRLF input keeps CRLF in new multi-line members.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const imp = rel => import(pathToFileURL(path.join(root, rel)).href);
// Byte-exact: NOT CRLF-normalised -- the round trip must reproduce the file as it is on disk.
const readRaw = rel => fs.readFileSync(path.join(root, rel), 'utf8');

let passes = 0, failures = 0;
function check(name, ok, detail) {
  if (ok) { passes++; console.log('  ok   ' + name); }
  else { failures++; console.error('  FAIL ' + name + (detail !== undefined ? '\n       ' + JSON.stringify(detail).slice(0, 600) : '')); }
}

const { serializePreserving, parseWithSpans, inlineJson, deepEqual } = await imp('src/json-layout.js');

/** Lines of b that differ from a (by a simple common prefix/suffix trim). */
function changedLines(a, b) {
  const A = a.split('\n'), B = b.split('\n');
  let p = 0;
  while (p < A.length && p < B.length && A[p] === B[p]) p++;
  let s = 0;
  while (s < A.length - p && s < B.length - p && A[A.length - 1 - s] === B[B.length - 1 - s]) s++;
  return { removed: A.slice(p, A.length - s), added: B.slice(p, B.length - s) };
}

console.log('1. no-op round trips are byte-identical');
const files = ['houses/demo/geometry.json', 'houses/demo/rooms.json', 'houses/schema.json'];
files.forEach(f => {
  const t = readRaw(f);
  check(f + ' (shortcut)', serializePreserving(t, JSON.parse(t)) === t);
  check(f + ' (splice every container)', serializePreserving(t, JSON.parse(t), { copyEqual: false }) === t);
});

const geoText = readRaw('houses/demo/geometry.json').replace(/\r\n/g, '\n');
const geo = () => JSON.parse(geoText);

console.log('2. an edit changes only its own lines');
{
  const d = geo();
  d.rooms[0].view = { azimuth: 0.7, polar: 0.95, distance: 6.5, target: [150, 140], targetHeight: 90, fov: 50 };
  const out = serializePreserving(geoText, d);
  const c = changedLines(geoText, out);
  check('room view: parses back to the new doc', deepEqual(JSON.parse(out), d));
  check('room view: one line gains a comma, one line added', c.removed.length === 1 && c.added.length === 2 &&
    c.added[0] === c.removed[0] + ',' && /^\s+"view": \{ "azimuth": 0.7, /.test(c.added[1]), c);
  check('room view: written at the members\' indent', c.added[1].startsWith('      "view"'), c.added[1]);
}
{
  const d = geo();
  const it = d.furniture[0];
  it.view = { azimuth: 1.1, polar: 1, distance: 2 };
  const out = serializePreserving(geoText, d);
  const c = changedLines(geoText, out);
  check('furniture view: parses back', deepEqual(JSON.parse(out), d));
  check('furniture view: stays on the item\'s last line (one-object-per-line style)', c.removed.length === 1 && c.added.length === 1 &&
    c.added[0].endsWith('"view": { "azimuth": 1.1, "polar": 1, "distance": 2 } },'), c);
}
{
  const d = geo();
  d.furniture[1].params.width = 99;
  const out = serializePreserving(geoText, d);
  const c = changedLines(geoText, out);
  check('one param changed: exactly one line differs', c.removed.length === 1 && c.added.length === 1 &&
    c.added[0] === c.removed[0].replace('"width": 60', '"width": 99'), c);
}
{
  const d = geo();
  d.rooms[0].view = { azimuth: 0.5, polar: 0.9, distance: 5 };
  const withView = serializePreserving(geoText, d);
  delete d.rooms[0].view;
  const back = serializePreserving(withView, d);
  check('removing the key restores the original bytes', back === geoText, changedLines(geoText, back));
  // Removing the FIRST member of a multi-line object keeps the open's whitespace.
  const e = geo();
  delete e.coordinateTransform.originX;
  const out = serializePreserving(geoText, e);
  const c = changedLines(geoText, out);
  check('removing the first member drops just its line', deepEqual(JSON.parse(out), e) && c.removed.length === 1 && c.added.length === 0, c);
}
{
  const d = geo();
  d.schemaVersion = '1.4';
  const c = changedLines(geoText, serializePreserving(geoText, d));
  check('a changed scalar changes one line', c.removed.length === 1 && c.added.length === 1 && c.added[0] === '  "schemaVersion": "1.4",', c);
}

console.log('3. arrays of objects with ids match by id');
{
  const d = geo();
  const gone = d.furniture.splice(3, 1)[0];
  const out = serializePreserving(geoText, d);
  const c = changedLines(geoText, out);
  check('deleting one item removes only its lines', deepEqual(JSON.parse(out), d) && c.added.length === 0 &&
    c.removed.join('\n').includes('"' + gone.id + '"') && c.removed.length <= 4, c);
}
{
  const d = geo();
  d.furniture.push({ id: 'demo_new_box', room: 'lounge', type: 'box', at: [100, 100], params: { width: 40, depth: 40, height: 40 } });
  const out = serializePreserving(geoText, d);
  const c = changedLines(geoText, out);
  check('appending an item adds it on one line in the siblings\' style', deepEqual(JSON.parse(out), d) &&
    c.added.length === c.removed.length + 1 && c.added[c.added.length - 1].startsWith('    { "id": "demo_new_box", '), c);
}
{
  // A reorder is a real change: the container is written fresh, still valid.
  const d = geo();
  d.rooms.reverse();
  const out = serializePreserving(geoText, d);
  check('a reordered array still serialises to the new doc', deepEqual(JSON.parse(out), d));
}

console.log('4. odds and ends');
{
  check('inline style', inlineJson({ a: 1, b: [1, 2], c: {} }) === '{ "a": 1, "b": [1, 2], "c": {} }');
  check('no base text: plain 2-space JSON', serializePreserving(null, { a: 1 }) === '{\n  "a": 1\n}\n');
  check('unparseable base: plain 2-space JSON', serializePreserving('{nope', { a: 1 }) === '{\n  "a": 1\n}\n');
  const crlf = '{\r\n  "a": 1,\r\n  "b": 2\r\n}\r\n';
  const big = { a: 1, b: 2, c: { long: 'x'.repeat(60), longer: 'y'.repeat(60) } };
  const out = serializePreserving(crlf, big);
  check('CRLF base: kept, and a new multi-line member uses CRLF', !/[^\r]\n/.test(out) && deepEqual(JSON.parse(out), big), out);
  let threw = false;
  try { parseWithSpans('{"a": 1,}'); } catch (e) { threw = true; }
  check('parser rejects invalid JSON', threw);
  check('strings with escapes survive', (() => { const t = '{ "s": "a\\"b\\\\c\\u00e9" }\n'; return serializePreserving(t, JSON.parse(t), { copyEqual: false }) === t; })());
}

console.log('\n' + passes + ' passed, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
