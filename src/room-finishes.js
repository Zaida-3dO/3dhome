// room-finishes.js -- the house's own floor and wall finishes, shared with
// the spec pages (item 7938c4e3, folding in 96db53af).
//
// The live house (src/home3d-scene.js) draws its floor with the Ashy Oak LVT
// texture and its painted walls in WALL_COLOR with a matte-plaster roughness
// map. Both texture makers live here, moved verbatim from home3d-scene.js
// (THREE injected, as in src/render-rig.js), so a spec page's backdrop floor
// and wall are the house's own finishes rather than colours tuned for a
// different light rig, and the two cannot drift.
//
// Browser-only: the textures are drawn on a <canvas>.

/** Painted wall and floor material parameters, as the house sets them. */
export const ROOM_FINISH = Object.freeze({
  wallColor: 0xece9e1,     // home3d-scene.js WALL_COLOR default (a profile may override)
  wallRoughness: 0.82,
  floorColor: 0xffffff,    // neutral tint: the baked canvas colours show true
  floorRoughness: 0.82
});

// ---------------------------------------------------------------------------
// Ashy Oak LVT — the real house floor (Floored.co.uk "LVT Ashy Oak").
// Weathered/aged grey-toned OAK look with warm-beige undertones and a realistic
// flowing woodgrain, reproduced from floor close-up photos (2026-07-09)
// + the product's "modern grey toned oak finish" description.
//
// Real product: planks 18.5cm wide x 121.5cm long, matte, LOW-contrast, uniform.
// Long axis runs NORTH-SOUTH in the house.
//
// DESIGN INTENT (per review): the visual interest is the STAGGER (the semi-random
// row-offset pattern that "looks patterned for a few rows, then clearly isn't"),
// NOT the plank faces. All planks are the SAME LVT product, so their grain/colour
// is largely UNIFORM — only SUBTLE per-plank variation (real planks aren't
// identical, but they're close). Per-plank randomisation is deliberately gentle.
//
// This bakes the ENTIRE floor into ONE canvas mapped to cover the whole slab
// once (see the floor-material block for the world-space UV maths), so the plank
// stagger is genuinely non-repeating across the room — no tiling seam.
//
// Determinism: a stable 2D index-hash + a tiny seeded PRNG (mulberry32) drive
// every per-plank tint and the stagger — no Math.random, so the floor is
// pixel-identical on every reload.
export function makeAshyOakTexture(THREE, widthM, depthM) {
  const PLANK_W_CM = 18.5;   // plank width  (E-W / U)
  const PLANK_L_CM = 121.5;  // plank length (N-S / V, the long axis)
  // Knot/mineral-streak radius, in cm like every other dimension here (gibbs-knots
  // fix, 2026-09-14): previously authored in raw canvas px, so the same knot covered
  // MORE real-world area as the slab grew and pxPerCm shrank under the CAP below —
  // a ~10cm blob in a big room instead of a subtle character mark. The drawn radius
  // is kr * 2.2 (soft falloff), so kr = 0.23-0.46cm gives a ~1.0-2.0cm knot DIAMETER
  // in every room regardless of slab size (target: ~1-2cm everywhere).
  const KNOT_R_CM = 0.23;
  const KNOT_R_CM_RAND = 0.23;
  const wCm = widthM * 100, dCm = depthM * 100;

  // ⚠️ SCALE — the canvas must map 1:1 to the SLAB extent (widthM x depthM), because
  // the floor material maps ONE canvas copy across exactly the slab (repeat=1/extent).
  // So size the canvas to the slab's real cm extent, and draw each plank cell at its
  // TRUE cm size (PLANK_W_CM x PLANK_L_CM * pxPerCm). Planks then render at exactly
  // 18.5 x 121.5 cm in world space. (Bug history: previously the canvas was sized to
  // nCols x nRows *rounded-up* plank counts, so the bleed planks got squeezed into the
  // slab extent by the repeat mapping, shrinking every plank — gibbs-r4b.)
  const pxPerCm0 = 3.6;
  // Cap the LONG edge so the GPU upload stays small; scale pxPerCm down if needed.
  const CAP = 2048;
  const longCm = Math.max(wCm, dCm);
  const pxPerCm = Math.min(pxPerCm0, CAP / longCm);
  const cw = Math.round(wCm * pxPerCm);  // canvas width  == slab E-W extent
  const ch = Math.round(dCm * pxPerCm);  // canvas height == slab N-S extent
  // Fixed real-size plank cells (px), independent of how many fit.
  const plankPxW = PLANK_W_CM * pxPerCm; // == 18.5cm in px
  const plankPxH = PLANK_L_CM * pxPerCm; // == 121.5cm in px
  // How many cells to draw to cover the canvas (+1 bleed so edges fill; extra cells
  // simply draw partly off-canvas, they do NOT change plank size).
  const nCols = Math.ceil(cw / plankPxW) + 1;
  const nRows = Math.ceil(ch / plankPxH) + 1;

  const c = document.createElement("canvas");
  c.width = cw; c.height = ch;
  const ctx = c.getContext("2d");

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const hash2 = (x, y) => {
    let h = (x * 374761393 + y * 668265263) | 0;
    h = (h ^ (h >>> 13)) | 0; h = Math.imul(h, 1274126177) | 0;
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };
  const clamp = v => Math.max(0, Math.min(255, Math.round(v)));

  // Weathered grey-oak base colour (sampled from reference photos): a warm-neutral
  // grey-beige, LOW contrast. All planks share this base; per-plank variation is
  // only a few RGB points around it (see drawPlank). Grain lines sit a little
  // darker (cool) with the occasional warmer-beige streak.
  const BASE = [178, 170, 158];   // dominant plank tone (weathered grey-beige oak)
  const GRAIN_DARK = [132, 124, 112]; // grain line / cathedral figure (deeper contrast)
  const GRAIN_WARM = [190, 176, 155]; // occasional warm-beige streak

  // Base fill = plank BASE tone (not a seam colour). LVT is tightly butted, so
  // the background should read as floor, NOT as a fat grout gap showing through.
  // The hairline seams are drawn per-plank inside drawPlank (a single ~1px line),
  // so there's no wide bevel bleeding around every plank.
  ctx.fillStyle = `rgb(${BASE[0]},${BASE[1]},${BASE[2]})`;
  ctx.fillRect(0, 0, cw, ch);

  // --- LAYOUT: planks run N-S. Floor = vertical STRIPS (columns) running N-S,
  // each strip plankPxW (18.5cm) wide E-W, filled by a stack of planks laid
  // end-to-end down the N-S axis, each plankPxH (121.5cm) long.
  //
  // THE STAGGER (Bug-1 fix): each STRIP starts at its own N-S offset, so the
  // horizontal plank-END seams do NOT line up column-to-column — they zig-zag
  // instead of forming continuous horizontal grout lines across the floor.
  // (Previously the stagger was on the E-W axis with a fixed y per row, which
  // made every plank-end align on the same horizontal lines → the grid seen in review.)
  // The vertical seams (plank LONG edges, between strips) stay continuous
  // straight N-S lines — correct for real plank flooring.
  for (let col = -1; col <= nCols; col++) {
    const x0 = Math.round(col * plankPxW);
    const x1 = Math.round((col + 1) * plankPxW);
    if (x1 <= 0 || x0 >= cw) continue;

    // --- SEMI-RANDOM PER-COLUMN N-S START OFFSET (the important characteristic) --
    // Each strip's vertical start is a fraction of a plank LENGTH from a stable
    // per-column hash, quantised to 1/6-plank steps so some columns SHARE a
    // cross-seam (aligned) and others are well offset — "looks patterned for a
    // few strips, then clearly isn't". Deliberately NOT a clean 1/2 or 1/3 bond.
    const rawOff = hash2(col * 2 + 101, 7);
    const colOffset = (Math.round(rawOff * 6) / 6) * plankPxH; // 0 .. 5/6 plank length
    // Tiny sub-plank nudge so "aligned" columns aren't pixel-perfect — a few mm.
    const microNudge = (hash2(col + 55, 3) - 0.5) * plankPxH * 0.03;
    // Start one plank above the top so the offset strip fills the top edge.
    const startY = -colOffset + microNudge;

    for (let row = -1; row <= nRows; row++) {
      const y0 = Math.round(startY + row * plankPxH);
      const y1 = Math.round(startY + (row + 1) * plankPxH);
      if (y1 <= 0 || y0 >= ch) continue;
      drawPlank(ctx, x0, y0, x1 - x0, y1 - y0, col, row);
    }
  }

  // Faint large-scale mottle so lighting isn't perfectly even tile-to-tile
  // (matches the slightly uneven wear in the photos). Very low alpha.
  const grimeRnd = mulberry32(9001);
  ctx.save();
  ctx.globalCompositeOperation = "multiply";
  for (let i = 0; i < 30; i++) {
    const gx = grimeRnd() * cw, gy = grimeRnd() * ch;
    const gr = (0.1 + grimeRnd() * 0.16) * cw;
    const grd = ctx.createRadialGradient(gx, gy, 0, gx, gy, gr);
    const a = 0.02 + grimeRnd() * 0.03;
    grd.addColorStop(0, `rgba(150,146,140,${a})`);
    grd.addColorStop(1, "rgba(150,146,140,0)");
    ctx.fillStyle = grd;
    ctx.fillRect(0, 0, cw, ch);
  }
  ctx.restore();

  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  return tex;

  // --- per-plank painter -------------------------------------------------
  function drawPlank(g, px, py, pw, ph, col, row) {
    if (pw <= 0 || ph <= 0) return;
    const seed = ((col + 128) * 92821 + (row + 128)) | 0;
    const rnd = mulberry32(seed);

    // SUBTLE per-plank tint: a few RGB points of warm<->cool + light<->dark
    // around the shared BASE, so no two planks are identical but they clearly
    // read as the same product. (Intentionally gentle — the interest is the
    // stagger, not the faces.)
    const warm = (hash2(col + 17, row + 4) - 0.5) * 7;  // beige<->grey, +/-3.5
    const light = (hash2(col + 8, row + 21) - 0.5) * 9; // brightness, +/-4.5
    const br = clamp(BASE[0] + warm + light);
    const bg = clamp(BASE[1] + light);
    const bb = clamp(BASE[2] - warm * 0.6 + light);

    // HAIRLINE seam (Bug-2 fix): tightly-butted LVT has only a fine joint, not a
    // fat grout gap. Inset the plank fill by a single ~1px on the left+top so the
    // (slightly darker) base tone shows through as a hairline seam — no wide
    // bevel, no fill-through background. gap is clamped to 1px regardless of scale.
    const gap = 1;
    g.fillStyle = `rgb(${br},${bg},${bb})`;
    g.fillRect(px + gap, py + gap, pw - gap, ph - gap);

    g.save();
    g.beginPath(); g.rect(px + gap, py + gap, pw - gap, ph - gap); g.clip();

    // Gentle length-wise light falloff (planks have a faint sheen change end
    // to end). Low alpha.
    const lg = g.createLinearGradient(0, py, 0, py + ph);
    lg.addColorStop(0, `rgba(245,242,236,${0.02 + rnd() * 0.02})`);
    lg.addColorStop(0.5, "rgba(0,0,0,0)");
    lg.addColorStop(1, `rgba(0,0,0,${0.03 + rnd() * 0.035})`);
    g.fillStyle = lg; g.fillRect(px + gap, py, pw - gap, ph);

    // --- Woodgrain: straight-ish striations running the plank length (N-S) ---
    // Consistent count/style across planks (same product). BOLDER grain pass
    // (2026-07-11, monty-grain): design intent: a stronger cathedral-oak figure, so
    // the striations are a notch more visible — a little more amplitude/wobble,
    // slightly darker+wider lines, higher alpha. Still matte, weathered-grey oak
    // (NOT high-contrast/cartoonish): the alpha bump is modest so faces stay
    // realistic, just clearly reading as wood grain now.
    const nFine = 18 + Math.floor(rnd() * 7); // 18..24 (was 16..21) — a touch denser
    for (let i = 0; i < nFine; i++) {
      const fx = px + gap + rnd() * (pw - gap);
      const amp = 1.0 + rnd() * 2.6;   // was 0.8..2.8 — slightly more figure sweep
      const wob = 0.7 + rnd() * 1.4;   // was 0.6..1.8
      const warmLine = rnd() < 0.18; // occasional warm-beige streak
      const dk = warmLine ? GRAIN_WARM : GRAIN_DARK;
      const a = warmLine ? (0.10 + rnd() * 0.07) : (0.14 + rnd() * 0.12); // was 0.07..0.13 / 0.09..0.19
      g.strokeStyle = `rgba(${clamp(dk[0] + warm)},${clamp(dk[1] + light)},${clamp(dk[2] - warm * 0.6)},${a})`;
      g.lineWidth = 0.6 + rnd() * 1.1; // was 0.5..1.4 — a hair wider
      g.beginPath();
      const steps = 10;
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const yy = py + t * ph;
        const xx = fx + Math.sin(t * Math.PI * wob + i) * amp;
        if (s === 0) g.moveTo(xx, yy); else g.lineTo(xx, yy);
      }
      g.stroke();
    }

    // --- Cathedral / flowing grain figure: 2-3 looping streaks -------------
    // The wide "flame"/cathedral arcs visible in the photos — this is THE oak-
    // figure signature as intended stronger (2026-07-11, monty-grain). Boldened:
    // 2-3 nested-arc bundles (was 1-2), each a wider 7-line bundle (k -3..3, was
    // -2..2), a bit more spread, darker (-14 vs -8), and higher alpha so the
    // cathedral sweeps clearly read as oak. Deeper-arc bezier (control points
    // pulled further left) gives a rounder, more pronounced cathedral curve.
    // Still soft-edged + matte — a clear step up in figure, not a garish jump.
    const nCath = 2 + Math.floor(rnd() * 2); // 2..3 (was 1..2)
    for (let i = 0; i < nCath; i++) {
      const cxp = px + gap + (0.22 + rnd() * 0.56) * (pw - gap);
      const spread = 2.5 + rnd() * 5; // was 2..6 — slightly wider figure
      const yTop = py + rnd() * ph * 0.4;
      const yBot = yTop + (0.32 + rnd() * 0.5) * ph; // slightly taller arcs
      g.strokeStyle = `rgba(${clamp(GRAIN_DARK[0] + warm - 14)},${clamp(GRAIN_DARK[1] + light - 14)},${clamp(GRAIN_DARK[2] - 14)},${0.10 + rnd() * 0.07})`; // was -8 / 0.06..0.11
      g.lineWidth = 1.1 + rnd() * 2.0; // was 1..2.8
      for (let k = -3; k <= 3; k++) { // 7-line bundle (was 5, k -2..2)
        g.beginPath();
        const off = k * spread;
        g.moveTo(cxp + off, yTop);
        g.bezierCurveTo(
          cxp + off - spread * 1.9, yTop + (yBot - yTop) * 0.33, // deeper cathedral curve (was 1.5)
          cxp + off - spread * 1.9, yTop + (yBot - yTop) * 0.66,
          cxp + off, yBot
        );
        g.stroke();
      }
    }

    // Rare small knot / mineral streak (weathered-oak character) — low freq.
    // Radius authored in CM (KNOT_R_CM above) and converted via pxPerCm, same as
    // every other dimension in this texture — NOT raw px (gibbs-knots, 2026-09-14).
    if (rnd() < 0.12) {
      const kx = px + gap + rnd() * (pw - gap);
      const ky = py + rnd() * ph;
      const kr = (KNOT_R_CM + rnd() * KNOT_R_CM_RAND) * pxPerCm;
      const kg = g.createRadialGradient(kx, ky, 0, kx, ky, kr * 2.2);
      kg.addColorStop(0, `rgba(${clamp(GRAIN_DARK[0] - 30)},${clamp(GRAIN_DARK[1] - 30)},${clamp(GRAIN_DARK[2] - 28)},0.4)`);
      kg.addColorStop(1, "rgba(0,0,0,0)");
      g.fillStyle = kg;
      g.beginPath(); g.arc(kx, ky, kr * 2.2, 0, Math.PI * 2); g.fill();
    }
    g.restore();

    // HAIRLINE seam lines (Bug-2 fix): a single thin ~1px line on the left edge
    // (plank LONG seam) and the top edge (plank END seam), soft and only a little
    // darker than the plank so it reads as a fine joint — NOT the old fat 3-stroke
    // bevel. Tightly-butted LVT: fine seam, not wide grout.
    g.strokeStyle = "rgba(118,113,106,0.35)";
    g.lineWidth = 1;
    g.beginPath(); g.moveTo(px + 0.5, py + gap); g.lineTo(px + 0.5, py + ph); g.stroke();
    g.beginPath(); g.moveTo(px + gap, py + 0.5); g.lineTo(px + pw, py + 0.5); g.stroke();
  }
}

