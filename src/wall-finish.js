/**
 * Wall-face finishes -- brick, tile, and whatever comes next.
 *
 * A wall segment may carry `finishes` in its profile (schemaVersion 1.3):
 *
 *   "finishes": [
 *     { "finish": "brick", "side": "exterior" },
 *     { "finish": "tile",  "room": "bathroom", "to": 120, "along": [385, 600],
 *       "look": { "relief": 5, "roughness": 0.35 } }
 *   ]
 *
 * Each entry puts ONE procedural finish on ONE face of the wall, optionally
 * only over a height band (`from`/`to`, cm above the floor) and a span along
 * the wall (`along`, plan cm on the wall's long axis, the same convention as
 * a door's `centre`); `gridAnchor: "from"` starts the tile grid at the
 * band's bottom instead of the floor (see GRID_ANCHORS). The face is named by `side` -- `exterior` (derived: the
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
 * THE TILE IS THE BATHROOM SPEC PAGES' TILE: a 40 x 25 cm landscape tile in a
 * 0.4 cm grout joint, flat or with an embossed 5 cm relief, ported from their
 * shared materials file. A tile entry may carry a `look` (size, grout,
 * colours, relief, roughness -- see TILE_DEFAULTS); the defaults are that
 * spec's flat tile. A look describes a tile, not a house.
 *
 * COST. Each finish LOOK is ONE small canvas (brick 384 x 96, the default
 * tile 256 x 160, never over 512 a side), drawn once per page and shared, and
 * ONE texture + ONE material template per scene. Nothing here runs per frame.
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

// ---- Tile (ported from the bathroom spec pages) ---------------------------

/**
 * The tile the bathroom spec pages draw (their shared materials file,
 * makeFlatTileTexture / makeTexturedTileTexture): a 40 x 25 cm tile, landscape,
 * with a 0.4 cm grout joint, a warm greige face and a darker grout. The canvas
 * is ONE tile at 6.4 px/cm (256 x 160), grout as the ground and the face
 * inset half a joint all round, so repeats meet in a full joint at the tile
 * pitch. The same numbers are the vanity counter's defaults
 * (src/furniture/bathroom.js), so a counter and the wall behind it agree.
 *
 * A tile finish may carry a `look` that changes any of these -- they are a
 * description of a tile, not of a house:
 *
 *   size        [w, h] cm, the tile PITCH (grout included)     [40, 25]
 *   grout       cm, the joint between tiles                      0.4
 *   colour      the tile face                                    '#cdc2b1'
 *   groutColour the joint                                        '#a89c87'
 *   relief      cm; 0 = a FLAT tile, else the face is embossed  0
 *               with a grid of squares about this size (the
 *               spec's wet-area tile is relief 5: 8 x 5 squares)
 *   roughness   the material's roughness                         0.55
 *
 * A RELIEF tile is the spec's makeTexturedTileTexture: one base tone over the
 * face, each emboss square its own shade (+/-4.5), a thin seam between squares
 * with a faint lighter highlight stroked over it. It is NOT grout -- the grout
 * joint stays only between whole tiles. The spec jitters with Math.random();
 * this seeds the jitter from the square's row/column (hash2), so the wall is
 * the same on every load. The spec's whole-tile +/-5 random tone is dropped:
 * its canvas is one tile repeated, so every tile shared that one random shade
 * anyway -- the base is the colour itself.
 */
export const TILE_PX_PER_CM = 6.4;     // 32 px per 5 cm emboss square, as the spec
export const TILE_MAX_PX = 512;        // a canvas side never exceeds this
export const TILE_DEFAULTS = Object.freeze({
  size: Object.freeze([40, 25]),
  grout: 0.4,
  colour: '#cdc2b1',
  groutColour: '#a89c87',
  relief: 0,
  roughness: 0.55
});
/** The relief's seam (cm), per-square shade spread, and highlight, from the spec. */
export const TILE_RELIEF = Object.freeze({ seam: 0.15, spread: 9, lift: 26, alpha: 0.35 });

