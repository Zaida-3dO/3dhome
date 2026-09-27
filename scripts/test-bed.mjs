#!/usr/bin/env node
/**
 * bed.js: geometry decisions a contract-gate screenshot cannot pin.
 * No framework, no install: `node scripts/test-bed.mjs`.
 *
 * scripts/test-furniture-core.mjs already checks the generic builder
 * contract (bbox, finish tags, no-three, low<=full triangles) for every
 * registered type including `bed`. This file checks what makes THIS bed the
 * soft, made-up bed it is meant to be -- each check names the one-line
 * regression it exists to catch:
 *
 *   1. Headboard: channelCount padded channels INSIDE a padded border that
 *      runs up both sides and across the top; `height` honoured directly.
 *   2. Base: upholstered rails in the headboard velvet -- NOT a dark box --
 *      with their top at baseHeight, round the sides AND the foot.
 *   3. Mattress: rounded edges, a crowned top, its top at the bedside height,
 *      its lower edge hidden inside the rails.
 *   4. Duvet: covers the foot end of the mattress, drapes down the sides and
 *      the foot to the rail tops, folds back at its top edge, stays inside
 *      the envelope, and faces outward (it is one-sided).
 *   5. Pillows: 2 sleeping pillows, 2 accent pillows and a cushion, all at the
 *      headboard end; low detail keeps only the 2 sleeping pillows.
 *   6. Print: botanical at full detail, following the duvet surface and
 *      facing out; none for 'plain' or low detail; deterministic.
 *   7. Budget: within TRIANGLE_CAPS at full and low; low <= 0.6 x full.
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const imp = rel => import(pathToFileURL(path.join(root, rel)).href);
const THREE = await imp('vendor/three-r160/three.module.min.js');
const Bed = await imp('src/furniture/bed.js');

let failures = 0, passes = 0;
function check(name, cond, detail) {
  if (cond) { passes++; return; }
  failures++;
  console.error('FAIL ' + name + (detail !== undefined ? ' -- ' + JSON.stringify(detail) : ''));
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const byName = (g, name) => { const out = []; g.traverse(o => { if (o.isMesh && o.name === name) out.push(o); }); return out; };
const byPrefix = (g, pre) => { const out = []; g.traverse(o => { if (o.isMesh && o.name.startsWith(pre)) out.push(o); }); return out; };
const wbox = o => new THREE.Box3().setFromObject(o);
const tris = g => { let n = 0; g.traverse(o => { if (o.isMesh) n += (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3; }); return n; };
const cm = v => v * 100;
const D = Bed.DEFAULTS;
const build = (params, detail) => { const g = Bed.build(THREE, Object.assign({}, D, params || {}), { detail: detail || 'full' }); g.updateMatrixWorld(true); return g; };

/** World-space vertices of a mesh. */
function verts(mesh) {
  const p = mesh.geometry.attributes.position, out = [];
  for (let i = 0; i < p.count; i++) out.push(new THREE.Vector3().fromBufferAttribute(p, i).applyMatrix4(mesh.matrixWorld));
  return out;
}
/** World-space triangles of a mesh: [a, b, c, normal]. */
function triangles(mesh) {
  const p = mesh.geometry.attributes.position, idx = mesh.geometry.index, out = [];
  const n = idx ? idx.count / 3 : p.count / 3;
  const at = i => new THREE.Vector3().fromBufferAttribute(p, i).applyMatrix4(mesh.matrixWorld);
  for (let t = 0; t < n; t++) {
    const a = at(idx ? idx.getX(t * 3) : t * 3), b = at(idx ? idx.getX(t * 3 + 1) : t * 3 + 1), c = at(idx ? idx.getX(t * 3 + 2) : t * 3 + 2);
    const nr = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a));
    if (nr.lengthSq() > 1e-16) out.push([a, b, c, nr.normalize()]);
  }
  return out;
}
const lum = hex => { const c = new THREE.Color(hex); return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b; };

