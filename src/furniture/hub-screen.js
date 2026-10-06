/**
 * hub-screen.js -- a smart display's screen shows what its speaker is
 * playing, drawn as a copy of Home Assistant's own media control card
 * (home-assistant/frontend, src/panels/lovelace/cards/hui-media-control-card.ts).
 * Anything but `playing` leaves the screen in its built look (dark glass, or
 * the dim ambient glow).
 *
 * Pure ESM, THREE injected (no `import 'three'`), so the same code runs in the
 * Node tests and the live scene. The pieces:
 *
 *   hubDisplayBindings(soundMenu)   rooms.json sensors.soundMenu -> Map
 *                                   itemId -> the media_player it plays on
 *   hubScreenContent(raw, baseUrl)  a media_player state -> what the screen
 *                                   shows: { mode: 'idle' } or { mode:
 *                                   'playing', title, artist, art, player,
 *                                   duration, position, positionAt }
 *   hubContentKey(content)          the identity of that content, for
 *                                   "did anything the screen shows change?"
 *   hubProgress(content, nowMs)     the progress bar's fraction, or null
 *   hubArtColors(rgba)              artwork pixels -> the card's background
 *                                   and foreground colours
 *   drawHubScreen(ctx, w, h, c, img, colors, nowMs)  paint it into a 2D canvas
 *   createHubScreens(opts)          the scene's per-item controller
 *
 * WHICH PLAYER. A smart display opens the sound menu as a speaker through
 * `sensors.soundMenu.openFrom` (`{ <itemId>: 'media_player.x' }`). That entity
 * is the speaker's ANCHOR: index.html follows every media_player of the same
 * physical speaker (src/speaker-players.js -- a Music Assistant speaker has
 * `_ma`, `_2` and the Cast entity) and shows the one actually playing. An
 * item with no openFrom entry has no player and keeps its built look.
 *
 * THE CARD (HA's layout, at canvas scale). The whole card is filled with the
 * artwork's dominant colour; the artwork is a card-height square on the
 * right; a gradient from that colour to transparent fades the art's left
 * edge into the card. On top, in a foreground colour picked for contrast:
 * the player's icon and name, then the title (1.2em), the artist, the
 * transport icons (drawn, not live: this is a picture of a screen) and a thin
 * progress track. With no artwork, as HA does: its primary blue, white text,
 * and a faint music graphic on the right half. The colours are HA's own rule
 * (extract_color.ts): the most populous colour is the background, the next
 * one with a 4.5:1 contrast is the foreground, else white or black by YIQ --
 * computed here from a small downsample instead of node-vibrant (no build
 * step, no dependency).
 *
 * STATE -> SCREEN. Only `playing` lights the card. `paused` is treated as not
 * playing (the built look): a paused speaker on a real Hub drops back to its
 * ambient screen after a moment. `buffering` (between tracks) keeps whatever
 * is showing -- see hubScreenContent.
 *
 * ARTWORK. `entity_picture` is either an absolute URL (Music Assistant passes
 * a Spotify cover straight through) or a path on the Home Assistant host,
 * /api/media_player_proxy/<entity>?token=<the entity's own rotating token>.
 * A WebGL texture needs a CORS-clean image, so the art is loaded as an
 * <img crossOrigin="anonymous">: it succeeds only when the image's host sends
 * Access-Control-Allow-Origin for this app. Anything that fails -- a load
 * error, a CORS refusal, a canvas that still reads back as tainted -- falls
 * back to the no-artwork card, and that URL is not retried while it stays the
 * same. The long-lived HA token is NEVER used for artwork.
 *
 * PERF. One small canvas (CANVAS_W wide, the screen's own aspect) and one
 * CanvasTexture per display, created on the first `playing` and disposed when
 * it stops. It is redrawn when hubContentKey changes (title, artist, artwork,
 * player, duration, or a re-anchored position -- the proxy URL's rotating
 * `token` is ignored), when the artwork finishes loading, and by the progress
 * tick: at most every PROGRESS_TICK_MS (0.5 Hz), only while a playing screen
 * has a duration, only when the bar moved a pixel, and only every
 * HIDDEN_TICK_EVERY-th tick for a screen out of view. Each redraw asks for ONE
 * repaint. The material always carries an emissive map (a shared 1x1 white
 * texture while idle), so switching never compiles a shader.
 */
