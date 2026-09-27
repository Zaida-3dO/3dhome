/**
 * Wall-face finishes -- brick, tile, and whatever comes next.
 *
 * A wall segment may carry `finishes` in its profile (schemaVersion 1.3):
 *
 *   "finishes": [
 *     { "finish": "brick", "side": "exterior" },
 *     { "finish": "tile",  "room": "bathroom", "to": 120, "along": [385, 600] }
 *   ]
 *
 * Each entry puts ONE procedural finish on ONE face of the wall, optionally
 * only over a height band (`from`/`to`, cm above the floor) and a span along
 * the wall (`along`, plan cm on the wall's long axis, the same convention as
 * a door's `centre`). The face is named by `side` -- `exterior` (derived: the
 * long face pointing away from the house), a compass side (a long face, or an
 * END face when the compass points along the wall, e.g. the north face of a
 * pillar authored north-south), or `start`/`end` -- or by `room` (the long
 * face fronting that room, probed exactly as windows are). The loader
 * resolves every entry to a plan-space normal (plus the end point for an end
 * face), so the renderer never re-derives it. `reveals` (default: on for
 * `exterior`) wraps the finish round the jambs of the wall's openings and
 * its own ends, as the spec pages' brick returns into a window reveal.
 *
 * HOW IT IS DRAWN (home3d-scene.js). Every finished face of a wall, for one
 * finish, is ONE merged mesh of quads 1.5 mm proud of the painted wall boxes:
 * a long-face quad per pier/cill/lintel box (so openings are skipped for
 * free), a cross-face quad per reveal and end face. ONE draw per finish per
 * wall however many boxes the wall is split into; the boxes themselves keep
 * their single material. The mesh fades with its wall as one unit.
 *
 * THE BRICK IS THE SPEC PAGES' BRICK. specs/WindowSpec.html and
 * specs/BalconyWindowSpec.html each draw the house's outer leaf with a
 * procedural running-bond buff brick (makeBrickTexture there). This is that
 * generator ported: the same UK 225 x 75 mm module, the same 46 x 14 px brick
 * in a 2 px mortar joint, the same 8 x 6 tile, the same mortar colour and six
 * face shades, the same hash2 shade pick, the same +/-9 per-brick jitter and
 * the same tiles-per-metre repeat. Two deliberate differences: the jitter is
 * seeded from the brick's row/column instead of Math.random(), so the wall
 * looks the same on every load and a test can pin it; and the brick
 * straddling the tile edge is one brick rather than two half-shades. The
 * spec pages keep their own copy -- they are standalone pages and this port
 * does not change their behaviour.
 *
 * TILE IS A PLACEHOLDER: a plain 15 cm square off-white tile with a pale
 * grout line, so the mechanism can be exercised. The real bathroom tile look
 * is a follow-up; replace FINISH_TYPES.tile's draw/size/module, nothing else.
 *
 * COST. Each finish type is ONE small canvas (brick 384 x 96, tile 128 x 128),
 * drawn once per page and shared, and ONE texture + ONE material template per
 * scene. Nothing here runs per frame.
 *
 * Pure apart from makeFinishCanvas(), which needs a `document` (or any object
 * with createElement('canvas') returning a 2D-capable canvas). THREE is passed
 * in, as in wall-fittings.js, so node tests can drive the vendored build.
 */

// ---- Brick (ported from the window spec pages) --------------------------

// Standard UK brick module: a 215 x 65 mm brick plus a 10 mm mortar joint.
export const BRICK_MODULE_W = 0.225;   // m (215mm brick + 10mm perpend)
export const BRICK_MODULE_H = 0.075;   // m (65mm brick + 10mm bed joint)

/** The canvas tile, in pixels. Cell 48 x 16 = the module's 3:1, isotropic. */
export const BRICK_TILE = Object.freeze({ brickW: 46, brickH: 14, mortar: 2, cols: 8, rows: 6 });

/** Mortar joint colour and the six brick-face shades, from the spec pages. */
export const BRICK_MORTAR = '#857151';
export const BRICK_SHADES = Object.freeze(['#9d8964', '#a99168', '#b09a7c', '#b5a284', '#bdac92', '#c6b8a2']);

/** Deterministic per-brick hash (the spec pages' hash2, verbatim). */
export function hash2(a, b) {
  let x = (a * 374761393 + b * 668265263) | 0;
  x = ((x ^ (x >>> 13)) * 1274126177) | 0;
  return (x ^ (x >>> 16)) >>> 0;
}

