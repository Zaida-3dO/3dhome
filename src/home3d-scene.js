/**
 * Home 3D Scene — vanilla JS Three.js scene builder
 * Converted from React JSX (house-3d-model.jsx).
 * Shared between the sidebar preview and the full-screen page.
 *
 * Usage:
 *   const scene = Home3DScene.create(containerEl, { interactive: true });
 *   // later: scene.dispose();
 */

/* global THREE */

const Home3DScene = (() => {
  // ---- The active house profile -------------------------------------------
  //
  // THIS ENGINE RENDERS WHATEVER HOUSE IT IS GIVEN. Everything that used to be
  // a module constant describing one specific flat -- the coordinate origin,
  // the wall list, the room polygons, the door schedule, where every light
  // fixture hangs, the site latitude -- now arrives as a compiled house profile
  // from src/house-loader.js. See houses/schema.json for the data format.
  //
  // `activeHouse` is the profile the module-level exports (ROOMS, LIGHTS,
  // WALL_SEGMENTS_WORLD, FOOTPRINT_BOUNDS, COORD_TRANSFORM, DOOR_LABELS_WORLD)
  // are derived from. Those exports are consumed by the debug overlays and by
  // embedders, so they must keep working; they are now DERIVED from the loaded
  // profile rather than frozen constants, and are refreshed whenever a scene is
  // created for a house. Read them after create() resolves, not before.
  let activeHouse = null;

  // Per-house values the scene builder reads. Bound by useHouse() below; every
  // function in this module reads them through these bindings rather than
  // closing over a literal, which is the whole point of the refactor.
  let HOUSE = null;              // the compiled profile
  let OX = 0, OY = 0, S = 0.01;  // coordinate transform (per house, never a constant)
  let WH = 2.5;                  // wall height, metres
  let WT_CM = 10;                // default wall thickness, cm
  let WT = 0.10;                 // the same, in metres (WT_CM * S)
  let WALLS = [];                // authored centrelines
  let WALL_EXT = [];             // corner-filled centrelines (see house-loader)
  let ROOMS = {};                // room id -> { poly, derived bbox, name, area, ... }
  let LIGHTS = {};               // room id -> channel -> fixture group
  let DOORS = [];                // compiled door schedule
  let WALL_COLOR = 0xece9e1;
  let DOOR_SLAB_COLOR = 0xece4d4;
  let CEILING_COLOR = 0xf2efe9;

  // Plan centimetres -> world metres. Reassigned per house, so every call site
  // picks up the new transform automatically.
  let tx = x => (x - OX) * S;
  let tz = y => (y - OY) * S;

  // Door geometry defaults, in the units the render code wants (metres/cm).
  let DOOR_H = 2.03;    // default door leaf height (m)
  let DOOR_T = 0.04;    // door slab thickness (m)
  let OPEN_H = 2.07;    // wall opening height (m) -- wall stays as a lintel above
  let REVEAL_CM = 8;    // frame reveal each side (cm)
  let DOOR_REST = 0.2;  // at-rest pose as a fraction of the solved max swing

  // Front-door leaf finish. A profile can override the leaf colour per door
  // (door.color); these are the fallbacks for a door of kind 'front'.
  const FRONT_DOOR_COLOR = 0x6E4A34;
  const FRONT_DOOR_GROOVE_COLOR = 0x2A1D14;

  /**
   * Bind a compiled house profile as the one this module renders.
   *
   * Called by create() before it builds a scene. Kept separate so the derived
   * exports can be refreshed in one place, and so a caller can compile a
   * profile once and hand it in repeatedly.
   */
  function useHouse(house) {
    if (!house) throw new Error('Home3DScene: no house profile supplied');
    activeHouse = HOUSE = house;

    OX = house.transform.OX;
    OY = house.transform.OY;
    S = house.transform.S;
    tx = house.transform.tx;
    tz = house.transform.tz;

    WH = house.wallHeight;
    WT_CM = house.wallThickness;
    WT = WT_CM * S;
    WALLS = house.walls;
    WALL_EXT = house.wallsExt;
    ROOMS = house.rooms;
    LIGHTS = house.lights;
    DOORS = house.doors;

    WALL_COLOR = house.materials.wallColor;
    DOOR_SLAB_COLOR = house.materials.doorSlabColor;
    CEILING_COLOR = house.materials.ceilingColor;

    DOOR_H = house.defaults.doorHeight / 100;
    DOOR_T = house.defaults.doorThickness / 100;
    OPEN_H = house.defaults.doorOpeningHeight / 100;
    REVEAL_CM = house.defaults.doorFrameReveal;
    DOOR_REST = house.defaults.doorRestOpenFraction;

    refreshExports();
    return house;
  }

  // --- Door swing geometry helpers (cm space; x=east, y=south) ---
  // Returns the door's hinge point + basis: `along` (hinge->latch, closed) and
  // `normal` (into the room it opens into).
  function doorBasis(d) {
    let along, normal, oc;
    if (d.wall === 'x') { oc = [d.c, d.at]; along = [d.hinge === 'w' ? 1 : -1, 0]; normal = [0, d.swing === 's' ? 1 : -1]; }
    else { oc = [d.at, d.c]; along = [0, d.hinge === 'n' ? 1 : -1]; normal = [d.swing === 'e' ? 1 : -1, 0]; }
    const hinge = [oc[0] - along[0] * d.w / 2, oc[1] - along[1] * d.w / 2];
    return { hinge, along, normal };
  }
  // Free (latch) end of the leaf when opened `deg` degrees.
  function doorLeafTip(d, deg) {
    const b = doorBasis(d), r = deg * Math.PI / 180;
    const dx = b.along[0] * Math.cos(r) + b.normal[0] * Math.sin(r);
    const dy = b.along[1] * Math.cos(r) + b.normal[1] * Math.sin(r);
    return [b.hinge[0] + d.w * dx, b.hinge[1] + d.w * dy];
  }
  // Minimum distance between two 2-D segments (cm).
  function segSegDist(p, p2, q, q2) {
    const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
    const clamp01 = t => Math.max(0, Math.min(1, t));
    const u = sub(p2, p), v = sub(q2, q), w0 = sub(p, q);
    const a = dot(u, u), b = dot(u, v), c = dot(v, v), dd = dot(u, w0), e = dot(v, w0);
    const D = a * c - b * b;
    let sc, tc;
    if (D < 1e-9) { sc = 0; tc = (c > 1e-9 ? e / c : 0); }
    else { sc = clamp01((b * e - c * dd) / D); tc = clamp01((a * e - b * dd) / D); }
    // refine against clamped params
    sc = clamp01((b * tc - dd) / (a || 1));
    tc = clamp01((b * sc + e) / (c || 1));
    const cp = [p[0] + sc * u[0], p[1] + sc * u[1]];
    const cq = [q[0] + tc * v[0], q[1] + tc * v[1]];
    return Math.hypot(cp[0] - cq[0], cp[1] - cq[1]);
  }
  // Collision-aware max open angles: reduce swings so no two open leaves come
  // within CLEAR cm. Cupboard doors stay small; where two standard doors clash
  // they back off together; a standard vs a cupboard yields (the standard
  // reduces). Prevents doors from swinging into each other. The profile's
  // maxOpenDegrees is the INTENDED maximum -- this only ever lowers it.
  function computeDoorAngles(doors) {
    const ang = doors.map(d => d.ang);
    const CLEAR = 9, MIN_STD = 25, MIN_CUP = 18;
    const leaf = i => [doorBasis(doors[i]).hinge, doorLeafTip(doors[i], ang[i])];
    for (let it = 0; it < 120; it++) {
      let changed = false;
      for (let i = 0; i < doors.length; i++) for (let j = i + 1; j < doors.length; j++) {
        const si = leaf(i), sj = leaf(j);
        if (segSegDist(si[0], si[1], sj[0], sj[1]) < CLEAR) {
          const ci = doors[i].size === 'cup', cj = doors[j].size === 'cup';
          const minI = ci ? MIN_CUP : MIN_STD, minJ = cj ? MIN_CUP : MIN_STD;
          if (ci !== cj) { // the standard door reduces before a cupboard does
            const k = ci ? j : i, mk = k === i ? minI : minJ;
            if (ang[k] > mk) { ang[k] -= 2; changed = true; }
            else { const o = k === i ? j : i, mo = o === i ? minI : minJ; if (ang[o] > mo) { ang[o] -= 2; changed = true; } }
          } else { // same class -> back off together
            if (ang[i] > minI) { ang[i] -= 2; changed = true; }
            if (ang[j] > minJ) { ang[j] -= 2; changed = true; }
          }
        }
      }
      if (!changed) break;
    }
    return ang;
  }

  function k2h(k) {
    const t = Math.max(0, Math.min(1, (k - 2700) / 3800));
    return (Math.round(255 - t * 30) << 16) | (Math.round(215 + t * 30) << 8) | Math.round(160 + t * 90);
  }

  // ---- Procedural floor textures (canvas-generated, no external files) ----
  function makeWoodTileTexture() {
    const size = 512;
    const c = document.createElement("canvas");
    c.width = c.height = size;
    const ctx = c.getContext("2d");

    // Base warm wood tone
    ctx.fillStyle = "#b89060";
    ctx.fillRect(0, 0, size, size);

    // Plank grain lines (horizontal, subtle variation)
    const plankH = 64; // pixels per plank row
    for (let row = 0; row < size / plankH; row++) {
      const y0 = row * plankH;
      // Slightly vary plank colour
      const v = (row % 2 === 0) ? 8 : -8;
      const r = 184 + v, g = 144 + v, b = 96 + v;
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.fillRect(0, y0, size, plankH - 1);

      // Fine grain lines within each plank
      ctx.strokeStyle = `rgba(80,50,20,0.08)`;
      ctx.lineWidth = 0.5;
      for (let i = 0; i < 6; i++) {
        const gy = y0 + Math.random() * plankH;
        ctx.beginPath();
        ctx.moveTo(0, gy);
        ctx.lineTo(size, gy + (Math.random() - 0.5) * 4);
        ctx.stroke();
      }
    }

    // Tile grout lines (grid — every 128px horizontal, every plankH vertical)
    ctx.strokeStyle = "rgba(60,40,20,0.35)";
    ctx.lineWidth = 2;
    for (let y = 0; y <= size; y += plankH) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(size, y); ctx.stroke();
    }
    for (let x = 0; x <= size; x += 128) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, size); ctx.stroke();
    }

    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    return tex;
  }

  function makeCarpetTexture(hexColor) {
    const size = 256;
    const c = document.createElement("canvas");
    c.width = c.height = size;
    const ctx = c.getContext("2d");
    const r = (hexColor >> 16) & 0xff;
    const g = (hexColor >> 8) & 0xff;
    const b = hexColor & 0xff;
    ctx.fillStyle = `rgb(${r},${g},${b})`;
    ctx.fillRect(0, 0, size, size);

    // Fine noise to simulate carpet pile
    const id = ctx.getImageData(0, 0, size, size);
    const data = id.data;
    for (let i = 0; i < data.length; i += 4) {
      const noise = (Math.random() - 0.5) * 28;
      data[i]   = Math.max(0, Math.min(255, data[i]   + noise));
      data[i+1] = Math.max(0, Math.min(255, data[i+1] + noise));
      data[i+2] = Math.max(0, Math.min(255, data[i+2] + noise));
    }
    ctx.putImageData(id, 0, 0);

    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    return tex;
  }

  function makeTileBathroomTexture() {
    const size = 256;
    const c = document.createElement("canvas");
    c.width = c.height = size;
    const ctx = c.getContext("2d");
    // Light grey-beige tile
    ctx.fillStyle = "#ccc4bc";
    ctx.fillRect(0, 0, size, size);

    // Grout lines every 64px
    ctx.strokeStyle = "rgba(100,90,85,0.5)";
    ctx.lineWidth = 2;
    for (let v = 0; v <= size; v += 64) {
      ctx.beginPath(); ctx.moveTo(0, v); ctx.lineTo(size, v); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(v, 0); ctx.lineTo(v, size); ctx.stroke();
    }

    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    return tex;
  }

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
  function makeAshyOakTexture(widthM, depthM) {
    const PLANK_W_CM = 18.5;   // plank width  (E-W / U)
    const PLANK_L_CM = 121.5;  // plank length (N-S / V, the long axis)
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
      if (rnd() < 0.12) {
        const kx = px + gap + rnd() * (pw - gap);
        const ky = py + rnd() * ph;
        const kr = 1.4 + rnd() * 2.2;
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
  function makeWallRoughnessTexture() {
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

  // Procedural oak-grain roughness map for the acoustic slat panels — subtle
  // low-contrast vertical streaks, tiled a few times up the ~2.5m slat height.
  // (Ported from experimental 2026-07-11, zabine-wall25.)
  function makeOakGrainTexture() {
    const w = 16, h = 256;
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#d9d9d9";
    ctx.fillRect(0, 0, w, h);
    for (let i = 0; i < 40; i++) {
      const x0 = Math.random() * w;
      const shade = 190 + Math.random() * 50; // subtle, low-contrast like wallRoughMap
      ctx.strokeStyle = `rgba(${shade},${shade},${shade},0.5)`;
      ctx.lineWidth = 0.4 + Math.random() * 0.6;
      ctx.beginPath();
      ctx.moveTo(x0, 0);
      ctx.bezierCurveTo(
        x0 + (Math.random() - 0.5) * 3, h * 0.33,
        x0 + (Math.random() - 0.5) * 3, h * 0.66,
        x0 + (Math.random() - 0.5) * 2, h
      );
      ctx.stroke();
    }
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(1, 5);
    return tex;
  }

  /**
   * Wall #25 bedroom-facing acoustic wood slat panel (Acupanel Contemporary
   * Oak). Ported from experimental 2026-07-11 (zabine-wall25) and re-fitted to
   * LIVE R4 #25 (centerline 953.5->931.1, run 447.8->453.0cm).
   *
   * Real product spec (mm): slats 27 wide x 10 deep, 13 gap (40 pitch), 9 felt
   * backing (19 total off the wall). Built as real parametric 3D — individual
   * slat meshes with real gaps — because the grooves have physical relief a flat
   * texture can't sell. A standalone THREE.Group bolted onto #25's existing
   * bedroom (-x) face; never touches WALL_EXT, the wall render loop, or #25's own
   * material. Reads #25's live geometry (position + own thickness) only.
   *
   * NO-FADE + BLACK-HALF FIX (2026-07-11, review-flagged): #25 is an INTERIOR
   * divider (outer:0). The bedroom slats must NEVER fade — an earlier attempt
   * registered them with outer:true (borrowing exterior wall #4's fade normal) so
   * they'd fade to let you see into the bedroom from outside, but that made the
   * slats go see-through whenever #4 faded, which reads wrong for an interior
   * panel. Fix: register the meshes with outer:false so the render-loop fade
   * block's `if (!outer) return` SKIPS them → opacity stays 1.0 forever. The panel
   * is a STACK of ~114 near-coplanar boxes; the experimental "black-half" bug was
   * an unstable transparent-pass sort making half the panel render solid BLACK,
   * swapping halves as the camera orbits. Because the slats are now always solid,
   * their materials are created with depthWrite:true (and no transparency) so the
   * z-buffer resolves the box stack from every angle — no black half, ever. (You
   * still see INTO the bedroom from outside via the exterior wall #4 fading; the
   * interior slat panel simply stays put, which is the correct real-world read.)
   */
  function buildAcousticPanelWall25(scene, wallMeshes) {
    const wall25 = WALLS.find(w => w.id === 25);
    if (!wall25) return;   // this house has no wall 25 — nothing to panel
    if (!wall25) return null;
    const wall25ThicknessCm = wall25.thickness != null ? wall25.thickness : (WT * 100);
    const wall25ThicknessM = wall25ThicknessCm * S;
    const wallCenterX = tx(wall25.x1);
    // SOUTH-END CLIP (2026-07-11, review-flagged): #25's raw span runs y 299.6..752.6,
    // but the bedroom bump-in pillar #31 (horizontal, centerline y=743.2,
    // thickness 18.8) sits across the south end — so its NORTH (bedroom-facing)
    // face is at y = 743.2 − 18.8/2 = 733.8cm. The slat run must STOP there, not
    // continue behind #31. Clip ONLY the bedroom slats' south end; the home_office
    // wallpaper on the +x face still covers the whole wall (built in the wall loop).
    const wall31 = WALLS.find(w => w.id === 31);
    const southYcm = wall31 ? (wall31.y1 - (wall31.thickness != null ? wall31.thickness : 18.8) / 2) : 733.8;
    const northYcm = Math.min(wall25.y1, wall25.y2); // 299.6 (north end, unchanged)
    const wz1 = tz(northYcm), wz2 = tz(southYcm);
    const wallCenterZ = (wz1 + wz2) / 2;
    const runLenM = Math.abs(wz2 - wz1); // clipped run: north end .. #31 north face
    // #25's own -x (bedroom) face, using #25's OWN thickness (10cm).
    const bedroomFaceX = wallCenterX - wall25ThicknessM / 2;

    // Acupanel Contemporary spec, mm -> m.
    const slatW = 0.027, slatD = 0.010, backingD = 0.009;
    const nomGap = 0.013;
    const EPS = 0.005; // mounting-gap offset off the wall face — avoids z-fighting

    // Fit whole slats; redistribute the sub-cm remainder into the gap.
    const nomPitch = slatW + nomGap;
    const n = Math.round(runLenM / nomPitch);
    const gap = (runLenM - n * slatW) / (n - 1);
    const pitch = slatW + gap;

    // Depth stack outward from the wall face into the bedroom: face -> EPS gap
    // -> felt backing -> slats. Slats protrude slatD past the backing — that step
    // IS the visible groove depth.
    const backingOuterX = bedroomFaceX - EPS;
    const backingInnerX = backingOuterX - backingD;
    const backingCenterX = (backingOuterX + backingInnerX) / 2;
    const slatOuterX = backingInnerX - slatD;
    const slatCenterX = (backingInnerX + slatOuterX) / 2;

    const group = new THREE.Group();
    group.name = 'wall25-acoustic-panel-bedroom';
    const panelMeshes = [];

    // Felt backing — dark recessed groove floor. #25 is an INTERIOR divider
    // (outer:0) so the slats must NEVER fade (2026-07-11, review-flagged: they were
    // going see-through when exterior wall #4 faded). They're registered below
    // with outer:false → the fade loop skips them → opacity stays 1.0 forever.
    // Because they're always solid, depthWrite is TRUE at creation (and never
    // toggled) so the ~114 near-coplanar boxes resolve in the z-buffer — that's
    // also what keeps the black-half bug fixed (solid + depthWrite → no black half).
    const backingMat = new THREE.MeshStandardMaterial({ color: 0x1c1815, roughness: 0.95, depthWrite: true });
    const backing = new THREE.Mesh(new THREE.BoxGeometry(backingD, WH, runLenM), backingMat);
    backing.position.set(backingCenterX, WH / 2, wallCenterZ);
    backing.receiveShadow = true;
    group.add(backing);
    panelMeshes.push(backing);

    // Slats — one shared geometry + material, n positioned instances.
    const grainMap = makeOakGrainTexture();
    const slatMat = new THREE.MeshStandardMaterial({
      color: 0xc9a06a, roughness: 0.55, roughnessMap: grainMap, depthWrite: true
    });
    const slatGeo = new THREE.BoxGeometry(slatD, WH, slatW);
    const startZ = Math.min(wz1, wz2);
    for (let i = 0; i < n; i++) {
      const zCenter = startZ + i * pitch + slatW / 2;
      const slat = new THREE.Mesh(slatGeo, slatMat);
      slat.position.set(slatCenterX, WH / 2, zCenter);
      slat.castShadow = true;
      slat.receiveShadow = true;
      group.add(slat);
      panelMeshes.push(slat);
    }

    scene.add(group);

    // Register the panel meshes with outer:false so the render-loop fade block's
    // `if (!outer) return` SKIPS them — they never fade (correct for an interior
    // divider; #25 is outer:0). Opacity stays 1.0, depthWrite stays true (set at
    // material creation), so the black-half bug stays fixed at every angle. (The
    // earlier outer:true made them borrow #4's fade and go see-through — the bug
    // review flagged 2026-07-11.) Kept in wallMeshes only for parity/traceability.
    if (wallMeshes) panelMeshes.forEach(mesh => wallMeshes.push({ mesh, nx: 0, nz: -1, outer: false }));

    return group;
  }


  // Subtle oak-grain roughness map shared by the acoustic slat panels. Low
  // contrast so it reads as texture, not stripes. (Ported from experimental.)
  function makeOakGrainTexture() {
    const w = 16, h = 256;
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#d9d9d9";
    ctx.fillRect(0, 0, w, h);
    for (let i = 0; i < 40; i++) {
      const x0 = Math.random() * w;
      const shade = 190 + Math.random() * 50; // subtle, low-contrast like wallRoughMap
      ctx.strokeStyle = `rgba(${shade},${shade},${shade},0.5)`;
      ctx.lineWidth = 0.4 + Math.random() * 0.6;
      ctx.beginPath();
      ctx.moveTo(x0, 0);
      ctx.bezierCurveTo(
        x0 + (Math.random() - 0.5) * 3, h * 0.33,
        x0 + (Math.random() - 0.5) * 3, h * 0.66,
        x0 + (Math.random() - 0.5) * 2, h
      );
      ctx.stroke();
    }
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(1, 5); // tile a few times up the 2.5m slat height
    return tex;
  }

  /**
   * Living-room acoustic wood slat panel — wall #1's room-facing (east) face +
   * the wall #3 step return, STRIVO Black Oak. Ported from the experimental
   * scene (buildAcousticPanelLivingRoomWall1Wall3).
   *
   * PATH: wall #1 (`{id:1, x1:x2:288.3, thickness:30}`) and wall #3
   * (`{id:3, x1:x2:307.4, thickness:15.8}`) are both vertical-in-plan and
   * near-parallel — #3 is thicker and widened room-ward so its east face sits
   * 12cm further into the living room than #1's, producing a real step at the
   * point #3 begins (y=707.8). The panel covers #1's face (north stop y=353.4,
   * south to the step y=707.8) plus that short 12cm perpendicular return. It
   * does NOT continue onto wall #3's own wide face (visual review
   * 2026-07-09 locked this "shorter reading"). Living room sits east (+x) of
   * both walls — this is the house's west EXTERIOR wall, so slats protrude +x
   * on #1's face and -z on the step.
   *
   * DIMENSIONS: STRIVO Black Oak (600x2400x21mm; 56mm slat / 19mm gap = 75mm
   * pitch). 21mm total split as 9mm felt backing + 12mm slat protrusion.
   *
   * FADE + BLACK-HALF: transparent:true + depthWrite:false initial (the panel
   * is a stack of ~15 near-coplanar transparent boxes → without depthWrite the
   * stacked alpha compounds, and worse, from certain angles the painter's-sort
   * paints the near-black backing over the slats = the "black-half" bug). The
   * fix lives in the render-loop fade block: depthWrite is toggled per-frame to
   * `opacity > 0.98` — depth-write while solid (z-buffer resolves the stack, no
   * black-half) and off once faded (preserves see-through). The meshes are
   * registered into wallMeshes so that render-loop fix + the exterior-fade
   * reach them. Each segment gets its OWN material pair (materialFactory) —
   * seg1 (#1 face, normal (1,0)) and seg2 (step, normal (0,-1)) fade on
   * different schedules; one shared material froze in a static tug-of-war.
   *
   * Standalone group — reads only #1/#3's published geometry, never touches
   * WALL_EXT, the wall loop, or either wall's own box material.
   */
  function buildAcousticPanelLivingRoomWall1Wall3(scene, wallMeshes) {
    const wall1 = WALLS.find(w => w.id === 1);
    const wall3 = WALLS.find(w => w.id === 3);
    if (!wall1 || !wall3) return;   // this house lacks those walls — nothing to panel
    const wall1ThicknessM = (wall1.thickness != null ? wall1.thickness : WT_CM) * S;
    const wall3ThicknessM = (wall3.thickness != null ? wall3.thickness : WT_CM) * S;
    const wall1FaceX = tx(wall1.x1) + wall1ThicknessM / 2;  // wall #1's room-facing (east) face
    const wall3FaceX = tx(wall3.x1) + wall3ThicknessM / 2;  // wall #3's room-facing (east) face — used only to size the step return
    const stepZ = tz(707.8);                    // wall #1 -> wall #3 transition (wall #3's north end); panel's south end

    const stepLen = wall3FaceX - wall1FaceX;    // step-face run: ~12.0cm
    const seg1NorthZ = tz(353.4);               // fixed north stop (locked, inside living_room y:303-749)
    const seg1Len = stepZ - seg1NorthZ;         // wall #1 face run, north stop to the step

    const slatW = 0.056, slatD = 0.012, backingD = 0.009;
    const nomGap = 0.019;
    const EPS = 0.005;

    const group = new THREE.Group();
    group.name = 'wall1-wall3-acoustic-panel-livingroom';

    // Light ASHY GREY-OAK (2026-07-11, review-flagged): the real #1 slats are a
    // light dove/ashy warm-grey with grey-brown wood grain — NOT the near-black
    // "STRIVO Black Oak" this used to render (backing 0x0e0b09 / slat 0x2b211c),
    // which read as an almost-black panel. Retoned to a light ashy warm-grey oak
    // in the #25 Acupanel family (the "looks perfect" reference) but greyer:
    // STRIVO Acoustic Slat Panel BLACK OAK (2026-07-11, product ref):
    // panelcompany.co.uk STRIVO Black Oak = a DARK charcoal/black-oak base with
    // SUBTLE lighter grey-brown vertical grain and dark recessed gaps. The "light
    // ashy" look in another reference photo was just bright window light hitting this dark
    // panel (the LIT appearance), not the base albedo. So the BASE is dark:
    //   slat  0x322e29 (dark warm-charcoal black-oak; warmer/greyer than dead-black
    //         0x0e0b09, darker than the ashy lit look) + grain roughnessMap for the
    //         subtle lighter grey-brown streaking seen in the product photo.
    //   backing 0x0e0b09 (near-black - correct for the DEEP recessed gaps between
    //         slats). Under bright light the charcoal reads lighter/ashy (the lit
    //         photo); in ambient it reads dark charcoal (product shots + dim render).
    // Roughness 0.6/0.95 = matte oak, no glossy sheen.
    // transparent:true so the render-loop exterior-fade can drive its opacity
    // (wall #1 is outer:1 → this panel fades see-through from outside).
    // materialFactory() makes a FRESH pair per segment so each segment owns its
    // own material (seg1 + seg2 now share a normal and fade in lockstep — see
    // the registration block below).
    // depthWrite:false INITIAL only — the render loop toggles it to
    // opacity>0.98 each frame (black-half fix, see scout-blackhalf report).
    const grainMap = makeOakGrainTexture();
    function materialFactory() {
      return {
        backing: new THREE.MeshStandardMaterial({ color: 0x0e0b09, roughness: 0.95, transparent: true, depthWrite: false }),
        slat: new THREE.MeshStandardMaterial({ color: 0x322e29, roughness: 0.6, roughnessMap: grainMap, transparent: true, depthWrite: false })
      };
    }

    const slatGeoZ = new THREE.BoxGeometry(slatD, WH, slatW);
    const slatGeoX = new THREE.BoxGeometry(slatW, WH, slatD);

    // Adds one straight run of slats + felt backing along world-z or world-x.
    // `normalSign` is the protrusion direction (+1/-1) on the perpendicular axis.
    // Returns the meshes so the caller can register them into wallMeshes.
    function addRun(axis, faceCoord, normalSign, spanStart, spanEnd, mats) {
      const runLen = Math.abs(spanEnd - spanStart);
      const nomPitch = slatW + nomGap;
      const n = Math.max(1, Math.round(runLen / nomPitch));
      const gap = n > 1 ? (runLen - n * slatW) / (n - 1) : 0;
      const pitch = slatW + gap;
      const start = Math.min(spanStart, spanEnd);

      const backingOuter = faceCoord + normalSign * EPS;
      const backingInner = backingOuter + normalSign * backingD;
      const backingCenter = (backingOuter + backingInner) / 2;
      const slatOuter = backingInner + normalSign * slatD;
      const slatCenter = (backingInner + slatOuter) / 2;

      const meshes = [];
      if (axis === 'z') {
        const backing = new THREE.Mesh(new THREE.BoxGeometry(backingD, WH, runLen), mats.backing);
        backing.position.set(backingCenter, WH / 2, (spanStart + spanEnd) / 2);
        backing.receiveShadow = true;
        group.add(backing);
        meshes.push(backing);
        for (let i = 0; i < n; i++) {
          const c = start + i * pitch + slatW / 2;
          const slat = new THREE.Mesh(slatGeoZ, mats.slat);
          slat.position.set(slatCenter, WH / 2, c);
          slat.castShadow = true;
          slat.receiveShadow = true;
          group.add(slat);
          meshes.push(slat);
        }
      } else {
        const backing = new THREE.Mesh(new THREE.BoxGeometry(runLen, WH, backingD), mats.backing);
        backing.position.set((spanStart + spanEnd) / 2, WH / 2, backingCenter);
        backing.receiveShadow = true;
        group.add(backing);
        meshes.push(backing);
        for (let i = 0; i < n; i++) {
          const c = start + i * pitch + slatW / 2;
          const slat = new THREE.Mesh(slatGeoX, mats.slat);
          slat.position.set(c, WH / 2, slatCenter);
          slat.castShadow = true;
          slat.receiveShadow = true;
          group.add(slat);
          meshes.push(slat);
        }
      }
      return { n, gap, meshes };
    }

    // Segment 1: wall #1 face, z from seg1NorthZ (north) to stepZ (south),
    // protrudes +x. Registered with wall #1's normal (1,0,outer:true).
    const seg1 = addRun('z', wall1FaceX, +1, seg1NorthZ, stepZ, materialFactory());
    if (wallMeshes) seg1.meshes.forEach(mesh => wallMeshes.push({ mesh, nx: 1, nz: 0, outer: true }));
    // Segment 2: step face (the SMALLER face near wall #1), x from wall1FaceX
    // to wall3FaceX, protrudes -z. Panel's south end (the pillar-#3 strip).
    // FADE-TOGETHER FIX (2026-07-11, review-flagged): register seg2 with the SAME
    // normal as seg1 (nx:1, nz:0 — wall #1's face normal) even though it
    // physically faces -z. The render-loop fade computes targetOpacity from
    // dot = nx*camDir.x + nz*camDir.z; giving both segments the identical normal
    // makes them compute the identical dot → identical target → they hide/show
    // in lockstep from every angle. With its own -z normal, seg2 crossed the
    // fade threshold at different camera angles than seg1, so the big face hid
    // while this pillar strip stayed solid (or vice versa). Keying the small
    // step off #1's normal is visually fine and keeps the two parts always in sync.
    const seg2 = addRun('x', stepZ, -1, wall1FaceX, wall3FaceX, materialFactory());
    if (wallMeshes) seg2.meshes.forEach(mesh => wallMeshes.push({ mesh, nx: 1, nz: 0, outer: true }));
    // Segment 3 (wall #3's own wide face) DELIBERATELY OMITTED per the owner's
    // 2026-07-09 visual review — wall #3's face stays bare wall.

    scene.add(group);
    return group;
  }

  /**
   * Build the full Three.js scene (walls, floors, furniture, lights).
   * Returns { scene, mainLights, mainMeshes, ambientLights, ambientMeshes }
   */
  function buildScene(scene, quality) {
    const mainLights = {}, mainMeshes = {}, ambientLights = {}, ambientMeshes = {};
    // Channels beyond 'main' and 'ambient' (a profile may declare any number --
    // the reference house had a 'galaxy' star projector). Keyed room -> channel.
    const extraLights = {}, extraMeshes = {};
    // quality = { tier, maxFragU, sunShadow, roomShadowLights, ambientStrips, shadowMapScale }
    // Set by create() based on the GPU's MAX_FRAGMENT_UNIFORM_VECTORS (and the
    // caller's `shadows` override). On low-uniform mobile GPUs (Z Fold 6 Adreno
    // = 256) the full light count blows past the shader's uniform limit and
    // nothing renders at all. The flags below trim per-tier so the shader fits.
    // shadowMapScale (default 1) shrinks shadow-map resolution for cheaper, very
    // slightly softer shadows (e.g. 0.25 => 2048->512) — used by the 'low' preset.
    const smScale = quality.shadowMapScale || 1;

    // Ambient + directional (intensities set by updateSunlight())
    const ambLight = new THREE.AmbientLight(0x252535, 0.3);
    scene.add(ambLight);
    const sun = new THREE.DirectionalLight(0xffeedd, 0.25);
    sun.position.set(10, 18, -5);
    sun.castShadow = quality.sunShadow;
    sun.shadow.mapSize.width = Math.round(2048 * smScale);
    sun.shadow.mapSize.height = Math.round(2048 * smScale);
    sun.shadow.camera.left = -15;
    sun.shadow.camera.right = 15;
    sun.shadow.camera.top = 15;
    sun.shadow.camera.bottom = -15;
    sun.shadow.camera.near = 0.5;
    sun.shadow.camera.far = 40;
    sun.shadow.bias = -0.0005;
    scene.add(sun);

    // Ground (color updated by updateSunlight)
    const gndMat = new THREE.MeshStandardMaterial({ color: 0x181828, roughness: 0.9 });
    // Sized and centred on THIS house's footprint (it used to be a fixed 30 m
    // square at one specific plan coordinate, which left a larger house sitting
    // off the edge of its own ground).
    const _groundSpan = Math.max(30, Math.max(
      (HOUSE.footprint.maxX - HOUSE.footprint.minX) * S,
      (HOUSE.footprint.maxY - HOUSE.footprint.minY) * S
    ) * 3);
    const gnd = new THREE.Mesh(new THREE.PlaneGeometry(_groundSpan, _groundSpan), gndMat);
    gnd.rotation.x = -Math.PI / 2;
    gnd.position.set(tx(HOUSE.centre[0]), -0.02, tz(HOUSE.centre[1]));
    gnd.receiveShadow = true;
    scene.add(gnd);

    // Walls — each gets its own material for per-wall opacity.
    // Where a door sits on a segment, the segment is split into full-height
    // sub-boxes around the opening plus a lintel box above it (OPEN_H up to the
    // wall top) so the wall stays solid above head height. Every resulting
    // sub-box is pushed into wallMeshes with the segment's ORIGINAL rotation,
    // normal and `outer` flag — the exterior-fade animation depends on those.
    // Matte-plaster roughness texture: one shared instance for every wall
    // material below (same object, not cloned — a single GPU upload). Gated
    // on GPU tier the same way ambientStrips is ('low' tier goes flat colour,
    // matching how the low tier already sheds the heaviest per-frame costs).
    const wallRoughMap = quality.tier !== 'low' ? makeWallRoughnessTexture() : null;

    // WALL FACE TEXTURES ---------------------------------------------------
    // A per-face material array lets a single wall box carry an image on ONE of
    // its 6 local faces (BoxGeometry default order [+x,-x,+y,-y,+z,-z]) while
    // every other face keeps the plain wall material. Which face is named by the
    // profile as a COMPASS side (`faceTexture.side`), because that is how a
    // person describes it standing in the room; it is resolved to a local box
    // face here against the wall's own orientation.
    //
    // The reference implementation hardcoded two image paths pointing into a
    // deploy directory, and kept a DUPLICATE COPY of each PNG so a deploy hook
    // that copied only one tree would still ship them. Profile-relative texture
    // paths retire that hack entirely: a texture lives in the house directory
    // beside the profile that references it.
    const wallTexLoader = new THREE.TextureLoader();

    /**
     * Compass side -> local BoxGeometry face for a wall.
     *
     * A wall box is built along its own long axis. For a wall running east-west
     * (x1 != x2, y1 == y2) the box's local +z/-z faces point south/north; for a
     * wall running north-south the local +x/-x faces point east/west. Returns
     * 'px' or 'nx' — the two the material builder below understands — or null
     * when the requested side is an END of the wall rather than a long face.
     */
    function sideToFaceAxis(wall, side) {
      const horizontal = Math.abs(wall.y1 - wall.y2) < Math.abs(wall.x1 - wall.x2);
      if (horizontal) {
        // Long faces look north and south.
        if (side === 'south') return 'px';
        if (side === 'north') return 'nx';
      } else {
        // Long faces look east and west.
        if (side === 'east') return 'px';
        if (side === 'west') return 'nx';
      }
      return null;
    }

    /**
     * The stretch of a north-south wall's line that a room's polygon fronts,
     * as [minY, maxY] in plan cm — or null if the room does not front it.
     *
     * Taken from the polygon rather than the room's bounding box: an L-shaped
     * room's box spans far more of the wall than the room's own edge does. The
     * hallway's box runs y 13.2..293.6 while the edge that actually fronts wall
     * #22 runs 95.6..293.6, so the box would claim ~0.9 m of wall that in fact
     * fronts a different room.
     */
    function _roomEdgeSpanOnWall(wall, roomId) {
      const room = ROOMS[roomId];
      if (!room || !Array.isArray(room.poly) || room.poly.length < 2) return null;
      if (Math.abs(wall.x1 - wall.x2) >= 0.5) return null;   // north-south walls only
      // The room's face sits half a wall thickness off the centreline, so allow
      // a little more than that — but stay tight enough to reject the room's
      // OTHER vertical edges (for the hallway the next-nearest is 37.5 cm away,
      // against the true edge's 9.5 cm).
      const tol = (wall.thickness != null ? wall.thickness : WT_CM) * 1.6;
      const ys = [];
      for (let i = 0; i < room.poly.length; i++) {
        const a = room.poly[i], b = room.poly[(i + 1) % room.poly.length];
        if (Math.abs(a[0] - b[0]) < 0.5 && Math.abs(a[0] - wall.x1) < tol) ys.push(a[1], b[1]);
      }
      if (!ys.length) return null;
      return [Math.min.apply(null, ys), Math.max.apply(null, ys)];
    }

    /**
     * Does `roomId` front effectively the WHOLE of this wall's face?
     *
     * Decides which of the two papering passes owns the wall (see their call
     * sites). The threshold is loose because a room polygon is inset from the
     * wall centreline at each end, so a room running the full length still
     * measures a few centimetres short of it.
     */
    function _roomCoversWholeFace(wall, roomId) {
      const span = _roomEdgeSpanOnWall(wall, roomId);
      if (!span) return false;
      const wallLen = Math.abs(wall.y2 - wall.y1);
      if (wallLen <= 0) return false;
      return ((span[1] - span[0]) / wallLen) >= 0.9;
    }

    /**
     * Will the room-clipped overlay pass actually build this wall?
     *
     * The two papering passes must partition the papered walls between them:
     * whatever the overlay will NOT build has to stay with the material array,
     * or the texture is simply lost. The overlay only handles a partly-fronted
     * NORTH-SOUTH wall, so an east-west wall keeps the array however little of
     * it the room fronts — the demo house papers an east-west wall exactly this
     * way, and routing it to the overlay would have made its texture disappear.
     */
    function _overlayPassOwns(wall, roomId) {
      if (!roomId) return false;
      if (Math.abs(wall.x1 - wall.x2) >= 0.5) return false;   // east-west: array's
      return !_roomCoversWholeFace(wall, roomId);
    }

    // wall id -> { faceAxis, url } for every wall the profile papers.
    const WALL_FACE_TEXTURES = {};
    Object.keys(HOUSE.wallFaceTextures).forEach(wid => {
      const ft = HOUSE.wallFaceTextures[wid];
      const wall = HOUSE.wallsById[wid];
      if (!wall) return;
      // EXACTLY ONE pass may paper a wall. There are two, and which is right
      // depends on how much of the wall the clipped room actually fronts:
      //
      //   whole face  -> this pass, a 6-entry material array on the wall box
      //                  (cheaper, and it tracks the wall's own geometry).
      //   part of it  -> the room-clipped OVERLAY pass further down, which
      //                  builds thin panels over just that stretch.
      //
      // Running both is what put wall #22's monstera on the hallway's INSIDE
      // face: the overlay drew it correctly on the west face while the material
      // array simultaneously painted the whole wall box, so the image showed up
      // on the far side too. The array cannot express a partial run, so a wall
      // the room only partly fronts is left entirely to the overlay. Wall #25,
      // whose home_office face IS fronted end to end, keeps the array — as does
      // any wall the overlay pass would not build at all.
      if (_overlayPassOwns(wall, ft.clipToRoom)) return;
      const faceAxis = sideToFaceAxis(wall, ft.side);
      if (!faceAxis) {
        console.warn(
          '[Home3DScene] wall ' + wid + ' asks for a texture on its "' + ft.side + '" face, but that ' +
          'is an END of the wall, not one of its two long faces — ignored.'
        );
        return;
      }
      WALL_FACE_TEXTURES[wid] = { faceAxis: faceAxis, url: ft.url };
    });

    function buildFaceTexturedMaterials(faceAxis, url, plainMatFactory, lm, h, isOuter) {
      // Start as the ordinary wall paint. If the image loads it is applied on
      // top; if it does NOT (a profile referencing a texture that was not
      // shipped, a 404, a zero-byte placeholder) the wall simply stays painted.
      // Without this the face rendered as an unlit black panel, which looks like
      // a hole in the building rather than a missing decoration -- and a missing
      // texture is exactly what happens when a house profile is shared without
      // its images, so it has to degrade gracefully.
      const wallpaperMat = new THREE.MeshStandardMaterial({
        color: WALL_COLOR,
        roughness: 0.85, side: THREE.DoubleSide,
        transparent: !!isOuter, opacity: 1
      });
      wallTexLoader.load(url, (tex) => {
        if (!tex.image || !tex.image.width || !tex.image.height) {
          console.warn('[Home3DScene] wall texture "' + url + '" decoded to an empty image; ' +
            'leaving the wall painted.');
          return;
        }
        if ('colorSpace' in tex) tex.colorSpace = THREE.SRGBColorSpace; // r152+
        else tex.encoding = THREE.sRGBEncoding; // older three.js fallback
        tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
        // 1) object-fit:cover against the REAL visible rect (lm x WH, metres,
        //    not the padded box height h) — crop the excess dimension evenly so
        //    the photo is never stretched.
        const imgAspect = tex.image.width / tex.image.height;
        const boxAspect = lm / WH;
        let coverRX, coverOX, coverRY, coverOY;
        if (imgAspect >= boxAspect) {
          coverRX = boxAspect / imgAspect; coverOX = (1 - coverRX) / 2;
          coverRY = 1; coverOY = 0;
        } else {
          coverRX = 1; coverOX = 0;
          coverRY = imgAspect / boxAspect; coverOY = (1 - coverRY) / 2;
        }
        // 2) Re-target the cover-fit rect onto the box's ACTUAL V-range. Every
        //    wall box is padded below the floor so the wall never gaps at the
        //    seam; map the cover-fit V onto the visible sub-range [vFloor,1] so
        //    the photo isn't squeezed by the padding.
        const vFloor = (h - WH) / h; // box-space V where world Y=0 (floor) sits
        const rY = coverRY / (1 - vFloor);
        const oY = coverOY - rY * vFloor;
        tex.repeat.set(coverRX, rY);
        tex.offset.set(coverOX, oY);
        tex.needsUpdate = true;
        // The map multiplies the material colour, so drop the paint tint to
        // white or the photo would be shaded by it.
        wallpaperMat.color.setHex(0xffffff);
        wallpaperMat.map = tex;
        wallpaperMat.needsUpdate = true;
      }, undefined, () => {
        console.warn('[Home3DScene] wall texture "' + url + '" could not be loaded; ' +
          'leaving the wall painted.');
      });
      const plain = plainMatFactory();
      // BoxGeometry material groups, order [+x,-x,+y,-y,+z,-z].
      return faceAxis === 'px'
        ? [wallpaperMat, plain, plain, plain, plain, plain]
        : [plain, wallpaperMat, plain, plain, plain, plain];
    }

    const wallMeshes = [];
    // HEIGHTS REMODEL (2026-07-11, ACK'd) — wall vertical extents now depend
    // on the `outer` flag, and top at the CEILING UNDERSIDE (y=WH), not the
    // ceiling top:
    //   • INTERNAL walls (outer:0) span EXACTLY the room interior: y = 0 .. WH
    //     (from the floor's walkable TOP face to the ceiling's UNDERSIDE). They
    //     no longer poke into the floor slab below y=0 or the ceiling slab above
    //     WH. Height = WH, centred at WH/2.
    //   • EXTERNAL walls (outer:1, incl. pillars #3/#12/#26/#31) span the full
    //     floor slab up to the ceiling underside: y = -0.15 .. WH (start below,
    //     through the 15cm floor slab; STOP at the ceiling underside — NOT up
    //     through the ceiling). Height = WH+0.15, centred at (WH-0.15)/2.
    // (Previously ALL walls spanned -0.15..WH+0.15, poking into both slabs.)
    // Doors sit at floor level (y=0) with OPEN_H=2.07 < WH=2.5, so internal
    // walls at height WH still frame every door + lintel comfortably.
    const WALL_INT_BOTTOM_Y = 0;          // internal walls start at floor top
    const WALL_EXT_BOTTOM_Y = -0.15;      // external walls start at floor bottom
    const WALL_TOP_Y = WH;                // BOTH cap at the ceiling underside
    WALL_EXT.forEach(({ id, x1, y1, x2, y2, outer, thickness }) => {
      // Per-wall vertical geometry, keyed off the outer flag (see block above).
      const WALL_BOTTOM_Y = outer ? WALL_EXT_BOTTOM_Y : WALL_INT_BOTTOM_Y;
      const WALL_YC = (WALL_TOP_Y + WALL_BOTTOM_Y) / 2;
      const WALL_FULL_H = WALL_TOP_Y - WALL_BOTTOM_Y;
      const wx1 = tx(x1), wz1 = tz(y1), wx2 = tx(x2), wz2 = tz(y2);
      const dx = wx2 - wx1, dz = wz2 - wz1;
      const len = Math.sqrt(dx*dx + dz*dz);
      if (len < 0.01) return;
      const angle = Math.atan2(dx, dz);
      const nx = Math.cos(angle), nz = -Math.sin(angle);
      // Per-wall thickness (m) — `thickness` (cm) always arrives set on
      // WALL_EXT entries (defaults to WT_CM there), so this is WT for every
      // wall except #3, which overrides it. Same units conversion WT itself
      // was defined with (WT_CM * S === WT).
      const wallWidthM = thickness * S;
      // One wall box centred at (mx,mz): length lm (m), vertical centre yc, height h.
      // Reuses the segment's rotation + normal so sub-boxes of a descending
      // segment don't flip their exterior-fade direction.
      const addWallBox = (mx, mz, lm, yc, h) => {
        if (lm < 0.01) return;
        // TRANSPARENCY BUG FIX (LEARNINGS #50): only OUTER walls (exterior shell +
        // the feature pillars #3/#12/#26/#31, outer:1) ever fade, so only they need
        // to live in the transparent render pass. INTERIOR partitions (outer:0) never
        // fade — making them transparent:true put them in the transparent pass with
        // unreliable depth-write, so a faded exterior wall in front of them made them
        // read as see-through (e.g. #25 from the SE corner). Keying transparent off
        // `outer` puts partitions in the normal OPAQUE pass → they stay solid behind
        // faded shell walls. Outer/pillar fade behaviour is unchanged.
        const plainMatFactory = () => new THREE.MeshStandardMaterial({
          color: WALL_COLOR, roughness: 0.82, roughnessMap: wallRoughMap,
          side: THREE.DoubleSide, transparent: !!outer, opacity: 1
        });
        // Face-textured walls (e.g. #25 home_office wallpaper mural) get a
        // 6-material array with the photo on one local face + plain on the rest;
        // every other wall keeps the single plain material. (zabine-wall25.)
        const faceTex = WALL_FACE_TEXTURES[id];
        const mat = faceTex
          ? buildFaceTexturedMaterials(faceTex.faceAxis, faceTex.url, plainMatFactory, lm, h, outer)
          : plainMatFactory();
        const wall = new THREE.Mesh(new THREE.BoxGeometry(wallWidthM, h, lm), mat);
        wall.position.set(mx, yc, mz);
        wall.rotation.y = angle;
        wall.castShadow = true;
        wall.receiveShadow = true;
        scene.add(wall);
        wallMeshes.push({ mesh: wall, nx, nz, outer: !!outer });
      };
      const horiz = Math.abs(y2 - y1) < 0.01, vert = Math.abs(x2 - x1) < 0.01;
      // Doors sitting on this segment
      const dts = DOORS.filter(d => {
        if (d.wall === 'x' && horiz && Math.abs(y1 - d.at) < 1.5) {
          const lo = Math.min(x1, x2), hi = Math.max(x1, x2);
          return d.c > lo - 1 && d.c < hi + 1;
        }
        if (d.wall === 'z' && vert && Math.abs(x1 - d.at) < 1.5) {
          const lo = Math.min(y1, y2), hi = Math.max(y1, y2);
          return d.c > lo - 1 && d.c < hi + 1;
        }
        return false;
      });
      if (dts.length === 0) {
        addWallBox((wx1+wx2)/2, (wz1+wz2)/2, len, WALL_YC, WALL_FULL_H);
        return;
      }
      // Carve openings along the wall axis. a..b are cm coords along the axis.
      const boxAt = (a, b, yc, h) => {
        if (b - a < 1) return; // skip sub-centimetre slivers
        const mid = (a + b) / 2;
        addWallBox(horiz ? tx(mid) : wx1, horiz ? wz1 : tz(mid), (b - a) * S, yc, h);
      };
      const p1 = horiz ? x1 : y1, p2 = horiz ? x2 : y2;
      const lo = Math.min(p1, p2), hi = Math.max(p1, p2);
      const ops = dts.map(d => {
        const cw = d.w + 2 * REVEAL_CM;
        return { a: d.c - cw / 2, b: d.c + cw / 2 };
      }).sort((u, v) => u.a - v.a);
      let cur = lo;
      ops.forEach(o => {
        boxAt(cur, Math.min(Math.max(o.a, lo), hi), WALL_YC, WALL_FULL_H);
        cur = Math.max(cur, Math.min(o.b, hi));
      });
      boxAt(cur, hi, WALL_YC, WALL_FULL_H);
      // Lintel above each opening (wall remains from OPEN_H up to the wall top,
      // now WALL_TOP_Y = WH = the ceiling underside, so the lintel caps the
      // opening up to the ceiling — no longer through the ceiling slab).
      ops.forEach(o => {
        const a = Math.max(o.a, lo), b = Math.min(o.b, hi);
        boxAt(a, b, (OPEN_H + WALL_TOP_Y) / 2, WALL_TOP_Y - OPEN_H);
      });
    });

    // ---- Hallway wallpaper overlay — wall #22, hallway segment ONLY ----
    // a real photographed monstera wallpaper (photowall.co.uk product shot)
    // on wall #22's HALLWAY-facing (west) surface. Ported from the experimental
    // scene (bunmi-wall22, 2026-07-11). Unlike wall #25's 6-material-array trick
    // (buildFaceTexturedMaterials), #22 already has 2 doors carved into it
    // (Bathroom c=145.0, En-suite c=389.7, both wall:'z' at:1068.9) — touching
    // #22's own box/material construction would risk those openings — so this is
    // a SEPARATE thin flush-mounted overlay mesh on the hallway face only, the
    // same technique the acoustic panels use. Zero collision risk with the
    // door-carving loop above.
    //
    // #22 SPLIT QUESTION — ANSWERED (scout-textures): NO split. The experimental
    // 3-segment version (ids 22/48/49) was a wall-thickness-remap artifact, not a
    // wallpaper requirement. LIVE R4 #22 is ONE uniform vertical wall
    // {x=1068.9, y 91.2..455.4, thk 10}, so this is a single run.
    //
    // Clip to the HALLWAY portion only: hallway borders #22 for y 95.6..293.6
    // (ROOMS.hallway.poly east edge: [1059.4,95.6],[1059.4,293.6]). South of
    // ~293.6 the west side faces home_office (not hallway), so the wallpaper
    // stops there. Only the Bathroom door (c=145.0) falls inside this range; the
    // overlay skips its opening and keeps the lintel above it. (En-suite door
    // c=389.7 is outside the clip and never sees wallpaper.)
    //
    // outer:0 (interior partition) → these overlays never fade, so they are NOT
    // pushed into wallMeshes (no exterior-fade wiring). Gated on quality.tier
    // like every other procedural/photo texture — 'low' tier stays plain wall.
    // Runs for EVERY wall whose profile entry asks for a texture clipped to one
    // room (`faceTexture.clipToRoom`). A long wall often runs past several rooms
    // while the paper covers only one of them; without the clip the image
    // stretches across the whole run. Which wall, which room and which image are
    // all profile data — this used to be hardcoded for one wall and one room.
    Object.keys(HOUSE.wallFaceTextures).forEach(_wid => {
      const _overlaySpec = HOUSE.wallFaceTextures[_wid];
      if (!_overlaySpec.clipToRoom) return;
      const _clipRoom = ROOMS[_overlaySpec.clipToRoom];
      if (!_clipRoom) return;
      // Only north-south walls take this path today (the clip is expressed as a
      // y-range along the wall). An east-west wall keeps the whole-face texture
      // built in the wall loop above.
      const wall22 = WALL_EXT.find(w => String(w.id) === String(_wid) && Math.abs(w.x1 - w.x2) < 0.5);
      if (wall22 && quality.tier !== 'low') {
        const panelThicknessM = 0.006; // thin flush overlay, nudged outward to avoid z-fighting with the wall's own face
        const overlayTexUrl = _overlaySpec.url;
        // The clipped room's extent along the wall, from the room's DERIVED
        // bounding box — authoritative, and not the wall's full span, which
        // continues past the room into its neighbours.
        // Clip to the stretch of wall the room ACTUALLY fronts, taken from the
        // room polygon — not from its bounding box. An L-shaped room's bbox
        // spans far more of the wall than the room's own edge does: the hallway
        // bbox runs y 13.2..293.6, while the polygon edge that fronts wall #22
        // runs only y 95.6..293.6. Using the bbox papered ~0.9 m of wall that
        // fronts a different room entirely, and stretched the mural to fit it.
        //
        // A wall the room fronts ENTIRELY was already papered by the material
        // array in the wall loop above, which is the better path for a full
        // face; papering it again here would double the image up.
        if (_roomCoversWholeFace(wall22, _overlaySpec.clipToRoom)) return;
        const _span = _roomEdgeSpanOnWall(wall22, _overlaySpec.clipToRoom);
        const northY = _span ? _span[0] : _clipRoom.y1;
        const southY = _span ? _span[1] : _clipRoom.y2;
        // #22 rotation is exactly 180deg (dx=0, dz<0 => atan2 = pi), but a box
        // rotated by pi stays axis-aligned in world space (thickness spans world
        // X, length spans world Z, mirrored). West (lower world X) = hallway
        // side; the overlay needs no rotation, only correct X placement.
        const wallThicknessM = (wall22.thickness != null ? wall22.thickness : WT_CM) * S;
        const centerlineX = tx(wall22.x1);
        const faceX = centerlineX - wallThicknessM / 2;      // hallway-facing (west) face
        const overlayX = faceX - panelThicknessM / 2;        // sit the overlay just proud of it
        const overlayPanels = []; // {tex} collected for deferred image attach
        // STRETCH-TO-FIT, ONE COPY, NO TILING. the monstera is a single mural
        // image, not a repeating pattern — so the wallpaper maps as ONE continuous
        // image STRETCHED across the ENTIRE hallway portion of #22's face (the
        // full image UV 0..1 spans the whole hallway rect: Z northY..southY, Y
        // floor..ceiling). The Bathroom door splits that face into >1 mesh, so
        // each panel samples its OWN sub-window of the single stretched image
        // (continuous UVs) — the leaves line up across the door/lintel seam and
        // there is exactly ONE monstera on the wall, never a per-panel full copy
        // and never a repeated tile grid. ClampToEdgeWrapping (never wrap/tile);
        // a per-panel repeat<1 samples a CROP-slice of the one image, it does not
        // repeat it. Full-face reference rect:
        const faceZ0 = tz(northY), faceZ1 = tz(southY);   // world-Z extent of the hallway face
        const faceLen = Math.abs(faceZ1 - faceZ0);         // total run length (m)
        const faceZMin = Math.min(faceZ0, faceZ1);         // near (min-Z) edge of the face
        const faceY0 = 0, faceY1 = WH;                     // floor .. ceiling underside
        const faceH = faceY1 - faceY0;
        // Build one overlay panel covering [a,b] (cm along Z) at vertical centre
        // yc / height h (m). Its UV window is its own position WITHIN the full
        // face rect → one stretched image; the panel just samples its slice.
        const addOverlayPanel = (a, b, yc, h) => {
          const lm = (b - a) * S;
          if (lm < 0.01 || h < 0.01) return;
          const zc = tz((a + b) / 2);                       // panel centre in world Z
          const tex = new THREE.Texture();
          tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping; // never tile
          // U spans this panel's Z-slice of the whole face; V its Y-slice.
          const uRepeat = lm / faceLen;
          const uOffset = (zc - lm / 2 - faceZMin) / faceLen;
          const yBottom = yc - h / 2;
          const vRepeat = h / faceH;
          const vOffset = (yBottom - faceY0) / faceH;        // V=0 at floor
          tex.repeat.set(uRepeat, vRepeat);
          tex.offset.set(uOffset, vOffset);
          const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.88 });
          const mesh = new THREE.Mesh(new THREE.BoxGeometry(panelThicknessM, h, lm), mat);
          mesh.position.set(overlayX, yc, zc);
          mesh.receiveShadow = true;
          // HIDDEN UNTIL THE IMAGE ARRIVES. tex is an empty THREE.Texture until
          // the loader fills it in, and an empty map samples black -- so a
          // profile whose texture is missing or 404s would paste a black panel
          // over the wall, which reads as a hole in the building. The panel is
          // only shown once a real image is in hand; otherwise the wall behind
          // it simply stays as it is.
          mesh.visible = false;
          scene.add(mesh);
          overlayPanels.push({ tex, mesh });
        };
        // Mirror the main door-carving loop's solid/opening split for whichever
        // doors on this wall fall inside the hallway clip — found live (not
        // assumed to be "just the Bathroom door") so a future door move reflows.
        // The wallpaper skips each door opening but DOES continue over the lintel
        // above it (solid wall there). Matched against wall22.x1.
        const doorOps = DOORS.filter(d => d.wall === 'z' && Math.abs(d.at - wall22.x1) < 1.5 &&
            d.c > northY && d.c < southY)
          .map(d => ({ a: d.c - (d.w + 2 * REVEAL_CM) / 2, b: d.c + (d.w + 2 * REVEAL_CM) / 2 }))
          .sort((u, v) => u.a - v.a);
        let cur = northY;
        doorOps.forEach(op => {
          const a = Math.max(op.a, northY), b = Math.min(op.b, southY);
          addOverlayPanel(cur, a, WH / 2, WH);                        // solid, floor-to-ceiling up to the opening
          addOverlayPanel(a, b, (OPEN_H + WH) / 2, WH - OPEN_H);      // lintel above the opening only
          cur = Math.max(cur, b);
        });
        addOverlayPanel(cur, southY, WH / 2, WH);                     // solid run south of the last opening
        // Load the shared photo once; hand its decoded image to every panel.
        // Each panel's UV window (repeat/offset) was already set at build time
        // from its slice of the full face, so here we only attach the image —
        // one stretched monstera across the whole hallway face, no tiling.
        // (Panels are built synchronously above, so this async callback always
        // sees the full set — same pattern as wall #25's wallpaper.)
        if (overlayPanels.length) {
          new THREE.TextureLoader().load(
            overlayTexUrl,
            (loaded) => {
              const img = loaded.image;
              if (!img || !img.width || !img.height) {
                console.warn('[Home3DScene] wall overlay texture "' + overlayTexUrl +
                  '" decoded to an empty image; leaving the wall as it is.');
                return;
              }
              overlayPanels.forEach(p => {
                p.tex.image = img;
                if ('colorSpace' in p.tex) p.tex.colorSpace = THREE.SRGBColorSpace; // r152+
                else p.tex.encoding = THREE.sRGBEncoding; // older three.js fallback
                p.tex.needsUpdate = true;
                p.mesh.visible = true;
              });
            },
            undefined,
            () => console.warn('[Home3DScene] wall overlay texture "' + overlayTexUrl +
              '" could not be loaded; leaving the wall as it is.')
          );
        }
      }
    });

    // === Door assemblies (frame + swinging slab + handles, per DoorSpec) ===
    // One Group per door pivoted at the hinge edge; slab + grooves + mirrored
    // handles + frame as children. The pivot rotates on Y by a fixed-sign,
    // clamped-non-negative angle — one-direction swing only. Max angles are
    // collision-solved (computeDoorAngles) so no two fully-open leaves ever
    // intersect; the rendered rest pose is DOOR_REST of each door's solved max.
    // doorByRoom: ROOMS key → live door record, driving the panel's per-room
    // openness slider via the getDoorOpen/setDoorOpen API below (UI only — no HA).
    const doorByRoom = {};
    {
      // Same paint as the walls (DOOR_SLAB_COLOR/frameMat both derive from
      // WALL_COLOR) — differentiation from the wall's matte-plaster finish is
      // via roughness only (wood-grain-under-paint reads a touch smoother/less
      // matte than plasterboard), not a second texture, to keep this cheap.
      const slabMat = new THREE.MeshStandardMaterial({ color: DOOR_SLAB_COLOR, roughness: 0.6 });
      const frameMat = new THREE.MeshStandardMaterial({ color: WALL_COLOR, roughness: 0.5 });
      const chromeMat = new THREE.MeshStandardMaterial({ color: 0xCFD6DA, roughness: 0.25, metalness: 0.85 });
      const grooveMat = new THREE.MeshStandardMaterial({ color: 0xCBC3B4, roughness: 0.8 });
      // Front-door-only leaf material + seam colour (frame stays frameMat —
      // only the swinging slab changes). Same MeshStandardMaterial, zero new
      // draw calls or textures — reuses the existing groove-box technique
      // below with a different count/colour, not a new rendering path.
      const frontDoorSlabMat = new THREE.MeshStandardMaterial({ color: FRONT_DOOR_COLOR, roughness: 0.65 });
      const frontDoorGrooveMat = new THREE.MeshStandardMaterial({ color: FRONT_DOOR_GROOVE_COLOR, roughness: 0.9 });
      const V = THREE.Vector3;
      const doorLeafMatCache = {};
      const doorAngles = computeDoorAngles(DOORS); // collision-aware max open angles (deg)
      DOORS.forEach((d, di) => {
        // A front door gets an exterior finish (a darker leaf, an extra groove).
        // Keyed off the profile's `kind`, NOT off the door's display label --
        // matching the English string "Front door" meant a house whose door was
        // labelled anything else, in any other language, silently rendered as an
        // internal door. `kind` is the schema's field for exactly this.
        const isFrontDoor = d.kind === "front";
        const w = d.w * S, H = DOOR_H, T = DOOR_T;
        // opening centre in world (on the wall line, at floor level)
        const oc = d.wall === 'x' ? new V(tx(d.c), 0, tz(d.at)) : new V(tx(d.at), 0, tz(d.c));
        // along = unit vector hinge->latch; normal = unit vector into the room the door opens into
        let along, normal;
        if (d.wall === 'x') {
          along = new V(d.hinge === 'w' ? 1 : -1, 0, 0);
          normal = new V(0, 0, d.swing === 's' ? 1 : -1);
        } else {
          along = new V(0, 0, d.hinge === 'n' ? 1 : -1);
          normal = new V(d.swing === 'e' ? 1 : -1, 0, 0);
        }
        const hingeWorld = oc.clone().addScaledVector(along, -w / 2);
        // mount: rotate about Y so local +X points along `along`
        const theta = Math.atan2(-along.z, along.x);
        const mount = new THREE.Group();
        mount.position.copy(hingeWorld);
        mount.rotation.y = theta;
        scene.add(mount);
        // static frame: jambs + head (mount-local: x 0..w, y up, z across wall thickness).
        // Jamb width = REVEAL_CM so the frame fully plugs the carved reveal gap.
        const fj = REVEAL_CM * S, fdep = WT * 1.4, fh = 0.06;
        const jamb = lx => {
          const m = new THREE.Mesh(new THREE.BoxGeometry(fj, H + fh, fdep), frameMat);
          m.position.set(lx, (H + fh) / 2, 0);
          m.castShadow = true;
          mount.add(m);
        };
        jamb(-fj / 2);
        jamb(w + fj / 2);
        const head = new THREE.Mesh(new THREE.BoxGeometry(w + 2 * fj, fh, fdep), frameMat);
        head.position.set(w / 2, H + fh / 2, 0);
        head.castShadow = true;
        mount.add(head);
        // swinging leaf: pivot at the hinge (local origin); leaf extends +X to the latch edge
        const pivot = new THREE.Group();
        mount.add(pivot);
        const maxDeg = Math.max(0, doorAngles[di] ?? d.ang ?? 90);
        const restRad = maxDeg * DOOR_REST * Math.PI / 180;
        // local +Z maps to this world dir; fixed sign so the leaf only ever swings toward `normal`
        const locZ = new V(Math.sin(theta), 0, Math.cos(theta));
        const swingSign = locZ.dot(normal) > 0 ? -1 : 1;
        pivot.rotation.y = swingSign * restRad;
        mount.userData = { doorId: d.name, maxAngleDeg: maxDeg, swingSign };
        if (d.room) doorByRoom[d.room] = { name: d.name, pivot, maxDeg, swingSign, openPct: DOOR_REST * 100 };
        // A door may name its own leaf colour in the profile; otherwise a front
        // door gets the exterior finish and everything else the house's default
        // internal slab colour. Per-door materials are cached so a house with
        // many same-coloured doors still shares one material.
        let leafMat;
        if (d.color) {
          const key = String(d.color).toLowerCase();
          if (!doorLeafMatCache[key]) {
            doorLeafMatCache[key] = new THREE.MeshStandardMaterial({
              color: new THREE.Color(d.color), roughness: 0.65
            });
          }
          leafMat = doorLeafMatCache[key];
        } else {
          leafMat = isFrontDoor ? frontDoorSlabMat : slabMat;
        }
        const slab = new THREE.Mesh(new THREE.BoxGeometry(w, H, T), leafMat);
        slab.position.set(w / 2, H / 2, 0);
        slab.castShadow = true;
        slab.receiveShadow = true;
        pivot.add(slab);
        // subtle panel grooves on both faces — front door gets 5 horizontal
        // bands with a dark recessed seam (wood-plank look off the reference
        // photo); every other door keeps the original 4-band light groove.
        const NG = isFrontDoor ? 5 : 4, secH = H / NG;
        const gMat = isFrontDoor ? frontDoorGrooveMat : grooveMat;
        for (let i = 1; i < NG; i++) for (const sgn of [1, -1]) {
          const g = new THREE.Mesh(new THREE.BoxGeometry(Math.max(w - 0.1, 0.05), 0.02, 0.006), gMat);
          g.position.set(w / 2, secH * i, sgn * (T / 2));
          pivot.add(g);
        }
        // lever handle near the latch edge, mirrored on both faces
        const hx = w - 0.06, hy = H * 0.45;
        [1, -1].forEach(zs => {
          const hg = new THREE.Group();
          const ros = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.01, 16), chromeMat);
          ros.rotation.x = Math.PI / 2;
          ros.position.set(0, 0, zs * (T / 2 + 0.005));
          hg.add(ros);
          const lev = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.02, 0.02), chromeMat);
          lev.position.set(-0.04, 0, zs * (T / 2 + 0.03));
          hg.add(lev);
          hg.position.set(hx, hy, 0);
          pivot.add(hg);
        });
      });
    }

    // ── Single house-wide FLOOR + CEILING slabs (2026-07-10 cascade rework) ──
    // we decoupled the two concerns: (1) ONE visible tile floor + ONE ceiling,
    // both bounded by the walls, each a real 15cm-thick extruded solid; (2)
    // per-room INVISIBLE click-catcher meshes carry the roomId for "click room ->
    // light controls" (the visible floor is single, so it can't carry per-room
    // ids). Rugs are separate objects on top of the tile in the bedroom +
    // home_office. Built once, up front, before the room loop.
    //
    // HEIGHTS REMODEL (2026-07-11, ACK'd): the FLOOR reaches the INNER
    // (room-facing) faces of the walls (SLAB_POLY, unchanged) while the CEILING
    // reaches the OUTER faces (CEIL_POLY, below) — they are NO LONGER the same
    // outline. External walls run y -0.15 .. WH (through the floor, up to the
    // ceiling underside); internal walls run y 0 .. WH (see the wall build above).
    //
    // BOTH OUTLINES ARE NOW DERIVED FROM THE PROFILE. They used to be two
    // hand-traced rings describing one specific flat, re-traced by hand whenever
    // a wall moved.
    //
    // FLOOR — the room interior. Every room polygon is laid down, so the floor
    // covers exactly the rooms the profile declares and nothing else; external
    // walls sit ON it. Using the ROOMS rather than the wall footprint is what
    // keeps a re-entrant plan (an L, a cut corner, a courtyard) correct without
    // anyone tracing its outline: a notch is simply a place where no room is.
    //
    // CEILING — the full building envelope, out to the OUTER faces of the
    // exterior walls, so it caps over them. Each exterior wall contributes its
    // own slab rectangle (centreline expanded by half its thickness); together
    // with the rooms that is the envelope. Floor and ceiling are deliberately
    // NOT the same outline: external walls run from below the floor up to the
    // ceiling underside, internal walls only from the floor up.
    //
    // Both are a LIST OF PIECES rather than one ring, because THREE.Shape can
    // only describe a single ring. The pieces are extruded together into one
    // geometry, which is visually identical (they abut exactly) and removes the
    // hand-tracing step completely.
    const SLAB_PIECES = HOUSE.roomOrder.map(rid => ROOMS[rid].poly);
    const CEIL_PIECES = SLAB_PIECES.concat(
      HOUSE.wallsExt.filter(w => w.outer).map(w => {
        const dx = w.x2 - w.x1, dy = w.y2 - w.y1;
        const len = Math.hypot(dx, dy) || 1;
        // Unit normal to the wall, scaled to half its thickness.
        const nx = (-dy / len) * (w.thickness / 2);
        const ny = (dx / len) * (w.thickness / 2);
        return [
          [w.x1 + nx, w.y1 + ny], [w.x2 + nx, w.y2 + ny],
          [w.x2 - nx, w.y2 - ny], [w.x1 - nx, w.y1 - ny]
        ];
      })
    );
    const SLAB_THICK = 0.15; // 15cm, both floor + ceiling
    // Build a THREE.Shape from a cm polygon using the same (tx, -tz) convention
    // the per-room floors used, so the -PI/2 X-rotation lands it correctly.
    const shapeFromPoly = poly => {
      const sh = new THREE.Shape();
      sh.moveTo(tx(poly[0][0]), -tz(poly[0][1]));
      for (let i = 1; i < poly.length; i++) sh.lineTo(tx(poly[i][0]), -tz(poly[i][1]));
      sh.closePath();
      return sh;
    };
    const slabShapes = SLAB_PIECES.map(shapeFromPoly);
    const ceilShapes = CEIL_PIECES.map(shapeFromPoly);

    // Whole-house floor material: Ashy Oak LVT (Floored.co.uk "LVT Ashy Oak") —
    // the home's real flooring. Weathered grey-toned oak, 18.5cm x 121.5cm planks, long
    // axis N-S, semi-random stagger. Procedurally baked (no external image file).
    //
    // We bake the ENTIRE floor into one canvas and map it so ONE canvas copy covers
    // the whole slab — the plank stagger is then genuinely non-repeating across the
    // floor (no tiling seam gives the pattern away).
    //
    // ⚠️ UV — DO NOT TRUST ExtrudeGeometry's built-in UVs. Its WorldUVGenerator
    // emits uvs from the shape coords for the caps BUT also emits SIDE-WALL uvs for
    // the 15cm extrude depth, so the geometry's actual emitted uv range is NOT the
    // slab's position bbox (measured live: ~17.183 x 8.358, not 9.782 x 7.386).
    // Keying repeat/offset off the position bbox therefore shrinks every plank
    // (gibbs-r4b, LEARNINGS #54). FIX (robust): OVERWRITE the floor geometry's uv
    // attribute with our OWN planar UVs derived straight from each vertex's world
    // position (u = worldX metres, v = worldZ metres). Then the uv range is EXACTLY
    // the slab's world extent by construction, independent of ExtrudeGeometry's
    // quirk, and repeat = 1/extent + offset = -min/extent makes ONE canvas cover
    // the slab with planks at the true 18.5 x 121.5 cm. Only the top face is ever
    // visible (bottom is underground, sides hidden in the walls), so cap/side uvs
    // sharing this planar mapping is harmless.
    const _sxAll = [], _syAll = [];
    SLAB_PIECES.forEach(poly => poly.forEach(pt => { _sxAll.push(pt[0]); _syAll.push(pt[1]); }));
    const _sx = _sxAll, _sy = _syAll;
    const slabMinXW = tx(Math.min(..._sx)), slabMaxXW = tx(Math.max(..._sx)); // E-W world (u)
    const _yA = -tz(Math.min(..._sy)), _yB = -tz(Math.max(..._sy));           // shape-Y = -tz(y)
    const slabMinYW = Math.min(_yA, _yB), slabMaxYW = Math.max(_yA, _yB);     // N-S world (v)
    const slabWidthM = slabMaxXW - slabMinXW; // E-W metres (plank WIDTH axis / u)
    const slabDepthM = slabMaxYW - slabMinYW; // N-S metres (plank LENGTH axis / v)
    const floorTileTex = makeAshyOakTexture(slabWidthM, slabDepthM);
    floorTileTex.wrapS = floorTileTex.wrapT = THREE.ClampToEdgeWrapping; // one copy only
    floorTileTex.repeat.set(1 / slabWidthM, 1 / slabDepthM);
    floorTileTex.offset.set(-slabMinXW / slabWidthM, -slabMinYW / slabDepthM);
    floorTileTex.needsUpdate = true;
    // Neutral-white tint so the baked canvas colours show true (matte LVT).
    const floorMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.82, metalness: 0.0, map: floorTileTex });
    // Floor: extrude 15cm; after the -PI/2 X-rotation the extrude runs to world
    // +Y, so drop the mesh by SLAB_THICK-0.005 to put the walkable TOP face at
    // y=0.005 and the 15cm body BELOW it (grows downward, into the ground).
    // ExtrudeGeometry accepts an array of shapes and emits one geometry, so the
    // multi-piece floor is still a single mesh and a single draw call.
    const floorGeo = new THREE.ExtrudeGeometry(slabShapes, { depth: SLAB_THICK, bevelEnabled: false });
    // --- Custom planar UVs (the fix). The shape is authored in the X-Y plane
    // (shape.x = world X, shape.y = -tz(y)); after the -PI/2 X-rotation shape.y
    // becomes world Z. Both are already in metres. Write uv = (shape.x, shape.y)
    // straight from position, so the uv range == the slab's world extent exactly.
    {
      const pos = floorGeo.attributes.position;
      const uvArr = new Float32Array(pos.count * 2);
      for (let i = 0; i < pos.count; i++) {
        uvArr[i * 2]     = pos.getX(i); // world X metres  -> u
        uvArr[i * 2 + 1] = pos.getY(i); // shape Y metres  -> v (becomes world Z)
      }
      floorGeo.setAttribute("uv", new THREE.BufferAttribute(uvArr, 2));
      floorGeo.attributes.uv.needsUpdate = true;
    }
    const floorSlab = new THREE.Mesh(floorGeo, floorMat);
    floorSlab.rotation.x = -Math.PI / 2;
    floorSlab.position.set(0, -(SLAB_THICK - 0.005), 0);
    floorSlab.receiveShadow = true;
    scene.add(floorSlab);

    // Ceiling: OUTER-FLUSH outline (ceilShape, the full building footprint — see
    // CEIL_POLY above), 15cm thick, grows UPWARD from WH (visible underside stays
    // at y=WH; body extends up toward the roof). The ceiling is BIGGER than the
    // floor now — it caps OVER the external walls out to their outer faces, while
    // the floor stays at the inner faces. Keeps the fade-from-outside behaviour
    // (transparent when the camera is above the house, solid from inside) —
    // driven by ceilingMesh.material.opacity in the render loop.
    const ceilMat = new THREE.MeshStandardMaterial({
      color: CEILING_COLOR, roughness: 0.9, side: THREE.DoubleSide,
      transparent: true, opacity: 0, depthWrite: false
    });
    const ceilGeo = new THREE.ExtrudeGeometry(ceilShapes, { depth: SLAB_THICK, bevelEnabled: false });
    const ceilingMesh = new THREE.Mesh(ceilGeo, ceilMat);
    ceilingMesh.rotation.x = -Math.PI / 2;
    ceilingMesh.position.set(0, WH, 0);
    ceilingMesh.castShadow = true;
    ceilingMesh.receiveShadow = true;
    scene.add(ceilingMesh);

    // Rug diffuse — a procedural plush-pile texture, generated at runtime like
    // every other floor material here. It replaces an embedded base64
    // PHOTOGRAPH of a specific real rug that used to live in this file: a photo
    // of somebody's furniture is not something a general-purpose renderer should
    // carry, it cannot be licensed onward, and it made the engine 14 KB heavier
    // for one house's benefit. A house that wants its own rug image supplies one
    // through the profile (`room.rug.texture`), which is loaded over this.
    //
    // The pattern is a warm-neutral mid-grey with fine directional noise, which
    // is what reads as cut pile at the scale a rug is seen from.
    const rugDiffuseTex = (() => {
      const size = 128;
      const c = document.createElement('canvas');
      c.width = c.height = size;
      const g = c.getContext('2d');
      const img = g.createImageData(size, size);
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const i = (y * size + x) * 4;
          // Base mid-grey with a slight warm cast, plus per-pixel pile noise and
          // a faint vertical streak so the pile has a lie to it.
          const streak = Math.sin(x * 0.9) * 4;
          const n = (Math.random() - 0.5) * 26 + streak;
          img.data[i]     = Math.max(0, Math.min(255, 150 + n));
          img.data[i + 1] = Math.max(0, Math.min(255, 145 + n));
          img.data[i + 2] = Math.max(0, Math.min(255, 138 + n));
          img.data[i + 3] = 255;
        }
      }
      g.putImageData(img, 0, 0);
      const tex = new THREE.CanvasTexture(c);
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      tex.anisotropy = 4;
      tex.needsUpdate = true;
      return tex;
    })();

    // Rooms (invisible click-catchers, rugs, lights)
    Object.entries(ROOMS).forEach(([id, rm]) => {
      const w = (rm.x2 - rm.x1) * S, d = (rm.y2 - rm.y1) * S;
      const cx = tx((rm.x1 + rm.x2) / 2), cz = tz((rm.y1 + rm.y2) / 2);

      // Per-room INVISIBLE click-catcher (replaces the old visible per-room
      // floor as the room-selection raycast target). opacity:0 (NOT visible:false
      // — an invisible-flagged mesh doesn't raycast; a zero-opacity one still
      // does). Carries roomId + clickable, sits at floor level. Built from the
      // room's D5 poly (or its rect if no poly).
      let ccGeo;
      if (rm.poly) {
        const shape = new THREE.Shape();
        shape.moveTo(tx(rm.poly[0][0]), -tz(rm.poly[0][1]));
        for (let i = 1; i < rm.poly.length; i++) shape.lineTo(tx(rm.poly[i][0]), -tz(rm.poly[i][1]));
        shape.closePath();
        ccGeo = new THREE.ShapeGeometry(shape);
      } else {
        ccGeo = new THREE.PlaneGeometry(w, d);
      }
      const cc = new THREE.Mesh(ccGeo, new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }));
      cc.rotation.x = -Math.PI / 2;
      if (!rm.poly) cc.position.set(cx, 0.006, cz);
      else cc.position.set(0, 0.006, 0);
      cc.userData = { roomId: id, clickable: true };
      scene.add(cc);

      // Rug objects — full-room rugs on the Ashy Oak floor in the bedroom + home
      // office (replaces the old baked carpet:true floors). A thin flat mesh over
      // the plank floor (y=0.01, above the tile to avoid z-fight).
      // R4 (2026-07-10, ACK'd): the rug covers the ENTIRE room floor and
      // IGNORES the pillar notches (#31 in bedroom, #26 in home_office) — the rug
      // laps over/under where the pillar bumps in, as if the pillars weren't there.
      // ENSUITE CUT (2026-07-11, rhaenys-rug, requested): the home_office rug must
      // follow home_office's actual L-SHAPE and STOP at the ensuite walls — the
      // ensuite (a whole room carved out of home_office's NE corner, x1071.2..1281.8
      // y303..448) must NOT be carpeted. So the home_office rug is a ShapeGeometry
      // built from home_office's outer L-boundary EXCLUDING the ensuite (opposite of
      // the pillar-notch rule: a whole ROOM is cut, but the #26 pillar bump is still
      // ignored/lapped-over). The BEDROOM rug stays a full RECTANGLE (still ignores
      // #31). See HO_RUG_POLY below — a squared-off L (no #26 notch) that only
      // excludes the ensuite.
      // COLOUR (2026-07-10, research-rug2): uses the REAL CGTrader grey plush-rug
      // diffuse (embedded data-URI, shared rugDiffuseTex above) with material tint
      // 0xFFFFFF so the photo's own correct warm-neutral MID-grey shows true. This
      // replaces the old 0xE2DFDA procedural fill, which was far too light (it
      // double-multiplied to a pale oatmeal, not the mid-grey of the reference).
      // Rugs — a thin flat mesh over the floor (y=0.01, above the slab to avoid
      // z-fighting). WHICH rooms have one, and what shape, is now profile data
      // (`room.rug`): the reference implementation hardcoded two room ids and an
      // inline polygon. A rug's outline is deliberately independent of the room
      // polygon — a rug laps over a pillar and stops short of a doorway, so it is
      // neither the room shape nor a plain rectangle — which is exactly why the
      // profile stores it separately rather than deriving it.
      if (rm.rug) {
        const rug = rm.rug;
        // Clone so each rug can set its own repeat without the rugs fighting
        // over one texture's repeat state. A CanvasTexture clone shares the
        // already-drawn canvas, so it is usable immediately.
        const rt = rugDiffuseTex.clone();
        rt.wrapS = rt.wrapT = THREE.RepeatWrapping;
        rt.needsUpdate = true;
        // Built from the rug polygon exactly like the floor slab's ShapeGeometry,
        // so the -PI/2 X-rotation lands it flat and correctly positioned. The
        // shape is authored at absolute world coords, so the mesh sits at the
        // origin rather than being translated to the room centre.
        const shape = new THREE.Shape();
        shape.moveTo(tx(rug.poly[0][0]), -tz(rug.poly[0][1]));
        for (let i = 1; i < rug.poly.length; i++) shape.lineTo(tx(rug.poly[i][0]), -tz(rug.poly[i][1]));
        shape.closePath();
        const rugGeo = new THREE.ShapeGeometry(shape);
        // ShapeGeometry emits UVs straight from the shape's world-metre coords,
        // so one texture copy per `repeatMetres` of rug keeps the pile at a
        // sensible real-world scale.
        //
        // A RECTANGULAR rug additionally rounds to a WHOLE number of copies
        // across each axis, so the pile pattern is not cut mid-tile at the rug's
        // own edge (a visible seam along the border). That rounding is only
        // meaningful when the rug's outline IS its bounding box; on an L-shaped
        // rug the box is bigger than the rug, so rounding against it would skew
        // the pile scale and the flat per-metre rate is the correct one.
        const _rb = { x1: Infinity, y1: Infinity, x2: -Infinity, y2: -Infinity };
        rug.poly.forEach(pt => {
          if (pt[0] < _rb.x1) _rb.x1 = pt[0];
          if (pt[0] > _rb.x2) _rb.x2 = pt[0];
          if (pt[1] < _rb.y1) _rb.y1 = pt[1];
          if (pt[1] > _rb.y2) _rb.y2 = pt[1];
        });
        const _rw = (_rb.x2 - _rb.x1) * S, _rd = (_rb.y2 - _rb.y1) * S;
        // Rectangular iff its area fills its bounding box (4-point outlines and
        // the degenerate collinear cases included).
        const _rugArea = Math.abs((function () {
          let s = 0;
          for (let i = 0; i < rug.poly.length; i++) {
            const a = rug.poly[i], b = rug.poly[(i + 1) % rug.poly.length];
            s += a[0] * b[1] - b[0] * a[1];
          }
          return s / 2;
        })()) * S * S;
        const _isRect = _rw > 0 && _rd > 0 && Math.abs(_rugArea - _rw * _rd) / (_rw * _rd) < 0.01;
        if (_isRect) {
          rt.repeat.set(
            Math.max(1, Math.round(_rw / rug.repeatMetres)) / _rw,
            Math.max(1, Math.round(_rd / rug.repeatMetres)) / _rd
          );
        } else {
          rt.repeat.set(1 / rug.repeatMetres, 1 / rug.repeatMetres);
        }
        // The procedural pile is a mid-grey, and a material colour MULTIPLIES
        // its map — so tinting with the rug's own mid-tone colour would darken
        // it twice over and the rug would read as near-black. Divide the tint
        // through by the pile's own mean grey so the rendered result lands on
        // the colour the profile actually asked for.
        const PILE_MEAN = 145 / 255;
        const _tint = new THREE.Color(rug.color);
        _tint.setRGB(
          Math.min(1, _tint.r / PILE_MEAN),
          Math.min(1, _tint.g / PILE_MEAN),
          Math.min(1, _tint.b / PILE_MEAN)
        );
        const rugMesh = new THREE.Mesh(rugGeo, new THREE.MeshStandardMaterial({
          color: _tint, roughness: 0.95, metalness: 0.0, map: rt
        }));
        rugMesh.rotation.x = -Math.PI / 2;
        rugMesh.position.set(0, 0.01, 0);
        rugMesh.receiveShadow = true;
        scene.add(rugMesh);
        if (rug.textureUrl) {
          // A profile-supplied rug image replaces the built-in pile texture.
          // Loaded after the mesh exists, so the callback has something to
          // assign to; a failure leaves the procedural pile in place.
          new THREE.TextureLoader().load(
            rug.textureUrl,
            loaded => {
              loaded.wrapS = loaded.wrapT = THREE.RepeatWrapping;
              loaded.anisotropy = 4;
              loaded.repeat.set(1 / rug.repeatMetres, 1 / rug.repeatMetres);
              rugMesh.material.map = loaded;
              rugMesh.material.needsUpdate = true;
            },
            undefined,
            () => console.warn('[Home3DScene] rug texture "' + rug.textureUrl +
              '" could not be loaded; using the procedural pile instead.')
          );
        }
      }

      // ---- Room lights ---------------------------------------------------
      //
      // DATA-DRIVEN. This used to be a chain of `if (id === "living_room")`
      // branches placing fixtures at literal coordinates, with a per-room
      // DL_SHIFT table nudging them whenever a room moved -- the single biggest
      // reason the engine only rendered one flat. Every fixture position now
      // comes from the profile (geometry.json -> lights[].fixtures[].positions),
      // so this code places whatever it is given and knows nothing about any
      // particular room.
      //
      // A fixture group is a `channel` (the join key to a Home Assistant entity
      // in rooms.json) with a `fixtureType` telling us what to draw and a list
      // of positions in plan centimetres. Positions the author did not supply
      // were auto-placed over the room bbox by the loader.
      const mls = [], mms = [];
      const groups = LIGHTS[id] || {};

      // One shadow-casting light per room for wall occlusion. Skipped on
      // low-uniform GPUs — these × ~14 fragment-uniform vectors each alone
      // exceeds the Adreno 256 budget. The room still has its main fixture
      // lights; just no wall-shadowing from a hidden point source.
      //
      // Its range keys off the room's bounding box, which is now DERIVED from
      // the room polygon rather than read from a separately-authored rect.
      const FY = 0;
      const roomRange = Math.max(w, d) * 1.2;
      if (quality.roomShadowLights) {
        const roomShadowLight = new THREE.PointLight(0xfff4cc, 0.4, roomRange, 1.5);
        roomShadowLight.position.set(cx, FY + WH - 0.15, cz);
        roomShadowLight.castShadow = true;
        roomShadowLight.shadow.mapSize.width = Math.round(1024 * smScale);
        roomShadowLight.shadow.mapSize.height = Math.round(1024 * smScale);
        roomShadowLight.shadow.bias = -0.0008;
        roomShadowLight.shadow.camera.near = 0.1;
        roomShadowLight.shadow.camera.far = roomRange;
        scene.add(roomShadowLight);
        mls.push(roomShadowLight);
      }

      // --- Fixture builders, one per fixtureType --------------------------
      // Each takes a world-space position and returns nothing; it pushes the
      // visible fixture mesh into `meshes` and its PointLight into `lights`.
      // The emissive disc/sphere is what the user clicks to select the room, so
      // every fixture carries { roomId, clickable }.

      // Flush ceiling disc.
      const addDownlight = (px, py, pz, meshes, lights, tint) => {
        const bm = new THREE.MeshStandardMaterial({ color: 0xfff8e0, emissive: tint, emissiveIntensity: 1.5 });
        const b = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.07, 0.03, 10), bm);
        b.position.set(px, py, pz);
        b.userData = { roomId: id, clickable: true };
        scene.add(b);
        meshes.push(b);
        const pl = new THREE.PointLight(tint, 0.6, Math.max(w, d) * 1.8, 1.8);
        pl.position.set(px, py - 0.06, pz);
        scene.add(pl);
        lights.push(pl);
      };

      // Surface-mounted spot: a small sphere. Historically a room's five spots
      // were drawn as a fixed cluster around the room centre; they are now five
      // ordinary positions like any other fixture, and a group of spots shares
      // ONE PointLight at the group's centroid (the cluster was always lit by a
      // single light -- five would blow the fragment-uniform budget for no
      // visible gain).
      const addSpotMesh = (px, py, pz, meshes, tint) => {
        const bm = new THREE.MeshStandardMaterial({ color: 0xfff8e0, emissive: tint, emissiveIntensity: 1.5 });
        const b = new THREE.Mesh(new THREE.SphereGeometry(0.05, 10, 10), bm);
        b.position.set(px, py, pz);
        b.userData = { roomId: id, clickable: true };
        scene.add(b);
        meshes.push(b);
      };

      // Bare bulb / pendant hanging below the ceiling.
      const addBulb = (px, py, pz, meshes, lights, tint) => {
        const bm = new THREE.MeshStandardMaterial({ color: 0xfff8e0, emissive: tint, emissiveIntensity: 1.5 });
        const b = new THREE.Mesh(new THREE.SphereGeometry(0.045, 10, 10), bm);
        b.position.set(px, py, pz);
        b.userData = { roomId: id, clickable: true };
        scene.add(b);
        meshes.push(b);
        const pl = new THREE.PointLight(tint, 0.5, 4, 2);
        pl.position.set(px, py, pz);
        scene.add(pl);
        lights.push(pl);
      };

      // Linear LED run. `size` is the emitter's [length, height, depth] in cm,
      // straight from the profile, so a 2 m cornice reads as a line not a point.
      const addStrip = (px, py, pz, size, meshes, lights, tint) => {
        const [sl, sh, sd] = size;
        const m = new THREE.Mesh(
          new THREE.BoxGeometry(sl / 100, sh / 100, sd / 100),
          new THREE.MeshStandardMaterial({
            color: tint, emissive: tint, emissiveIntensity: 0.8,
            transparent: true, opacity: 0.85
          })
        );
        m.position.set(px, py, pz);
        m.userData = { roomId: id, clickable: true };
        scene.add(m);
        meshes.push(m);
        const pl = new THREE.PointLight(tint, 0.2, 2.5, 2);
        pl.position.set(px, py, pz);
        scene.add(pl);
        lights.push(pl);
      };

      /**
       * Resolve a fixture position to world space.
       *
       * `at` is plan [x, y] in centimetres. `heightCm` is height above THIS
       * room's floor; omitted means a ceiling fixture, which sits just below
       * the ceiling. That default is what lets a profile list a downlight as a
       * bare [x, y] without repeating the ceiling height on every entry.
       */
      const fixtureY = (pos, ceilingDrop) => (
        pos.heightCm != null ? FY + pos.heightCm / 100 : FY + WH - ceilingDrop
      );

      // Build every channel this room declares. 'main' and 'ambient' get their
      // own light/mesh arrays because the controls panel and the HA binding
      // switch them independently; any other channel is its own group too.
      const groupLights = {}, groupMeshes = {};
      Object.keys(groups).forEach(channel => {
        const g = groups[channel];
        // Ambient/accent groups are the decorative layer and are dropped on the
        // low tier (~12 PointLights x 6 vec4 of fragment uniforms we cannot
        // afford on an Adreno 256). Visual loss is moderate; "nothing renders
        // at all" is not.
        const isAccent = (channel !== 'main');
        if (isAccent && !quality.ambientStrips) return;

        const ls = [], ms = [];
        // Fixture tint from the group's colour temperature. Ambient strips have
        // historically been a saturated accent colour rather than a white, and
        // a profile expresses that by giving the group a low kelvin.
        const tint = (g.fixtureType === 'strip' && isAccent) ? 0xff3300 : k2h(g.colorTemperatureK);

        (g.positions || []).forEach(pos => {
          const px = tx(pos.at[0]), pz = tz(pos.at[1]);
          switch (g.fixtureType) {
            case 'downlight':
              addDownlight(px, fixtureY(pos, 0.02), pz, ms, ls, tint);
              break;
            case 'spot':
              addSpotMesh(px, fixtureY(pos, 0.12), pz, ms, tint);
              break;
            case 'pendant':
            case 'bulb':
              addBulb(px, pos.heightCm != null ? FY + pos.heightCm / 100 : FY + WH * 0.7, pz, ms, ls, tint);
              break;
            case 'strip':
              addStrip(px, fixtureY(pos, 0.06), pz, pos.size || [Math.max(w, d) * 70, 2.5, 2.5], ms, ls, tint);
              break;
            case 'projector':
              // A special-effect emitter (e.g. a star projector). It gets NO
              // fixture geometry and NO point light: the real device is a small
              // matt-black puck that throws points of light onto the ceiling,
              // so drawing it as an emissive bulb put a glowing ball in mid-air
              // in the middle of the room — and because an accent channel is
              // tinted #ff3300, that ball rendered as a stray red dot. The
              // channel still exists in lightState, so it keeps its own toggle
              // in the controls panel; it simply has nothing to draw.
              break;
            case 'none':
              // Light with no visible fixture geometry.
              {
                const pl = new THREE.PointLight(tint, 0.6, Math.max(w, d) * 1.8, 1.8);
                pl.position.set(px, fixtureY(pos, 0.08), pz);
                scene.add(pl);
                ls.push(pl);
              }
              break;
            default:
              addDownlight(px, fixtureY(pos, 0.02), pz, ms, ls, tint);
          }
        });

        // A spot cluster shares one PointLight at its centroid — see addSpotMesh.
        if (g.fixtureType === 'spot' && g.positions && g.positions.length) {
          let sx = 0, sz = 0;
          g.positions.forEach(pos => { sx += tx(pos.at[0]); sz += tz(pos.at[1]); });
          const pl = new THREE.PointLight(tint, 1.0, Math.max(w, d) * 2, 1.5);
          pl.position.set(sx / g.positions.length, FY + WH - 0.18, sz / g.positions.length);
          scene.add(pl);
          ls.push(pl);
        }

        groupLights[channel] = ls;
        groupMeshes[channel] = ms;
      });

      // 'main' feeds the room's primary light arrays (and the room shadow light
      // rides along with it, as it always did). Every other channel is stored
      // under its own name.
      mls.push.apply(mls, groupLights.main || []);
      mms.push.apply(mms, groupMeshes.main || []);
      mainLights[id] = mls;
      mainMeshes[id] = mms;

      // Accent channels. 'ambient' keeps its dedicated arrays because the
      // controls panel and updateLights() address it by name; anything else is
      // kept in the same per-channel maps so a profile can declare a third
      // switchable group without an engine change.
      ambientLights[id] = groupLights.ambient || [];
      ambientMeshes[id] = groupMeshes.ambient || [];
      Object.keys(groupLights).forEach(channel => {
        if (channel === 'main' || channel === 'ambient') return;
        extraLights[id] = extraLights[id] || {};
        extraMeshes[id] = extraMeshes[id] || {};
        extraLights[id][channel] = groupLights[channel];
        extraMeshes[id][channel] = groupMeshes[channel];
      });
    });

    // (The single house-wide ceiling slab is built up front with the floor slab
    // — see the floor/ceiling section before the room loop above. It keeps the
    // fade-from-outside behaviour via ceilingMesh.material.opacity in the loop.)

    // Living-room black-oak acoustic slat panel on wall #1's room-facing (east)
    // face + the 12cm step-return where wall #3 begins (y=707.8). North stop
    // y=353.4, south end at the step y=707.8; does NOT continue onto wall #3's
    // own wide face (visual review 2026-07-09). Ported from experimental
    // (buildAcousticPanelLivingRoomWall1Wall3) WITH the black-half depthWrite
    // fix (see scout-blackhalf report + the render-loop fade block). wallMeshes
    // is passed so the panel meshes register into the SAME exterior-fade loop as
    // wall #1 (#1 is outer:1, so the panel DOES fade see-through from outside).
    // Decorative slat panelling. This is bespoke geometry keyed to specific wall
    // ids of the house it was modelled for, and there is no schema field for it —
    // it is furniture, not building fabric. It is therefore OPT-IN: a house asks
    // for it by passing `decor: ['acoustic-panels']` to create(). Every house that
    // does not ask (the demo house included) simply skips it, and the functions
    // themselves no-op when the wall ids they need are absent, so an opt-in from a
    // house without those walls degrades quietly rather than throwing.
    if (quality.decor.indexOf('acoustic-panels') !== -1) {
      buildAcousticPanelLivingRoomWall1Wall3(scene, wallMeshes);
    }

    // Clouds — drifting puff sprites in the sky. Shared canvas texture (a few
    // overlapping radial gradients fake a fluffy outline). Tinted by sun mode.
    const cloudTex = (() => {
      const c = document.createElement('canvas');
      c.width = 256; c.height = 128;
      const g = c.getContext('2d');
      const blobs = [[80,70,60],[130,55,55],[180,70,50],[105,85,45],[155,85,45]];
      blobs.forEach(([x, y, r]) => {
        const grd = g.createRadialGradient(x, y, 0, x, y, r);
        grd.addColorStop(0, 'rgba(255,255,255,0.85)');
        grd.addColorStop(0.4, 'rgba(255,255,255,0.55)');
        grd.addColorStop(1, 'rgba(255,255,255,0)');
        g.fillStyle = grd;
        g.fillRect(0, 0, 256, 128);
      });
      const tex = new THREE.CanvasTexture(c);
      tex.needsUpdate = true;
      return tex;
    })();
    const clouds = [];
    const CLOUD_COUNT = 14;
    const CLOUD_SPREAD = 70;
    const HOME_CX = tx(HOUSE.centre[0]), HOME_CZ = tz(HOUSE.centre[1]);
    const wrapMinX = HOME_CX - CLOUD_SPREAD / 2;
    const wrapMaxX = HOME_CX + CLOUD_SPREAD / 2;
    for (let i = 0; i < CLOUD_COUNT; i++) {
      const mat = new THREE.SpriteMaterial({
        map: cloudTex, transparent: true, opacity: 0.85,
        color: 0xffffff, depthWrite: false
      });
      const sp = new THREE.Sprite(mat);
      const sc = 8 + Math.random() * 6;
      sp.scale.set(sc * 2, sc, 1);
      sp.position.set(
        wrapMinX + Math.random() * CLOUD_SPREAD,
        22 + Math.random() * 10,
        HOME_CZ + (Math.random() - 0.5) * CLOUD_SPREAD
      );
      sp.userData.driftSpeed = 0.3 + Math.random() * 0.4;
      sp.userData.wrapMinX = wrapMinX;
      sp.userData.wrapMaxX = wrapMaxX;
      scene.add(sp);
      clouds.push(sp);
    }

    // Wall #25 bedroom-facing acoustic slat panel (Acupanel Oak). Standalone
    // group bolted onto #25's -x face; registers its meshes into wallMeshes so
    // it fades with the bedroom's exterior wall (#4) and gets the black-half
    // depthWrite fix in the render loop. (zabine-wall25, ported 2026-07-11.)
    if (quality.decor.indexOf('acoustic-panels') !== -1) {
      buildAcousticPanelWall25(scene, wallMeshes);
    }

    return { mainLights, mainMeshes, ambientLights, ambientMeshes, extraLights, extraMeshes, sun, ambLight, gndMat, wallMeshes, ceilingMesh, clouds, doorByRoom };
  }

  /**
   * Create a 3D home instance attached to a DOM container.
   *
   * THE HOUSE IS AN ARGUMENT. Pass either a compiled profile (from
   * HouseLoader.load / .compile) as `opts.house`, or a profile id as
   * `opts.houseId` and this will load it, falling back to the demo house if it
   * cannot. Because loading is asynchronous, the id form returns a PROMISE of
   * the instance; the compiled form returns the instance synchronously, so an
   * embedder that already has a profile keeps the original call shape.
   *
   *   // synchronous — you already have a profile
   *   const house = await HouseLoader.load('demo');
   *   const scene = Home3DScene.create(el, { house, interactive: true });
   *
   *   // asynchronous — let the engine fetch it
   *   const scene = await Home3DScene.create(el, { houseId: 'demo' });
   *
   * The module-level exports (ROOMS, LIGHTS, WALL_SEGMENTS_WORLD,
   * FOOTPRINT_BOUNDS, COORD_TRANSFORM, DOOR_LABELS_WORLD) are refreshed to the
   * house being rendered, so read them AFTER this resolves.
   *
   * @param {HTMLElement} container
   * @param {Object} opts
   * @param {Object}  opts.house       - a compiled house profile (preferred)
   * @param {string}  opts.houseId     - a profile id to load; returns a Promise
   * @param {string}  opts.fallbackHouseId - used when houseId cannot be loaded
   * @param {boolean} opts.interactive  - enable orbit/click (full page mode)
   * @param {boolean} opts.autoRotate   - slow auto-rotation (preview mode)
   * @param {number}  opts.pixelRatio   - override devicePixelRatio
   * @param {Function} opts.onRoomClick - callback(roomId) when a room is clicked
   * @returns {Object|Promise<Object>} the instance, or a Promise of it when
   *          `houseId` was given.
   */
  function create(container, opts = {}) {
    // The id form is asynchronous: fetch, compile, then build synchronously.
    if (!opts.house && opts.houseId) {
      if (typeof HouseLoader === 'undefined') {
        throw new Error(
          'Home3DScene.create({ houseId }) needs src/house-loader.js to be loaded first. ' +
          'Either include that script, or compile the profile yourself and pass it as opts.house.'
        );
      }
      return HouseLoader.loadWithFallback(opts.houseId, opts.fallbackHouseId)
        .then(loaded => create(container, Object.assign({}, opts, { house: loaded, houseId: null })));
    }
    if (!opts.house) {
      throw new Error(
        'Home3DScene.create() requires a house: pass opts.house (a compiled profile from ' +
        'HouseLoader) or opts.houseId (a profile id under houses/). The engine no longer ' +
        'carries a built-in house.'
      );
    }
    // Bind the profile. Everything below — and every export — now describes it.
    useHouse(opts.house);

    const {
      interactive = false,
      autoRotate = false,
      rotateSpeed = 0.024, // radians/second (~262s per full turn — homepage preview default)
      pixelRatio = Math.min(devicePixelRatio, 2),
      onRoomClick = null,
      initialState = null,
      // ── Power/quality knobs (default to the original full-fat behaviour) ──
      // shadows: 'auto' = GPU-tier decides (original); 'low' = sun shadow only at
      //   1/4 map size, no room shadow lights; 'off' = no shadows at all.
      shadows = 'auto',
      // maxFps: 0 = uncapped (original). The preview tile passes a low cap (it's a
      //   tiny slowly-rotating thumbnail — 60–240fps was pure waste); the loop
      //   stays time-correct so rotation speed is unchanged.
      maxFps = 0,
      // antialias: cheap to drop on the preview tile (barely visible at 379x163).
      antialias = true,
    } = opts;

    const W = container.clientWidth, H = container.clientHeight;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0f0f1a);

    const cam = new THREE.PerspectiveCamera(50, W / H, 0.1, 200);
    const ren = new THREE.WebGLRenderer({ antialias });
    ren.setSize(W, H);
    ren.setPixelRatio(pixelRatio);

    // ─── GPU capability tiering ─────────────────────────────────────────────
    // The scene uses ~64 lights (10 room shadow + ~24 main fixtures + ~12
    // ambient strips + sun + amb) → ~360+ fragment uniform vectors with
    // shadows. Desktop GPUs allow 1024+; mobile Adreno can advertise as low
    // as 256 (the WebGL minimum), in which case shaders fail to compile and
    // NOTHING renders — only the scene.background "sky" colour is visible.
    // We classify the GPU and skip the heaviest light categories on low tier.
    const gl = ren.getContext();
    const maxFragU = gl.getParameter(gl.MAX_FRAGMENT_UNIFORM_VECTORS);
    let tier;
    if (maxFragU >= 1024)      tier = 'ultra';  // full scene as designed
    else if (maxFragU >= 512)  tier = 'mid';    // drop room shadow lights
    else                       tier = 'low';    // also drop ambient strips + sun shadow
    // Start from the GPU-tier defaults, then let the `shadows` opt override. The
    // 10 invisible per-room shadow-casting PointLights ('ultra' only) are by far
    // the biggest GPU cost (each = a 6-face cubemap shadow render every frame) —
    // 'low' and 'off' both drop them; 'off' also drops the sun shadow.
    let sunShadow = tier !== 'low';
    let roomShadowLights = tier === 'ultra';
    let shadowMapScale = 1;
    if (shadows === 'off') {
      sunShadow = false;
      roomShadowLights = false;
    } else if (shadows === 'low') {
      sunShadow = tier !== 'low';
      roomShadowLights = false;
      shadowMapScale = 0.25; // 2048 -> 512
    } else if (shadows === 'high') {
      // Force the FULL shadow set (sun @2048 + the 10 per-room shadow-casting
      // lights), overriding the GPU-tier gate — the #3d popup should ALWAYS have
      // room-shadow lights. Guarded by tier !== 'low': on a sub-512-uniform GPU
      // the full light+shadow set fails to compile the shader (nothing renders),
      // so only the very weakest devices degrade instead of breaking.
      sunShadow = tier !== 'low';
      roomShadowLights = tier !== 'low';
      shadowMapScale = 1;
    }
    const quality = {
      tier,
      maxFragU,
      sunShadow,
      roomShadowLights,
      ambientStrips:    tier !== 'low',
      shadowMapScale,
      // Opt-in bespoke decoration (see the acoustic panels below). Empty by
      // default: a house gets only what its profile describes. The PROFILE is
      // the primary source — decor is per-house data, so a house that owns
      // slat panelling should render it wherever it is loaded, without the
      // embedding page having to know and pass a flag. The `decor` create()
      // option still works and is unioned in, for an embedder that wants to
      // add decoration on top of the profile's own.
      decor: (HOUSE.decor || []).concat(Array.isArray(opts.decor) ? opts.decor : []),
    };
    // ── Progressive first paint ────────────────────────────────────────────
    // Measured on the real 10-room house: the single most expensive step of a
    // cold start is the FIRST ren.render(), at ~300-560ms, because three.js
    // compiles and uploads every program and renders every shadow map in that
    // one blocking call. Steady-state frames afterwards are 10-22ms.
    //
    // So: render the first frames with the shadow pass switched OFF (cheap and
    // correct -- same geometry, same materials, same lights, just no cast
    // shadows yet), then switch shadows on once the scene is up and let the
    // shadow maps build on a later frame.
    //
    // This is a RAMP, NOT A DOWNGRADE. The end state is byte-for-byte the
    // configuration the scene would have had anyway: `wantShadows` below is
    // exactly the old `ren.shadowMap.enabled` expression, and it is restored
    // after `PROGRESSIVE_FRAMES` rendered frames. Nothing else -- pixel ratio,
    // antialias, light set, shadow-map size -- is touched, so the image at rest
    // is unchanged.
    //
    // Opt out with progressive:false (the ?shadows= presets are unaffected: a
    // scene that ends with no shadows simply has nothing to ramp to).
    const wantShadows = quality.sunShadow || quality.roomShadowLights;
    const progressive = opts.progressive !== false && wantShadows;
    // Frames to paint before turning the shadow pass on. 2 is enough to get a
    // complete, correct image on screen (frame 1 compiles the programs, frame 2
    // is already cheap) without the ramp being perceptible.
    const PROGRESSIVE_FRAMES = 2;
    let framesRendered = 0;
    let shadowsRamped = !progressive;
    ren.shadowMap.enabled = progressive ? false : wantShadows;
    console.info(
      `[Home3DScene] Quality tier=${tier} ` +
      `(MAX_FRAGMENT_UNIFORM_VECTORS=${maxFragU}) shadows=${shadows} maxFps=${maxFps || 'uncapped'}. ` +
      `sunShadow=${quality.sunShadow} ` +
      `roomShadowLights=${quality.roomShadowLights} ` +
      `shadowMapScale=${quality.shadowMapScale} ` +
      `ambientStrips=${quality.ambientStrips}`
    );
    // ─────────────────────────────────────────────────────────────────────────

    ren.toneMapping = THREE.ACESFilmicToneMapping;
    ren.toneMappingExposure = 0.85;
    ren.domElement.style.touchAction = 'none';
    container.appendChild(ren.domElement);

    const { mainLights, mainMeshes, ambientLights, ambientMeshes, extraLights, extraMeshes, sun, ambLight, gndMat, wallMeshes, ceilingMesh, clouds, doorByRoom } = buildScene(scene, quality);

    // ── On-demand render requests ──────────────────────────────────────────
    // A NON-auto-rotating scene (the #3d popup) only changes when the user moves
    // the camera, a light/sun/HA state changes, or an opacity transition is still
    // settling. These flags let the loop skip rendering entirely when idle
    // (≈0 GPU for an open-but-untouched popup) and snap straight to maxFps the
    // instant the user interacts. The auto-rotating preview ignores this (it
    // always has motion) and just runs at its maxFps cap. Declared before
    // syncLights() so a light change can requestRender() without a TDZ error.
    let needsRender = true;        // paint at least the first frame
    let wakeUntil = 0;             // keep rendering until this ts (post-interaction tail)
    let transitionsActive = true;  // wall/ceiling opacity still easing toward target
    function requestRender() { needsRender = true; }
    function wake(ms) { wakeUntil = Math.max(wakeUntil, performance.now() + (ms || 0)); needsRender = true; }

    // Light state — one entry per room, one sub-entry per channel the profile
    // declares for it. A room with no 'main' channel still gets a main entry so
    // the controls panel and syncLights() can address every room uniformly.
    const ids = Object.keys(ROOMS);
    const lightState = {};
    ids.forEach(id => {
      const groups = LIGHTS[id] || {};
      lightState[id] = { main: { on: false, bri: 100, temp: 4000 } };
      Object.keys(groups).forEach(channel => {
        if (channel === 'main') return;
        // Accent channels default to a warm accent colour and a lower brightness;
        // that is a display default, not a fact about the house.
        lightState[id][channel] = { on: false, bri: 80, color: "#ff3300" };
      });
    });

    // Apply initial HA state if provided
    if (initialState) {
      ids.forEach(id => {
        const init = initialState[id];
        if (!init) return;
        Object.keys(init).forEach(group => {
          if (lightState[id][group]) Object.assign(lightState[id][group], init[group]);
        });
      });
    }

    // TODO: per-bulb tracking. Today every bulb in a room/group renders with
    // the same intensity/color because lightState[id].main is a single object
    // shared by all bulbs. To make each 3D bulb mirror its own HA entity, swap
    // lightState[id].main for an array (one entry per entity in rooms[id].main)
    // and look up mainLights[id][i] against its matching entity here. Sidebar
    // controls stay group-level — only the visual state goes per-bulb.
    function syncLights() {
      ids.forEach(id => {
        const s = lightState[id];
        if (!s) return;
        const mc = k2h(s.main.temp), mb = s.main.on ? s.main.bri / 100 : 0;
        (mainLights[id] || []).forEach(l => { l.intensity = mb * 0.6; l.color.setHex(mc); });
        (mainMeshes[id] || []).forEach(m => {
          m.material.emissive.setHex(s.main.on ? mc : 0x222222);
          m.material.emissiveIntensity = s.main.on ? mb * 2 : 0.05;
        });
        // Accent channels. 'ambient' has dedicated arrays; any other channel a
        // profile declares is driven through the same code path from the
        // per-channel maps, so a third switchable group needs no engine change.
        const applyAccent = (state, lights, meshes) => {
          if (!state) return;
          const ac = parseInt(String(state.color).replace("#", ""), 16);
          const ab = state.on ? state.bri / 100 : 0;
          (lights || []).forEach(l => { l.intensity = ab * 0.3; l.color.setHex(ac); });
          (meshes || []).forEach(m => {
            m.material.color.setHex(ac);
            m.material.emissive.setHex(state.on ? ac : 0x111111);
            m.material.emissiveIntensity = state.on ? ab * 1.5 : 0;
            m.material.opacity = state.on ? 0.85 : 0.15;
          });
        };
        applyAccent(s.ambient, ambientLights[id], ambientMeshes[id]);
        Object.keys(s).forEach(channel => {
          if (channel === 'main' || channel === 'ambient') return;
          applyAccent(s[channel], (extraLights[id] || {})[channel], (extraMeshes[id] || {})[channel]);
        });
      });
      requestRender(); // light state changed → repaint (matters when idle/on-demand)
    }
    syncLights();

    // Orbit state — `pan` mirrors `drag` but for a right-drag translate of the
    // look-at target instead of a rotate; the two are mutually exclusive
    // (pointerdown picks one based on e.button), so px/py are shared between
    // them as "last pointer position for whichever drag is active".
    // The orbit target is the centre of the house's own footprint (derived from
    // the walls), not a hardcoded plan coordinate — a different house has a
    // different centre, and framing it on somebody else's is how a model ends up
    // off-screen. `_defaultDistance` frames the footprint's larger dimension in
    // the camera's field of view, so a bigger or smaller house is framed
    // correctly without the profile having to say anything about cameras.
    const _homeTgt = () => new THREE.Vector3(tx(HOUSE.centre[0]), 0, tz(HOUSE.centre[1]));
    const _fpW = (HOUSE.footprint.maxX - HOUSE.footprint.minX) * S;
    const _fpD = (HOUSE.footprint.maxY - HOUSE.footprint.minY) * S;
    const _defaultDistance = Math.max(6, Math.max(_fpW, _fpD) / (2 * Math.tan(cam.fov * Math.PI / 360)) * 1.15);
    const _t0 = _homeTgt();
    const orb = { drag: false, pan: false, px: 0, py: 0, th: Math.PI * 0.22, ph: Math.PI * 0.32, r: _defaultDistance, tgt: _t0 };
    const clickStart = { x: 0, y: 0 };
    const rc = new THREE.Raycaster();
    const mouse = new THREE.Vector2();

    // Pan bounds — derived from the wall geometry (not hardcoded) so a future
    // edit to the house footprint doesn't silently desync these. Generous
    // margin beyond the footprint (not tightly tuned — just stops the target
    // being dragged arbitrarily far from the model, same spirit as the
    // orb.r zoom clamp below). Y (vertical pan) gets a flat, small range since
    // there's no wall geometry to derive it from.
    const PAN_MARGIN_CM = 500;
    const wallXs = WALLS.flatMap(w => [w.x1, w.x2]);
    const wallYs = WALLS.flatMap(w => [w.y1, w.y2]);
    const PAN_BOUNDS = {
      minX: tx(Math.min(...wallXs) - PAN_MARGIN_CM), maxX: tx(Math.max(...wallXs) + PAN_MARGIN_CM),
      minZ: tz(Math.min(...wallYs) - PAN_MARGIN_CM), maxZ: tz(Math.max(...wallYs) + PAN_MARGIN_CM),
      minY: -2, maxY: 6
    };

    function updCam() {
      cam.position.set(
        orb.tgt.x + orb.r * Math.sin(orb.ph) * Math.cos(orb.th),
        orb.tgt.y + orb.r * Math.cos(orb.ph),
        orb.tgt.z + orb.r * Math.sin(orb.ph) * Math.sin(orb.th)
      );
      cam.lookAt(orb.tgt);
      requestRender();
    }
    updCam();

    // ---- Named camera view presets (for `?camera=<preset>` — see home3d.html) ----
    // Lets visual-review agents jump straight to a useful angle instead of
    // driving OrbitControls via synthetic mouse events (which the custom orbit
    // camera resists — First Mate LEARNINGS #55). Each preset sets the orbit
    // state {th, ph, r} and optionally re-targets orb.tgt; the user can still
    // orbit/pan freely afterwards (this only overrides the INITIAL pose).
    //
    // Angle convention (see updCam above): th = azimuth in the XZ plane; the
    // camera sits at th and looks back at the target. In model space x=East,
    // y=South, so world +X=East, +Z=South. Camera on the:
    //   +X (th=0)      side → looks West  (shows the EAST face)
    //   +Z (th=π/2)    side → looks North (shows the SOUTH face)
    //   -X (th=π)      side → looks East  (shows the WEST face)
    //   -Z (th=3π/2)   side → looks South (shows the NORTH face)
    // The front door is in the north wall (model y≈-4.8), so the ENTRANCE/front
    // elevation is the north face → camera on the -Z side (th=3π/2). ph is the
    // polar angle from +Y: ph→0 = straight top-down, ph=π/2 = eye-level.
    const PI = Math.PI;
    // The useful presets are DIRECTIONS — top-down, the four corner three-quarter
    // views, the four elevations — and a direction is house-independent. What
    // genuinely varies is the framing distance, and that is computed from the
    // footprint above. So a profile that says nothing about cameras still gets a
    // sensible set for its own size; `cameraPresets` in the profile overrides any
    // of them, wholly or in part, for a house whose shape wants a different angle.
    const _R = _defaultDistance;
    const CAMERA_PRESETS = {
      // Straight top-down floor-plan view. ph tiny-but-nonzero avoids a
      // gimbal-flat lookAt.
      top:     { th: -PI / 2, ph: 0.02, r: _R * 1.15 },
      // Four corner 3/4 aerial views — camera in the named corner looking into
      // the interior.
      se:      { th: PI * 0.25, ph: PI * 0.34, r: _R },
      sw:      { th: PI * 0.75, ph: PI * 0.34, r: _R },
      nw:      { th: PI * 1.25, ph: PI * 0.34, r: _R },
      ne:      { th: PI * 1.75, ph: PI * 0.34, r: _R },
      // Elevations — camera dead-on a face, near eye-level (ph high).
      front:   { th: PI * 1.5, ph: PI * 0.46, r: _R * 1.08 },
      back:    { th: PI * 0.5, ph: PI * 0.46, r: _R * 1.08 },
      east:    { th: 0,        ph: PI * 0.46, r: _R * 1.08 },
      west:    { th: PI,       ph: PI * 0.46, r: _R * 1.08 },
      // Default pleasant isometric-ish 3/4 (mirrors the scene's own default).
      iso:     { th: PI * 0.22, ph: PI * 0.32, r: _R },
    };
    // Per-house overrides. The profile expresses a preset in orbit terms
    // (azimuth/polar/distance, plus an optional plan-space target); map those
    // onto the engine's th/ph/r. A partial override keeps the engine default for
    // any key it omits.
    Object.keys(HOUSE.cameraPresets || {}).forEach(name => {
      const p = HOUSE.cameraPresets[name];
      const base = CAMERA_PRESETS[name] || CAMERA_PRESETS.iso;
      CAMERA_PRESETS[name] = {
        th: p.azimuth != null ? p.azimuth : base.th,
        ph: p.polar != null ? p.polar : base.ph,
        r: p.distance != null ? p.distance : base.r,
        tgt: p.target ? new THREE.Vector3(tx(p.target[0]), 0, tz(p.target[1])) : undefined
      };
    });
    // topdown is an alias for top
    CAMERA_PRESETS.topdown = CAMERA_PRESETS.top;

    // Apply a named preset (case-insensitive). Unknown/absent name → no-op
    // (keeps the current/default view). Returns true if a preset was applied.
    function setView(name) {
      if (!name) return false;
      const p = CAMERA_PRESETS[String(name).toLowerCase()];
      if (!p) return false;
      orb.th = p.th;
      orb.ph = p.ph;
      orb.r = p.r;
      orb.tgt.copy(p.tgt || _homeTgt());
      updCam();
      return true;
    }

    // Pan — translates orb.tgt (the look-at point) along the camera's actual
    // world-space right/up basis vectors, same approach Three.js OrbitControls
    // uses for its right-drag pan. Scaled by target distance (orb.r) and FOV so
    // a given pixel drag moves the same apparent screen-space amount regardless
    // of zoom level (matches the "consistent pan speed" behavior orbit
    // controls are known for) rather than a flat pixel->world constant.
    function panCam(dx, dy) {
      cam.updateMatrixWorld();
      const e = cam.matrixWorld.elements;
      const right = new THREE.Vector3(e[0], e[1], e[2]);
      const up = new THREE.Vector3(e[4], e[5], e[6]);
      const h = container.clientHeight || 1;
      const targetDistance = Math.abs(orb.r) * Math.tan((cam.fov / 2) * Math.PI / 180);
      const scale = (2 * targetDistance) / h;
      // Drag right -> content follows cursor right -> camera/target shift left
      // (negative right); drag down -> content follows cursor down -> camera/
      // target shift up (positive up). Standard "grab and drag the world" feel.
      orb.tgt.addScaledVector(right, -dx * scale);
      orb.tgt.addScaledVector(up, dy * scale);
      orb.tgt.x = Math.max(PAN_BOUNDS.minX, Math.min(PAN_BOUNDS.maxX, orb.tgt.x));
      orb.tgt.y = Math.max(PAN_BOUNDS.minY, Math.min(PAN_BOUNDS.maxY, orb.tgt.y));
      orb.tgt.z = Math.max(PAN_BOUNDS.minZ, Math.min(PAN_BOUNDS.maxZ, orb.tgt.z));
      updCam();
    }

    // ---- Sunlight from the house's own location -------------------------
    //
    // GEOLOCATED PER HOUSE. This used to hardcode one city's latitude and assume
    // solar noon at 12:00 UTC, so a house anywhere else lit up and went dark at
    // the wrong time. Latitude and longitude now come from the profile's `site`
    // block; a profile that omits `site` gets a fixed neutral daylight instead of
    // somebody else's sky.
    const LAT = HOUSE.site.latitude;
    const LON = HOUSE.site.longitude;
    const HAS_SITE = HOUSE.site.present;

    function getSunTimes() {
      const now = new Date();
      const start = new Date(now.getFullYear(), 0, 0);
      const doy = Math.floor((now - start) / 86400000); // day of year
      // Solar declination (Spencer, 1971)
      const B = (2 * Math.PI / 365) * (doy - 81);
      const decl = Math.asin(0.3978 * Math.sin(B));
      // Hour angle at sunrise/sunset
      const latRad = LAT * Math.PI / 180;
      const cosH = -Math.tan(latRad) * Math.tan(decl);
      const clamped = Math.max(-1, Math.min(1, cosH));
      const H = Math.acos(clamped) * 180 / Math.PI; // degrees
      // Solar noon in LOCAL CLOCK HOURS. Solar noon is 12:00 UTC on the prime
      // meridian and shifts 4 minutes (1/15 h) per degree of longitude east, so
      // the UTC instant is 12 - LON/15. Convert that to the viewer's own clock
      // with their UTC offset, because getSunFactor() compares against local
      // wall-clock time. (For a house at longitude 0 viewed from UTC this is
      // exactly 12, which is what the reference implementation assumed.)
      const utcOffsetH = -now.getTimezoneOffset() / 60;
      const solarNoon = 12 - LON / 15 + utcOffsetH;
      const rise = solarNoon - H / 15;
      const set = solarNoon + H / 15;
      return { rise, set };
    }

    function getSunFactor() {
      // No site in the profile: a fixed, neutral daylight. Better than picking a
      // latitude on the author's behalf and being confidently wrong about it.
      if (!HAS_SITE) return 0.85;
      const now = new Date();
      const h = now.getHours() + now.getMinutes() / 60;
      const { rise, set } = getSunTimes();
      // Transition periods: 1 hour for dawn, 1 hour for dusk
      const dawnStart = rise - 0.5;   // civil twilight ~30min before sunrise
      const dawnEnd = rise + 0.5;     // full brightness 30min after sunrise
      const duskStart = set - 0.5;    // start dimming 30min before sunset
      const duskEnd = set + 0.5;      // dark 30min after sunset

      if (h < dawnStart) return 0;                                    // night
      if (h < dawnEnd) return (h - dawnStart) / (dawnEnd - dawnStart); // dawn: 0→1
      if (h < duskStart) return 1;                                     // day
      if (h < duskEnd) return 1 - (h - duskStart) / (duskEnd - duskStart); // dusk: 1→0
      return 0;                                                        // night
    }

    let sunEnabled = true;
    // "auto" | "morning" | "noon" | "night"
    let sunMode = "auto";

    // Fixed sun factors for preset modes
    const SUN_MODE_FACTORS = { morning: 0.42, noon: 1.0, night: 0.0 };
    // Colour tints per preset: [r, g, b] for sun directional light
    const SUN_MODE_COLORS  = { morning: [1.0, 0.70, 0.38], noon: [1.0, 0.93, 0.85], night: [0.4, 0.45, 0.6] };

    function updateSunlight() {
      if (!sunEnabled) {
        sun.intensity = 0;
        ambLight.intensity = 0.12;
        ambLight.color.setRGB(0.85, 0.85, 0.9);
        gndMat.color.setRGB(0x18/255, 0x18/255, 0x18/255);
        scene.background.setRGB(0x0f/255, 0x0f/255, 0x1a/255);
        clouds.forEach(c => { c.material.opacity = 0; });
        return;
      }
      const f = sunMode === "auto" ? getSunFactor() : SUN_MODE_FACTORS[sunMode];
      // Sun directional: exterior light hitting roof/ground — 0 at night, 0.8 at peak
      sun.intensity = f * 0.8;
      // Sun color: preset overrides, otherwise auto from factor
      if (sunMode !== "auto" && SUN_MODE_COLORS[sunMode]) {
        const [sr, sg, sb] = SUN_MODE_COLORS[sunMode];
        sun.color.setRGB(sr, sg, sb);
      } else if (f < 0.7) {
        sun.color.setRGB(1.0, 0.75, 0.45);   // warm gold (dawn/dusk)
      } else {
        sun.color.setRGB(1.0, 0.93, 0.85);   // neutral warm white (midday)
      }
      // Ambient: this is what lights the interior (penetrates roof)
      // Night: dim 0.12, Day: bright 0.7 — simulates light through windows
      ambLight.intensity = 0.12 + f * 0.58;
      ambLight.color.setRGB(0.85 + f * 0.15, 0.85 + f * 0.12, 0.9 + f * 0.1);
      // Ground: dark at night, visible green-grey during day
      const gr = (0x18 + Math.round(f * 0x22)) / 255;
      const gg = (0x18 + Math.round(f * 0x28)) / 255;
      const gb = (0x18 + Math.round(f * 0x18)) / 255;
      gndMat.color.setRGB(gr, gg, gb);
      // Background: dark navy at night, dark blue-grey during day
      const bgR = (0x0f + Math.round(f * 0x18)) / 255;
      const bgG = (0x0f + Math.round(f * 0x17)) / 255;
      const bgB = (0x1a + Math.round(f * 0x1e)) / 255;
      scene.background.setRGB(bgR, bgG, bgB);
      // Clouds: tinted with sun. Warm gold at dawn/dusk, white at noon, faint
      // blue-grey at night. Preset modes match the sun color tints above.
      let cr, cg, cb;
      if (sunMode !== "auto" && SUN_MODE_COLORS[sunMode]) {
        [cr, cg, cb] = SUN_MODE_COLORS[sunMode];
      } else if (f < 0.7) {
        cr = 1.0; cg = 0.82; cb = 0.65;
      } else {
        cr = 1.0; cg = 0.98; cb = 0.95;
      }
      const cloudOpacity = 0.25 + f * 0.6;
      clouds.forEach(c => {
        c.material.color.setRGB(cr, cg, cb);
        c.material.opacity = cloudOpacity;
      });
    }
    updateSunlight();

    let lastSunCheck = 0;

    // ── Pause control ──────────────────────────────────────────────────────
    // The render loop keeps requesting frames (cheap) but does NO work while
    // paused. Two independent reasons to pause, OR'd together:
    //   _hidden   — the tab/app is backgrounded (Page Visibility API). Handled
    //               internally below for every mode.
    //   _inactive — the embedder called setActive(false): the preview is behind
    //               an open popup, off the active swipe slide, or scrolled out.
    // Unpausing resets the clock so rotation/cloud drift don't lurch forward.
    let _hidden = (typeof document !== 'undefined' && document.hidden) || false;
    let _inactive = false;
    let paused = _hidden || _inactive;
    function applyPause() {
      const p = _hidden || _inactive;
      if (p === paused) return;
      paused = p;
      if (!paused) { lastRender = performance.now(); needsRender = true; } // repaint on resume
    }

    // onRender subscribers — external overlays (e.g. the compass rose in
    // home3d.html) that must update every rendered frame, in lockstep with the
    // on-demand render loop below. Each fn is called AFTER ren.render() with
    // { cam }. Kept as a plain additive list so nothing existing changes
    // behaviour; a throwing subscriber can't break the render loop (guarded).
    const onRenderSubs = [];

    // Render loop — frame-rate-capped + pausable. minFrameMs gates the heavy
    // work; dt is measured from the last RENDERED frame so motion stays
    // time-correct regardless of the cap (a 15fps cap rotates at the same speed
    // as uncapped, just in bigger steps).
    let animId;
    let autoAngle = 0;
    const minFrameMs = maxFps > 0 ? (1000 / maxFps) - 1 : 0;
    let lastRender = performance.now();
    (function loop() {
      animId = requestAnimationFrame(loop);
      if (paused) return;
      const frameNow = performance.now();
      if (minFrameMs && (frameNow - lastRender) < minFrameMs) return;

      // On-demand gate: a non-auto-rotating scene (the #3d popup) renders only
      // while the user is interacting (drag, or the short tail after a wheel/
      // pinch via wakeUntil), while an opacity transition is still settling, or
      // when a redraw was explicitly requested (camera/light/sun/HA change,
      // resize, resume). Otherwise it idles at ~0 GPU — an open-but-untouched
      // popup costs nothing. The preview (autoRotate) always has motion, so it
      // skips this gate and just honours the maxFps cap.
      const interacting = orb.drag || orb.pan || frameNow < wakeUntil;
      if (!autoRotate && !needsRender && !interacting && !transitionsActive) return;

      // Seconds since last rendered frame, clamped so a long idle/pause doesn't jump
      const dt = Math.min((frameNow - lastRender) / 1000, 0.1);
      lastRender = frameNow;
      needsRender = false;

      if (autoRotate && !orb.drag && !orb.pan) {
        autoAngle += rotateSpeed * dt;
        orb.th = Math.PI * 0.22 + autoAngle;
        updCam();
      }
      // Update sunlight every 60 seconds
      const now = Date.now();
      if (now - lastSunCheck > 60000) { updateSunlight(); lastSunCheck = now; }

      // Transparent walls / ceiling ease toward target; track whether anything is
      // still moving so the loop knows to keep rendering until it settles.
      let animating = false;
      const camDir = new THREE.Vector3().subVectors(orb.tgt, cam.position).normalize();
      wallMeshes.forEach(({ mesh, nx, nz, outer }) => {
        if (!outer) return;
        const dot = nx * camDir.x + nz * camDir.z;
        const targetOpacity = dot > 0.3 ? 0.05 : 1.0; // more see-through shell (was 0.12) — design intent: exterior walls fainter when facing camera
        mesh.material.opacity += (targetOpacity - mesh.material.opacity) * 0.12;
        // BLACK-HALF FIX (scout-blackhalf): the living-room acoustic slat panel
        // meshes are a stack of coplanar transparent boxes registered here —
        // write depth only while effectively opaque so the z-buffer resolves the
        // stack (kills the half-solid-black artifact), and stop writing depth
        // once faded so the panel still reads see-through with its exterior wall.
        // Plain single-box walls are unaffected (harmless: they read as opaque).
        mesh.material.depthWrite = mesh.material.opacity > 0.98;
        if (Math.abs(targetOpacity - mesh.material.opacity) > 0.004) animating = true;
      });
      // Ceilings — see-through while the camera is above the house, solid once
      // it dips below ceiling height (i.e. you're looking from inside a room).
      const ceilTarget = cam.position.y > WH ? 0 : 1.0;
      ceilingMesh.material.opacity += (ceilTarget - ceilingMesh.material.opacity) * 0.12;
      if (Math.abs(ceilTarget - ceilingMesh.material.opacity) > 0.004) animating = true;

      // Clouds drift only while the scene is "awake" (auto-rotating preview, or a
      // popup the user is actively moving). An idle popup freezes the sky so it
      // can stop rendering entirely.
      if (autoRotate || interacting) {
        clouds.forEach(cl => {
          cl.position.x += cl.userData.driftSpeed * dt;
          if (cl.position.x > cl.userData.wrapMaxX) cl.position.x = cl.userData.wrapMinX;
        });
      }
      transitionsActive = animating;
      ren.render(scene, cam);

      // Progressive ramp: once the first frames are on screen, restore the full
      // shadow configuration this scene was asked for. Runs exactly once, and
      // requests one more frame so the newly enabled shadow pass is painted.
      if (!shadowsRamped && ++framesRendered >= PROGRESSIVE_FRAMES) {
        shadowsRamped = true;
        ren.shadowMap.enabled = wantShadows;
        ren.shadowMap.needsUpdate = true;
        // Materials compiled without the shadow defines must be recompiled with
        // them, exactly as setShadows() does.
        scene.traverse(obj => { if (obj.material) obj.material.needsUpdate = true; });
        needsRender = true;
        if (typeof window !== 'undefined') window.__qualityReadyAt = performance.now();
      }
      // Notify onRender subscribers (compass overlay etc.) after the frame is
      // drawn, so screen-space overlays can track the current camera. Guarded
      // so a bad subscriber can't wedge the render loop.
      for (let i = 0; i < onRenderSubs.length; i++) {
        try { onRenderSubs[i](cam); } catch (e) { /* overlay error must not break render */ }
      }
    })();

    // Event handlers (only if interactive or auto-rotate preview needs resize)
    const handlers = [];
    const on = (el, ev, fn, opts) => { el.addEventListener(ev, fn, opts); handlers.push([el, ev, fn, opts]); };

    // Pause whenever the tab/app is backgrounded (every mode). The embedder
    // adds further reasons via setActive() (popup open / off-screen preview).
    on(document, "visibilitychange", () => { _hidden = document.hidden; applyPause(); });

    if (interactive) {
      let pinchDist = null;

      on(container, "pointerdown", e => {
        container.setPointerCapture(e.pointerId);
        // button: 0=left (rotate, existing), 1=middle, 2=right (pan, new) —
        // industry convention (Three.js OrbitControls, Blender/Maya/SketchUp).
        // Touch contacts always report button 0, so touch keeps rotating here;
        // touch-pan is handled separately below via 2-finger touchmove.
        if (e.button === 2) { orb.pan = true; } else { orb.drag = true; }
        orb.px = e.clientX; orb.py = e.clientY;
        clickStart.x = e.clientX; clickStart.y = e.clientY;
      });
      on(container, "pointermove", e => {
        const r = container.getBoundingClientRect();
        mouse.x = ((e.clientX - r.left) / r.width) * 2 - 1;
        mouse.y = -((e.clientY - r.top) / r.height) * 2 + 1;
        if (orb.drag) {
          orb.th += (e.clientX - orb.px) * 0.005;
          orb.ph = Math.max(0.05, Math.min(Math.PI - 0.05, orb.ph - (e.clientY - orb.py) * 0.005));
          orb.px = e.clientX; orb.py = e.clientY;
          updCam();
        } else if (orb.pan) {
          panCam(e.clientX - orb.px, e.clientY - orb.py);
          orb.px = e.clientX; orb.py = e.clientY;
        }
      });
      on(container, "pointerup", e => {
        container.releasePointerCapture(e.pointerId);
        orb.drag = false;
        orb.pan = false;
        wake(250); // brief tail so the release settles smoothly under on-demand
      });
      on(container, "pointercancel", e => {
        container.releasePointerCapture(e.pointerId);
        orb.drag = false;
        orb.pan = false;
      });
      // Right-drag is repurposed for pan — suppress the browser's native
      // right-click context menu on the canvas so it doesn't pop up mid-drag.
      on(container, "contextmenu", e => { e.preventDefault(); });
      on(container, "click", e => {
        if (Math.abs(e.clientX - clickStart.x) > 5 || Math.abs(e.clientY - clickStart.y) > 5) return;
        rc.setFromCamera(mouse, cam);
        const h = rc.intersectObjects(scene.children, true).find(x => x.object.userData.clickable);
        if (h && onRoomClick) onRoomClick(h.object.userData.roomId);
      });
      on(container, "wheel", e => {
        e.preventDefault();
        // Min zoom distance lowered 4 -> 1 (2026-07-10, requested) so the
        // camera can push right inside a room. cam.near is 0.1 (see camera
        // create above), well under 1, so nothing clips at this range. Max 30.
        // Floor further lowered 1 -> -30 (2026-07-17, requested): r crossing
        // 0 carries the camera through orb.tgt and out the far side of the
        // house ("zoom through to the other side"). Symmetric with the +30 max.
        orb.r = Math.max(-30, Math.min(30, orb.r + e.deltaY * 0.012));
        updCam();
        wake(250);
      }, { passive: false });

      // Pinch to zoom + 2-finger-drag to pan (mobile convention: 1-finger =
      // rotate via the pointer handlers above, 2-finger-drag = pan, pinch
      // distance-change = zoom — both read off the same 2-touch stream so a
      // user can pinch and drag at once, same as most mobile 3D apps).
      let panCentroid = null;
      on(container, "touchmove", e => {
        if (e.touches.length === 2) {
          e.preventDefault();
          const dx = e.touches[0].clientX - e.touches[1].clientX;
          const dy = e.touches[0].clientY - e.touches[1].clientY;
          const dist = Math.sqrt(dx*dx + dy*dy);
          const cx = (e.touches[0].clientX + e.touches[1].clientX) / 2;
          const cy = (e.touches[0].clientY + e.touches[1].clientY) / 2;
          if (pinchDist !== null) {
            // Min zoom 4 -> 1 (2026-07-10, requested), same as wheel above.
            // Floor further lowered 1 -> -30 (2026-07-17), same as wheel above.
            orb.r = Math.max(-30, Math.min(30, orb.r - (dist - pinchDist) * 0.05));
            panCam(cx - panCentroid.x, cy - panCentroid.y); // also updCam()s
            wake(250);
          }
          pinchDist = dist;
          panCentroid = { x: cx, y: cy };
          orb.drag = false;
        } else {
          pinchDist = null;
          panCentroid = null;
        }
      }, { passive: false });
      on(container, "touchend", () => { pinchDist = null; panCentroid = null; });
    }

    on(window, "resize", () => {
      const w = container.clientWidth, h = container.clientHeight;
      if (w === 0 || h === 0) return;
      cam.aspect = w / h;
      cam.updateProjectionMatrix();
      ren.setSize(w, h);
      requestRender();
    });

    return {
      scene,
      lightState,
      updateLights: syncLights,
      ROOMS,
      LIGHTS,
      roomIds: ids,
      setSun(enabled) {
        sunEnabled = enabled;
        updateSunlight();
        requestRender();
      },
      setSunMode(mode) {
        sunMode = mode;
        updateSunlight();
        requestRender();
      },
      getSunMode() { return sunMode; },
      // Per-room door openness (panel slider — UI only, no HA wiring).
      // pct: 0 = fully closed, 100 = fully open at the door's collision-solved
      // max angle, always in its fixed single swing direction (swingSign).
      // Returns null for rooms without a door (living room).
      getDoorOpen(roomId) {
        const dr = doorByRoom[roomId];
        return dr ? dr.openPct : null;
      },
      setDoorOpen(roomId, pct) {
        const dr = doorByRoom[roomId];
        if (!dr) return;
        dr.openPct = Math.max(0, Math.min(100, +pct || 0));
        dr.pivot.rotation.y = dr.swingSign * (dr.maxDeg * dr.openPct / 100) * Math.PI / 180;
        requestRender();
      },
      // Embedder pause control: setActive(false) halts the render loop (no GPU
      // work) without tearing down the scene; setActive(true) resumes. Used by
      // the preview tile to stop rendering behind an open popup / when off-screen.
      setActive(active) { _inactive = !active; applyPause(); },
      setShadows(enabled) {
        // An explicit caller wins over the progressive ramp: cancel it so the
        // ramp cannot overwrite this choice a frame later.
        shadowsRamped = true;
        ren.shadowMap.enabled = enabled;
        ren.shadowMap.needsUpdate = true;
        // Force all materials to recompile with/without shadow defines
        scene.traverse(obj => { if (obj.material) obj.material.needsUpdate = true; });
        requestRender();
      },
      // Generic on-demand-render trigger for external callers that mutate the
      // scene graph directly (e.g. js/wall-debug-overlay.js toggling its
      // label group's visibility outside any of the setters above) -- this
      // render loop only repaints on requestRender()/wake(), so a direct
      // `scene.add`/`.visible = x` from outside is otherwise invisible until
      // the next drag/scroll.
      requestRender() { requestRender(); },
      // The live orbit camera — external overlays that project world points into
      // screen space (e.g. the compass rose) read this each frame. Returned by
      // reference; callers must not mutate it.
      getCamera() { return cam; },
      // Jump the orbit camera to a named preset view (top/se/front/iso/…) —
      // powers `?camera=<preset>` for scriptable visual review. Unknown/absent
      // name is a no-op (default view unchanged). Returns true if applied.
      setView(name) { return setView(name); },
      // Preset names, for callers that want to validate/enumerate.
      viewPresets: Object.keys(CAMERA_PRESETS),
      // Subscribe an overlay to post-render frames. fn(cam) runs after every
      // rendered frame (see onRenderSubs above). Returns an unsubscribe fn.
      // The scene renders on demand, so also nudge one frame now in case the
      // scene is currently idle when the subscriber attaches.
      onRender(fn) {
        if (typeof fn !== "function") return () => {};
        onRenderSubs.push(fn);
        requestRender();
        return () => {
          const i = onRenderSubs.indexOf(fn);
          if (i >= 0) onRenderSubs.splice(i, 1);
        };
      },
      dispose() {
        cancelAnimationFrame(animId);
        handlers.forEach(([el, ev, fn, o]) => el.removeEventListener(ev, fn, o));
        ren.dispose();
        if (container.contains(ren.domElement)) container.removeChild(ren.domElement);
      }
    };
  }

  // ---- Derived data exports ------------------------------------------------
  //
  // These are the module's PUBLIC SURFACE, consumed by the debug overlays in
  // src/overlays/ and by embedders (index.html reads ROOMS and LIGHTS to build
  // the controls panel). They used to be constants computed once from a
  // hardcoded house. They are now DERIVED FROM THE LOADED PROFILE and rebuilt
  // by refreshExports() whenever useHouse() binds a new one.
  //
  // The exported object identity is stable -- `api` below is created once and
  // its properties are reassigned in place -- so a caller that captured
  // `Home3DScene` at load time sees the current house's data. What a caller
  // must NOT do is destructure a value out before create() has resolved: until
  // a house is bound these are empty. Read them after create().
  //
  // Everything here derives from WALL_EXT (the corner-filled centrelines), not
  // from the authored WALLS, because the overlays draw over what is actually
  // rendered.
  function refreshExports() {
    // Wall segments in WORLD space for wall-debug-overlay.js. `id` is carried
    // through so the overlay labels by the wall's PERMANENT id, never by array
    // position -- position shifts whenever a wall is retired, the id does not.
    api.WALL_SEGMENTS_WORLD = WALL_EXT.map(w => ({
      id: w.id, x1: tx(w.x1), z1: tz(w.y1), x2: tx(w.x2), z2: tz(w.y2)
    }));

    // Door label anchors in WORLD space for door-debug-overlay.js. Each door
    // gets a stable 1-based `num` (its position in the schedule + 1 -- these
    // are user-facing debug labels like "door #3", not permanent ids) plus its
    // opening centre. Centre in cm: for an x-wall door that is [c, at]; for a
    // z-wall door it is [at, c] (see doorBasis).
    api.DOOR_LABELS_WORLD = DOORS.map((d, i) => {
      const cxCm = d.wall === 'x' ? d.c : d.at;
      const cyCm = d.wall === 'x' ? d.at : d.c;
      return { num: i + 1, id: d.id, name: d.name, x: tx(cxCm), z: tz(cyCm) };
    });

    // Model-space footprint for home3d-grid-overlay.js. The grid draws in MODEL
    // coordinates (cm -- the same numbers as the profile) but must place its
    // geometry in WORLD space, so it needs the bounds AND the transform.
    api.FOOTPRINT_BOUNDS = HOUSE
      ? { minX: HOUSE.footprint.minX, maxX: HOUSE.footprint.maxX,
          minY: HOUSE.footprint.minY, maxY: HOUSE.footprint.maxY }
      : { minX: 0, maxX: 0, minY: 0, maxY: 0 };

    // Exported so the overlays position their lines and labels with the exact
    // same transform the scene uses for walls, guaranteeing registration.
    api.COORD_TRANSFORM = { tx, tz, S, OX, OY };

    api.ROOMS = ROOMS;
    api.LIGHTS = LIGHTS;
    api.WALL_HEIGHT = WH;
    api.HOUSE = activeHouse;
  }

  // The stable public object. Built once; refreshExports() reassigns the
  // house-derived properties in place so the identity never changes.
  const api = {
    create,
    useHouse,
    k2h,
    ROOMS: {},
    LIGHTS: {},
    HOUSE: null,
    WALL_HEIGHT: 2.5,
    WALL_SEGMENTS_WORLD: [],
    DOOR_LABELS_WORLD: [],
    FOOTPRINT_BOUNDS: { minX: 0, maxX: 0, minY: 0, maxY: 0 },
    COORD_TRANSFORM: { tx, tz, S, OX, OY }
  };

  return api;
})();
