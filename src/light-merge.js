/**
 * light-merge.js - collapse a room channel's fixture lights into one or two
 * (task cd6d5d05).
 *
 * three.js evaluates EVERY light for EVERY fragment of every lit material in
 * the house -- there is no clustering or culling -- so fragment cost is
 * linear in the light count, and each PointLight also costs ~4 fragment
 * uniform vectors (a 256-vector phone has room for very few). A room of six
 * downlights used to be six PointLights. It is now ONE, at the fixtures'
 * intensity-weighted centroid, carrying their summed intensity and reaching
 * as far as the furthest of them did; a room longer than SPLIT_LONG_SIDE_CM
 * gets two, one per half along its long axis, and so does a channel whose
 * fixtures are more than SPREAD_M apart (split at its farthest pair). Every fixture MESH stays: it
 * is still what you click and what glows.
 *
 * Pure (no THREE), so scripts/test-light-collapse.mjs drives it directly.
 */

/** A room whose longer side is over this (cm) gets two lights per channel. */
export const SPLIT_LONG_SIDE_CM = 400;

/**
 * Fixtures further apart than this (metres, any two of a channel) are never
 * one light: the channel splits in two at its farthest pair. Ceiling
 * downlights in an ordinary room sit well inside it; an accent strip along
 * the ceiling cove and another behind the sofa do not.
 */
export const SPREAD_M = 2.5;

/**
 * How much of the members' summed intensity a merged light carries. One
 * light at the centre with N times the intensity lights the room more than
 * N lights spread over it do: more of its light lands near the middle of the
 * floor, and its range grows to cover every member's pool. At 1.0 a
 * merged room's mean lit-floor brightness came out 8-17% above the per-fixture
 * version on the full-house fixture; 0.9 brings it back within a few percent
 * (see the PR). A lone fixture's light is never scaled.
 */
export const MERGED_GAIN = 0.9;

/**
 * @param {Array<{x:number, y:number, z:number, intensity:number, distance:number, decay:number}>} emitters
 *        metres, world space; `intensity` is each fixture light's base weight
 * @param {{minX:number, maxX:number, minZ:number, maxZ:number}} roomBox
 *        the room's bounding box in metres (world x/z)
 * @param {Object} [opts]
 * @param {number} [opts.splitLongSideCm]  default SPLIT_LONG_SIDE_CM
 * @param {number} [opts.gain]             default MERGED_GAIN
 * @returns {Array<{x, y, z, intensity, distance, decay, count, members}>}
 *          one or two merged lights; `members` indexes into `emitters`
 */
export function collapseEmitters(emitters, roomBox, opts) {
  const list = (emitters || []).filter(e => e && isFinite(e.x) && isFinite(e.z));
  if (!list.length) return [];
  const o = opts || {};
  const splitCm = o.splitLongSideCm != null ? o.splitLongSideCm : SPLIT_LONG_SIDE_CM;
  const gain = o.gain != null ? o.gain : MERGED_GAIN;
  const spreadM = o.spreadM != null ? o.spreadM : SPREAD_M;
  const box = { minX: Math.min(roomBox.minX, roomBox.maxX), maxX: Math.max(roomBox.minX, roomBox.maxX),
    minZ: Math.min(roomBox.minZ, roomBox.maxZ), maxZ: Math.max(roomBox.minZ, roomBox.maxZ) };
  const w = box.maxX - box.minX, d = box.maxZ - box.minZ;
  const alongX = w >= d;
  const longSide = Math.max(w, d);
  const idx = list.map((e, i) => i);
  let groups = [idx];
  if (longSide * 100 > splitCm && list.length > 1) {
    const mid = alongX ? (box.minX + box.maxX) / 2 : (box.minZ + box.maxZ) / 2;
    const key = i => (alongX ? list[i].x : list[i].z);
    const a = idx.filter(i => key(i) < mid), b = idx.filter(i => key(i) >= mid);
    if (a.length && b.length) groups = [a, b];
  } else if (list.length > 1) {
    // A channel whose fixtures are far apart -- an accent strip along the
    // ceiling cove and another behind the sofa -- would put one merged light
    // in mid-air between them, lighting neither. Past SPREAD_M apart, split
    // it at its farthest pair: each fixture joins the nearer end.
    const dist = (i, j) => Math.hypot(list[i].x - list[j].x, list[i].y - list[j].y, list[i].z - list[j].z);
    let fa = 0, fb = 0, far = 0;
    idx.forEach(i => idx.forEach(j => { const dd = dist(i, j); if (dd > far) { far = dd; fa = i; fb = j; } }));
    if (far > spreadM) {
      const a = idx.filter(i => dist(i, fa) <= dist(i, fb)), b = idx.filter(i => dist(i, fa) > dist(i, fb));
      if (a.length && b.length) groups = [a, b];
    }
  }
  return groups.map(g => {
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
    // A lone fixture's light is left exactly as it was.
    const intensity = g.reduce((s, i) => s + (list[i].intensity || 0), 0) * (g.length > 1 ? gain : 1);
    return { x, y, z, intensity, distance: distance === Infinity ? 0 : distance,
      decay: list[g[0]].decay, count: g.length, members: g.slice() };
  });
}