// Subtle matte-plaster roughness texture for painted walls — a fine, low-
// contrast noise (not a colour map) so painted plasterboard reads as a real
// wall instead of a flat shader, without adding a second texture unit's
// worth of visible cost. One shared Texture instance is created per scene
// and reused by every wall material (same pattern as `cloudTex` below) —
// a single ~32x32 canvas + single GPU upload no matter how many wall
// segments reference it. Skipped entirely on the 'low' GPU tier (see
// quality.tier in buildScene) — same tier gate as ambientStrips.
export function makeWallRoughnessTexture(THREE) {
  const size = 32;
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#d9d9d9";
  ctx.fillRect(0, 0, size, size);
  const id = ctx.getImageData(0, 0, size, size);
  const data = id.data;
  for (let i = 0; i < data.length; i += 4) {
    const noise = (Math.random() - 0.5) * 40; // gentle micro-variation, not carpet-grade
    const v = Math.max(0, Math.min(255, 217 + noise));
    data[i] = data[i + 1] = data[i + 2] = v;
  }
  ctx.putImageData(id, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(6, 3); // fine tiling frequency, reads as texture not visible tiles
  return tex;
}

/**
 * The house's painted-wall material: WALL_COLOR at roughness 0.82 with the
 * plaster roughness map. `roughMap` may be passed to share one texture.
 */
export function makeWallMaterial(THREE, opts) {
  const o = opts || {};
  return new THREE.MeshStandardMaterial({
    color: o.color != null ? o.color : ROOM_FINISH.wallColor,
    roughness: ROOM_FINISH.wallRoughness,
    roughnessMap: o.roughMap !== undefined ? o.roughMap : makeWallRoughnessTexture(THREE),
    side: o.side != null ? o.side : THREE.FrontSide
  });
}

/**
 * The house's floor material over a widthM x depthM (metres) area: one
 * Ashy Oak canvas mapped once across it, as the house maps it across its
 * slab. The mesh's UVs must run 0..1 over that area (a PlaneGeometry's do;
 * a CircleGeometry's run 0..1 across its diameter).
 */
export function makeFloorMaterial(THREE, widthM, depthM) {
  const tex = makeAshyOakTexture(THREE, widthM, depthM);
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return new THREE.MeshStandardMaterial({ color: ROOM_FINISH.floorColor, roughness: ROOM_FINISH.floorRoughness, metalness: 0, map: tex });
}

/**
 * Give a spec page's backdrop meshes the house's finishes. A page tags each
 * backdrop in its buildModel with `mesh.userData.specBackdrop = 'floor'` or
 * `'wall'`; this replaces its material with the house floor (Ashy Oak over
 * the mesh's own UV extent) or painted wall. A mesh's own `side` and any
 * transparency it was built with are kept. `cache` (a Map the caller keeps)
 * shares one material per floor size and one wall material across rebuilds.
 * @returns {number} how many meshes were re-skinned
 */
export function applyRoomBackdrops(THREE, root, cache) {
  let n = 0;
  root.traverse(o => {
    const kind = o.isMesh && o.userData && o.userData.specBackdrop;
    if (kind !== 'floor' && kind !== 'wall') return;
    const old = Array.isArray(o.material) ? o.material[0] : o.material;
    if (old && old.userData && old.userData.roomFinish) return;
    let key, make;
    if (kind === 'floor') {
      // The UV extent: a plane's or disc's two largest local dimensions.
      if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
      const sz = new THREE.Vector3(); o.geometry.boundingBox.getSize(sz);
      const dims = [sz.x, sz.y, sz.z].sort((a, b) => b - a);
      const w = Math.max(0.1, Math.round(dims[0] * 10) / 10), d = Math.max(0.1, Math.round(dims[1] * 10) / 10);
      key = 'floor|' + w + '|' + d + '|' + (old ? old.side : 0);
      make = () => makeFloorMaterial(THREE, w, d);
    } else {
      key = 'wall|' + (old ? old.side : 0) + '|' + (old && old.transparent ? old.opacity : 1);
      make = () => makeWallMaterial(THREE, { roughMap: cache.get('wallRough') || cache.set('wallRough', makeWallRoughnessTexture(THREE)).get('wallRough') });
    }
    if (!cache.has(key)) {
      const m = make();
      if (old) { m.side = old.side; if (old.transparent) { m.transparent = true; m.opacity = old.opacity; } }
      m.userData.roomFinish = kind;
      cache.set(key, m);
    }
    if (old && old.dispose) old.dispose();
    o.material = cache.get(key);
    n++;
  });
  return n;
}
