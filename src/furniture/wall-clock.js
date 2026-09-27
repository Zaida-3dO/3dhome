/**
 * wall-clock.js - a working wall clock, one of three `kind`s:
 *   - `framed`: a conventional round face + rim + hands.
 *   - `diy-numerals`: numerals/dots stuck straight on the wall around a
 *     plain hands unit, no visible face disc (a living-room clock photo).
 *   - `diy-words`: a frameless stick-on clock -- big bold 12/9/6, solid dots
 *     at 7/8/10/11, the WORDS "One".."Five" to the right of the 1-5
 *     positions, a black centre disc, tapered black hour/minute hands and a
 *     thin red second hand with a tail (item 059873ed, the owner's actual
 *     kitchen clock photo).
 *
 * THE BUILDER CONTRACT (every src/furniture/<type>.js follows it):
 *   - Pure ESM, THREE injected; no `import 'three'`.
 *   - Exports TYPE, DEFAULTS (frozen, cm, includes width/depth/height) and
 *     build(THREE, params, { detail: 'full' | 'low' }) -> Group.
 *   - Local frame in METRES: y = 0 is the item's bottom, x is centred along
 *     the width, the BACK face is at z = 0 and the front faces +z.
 *   - Every material comes from makeFinish() (./finishes.js) EXCEPT the
 *     `diy-words` numerals/words canvas-texture panel, which is the one
 *     textured, kept-out-of-merge part (same exception wall-sign.js makes
 *     for its own text panel).
 * See docs/house-profile.md, "Furniture".
 *
 * REFERENCE. `diy-numerals` models a living-room clock photo (numerals/dots
 * stuck straight on the wall, no face disc). `diy-words` models the owner's
 * actual kitchen clock (private reference photo, never committed) -- a
 * FRAMELESS clock of separate black acrylic pieces mounted a few mm off the
 * wall (so each casts a small shadow), no dial, no rim: big bold numerals at
 * 12/9/6, solid dots at 7/8/10/11, the words "One" through "Five" in a thin
 * script to the right of the 1-5 ring positions ("Three" is the largest), a
 * black centre disc, tapered black hour/minute hands and a thin red second
 * hand with a small counterweight tail. Everything is black except the red
 * second hand.
 *
 * PERF (item 059873ed): real 3D text geometry is too heavy for 17 short
 * strings (perf-audit-furniture.md's per-type triangle caps). The numerals
 * and words are drawn on ONE transparent CanvasTexture plane a few mm off
 * the wall (alpha-tested, `keep`), matching wall-sign.js's own text-panel
 * pattern; the dots and centre disc are low-poly meshes; the hands are
 * meshes. The panel's own width/height are sized to include the words that
 * extend right of the ring, and DEFAULTS.width/height reflect that widened
 * envelope for `diy-words` specifically (see buildDiyWordsClock).
 *
 * HISTORY. Split out of dining.js (item 89769f2b, 2026-09-26) into its own
 * module and its own spec page, ClockSpec.html -- it shares no geometry with
 * the dining table/chairs, just a spec page by coincidence of both being
 * kitchen photos. DiningSpec.html keeps the table and chairs only.
 *
 * REGISTRY NOTE. `clock` was already pre-seeded in registry.js pointing at
 * small-items.js (a module that does not exist on this branch). This module
 * does not repoint or touch that entry -- small-items.js is someone else's
 * territory. It is the `wall-clock` type, registered separately.
 *
 * LIVE HOUSE ANIMATION. A clock's hands (hourHand, minuteHand, secondHand,
 * secondHandTail) carry userData.dynamic = true, which excludes them from
 * every furniture merge bucket (src/furniture/merge.js flattenGroup) and
 * keeps them as their own live meshes, re-parented into a per-item wrapper
 * group (src/furniture.js buildPlaced, exposed as result.dynamicByItemId).
 * The scene starts startLiveClock() on that wrapper when the item is
 * attached and stops it on dispose (src/home3d-scene.js attachFurniture /
 * stopLiveClocks). This is what lets setClockTime() actually animate a
 * clock placed in a real house, not just on ClockSpec -- item 059873ed's
 * round 3 review; see src/furniture/merge.js's own header for the general
 * mechanism (also used by the desk LED strip, item 816d71ee).
 */
import { makeFinish, isKeptFinish } from './finishes.js';

const TAU = Math.PI * 2;

export const TYPE = 'wall-clock';

export const DEFAULTS = Object.freeze({
  width: 30,
  depth: 4,
  height: 30,
  kind: 'diy-numerals',    // 'framed' | 'diy-numerals' | 'diy-words'
  diameter: 30,
  faceColor: '#f5f2ea',
  rimColor: '#1a1a1a',
  numeralColor: '#1a1a1a',
  handColor: '#1a1a1a',
  secondHandColor: '#c62828', // red, diy-words only -- other kinds' second hand uses handColor
  time: '10:10'            // "HH:MM", the INITIAL hand pose only -- see setClockTime()
});

/**
 * DEFAULTS for `kind: 'diy-words'` specifically: the same diameter/depth,
 * but `width` widened to include the words extending right of the ring (the
 * builder contract's bbox check needs the envelope to cover them -- see
 * buildDiyWordsClock's own WORD_REACH constant). Not the module's own
 * DEFAULTS.kind default (that stays 'diy-numerals', unaffected by this
 * addition) -- a caller opts into this style with `kind: 'diy-words'` and
 * should merge params onto THIS object, e.g.
 * `Object.assign({}, DIY_WORDS_DEFAULTS, { seatHeight: ... })`, the same
 * pattern wall-sconce.js's UP_DOWN_DEFAULTS uses for its own second kind.
 */
export const DIY_WORDS_DEFAULTS = Object.freeze(Object.assign({}, DEFAULTS, {
  kind: 'diy-words',
  // width/height are the whole envelope INCLUDING the words that extend
  // right of the ring, not just the ring's own diameter (30cm) -- computed
  // from WORD_LEFT_R/WORD_RIGHT_R/Y_MARGIN_R below: width =
  // radius*(WORD_LEFT_R+WORD_RIGHT_R), height = radius*2*Y_MARGIN_R, at
  // diameter=30 (radius=15cm). Verified exactly by test-wall-clock.mjs.
  // Recomputed twice (item 059873ed): first when WORD_RIGHT_R widened
  // 1.85->2.1 (43.5->47.25), then again when WORD_LEFT_R/Y_MARGIN_R both
  // widened again in round 2 to clear the "12"/"9"/"6" numeral clipping
  // (1.05->1.22, 1.18->1.3): 15*(1.22+2.1)=49.8, 15*2*1.3=39.
  width: 49.8,
  height: 39,
  faceColor: '#f5f2ea', // unused by diy-words (no face disc) -- kept for shape parity
  numeralColor: '#1a1a1a',
  handColor: '#1a1a1a',
  secondHandColor: '#c62828'
}));

