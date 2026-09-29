/**
 * tv-screen.js -- a TV's screen follows its TV: matte black glass when the
 * set is off, a lit home screen when it is on.
 *
 * Pure ESM, THREE injected (no `import 'three'`), so the same code runs in
 * the Node tests, the live scene and the spec pages. Four pieces:
 *
 *   tvScreenOn(raw)           a media_player state -> is the panel lit?
 *   tvScreenMode(...)         the TV's state + its optional ART condition
 *                             -> 'off' | 'on' | 'art'
 *   tvEntityBindings(items)   rooms.json sensors.items -> itemId -> the entity
 *                             of the item's `role: "tv"` media row
 *   makeTvScreenMaterial()    the screen's ONE material, built in the off look
 *   applyTvScreenLook(m, on)  flip that material between the two looks
 *
 * STATE -> LOOK. Home Assistant's media_player states, for a TV:
 *
 *   on, idle, playing, paused, buffering   LIT  -- the panel is showing
 *                                          something. `idle` is a TV sitting
 *                                          on its home screen (most TV
 *                                          integrations report it that way),
 *                                          and `paused` still shows the
 *                                          paused picture.
 *   off, standby                           DARK -- standby is the set's own
 *                                          "off with the network up".
 *   unavailable, unknown, no reading,      DARK -- nothing says the panel is
 *   anything else                          on, so it is not drawn on. A TV
 *                                          with no binding at all is dark too.
 *
 * THE TWO LOOKS are the SAME material with different uniforms, never a
 * different material or program: the screen's emissive map (the home-screen
 * picture) is attached at build time and stays attached, and "off" simply
 * multiplies it by a black emissive colour. So a switch changes three
 * uniforms, adds no light, compiles no shader and allocates nothing.
 *
 *   off  glass colour (the item's `screenColor`, darkened to near-black)
 *        lit by the room, roughness GLASS_ROUGHNESS, plus the GLASS SHEEN:
 *        a very faint, fixed "reflection" -- a soft diagonal band, a little
 *        more towards the top, and a thin brighter rim at the edges. The
 *        live house has no environment map, so a dark smooth panel in a dim
 *        room otherwise renders pure 0 and vanishes into a dark wall behind
 *        it (a black slat wall, say); the sheen keeps its outline and surface
 *        readable while it stays unmistakably black and unlit. OFF_SHEEN is
 *        a few sRGB levels at most, and neutral grey, never blue.
 *   on   the same glass, plus the home-screen picture as emission at
 *        ON_INTENSITY, and no sheen.
 *
 * The sheen is spliced into the fragment shader (onBeforeCompile) and driven
 * by one uniform; every TV shares the one program (customProgramCacheKey).
 *
 * ART MODE. A TV's media row may carry an `art` condition (rooms.json
 * schemaVersion 1.10): `{ entity, attribute?, value }`. It HOLDS when the
 * entity is 'on' and its `attribute` equals `value` -- say a streaming
 * stick's remote whose current_activity is a photo-frame app -- or, with no
 * attribute, when the entity's state equals `value`. While the TV is lit
 * AND the condition holds, the screen shows the ART look instead of the home
 * screen: a second invented picture (a painting in a mat), drawn once and
 * shared like the first, swapped in as the emissive map -- same material,
 * same program -- at a lower, matte intensity. A TV that is off stays black
 * glass whatever the condition says.
 *
 * THE PICTURE is invented: a generic smart-TV home screen (a hero banner and
 * rows of rounded app tiles in varied colours), drawn procedurally once per
 * page into a 16:9 canvas and shared by every TV. It carries NO real brand
 * name, logo or trademark -- the shapes are abstract and the only words are
 * generic menu labels. In Node (no DOM) it is a 1x1 texture, so the builder
 * stays pure and the material keeps the same shape (a map is present) either
 * way.
 */

/** The media_player states that mean the panel is lit. */
export const TV_ON_STATES = Object.freeze(['on', 'idle', 'playing', 'paused', 'buffering']);