function jitterRgb(hex, delta) {
  const n = parseInt(hex.slice(1), 16);
  const clamp = v => Math.max(0, Math.min(255, Math.round(v)));
  return [
    clamp(((n >> 16) & 255) + delta),
    clamp(((n >> 8) & 255) + delta),
    clamp((n & 255) + delta)
  ];
}

/**
 * Every brick rectangle on the tile, in draw order: { x, y, w, h, rgb }.
 * Running bond: odd courses shift half a cell; columns -1..cols are drawn so
 * the shifted courses wrap seamlessly at the tile edge.
 */
export function brickLayout() {
  const { brickW, brickH, mortar, cols, rows } = BRICK_TILE;
  const cellW = brickW + mortar, cellH = brickH + mortar;
  const out = [];
  for (let row = 0; row < rows; row++) {
    const offset = (row % 2) * cellW / 2;
    for (let col = -1; col <= cols; col++) {
      // Column wrapped modulo `cols`: the brick drawn at col -1 on a shifted
      // course is the far half of col cols-1 coming round the tile edge, so
      // it must be the SAME brick. (The spec pages hash the raw column, which
      // gives that one straddling brick two different halves.)
      const wc = ((col % cols) + cols) % cols;
      const base = BRICK_SHADES[hash2(row, wc) % BRICK_SHADES.length];
      // The spec pages use (Math.random() - 0.5) * 18; this is the same
      // +/-9 spread, seeded by the brick so it is stable across loads.
      const u = hash2(row + 7919, wc + 104729) / 4294967296;
      out.push({
        x: col * cellW + offset + mortar / 2,
        y: row * cellH + mortar / 2,
        w: brickW, h: brickH,
        rgb: jitterRgb(base, (u - 0.5) * 18)
      });
    }
  }
  return out;
}

// ---- Tile (PLACEHOLDER) ------------------------------------------------

export const TILE_MODULE = 0.15;       // m, tile + grout, both axes
export const TILE_GRID = Object.freeze({ cell: 32, grout: 2, n: 4 });
export const TILE_GROUT = '#cfcac2';
export const TILE_FACE = '#f2f0ec';

export function tileLayout() {
  const { cell, grout, n } = TILE_GRID;
  const out = [];
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const u = hash2(r + 31, c + 17) / 4294967296;
      out.push({ x: c * cell + grout / 2, y: r * cell + grout / 2, w: cell - grout, h: cell - grout,
        rgb: jitterRgb(TILE_FACE, (u - 0.5) * 6) });
    }
  }
  return out;
}

// ---- The finish registry --------------------------------------------------

/**
 * Every finish the engine can draw. `size` is the canvas in px, `repeat` the
 * THREE texture repeat in TILES PER METRE (face UVs are in metres here -- see
 * faceUvMetres), `ground` the colour under the rects (mortar/grout).
 */
export const FINISH_TYPES = Object.freeze({
  brick: Object.freeze({
    size: () => {
      const { brickW, brickH, mortar, cols, rows } = BRICK_TILE;
      return { w: cols * (brickW + mortar), h: rows * (brickH + mortar) };
    },
    repeat: () => ({ x: 1 / (BRICK_TILE.cols * BRICK_MODULE_W), y: 1 / (BRICK_TILE.rows * BRICK_MODULE_H) }),
    ground: BRICK_MORTAR,
    layout: brickLayout,
    roughness: 0.9
  }),
  tile: Object.freeze({
    size: () => ({ w: TILE_GRID.cell * TILE_GRID.n, h: TILE_GRID.cell * TILE_GRID.n }),
    repeat: () => ({ x: 1 / (TILE_GRID.n * TILE_MODULE), y: 1 / (TILE_GRID.n * TILE_MODULE) }),
    ground: TILE_GROUT,
    layout: tileLayout,
    roughness: 0.35
  })
});

/** Finish names the engine knows. Anything else is warned about and ignored. */
export const FINISHES = Object.freeze(Object.keys(FINISH_TYPES));

const _canvases = {};
/**
 * A finish's tile as a canvas. Drawn ONCE per page and cached per finish:
 * every scene (the sidebar preview and the full page are separate scenes)
 * wraps the same pixels, so a second scene costs an upload, not a redraw.
 */