/**
 * The DEFAULTS a house item of this `kind` starts from, BEFORE its own
 * params are applied (src/furniture.js calls this when present, item
 * 7c056b3e). Without it the house path filled width/height from the generic
 * DEFAULTS (30x30), so an item giving only `{ kind: 'diy-words' }` declared a
 * 30x30 envelope while build() drew the 49.8x39 words clock -- and lifted it
 * by the wrong half-height, sinking its bottom 4.5 cm below y = 0.
 */
export function defaultsFor(params) {
  return (params && params.kind) === 'diy-words' ? DIY_WORDS_DEFAULTS : DEFAULTS;
}

/**
 * "HH:MM" -> hour/minute/second hand angles, radians clockwise from 12
 * o'clock. Seconds are not encoded in "HH:MM" so they default to 0 -- this is
 * only ever used to lay out the STARTING pose at build time; a live scene
 * calls setClockTime() with a real Date immediately after and every tick
 * after that.
 */
function handAngles(time) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(time || '').trim());
  const h = m ? (parseInt(m[1], 10) % 12) : 10;
  const min = m ? (parseInt(m[2], 10) % 60) : 10;
  const secondAngle = 0;
  const minuteAngle = (min / 60) * TAU;
  const hourAngle = ((h + min / 60) / 12) * TAU;
  return { hourAngle, minuteAngle, secondAngle };
}

/**
 * Hour/minute/second hand angles for a real Date, same convention as
 * handAngles(): radians clockwise from 12 o'clock. Pure -- reads only the
 * Date's local hour/minute/second/ms, never the DOM or a clock.
 */
export function angleForTime(date) {
  const h = date.getHours() % 12;
  const min = date.getMinutes();
  const sec = date.getSeconds() + date.getMilliseconds() / 1000;
  const secondAngle = (sec / 60) * TAU;
  const minuteAngle = ((min + sec / 60) / 60) * TAU;
  const hourAngle = ((h + min / 60) / 12) * TAU;
  return { hourAngle, minuteAngle, secondAngle };
}

/**
 * Rotate a built `wall-clock` group's hands to show `date` (a JS Date;
 * defaults to now). Pure with respect to everything except the three named
 * hand meshes' `.rotation.z` -- it does not touch geometry, materials or any
 * other part of the group, so it is cheap enough to call every animation
 * frame, and safe to call on a group built at any `time` default.
 *
 * Both the live house scene and the spec page call this once a SECOND, via
 * startLiveClock() below -- this helper itself has no opinion on cadence,
 * it is just the cheap, geometry-free pose write both callers share.
 *
 * @param {Object} group  a THREE.Group returned by wall-clock's build()
 * @param {Date} [date]   defaults to `new Date()`
 */
export function setClockTime(group, date) {
  const d = date || new Date();
  const { hourAngle, minuteAngle, secondAngle } = angleForTime(d);
  const hour = group.getObjectByName('hourHand');
  const minute = group.getObjectByName('minuteHand');
  const second = group.getObjectByName('secondHand');
  // diy-words' second hand has a separate TAIL mesh (the counterweight past
  // the pivot) that must turn WITH the second hand -- addHands() builds it
  // at the same angle plus 180 degrees, so it is kept in that same fixed
  // relationship here rather than looked up and set independently.
  const secondTail = group.getObjectByName('secondHandTail');
  if (hour) hour.rotation.z = -hourAngle;
  if (minute) minute.rotation.z = -minuteAngle;
  if (second) second.rotation.z = -secondAngle;
  if (secondTail) secondTail.rotation.z = -secondAngle - Math.PI;
}

/**
 * Keep a built `wall-clock` group ALWAYS showing the viewer's current local
 * time (item 059873ed): calls setClockTime() once a second via setInterval,
 * and RESYNCS immediately whenever the page becomes visible again (a
 * background tab throttles or entirely suspends timers in most browsers, so
 * without this the clock would sit frozen at whatever time the tab was
 * backgrounded at, then jump -- this makes it correct the instant the tab
 * is looked at again, not just eventually).
 *
 * This does NOT force continuous rendering on its own: it only touches hand
 * rotations (the same cheap, geometry-free write setClockTime always makes)
 * and calls the caller-supplied `onTick` once per update so the CALLER
 * decides whether/how to request a repaint -- a page that renders every
 * frame regardless (like ClockSpec's orbit-camera loop) can ignore it, and
 * a render-on-demand scene (the live house) should have `onTick` call its
 * own bounded "wake for one frame" primitive, not an unconditional
 * repaint-forever.
 *
 * @param {Object} group  a THREE.Group returned by wall-clock's build()
 * @param {Object} [opts]
 * @param {function()} [opts.onTick]  called after every setClockTime() call
 *   (both the once-a-second timer and the visibility resync) -- e.g.
 *   `requestRender` or `wake(50)` in the live scene, or nothing at all on a
 *   page that already renders continuously.
 * @param {Object} [opts.doc]  injection point for `document` (tests run
 *   under plain Node, where no global `document` exists) -- defaults to the
 *   global `document` when available, and skips the visibility listener
 *   entirely when neither is present (the interval still runs).
 * @param {function(): Date} [opts.now]  injection point for "the current
 *   time" (tests can supply a fake clock instead of the real Date/now).
 * @returns {function()} `stop()` -- clears the interval and removes the
 *   visibility listener. ALWAYS call this when the clock is removed from
 *   the scene, or the interval keeps a reference to `group` (and everything
 *   it holds) alive forever.
 */