import { normaliseSoundMenu } from '../sound-model.js';

/** The canvas width; the height follows the screen's aspect (clamped). */
export const CANVAS_W = 512;
export const CANVAS_H_MIN = 200;
export const CANVAS_H_MAX = 320;
/** A lit screen's emission multiplier: a touch under a TV's 1.15 -- a small panel, often seen at night. */
export const HUB_ON_INTENSITY = 0.9;
/** The only state that shows the card. */
export const HUB_PLAYING_STATES = Object.freeze(['playing']);
/** The progress bar's tick (ms): 0.5 Hz, and only while something is playing. */
export const PROGRESS_TICK_MS = 2000;
/** A screen out of view advances its bar only every Nth tick (every 10 s). */
export const HIDDEN_TICK_EVERY = 5;
/** HA's card with no artwork: --primary-color and --text-primary-color. */
export const HA_PRIMARY = '#03a9f4';
export const HA_TEXT_PRIMARY = '#ffffff';
/** The demo house (no Home Assistant): a generic sample with a generated-gradient cover. */
export const DEMO_NOW_PLAYING = Object.freeze({
  mode: 'playing', title: 'Sample track', artist: 'Demo artist', player: 'Kitchen display',
  duration: 214, position: 71, positionAt: null,
  art: Object.freeze({ gradient: Object.freeze(['#ff8a5c', '#7b3fe4', '#1f6fd1']) })
});
/** How many artworks (loaded or failed) are remembered page-wide. */
const ART_CACHE_MAX = 12;

const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const str = v => (typeof v === 'string' ? v.trim() : '');

/**
 * rooms.json sensors.soundMenu -> Map itemId -> media_player entity, for
 * every openFrom entry that names one of the menu's speakers. Empty when
 * there is no (valid) sound menu.
 */
export function hubDisplayBindings(soundMenu) {
  const cfg = normaliseSoundMenu(soundMenu);
  const out = new Map();
  if (!cfg) return out;
  cfg.openFrom.forEach((eid, itemId) => { if (eid) out.set(itemId, eid); });
  return out;
}

/**
 * An `entity_picture`(_local) -> an absolute URL the browser can load, or
 * null. Absolute http(s) and data:image URLs pass through; a path is joined to
 * Home Assistant's base URL (none known -> null). Anything else is refused.
 */