/** The emission multiplier of a lit screen (the picture's own colours x this). */
export const ON_INTENSITY = 1.15;
/** Art mode: dimmer than the home screen -- a matte picture, not a glowing UI. */
export const ART_INTENSITY = 0.62;
/** Art mode's surface: a matte (anti-glare) panel, not glossy glass. */
export const ART_ROUGHNESS = 0.85;
/** The three looks a screen can be in. */
export const TV_MODES = Object.freeze(['off', 'on', 'art']);
/** Screen glass: smooth enough to catch the room's highlights when dark. */
export const GLASS_ROUGHNESS = 0.3;
/** The off glass is the item's screenColor scaled by this -- near black. */
export const GLASS_DARKEN = 0.3;
/**
 * The off glass's fixed sheen, linear RGB per channel, before the shader's
 * weights (SHEEN_WEIGHTS). Neutral grey: never tints blue.
 */
export const OFF_SHEEN = 0.006;
/**
 * The shader's weights on the sheen: a floor, a rise towards the top (x uv
 * y), a soft diagonal band and the edge rim, each term 0..1. TV_SHEEN_GLSL
 * is written FROM these, so the brightest the sheen can ever be is
 * OFF_SHEEN x their sum (sheenPeak) -- held under SHEEN_PEAK_MAX.
 */
export const SHEEN_WEIGHTS = Object.freeze({ base: 0.25, top: 0.2, band: 0.45, rim: 1.0 });
/** The most the off glass may add, linear: a few sRGB levels after tone mapping. */
export const SHEEN_PEAK_MAX = 0.012;
/** The brightest the off sheen can be anywhere on the panel (all terms at 1). */
export function sheenPeak() {
  const w = SHEEN_WEIGHTS;
  return OFF_SHEEN * (w.base + w.top + w.band + w.rim);
}
/** A JS number as a GLSL float literal (1 -> '1.0'). */
const glslFloat = v => (Number.isInteger(v) ? v.toFixed(1) : String(v));

/** The picture's size: 16:9, enough for a big TV seen across a room. */
export const HOME_W = 768;
export const HOME_H = 432;

/**
 * Is the panel lit? `raw` is a Home Assistant state object ({ state, ... }),
 * a bare state string, or null/undefined (no reading).
 */
export function tvScreenOn(raw) {
  const st = raw && typeof raw === 'object' ? raw.state : raw;
  return typeof st === 'string' && TV_ON_STATES.indexOf(st) !== -1;
}

/**
 * A media row's `art` condition -> { entity, attribute, value }, or null
 * when it is missing or malformed (then the TV simply has no art mode).
 */
export function normaliseArtCondition(art) {
  if (!art || typeof art !== 'object' || Array.isArray(art)) return null;
  if (typeof art.entity !== 'string' || !/^[a-z_]+\.[a-z0-9_]+$/.test(art.entity)) return null;
  if (typeof art.value !== 'string' || !art.value) return null;
  if (art.attribute !== undefined && (typeof art.attribute !== 'string' || !art.attribute)) return null;
  return { entity: art.entity, attribute: art.attribute || null, value: art.value };
}

/**
 * Does an art condition hold for its entity's raw state? With an
 * attribute: the entity is 'on' and that attribute equals `value`. Without:
 * the entity's state equals `value`. No reading -> no.
 */
export function artHolds(art, raw) {
  if (!art || !raw || typeof raw !== 'object') return false;
  if (art.attribute) {
    const a = raw.attributes || {};
    return raw.state === 'on' && a[art.attribute] === art.value;
  }
  return raw.state === art.value;
}

/** A value from the scene's API or the debug seam -> 'off' | 'on' | 'art'. */
export function tvMode(v) {
  if (v === 'art') return 'art';
  return !v || v === 'off' ? 'off' : 'on';
}

/**
 * The screen's mode from HA: dark unless the TV is lit (tvScreenOn); lit and
 * the art condition holding -> 'art'; otherwise 'on'.
 */
export function tvScreenMode(tvRaw, art, artRaw) {
  if (!tvScreenOn(tvRaw)) return 'off';
  return art && artHolds(art, artRaw) ? 'art' : 'on';
}

/**
 * rooms.json `sensors.items` -> Map furnitureId -> { entity, art } for that
 * item's first `role: "tv"` media row (first card, first row, as
 * tvEntityBindings); `art` is its normalised condition or null.
 */
export function tvBindings(items) {
  const out = new Map();
  if (!items || typeof items !== 'object') return out;
  Object.keys(items).forEach(itemId => {
    const raw = items[itemId];
    const cards = Array.isArray(raw) ? raw : [raw];
    for (const card of cards) {
      const media = card && Array.isArray(card.media) ? card.media : [];
      const row = media.find(r => r && r.role === 'tv' && typeof r.entity === 'string' &&
        r.entity.indexOf('media_player.') === 0);
      if (row) { out.set(itemId, { entity: row.entity, art: normaliseArtCondition(row.art) }); return; }
    }
  });
  return out;
}