// ---- exports -------------------------------------------------------------------
check('exports TYPE "bed"', Bed.TYPE === 'bed');
check('DEFAULTS frozen with width/depth/height numeric',
  Object.isFrozen(D) && ['width', 'depth', 'height'].every(k => typeof D[k] === 'number'));
check('DEFAULTS: 8 channels, pale blue-grey velvet headboard', D.channelCount === 8 && D.headboardColor === '#9ba8b3');
check('DEFAULTS: bedding preset is the botanical print', D.beddingPreset === 'botanical');

const g = build();
const L = Bed.layout(Object.assign({}, D));

// ---- 1. headboard ----------------------------------------------------------------
{
  const border = byName(g, 'bed:headboard-border')[0];
  const channels = byName(g, 'bed:headboard-channel');
  check('headboard: exactly channelCount channels', channels.length === D.channelCount, channels.length);
  check('headboard: a padded border', !!border);
  if (border && channels.length) {
    const bb = wbox(border);
    check('border spans the full width', near(cm(bb.max.x - bb.min.x), D.width, 0.05), cm(bb.max.x - bb.min.x));
    check('border reaches the headboard top (height)', near(cm(bb.max.y), D.height, 0.05), cm(bb.max.y));
    check('border is ~10 thick (the headboard depth), back on z=0', near(bb.min.z, 0, 1e-4) && near(cm(bb.max.z), 10, 0.05));
    // Border runs DOWN both sides: at each edge it has geometry both near the
    // floor and at the top (a top-only border would have no low vertices).
    const vs = verts(border);
    const edge = sx => vs.filter(v => sx * v.x > D.width / 200 - 0.08);
    for (const [sx, side] of [[-1, 'left'], [1, 'right']]) {
      const e = edge(sx);
      check('border runs down the ' + side + ' side (floor to top)',
        e.some(v => v.y < 0.1) && e.some(v => v.y > D.height / 100 - 0.1), e.length);
    }
    // Channels sit strictly INSIDE the border, evenly pitched, under its top.
    const xs = channels.map(c => { const b = wbox(c); return [b.min.x, b.max.x, (b.min.x + b.max.x) / 2]; }).sort((a, b) => a[2] - b[2]);
    const bw = 7.5 / 100;
    check('channels sit inside the border (none under the side rolls)',
      xs[0][0] >= bb.min.x + bw - 1e-4 && xs[xs.length - 1][1] <= bb.max.x - bw + 1e-4, [xs[0][0], bb.min.x + bw]);
    const pitches = xs.slice(1).map((x, i) => x[2] - xs[i][2]);
    check('channels evenly pitched', Math.max(...pitches) - Math.min(...pitches) < 1e-4, pitches);
    check('channels fill the inner width edge to edge', near(xs[0][0] - (bb.min.x + bw), 0, 1e-3));
    check('channel tops tuck under the border top', channels.every(c => wbox(c).max.y <= bb.max.y - bw + 0.02));
    check('channels are tall and narrow (vertical channels)', channels.every(c => { const b = wbox(c); return (b.max.y - b.min.y) > 3 * (b.max.x - b.min.x); }));
    const backing = byName(g, 'bed:headboard-backing')[0];
    check('channels stand proud of the backing by ~channelDepth', channels.every(c => near(cm(wbox(c).max.z - wbox(backing).max.z), D.channelDepth, 0.1)));
  }
  // `height` is honoured directly; a custom height and channel count too.
  const bx = wbox(g);
  check('overall height == height (the headboard is the tallest part)', near(cm(bx.max.y - bx.min.y), D.height, 0.05), cm(bx.max.y - bx.min.y));
  const g2 = build({ height: 140, channelCount: 6, width: 137, depth: 190 });
  const b2 = wbox(g2);
  check('a custom size 137 x 190, height 140 builds to its own bbox',
    near(cm(b2.max.x - b2.min.x), 137, 0.05) && near(cm(b2.max.z - b2.min.z), 190, 0.05) && near(cm(b2.max.y - b2.min.y), 140, 0.05),
    [cm(b2.max.x - b2.min.x), cm(b2.max.z - b2.min.z), cm(b2.max.y - b2.min.y)]);
  check('channelCount override is honoured', byName(g2, 'bed:headboard-channel').length === 6);
  check('back stays at z=0, bottom at y=0, x centred', near(bx.min.z, 0, 1e-4) && near(bx.min.y, 0, 1e-4) && near(bx.min.x + bx.max.x, 0, 1e-4));
}

