// Structured scene-graph diff between the two digests a probe run captured.
// Groups objects into comparable buckets and reports where the two builds
// disagree, so a difference is named rather than merely visible.
import fs from 'fs';
import path from 'path';

const OUT = process.env.H3D_OUT || path.join(process.cwd(), '.compare-out');
const TAG = process.env.H3D_TAG || 'run';
const d = JSON.parse(fs.readFileSync(path.join(OUT, TAG, 'digest.json'), 'utf8'));
// The two sides are keyed reference/subject. Earlier captures used
// original/new, so accept those too rather than failing on an old digest.
const _ref = d.reference || d.original;
const _sub = d.subject || d.new;
if (!_ref || !_sub) {
  console.error('digest.json has neither reference/subject nor original/new. Keys: ' + Object.keys(d).join(', '));
  process.exit(2);
}
const O = _ref.digest, N = _sub.digest;

const line = (label, a, b) => {
  const same = JSON.stringify(a) === JSON.stringify(b);
  console.log(
    '  ' + label.padEnd(30) +
    String(JSON.stringify(a)).padEnd(30) +
    String(JSON.stringify(b)).padEnd(30) +
    (same ? 'MATCH' : 'DIFFER')
  );
  return same;
};

let checks = 0, matches = 0;
const chk = (l, a, b) => { checks++; if (line(l, a, b)) matches++; };

console.log('\n=== RENDERER ===');
console.log('  ' + 'property'.padEnd(30) + 'reference'.padEnd(30) + 'subject'.padEnd(30) + 'verdict');
for (const k of Object.keys(O.renderer)) chk(k, O.renderer[k], N.renderer[k]);

console.log('\n=== SCENE / SKY ===');
for (const k of Object.keys(O.scene)) chk(k, O.scene[k], N.scene[k]);
chk('three revision', O.three, N.three);

console.log('\n=== CAMERA (intrinsics) ===');
for (const k of ['type', 'fov', 'near', 'far', 'zoom']) chk(k, O.camera[k], N.camera[k]);

console.log('\n=== OBJECT COUNTS BY TYPE ===');
for (const k of Object.keys({ ...O.counts, ...N.counts })) chk(k, O.counts[k] || 0, N.counts[k] || 0);

// Lights, keyed by what they are rather than by array order.
const lkey = l => [l.type, l.color, l.intensity, l.distance, l.decay, l.castShadow,
  (l.position || []).map(v => Math.round(v * 100) / 100).join(',')].join('|');
const lc = arr => { const m = {}; arr.forEach(l => { m[lkey(l)] = (m[lkey(l)] || 0) + 1; }); return m; };
const LO = lc(O.lights), LN = lc(N.lights);
const lonlyO = Object.keys(LO).filter(k => !LN[k]).length;
const lonlyN = Object.keys(LN).filter(k => !LO[k]).length;
console.log('\n=== LIGHTS ===');
chk('total', O.lights.length, N.lights.length);
chk('distinct signatures only in one', 0, lonlyO + lonlyN);
if (lonlyO + lonlyN) {
  Object.keys(LO).filter(k => !LN[k]).forEach(k => console.log('    only reference: ' + k));
  Object.keys(LN).filter(k => !LO[k]).forEach(k => console.log('    only subject:   ' + k));
}

// Sun + ambient, compared field by field (these set the whole mood).
const pick = (arr, t) => arr.find(l => l.type === t);
console.log('\n=== SUN / AMBIENT (full) ===');
for (const t of ['DirectionalLight', 'AmbientLight']) {
  const a = pick(O.lights, t), b = pick(N.lights, t);
  for (const k of ['color', 'intensity', 'position', 'castShadow', 'shadow']) chk(t + '.' + k, a && a[k], b && b[k]);
}

// Meshes bucketed by geometry+material signature — the shape of the model.
const msig = x => {
  let m = x.mat || {};
  if (Array.isArray(m)) m = m[0] || {};
  return [x.type, x.geo, m.type, m.color, m.roughness, m.metalness, m.transparent, m.opacity, m.side].join('|');
};
const mc = arr => { const m = {}; arr.forEach(x => { m[msig(x)] = (m[msig(x)] || 0) + 1; }); return m; };
const MO = mc(O.objects), MN = mc(N.objects);
console.log('\n=== MESH BUCKETS (geometry + material) ===');
console.log('  ' + 'type|geo|mat|color|rough|metal|transp|op|side'.padEnd(74) + 'ref  subj');
let bucketDiffs = 0;
for (const k of Object.keys({ ...MO, ...MN }).sort()) {
  const a = MO[k] || 0, b = MN[k] || 0;
  if (a !== b) { bucketDiffs++; console.log('  ' + k.padEnd(74) + String(a).padStart(4) + String(b).padStart(6) + '   DIFFER'); }
}
console.log('  buckets differing: ' + bucketDiffs + ' of ' + Object.keys({ ...MO, ...MN }).length);

// Textures: every mapped mesh, by image and sampler state.
const tex = arr => {
  const out = [];
  arr.forEach(x => {
    const ms = Array.isArray(x.mat) ? x.mat : [x.mat];
    ms.forEach(m => {
      if (m && m.map && m.map.src && !/^2Q==|^data:/.test(m.map.src)) {
        out.push([m.map.src, m.map.wrapS, m.map.wrapT,
          (m.map.repeat || []).map(v => Math.round(v * 1e4) / 1e4).join(','),
          (m.map.offset || []).map(v => Math.round(v * 1e4) / 1e4).join(','),
          m.map.flipY, m.map.colorSpace,
          (x.pos || []).map(v => Math.round(v * 100) / 100).join(',')].join('|'));
      }
    });
  });
  return out.sort();
};
const TO = tex(O.objects), TN = tex(N.objects);
console.log('\n=== TEXTURED SURFACES (image + sampler + position) ===');
chk('count', TO.length, TN.length);
const onlyO = TO.filter(t => !TN.includes(t));
const onlyN = TN.filter(t => !TO.includes(t));
chk('entries only in one build', 0, onlyO.length + onlyN.length);
onlyO.forEach(t => console.log('    only reference: ' + t));
onlyN.forEach(t => console.log('    only subject:   ' + t));

console.log('\n=== SUMMARY ===');
console.log('  checks: ' + checks + '  matching: ' + matches + '  differing: ' + (checks - matches));
