/**
 * hub-screen.js -- a smart display's screen shows what its speaker is
 * playing: the track's artwork with a small "Now playing" caption, or a
 * text-only card when the artwork cannot be shown. Anything but `playing`
 * leaves the screen in its built look (dark glass, or the dim ambient glow).
 *
 * Pure ESM, THREE injected (no `import 'three'`), so the same code runs in the
 * Node tests and the live scene. The pieces:
 *
 *   hubDisplayBindings(soundMenu)   rooms.json sensors.soundMenu -> Map
 *                                   itemId -> the media_player it plays on
 *   hubScreenContent(raw, baseUrl)  a media_player state -> what the screen
 *                                   shows: { mode: 'idle' } or { mode:
 *                                   'playing', title, artist, art }
 *   hubContentKey(content)          the identity of that content, for
 *                                   "did anything the screen shows change?"
 *   drawHubScreen(ctx, w, h, c, img) paint it into a 2D canvas
 *   createHubScreens(opts)          the scene's per-item controller
 *
 * WHICH PLAYER. A smart display opens the sound menu as a speaker through
 * `sensors.soundMenu.openFrom` (`{ <itemId>: 'media_player.x' }`); that same
 * mapping says what it plays, so a display needs no new configuration. An
 * item with no openFrom entry (or one that maps to null) has no player and
 * keeps its built look. Items that are not smart displays are ignored: only
 * a mesh tagged `userData.hubScreen` (smart-display.js) is ever drawn on.
 *
 * STATE -> SCREEN. Only `playing` lights the now-playing card. `paused` is
 * treated as not playing (the built look): a paused speaker on a real Hub
 * drops back to its ambient screen after a moment, and a frozen card left on
 * a countertop reads as "still playing" from across a room. `buffering`
 * (between tracks) keeps whatever is showing -- see hubScreenContent.
 *
 * ARTWORK. `entity_picture` is either an absolute URL (a media player whose
 * art is remotely accessible -- Music Assistant passes a Spotify track's
 * i.scdn.co cover straight through) or a path on the Home Assistant host,
 * /api/media_player_proxy/<entity>?token=<the entity's own rotating token>.
 * A WebGL texture needs a CORS-clean image, so the art is loaded as an
 * <img crossOrigin="anonymous">: it succeeds only when the image's host sends
 * Access-Control-Allow-Origin for this app. Spotify's CDN sends `*`; Home
 * Assistant sends it only for the origins in `http: cors_allowed_origins`.
 * Anything that fails -- a load error, a CORS refusal, a canvas that still
 * reads back as tainted -- falls back to the text card, and that URL is not
 * retried while it stays the same. The long-lived HA token is NEVER used for
 * artwork: a bearer fetch needs exactly the same CORS allowance the plain
 * <img> does, so it would buy nothing and put the token on a new path.
 *
 * PERF. One small canvas (CANVAS_W wide, the screen's own aspect) and one
 * CanvasTexture per display, created on the first `playing` and disposed when
 * it stops. It is redrawn only when hubContentKey changes (title, artist or
 * the artwork -- the proxy URL's rotating `token` is ignored, so HA's
 * five-minute token refresh is not a change) or when the artwork finishes
 * loading; each redraw asks for ONE repaint. The screen's material always
 * carries an emissive map (a shared 1x1 white texture while idle), so
 * switching costs uniforms and a texture upload, never a shader compile.
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
/** The demo house (no Home Assistant): a generic sample with a generated-gradient cover. */
export const DEMO_NOW_PLAYING = Object.freeze({
  mode: 'playing', title: 'Sample track', artist: 'Demo artist',
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

/**
 * A media_player's raw state -> what its display shows.
 *   { mode: 'idle' }                                  the built look
 *   { mode: 'playing', title, artist, art }           the now-playing card;
 *        art: an absolute URL, or null (text card)
 *   { mode: 'hold' }                                  buffering: keep what is
 *        on screen (a track change passes through it)
 */
export function hubScreenContent(raw, baseUrl) {
  const st = raw && typeof raw === 'object' ? raw.state : null;
  if (st === 'buffering') return { mode: 'hold' };
  if (HUB_PLAYING_STATES.indexOf(st) === -1) return { mode: 'idle' };
  const a = isObj(raw.attributes) ? raw.attributes : {};
  return {
    mode: 'playing',
    title: str(a.media_title),
    artist: str(a.media_artist) || str(a.media_album_artist),
    art: hubArtUrl(baseUrl, a.entity_picture) || hubArtUrl(baseUrl, a.entity_picture_local)
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
  return JSON.stringify(['playing', c.title || '', c.artist || '', hubArtKey(c.art)]);
}

/** The one-line text card: "Now playing · <title> — <artist>". */
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

/** Up to `lines` lines of `text` within maxW, the last one ellipsised. */
function wrap(ctx, text, maxW, lines) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const out = [];
  let cur = '';
  for (let i = 0; i < words.length; i++) {
    const next = cur ? cur + ' ' + words[i] : words[i];
    if (ctx.measureText(next).width <= maxW || !cur) { cur = next; continue; }
    out.push(cur);
    cur = words[i];
    if (out.length === lines - 1) { cur = words.slice(i).join(' '); break; }
  }
  if (cur) out.push(cur);
  return out.slice(0, lines).map((l, i, arr) => (i === arr.length - 1 ? fit(ctx, l, maxW) : l));
}

function gradientFill(ctx, x, y, w, h, stops) {
  const g = ctx.createLinearGradient(x, y, x + w, y + h);
  stops.forEach((c, i) => g.addColorStop(stops.length === 1 ? 0 : i / (stops.length - 1), c));
  return g;
}

/**
 * Paint `c` (a 'playing' content) into a w x h context. `img`: a loaded
 * CORS-clean image, a { gradient: [colours] } cover, or null for the text
 * card. Deterministic: no clock, no randomness.
 */
export function drawHubScreen(ctx, w, h, c, img) {
  ctx.fillStyle = gradientFill(ctx, 0, 0, w, h, ['#1b1e26', '#0e1015']);
  ctx.fillRect(0, 0, w, h);
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  const pad = Math.round(h * 0.1);
  if (img) {
    // Cover on the left, square, inset; the caption to its right.
    const s = h - 2 * pad;
    if (img.gradient) {
      ctx.fillStyle = gradientFill(ctx, pad, pad, s, s, img.gradient);
      ctx.fillRect(pad, pad, s, s);
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.beginPath(); ctx.arc(pad + s * 0.5, pad + s * 0.5, s * 0.16, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = gradientFill(ctx, pad, pad, s, s, img.gradient);
      ctx.beginPath(); ctx.arc(pad + s * 0.5, pad + s * 0.5, s * 0.05, 0, Math.PI * 2); ctx.fill();
    } else {
      // Centre-crop to a square.
      const iw = img.naturalWidth || img.width || s, ih = img.naturalHeight || img.height || s;
      const q = Math.min(iw, ih);
      ctx.drawImage(img, (iw - q) / 2, (ih - q) / 2, q, q, pad, pad, s, s);
    }
    const x = pad * 2 + s, maxW = w - x - pad;
    ctx.fillStyle = '#9aa3b5';
    ctx.font = '600 ' + Math.round(h * 0.07) + 'px sans-serif';
    ctx.fillText(fit(ctx, 'NOW PLAYING', maxW), x, pad + h * 0.08);
    ctx.fillStyle = '#f2f4f8';
    const tf = Math.round(h * 0.11);
    ctx.font = '700 ' + tf + 'px sans-serif';
    const lines = wrap(ctx, c.title || 'Untitled', maxW, 3);
    let y = pad + h * 0.08 + tf * 1.5;
    lines.forEach(l => { ctx.fillText(l, x, y); y += tf * 1.18; });
    if (c.artist) {
      ctx.fillStyle = '#c3c9d6';
      ctx.font = '400 ' + Math.round(h * 0.085) + 'px sans-serif';
      ctx.fillText(fit(ctx, c.artist, maxW), x, y + h * 0.03);
    }
    return;
  }
  // Text card: centred caption with a music note.
  const maxW = w - 2 * pad;
  ctx.textAlign = 'center';
  ctx.fillStyle = '#9aa3b5';
  ctx.font = '400 ' + Math.round(h * 0.2) + 'px sans-serif';
  ctx.fillText('♫', w / 2, h * 0.32);
  ctx.font = '600 ' + Math.round(h * 0.07) + 'px sans-serif';
  ctx.fillText('NOW PLAYING', w / 2, h * 0.45);
  ctx.fillStyle = '#f2f4f8';
  const tf = Math.round(h * 0.1);
  ctx.font = '700 ' + tf + 'px sans-serif';
  const lines = wrap(ctx, c.title || 'Untitled', maxW, 2);
  let y = h * 0.45 + tf * 1.45;
  lines.forEach(l => { ctx.fillText(l, w / 2, y); y += tf * 1.15; });
  if (c.artist) {
    ctx.fillStyle = '#c3c9d6';
    ctx.font = '400 ' + Math.round(h * 0.08) + 'px sans-serif';
    ctx.fillText(fit(ctx, '— ' + c.artist, maxW), w / 2, y + h * 0.02);
  }
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
 *
 *   set(itemId, content) -> changed?    remembered; applied when it attaches
 *   attach(dynamicByItemId)             index the built screens and apply
 *   clear()                             forget the meshes, free the textures
 *   entries() / state(itemId)           for tests and the debug seam
 *   stats                               { draws, loads }
 */
export function createHubScreens(opts) {
  const o = opts || {};
  const THREE = o.THREE;
  const repaint = o.repaint || (() => {});
  const makeCanvas = o.makeCanvas || defaultMakeCanvas;
  const loadImage = o.loadImage || defaultLoadImage;
  const meshes = new Map();   // itemId -> screen mesh
  const want = new Map();     // itemId -> content
  const live = new Map();     // itemId -> { canvas, tex, art: 'none'|'loading'|'ok'|'failed', abort }
  const artCache = new Map(); // artKey -> { status: 'ok'|'failed', img }
  const stats = { draws: 0, loads: 0 };

  function remember(key, entry) {
    artCache.delete(key);
    artCache.set(key, entry);
    while (artCache.size > ART_CACHE_MAX) artCache.delete(artCache.keys().next().value);
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
      L = { canvas, ctx, tex, art: 'none', abort: null };
      live.set(itemId, L);
    }
    const art = c.art;
    let img = null;
    if (art && typeof art === 'object') { img = art; L.art = 'ok'; }
    else if (art) {
      const hit = artCache.get(hubArtKey(art));
      if (hit && hit.status === 'ok') { img = hit.img; L.art = 'ok'; }
      else if (hit && hit.status === 'failed') L.art = 'failed';
    } else L.art = 'none';
    const { canvas, ctx } = L;
    drawHubScreen(ctx, canvas.width, canvas.height, c, img);
    if (img && !img.gradient) {
      // A CORS-refused image that still "loaded" taints the canvas, and the
      // texture upload would throw: read one pixel back to find out first.
      try { ctx.getImageData(0, 0, 1, 1); } catch (e) {
        remember(hubArtKey(art), { status: 'failed', img: null });
        L.art = 'failed';
        drawHubScreen(ctx, canvas.width, canvas.height, c, null);
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
      else if (LL) LL.art = 'failed';   // the text card is already up
    };
    L.abort = loadImage(c.art, img => settle({ status: 'ok', img }), () => settle({ status: 'failed', img: null }));
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

  return {
    stats,
    set(itemId, content) {
      const c = content && typeof content === 'object' ? content : { mode: 'idle' };
      if (c.mode === 'hold') return false;
      const prev = want.get(itemId);
      if (prev && hubContentKey(prev) === hubContentKey(c)) { want.set(itemId, c); return false; }
      want.set(itemId, c);
      const changed = apply(itemId);
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
      return changed;
    },
    clear() {
      [...live.keys()].forEach(freeLive);
      meshes.clear();
    },
    entries() { return [...meshes]; },
    state(itemId) {
      const L = live.get(itemId), mesh = meshes.get(itemId);
      return { mode: mesh ? mesh.material.userData.hubMode || 'idle' : null, art: L ? L.art : 'none',
        texture: L ? L.tex : null, version: L ? L.tex.version : 0 };
    }
  };
}