export function hubArtUrl(baseUrl, picture) {
  const p = str(picture);
  if (!p) return null;
  if (/^https?:\/\//i.test(p) || /^data:image\//i.test(p)) return p;
  if (p.charAt(0) !== '/' || p.charAt(1) === '/') return null;
  const b = str(baseUrl).replace(/\/+$/, '');
  return /^https?:\/\//i.test(b) ? b + p : null;
}

/** A player's display name: its friendly name minus MA's " - ma" suffix. */
export function hubPlayerName(raw) {
  const a = raw && isObj(raw.attributes) ? raw.attributes : {};
  return str(a.friendly_name).replace(/\s+-\s*ma$/i, '');
}

const num = v => (typeof v === 'number' && isFinite(v) ? v : typeof v === 'string' && v.trim() && isFinite(+v) ? +v : null);

/**
 * A media_player's raw state -> what its display shows.
 *   { mode: 'idle' }                     the built look
 *   { mode: 'playing', title, artist, art, player, duration, position, positionAt }
 *        art: an absolute URL, or null (the no-artwork card);
 *        duration/position: seconds or null; positionAt: ms epoch of
 *        media_position_updated_at, or null (a position that does not advance)
 *   { mode: 'hold' }                     buffering: keep what is on screen
 */
export function hubScreenContent(raw, baseUrl) {
  const st = raw && typeof raw === 'object' ? raw.state : null;
  if (st === 'buffering') return { mode: 'hold' };
  if (HUB_PLAYING_STATES.indexOf(st) === -1) return { mode: 'idle' };
  const a = isObj(raw.attributes) ? raw.attributes : {};
  const duration = num(a.media_duration);
  const at = Date.parse(str(a.media_position_updated_at));
  return {
    mode: 'playing',
    title: str(a.media_title),
    artist: str(a.media_artist) || str(a.media_album_artist),
    art: hubArtUrl(baseUrl, a.entity_picture) || hubArtUrl(baseUrl, a.entity_picture_local),
    player: hubPlayerName(raw),
    duration: duration && duration > 0 ? duration : null,
    position: num(a.media_position),
    positionAt: isFinite(at) ? at : null
  };
}

/** An artwork's identity: a URL minus HA's rotating `token` query parameter. */
export function hubArtKey(art) {
  if (!art) return '';
  if (typeof art !== 'string') return JSON.stringify(art);
  return art.replace(/([?&])token=[^&#]*&?/g, '$1').replace(/[?&]$/, '');
}

/** The identity of what the screen shows: equal keys -> nothing to redraw. */
export function hubContentKey(c) {
  if (!c || c.mode !== 'playing') return c && c.mode === 'hold' ? 'hold' : 'idle';
  return JSON.stringify(['playing', c.title || '', c.artist || '', hubArtKey(c.art), c.player || '',
    c.duration || null, c.position == null ? null : Math.round(c.position), c.positionAt || null]);
}

/**
 * The progress bar's fraction 0..1 at `nowMs`, or null when there is no bar
 * (no duration). HA publishes media_position with media_position_updated_at;
 * while playing the position advances from that moment (HA's own
 * getCurrentProgress). No anchor -> the position as given.
 */
export function hubProgress(c, nowMs) {
  if (!c || c.mode !== 'playing' || !(c.duration > 0)) return null;
  let pos = typeof c.position === 'number' ? c.position : 0;
  if (c.positionAt && typeof nowMs === 'number') pos += Math.max(0, (nowMs - c.positionAt) / 1000);
  return Math.max(0, Math.min(1, pos / c.duration));
}

/** The plain text of the card, for logs and the debug seam: "Title — Artist". */
export function hubCaption(c) {
  if (!c || c.mode !== 'playing') return '';
  const parts = [c.title, c.artist].filter(Boolean);
  return 'Now playing' + (parts.length ? ' · ' + parts.join(' — ') : '');
}

/** The canvas height for a screen of aspect w/h. */
export function hubCanvasHeight(aspect) {
  const a = typeof aspect === 'number' && isFinite(aspect) && aspect > 0 ? aspect : CANVAS_W / 300;
  return Math.max(CANVAS_H_MIN, Math.min(CANVAS_H_MAX, Math.round(CANVAS_W / a)));
}

// ---- colours (HA's extract_color.ts rule, without node-vibrant) -------------

const hex2 = n => ('0' + Math.max(0, Math.min(255, Math.round(n))).toString(16)).slice(-2);
const toHex = rgb => '#' + hex2(rgb[0]) + hex2(rgb[1]) + hex2(rgb[2]);
function fromHex(h) {
  const m = /^#?([0-9a-f]{6})$/i.exec(str(h));
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function luminance(rgb) {
  const c = rgb.map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
/** WCAG contrast ratio of two [r,g,b] colours (HA's getRGBContrastRatio). */
export function contrastRatio(a, b) {
  const l1 = luminance(a), l2 = luminance(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}
const yiq = rgb => (rgb[0] * 299 + rgb[1] * 587 + rgb[2] * 114) / 1000;

/** HA's foreground rule: the first other colour with 4.5:1 contrast, else white/black by YIQ. */
function pickForeground(bg, others) {
  for (const c of others) if (contrastRatio(bg, c) > 4.5) return c;
  return yiq(bg) < 200 ? [255, 255, 255] : [0, 0, 0];
}

/**
 * RGBA pixels (a small downsample of the artwork) -> { background,
 * foreground } as '#rrggbb'. Pixels are binned 8 levels per channel; the most
 * populous bin's mean is the background; the foreground follows HA's rule
 * over the remaining bins in population order. No usable pixel -> HA's
 * no-artwork colours.
 */
export function hubArtColors(rgba) {
  const bins = new Map();
  const n = rgba && rgba.length ? Math.floor(rgba.length / 4) : 0;
  for (let i = 0; i < n; i++) {
    const r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2], a = rgba[i * 4 + 3];
    if (a < 128) continue;
    const k = (r >> 5) << 6 | (g >> 5) << 3 | (b >> 5);
    const e = bins.get(k) || { n: 0, r: 0, g: 0, b: 0 };
    e.n++; e.r += r; e.g += g; e.b += b;
    bins.set(k, e);
  }
  if (!bins.size) return { background: HA_PRIMARY, foreground: HA_TEXT_PRIMARY };
  const sorted = [...bins.values()].sort((x, y) => y.n - x.n).map(e => [e.r / e.n, e.g / e.n, e.b / e.n]);
  const bg = sorted[0];
  return { background: toHex(bg), foreground: toHex(pickForeground(bg, sorted.slice(1))) };
}

/** A generated { gradient } cover's colours: its middle stop, and HA's foreground rule. */
export function hubGradientColors(stops) {
  const cs = (Array.isArray(stops) ? stops : []).map(fromHex).filter(Boolean);
  if (!cs.length) return { background: HA_PRIMARY, foreground: HA_TEXT_PRIMARY };
  const bg = cs[Math.floor(cs.length / 2)];
  return { background: toHex(bg), foreground: toHex(pickForeground(bg, cs.filter(c => c !== bg))) };
}

// ---- drawing ----------------------------------------------------------------

function fit(ctx, text, maxW) {
  if (!text) return '';
  if (ctx.measureText(text).width <= maxW) return text;
  let lo = 0, hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ctx.measureText(text.slice(0, mid) + '…').width <= maxW) lo = mid; else hi = mid - 1;
  }
  return text.slice(0, lo).trimEnd() + '…';
}

function gradientFill(ctx, x, y, w, h, stops) {
  const g = ctx.createLinearGradient(x, y, x + w, y + h);
  stops.forEach((c, i) => g.addColorStop(stops.length === 1 ? 0 : i / (stops.length - 1), c));
  return g;
}

// Material Design Icons (Apache 2.0), the ones HA's card shows: 24x24 paths.
const MDI = {
  speaker: 'M12,12A3,3 0 0,0 9,15A3,3 0 0,0 12,18A3,3 0 0,0 15,15A3,3 0 0,0 12,12M12,20A5,5 0 0,1 7,15A5,5 0 0,1 12,10A5,5 0 0,1 17,15A5,5 0 0,1 12,20M12,4A2,2 0 0,1 14,6A2,2 0 0,1 12,8C10.89,8 10,7.1 10,6C10,4.89 10.89,4 12,4M17,2H7C5.89,2 5,2.89 5,4V20A2,2 0 0,0 7,22H17A2,2 0 0,0 19,20V4C19,2.89 18.1,2 17,2Z',
  previous: 'M6,18V6H8V18H6M9.5,12L18,6V18L9.5,12Z',
  pause: 'M14,19H18V5H14M6,19H10V5H6V19Z',
  next: 'M16,18H18V6H16M6,18L14.5,12L6,6V18Z',
  music: 'M21,3V15.5A3.5,3.5 0 0,1 17.5,19A3.5,3.5 0 0,1 14,15.5A3.5,3.5 0 0,1 17.5,12C18.04,12 18.55,12.12 19,12.34V6.47L9,8.6V17.5A3.5,3.5 0 0,1 5.5,21A3.5,3.5 0 0,1 2,17.5A3.5,3.5 0 0,1 5.5,14C6.04,14 6.55,14.12 7,14.34V6L21,3Z'
};
const pathCache = new Map();
/** Fill an MDI icon at (x, y), `size` px square. A no-op without Path2D (Node). */
function icon(ctx, name, x, y, size) {
  if (typeof Path2D === 'undefined') return;
  let p = pathCache.get(name);
  if (!p) { p = new Path2D(MDI[name]); pathCache.set(name, p); }
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(size / 24, size / 24);
  ctx.fill(p);
  ctx.restore();
}

/**
 * Paint `c` (a 'playing' content) into a w x h context, as HA's media control
 * card. `img`: a loaded CORS-clean image, a { gradient } cover, or null (no
 * artwork). `colors`: { background, foreground } for the artwork (ignored
 * without one). `nowMs` places the progress bar. Returns the bar's filled
 * width in px (or -1 with no bar) -- the controller redraws only when it moves.
 */
export function drawHubScreen(ctx, w, h, c, img, colors, nowMs) {
  const k = w / 400;                       // HA's card is ~400 css px wide
  const hasArt = !!img;
  const col = hasArt && colors ? colors : { background: HA_PRIMARY, foreground: HA_TEXT_PRIMARY };
  // .color-block: the whole card in the background colour.
  ctx.globalAlpha = 1;
  ctx.fillStyle = col.background;
  ctx.fillRect(0, 0, w, h);
  if (hasArt) {
    // .image: a card-height square on the right, background-size: cover.
    const x0 = w - h;
    if (img.gradient) {
      ctx.fillStyle = gradientFill(ctx, x0, 0, h, h, img.gradient);
      ctx.fillRect(x0, 0, h, h);
    } else {
      const iw = img.naturalWidth || img.width || h, ih = img.naturalHeight || img.height || h;
      const q = Math.min(iw, ih);
      ctx.drawImage(img, (iw - q) / 2, (ih - q) / 2, q, q, x0, 0, h, h);
    }
    // .color-gradient: background -> transparent over the art's width.
    const rgb = fromHex(col.background) || [3, 169, 244];
    const g = ctx.createLinearGradient(x0, 0, w, 0);
    g.addColorStop(0, 'rgba(' + rgb.join(',') + ',1)');
    g.addColorStop(1, 'rgba(' + rgb.join(',') + ',0)');
    ctx.fillStyle = g;
    ctx.fillRect(x0, 0, h, h);
  } else {
    // .no-img: HA's faint music graphic over the right half.
    ctx.globalAlpha = 0.18;
    ctx.fillStyle = '#ffffff';
    const s = Math.min(w / 2, h) * 0.7;
    icon(ctx, 'music', w * 0.75 - s / 2, (h - s) / 2, s);
    ctx.globalAlpha = 1;
  }
  // .player: 16px padding, foreground colour.
  const pad = Math.round(16 * k);
  const fg = col.foreground;
  const base = Math.round(14 * k);
  ctx.fillStyle = fg;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  // .top-info: state icon + player name.
  const iconS = Math.round(24 * k);
  icon(ctx, 'speaker', pad, pad, iconS);
  ctx.font = '400 ' + base + 'px Roboto, "Noto Sans", sans-serif';
  const textMaxW = w - 2 * pad - (hasArt ? h * 0.25 : 0);
  ctx.fillText(fit(ctx, c.player || 'Speaker', textMaxW - iconS - 8 * k), pad + iconS + 8 * k, pad + iconS / 2);
  // Bottom-up: progress track, transport icons, artist, title.
  const trackH = Math.max(3, Math.round(8 * k * 0.6));
  const frac = hubProgress(c, nowMs);
  const trackY = h - pad - trackH;
  let barPx = -1;
  if (frac !== null) {
    const tw = w - 2 * pad;
    ctx.fillStyle = 'rgba(200,200,200,0.5)';
    ctx.fillRect(pad, trackY, tw, trackH);
    barPx = Math.round(tw * frac);
    ctx.fillStyle = fg;
    if (barPx > 0) ctx.fillRect(pad, trackY, barPx, trackH);
  }
  const ctlS = Math.round(30 * k), playS = Math.round(40 * k);
  const ctlMid = (frac !== null ? trackY - 6 * k : h - pad) - playS / 2;
  ctx.fillStyle = fg;
  let x = pad - 4 * k;
  icon(ctx, 'previous', x, ctlMid - ctlS / 2, ctlS); x += ctlS + 14 * k;
  icon(ctx, 'pause', x, ctlMid - playS / 2, playS); x += playS + 14 * k;
  icon(ctx, 'next', x, ctlMid - ctlS / 2, ctlS);
  let y = ctlMid - playS / 2 - 8 * k;
  ctx.textBaseline = 'alphabetic';
  if (c.artist) {
    ctx.font = '400 ' + base + 'px Roboto, "Noto Sans", sans-serif';
    ctx.fillText(fit(ctx, c.artist, textMaxW), pad, y);
    y -= base * 1.45;
  }
  ctx.font = '400 ' + Math.round(base * 1.2) + 'px Roboto, "Noto Sans", sans-serif';
  ctx.fillText(fit(ctx, c.title || c.artist || 'Playing', textMaxW), pad, y);
  return barPx;
}

// ---- the scene's controller ---------------------------------------------------

function defaultMakeCanvas(w, h) {
  if (typeof document !== 'undefined' && document.createElement) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  return null;
}

/** Load `url` as a CORS image: ok(img) / fail(). Returns abort(). No credentials, no referrer. */
function defaultLoadImage(url, ok, fail) {
  if (typeof Image === 'undefined') { fail(); return () => {}; }
  const img = new Image();
  let live = true;
  img.crossOrigin = 'anonymous';
  img.referrerPolicy = 'no-referrer';
  img.decoding = 'async';
  img.onload = () => { if (live) ok(img); };
  img.onerror = () => { if (live) fail(); };
  img.src = url;
  return () => { live = false; img.onload = img.onerror = null; };
}

// One 1x1 white texture per THREE namespace: an idle screen's emissive map,
// so the material never loses its map (no program switch on play/stop).
const blankCache = new Map();
/** The shared idle emissive map (white: the built emissive colour shows unchanged). */
export function hubBlankTexture(THREE) {
  if (blankCache.has(THREE)) return blankCache.get(THREE);
  const t = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  if ('colorSpace' in t && THREE.SRGBColorSpace) t.colorSpace = THREE.SRGBColorSpace;
  t.name = 'hub-blank';
  t.needsUpdate = true;
  blankCache.set(THREE, t);
  return t;
}

/**
 * The scene's per-item controller, every effect injectable for the tests:
 *   opts.THREE, opts.repaint()          one frame, on a real change
 *   opts.makeCanvas(w, h)               default: a DOM canvas (null in Node)
 *   opts.loadImage(url, ok, fail)       default: a CORS <img>; returns abort()
 *   opts.now()                          default: Date.now
 *   opts.isVisible(mesh)                default: the page is not hidden
 *   opts.setInterval / clearInterval    default: the globals
 *
 *   set(itemId, content) -> changed?    remembered; applied when it attaches
 *   attach(dynamicByItemId)             index the built screens and apply
 *   tick() -> changed?                  one progress tick (the timer calls it)
 *   clear()                             forget the meshes, free the textures
 *   entries() / state(itemId)           for tests and the debug seam
 *   stats                               { draws, loads, ticks }
 */
export function createHubScreens(opts) {
  const o = opts || {};
  const THREE = o.THREE;
  const repaint = o.repaint || (() => {});
  const makeCanvas = o.makeCanvas || defaultMakeCanvas;
  const loadImage = o.loadImage || defaultLoadImage;
  const now = o.now || (() => Date.now());
  const isVisible = o.isVisible || (() => typeof document === 'undefined' || !document.hidden);
  const setIv = o.setInterval || ((fn, ms) => setInterval(fn, ms));
  const clearIv = o.clearInterval || (id => clearInterval(id));
  const meshes = new Map();   // itemId -> screen mesh
  const want = new Map();     // itemId -> content
  const live = new Map();     // itemId -> { canvas, ctx, tex, art: 'none'|'loading'|'ok'|'failed', abort, barPx, ticks }
  const artCache = new Map(); // artKey -> { status: 'ok'|'failed', img, colors }
  const stats = { draws: 0, loads: 0, ticks: 0 };
  let timer = null;

  function remember(key, entry) {
    artCache.delete(key);
    artCache.set(key, entry);
    while (artCache.size > ART_CACHE_MAX) artCache.delete(artCache.keys().next().value);
  }

  // The progress timer runs only while some lit screen has a bar to move.
  function syncTimer() {
    let need = false;
    live.forEach((L, id) => { const c = want.get(id); if (c && c.mode === 'playing' && c.duration > 0 && meshes.has(id)) need = true; });
    if (need && timer === null) timer = setIv(() => tick(), PROGRESS_TICK_MS);
    else if (!need && timer !== null) { clearIv(timer); timer = null; }
  }

  // An artwork's card colours, from a 24x24 downsample; HA's defaults if unreadable.
  function artColors(img) {
    try {
      const cv = makeCanvas(24, 24);
      const cx = cv && cv.getContext ? cv.getContext('2d') : null;
      if (!cx) return null;
      cx.drawImage(img, 0, 0, 24, 24);
      return hubArtColors(cx.getImageData(0, 0, 24, 24).data);
    } catch (e) { return null; }
  }

  function offLook(mesh) {
    const m = mesh.material, ud = m.userData.hubOff;
    const changed = m.userData.hubMode !== 'idle';
    if (ud) {
      m.color.setHex(ud.color);
      m.emissive.setHex(ud.emissive);
      m.emissiveIntensity = ud.intensity;
    }
    m.emissiveMap = THREE ? hubBlankTexture(THREE) : m.emissiveMap;
    m.userData.hubMode = 'idle';
    return changed;
  }

  function freeLive(itemId) {
    const L = live.get(itemId);
    if (!L) return;
    if (L.abort) L.abort();
    if (L.tex) L.tex.dispose();
    live.delete(itemId);
  }

  // Draw `c` on the item's canvas with whatever art is ready; returns true if drawn.
  function draw(itemId, mesh, c) {
    let L = live.get(itemId);
    if (!L) {
      const h = hubCanvasHeight(mesh.userData.hubAspect);
      const canvas = makeCanvas(CANVAS_W, h);
      const ctx = canvas && canvas.getContext ? canvas.getContext('2d') : null;
      if (!ctx || !THREE) return false;
      const tex = new THREE.CanvasTexture(canvas);
      if ('colorSpace' in tex && THREE.SRGBColorSpace) tex.colorSpace = THREE.SRGBColorSpace;
      tex.name = 'hub-now-playing:' + itemId;
      L = { canvas, ctx, tex, art: 'none', abort: null, barPx: -1, ticks: 0 };
      live.set(itemId, L);
    }
    const art = c.art;
    let img = null, colors = null;
    if (art && typeof art === 'object') { img = art; colors = hubGradientColors(art.gradient); L.art = 'ok'; }
    else if (art) {
      const hit = artCache.get(hubArtKey(art));
      if (hit && hit.status === 'ok') { img = hit.img; colors = hit.colors; L.art = 'ok'; }
      else if (hit && hit.status === 'failed') L.art = 'failed';
    } else L.art = 'none';
    const { canvas, ctx } = L;
    L.barPx = drawHubScreen(ctx, canvas.width, canvas.height, c, img, colors, now());
    if (img && !img.gradient) {
      // A CORS-refused image that still "loaded" taints the canvas, and the
      // texture upload would throw: read one pixel back to find out first.
      try { ctx.getImageData(0, 0, 1, 1); } catch (e) {
        remember(hubArtKey(art), { status: 'failed', img: null, colors: null });
        L.art = 'failed';
        L.barPx = drawHubScreen(ctx, canvas.width, canvas.height, c, null, null, now());
      }
    }
    L.tex.needsUpdate = true;
    stats.draws++;
    const m = mesh.material;
    m.emissiveMap = L.tex;
    m.emissive.setHex(0xffffff);
    m.emissiveIntensity = HUB_ON_INTENSITY;
    m.color.setHex(0x050608);
    m.userData.hubMode = 'playing';
    return true;
  }

  function startLoad(itemId, c) {
    const L = live.get(itemId);
    if (!L || typeof c.art !== 'string' || L.art !== 'none' && L.art !== 'loading') return;
    if (L.abort) L.abort();
    L.art = 'loading';
    stats.loads++;
    const key = hubArtKey(c.art);
    const settle = entry => {
      remember(key, entry);
      const cur = want.get(itemId), mesh = meshes.get(itemId);
      if (!cur || cur.mode !== 'playing' || hubArtKey(cur.art) !== key || !mesh) return;
      const LL = live.get(itemId);
      if (LL) LL.abort = null;
      if (entry.status === 'ok') { if (draw(itemId, mesh, cur)) repaint(); }
      else if (LL) LL.art = 'failed';   // the no-artwork card is already up
    };
    L.abort = loadImage(c.art,
      img => settle({ status: 'ok', img, colors: artColors(img) }),
      () => settle({ status: 'failed', img: null, colors: null }));
  }

  // Bring one item's screen to its wanted content. Returns true if it changed.
  // set() has already ruled out an unchanged key; attach() re-applies a fresh material.
  function apply(itemId) {
    const mesh = meshes.get(itemId);
    if (!mesh) return false;
    const c = want.get(itemId) || { mode: 'idle' };
    const L = live.get(itemId);
    if (c.mode !== 'playing') {
      freeLive(itemId);
      return offLook(mesh);
    }
    if (L && L.abort) { L.abort(); L.abort = null; }
    if (L) L.art = 'none';
    if (!draw(itemId, mesh, c)) return offLook(mesh);
    startLoad(itemId, c);
    return true;
  }

  // The progress tick: redraw a lit screen only when its bar moved a pixel;
  // a screen out of view only every HIDDEN_TICK_EVERY-th tick. One repaint.
  function tick() {
    stats.ticks++;
    let changed = false;
    live.forEach((L, itemId) => {
      const c = want.get(itemId), mesh = meshes.get(itemId);
      if (!c || c.mode !== 'playing' || !mesh || !(c.duration > 0)) return;
      L.ticks++;
      if (!isVisible(mesh) && L.ticks % HIDDEN_TICK_EVERY !== 0) return;
      const frac = hubProgress(c, now());
      const tw = L.canvas.width - 2 * Math.round(16 * (L.canvas.width / 400));
      if (Math.round(tw * frac) === L.barPx) return;
      if (draw(itemId, mesh, c)) changed = true;
    });
    if (changed) repaint();
    return changed;
  }

  return {
    stats,
    tick,
    set(itemId, content) {
      const c = content && typeof content === 'object' ? content : { mode: 'idle' };
      if (c.mode === 'hold') return false;
      const prev = want.get(itemId);
      if (prev && hubContentKey(prev) === hubContentKey(c)) { want.set(itemId, c); return false; }
      want.set(itemId, c);
      const changed = apply(itemId);
      syncTimer();
      if (changed) repaint();
      return changed;
    },
    attach(dynamicByItemId) {
      meshes.clear();
      let changed = false;
      Object.keys(dynamicByItemId || {}).forEach(itemId => {
        const dyn = dynamicByItemId[itemId];
        if (!dyn || !dyn.group) return;
        dyn.group.traverse(m => { if (m.isMesh && m.userData && m.userData.hubScreen) meshes.set(itemId, m); });
      });
      // A display no longer built frees its texture; a rebuilt screen is a
      // fresh material, so everything wanted is re-applied.
      [...live.keys()].forEach(id => { if (!meshes.has(id)) freeLive(id); });
      meshes.forEach((mesh, itemId) => { if (apply(itemId)) changed = true; });
      syncTimer();
      return changed;
    },
    clear() {
      [...live.keys()].forEach(freeLive);
      meshes.clear();
      syncTimer();
    },
    timerRunning() { return timer !== null; },
    entries() { return [...meshes]; },
    state(itemId) {
      const L = live.get(itemId), mesh = meshes.get(itemId);
      return { mode: mesh ? mesh.material.userData.hubMode || 'idle' : null, art: L ? L.art : 'none',
        texture: L ? L.tex : null, version: L ? L.tex.version : 0, barPx: L ? L.barPx : -1 };
    }
  };
}