export function startLiveClock(group, opts) {
  const o = opts || {};
  const doc = 'doc' in o ? o.doc : (typeof document !== 'undefined' ? document : null);
  const now = typeof o.now === 'function' ? o.now : () => new Date();
  const tick = () => {
    setClockTime(group, now());
    if (typeof o.onTick === 'function') o.onTick();
  };
  tick(); // show the correct time immediately, don't wait a full second
  const intervalId = setInterval(tick, 1000);
  let onVisible = null;
  if (doc && typeof doc.addEventListener === 'function') {
    onVisible = () => {
      if (!doc.hidden) tick(); // resync the instant the tab is looked at again
    };
    doc.addEventListener('visibilitychange', onVisible);
  }
  return function stop() {
    clearInterval(intervalId);
    if (onVisible && doc && typeof doc.removeEventListener === 'function') {
      doc.removeEventListener('visibilitychange', onVisible);
    }
  };
}

/**
 * @param {number} totalDepth  the item's own declared depth (metres) -- the
 *   hub, the deepest part, is placed with its FRONT face exactly at
 *   totalDepth, so the whole assembly's z-extent matches params.depth exactly
 *   (the builder contract's bbox check) regardless of kind.
 * @param {number} backZ  where the hands' own back face should land (metres,
 *   in the caller's frame) -- callers pass whatever z their own geometry
 *   already treats as "flush with the wall/face".
 */
/**
 * @param {?string} [secondHandColor]  colour for the second hand only,
 *   defaults to `handColor` -- used by `diy-words`, whose second hand is
 *   red while the hour/minute hands and hub stay black. `framed` and
 *   `diy-numerals` never pass this, so their second hand is unchanged
 *   (the same colour as the other hands, as it always has been).
 * @param {boolean} [tapered]  true for `diy-words`'s tapered stick hands
 *   (wide at the pivot, narrowing toward the tip) and a red second hand
 *   with a short tail extending past the pivot -- false (the default)
 *   keeps the original plain rectangular hands `framed`/`diy-numerals` use.
 */
function addHands(THREE, group, radius, handColor, time, detail, backZ, totalDepth, secondHandColor, tapered) { // eslint-disable-line no-unused-vars
  const { hourAngle, minuteAngle, secondAngle } = handAngles(time);
  const handThickness = Math.max(0.003, Math.min(0.008, (totalDepth - backZ) * 0.3));
  const z = backZ + handThickness / 2;
  const mat = makeFinish(THREE, 'matte', handColor);
  const secondMat = makeFinish(THREE, 'matte', secondHandColor || handColor);

  const hourLen = radius * 0.5, minuteLen = radius * 0.72, secondLen = radius * 0.78;
  const handW = radius * 0.06, secondW = radius * 0.02;

  function handGeometry(length, widthAtBase, widthAtTip, thickness) {
    if (!tapered || widthAtBase === widthAtTip) {
      const geo = new THREE.BoxGeometry(widthAtBase, length, thickness);
      geo.translate(0, length / 2, 0);
      return geo;
    }
    // A tapered stick: a 4-sided prism (a triangular strip in cross-section
    // along y, constant in z) narrowing from widthAtBase at the pivot
    // (y=0) to widthAtTip at the tip (y=length) -- built directly as a
    // BufferGeometry rather than reshaping a BoxGeometry, since three's
    // primitives have no "taper" parameter.
    const hb = widthAtBase / 2, ht = widthAtTip / 2, hz = thickness / 2;
    const positions = [
      -hb, 0, -hz, hb, 0, -hz, ht, length, -hz, -ht, length, -hz, // back face
      -hb, 0, hz, hb, 0, hz, ht, length, hz, -ht, length, hz       // front face
    ];
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    const idx = [
      0, 1, 2, 0, 2, 3,       // back
      4, 6, 5, 4, 7, 6,       // front (opposite winding)
      0, 4, 5, 0, 5, 1,       // bottom (pivot end)
      1, 5, 6, 1, 6, 2,       // right side
      2, 6, 7, 2, 7, 3,       // top (tip end)
      3, 7, 4, 3, 4, 0        // left side
    ];
    geo.setIndex(idx);
    geo.computeVertexNormals();
    return geo;
  }

  function hand(name, length, widthAtBase, widthAtTip, angle, matInstance, thickness) {
    const geo = handGeometry(length, widthAtBase, widthAtTip, thickness != null ? thickness : handThickness);
    const mesh = new THREE.Mesh(geo, matInstance);
    mesh.name = name;
    mesh.position.set(0, 0, z);
    // Clockwise from 12 o'clock (+y) -> rotate about z by -angle.
    mesh.rotation.z = -angle;
    // Hands rotate continuously in the live scene (once a second, via
    // setClockTime/startLiveClock below): userData.dynamic = true is the
    // merge's per-part opt-out (src/furniture/merge.js flattenGroup) that
    // keeps a part OUT of every bucket entirely, as its own mesh, parented
    // so it follows the item's placement. `keep` stays set too (a dynamic
    // part is also never re-coloured/merged if something upstream reads
    // keep on its own), but `dynamic` is what actually excludes it.
    mesh.userData.keep = true;
    mesh.userData.dynamic = true;
    return mesh;
  }
  if (tapered) {
    // Tapered sticks, wide at the pivot narrowing to a point at the tip.
    group.add(hand('hourHand', hourLen, handW * 1.4, handW * 0.25, hourAngle, mat));
    group.add(hand('minuteHand', minuteLen, handW * 1.1, handW * 0.2, minuteAngle, mat.clone()));
    // The second hand is a thin uniform rod (not tapered) with a short TAIL
    // extending past the pivot in the opposite direction -- built as two
    // hands sharing one angle, the tail half the main length and rotated
    // 180 degrees so it points the other way.
    const secondThickness = Math.max(0.002, handThickness * 0.6);
    group.add(hand('secondHand', secondLen, secondW, secondW, secondAngle, secondMat, secondThickness));
    const tailLen = secondLen * 0.22;
    const tail = hand('secondHandTail', tailLen, secondW * 1.4, secondW * 1.4, secondAngle + Math.PI, secondMat.clone(), secondThickness);
    group.add(tail);
  } else {
    group.add(hand('hourHand', hourLen, handW, handW, hourAngle, mat));
    group.add(hand('minuteHand', minuteLen, handW * 0.7, handW * 0.7, minuteAngle, mat.clone()));
    group.add(hand('secondHand', secondLen, secondW, secondW, secondAngle, secondMat));
  }

  // The hub is the deepest part: its FRONT face lands exactly at totalDepth
  // so the group's overall z-extent equals params.depth precisely.
  const hubThickness = Math.max(0.004, totalDepth - backZ);
  const hubRadius = tapered ? radius * 0.09 : radius * 0.05;
  const hubGeo = new THREE.CylinderGeometry(hubRadius, hubRadius, hubThickness, detail ? 8 : 16);
  hubGeo.rotateX(Math.PI / 2);
  hubGeo.translate(0, 0, totalDepth - hubThickness / 2);
  const hub = new THREE.Mesh(hubGeo, mat.clone());
  hub.name = 'hub';
  hub.userData.keep = true;
  group.add(hub);
}