/**
 * rooms.json `sensors.items` -> Map furnitureId -> the entity id of that
 * item's first `role: "tv"` media row (in authored card and row order).
 * Items with no such row are absent: their screen stays dark. Reads the raw
 * binding (the shape src/item-cards.js documents) rather than importing its
 * normaliser, so this module stays a leaf the builders can load.
 */
export function tvEntityBindings(items) {
  const out = new Map();
  if (!items || typeof items !== 'object') return out;
  tvBindings(items).forEach((b, itemId) => out.set(itemId, b.entity));
  return out;
}

/** '#rrggbb' -> 0xrrggbb, scaled by k per channel; fallback when malformed. */
function scaledHex(color, k, fallback) {
  if (typeof color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(color)) return fallback;
  const n = parseInt(color.slice(1), 16);
  const ch = s => Math.round(((n >> s) & 0xff) * k);
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
}

/**
 * The look for a mode ('off' | 'on' | 'art', or a boolean), as plain values
 * -- what applyTvScreenLook writes. `picture` names the emissive map:
 * 'home' (the home screen) or 'art' (the painting).
 * @returns {{ emissive, emissiveIntensity, sheen, roughness, picture }}
 */
export function tvScreenLook(mode) {
  const m = tvMode(mode);
  if (m === 'art') return { emissive: 0xffffff, emissiveIntensity: ART_INTENSITY, sheen: 0, roughness: ART_ROUGHNESS, picture: 'art' };
  if (m === 'on') return { emissive: 0xffffff, emissiveIntensity: ON_INTENSITY, sheen: 0, roughness: GLASS_ROUGHNESS, picture: 'home' };
  return { emissive: 0x000000, emissiveIntensity: 0, sheen: OFF_SHEEN, roughness: GLASS_ROUGHNESS, picture: 'home' };
}

/**
 * Put a screen material in the look for `mode` ('off' | 'on' | 'art', or a
 * boolean). Touches only uniforms -- the emissive colour and intensity, the
 * sheen, the roughness -- and the emissive map's TEXTURE, swapped between
 * the two shared pictures (the map is always present, so the program never
 * changes; both pictures are the same kind of texture).
 * @returns {boolean} true when anything changed (the caller repaints then)
 */
export function applyTvScreenLook(mat, mode) {
  if (!mat) return false;
  const m = tvMode(mode);
  const look = tvScreenLook(m);
  const ud = mat.userData || {};
  const pics = ud.tvPictures || null;
  const map = pics ? pics[look.picture] : mat.emissiveMap;
  const sheen = ud.tvSheen ? ud.tvSheen.value : null;
  const same = ud.tvMode === m && mat.emissive && mat.emissive.getHex() === look.emissive &&
    mat.emissiveIntensity === look.emissiveIntensity && mat.roughness === look.roughness &&
    mat.emissiveMap === map && (!sheen || (sheen.r === look.sheen && sheen.g === look.sheen && sheen.b === look.sheen));
  mat.emissive.setHex(look.emissive);
  mat.emissiveIntensity = look.emissiveIntensity;
  mat.roughness = look.roughness;
  if (map) mat.emissiveMap = map;
  if (sheen) sheen.setScalar(look.sheen);
  mat.userData.tvMode = m;
  mat.userData.tvOn = m !== 'off';
  return !same;
}

/**
 * The screen material, built OFF. Stamped `finish: 'emissive'` (the palette
 * entry for screens -- a kept, never-merged finish), and its mesh is made a
 * dynamic part by the builder so the scene can flip it per item.
 */
export function makeTvScreenMaterial(THREE, screenColor) {
  const mat = new THREE.MeshStandardMaterial({
    color: scaledHex(screenColor, GLASS_DARKEN, 0x080a0d),
    roughness: GLASS_ROUGHNESS,
    metalness: 0,
    emissive: 0x000000,
    emissiveIntensity: 0,
    emissiveMap: tvHomeTexture(THREE)
  });
  mat.userData.finish = 'emissive';
  mat.userData.tvScreen = true;
  mat.userData.tvOn = false;
  mat.userData.tvMode = 'off';
  // The two shared pictures the emissive map swaps between (never disposed
  // per TV: they are page-wide; see the texture caches below).
  mat.userData.tvPictures = { home: tvHomeTexture(THREE), art: tvArtTexture(THREE) };
  // The off-glass sheen: one uniform per TV (its own look), one program for
  // every TV. Built off, so it starts at OFF_SHEEN.
  mat.userData.tvSheen = { value: new THREE.Color().setScalar(OFF_SHEEN) };
  mat.onBeforeCompile = shader => {
    shader.uniforms.tvSheen = mat.userData.tvSheen;
    shader.fragmentShader = injectTvSheen(shader.fragmentShader);
  };
  mat.customProgramCacheKey = () => 'tv-screen-glass-1';
  return mat;
}