// ---- 2. base: velvet rails, not a dark box -----------------------------------------
{
  const rails = byName(g, 'bed:rail');
  check('base: one upholstered rail run', rails.length === 1, rails.length);
  const rail = rails[0];
  if (rail) {
    check('base: rails are the SAME velvet as the headboard by default', rail.material.color.getHex() === new THREE.Color(D.headboardColor).getHex());
    check('base: rails are not dark (the old #3a3a3d box read as a black slab)', lum('#' + rail.material.color.getHexString()) > 0.3);
    const rb = wbox(rail);
    check('base: rail top at baseHeight', near(cm(rb.max.y), D.baseHeight, 0.05), cm(rb.max.y));
    check('base: rails float on a plinth (bottom ~3.5 off the floor)', near(cm(rb.min.y), 3.5, 0.05), cm(rb.min.y));
    check('base: rails run the full width and to the foot', near(cm(rb.max.x - rb.min.x), D.width, 0.05) && near(cm(rb.max.z), D.depth, 0.05));
    // the rail run goes round the FOOT: geometry at the foot centre
    const foot = verts(rail).filter(v => v.z > D.depth / 100 - 0.07);
    check('base: a foot rail across the foot', foot.some(v => v.x < -0.6) && foot.some(v => v.x > 0.6));
    // rounded top: the topmost vertices are only along the rail centreline, not its edges
    const top = verts(rail).filter(v => cm(v.y) > D.baseHeight - 0.2 && v.z < 0.15 && v.x < 0);
    check('base: the rail top is rounded (only its centreline reaches the top)', top.length > 0 && top.every(v => Math.abs(cm(v.x) - (-D.width / 2 + 3)) < 0.5), top.map(v => cm(v.x)));
    // faces outward (away from the rail's centreline)
    const out = triangles(rail).filter(([a, b, c, n]) => {
      const cen = a.clone().add(b).add(c).multiplyScalar(1 / 3);
      if (cen.z < 0.3 || cen.z > D.depth / 100 - 0.3 || cm(cen.y) < 10) return false; // the long side runs only
      const cx = cen.x < 0 ? -D.width / 200 + 0.03 : D.width / 200 - 0.03;
      return true && Math.sign(n.x) === Math.sign(cen.x - cx) || Math.abs(n.x) < 0.2;
    });
    const sideTris = triangles(rail).filter(([a, b, c]) => { const z = (a.z + b.z + c.z) / 3, y = (a.y + b.y + c.y) / 3; return z > 0.3 && z < D.depth / 100 - 0.3 && cm(y) >= 10; });
    check('base: rail faces point outward', sideTris.length > 0 && out.length === sideTris.length, [out.length, sideTris.length]);
  }
  const plinth = byName(g, 'bed:plinth')[0];
  check('base: a dark recessed plinth, inset from the rails', !!plinth && lum(D.plinthColor) < 0.1 &&
    cm(wbox(plinth).max.x) < D.width / 2 - 3 && near(cm(wbox(plinth).max.y), 3.5, 0.05));
}