function buildFramedClock(THREE, p, detail, totalDepth) {
  const group = new THREE.Group();
  group.name = 'furniture:wall-clock:framed';
  const r = (p.diameter / 100) / 2;
  const segments = detail ? 20 : 40;
  // The rim + face take up most of the declared depth; hands and the hub
  // (the deepest part) fit in what is left, driven by totalDepth below.
  const faceThickness = Math.max(0.006, totalDepth * 0.5);

  const rimGeo = new THREE.CylinderGeometry(r, r, faceThickness, segments);
  rimGeo.rotateX(Math.PI / 2);
  rimGeo.translate(0, 0, faceThickness / 2); // back face at local z = 0
  const rim = new THREE.Mesh(rimGeo, makeFinish(THREE, 'matte', p.rimColor));
  rim.name = 'rim';
  group.add(rim);

  const faceR = r * 0.92;
  const faceThin = 0.005;
  const faceGeo = new THREE.CylinderGeometry(faceR, faceR, faceThin, segments);
  faceGeo.rotateX(Math.PI / 2);
  faceGeo.translate(0, 0, faceThickness + faceThin / 2);
  const face = new THREE.Mesh(faceGeo, makeFinish(THREE, 'matte', p.faceColor));
  face.name = 'face';
  group.add(face);

  // Twelve tick marks around the face.
  const tickCount = 12;
  for (let i = 0; i < tickCount; i++) {
    const a = (i / tickCount) * TAU;
    const isQuarter = i % 3 === 0;
    const tickLen = faceR * (isQuarter ? 0.14 : 0.08);
    const tickGeo = new THREE.BoxGeometry(faceR * 0.025, tickLen, 0.004);
    tickGeo.translate(0, faceR * 0.88 - tickLen / 2, 0);
    const tick = new THREE.Mesh(tickGeo, makeFinish(THREE, 'matte', p.numeralColor));
    tick.name = 'tick' + i;
    tick.position.z = faceThickness + faceThin;
    tick.rotation.z = -a;
    group.add(tick);
  }

  // Hands sit just in front of the face, which is itself in front of the
  // rim -- the rim's own back face is already at z = 0 (see rimGeo above).
  addHands(THREE, group, faceR, p.handColor, p.time, detail, faceThickness + faceThin, totalDepth);
  return group;
}

function buildDiyNumeralsClock(THREE, p, detail, totalDepth) {
  const group = new THREE.Group();
  group.name = 'furniture:wall-clock:diy-numerals';
  const r = (p.diameter / 100) / 2;
  const markThickness = Math.max(0.003, totalDepth * 0.3); // stuck straight on the wall

  // Numerals/dots stuck straight on the wall: at 12/3/6/9 a flat numeral
  // plaque (a small box standing in for the printed digit), and a plain dot
  // at the other eight hours -- matching the reference photo, where only a
  // few positions carry a printed number ("12", "9", "6" are the ones the
  // photo shows) and the rest are unmarked dots.
  //
  // The ring radius is shrunk by the numeral's own half-extent so the
  // FARTHEST point of the farthest numeral lands exactly on the declared
  // diameter, never past it -- otherwise a fixed 0.88*r ring radius plus the
  // numeral's box half-width overshoots the bbox the contract test measures.
  // The plaque is kept SQUARE (equal half-width/half-height) specifically so
  // one inset works whichever axis a numeral sits on (12/6 are on the y axis,
  // 3/9 on the x axis) -- an oblong plaque would need a per-position inset.
  const numeralHalf = r * 0.09;
  const numeralHalfW = numeralHalf, numeralHalfH = numeralHalf;
  const ringR = r - numeralHalf;
  const numeralPositions = [0, 3, 6, 9];
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * TAU;
    const x = ringR * Math.sin(a);
    const y = ringR * Math.cos(a);
    let mark;
    if (numeralPositions.includes(i)) {
      const geo = new THREE.BoxGeometry(numeralHalfW * 2, numeralHalfH * 2, markThickness);
      geo.translate(0, 0, markThickness / 2); // back face at local z = 0
      mark = new THREE.Mesh(geo, makeFinish(THREE, 'matte', p.numeralColor));
      mark.name = 'numeral' + i;
    } else {
      const geo = new THREE.CylinderGeometry(r * 0.035, r * 0.035, markThickness, detail ? 6 : 10);
      geo.rotateX(Math.PI / 2);
      geo.translate(0, 0, markThickness / 2); // back face at local z = 0
      mark = new THREE.Mesh(geo, makeFinish(THREE, 'matte', p.numeralColor));
      mark.name = 'dot' + i;
    }
    mark.position.set(x, y, 0);
    group.add(mark);
  }

  // Hands + hub mount flush on the wall too -- their own back face at z = 0.
  addHands(THREE, group, r, p.handColor, p.time, detail, 0, totalDepth);
  return group;
}

/** A canvas factory from opts, or the global `document`, or null if neither
 * exists -- same fallback chain as wall-sign.js's resolveCreateCanvas, so
 * both the Node builder-contract tests (no DOM) and a real browser/spec
 * page (global `document`) work without this module knowing which. */
function resolveCreateCanvas(opts) {
  if (opts && typeof opts.createCanvas === 'function') return opts.createCanvas;
  if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
    return (w, h) => {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      return c;
    };
  }
  return null;
}