/**
 * The sheen, spliced in right after the emissive map is applied, in that
 * map's own uv (0..1 across the panel's front). Weights: a floor, a slow
 * rise towards the top, a soft diagonal band (a window's reflection), and a
 * thin rim at the panel's edge -- what outlines it against a dark wall.
 */
export const TV_SHEEN_GLSL = [
  '{',
  '  vec2 tvq = vEmissiveMapUv;',
  '  float tvBand = exp( -pow( ( tvq.x * 0.7 - tvq.y + 0.25 ) / 0.22, 2.0 ) );',
  '  float tvEdge = min( min( tvq.x, 1.0 - tvq.x ), min( tvq.y, 1.0 - tvq.y ) );',
  '  float tvRim = 1.0 - smoothstep( 0.0, 0.018, tvEdge );',
  '  totalEmissiveRadiance += tvSheen * ( ' + glslFloat(SHEEN_WEIGHTS.base) + ' + ' + glslFloat(SHEEN_WEIGHTS.top) +
    ' * tvq.y + ' + glslFloat(SHEEN_WEIGHTS.band) + ' * tvBand + ' + glslFloat(SHEEN_WEIGHTS.rim) + ' * tvRim );',
  '}'
].join('\n');

/** Splice the sheen into a MeshStandardMaterial fragment shader. */
export function injectTvSheen(fragmentShader) {
  const anchor = '#include <emissivemap_fragment>';
  if (typeof fragmentShader !== 'string' || fragmentShader.indexOf(anchor) === -1) return fragmentShader;
  return fragmentShader
    .replace('#include <common>', '#include <common>\nuniform vec3 tvSheen;')
    .replace(anchor, anchor + '\n' + TV_SHEEN_GLSL);
}

/**
 * Light or darken every TV screen inside `root` (a built TV, or a group of
 * them) -- for a page that shows a TV with no Home Assistant: the spec page
 * shows it ON, so the lit look is the one that gets signed off.
 * @returns {number} how many screens it touched
 */
export function setTvScreensIn(root, mode) {
  let n = 0;
  if (root && root.traverse) root.traverse(o => {
    if (o.isMesh && o.userData && o.userData.tvScreen) { applyTvScreenLook(o.material, mode); n++; }
  });
  return n;
}

/**
 * The scene's TV screens: which are built, and which should be lit. The
 * wanted state is kept apart from the meshes, so a reading that lands
 * before the furniture attaches is applied when it does. `repaint` is
 * called only when a look actually changed (the scene renders on demand).
 *
 *   set(itemId, mode)        remember ('off' | 'on' | 'art', or a
 *                            boolean); apply (and repaint) if built
 *   attach(dynamicByItemId)  index a furniture build's screens and put each
 *                            in its wanted look; true if any look changed
 *                            (the caller repaints after attaching anyway)
 *   clear()                  forget the meshes (furniture disposed)
 *   entries()                [[itemId, mesh], ...]
 */
export function createTvScreens(repaint) {
  const meshes = new Map();
  const want = new Map();
  const apply = id => {
    const mesh = meshes.get(id);
    return mesh ? applyTvScreenLook(mesh.material, want.get(id) || 'off') : false;
  };
  return {
    set(itemId, mode) {
      want.set(itemId, tvMode(mode));
      if (apply(itemId) && repaint) repaint();
    },
    attach(dynamicByItemId) {
      meshes.clear();
      let changed = false;
      Object.keys(dynamicByItemId || {}).forEach(itemId => {
        const dyn = dynamicByItemId[itemId];
        if (!dyn || !dyn.group) return;
        dyn.group.traverse(o => { if (o.isMesh && o.userData && o.userData.tvScreen) meshes.set(itemId, o); });
        if (apply(itemId)) changed = true;
      });
      return changed;
    },
    clear() { meshes.clear(); },
    entries() { return [...meshes]; }
  };
}