// ---- 3. mattress --------------------------------------------------------------------
{
  const mat = byName(g, 'bed:mattress')[0];
  check('mattress: drawn', !!mat);
  if (mat) {
    const mb = wbox(mat);
    const vs = verts(mat);
    // edge height: the highest vertex near the mattress's long edge, mid-length
    const midZ = (mb.min.z + mb.max.z) / 2;
    const edgeTop = Math.max(...vs.filter(v => v.x > mb.max.x - 0.045 && Math.abs(v.z - midZ) < 0.3).map(v => v.y));
    check('mattress: top at the edge at ~58-60 (level with a 60 cm bedside table)', cm(edgeTop) >= 58 && cm(edgeTop) <= 60.2, cm(edgeTop));
    check('mattress: crowned (the centre stands > 1 cm above the edge)', cm(mb.max.y - edgeTop) > 1, cm(mb.max.y - edgeTop));
    check('mattress: its lower edge is hidden inside the rails (bottom below the rail top)', cm(mb.min.y) < D.baseHeight - 2, cm(mb.min.y));
    check('mattress: ~150 x 200', Math.abs(cm(mb.max.x - mb.min.x) - 150) < 3 && Math.abs(cm(mb.max.z - mb.min.z) - 200) < 5,
      [cm(mb.max.x - mb.min.x), cm(mb.max.z - mb.min.z)]);
    check('mattress: fits inside the rails', cm(mb.max.x) <= D.width / 2 - 6 + 1e-3);
    // rounded vertical edge: nothing sits at the sharp top corner
    const corner = new THREE.Vector3(mb.max.x, edgeTop, mb.max.z);
    const nearest = Math.min(...vs.map(v => v.distanceTo(corner)));
    check('mattress: rounded edges (nothing at the sharp top corner)', cm(nearest) > 1, cm(nearest));
    check('mattress: in the fitted-sheet colour', mat.material.color.getHex() === new THREE.Color(D.mattressColor).getHex());
  }
}

// ---- 4. duvet -------------------------------------------------------------------------
{
  const duv = byName(g, 'bed:duvet')[0];
  const mat = byName(g, 'bed:mattress')[0];
  check('duvet: drawn by default', !!duv);
  check('duvet: duvet:false removes it', byName(build({ duvet: false }), 'bed:duvet').length === 0);
  if (duv && mat) {
    const db = wbox(duv), mb = wbox(mat);
    const vs = verts(duv);
    const onTop = vs.filter(v => v.y > mb.max.y);
    const headEdge = Math.min(...onTop.map(v => v.z));
    const cover = (mb.max.z - headEdge) / (mb.max.z - mb.min.z);
    check('duvet: covers ~60-75% of the mattress, from the foot', cover >= 0.55 && cover <= 0.8, cover);
    check('duvet: drapes down to the rail tops (lowest point within 3 cm)', Math.abs(cm(db.min.y) - D.baseHeight) <= 3, cm(db.min.y));
    check('duvet: hangs past the mattress sides', db.max.x > mb.max.x + 0.02 && db.min.x < mb.min.x - 0.02);
    check('duvet: hangs over the foot', db.max.z > mb.max.z + 0.02);
    check('duvet: stays inside the width and depth envelope', cm(db.max.x) <= D.width / 2 + 1e-3 && cm(db.max.z) <= D.depth + 1e-3);
    // the drape really hangs: points low down at the SIDE at mid-length
    check('duvet: a side drape at mid-length', vs.some(v => v.x > mb.max.x && cm(v.y) < D.baseHeight + 4 && Math.abs(v.z - 1.3) < 0.3));
    // the fold-back: a doubled band near the head edge, a duvet thickness above the main top
    const mainTop = Math.max(...vs.filter(v => Math.abs(v.x) < 0.2 && v.z > 1.7 && v.z < 1.9).map(v => v.y));
    const band = vs.filter(v => Math.abs(v.x) < 0.2 && v.z > headEdge + 0.05 && v.z < headEdge + 0.25);
    const bandTop = Math.max(...band.map(v => v.y));
    check('duvet: the top edge is folded back (a band ~a duvet thickness proud of the main top)', cm(bandTop - mainTop) > 4 && cm(bandTop - mainTop) < 9, cm(bandTop - mainTop));
    // one-sided: every top-surface triangle over the flat faces up, the side drape faces out
    const tr = triangles(duv);
    const topTris = tr.filter(([a, b, c]) => { const x = (a.x + b.x + c.x) / 3, z = (a.z + b.z + c.z) / 3; return Math.abs(x) < 0.55 && z > headEdge + 0.45 && z < mb.max.z - 0.1; });
    check('duvet: the top faces up (visible from above)', topTris.length > 10 && topTris.every(t => t[3].y > 0.5), topTris.filter(t => t[3].y <= 0.5).length);
    const bandTris = tr.filter(([a, b, c]) => { const x = (a.x + b.x + c.x) / 3, z = (a.z + b.z + c.z) / 3; return Math.abs(x) < 0.55 && z > headEdge + 0.08 && z < headEdge + 0.25; });
    check('duvet: the fold-back band faces up too', bandTris.length > 0 && bandTris.every(t => t[3].y > 0.5), bandTris.length);
    const sideTris = tr.filter(([a, b, c]) => { const x = (a.x + b.x + c.x) / 3, y = (a.y + b.y + c.y) / 3, z = (a.z + b.z + c.z) / 3; return x > mb.max.x && y < mb.max.y - 0.08 && cm(y) > D.baseHeight + 1.5 && z > headEdge + 0.45 && z < mb.max.z - 0.2; });
    check('duvet: the right drape faces outward (+x)', sideTris.length > 0 && sideTris.every(t => t[3].x > 0.3), sideTris.length);
  }
}