// The panel's own local frame, in units of the clock's RADIUS (diameter/2):
// x=0 is the clock centre, y=0 is the clock centre, both numerals and words
// are laid out in this space and only converted to canvas pixels at draw
// time. Widened right (WORD_RIGHT_R) to fit "One".."Five" past the ring, and
// a little tall (Y_MARGIN_R) for "12"/"6" to clear the panel edge.
//
// WORD_RIGHT_R was widened from 1.85 to 2.1 (item 059873ed, visual-compare
// round against wall-clock-reference.png / wallclock.jpg): measured with
// ctx.measureText() in a real browser, "Three" at its own scale=1.0 and the
// ORIGINAL baseWordSize factor (0.42, see buildWordsTexture) overflowed the
// 1.85-wide canvas by ~178px out of 1024 -- a real clip, not a framing
// artifact (confirmed the panel geometry itself, and every other mesh's own
// world-space bbox, were already correct and symmetric; only the CANVAS
// TEXTURE's own drawn content ran past its own right edge). Fixed by both
// widening the envelope a little AND shrinking baseWordSize's factor from
// 0.42 to 0.3, rather than only one or the other -- doing it by width alone
// would have needed 2.36 (a much bigger footprint for a WORD_RIGHT_R that
// otherwise change nothing about layout); doing it by size alone would have
// shrunk every word to ~58% of its previous size, smaller than the
// reference photos show. The chosen pair leaves "Three" ~30px of margin at
// a 1024px texture width.
// WORD_LEFT_R and Y_MARGIN_R were both widened again (item 059873ed, round
// 2 of the visual-compare after the coordinator viewed clock-preview.png):
// the "12"/"9"/"6" numerals were genuinely clipped at the texture's own
// edges -- "12"'s top, "9"'s left, "6"'s bottom -- measured with
// ctx.measureText()'s actualBoundingBoxAscent/Descent/Left/Right PLUS the
// numeral shadow's own blur/offset (the shadow extends real ink beyond the
// glyph's own bounds, so a glyph-only measurement would still let the
// shadow clip). Searched for the smallest WORD_LEFT_R/Y_MARGIN_R pair that
// clears all three numerals at the round-2 numeral size/weight (see
// buildWordsTexture's numeralSize/font below), then rounded UP for a real
// safety margin (about 30-100px at a 1024px texture) rather than shipping
// the exact zero-margin values the search found -- font metrics can vary
// slightly across environments, and this is exactly the bug class (a
// measured-tight fit with no slack) that clipped "Three" in round 1.
const WORD_LEFT_R = 1.22;   // left edge of the panel, past the ring's own left extent AND the "9" numeral's ink+shadow
const WORD_RIGHT_R = 2.1;   // right edge -- covers the words' own reach (see DIY_WORDS_DEFAULTS.width)
const Y_MARGIN_R = 1.3;     // top/bottom edge, past the "12"/"6" numerals' ink+shadow

// Round 3 (item 059873ed, round-2 review): neither "Segoe UI" (no true 500
// face -- it has only Regular/Semibold/Bold, so a canvas asking for 500
// silently resolves to Semibold/600, confirmed by the reviewer via a pixel-
// hash comparison) nor "Arial Rounded MT Bold" (Chrome does not resolve it
// as a family name at all, even when the file is installed) actually gave a
// medium-weight rounded numeral on Windows. Nunito genuinely ships a 500
// weight as its own font file (not a synthesized weight), and is a rounded
// geometric sans close to the reference photos' soft-terminal look.
// Loaded from @fontsource via jsdelivr -- an allowed CDN already used
// elsewhere in this repo for third-party libraries (see docs/deployment.md)
// -- rather than bundled, per the item's own "web-safe or bundled open-
// licence font... unless [fetched] from an allowed CDN" rule.
const NUMERAL_FONT_FAMILY = 'Nunito';
const NUMERAL_FONT_CSS_URL = 'https://cdn.jsdelivr.net/npm/@fontsource/nunito@5.0.8/500.css';
// One shared promise for the whole page, created the first time any clock
// asks for the font and reused by every caller after that -- see
// numeralFontReady()'s own doc comment for why a promise, not a boolean.
let numeralFontPromise = null;

/**
 * Round 3 review (item 059873ed, code_review b3a0eece): the ORIGINAL
 * version of this function called `document.fonts.load()` in the SAME
 * synchronous tick it appended the @fontsource `<link>`. Per spec,
 * `document.fonts.load()` only loads a face that some already-parsed CSS
 * has declared via `@font-face` -- until the browser has fetched and
 * parsed the stylesheet the `<link>` points at, no `@font-face` for
 * "Nunito" exists yet, so `load()` correctly resolved with an EMPTY array
 * immediately, and nothing ever retried. The reviewer reproduced this three
 * ways, including a live house with two clocks where the first-built clock
 * (a cold cache, the stylesheet still in flight when it called `load()`)
 * was left permanently on the Segoe UI Semibold fallback while a second
 * clock built moments later happened to get Nunito -- entirely dependent
 * on timing, not something a caller could rely on.
 *
 * FIX: wait for the `<link>` element's own `load` event first -- which
 * fires only once the browser has actually fetched AND PARSED the
 * stylesheet, so its `@font-face` rules are registered by the time this
 * resolves -- and only THEN call `document.fonts.load()`. This is done
 * ONCE per page behind a single shared promise (not per clock instance),
 * so every clock's redraw awaits the SAME settled outcome rather than each
 * clock racing its own `document.fonts.load()` call against the one
 * `<link>` fetch. A `<link>` firing `error` (CDN unreachable/blocked), or
 * `document.fonts.load()` itself rejecting or resolving with zero faces
 * (a malformed stylesheet, or a browser without the font installed even
 * after parsing), resolves the shared promise to `false` rather than
 * rejecting it -- every caller awaits gracefully and keeps the fallback
 * stack, never throws.
 *
 * Uses `<link rel="stylesheet">` (not the CSS Font Loading API's `FontFace`
 * constructor with a hand-written @font-face) because @fontsource's own
 * CSS already declares the unicode-range-split @font-face rules its files
 * need -- re-deriving that here would be a second copy to keep in sync with
 * an upstream package this module does not otherwise depend on.
 *
 * @param {Object} [doc]  injection point for `document` (round-3 review:
 *   the FIX itself is timing-sensitive -- a real browser's CDN fetch is
 *   often fast enough on a warm cache to hide the very race this exists to
 *   close -- so scripts/test-wall-clock.mjs drives this with a fake `doc`
 *   whose `<link>`'s `load` event fires on a controlled delay, exactly
 *   reproducing the reviewer's "stylesheet not parsed yet" scenario
 *   deterministically instead of hoping a real network is slow enough).
 *   Defaults to the global `document`.
 * @returns {Promise<boolean>|null} resolves true once Nunito 500 is
 *   genuinely usable, false if loading failed for any reason; null if no
 *   usable document is available at all (plain Node with no doc injected).
 */