// One picture of each kind per THREE namespace (the live page has one; a
// test may load another). A disposed texture is re-uploaded by three when
// drawn again, so a house rebuilt after disposeFurniture() reuses it safely.
// Both pictures are built the SAME way (same class, size, colour space and
// filtering), which is what lets a screen swap between them without a new
// shader program.
const pictureCache = new Map();

function makePicture(THREE, kind, draw, fallbackRgb) {
  let byKind = pictureCache.get(THREE);
  if (!byKind) { byKind = new Map(); pictureCache.set(THREE, byKind); }
  if (byKind.has(kind)) return byKind.get(kind);
  let tex = null;
  const canvas = makeCanvas(HOME_W, HOME_H);
  if (canvas) {
    const ctx = canvas.getContext('2d');
    if (ctx) {
      draw(ctx, HOME_W, HOME_H);
      tex = new THREE.CanvasTexture(canvas);
      tex.anisotropy = 4;
    }
  }
  if (!tex) {
    tex = new THREE.DataTexture(new Uint8Array(fallbackRgb.concat(255)), 1, 1);
    tex.needsUpdate = true;
  }
  if ('colorSpace' in tex && THREE.SRGBColorSpace) tex.colorSpace = THREE.SRGBColorSpace;
  tex.name = 'tv-' + kind;
  tex.userData = Object.assign({}, tex.userData, kind === 'home-screen' ? { tvHome: true } : { tvArt: true });
  byKind.set(kind, tex);
  return tex;
}

/** The shared home-screen texture (a canvas in a browser, 1x1 in Node). */
export function tvHomeTexture(THREE) {
  return makePicture(THREE, 'home-screen', drawTvHome, [40, 60, 90]);
}

/** The shared art-mode texture: a painting in a mat (a canvas in a browser, 1x1 in Node). */
export function tvArtTexture(THREE) {
  return makePicture(THREE, 'art', drawTvArt, [200, 170, 130]);
}

function makeCanvas(w, h) {
  if (typeof document !== 'undefined' && document.createElement) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  return null;
}

function rr(ctx, x, y, w, h, r) {
  const q = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + q, y);
  ctx.arcTo(x + w, y, x + w, y + h, q);
  ctx.arcTo(x + w, y + h, x, y + h, q);
  ctx.arcTo(x, y + h, x, y, q);
  ctx.arcTo(x, y, x + w, y, q);
  ctx.closePath();
}

function grad(ctx, x0, y0, x1, y1, stops) {
  const g = ctx.createLinearGradient(x0, y0, x1, y1);
  stops.forEach((c, i) => g.addColorStop(i / (stops.length - 1), c));
  return g;
}

/**
 * Draw the invented home screen into a 2D context of w x h. Deterministic
 * (no randomness, no clock), so every page draws the same picture.
 */