export function makeFinishCanvas(name, doc) {
  if (_canvases[name]) return _canvases[name];
  const type = FINISH_TYPES[name];
  if (!type) throw new Error('unknown finish "' + name + '"');
  const d = doc || (typeof document !== 'undefined' ? document : null);
  if (!d) throw new Error('makeFinishCanvas needs a document');
  const { w, h } = type.size();
  const c = d.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.fillStyle = type.ground;
  ctx.fillRect(0, 0, w, h);
  type.layout().forEach(b => {
    ctx.fillStyle = 'rgb(' + b.rgb[0] + ',' + b.rgb[1] + ',' + b.rgb[2] + ')';
    ctx.fillRect(b.x, b.y, b.w, b.h);
  });
  _canvases[name] = c;
  return c;
}

/** A CanvasTexture over the shared tile, tiled per metre. */
export function makeFinishTexture(THREE, name, doc) {
  const tex = new THREE.CanvasTexture(makeFinishCanvas(name, doc));
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  const r = FINISH_TYPES[name].repeat();
  tex.repeat.set(r.x, r.y);
  tex.anisotropy = 8;
  return tex;
}

// ---- Which face ------------------------------------------------------------

/** Compass side -> plan direction (x east, y SOUTH -- the plan's own axes). */
export function compassVector(side) {
  switch (side) {
    case 'north': return [0, -1];
    case 'south': return [0, 1];
    case 'east': return [1, 0];
    case 'west': return [-1, 0];
    default: return null;
  }
}

/**
 * The wall's unit normal (plan space) that agrees with `ref` -- i.e. the long
 * face pointing towards `ref`. null for a degenerate wall.
 */
export function faceNormalToward(wall, ref) {
  const dx = wall.x2 - wall.x1, dy = wall.y2 - wall.y1;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return null;
  let n = [-dy / len, dx / len];
  if (n[0] * ref[0] + n[1] * ref[1] < 0) n = [-n[0], -n[1]];
  return n;
}

/**
 * Which side of a wall is OUTSIDE: the long face pointing AWAY from the house
 * footprint's centre, judged from this wall's own midpoint -- never shared
 * with another wall, so two opposite walls authored in the same direction
 * still get opposite outsides. A concave house can defeat it (a wall in the
 * notch of an L); name the face by compass there instead.
 */
export function outsideVector(wall, centre) {
  return faceNormalToward(wall,
    [(wall.x1 + wall.x2) / 2 - centre[0], (wall.y1 + wall.y2) / 2 - centre[1]]);
}

// ---- Which rectangle -------------------------------------------------------

/**
 * A finish's span along the wall as metres from the wall's START
 * ([wall.x1, wall.y1] -- the corner-extended start the renderer builds from).
 * `along` is a pair of plan coordinates on the wall's long axis; null (or a
 * diagonal wall) means the whole length.
 */
export function alongToMetres(wall, along, S) {
  if (!along) return [-Infinity, Infinity];
  const horizontal = Math.abs(wall.y2 - wall.y1) < Math.abs(wall.x2 - wall.x1);
  const p1 = horizontal ? wall.x1 : wall.y1, p2 = horizontal ? wall.x2 : wall.y2;
  const sign = p2 >= p1 ? 1 : -1;
  const a = (along[0] - p1) * sign * S, b = (along[1] - p1) * sign * S;
  return [Math.min(a, b), Math.max(a, b)];
}

/**
 * The part of one wall box's face a finish covers.
 *
 * @param {[number,number]} box   [s0, s1] metres along the wall
 * @param {[number,number]} boxY  [bottom, top] world metres
 * @param {[number,number]} span  [s0, s1] finish span, metres (may be infinite)
 * @param {[number,number]} range [bottom, top] finish heights, metres (may be infinite)
 * @returns null (misses the box) | { full: true } | { full: false, s0, s1, y0, y1 }
 */
export function finishRectOnBox(box, boxY, span, range) {
  const EPS = 0.001;
  const s0 = Math.max(box[0], span[0]), s1 = Math.min(box[1], span[1]);
  const y0 = Math.max(boxY[0], range[0]), y1 = Math.min(boxY[1], range[1]);
  if (s1 - s0 < 0.005 || y1 - y0 < 0.005) return null;
  if (s0 - box[0] < EPS && box[1] - s1 < EPS && y0 - boxY[0] < EPS && boxY[1] - y1 < EPS) return { full: true };
  return { full: false, s0, s1, y0, y1 };
}

// ---- One mesh per finish per wall ------------------------------------------