function numeralFontReady(doc) {
  const d = doc || (typeof document !== 'undefined' ? document : null);
  if (!d || typeof d.fonts === 'undefined') return null; // Node, no doc injected: nothing to load
  if (numeralFontPromise) return numeralFontPromise;

  const linkLoaded = new Promise((resolve) => {
    const existing = d.querySelector('link[data-wall-clock-numeral-font]');
    if (existing) {
      // Another instance already appended it. If the browser already
      // finished loading it (readyState isn't standard on <link>, so this
      // is inferred from sheet being populated), do not wait for an
      // 'load' event that already fired and will never fire again.
      if (existing.sheet) { resolve(true); return; }
      existing.addEventListener('load', () => resolve(true), { once: true });
      existing.addEventListener('error', () => resolve(false), { once: true });
      return;
    }
    const link = d.createElement('link');
    link.rel = 'stylesheet';
    link.href = NUMERAL_FONT_CSS_URL;
    link.setAttribute('data-wall-clock-numeral-font', '1');
    link.addEventListener('load', () => resolve(true), { once: true });
    link.addEventListener('error', () => resolve(false), { once: true });
    d.head.appendChild(link);
  });

  numeralFontPromise = linkLoaded.then((stylesheetOk) => {
    if (!stylesheetOk) return false;
    // Only NOW does document.fonts.load() have a real @font-face to find --
    // the stylesheet's CSS has been parsed and its rules registered.
    return d.fonts.load('500 48px "' + NUMERAL_FONT_FAMILY + '"').then(
      (faces) => !!(faces && faces.length),
      () => false
    );
  });
  return numeralFontPromise;
}

/**
 * TEST-ONLY (item 1c7f8a6d). numeralFontReady caches ONE promise per page, so
 * a test file that has already loaded the font once can never drive the
 * failure path. These clear that cache and read the shared promise, so
 * scripts/test-wall-clock.mjs runs the failing-link scenario for real.
 * Not used by any caller in the app.
 */
export function _resetNumeralFontForTest() { numeralFontPromise = null; }
export function _numeralFontReadyForTest(doc) { return numeralFontReady(doc); }

/**
 * Call `onReady` (redraw and re-upload a diy-words texture) once the shared
 * numeralFontReady() promise settles TRUE. Never calls `onReady` on Node or
 * on a failed/unavailable load -- the caller's own fallback-font first draw
 * is already correct in that case, so there is nothing to redraw.
 */
function loadNumeralFont(onReady, doc) {
  const ready = numeralFontReady(doc);
  if (!ready) return; // Node, no doc injected
  ready.then((ok) => { if (ok && typeof onReady === 'function') onReady(); });
}

/**
 * Draw "12"/"9"/"6" (big bold numerals, at their ring positions) and
 * "One".."Five" (a thin script, to the right of the 1-5 ring positions,
 * "Three" largest) onto an ALREADY-SIZED canvas 2D context. Split out from
 * buildWordsTexture so the SAME canvas/texture can be redrawn once the real
 * numeral font finishes loading (see startDiyWordsFontRedraw below) without
 * re-deriving the layout math a second time.
 */
function drawWordsCanvas(ctx, wPx, hPx, numeralColor, numeralFontFamily) {
  ctx.clearRect(0, 0, wPx, hPx); // transparent background -- only the marks are opaque
  ctx.fillStyle = numeralColor;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  // Panel-space (radius units) -> canvas pixels: x=0 at WORD_LEFT_R from the
  // left edge (so the ring, which needs room on both sides of x=0, is not
  // pinned to the canvas edge), y=0 at vertical centre, +y is UP (canvas +y
  // is down, so this flips it).
  const spanX = WORD_LEFT_R + WORD_RIGHT_R;
  const pxPerR = wPx / spanX;
  const toPx = (xR, yR) => [(xR + WORD_LEFT_R) * pxPerR, hPx / 2 - yR * pxPerR];

  // Numerals: 12, 9, 6 -- big, bold, rounded sans.
  //
  // Both owner reference photos show a slight drop shadow on the numerals --
  // a real physical effect of the acrylic pieces standing a few mm off the
  // wall in the actual clock. The item's own perf guidance is explicit that
  // numerals are ONE flat canvas-texture plane, not individual 3D pieces
  // (cheaper than real per-numeral depth+lighting), so the shadow is drawn
  // into that same texture with the canvas 2D shadow properties -- a soft,
  // small offset blur behind the glyph -- rather than built as geometry.
  // Round 2 (item 059873ed): weight 900 read as far too heavy/blocky next
  // to the references, which show a rounded MEDIUM weight with soft
  // terminals -- dropped to 500, with the size factor also trimmed
  // (0.62 -> 0.5) since the references' numerals are a touch smaller
  // relative to the dial too. This is also what made the clipping fix
  // above (WORD_LEFT_R/Y_MARGIN_R) tractable without an oversized canvas:
  // a smaller, lighter glyph needs less margin to clear.
  // Round 3 (item 059873ed, round-2 review): the FIRST draw always happens
  // with `numeralFontFamily` set to the fallback stack (Nunito's CDN fetch
  // is async and must never block first paint); `startDiyWordsFontRedraw`
  // below calls this function again with the real "Nunito" family once
  // document.fonts.load resolves, so the panel upgrades from Segoe UI
  // Semibold to a genuine medium weight the moment it is ready, without a
  // second envelope/layout computation.
  const numeralSize = Math.round(pxPerR * 0.5);
  ctx.font = `500 ${numeralSize}px "${numeralFontFamily}", "Segoe UI", system-ui, sans-serif`;
  ctx.shadowColor = 'rgba(0,0,0,0.35)';
  ctx.shadowBlur = pxPerR * 0.05;
  ctx.shadowOffsetX = pxPerR * 0.025;
  ctx.shadowOffsetY = pxPerR * 0.03;
  [[12, 0, 1], [9, -1, 0], [6, 0, -1]].forEach(([label, xR, yR]) => {
    const [x, y] = toPx(xR, yR);
    ctx.fillText(String(label), x, y);
  });
  // The shadow is numerals-only (matching the reference: the words and dots
  // read flat, only the big block numerals show the raised-off-the-wall
  // look) -- cleared before anything else is drawn onto this canvas.
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;

  // Words: "One".."Five", thin quirky script, LEFT-aligned, placed to the
  // RIGHT of the 1-5 ring positions -- "Three" (position 3, straight right
  // of centre) reads largest, tapering slightly for the others, matching
  // the reference photo.
  // Both owner reference photos (wall-clock-reference.png, wallclock.jpg)
  // show a much steeper size gradient than a first pass here used: "Three"
  // reads clearly largest, "One" and "Five" clearly smallest -- not just
  // slightly smaller. Widened from a near-flat 0.85..1.0 range to 0.62..1.0.
  const words = [
    { label: 'One', hour: 1, scale: 0.62 },
    { label: 'Two', hour: 2, scale: 0.8 },
    { label: 'Three', hour: 3, scale: 1.0 },
    { label: 'Four', hour: 4, scale: 0.78 },
    { label: 'Five', hour: 5, scale: 0.6 }
  ];
  ctx.textAlign = 'left';
  // 0.3, not the numerals' own 0.62 -- see the WORD_RIGHT_R note above for
  // why this and the envelope width were tuned together against a real
  // ctx.measureText() overflow, not chosen independently.
  const baseWordSize = pxPerR * 0.3;
  words.forEach(({ label, hour, scale }) => {
    const angle = (hour / 12) * Math.PI * 2;
    const ringX = Math.sin(angle), ringY = Math.cos(angle);
    // Start just to the right of the ring point, at the SAME height --
    // matches the photo's roughly-horizontal word baselines rather than
    // following the ring's own curve.
    const [x, y] = toPx(ringX + 0.12, ringY);
    ctx.font = `400 ${Math.round(baseWordSize * scale)}px "Segoe Script", "Bradley Hand", cursive`;
    ctx.fillText(label, x, y);
  });
}