export function drawTvHome(ctx, w, h) {
  const s = w / 768;           // designed at 768 x 432
  const S = v => v * s;
  // Backdrop: deep blue-grey, lighter towards the top.
  ctx.fillStyle = grad(ctx, 0, 0, 0, h, ['#1d2640', '#121829', '#0c101c']);
  ctx.fillRect(0, 0, w, h);

  // Top bar: a round profile badge, four menu tabs (the first selected),
  // and two round icons on the right.
  ctx.fillStyle = '#e0875a';
  ctx.beginPath(); ctx.arc(S(34), S(26), S(11), 0, Math.PI * 2); ctx.fill();
  const tabs = ['Home', 'Live', 'Apps', 'Library'];
  ctx.font = '600 ' + S(13) + 'px sans-serif';
  ctx.textBaseline = 'middle';
  let tx = S(62);
  tabs.forEach((t, i) => {
    const tw = ctx.measureText(t).width + S(22);
    if (i === 0) { ctx.fillStyle = '#e8ecf5'; rr(ctx, tx, S(15), tw, S(22), S(11)); ctx.fill(); }
    ctx.fillStyle = i === 0 ? '#141a2b' : '#aab3c8';
    ctx.fillText(t, tx + S(11), S(26.5));
    tx += tw + S(8);
  });
  ctx.fillStyle = '#7d879e';
  [w - S(58), w - S(32)].forEach(x => { ctx.beginPath(); ctx.arc(x, S(26), S(8), 0, Math.PI * 2); ctx.fill(); });

  // Hero banner: a warm evening sky over layered hills, a title block and
  // two pill buttons -- shapes only, no words.
  const hx = S(24), hy = S(48), hw = w - S(48), hh = S(170);
  ctx.save();
  rr(ctx, hx, hy, hw, hh, S(14)); ctx.clip();
  ctx.fillStyle = grad(ctx, hx, hy, hx + hw, hy + hh, ['#f6b35c', '#e8646b', '#8a4fb8', '#3a3f9e']);
  ctx.fillRect(hx, hy, hw, hh);
  ctx.fillStyle = 'rgba(255,236,190,0.9)';
  ctx.beginPath(); ctx.arc(hx + hw * 0.72, hy + hh * 0.42, S(26), 0, Math.PI * 2); ctx.fill();
  const hill = (col, base, amp, phase) => {
    ctx.fillStyle = col;
    ctx.beginPath(); ctx.moveTo(hx, hy + hh);
    for (let i = 0; i <= 24; i++) {
      const x = hx + hw * i / 24;
      ctx.lineTo(x, hy + hh * base - Math.sin(i / 24 * Math.PI * 2 + phase) * amp - Math.sin(i / 24 * Math.PI * 5 + phase) * amp * 0.35);
    }
    ctx.lineTo(hx + hw, hy + hh); ctx.closePath(); ctx.fill();
  };
  hill('rgba(92,46,120,0.85)', 0.72, S(14), 0.6);
  hill('rgba(48,30,86,0.92)', 0.84, S(10), 2.1);
  // A darkening from the left under the title block, so it reads.
  ctx.fillStyle = grad(ctx, hx, 0, hx + hw * 0.6, 0, ['rgba(10,12,28,0.72)', 'rgba(10,12,28,0)']);
  ctx.fillRect(hx, hy, hw, hh);
  ctx.restore();
  ctx.fillStyle = '#ffffff';
  rr(ctx, hx + S(22), hy + S(44), S(190), S(20), S(6)); ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  rr(ctx, hx + S(22), hy + S(74), S(250), S(9), S(4)); ctx.fill();
  rr(ctx, hx + S(22), hy + S(90), S(210), S(9), S(4)); ctx.fill();
  ctx.fillStyle = '#ffffff';
  rr(ctx, hx + S(22), hy + S(116), S(84), S(26), S(13)); ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.28)';
  rr(ctx, hx + S(114), hy + S(116), S(84), S(26), S(13)); ctx.fill();
  ctx.fillStyle = '#1b1f33';
  ctx.beginPath(); ctx.moveTo(hx + S(40), hy + S(122)); ctx.lineTo(hx + S(40), hy + S(136)); ctx.lineTo(hx + S(52), hy + S(129)); ctx.closePath(); ctx.fill();
  // Carousel dots.
  for (let i = 0; i < 5; i++) {
    ctx.fillStyle = i === 0 ? '#ffffff' : 'rgba(255,255,255,0.4)';
    ctx.beginPath(); ctx.arc(hx + hw / 2 + (i - 2) * S(12), hy + hh - S(12), S(3), 0, Math.PI * 2); ctx.fill();
  }

  // Row 1: app tiles -- rounded squares-ish in varied colours, each with a
  // simple white glyph. Invented; none is anybody's logo.
  const rowLabel = (y, lw) => { ctx.fillStyle = '#8f98ae'; rr(ctx, S(24), y, lw, S(9), S(4)); ctx.fill(); };
  rowLabel(S(232), S(70));
  const apps = [
    ['#ff7a59', '#e0553a', 'star'], ['#2f81f7', '#1d5fc4', 'wave'], ['#22b573', '#168a55', 'ring'],
    ['#f5a524', '#d0801a', 'bars'], ['#8e5cf6', '#6a3fd0', 'square'], ['#10b6c9', '#0b8a99', 'wave'],
    ['#ec4899', '#c02d78', 'ring'], ['#f0f2f7', '#c9cfdc', 'dots']
  ];
  const tw1 = S(84), th1 = S(56), gap = S(10);
  apps.forEach(([a, b, glyph], i) => {
    const x = S(24) + i * (tw1 + gap), y = S(248);
    ctx.fillStyle = grad(ctx, x, y, x + tw1, y + th1, [a, b]);
    rr(ctx, x, y, tw1, th1, S(10)); ctx.fill();
    if (i === 0) { ctx.strokeStyle = '#ffffff'; ctx.lineWidth = S(3); rr(ctx, x - S(3), y - S(3), tw1 + S(6), th1 + S(6), S(12)); ctx.stroke(); }
    drawGlyph(ctx, glyph, x + tw1 / 2, y + th1 / 2, S(13), glyph === 'dots' ? '#39415a' : '#ffffff');
  });

  // Row 2: wide thumbnails (16:9) with soft gradients, running off the
  // right edge and the bottom to imply more to scroll to.
  rowLabel(S(322), S(96));
  const thumbs = [
    ['#2b5876', '#4e4376'], ['#134e5e', '#71b280'], ['#614385', '#516395'],
    ['#c04848', '#480048'], ['#e0a96d', '#6b4f2c'], ['#355c7d', '#c06c84']
  ];
  const tw2 = S(140), th2 = S(80);
  thumbs.forEach(([a, b], i) => {
    const x = S(24) + i * (tw2 + gap), y = S(338);
    ctx.fillStyle = grad(ctx, x, y, x + tw2, y + th2, [a, b]);
    rr(ctx, x, y, tw2, th2, S(8)); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.18)';
    ctx.beginPath(); ctx.arc(x + tw2 * 0.7, y + th2 * 0.4, th2 * 0.28, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    rr(ctx, x + S(10), y + th2 - S(18), tw2 * 0.45, S(7), S(3)); ctx.fill();
  });
}