const HEX6 = /^#[0-9a-fA-F]{6}$/;
const LOOK_KEYS = Object.keys(TILE_DEFAULTS);

/**
 * A tile `look` with its defaults filled in and every value checked. A bad
 * value is reported through `warn` and replaced by its default -- the tile is
 * still drawn, only that one property falls back. Returns a frozen object
 * with a canonical `key` (equal looks, equal keys), which is what the canvas,
 * texture, material and mesh are shared by.
 */
export function resolveTileLook(look, warn) {
  const say = typeof warn === 'function' ? warn : () => {};
  const src = look && typeof look === 'object' && !Array.isArray(look) ? look : {};
  if (look != null && src !== look) say('`look` must be an object -- using the default tile');
  Object.keys(src).forEach(k => {
    if (LOOK_KEYS.indexOf(k) === -1) say('look.' + k + ' is not a tile property (known: ' + LOOK_KEYS.join(', ') + ') -- ignored');
  });
  const pick = (k, ok, what) => {
    if (src[k] === undefined) return TILE_DEFAULTS[k];
    if (ok(src[k])) return src[k];
    say('look.' + k + ' ' + JSON.stringify(src[k]) + ' is not ' + what + ' -- using ' + JSON.stringify(TILE_DEFAULTS[k]));
    return TILE_DEFAULTS[k];
  };
  const num = (lo, hi) => v => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
  const size = pick('size', v => Array.isArray(v) && v.length === 2 && v.every(num(1, 500)),
    '[w, h] in cm (1..500 each)');
  const grout = pick('grout', v => num(0, 10)(v) && v < Math.min(size[0], size[1]) / 2,
    'a joint in cm (0 up to half the tile)');
  const colour = pick('colour', v => typeof v === 'string' && HEX6.test(v), 'a #rrggbb colour').toLowerCase();
  const groutColour = pick('groutColour', v => typeof v === 'string' && HEX6.test(v), 'a #rrggbb colour').toLowerCase();
  const relief = pick('relief', num(0, 500), 'a square size in cm (0 = flat)');
  const roughness = pick('roughness', num(0, 1), 'between 0 and 1');
  const out = { size: Object.freeze([size[0], size[1]]), grout, colour, groutColour, relief, roughness };
  out.key = [size[0], size[1], grout, colour, groutColour, relief, roughness].join(',');
  return Object.freeze(out);
}

const asLook = look => (look && look.key ? look : resolveTileLook(look));

/** The tile canvas's px per cm: the spec's 6.4, shrunk so no side passes TILE_MAX_PX. */
export function tilePxPerCm(look) {
  const L = asLook(look);
  return Math.min(TILE_PX_PER_CM, TILE_MAX_PX / L.size[0], TILE_MAX_PX / L.size[1]);
}

/** Emboss squares [across, down] a relief tile; [0, 0] when it is flat. */
export function reliefGrid(look) {
  const L = asLook(look);
  if (!(L.relief > 0)) return [0, 0];
  return [Math.max(1, Math.round(L.size[0] / L.relief)), Math.max(1, Math.round(L.size[1] / L.relief))];
}

/**
 * Every rect on the tile canvas, in draw order, over the grout ground:
 * { x, y, w, h, rgb, a? } -- `a` is an alpha, for the relief's highlight.
 */
export function tileLayout(look) {
  const L = asLook(look);
  const ppc = tilePxPerCm(L);
  const w = Math.round(L.size[0] * ppc), h = Math.round(L.size[1] * ppc);
  const g = L.grout > 0 ? Math.max(1, L.grout * ppc) : 0;
  const fx = g / 2, fy = g / 2, fw = w - g, fh = h - g;
  const out = [{ x: fx, y: fy, w: fw, h: fh, rgb: jitterRgb(L.colour, 0) }];
  const [cols, rows] = reliefGrid(L);
  if (!cols) return out;
  const sw = fw / cols, sh = fh / rows;
  const seam = Math.max(0.5, TILE_RELIEF.seam * ppc);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const u = hash2(r + 131, c + 977) / 4294967296;
      out.push({ x: fx + c * sw + seam / 2, y: fy + r * sh + seam / 2, w: sw - seam, h: sh - seam,
        rgb: jitterRgb(L.colour, (u - 0.5) * TILE_RELIEF.spread) });
    }
  }
  // The faint highlight over each inner seam -- a line `seam` wide, centred
  // on it, as the spec strokes it -- so the relief reads at a glance without
  // acting as grout.
  const hi = jitterRgb(L.colour, TILE_RELIEF.lift);
  for (let c = 1; c < cols; c++) out.push({ x: fx + c * sw - seam / 2, y: fy, w: seam, h: fh, rgb: hi, a: TILE_RELIEF.alpha });
  for (let r = 1; r < rows; r++) out.push({ x: fx, y: fy + r * sh - seam / 2, w: fw, h: seam, rgb: hi, a: TILE_RELIEF.alpha });
  return out;
}