/**
 * Draw "12"/"9"/"6" and "One".."Five" onto a transparent canvas, and return
 * a THREE.CanvasTexture, or null if no canvas factory is available (plain
 * Node, no DOM/polyfill) -- same optional-texture fallback as wall-sign.js's
 * buildTextTexture. The numerals are drawn with the FALLBACK font stack
 * synchronously (Nunito's CDN fetch is async); the caller wires up
 * startDiyWordsFontRedraw separately to upgrade this same texture once the
 * real font is ready.
 */
function buildWordsTexture(THREE, wPx, hPx, numeralColor, createCanvas) {
  if (!createCanvas) return null;
  const canvas = createCanvas(wPx, hPx);
  const ctx = canvas.getContext && canvas.getContext('2d');
  if (!ctx) return null;
  drawWordsCanvas(ctx, wPx, hPx, numeralColor, 'Segoe UI'); // fallback stack -- see drawWordsCanvas's own font line

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace || texture.colorSpace;
  texture.needsUpdate = true;
  return texture;
}

/**
 * The owner's actual kitchen clock (item 059873ed): a FRAMELESS stick-on
 * clock, every piece mounted a few mm off the wall (`STANDOFF` below) so it
 * casts a small shadow, no dial, no rim.
 *   - 12, 9, 6: big bold numerals -- drawn on the canvas texture panel
 *     (see buildWordsTexture), since real 3D text geometry for 8 short
 *     strings would blow the per-type triangle budget.
 *   - 7, 8, 10, 11: solid black dots -- low-poly meshes.
 *   - 1-5: the WORDS "One".."Five" -- same canvas panel as the numerals.
 *   - Centre: a black disc -- a low-poly mesh.
 *   - Hands: tapered black hour/minute sticks, a thin red second hand with
 *     a short tail -- meshes (see addHands's `tapered` mode).
 */
