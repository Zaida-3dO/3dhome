/**
 * light-merge.js - collapse a room channel's fixture lights into one or two
 * (task cd6d5d05).
 *
 * three.js evaluates EVERY light for EVERY fragment of every lit material in
 * the house -- there is no clustering or culling -- so fragment cost is
 * linear in the light count, and each PointLight also costs ~4 fragment
 * uniform vectors (a 256-vector phone has room for very few). A room of six
 * downlights used to be six PointLights. It is now ONE, at the fixtures'
 * intensity-weighted centroid (their mean position AND mean height, so it
 * always lies inside the fixtures' own bounding box), reaching as far as the
 * furthest of them did.
 *
 * WHEN a channel is two lights is decided by the fixtures' SPREAD alone, not
 * by the room's size: fixtures further apart than SPREAD_M are split at their
 * farthest pair, each joining the nearer end. A long room's downlights are
 * therefore two lights, one per end; a tight cluster in a long room is one.
 *
 * HOW BRIGHT the merged light is: the intensity that gives the room's floor
 * the same MEAN irradiance the separate fixtures gave it, computed with
 * three.js's own punctual-light falloff (inverse power `decay`, windowed to
 * `distance`) and the floor's cosine term, sampled over the room. Summing
 * the intensities instead over-lights a room -- one light at the centre puts
 * more of its light on the floor than N spread towards the walls -- by 8-17%
 * on the fixture house and ~9% on the demo's lounge.
 *
 * Linear strips are NOT merged (opts.merge false, as the scene passes for
 * fixtureType 'strip'): a strip's light is a short-range glow on the surface
 * it runs along (under a cupboard, along a cove), and a merged light between
 * two of them would glow in mid-air and wash the floor instead.
 *
 * Every fixture MESH stays: it is still what you click and what glows.
 *
 * Pure (no THREE), so scripts/test-light-collapse.mjs drives it directly.
 */

/** Fixtures further apart than this (metres) are never one light. */
export const SPREAD_M = 2.5;

/** Floor samples per axis when matching irradiance. */
const SAMPLES = 12;

/** three.js's punctual light attenuation (physically correct lights, r155+). */
export function attenuation(d, cutoff, decay) {
  let a = 1 / Math.max(Math.pow(d, decay), 0.01);
  if (cutoff > 0) {
    const r = d / cutoff;
    const w = Math.max(0, Math.min(1, 1 - r * r * r * r));
    a *= w * w;
  }
  return a;
}

/** Irradiance on an upward-facing floor point from a light (per unit intensity). */
export function floorIrradiance(light, px, py, pz) {
  const dx = light.x - px, dy = light.y - py, dz = light.z - pz;
  const d = Math.hypot(dx, dy, dz);
  if (d <= 0) return 0;
  const cos = Math.max(0, dy / d);
  return cos * attenuation(d, light.distance || 0, light.decay || 2);
}

function floorGrid(box, floorY) {
  const pts = [];
  for (let i = 0; i < SAMPLES; i++) {
    for (let j = 0; j < SAMPLES; j++) {
      pts.push([box.minX + (box.maxX - box.minX) * (i + 0.5) / SAMPLES, floorY,
        box.minZ + (box.maxZ - box.minZ) * (j + 0.5) / SAMPLES]);
    }
  }
  return pts;
}

/**
 * @param {Array<{x:number, y:number, z:number, intensity:number, distance:number, decay:number}>} emitters
 *        metres, world space; `intensity` is each fixture light's base weight
 * @param {{minX:number, maxX:number, minZ:number, maxZ:number}} roomBox
 *        the room's bounding box in metres (world x/z); the floor the
 *        irradiance is matched over
 * @param {Object} [opts]
 * @param {boolean} [opts.merge]    false: one light per emitter, unchanged (strips)
 * @param {number} [opts.floorY]    floor height, default 0
 * @param {number} [opts.spreadM]   default SPREAD_M
 * @returns {Array<{x, y, z, intensity, distance, decay, count, members}>}
 *          `members` indexes into the (finite) emitters
 */
export function collapseEmitters(emitters, roomBox, opts) {
  const list = (emitters || []).filter(e => e && isFinite(e.x) && isFinite(e.y) && isFinite(e.z));
  if (!list.length) return [];
  const o = opts || {};
  const single = i => ({ x: list[i].x, y: list[i].y, z: list[i].z, intensity: list[i].intensity,
    distance: list[i].distance, decay: list[i].decay, count: 1, members: [i] });
  const idx = list.map((e, i) => i);
  if (o.merge === false) return idx.map(single);
  const spreadM = o.spreadM != null ? o.spreadM : SPREAD_M;
  const floorY = o.floorY != null ? o.floorY : 0;
  const box = { minX: Math.min(roomBox.minX, roomBox.maxX), maxX: Math.max(roomBox.minX, roomBox.maxX),
    minZ: Math.min(roomBox.minZ, roomBox.maxZ), maxZ: Math.max(roomBox.minZ, roomBox.maxZ) };

  // Split by spread: past SPREAD_M apart, at the farthest pair.
  let groups = [idx];
  if (list.length > 1) {
    const dist = (i, j) => Math.hypot(list[i].x - list[j].x, list[i].y - list[j].y, list[i].z - list[j].z);
    let fa = 0, fb = 0, far = 0;
    idx.forEach(i => idx.forEach(j => { const dd = dist(i, j); if (dd > far) { far = dd; fa = i; fb = j; } }));
    if (far > spreadM) {
      const a = idx.filter(i => dist(i, fa) <= dist(i, fb)), b = idx.filter(i => dist(i, fa) > dist(i, fb));
      if (a.length && b.length) groups = [a, b];
    }
  }

  const grid = floorGrid(box, floorY);
  return groups.map(g => {
    if (g.length === 1) return single(g[0]);   // a lone fixture is left exactly as it was
    let wsum = 0, x = 0, y = 0, z = 0;
    g.forEach(i => {
      const e = list[i], wt = Math.max(0, e.intensity || 0) || 1e-6;
      wsum += wt; x += e.x * wt; y += e.y * wt; z += e.z * wt;
    });
    x /= wsum; y /= wsum; z /= wsum;
    let distance = 0;
    g.forEach(i => {
      const e = list[i];
      const off = Math.hypot(e.x - x, e.y - y, e.z - z);
      // 0 means "infinite" to three.js: keep it infinite.
      distance = (distance === Infinity || !e.distance) ? Infinity : Math.max(distance, e.distance + off);
    });
    const merged = { x, y, z, distance: distance === Infinity ? 0 : distance, decay: list[g[0]].decay };
    // Match the floor's mean irradiance.
    let want = 0, unit = 0;
    grid.forEach(([px, py, pz]) => {
      g.forEach(i => { want += (list[i].intensity || 0) * floorIrradiance(list[i], px, py, pz); });
      unit += floorIrradiance(merged, px, py, pz);
    });
    const sum = g.reduce((s, i) => s + (list[i].intensity || 0), 0);
    const intensity = unit > 0 ? want / unit : sum;
    return Object.assign(merged, { intensity, count: g.length, members: g.slice() });
  });
}