// ---- 5. pillows -------------------------------------------------------------------------
{
  check('pillows: 2 sleeping pillows at full', byName(g, 'bed:pillow').length === 2);
  check('pillows: 2 accent pillows at full', byName(g, 'bed:accent-pillow').length === 2);
  check('pillows: 1 cushion at full', byName(g, 'bed:cushion').length === 1);
  const low = build({}, 'low');
  check('pillows low: only the 2 sleeping pillows', byName(low, 'bed:pillow').length === 2 &&
    byName(low, 'bed:accent-pillow').length === 0 && byName(low, 'bed:cushion').length === 0);
  const all = byName(g, 'bed:pillow').concat(byName(g, 'bed:accent-pillow'), byName(g, 'bed:cushion'));
  const maxZ = Math.max(...all.map(p => wbox(p).max.z));
  check('pillows: all at the HEADBOARD end (within the first half of the depth)', cm(maxZ) < D.depth / 2, cm(maxZ));
  const acc = byName(g, 'bed:accent-pillow')[0];
  if (acc) {
    const n = new THREE.Vector3(0, 1, 0).applyQuaternion(acc.getWorldQuaternion(new THREE.Quaternion()));
    const tilt = Math.acos(Math.abs(n.y)) * 180 / Math.PI; // 0 = lying flat, 90 = upright
    check('accent pillows are propped at ~60 degrees', Math.abs(tilt - 60) < 5, tilt);
  }
  check('accent pillows are sage', !!acc && acc.material.color.getHex() === new THREE.Color(D.accentPillowColor).getHex());
  const cush = byName(g, 'bed:cushion')[0];
  check('cushion is centred', !!cush && Math.abs(cm(cush.position.x)) < 0.5);
  const dvb = wbox(byName(g, 'bed:duvet')[0]);
  check('pillows rest above the mattress top', byName(g, 'bed:pillow').every(p => cm(wbox(p).min.y) > 55));
  check('sleeping pillows clear the duvet (no pillow reaches past the fold)', byName(g, 'bed:pillow').every(p => wbox(p).max.z <= dvb.min.z + 0.08));
}

