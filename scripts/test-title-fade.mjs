/**
 * The title/hint card fades out after load: source-level guard (no browser).
 * `node scripts/test-title-fade.mjs`
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
let fail = 0;
const ok = (c, m) => { if (!c) { console.error('FAIL: ' + m); fail++; } else console.log('ok: ' + m); };
ok(/\.title-overlay\.title-fading\s*\{\s*opacity:\s*0/.test(html), 'fading class sets opacity 0');
ok(/\.title-overlay\s*\{\s*transition:\s*opacity 600ms/.test(html), '600ms opacity transition');
ok(/prefers-reduced-motion: reduce\)\s*\{\s*\.title-overlay\s*\{\s*transition:\s*none/.test(html), 'reduced motion drops transition');
ok(/HOLD_MS = 7000/.test(html), 'hold 7s');
ok(/L\.dismiss = function[^}]*start\(\)/.test(html), 'timer starts on loading-overlay dismiss');
ok(/style\.display = 'none'/.test(html.split('HOLD_MS')[1] || ''), 'card display:none after fade');
ok(/'pointerdown', 'wheel'/.test(html), 'early dismiss on pointerdown/wheel');
process.exit(fail ? 1 : 0);
