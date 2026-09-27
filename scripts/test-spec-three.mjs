#!/usr/bin/env node
/**
 * specs/spec-three.jsx -- the shared ThreeView every spec page renders with.
 * No framework, no install: `node scripts/test-spec-three.mjs`.
 *
 * What this checks:
 *   1. The iso camera distance (specIsoDistance, extracted from the
 *      SPEC-ISO-DISTANCE block and run here) fits a whole sphere of the item's
 *      radius in view, at a phone's portrait canvas as well as on a desktop.
 *      The fit is checked by projecting points of the sphere through an
 *      independent perspective projection, not by re-deriving the formula.
 *      At 390 px the canvas is taller than wide, so the horizontal field of
 *      view is the tight one; a distance that ignored the aspect cropped the
 *      bed on a phone.
 *   2. ThreeView actually uses it: the iso preset and the first build frame
 *      the item from the canvas's own width / height.
 *   3. The key light carries a shadow bias and normalBias (shadow acne: faint
 *      diagonal bands on flat faces that both cast and receive).
 *   4. The mirror env-cube capture swaps the dark page background for a
 *      neutral room colour for the capture only, and puts it back.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = fs.readFileSync(path.join(root, 'specs/spec-three.jsx'), 'utf8');

let passes = 0, failures = 0;
function check(name, ok, detail) {
  if (ok) { passes++; return; }
  failures++;
  console.log('FAIL: ' + name + (detail !== undefined ? '\n      ' + JSON.stringify(detail) : ''));
}

// ------------------------------------------------------------ 1. iso fit
const block = (src.match(/\/\* SPEC-ISO-DISTANCE-BEGIN[\s\S]*?\*\/([\s\S]*?)\/\* SPEC-ISO-DISTANCE-END \*\//) || [])[1];
check('SPEC-ISO-DISTANCE block found in spec-three.jsx', !!block);
const ctx = vm.createContext({ Math, Infinity });
vm.runInContext((block || '') + '\n;this.specIsoDistance = typeof specIsoDistance === "function" ? specIsoDistance : null;', ctx);
const iso = ctx.specIsoDistance;
check('specIsoDistance is a function', typeof iso === 'function');

// Largest |NDC| any point of a sphere of radius R (centred on the look
// target) reaches, seen from distance d along -z with a vertical fov and
// aspect. <= 1 means the whole sphere is inside the frame.
function maxNdc(d, R, fovDeg, aspect) {
  const t = Math.tan(fovDeg * Math.PI / 360);
  let worst = 0;
  const N = 90;
  for (let i = 0; i <= N; i++) {
    const phi = Math.PI * i / N;
    for (let j = 0; j < 2 * N; j++) {
      const th = Math.PI * j / N;
      const x = R * Math.sin(phi) * Math.cos(th);
      const y = R * Math.sin(phi) * Math.sin(th);
      const z = d - R * Math.cos(phi);          // depth in front of the camera
      if (z <= 0) return Infinity;
      worst = Math.max(worst, Math.abs(x / (z * t * aspect)), Math.abs(y / (z * t)));
    }
  }
  return worst;
}

const FOV = 35; // ThreeView's PerspectiveCamera
const cases = [
  { label: 'phone canvas 390x420 (portrait)', aspect: 390 / 420 },
  { label: 'phone canvas 309x420 (390 px page, card padding)', aspect: 309 / 420 },
  { label: 'desktop canvas 1335x560', aspect: 1335 / 560 },
];
if (typeof iso === 'function') {
  for (const c of cases) {
    for (const R of [0.4, 1.5, 3]) {
      const d = iso(c.aspect, R, FOV, 0, Infinity);
      const ndc = maxNdc(d, R, FOV, c.aspect);
      check(`${c.label}, radius ${R} m: whole sphere in frame`, ndc <= 1 + 1e-6, { d, ndc });
      // and not absurdly far: the sphere's projected edge reaches well into
      // the frame (a sphere fit leaves some margin, but not half the view).
      check(`${c.label}, radius ${R} m: fit is tight`, ndc > 0.8, { d, ndc });
    }
  }
  // the clamps the harness passes: never closer than the old 3.8 m, never
  // past the orbit's 10 m zoom limit
  check('min distance holds for a small item', iso(390 / 420, 0.2, FOV, 3.8, 10) === 3.8);
  check('max distance holds for a huge item', iso(390 / 420, 20, FOV, 3.8, 10) === 10);
  check('portrait needs more distance than landscape for the same item',
    iso(390 / 420, 1.5, FOV, 0, Infinity) > iso(1335 / 560, 1.5, FOV, 0, Infinity));
}

// ------------------------------------------------------------ 2. wiring
const isoFn = (src.match(/function isoDistance\(\) \{([\s\S]*?)\n    \}/) || [])[1] || '';
check('isoDistance() passes the canvas aspect (W / H) and the camera fov',
  /specIsoDistance\(\s*W\s*\/\s*H\s*,\s*r\s*,\s*cam\.fov\s*,\s*3\.8\s*,\s*10\s*\)/.test(isoFn), isoFn.trim().slice(0, 200));
check('isoDistance() reads the canvas size', /canvas\.clientWidth/.test(isoFn) && /canvas\.clientHeight/.test(isoFn));
check('iso preset takes its distance from isoDistance()',
  /iso:\s*\{[^}]*r:\s*null/.test(src) && /orb\.r\s*=\s*v\.r\s*\?\?\s*isoDistance\(\)/.test(src));
check('first build frames the item with isoDistance()',
  /if \(!s\._framed\) \{[\s\S]*?s\.orb\.r = s\.isoDistance\(\);[\s\S]*?s\.syncCam\(\);/.test(src));

// ------------------------------------------------------------ 3. shadow bias
const num = re => { const m = src.match(re); return m ? Number(m[1]) : NaN; };
const bias = num(/\bkey\.shadow\.bias\s*=\s*(-?[\d.]+)\s*;/);
const normalBias = num(/\bkey\.shadow\.normalBias\s*=\s*(-?[\d.]+)\s*;/);
check('key light shadow.bias is set, small and negative', bias < 0 && bias >= -0.005, bias);
check('key light shadow.normalBias is set, small and positive', normalBias > 0 && normalBias <= 0.1, normalBias);
// ...and the light they are set on is the shadow-casting key light
check('the biased light is the shadow-casting key light',
  /const key = new THREE\.DirectionalLight[\s\S]*?key\.castShadow = true/.test(src));

// ------------------------------------------------------------ 4. env capture background
const cap = (src.match(/\/\/ \(C\) env cube capture[\s\S]*?renderer\.render\(scene, cam\);/) || [])[0] || '';
check('env capture block found', !!cap);
const iSave = cap.indexOf('const prevBackground = scene.background;');
const iSet = cap.indexOf('scene.background = envCaptureBackground;');
const iUpdate = cap.indexOf('cubeCam.update(renderer, scene);');
const iRestore = cap.indexOf('scene.background = prevBackground;');
check('capture saves, sets, captures, then restores the background (in that order)',
  iSave >= 0 && iSave < iSet && iSet < iUpdate && iUpdate < iRestore, { iSave, iSet, iUpdate, iRestore });
check('only one cube capture in the block (the one wrapped by set/restore)',
  cap.split('cubeCam.update(').length === 2);
const bg = (src.match(/const envCaptureBackground = new THREE\.Color\(0x([0-9a-fA-F]{6})\)/) || [])[1];
check('envCaptureBackground is a declared colour', !!bg);
if (bg) {
  const [r, g, b] = [0, 2, 4].map(i => parseInt(bg.slice(i, i + 2), 16));
  // the page background it replaces is 0x1a1a1c (26,26,28); a room grey is
  // clearly lighter and roughly neutral
  check('envCaptureBackground is a lit room grey, not the dark page background',
    Math.min(r, g, b) >= 0x50 && Math.max(r, g, b) - Math.min(r, g, b) <= 24, bg);
}

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
