#!/usr/bin/env node
/**
 * specs/spec-three.jsx -- the shared ThreeView every spec page renders with.
 * No framework, no install: `node scripts/test-spec-three.mjs`.
 *
 * What this checks:
 *   1. The iso camera distance (specIsoDistance, extracted from the
 *      SPEC-ISO-DISTANCE block and run here) puts every corner of the item's
 *      box inside the frame on a phone's portrait canvas. The fit is checked
 *      through an independent lookAt camera and perspective projection, not
 *      by re-deriving the formula. At 390 px the canvas is taller than wide,
 *      so the horizontal field of view is the tight one; the fixed 3.8 m
 *      cropped the bed on a phone. And it changes nothing else: any landscape
 *      (desktop) canvas gets exactly the old 3.8 m, even for an item that is
 *      cropped there, and a portrait item whose width already fits stays at
 *      3.8 m too.
 *   2. ThreeView actually uses it: the iso preset and the first build frame
 *      the item from the canvas's own width / height and the orbit angles.
 *   3. The key light carries a shadow bias and normalBias (shadow acne: faint
 *      diagonal bands on flat faces that both cast and receive).
 *   4. Mirrors get their own env cube captured against a neutral room grey
 *      (not the dark page background), assigned as envMap to isMirror meshes
 *      ONLY -- scene.environment, which lights every other material, keeps
 *      the ordinary capture, so nothing else on the page changes brightness.
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

// An independent camera: position = target + d * (sin ph sin th, cos ph,
// sin ph cos th) exactly as ThreeView's syncCam places it, then a textbook
// lookAt basis and perspective divide. Returns the largest |NDC x| and
// |NDC y| any point reaches (<= 1 means in frame on that axis).
function maxNdc(points, d, th, ph, fovDeg, aspect) {
  const cam = [d * Math.sin(ph) * Math.sin(th), d * Math.cos(ph), d * Math.sin(ph) * Math.cos(th)];
  const norm = v => { const l = Math.hypot(...v); return v.map(c => c / l); };
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const fwd = norm(cam.map(c => -c));                 // camera looks at the origin (target)
  const right = norm(cross(fwd, [0, 1, 0]));
  const up = cross(right, fwd);
  const t = Math.tan(fovDeg * Math.PI / 360);
  let x = 0, y = 0;
  for (const p of points) {
    const rel = [p[0] - cam[0], p[1] - cam[1], p[2] - cam[2]];
    const z = dot(rel, fwd);
    if (z <= 0) return { x: Infinity, y: Infinity };
    x = Math.max(x, Math.abs(dot(rel, right) / (z * t * aspect)));
    y = Math.max(y, Math.abs(dot(rel, up) / (z * t)));
  }
  return { x, y };
}
// the 8 corners of a box w x h x d (m), relative to a look target at its
// centre (ThreeView's iso target is half the item's height)
const boxCorners = (w, h, dd) => {
  const pts = [];
  for (let i = 0; i < 8; i++) pts.push([(i & 1 ? 0.5 : -0.5) * w, (i & 2 ? 0.5 : -0.5) * h, (i & 4 ? 0.5 : -0.5) * dd]);
  return pts;
};

const FOV = 35, TH = 0.6, PH = 1.15, FILL = 0.92; // ThreeView's camera, iso angles, margin
const PHONE = 309 / 420, PHONE_WIDE = 390 / 420, DESK = 1335 / 560;
if (typeof iso === 'function') {
  const items = [
    { label: 'double bed 1.6 x 1.0 x 2.1 m', box: boxCorners(1.6, 1.0, 2.1) },
    { label: 'wardrobe 2.4 x 2.3 x 0.6 m', box: boxCorners(2.4, 2.3, 0.6) },
    { label: 'kitchen run 4 x 2.4 x 0.6 m', box: boxCorners(4, 2.4, 0.6) },
    { label: 'side table 0.4 x 0.5 x 0.4 m', box: boxCorners(0.4, 0.5, 0.4) },
  ];
  for (const aspect of [PHONE, PHONE_WIDE, 0.99]) {
    for (const it of items) {
      const d = iso(it.box, TH, PH, aspect, FOV, 0, Infinity, FILL);
      const ndc = maxNdc(it.box, d, TH, PH, FOV, aspect);
      check(`aspect ${aspect.toFixed(2)}, ${it.label}: every corner inside the width`, ndc.x <= FILL + 1e-6, { d, ndc });
      // tight: a box fit touches the margin exactly (a sphere fit would not)
      check(`aspect ${aspect.toFixed(2)}, ${it.label}: fit is tight`, ndc.x > FILL - 1e-3, { d, ndc });
      // a phone: the height is the roomy axis, so the width fit leaves the
      // item wholly in frame (3.8 m or further, as the harness clamps it).
      // (Near square it need not: height framing is left as it always was.)
      if (aspect > 0.95) continue;
      const dc = iso(it.box, TH, PH, aspect, FOV, 3.8, Infinity, FILL);
      check(`aspect ${aspect.toFixed(2)}, ${it.label}: portrait keeps the height in frame too`,
        maxNdc(it.box, dc, TH, PH, FOV, aspect).y <= 1, { dc, ndc: maxNdc(it.box, dc, TH, PH, FOV, aspect) });
    }
  }
  // Desktop framing is exactly as before: every landscape canvas gets the
  // old fixed 3.8 m -- including a wide item a width fit would push back
  // there (the kitchen run).
  for (const aspect of [1, 4 / 3, DESK]) {
    for (const it of items) {
      check(`landscape ${aspect.toFixed(2)}, ${it.label}: exactly the old 3.8 m`,
        iso(it.box, TH, PH, aspect, FOV, 3.8, 10, FILL) === 3.8, iso(it.box, TH, PH, aspect, FOV, 3.8, 10, FILL));
    }
  }
  check('(the kitchen run overflows the fit margin at 3.8 m on a desktop, so a fit there would move it)',
    maxNdc(items[2].box, 3.8, TH, PH, FOV, DESK).x > FILL, maxNdc(items[2].box, 3.8, TH, PH, FOV, DESK));
  // Portrait clamps: never closer than the old 3.8 m, never past the orbit's
  // 10 m limit; a small item whose width fits stays at exactly 3.8 m.
  const bed = items[0].box;
  check('phone: a side table fits at 3.8 m, so it stays at exactly 3.8 m',
    iso(items[3].box, TH, PH, PHONE, FOV, 3.8, 10, FILL) === 3.8);
  check('phone: the bed is cropped at 3.8 m, so the camera moves back',
    maxNdc(bed, 3.8, TH, PH, FOV, PHONE).x > 1 && iso(bed, TH, PH, PHONE, FOV, 3.8, 10, FILL) > 3.8,
    { ndcAt38: maxNdc(bed, 3.8, TH, PH, FOV, PHONE) });
  check('max distance holds for a huge item', iso(boxCorners(30, 5, 30), TH, PH, PHONE, FOV, 3.8, 10, FILL) === 10);
  const shifted = bed.map(([x, y, z]) => [x + 1, y, z]);
  check('an off-centre item is fitted too (not assumed symmetric about the target)',
    maxNdc(shifted, iso(shifted, TH, PH, PHONE, FOV, 0, Infinity, FILL), TH, PH, FOV, PHONE).x <= FILL + 1e-6);
}

// ------------------------------------------------------------ 2. wiring
const isoFn = (src.match(/function isoDistance\(\) \{([\s\S]*?)\n    \}/) || [])[1] || '';
check('isoDistance() passes the item corners, orbit angles, canvas aspect (W / H), fov and clamps',
  /specIsoDistance\(\s*pts\s*,\s*orb\.th\s*,\s*orb\.ph\s*,\s*W\s*\/\s*H\s*,\s*cam\.fov\s*,\s*3\.8\s*,\s*10\s*,\s*0\.9\d*\s*\)/.test(isoFn), isoFn.trim().slice(0, 300));
check('isoDistance() reads the canvas size', /canvas\.clientWidth/.test(isoFn) && /canvas\.clientHeight/.test(isoFn));
check('iso preset takes its distance from isoDistance()',
  /iso:\s*\{[^}]*r:\s*null/.test(src) && /orb\.r\s*=\s*v\.r\s*\?\?\s*isoDistance\(\)/.test(src));
check('first build frames the item with isoDistance()',
  /if \(!s\._framed\) \{[\s\S]*?s\.orb\.r = s\.isoDistance\(\);[\s\S]*?s\.syncCam\(\);/.test(src));

// ------------------------------------------------------------ 3. shadow bias
const num = re => { const m = src.match(re); return m ? Number(m[1]) : NaN; };
const bias = num(/\bkey\.shadow\.bias\s*=\s*(-?[\d.]+)\s*;/);
const normalBias = num(/\bkey\.shadow\.normalBias\s*=\s*(-?[\d.]+)\s*;/);
// The depth bias must stay ~0: on the key light's default 0.5-500 m shadow
// range, -0.0005 is ~25 cm and erased real contact shadows (visual review
// of PR #89). normalBias alone cures the acne.
check('key light shadow.bias is explicit and ~0 (never deep enough to erase contact shadows)',
  Number.isFinite(bias) && bias <= 0 && bias >= -0.00005, bias);
check('key light shadow.normalBias is set, small and positive', normalBias > 0 && normalBias <= 0.1, normalBias);
// ...and the light they are set on is the shadow-casting key light
check('the biased light is the shadow-casting key light',
  /const key = new THREE\.DirectionalLight[\s\S]*?key\.castShadow = true/.test(src));

// ------------------------------------------------------------ 4. mirror env cube
const cap = (src.match(/\/\/ \(C\) env cube capture[\s\S]*?renderer\.render\(scene, cam\);/) || [])[0] || '';
check('env capture block found', !!cap);
// The shared capture (scene.environment, lights EVERYTHING) must see the
// page's own background: nothing may swap it before cubeCam.update.
const iShared = cap.indexOf('cubeCam.update(renderer, scene);');
const iSet = cap.indexOf('scene.background = envCaptureBackground;');
const iMirror = cap.indexOf('mirrorCubeCam.update(renderer, scene);');
const iRestore = cap.indexOf('scene.background = prevBackground;');
check('shared capture first, then set grey, mirror capture, restore (in that order)',
  iShared >= 0 && iShared < iSet && iSet < iMirror && iMirror < iRestore, { iShared, iSet, iMirror, iRestore });
check('the grey background is set exactly once, in the mirror-only branch',
  cap.split('scene.background = envCaptureBackground').length === 2 &&
  /if \(mirrors\.length\) \{[\s\S]*?scene\.background = envCaptureBackground;[\s\S]*?mirrorCubeCam\.update/.test(cap));
check('mirror cube assigned as envMap to the mirror meshes only',
  /for \(const mesh of mirrors\)[\s\S]*?\.envMap = mirrorRT\.texture/.test(cap) && src.split('.envMap = mirrorRT.texture').length === 2);
check('scene.environment is the shared capture, never the mirror cube',
  /scene\.environment = cubeRT\.texture;/.test(src) && !/scene\.environment\s*=\s*mirrorRT/.test(src));
check('mirror cube captured from a CubeCamera on its own render target, and disposed',
  /const mirrorCubeCam = new THREE\.CubeCamera\([^)]*mirrorRT\)/.test(src) && /mirrorRT\.dispose\(\)/.test(src));
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