/**
 * Every finished face of one wall, for one finish type, is drawn as ONE mesh:
 * a batch of quads, each 1.5 mm proud of the wall face it dresses, merged
 * into a single BufferGeometry with a single material. So a finish costs ONE
 * draw per wall however many pier/cill/lintel boxes the wall is split into
 * (wall 32 is 10 boxes), and the painted boxes underneath keep their single
 * material and single draw. The mesh fades with its wall as one unit.
 *
 * A quad is either
 *   - a LONG-face quad: on the face whose outward normal is `n`, over wall
 *     distance [s0, s1] (metres from the wall's start) and height [y0, y1]; or
 *   - a CROSS-face quad: across the wall's thickness at distance `s`, facing
 *     along the wall (`facing` +1 = toward the wall's end, -1 = toward its
 *     start), over height [y0, y1] -- a segment end face, or the reveal
 *     (jamb) of an opening.
 *
 * UVs are metres: u along the face, v = world height, so every finish keeps
 * its real size and a long face's coursing runs on across boxes.
 *
 * `frame` is the wall's world frame: { wx1, wz1 } its start, { ux, uz } its
 * unit direction, `T` its thickness (m).
 */
export const FINISH_OFFSET = 0.0015;   // m proud of the painted face

export function createFinishBatch() { return { pos: [], nrm: [], uv: [], idx: [] }; }

function pushQuad(batch, corners, normal, uvs) {
  // Wind the two triangles so their geometric normal agrees with `normal`
  // (the material is FrontSide).
  const [a, b, c] = corners;
  const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [c[0] - b[0], c[1] - b[1], c[2] - b[2]];
  const cx = e1[1] * e2[2] - e1[2] * e2[1], cy = e1[2] * e2[0] - e1[0] * e2[2], cz = e1[0] * e2[1] - e1[1] * e2[0];
  const flip = cx * normal[0] + cy * normal[1] + cz * normal[2] < 0;
  const order = flip ? [0, 3, 2, 1] : [0, 1, 2, 3];
  const base = batch.pos.length / 3;
  order.forEach(i => {
    batch.pos.push(corners[i][0], corners[i][1], corners[i][2]);
    batch.nrm.push(normal[0], normal[1], normal[2]);
    batch.uv.push(uvs[i][0], uvs[i][1]);
  });
  batch.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
}

/** A long-face quad. `n` is the face's outward plan normal. */
export function addLongFace(batch, frame, n, s0, s1, y0, y1) {
  const { wx1, wz1, ux, uz, T } = frame;
  const off = T / 2 + FINISH_OFFSET;
  const P = (s, y) => [wx1 + ux * s + n[0] * off, y, wz1 + uz * s + n[1] * off];
  // u runs left-to-right as seen from outside the face: along the wall when
  // the wall's direction is to the viewer's right, else against it.
  const sigma = (n[1] * ux - n[0] * uz) < 0 ? -1 : 1;
  pushQuad(batch, [P(s0, y0), P(s1, y0), P(s1, y1), P(s0, y1)], [n[0], 0, n[1]],
    [[sigma * s0, y0], [sigma * s1, y0], [sigma * s1, y1], [sigma * s0, y1]]);
}

/** A cross-face quad (segment end, or an opening's reveal) at wall distance s. */
export function addCrossFace(batch, frame, s, facing, y0, y1) {
  const { wx1, wz1, ux, uz, T } = frame;
  const sp = s + facing * FINISH_OFFSET;
  const px = -uz, pz = ux;   // across the wall
  const P = (t, y) => [wx1 + ux * sp + px * t, y, wz1 + uz * sp + pz * t];
  const h = T / 2;
  pushQuad(batch, [P(-h, y0), P(h, y0), P(h, y1), P(-h, y1)], [ux * facing, 0, uz * facing],
    [[-h, y0], [h, y0], [h, y1], [-h, y1]]);
}

/** The batch as one BufferGeometry (null when empty). */
export function buildFinishGeometry(THREE, batch) {
  if (!batch.idx.length) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(batch.pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(batch.nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(batch.uv, 2));
  g.setIndex(batch.idx);
  g.computeBoundingSphere();
  return g;
}

/**
 * Which of a box's two ends are REVEALS for a `reveals` finish: both ends of
 * a full-height box (a pier beside an opening, or the wall's own end). A
 * cill or lintel box's ends touch the piers either side, so they are skipped.
 */
export function revealEnds(boxHeight, fullHeight) {
  return Math.abs(boxHeight - fullHeight) < 1e-6;
}