function buildDiyWordsClock(THREE, p, detail, totalDepth, opts) {
  const group = new THREE.Group();
  group.name = 'furniture:wall-clock:diy-words';
  const r = (p.diameter / 100) / 2;
  const STANDOFF = Math.max(0.002, Math.min(0.006, totalDepth * 0.4)); // a few mm off the wall

  // The ASYMMETRIC shape (a centred ring, but words reaching further right
  // than the ring reaches left) means the ring's own centre is NOT the
  // envelope's centre -- the builder contract requires x centred on the
  // WHOLE bbox, not on the ring. RING_OFFSET_X shifts every ring-based
  // element (dots, disc, hands) left by just enough that the panel's own
  // wider span (which strictly contains the ring's span, since
  // WORD_LEFT_R/WORD_RIGHT_R > 1) ends up centred at x=0. Solved once, in
  // panel-space units, from the panel's own left/right reach:
  //   minX = RING_OFFSET_X - WORD_LEFT_R*r, maxX = RING_OFFSET_X + WORD_RIGHT_R*r
  //   centred means minX = -maxX, so RING_OFFSET_X = r*(WORD_LEFT_R - WORD_RIGHT_R)/2
  const RING_OFFSET_X = (r * (WORD_LEFT_R - WORD_RIGHT_R)) / 2;

  // ---- Dots at 7, 8, 10, 11 -- solid black low-poly cylinders, flush with
  // the wall (their own back face at z=0, front at STANDOFF). ----
  const dotPositions = [7, 8, 10, 11];
  // Round 3 (item 059873ed, visual review): round 2's "3x" instruction
  // (0.05 -> 0.15) overshot -- the visual reviewer measured the ACTUAL
  // reference photo directly (wall-clock-reference.png) and found a dot is
  // ~0.065r in radius, about 0.4x the height of "12", against 0.15r/~0.75x
  // in the round-2 render. Corrected to 0.07 (the coordinator's own
  // 0.065-0.07 range).
  const dotR = r * 0.07;
  // Segment count raised alongside the 3x radius increase above -- 10
  // segments (this module's original full-detail count, sized for the OLD,
  // much smaller dot) became a visible polygon once the dot itself tripled
  // in size (noticed while re-checking the round-2 preview render, not
  // called out explicitly in the directive, but the same segment-count-vs-
  // radius bug class the disc fix below addresses, so fixed here too rather
  // than shipping a preview with a new, self-visible defect).
  dotPositions.forEach(hour => {
    const angle = (hour / 12) * TAU;
    const x = r * Math.sin(angle), y = r * Math.cos(angle);
    const geo = new THREE.CylinderGeometry(dotR, dotR, STANDOFF, detail ? 8 : 20);
    geo.rotateX(Math.PI / 2);
    geo.translate(0, 0, STANDOFF / 2);
    const dot = new THREE.Mesh(geo, makeFinish(THREE, 'matte', p.numeralColor));
    dot.name = 'dot' + hour;
    dot.position.set(x + RING_OFFSET_X, y, 0);
    group.add(dot);
  });

  // ---- Numerals (12, 9, 6) + words (One..Five): ONE transparent canvas
  // panel, standing STANDOFF off the wall so it reads as its own stuck-on
  // piece rather than painted flush on the surface. Sized in world units
  // from the SAME radius-unit panel space buildWordsTexture draws into, so
  // the texture and the plane's own geometry can never drift apart. ----
  const panelW = r * (WORD_LEFT_R + WORD_RIGHT_R);
  const panelH = r * (2 * Y_MARGIN_R);
  // The plane geometry is centred on ITS OWN origin, which must land at
  // world x = RING_OFFSET_X + (panel-space centre relative to ring centre)
  // -- the panel's own ring-space x=0 (the clock centre buildWordsTexture's
  // toPx() treats as the origin) is offset from the PLANE's own geometric
  // centre by (WORD_RIGHT_R - WORD_LEFT_R)/2 * r (the panel is wider on the
  // right than the left of ring-space 0), so the plane mesh's position is
  // the ring offset PLUS that panel-internal offset.
  const panelCenterX = RING_OFFSET_X + (r * (WORD_RIGHT_R - WORD_LEFT_R)) / 2;
  const createCanvas = resolveCreateCanvas(opts);
  const texPx = detail ? 512 : 1024;
  const texHeightPx = Math.round(texPx * (panelH / panelW));
  const texture = buildWordsTexture(THREE, texPx, texHeightPx, p.numeralColor, createCanvas);
  const panelMat = new THREE.MeshStandardMaterial(Object.assign(
    { roughness: 0.8, metalness: 0, transparent: true, alphaTest: 0.1 },
    texture ? { map: texture } : { color: p.numeralColor, opacity: 0 }
  ));
  const panel = new THREE.Mesh(new THREE.PlaneGeometry(panelW, panelH), panelMat);
  panel.name = 'wordsPanel';
  panel.position.set(panelCenterX, 0, STANDOFF);
  // Textured (or, with no canvas, an invisible placeholder so the envelope
  // and keep-tag are still exercised in Node) -- userData.keep excludes it
  // from the live-house merge (same exception wall-sign.js's text panel
  // makes), userData.finish is set for introspection/consistency.
  panel.userData.finish = 'matte';
  panel.userData.keep = true;
  group.add(panel);

  // Round 3 (item 059873ed, round-2 review): once the real Nunito 500 face
  // finishes loading (async -- see loadNumeralFont's own doc comment), redraw
  // this SAME canvas with the real family and re-upload the texture. This
  // must not run in Node (texture is null there -- buildWordsTexture already
  // returned null with no canvas factory) or fire more than once per group.
  if (texture) {
    loadNumeralFont(() => {
      const canvas = texture.image;
      const ctx = canvas && canvas.getContext && canvas.getContext('2d');
      if (!ctx) return;
      drawWordsCanvas(ctx, texPx, texHeightPx, p.numeralColor, NUMERAL_FONT_FAMILY);
      texture.needsUpdate = true;
    }, opts && opts.doc);
  }

  // ---- Centre disc: a low-poly black cylinder covering the hands' pivot.
  // Both owner reference photos show a LARGE disc, roughly a fifth of the
  // dial's own diameter (2r) -- i.e. a radius of about 0.2r -- not the small
  // hub-sized circle a first pass here used (0.16r radius read as visibly
  // too small next to the reference once compared side by side). ----
  const discR = r * 0.2;
  // Round 2 (item 059873ed): 14 segments at full detail (`detail` here is
  // true for LOW, so this was the FULL-detail branch) still read as a
  // visible polygon next to the reference photos' smooth disc. Raised to
  // 32 at full detail (the directive's own floor); low detail stays modest
  // (10, up slightly from 6) since it is never the camera's close subject.
  const discGeo = new THREE.CylinderGeometry(discR, discR, STANDOFF * 1.5, detail ? 10 : 32);
  discGeo.rotateX(Math.PI / 2);
  discGeo.translate(0, 0, STANDOFF * 1.5 / 2);
  const disc = new THREE.Mesh(discGeo, makeFinish(THREE, 'matte', p.numeralColor));
  disc.name = 'centreDisc';
  disc.position.set(RING_OFFSET_X, 0, 0);
  group.add(disc);

  // ---- Hands: tapered black hour/minute, thin red second hand with a tail
  // -- mounted just in front of the centre disc. addHands() itself always
  // pivots at LOCAL (0,0,z), so the whole hand assembly is built inside a
  // sub-group shifted by RING_OFFSET_X, rather than passing the offset into
  // addHands (which every other kind calls un-shifted). ----
  const handsGroup = new THREE.Group();
  handsGroup.name = 'handsGroup';
  handsGroup.position.set(RING_OFFSET_X, 0, 0);
  addHands(THREE, handsGroup, r, p.handColor, p.time, detail, STANDOFF * 1.5, totalDepth, p.secondHandColor, true);
  group.add(handsGroup);

  return group;
}

export function build(THREE, params, opts) {
  const isDiyWords = (params && params.kind) === 'diy-words';
  const p = Object.assign({}, isDiyWords ? DIY_WORDS_DEFAULTS : DEFAULTS, params || {});
  const detail = opts && opts.detail === 'low';
  const totalDepth = p.depth / 100;
  const group = p.kind === 'diy-words'
    ? buildDiyWordsClock(THREE, p, detail, totalDepth, opts)
    : p.kind === 'diy-numerals'
      ? buildDiyNumeralsClock(THREE, p, detail, totalDepth)
      : buildFramedClock(THREE, p, detail, totalDepth);
  group.name = 'furniture:wall-clock';
  // Both builders draw centred on x = 0, back already at z = 0 and every part
  // within [0, totalDepth] (see addHands' hub placement). Lift only in y so
  // the bottom of the whole assembly sits at the contract's y = 0.
  const h = p.height / 100;
  const wrapper = new THREE.Group();
  wrapper.name = 'furniture:wall-clock';
  group.position.y += h / 2;
  wrapper.add(group);
  return wrapper;
}