// ---- The finish registry --------------------------------------------------

/**
 * Every finish the engine can draw. Each property is a function of the
 * finish's resolved `look` (brick has none and ignores it): `size` is the
 * canvas in px, `repeat` the THREE texture repeat in TILES PER METRE (face
 * UVs are in metres here -- see addLongFace), `ground` the colour under the
 * rects (mortar/grout). `srgb`: the canvas holds sRGB colours to be colour-
 * managed -- tile yes, so the wall's #cdc2b1 renders as the counter's
 * #cdc2b1; brick keeps the look it was signed off with.
 */
export const FINISH_TYPES = Object.freeze({
  brick: Object.freeze({
    size: () => {
      const { brickW, brickH, mortar, cols, rows } = BRICK_TILE;
      return { w: cols * (brickW + mortar), h: rows * (brickH + mortar) };
    },
    repeat: () => ({ x: 1 / (BRICK_TILE.cols * BRICK_MODULE_W), y: 1 / (BRICK_TILE.rows * BRICK_MODULE_H) }),
    ground: () => BRICK_MORTAR,
    layout: () => brickLayout(),
    roughness: () => 0.9,
    srgb: false,
    hasLook: false
  }),
  tile: Object.freeze({
    size: look => {
      const L = asLook(look), ppc = tilePxPerCm(L);
      return { w: Math.round(L.size[0] * ppc), h: Math.round(L.size[1] * ppc) };
    },
    // The canvas IS one tile, so the repeat is tiles per metre.
    repeat: look => { const L = asLook(look); return { x: 100 / L.size[0], y: 100 / L.size[1] }; },
    ground: look => asLook(look).groutColour,
    layout: look => tileLayout(look),
    roughness: look => asLook(look).roughness,
    srgb: true,
    hasLook: true
  })
});

/** Finish names the engine knows. Anything else is warned about and ignored. */
export const FINISHES = Object.freeze(Object.keys(FINISH_TYPES));

/**
 * What a finish's canvas, texture, material and per-wall mesh are shared by:
 * the finish name, plus its look for a finish that has one. Two entries on
 * one wall with the same key are one mesh -- one draw.
 */
export function finishKey(name, look) {
  const type = FINISH_TYPES[name];
  if (!type || !type.hasLook) return name;
  return name + ':' + asLook(look).key;
}

const _canvases = {};
/**
 * A finish's tile as a canvas. Drawn ONCE per page and cached per finish key:
 * every scene (the sidebar preview and the full page are separate scenes)
 * wraps the same pixels, so a second scene costs an upload, not a redraw.
 */
export function makeFinishCanvas(name, doc, look) {
  const type = FINISH_TYPES[name];
  if (!type) throw new Error('unknown finish "' + name + '"');
  const key = finishKey(name, look);
  if (_canvases[key]) return _canvases[key];
  const d = doc || (typeof document !== 'undefined' ? document : null);
  if (!d) throw new Error('makeFinishCanvas needs a document');
  const { w, h } = type.size(look);
  const c = d.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.fillStyle = type.ground(look);
  ctx.fillRect(0, 0, w, h);
  type.layout(look).forEach(b => {
    ctx.fillStyle = b.a != null
      ? 'rgba(' + b.rgb[0] + ',' + b.rgb[1] + ',' + b.rgb[2] + ',' + b.a + ')'
      : 'rgb(' + b.rgb[0] + ',' + b.rgb[1] + ',' + b.rgb[2] + ')';
    ctx.fillRect(b.x, b.y, b.w, b.h);
  });
  _canvases[key] = c;
  return c;
}

