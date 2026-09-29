#!/usr/bin/env node
/**
 * scripts/check-no-pii.sh, Check 2 (Home Assistant entity ids): every domain
 * a house profile can bind is guarded. No framework, no install --
 * `node scripts/test-check-no-pii.mjs` (needs `sh` and `git` on PATH).
 *
 * WHAT THIS GUARDS
 *
 *   1. The repo as committed passes the guard.
 *   2. A real-looking id planted in source code is caught for EVERY guarded
 *      domain -- script, vacuum and media_player (bound since rooms.json
 *      1.7 / 1.4 / 1.6) as much as light or sensor -- and each planted id is
 *      named in the report.
 *   3. houses/demo/rooms.json keeps its rule: a demo_ id passes, a
 *      real-looking script id there fails.
 *
 * It runs the REAL script against a scratch copy of the tracked files, so
 * nothing in the working tree is touched. The planted ids are assembled at
 * run time: written literally in this file, they would trip the guard on
 * the repo itself.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0, passes = 0;
function check(name, cond, detail) {
  if (cond) { passes++; return; }
  failures++;
  console.error('FAIL ' + name + (detail !== undefined ? ' -- ' + JSON.stringify(detail) : ''));
}

// Domains the guard must cover. The first eight are what rooms.json binds
// today; the rest are the likely next ones (see ENTITY_DOMAINS in the script).
const DOMAINS = ['light', 'switch', 'sensor', 'binary_sensor', 'cover', 'climate', 'script', 'vacuum', 'media_player',
  'scene', 'automation', 'input_boolean', 'input_number', 'input_select', 'camera', 'fan', 'lock',
  'alarm_control_panel', 'device_tracker', 'humidifier', 'remote', 'valve'];
const q = (dom, obj) => '"' + dom + '.' + obj + '"';

const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root }).toString().split('\0').filter(Boolean);
function copyTree() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pii-guard-'));
  for (const rel of tracked) {
    const from = path.join(root, rel);
    if (!fs.existsSync(from)) continue;
    const to = path.join(dir, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  }
  // The guard fails closed outside a git checkout (its PLAN.md check needs
  // git), so the copy is one -- with nothing committed, which is all it asks.
  execFileSync('git', ['init', '-q'], { cwd: dir });
  return dir;
}
function guard(dir) {
  const r = spawnSync('sh', ['scripts/check-no-pii.sh'], { cwd: dir, encoding: 'utf8' });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

const dir = copyTree();
try {
  const clean = guard(dir);
  check('the tracked tree passes the guard', clean.code === 0 && /RESULT: PASS/.test(clean.out), clean.out.slice(-600));

  // One real-looking id per domain, as data in source code.
  const planted = path.join(dir, 'src', 'planted-binding.js');
  fs.writeFileSync(planted, DOMAINS.map(d => 'export const ' + d.toUpperCase() + ' = ' + q(d, 'kitchen_main_unit') + ';').join('\n') + '\n');
  const dirty = guard(dir);
  check('planted ids fail the guard', dirty.code !== 0 && /FAIL .*entity ids are demo-only/.test(dirty.out), dirty.out.slice(-400));
  for (const d of DOMAINS) {
    check('caught: ' + d + '.*', dirty.out.includes('(' + d + '.kitchen_main_unit)'), d);
  }
  fs.rmSync(planted);

  // houses/demo/rooms.json: demo_ passes, a real-looking script id fails.
  const demoPath = path.join(dir, 'houses', 'demo', 'rooms.json');
  const demo = fs.readFileSync(demoPath, 'utf8');
  const withDemoId = demo.replace('{', '{\n  "_planted": ' + q('script', 'demo_planted_off') + ',');
  fs.writeFileSync(demoPath, withDemoId);
  const ok = guard(dir);
  check('demo rooms.json: a demo_ script id passes', ok.code === 0, ok.out.slice(-400));
  fs.writeFileSync(demoPath, demo.replace('{', '{\n  "_planted": ' + q('script', 'living_room_off') + ','));
  const bad = guard(dir);
  check('demo rooms.json: a real-looking script id fails', bad.code !== 0 && bad.out.includes('(script.living_room_off)') &&
    /demo config must use a demo_ prefix/.test(bad.out), bad.out.slice(-400));
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`${failures ? 'FAILED' : 'ok'} -- ${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
