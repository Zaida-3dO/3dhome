/**
 * lights-budget.js - how much of the fragment-uniform budget the lights take
 * (item 112ec00c, the strip-light cost stages). Pure, plus one browser probe.
 *
 * WHY. MAX_FRAGMENT_UNIFORM_VECTORS is the ceiling that decides whether the
 * lit shader COMPILES at all (quality-tier.js): three.js declares every light
 * of a type as an array of structs in every lit material's fragment shader,
 * and each struct member takes at least one vector. Adding strip lights spends
 * that budget; this says by how much, two ways:
 *
 *   estimate  from the light counts and three r160's light structs (below).
 *             Lights only: a material's own uniforms (colour, maps, fog...)
 *             come on top, so compare with headroom, not with equality.
 *   measured  the largest active-uniform footprint of any linked program,
 *             read back from GL (vertex + fragment together, so an upper
 *             bound on the fragment side). Null where unreadable.
 *
 * Vectors per light in three r160's GLSL (UniformsLib / lights_pars_begin):
 *   DirectionalLight {direction, color}                                  2
 *   PointLight       {position, color, distance, decay}                  4
 *   SpotLight        {position, direction, color, distance, decay,
 *                     coneCos, penumbraCos}                               7
 *   RectAreaLight    {color, position, halfWidth, halfHeight}            4 (+2 LTC samplers)
 *   HemisphereLight  {direction, skyColor, groundColor}                  3
 *   ambientLightColor                                                    1
 * Shadows, per shadow-casting light (fragment side):
 *   directional / spot {shadowBias, shadowNormalBias, shadowRadius, shadowMapSize}  4
 *   point              {..., shadowCameraNear, shadowCameraFar}                     6
 */

export const VECTORS = Object.freeze({
  directional: 2, point: 4, spot: 7, rectArea: 4, hemisphere: 3, ambient: 1,
  directionalShadow: 4, spotShadow: 4, pointShadow: 6
});

/** Estimated fragment-uniform vectors the lights take, from lightCounts(). */
export function estimateLightVectors(lc) {
  if (!lc) return null;
  const n = k => (Number.isFinite(lc[k]) ? lc[k] : 0);
  return n('directional') * VECTORS.directional + n('point') * VECTORS.point + n('spot') * VECTORS.spot +
    n('rectArea') * VECTORS.rectArea + n('hemisphere') * VECTORS.hemisphere + 1 /* ambientLightColor, always declared */ +
    n('directionalShadow') * VECTORS.directionalShadow + n('spotShadow') * VECTORS.spotShadow +
    n('pointShadow') * VECTORS.pointShadow;
}

/** Rows a GL uniform type occupies (samplers take none of the vector budget). */
export function rowsForType(gl, type) {
  const m = {};
  if (gl.FLOAT_MAT2 !== undefined) m[gl.FLOAT_MAT2] = 2;
  if (gl.FLOAT_MAT3 !== undefined) m[gl.FLOAT_MAT3] = 3;
  if (gl.FLOAT_MAT4 !== undefined) m[gl.FLOAT_MAT4] = 4;
  if (gl.FLOAT_MAT2x3 !== undefined) { m[gl.FLOAT_MAT2x3] = 2; m[gl.FLOAT_MAT2x4] = 2; m[gl.FLOAT_MAT3x2] = 3;
    m[gl.FLOAT_MAT3x4] = 3; m[gl.FLOAT_MAT4x2] = 4; m[gl.FLOAT_MAT4x3] = 4; }
  const samplers = [gl.SAMPLER_2D, gl.SAMPLER_CUBE, gl.SAMPLER_3D, gl.SAMPLER_2D_SHADOW, gl.SAMPLER_2D_ARRAY,
    gl.SAMPLER_2D_ARRAY_SHADOW, gl.SAMPLER_CUBE_SHADOW, gl.INT_SAMPLER_2D, gl.UNSIGNED_INT_SAMPLER_2D].filter(v => v !== undefined);
  if (samplers.indexOf(type) !== -1) return 0;
  return m[type] || 1;
}

/**
 * The largest active-uniform footprint (vectors) over the renderer's linked
 * programs, or null. Browser only.
 */
export function measuredMaxUniformVectors(renderer) {
  try {
    const gl = renderer.getContext();
    const progs = renderer.info && Array.isArray(renderer.info.programs) ? renderer.info.programs : [];
    let best = 0, seen = 0;
    progs.forEach(p => {
      const prog = p && p.program;
      if (!prog || !gl.getProgramParameter(prog, gl.LINK_STATUS)) return;
      const n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
      let v = 0;
      for (let i = 0; i < n; i++) {
        const u = gl.getActiveUniform(prog, i);
        if (u) v += rowsForType(gl, u.type) * u.size;
      }
      seen++;
      if (v > best) best = v;
    });
    return seen ? best : null;
  } catch (e) { return null; }
}
