#!/usr/bin/env node
/**
 * WebGL-failure classification tests. No framework, no dependencies -
 * `node scripts/test-webgl-reason.mjs`.
 *
 * WHAT THIS GUARDS, and why it is worth a file of its own.
 *
 * When a WebGL context cannot be created there are two genuinely different
 * causes, and the advice for one is useless for the other:
 *
 *   - the browser ran out of graphics memory (usually a pile of open tabs,
 *     each holding contexts) -> closing tabs fixes it within seconds;
 *   - there is no usable GPU at all (driver off, hardware acceleration
 *     disabled, software renderer refused) -> closing tabs does nothing.
 *
 * A real user hit the first case on Android Chrome with ~47 tabs open and was
 * shown the second case's wording, which sent him to read a console that
 * already held the answer. The regex asserted here is what tells the two apart.
 *
 * THE DANGEROUS DIRECTION IS THE FALSE POSITIVE. Telling someone with a
 * genuinely broken GPU to "close some tabs" is confident, actionable and
 * wrong - strictly worse than the general wording, because they will do it and
 * it will not help. So the non-matching cases below matter more than the
 * matching ones, and `Error creating WebGL context.` is the single most
 * important string in this file: it is what three.js ACTUALLY throws once it
 * has dropped the reason, so it reaches the matcher as a fallback on every
 * failure of either kind. If it ever starts matching, every broken-GPU user is
 * told to close tabs.
 *
 * The matcher is read out of src/home3d-scene.js as text rather than imported,
 * because it lives inside a large browser-only module that touches `window`,
 * `document` and THREE at import time. Extracting the one literal keeps this
 * test dependency-free - and the extraction is ASSERTED, because a regex that
 * silently failed to match the source would leave this file testing nothing
 * while still printing PASS.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = fs.readFileSync(path.join(root, 'src/home3d-scene.js'), 'utf8');

// Pull the literal out of `const outOfMemory = /.../i.test(reasonText);`.
// Anchored on the variable name so it cannot accidentally match some other
// regex elsewhere in a 3000-line file.
const RE_SRC = /const\s+outOfMemory\s*=\s*\n?\s*(\/.+?\/)([a-z]*)\s*\n?\s*\.test\(/;
const m = src.match(RE_SRC);

let passed = 0;
let failed = 0;

function check(name, cond) {
  if (cond) { passed++; console.log(`PASS ${name}`); }
  else { failed++; console.error(`FAIL ${name}`); }
}

// --- The extraction itself is a test -------------------------------------
// Without this, a refactor that renamed the variable would make every case
// below vacuous: no matcher, nothing exercised, still green.
if (!m) {
  console.error(
    'FAIL could not extract the outOfMemory matcher from src/home3d-scene.js.\n' +
    '     This test cannot run, and a silent skip here would leave the ' +
    'false-positive guard unprotected.\n' +
    '     If the matcher moved or was renamed, update RE_SRC in this file.'
  );
  process.exit(1);
}
check('extracted the outOfMemory matcher from source', true);

const matcher = new RegExp(m[1].slice(1, -1), m[2]);

// --- Exhaustion: these MUST match ----------------------------------------
// Real strings browsers emit when they are out of graphics memory.
const EXHAUSTION = [
  // Chrome, and the exact string from the field report that prompted this work.
  'Web page caused context loss and was blocked',
  'Too many active WebGL contexts. Oldest context will be lost.',
  'Out of memory',
  'GPU memory exhausted',
];

for (const s of EXHAUSTION) {
  check(`exhaustion matches: ${JSON.stringify(s)}`, matcher.test(s));
}

// --- Not exhaustion: these MUST NOT match --------------------------------
// The consequential half. Each of these means "no usable GPU", where the
// tabs advice is wrong.
const NOT_EXHAUSTION = [
  // THE CRITICAL ONE. three.js drops the reason and throws this, so it reaches
  // the matcher via the `cause.message` fallback on EVERY failure of either
  // kind. If this matches, every broken-GPU user is told to close tabs.
  'Error creating WebGL context.',
  'WebGL is not supported',
  'WebGL unsupported in this browser',
  'Disallowed by enterprise policy',
  'GPU access is disabled',
  'Hardware acceleration is unavailable',
  'SwiftShader is not allowed',
  'The operation is insecure.',
  '',
];

for (const s of NOT_EXHAUSTION) {
  check(`not exhaustion: ${JSON.stringify(s)}`, !matcher.test(s));
}

// --- A bare "contexts" must not be enough --------------------------------
// Asserted because the source comment says a bare `contexts` alternative was
// deliberately rejected, and a comment is not a guard. This pins that decision
// so a later "simplification" of the regex fails here rather than in front of
// a user.
check(
  'a bare mention of contexts does not match',
  !matcher.test('This page has 3 WebGL contexts')
);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