function drawGlyph(ctx, kind, cx, cy, r, color) {
  ctx.fillStyle = color; ctx.strokeStyle = color;
  ctx.lineWidth = r * 0.3; ctx.lineCap = 'round';
  ctx.beginPath();
  // Deliberately no "play triangle" tile: a red tile with a white play
  // triangle is a real video brand's mark.
  if (kind === 'wave') {
    ctx.moveTo(cx - r, cy);
    for (let i = 0; i <= 16; i++) ctx.lineTo(cx - r + 2 * r * i / 16, cy - Math.sin(i / 16 * Math.PI * 2) * r * 0.5);
    ctx.stroke();
  } else if (kind === 'ring') {
    ctx.arc(cx, cy, r * 0.7, 0, Math.PI * 2); ctx.stroke();
  } else if (kind === 'star') {
    for (let i = 0; i < 10; i++) {
      const a = -Math.PI / 2 + i * Math.PI / 5, rad = i % 2 ? r * 0.42 : r;
      ctx.lineTo(cx + Math.cos(a) * rad, cy + Math.sin(a) * rad);
    }
    ctx.closePath(); ctx.fill();
  } else if (kind === 'square') {
    rr(ctx, cx - r * 0.7, cy - r * 0.7, r * 1.4, r * 1.4, r * 0.3); ctx.fill();
  } else if (kind === 'bars') {
    [-0.6, 0, 0.6].forEach((dx, i) => { const bh = r * (0.8 + i * 0.4); ctx.fillRect(cx + dx * r - r * 0.18, cy + r * 0.8 - bh, r * 0.36, bh); });
  } else {
    [-0.6, 0, 0.6].forEach(dx => { ctx.beginPath(); ctx.arc(cx + dx * r, cy, r * 0.18, 0, Math.PI * 2); ctx.fill(); });
  }
}

/**
 * Draw the invented art-mode picture into a 2D context of w x h: a warm,
 * soft landscape painting (evening sky, a low sun, layered hills, a lake,
 * a few trees) set in a wide off-white mat with a thin inner bevel, the way
 * a frame TV shows art. Deterministic (a seeded generator for the brush
 * texture), no words, no real image.
 */
