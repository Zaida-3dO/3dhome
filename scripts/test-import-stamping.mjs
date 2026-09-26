#!/usr/bin/env node
// ---------------------------------------------------------------------------
// test-import-stamping.mjs - every relative ES-module import in the SERVED
// tree must carry ?v=<version>.
//
// WHY. nginx caches src/ hard. If an entry module is versioned but its
// dependencies are imported by bare relative paths, a returning browser mixes
// a new entry with an old cached dependency and the app dies at link time
// ("does not provide an export named ..."). deploy/generate-config.sh stamps
// every relative import at container start; this proves it did.
//
// Two modes:
//
//   node scripts/test-import-stamping.mjs
//       Copies src/, specs/ and index.html into a temp dir, runs
//       deploy/generate-config.sh on it twice (two versions, to prove the
//       restamp replaces rather than appends), and scans the result.
//       Also asserts the UNSTAMPED source tree does have relative imports,
//       so the scan cannot pass vacuously.
//
//   node scripts/test-import-stamping.mjs --scan <webroot> <version>
//       Scans an already-stamped tree, e.g. one copied out of the built
//       Docker image. Used by the docker-dry-run CI job.
//
// The scanner is deliberately NOT the same regex as the stamper: it reads
// whole files, so an import split across lines (which the line-based sed
// cannot stamp) is reported here instead of slipping through.
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// `from '...'`, `import '...'`, `import('...')`, across any whitespace
// including newlines. Captures the specifier.
const IMPORT_RE = /(?:\bfrom|\bimport)\s*\(?\s*(['"`])([^'"`]*)\1/g;

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'vendor' || e.name.startsWith('.')) continue;
      walk(p, out);
    } else if (/\.(m?js|jsx|html)$/.test(e.name)) {
      out.push(p);
    }
  }
  return out;
}

/** Every relative import in `root` whose specifier lacks ?v=<version>. */
export function scan(root, version) {
  const files = [
    ...walk(path.join(root, 'src')),
    ...walk(path.join(root, 'specs')),
    path.join(root, 'index.html'),
  ].filter(f => fs.existsSync(f));
  const bad = [];
  let relative = 0;
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    for (const m of text.matchAll(IMPORT_RE)) {
      const spec = m[2];
      if (!spec.startsWith('./') && !spec.startsWith('../')) continue;
      relative++;
      const q = spec.indexOf('?');
      const v = q < 0 ? null : new URLSearchParams(spec.slice(q + 1)).get('v');
      if (version === null ? v === null : v !== version) {
        const line = text.slice(0, m.index).split('\n').length;
        bad.push(`${path.relative(root, f)}:${line}  ${spec}`);
      }
    }
  }
  return { files: files.length, relative, bad };
}

let failures = 0;
function check(cond, msg) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!cond) failures++;
}

function report(label, r, version) {
  check(r.relative > 0, `${label}: found ${r.relative} relative import(s) in ${r.files} file(s)`);
  check(r.bad.length === 0, `${label}: every relative import carries ?v=${version}`);
  for (const b of r.bad.slice(0, 50)) console.log('        ' + b);
}

const args = process.argv.slice(2);
if (args[0] === '--scan') {
  const [, root, version] = args;
  if (!root || !version) {
    console.error('usage: test-import-stamping.mjs --scan <webroot> <version>');
    process.exit(2);
  }
  report(root, scan(path.resolve(root), version), version);
} else {
  // Non-vacuity: the source tree has unstamped relative imports to stamp.
  const src = scan(REPO, null);
  check(src.relative > 20, `source tree has ${src.relative} relative imports (expected > 20)`);
  check(src.bad.length > 0, `source tree has ${src.bad.length} unversioned relative import(s) for the stamper to fix`);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'home3d-stamp-'));
  try {
    for (const p of ['src', 'specs', 'index.html']) {
      fs.cpSync(path.join(REPO, p), path.join(tmp, p), { recursive: true });
    }
    const run = version => execFileSync('sh', [path.join(REPO, 'deploy', 'generate-config.sh'), tmp], {
      env: { ...process.env, APP_VERSION: version, HOME3D_WEB_ROOT: tmp },
      stdio: ['ignore', 'ignore', 'inherit'],
    });

    run('t1.0.0');
    report('after first stamp', scan(tmp, 't1.0.0'), 't1.0.0');

    run('t2.0.0');
    const second = scan(tmp, 't2.0.0');
    report('after restamp with a new version', second, 't2.0.0');
    const doubled = walk(tmp).concat(path.join(tmp, 'index.html'))
      .flatMap(f => fs.readFileSync(f, 'utf8').match(/['"][^'"\s]*\?v=[^'"\s]*\?v=[^'"\s]*['"]/g) || []);
    check(doubled.length === 0, 'no specifier carries two ?v= queries after a restamp');
    for (const d of doubled.slice(0, 10)) console.log('        ' + d);

    // Bare and computed specifiers are left alone.
    const scene = fs.readFileSync(path.join(tmp, 'src', 'home3d-scene.js'), 'utf8');
    check(/from\s*'three'/.test(scene), "bare 'three' specifier is untouched");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);