// ---- 6. print -------------------------------------------------------------------------------
{
  const print = byPrefix(g, 'bed:print-');
  check('print: 4 colour meshes (sage and olive leaves, blue and pink flowers)', print.length === 4, print.map(m => m.name));
  const motifTris = print.reduce((n, m) => n + m.geometry.attributes.position.count / 3, 0);
  check('print: >= 60 motifs (a leaf is 2 triangles, a flower 4)', motifTris / 3 >= 60, motifTris);
  check('print: plain matte (merges into the matte bucket; no texture)', print.every(m => m.material.userData.finish === 'matte' && !m.material.map));
  // Every print vertex lies on (just above) the duvet surface.
  const duv = byName(g, 'bed:duvet')[0];
  const dtris = triangles(duv);
  const tri = new THREE.Triangle(), q = new THREE.Vector3();
  const nearestTri = v => {
    let best = null, bd = Infinity;
    for (const t of dtris) {
      tri.set(t[0], t[1], t[2]);
      tri.closestPointToPoint(v, q);
      const d = q.distanceTo(v);
      if (d < bd) { bd = d; best = t; }
    }
    return [bd, best];
  };
  let worst = 0, sample = 0;
  for (const m of print) {
    const vs = verts(m);
    for (let i = 0; i < vs.length; i += 5) { sample++; worst = Math.max(worst, nearestTri(vs[i])[0]); }
  }
  check('print: every motif lies on the duvet surface (within 1.5 cm; the grid is coarser than the print)', sample > 50 && cm(worst) < 1.5, cm(worst));
  // Faces outward: a print triangle's normal agrees with the duvet's at that spot.
  let bad = 0, n = 0;
  for (const m of print) {
    for (const [a, b, c, nr] of triangles(m).filter((_, i) => i % 4 === 0)) {
      const cen = a.clone().add(b).add(c).multiplyScalar(1 / 3);
      n++;
      if (nr.dot(nearestTri(cen)[1][3]) < 0) bad++;
    }
  }
  check('print: every motif faces out of the cloth (would vanish under back-face culling otherwise)', n > 20 && bad === 0, { bad, n });
  check('print: none for beddingPreset "plain"', byPrefix(build({ beddingPreset: 'plain' }), 'bed:print-').length === 0);
  check('print: none at low detail', byPrefix(build({}, 'low'), 'bed:print-').length === 0);
  check('print: none without a duvet', byPrefix(build({ duvet: false }), 'bed:print-').length === 0);
  const again = byPrefix(build(), 'bed:print-');
  const same = print.every((m, i) => {
    const a = m.geometry.attributes.position.array, b = again[i].geometry.attributes.position.array;
    return a.length === b.length && a.every((v, k) => v === b[k]);
  });
  check('print: deterministic (identical on every build)', same);
}

// ---- 7. budget ----------------------------------------------------------------------------------
{
  const low = build({}, 'low');
  const caps = Bed.TRIANGLE_CAPS;
  check('budget: full within the cap', tris(g) <= caps.full, [tris(g), caps.full]);
  check('budget: low within the cap', tris(low) <= caps.low, [tris(low), caps.low]);
  check('budget: low <= 0.6 x full', tris(low) <= 0.6 * tris(g), [tris(low), tris(g)]);
  check('budget: the caps are the audited 2,500 / 800', caps.full === 2500 && caps.low === 800);
  const big = build({ channelCount: 12 });
  check('budget: 12 channels still within the cap', tris(big) <= caps.full, tris(big));
}

// ---- registry wiring ---------------------------------------------------------------------------
{
  const { REGISTRY } = await imp('src/furniture/registry.js');
  check('registry: bed points at bed.js with no key (single-type module)',
    REGISTRY['bed'].path === 'bed.js' && REGISTRY['bed'].key === null, REGISTRY['bed']);
  check('registry: bed points at the BedSpec page', REGISTRY['bed'].spec === 'BedSpec');
}

console.log((failures ? 'FAILED' : 'ok') + ' -- ' + passes + ' passed, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