/** A CanvasTexture over the shared tile, tiled per metre. */
export function makeFinishTexture(THREE, name, doc, look) {
  const tex = new THREE.CanvasTexture(makeFinishCanvas(name, doc, look));
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  const r = FINISH_TYPES[name].repeat(look);
  tex.repeat.set(r.x, r.y);
  tex.anisotropy = 8;
  if (FINISH_TYPES[name].srgb && 'colorSpace' in tex) tex.colorSpace = THREE.SRGBColorSpace;
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
 * UVs are metres: u along the face, v = world height (less the finish's
 * grid origin -- gridOriginY), so every finish keeps its real size and a
 * long face's coursing runs on across boxes.
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

/**
 * Where a finish's grid starts vertically -- its `gridAnchor`:
 *
 *   'floor' (default) -- the grid is anchored at world height 0, the floor
 *            top: tile joints at 0, 25, 50 ... cm whatever the band is, so
 *            every band on every wall courses together.
 *   'from'  -- the grid is anchored at the band's own bottom, so a whole
 *            tile (or brick course) starts exactly on it: a 93-118 band on a
 *            93 cm counter is ONE full 25 cm row, not a 7 cm sliver at 93-100
 *            and an 18 cm piece above.
 */
export const GRID_ANCHORS = Object.freeze(['floor', 'from']);

/**
 * The world height (m) a finish's texture v = 0 sits at: 0 for 'floor', the
 * band's bottom as drawn (`range[0]`, already clamped to the wall) for
 * 'from'. The texture's v = 0 is a grout joint (the canvas is one tile with
 * half a joint round its edge), so this is where a row of joints lies.
 */
export function gridOriginY(anchor, range) {
  return anchor === 'from' && range && Number.isFinite(range[0]) ? range[0] : 0;
}

/**
 * A long-face quad. `n` is the face's outward plan normal. `vOrigin` is the
 * world height (m) the texture's v = 0 sits at -- gridOriginY(); 0 = the floor.
 */
export function addLongFace(batch, frame, n, s0, s1, y0, y1, vOrigin = 0) {
  const { wx1, wz1, ux, uz, T } = frame;
  const off = T / 2 + FINISH_OFFSET;
  const P = (s, y) => [wx1 + ux * s + n[0] * off, y, wz1 + uz * s + n[1] * off];
  // u runs left-to-right as seen from outside the face: along the wall when
  // the wall's direction is to the viewer's right, else against it.
  const sigma = (n[1] * ux - n[0] * uz) < 0 ? -1 : 1;
  const v0 = y0 - vOrigin, v1 = y1 - vOrigin;
  pushQuad(batch, [P(s0, y0), P(s1, y0), P(s1, y1), P(s0, y1)], [n[0], 0, n[1]],
    [[sigma * s0, v0], [sigma * s1, v0], [sigma * s1, v1], [sigma * s0, v1]]);
}

/**
 * A cross-face quad (segment end, or an opening's reveal) at wall distance s.
 * `vOrigin` as addLongFace, so a reveal courses with the face it returns from.
 */
export function addCrossFace(batch, frame, s, facing, y0, y1, vOrigin = 0) {
  const { wx1, wz1, ux, uz, T } = frame;
  const sp = s + facing * FINISH_OFFSET;
  const px = -uz, pz = ux;   // across the wall
  const P = (t, y) => [wx1 + ux * sp + px * t, y, wz1 + uz * sp + pz * t];
  const h = T / 2;
  const v0 = y0 - vOrigin, v1 = y1 - vOrigin;
  pushQuad(batch, [P(-h, y0), P(h, y0), P(h, y1), P(-h, y1)], [ux * facing, 0, uz * facing],
    [[-h, v0], [h, v0], [h, v1], [-h, v1]]);
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