export function drawTvArt(ctx, w, h) {
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
  // The mat: warm off-white, very slightly darker at the edges.
  const matG = ctx.createRadialGradient(w / 2, h / 2, h * 0.2, w / 2, h / 2, w * 0.7);
  matG.addColorStop(0, '#efe9dd'); matG.addColorStop(1, '#ddd5c6');
  ctx.fillStyle = matG;
  ctx.fillRect(0, 0, w, h);
  // The picture's window in the mat (a museum-style wide mat, heavier below).
  const mx = w * 0.14, myTop = h * 0.14, myBot = h * 0.17;
  const px = mx, py = myTop, pw = w - mx * 2, ph = h - myTop - myBot;
  // Bevel: a thin light line inside a hairline shadow.
  ctx.fillStyle = '#b9ae9c'; ctx.fillRect(px - 5, py - 5, pw + 10, ph + 10);
  ctx.fillStyle = '#f7f3ea'; ctx.fillRect(px - 3, py - 3, pw + 6, ph + 6);
  ctx.save();
  ctx.beginPath(); ctx.rect(px, py, pw, ph); ctx.clip();
  // Sky: warm evening, peach to a soft dusky blue at the top.
  const sky = ctx.createLinearGradient(0, py, 0, py + ph * 0.62);
  sky.addColorStop(0, '#8fa3b8'); sky.addColorStop(0.45, '#e7b98d'); sky.addColorStop(1, '#f2cf9a');
  ctx.fillStyle = sky; ctx.fillRect(px, py, pw, ph);
  // A low sun with a soft halo.
  const sx = px + pw * 0.66, sy = py + ph * 0.5;
  const halo = ctx.createRadialGradient(sx, sy, 2, sx, sy, ph * 0.45);
  halo.addColorStop(0, 'rgba(255,236,196,0.95)'); halo.addColorStop(0.18, 'rgba(255,221,170,0.55)'); halo.addColorStop(1, 'rgba(255,210,160,0)');
  ctx.fillStyle = halo; ctx.fillRect(px, py, pw, ph);
  // Soft cloud streaks.
  for (let i = 0; i < 9; i++) {
    const cy = py + ph * (0.1 + rnd() * 0.3), cx = px + rnd() * pw, cw = pw * (0.12 + rnd() * 0.22);
    ctx.fillStyle = 'rgba(255,240,225,' + (0.18 + rnd() * 0.18).toFixed(2) + ')';
    ctx.beginPath(); ctx.ellipse(cx, cy, cw / 2, ph * 0.018, 0, 0, Math.PI * 2); ctx.fill();
  }
  // Layered hills, far (hazy) to near (deep).
  const hill = (base, amp, freq, phase, col) => {
    ctx.fillStyle = col; ctx.beginPath(); ctx.moveTo(px, py + ph);
    for (let i = 0; i <= 40; i++) {
      const x = px + pw * i / 40;
      const y = py + ph * base - Math.sin(i / 40 * Math.PI * freq + phase) * amp - Math.sin(i / 40 * Math.PI * freq * 2.3 + phase * 1.7) * amp * 0.35;
      ctx.lineTo(x, y);
    }
    ctx.lineTo(px + pw, py + ph); ctx.closePath(); ctx.fill();
  };
  hill(0.6, ph * 0.05, 2.2, 0.4, '#b8a4a8');
  hill(0.66, ph * 0.06, 1.6, 1.9, '#8f7f86');
  // The lake, catching the sky.
  const lake = ctx.createLinearGradient(0, py + ph * 0.7, 0, py + ph);
  lake.addColorStop(0, '#e9c79b'); lake.addColorStop(1, '#a8a3a4');
  ctx.fillStyle = lake; ctx.fillRect(px, py + ph * 0.7, pw, ph * 0.3);
  ctx.fillStyle = 'rgba(255,238,205,0.55)';
  for (let i = 0; i < 7; i++) ctx.fillRect(sx - pw * (0.02 + i * 0.012), py + ph * (0.73 + i * 0.035), pw * (0.04 + i * 0.024), 2);
  // Near shore and a few dark trees.
  hill(0.84, ph * 0.03, 1.2, 3.1, '#5b5a4c');
  ctx.fillStyle = '#3f4238';
  [0.1, 0.16, 0.2, 0.83, 0.9].forEach((f, i) => {
    const tx = px + pw * f, base = py + ph * 0.86, th = ph * (0.16 + (i % 3) * 0.04);
    ctx.beginPath(); ctx.moveTo(tx, base - th); ctx.lineTo(tx - th * 0.22, base); ctx.lineTo(tx + th * 0.22, base); ctx.closePath(); ctx.fill();
  });
  // Brush texture: short translucent strokes across the whole painting.
  for (let i = 0; i < 900; i++) {
    const x = px + rnd() * pw, y = py + rnd() * ph, l = 4 + rnd() * 10;
    ctx.strokeStyle = rnd() < 0.5 ? 'rgba(255,255,255,0.06)' : 'rgba(60,40,30,0.06)';
    ctx.lineWidth = 1 + rnd() * 1.5;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + l, y + (rnd() - 0.5) * 3); ctx.stroke();
  }
  ctx.restore();
}
