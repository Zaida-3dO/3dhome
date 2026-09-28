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
 *   3. The time-of-day control: four presets (default noon, ?sun= pins one),
 *      each relighting the view through the shared rig. The lighting itself
 *      is scripts/test-render-rig.mjs (item 7938c4e3 replaced the old key
 *      light, its shadow bias and the mirror env capture with the house rig).
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

// ------------------------------------------------------------ 3. time of day
// (The lighting itself -- that it is the house's rig and nothing else -- is
// scripts/test-render-rig.mjs. This is the control.)
check('the four presets, in order, default noon',
  /const SPEC_SUN_PRESETS = \['morning', 'noon', 'evening', 'night'\];/.test(src) &&
  /return 'noon';\s*\n\}/.test(src));
check('a page may open on another preset (initialSun), still validated, ?sun= first',
  /if \(SPEC_SUN_PRESETS\.indexOf\(pageDefault\) !== -1\) return pageDefault;/.test(src) &&
  /React\.useState\(\(\) => specInitialSun\(initialSun\)\)/.test(src) &&
  src.indexOf("get('sun')") < src.indexOf('return pageDefault;'));
check('?sun=<preset> pins the opening preset (validated against the list)',
  /get\('sun'\)[\s\S]{0,80}SPEC_SUN_PRESETS\.indexOf\(q\) !== -1\) return q;/.test(src));
check('a button per preset drives setSunPreset, the active one marked',
  /SPEC_SUN_PRESETS\.map\(id =>[\s\S]*?onClick=\{\(\) => setSunPreset\(id\)\}/.test(src) && /id === sunPreset \? ' active' : ''/.test(src));
check('a preset change relights the view (sun, room light, background, shadow fit)',
  /React\.useEffect\(\(\) => \{[\s\S]*?s\.setSunPresetNow\(sunPreset\);[\s\S]*?\}, \[sunPreset\]\);/.test(src) &&
  /function setSunPresetNow\(preset\) \{[\s\S]*?relight\(\);/.test(src));
check('night switches the generic room light on, day off', /const night = lit\.preset === 'night';[\s\S]*?l\.visible = night;/.test(src));
check('every rebuild re-applies the house finishes and relights', /s\.applyFinishes\(\);[\s\S]*?s\.relight\(\);/.test(src));
check('the render-rig import is not a literal import() (Babel turns that into require)',
  /new Function\('u', 'return import\(u\);'\)/.test(src) &&
  !/(^|[^'"\w.])import\(/m.test(src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '').replace(/new Function\('u', 'return import\(u\);'\)/, '')));

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
