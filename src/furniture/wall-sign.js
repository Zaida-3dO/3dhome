/**
 * wall-sign.js - a framed wall sign: a white-washed wood panel in a thin dark
 * frame, with two lines of text rendered onto a CanvasTexture.
 *
 * Builder contract (see plan artifact 029b34e0 on item 78f2b614):
 *   ESM, THREE injected. Exports TYPE, DEFAULTS (frozen, cm, with numeric
 *   width/height/depth) and build(THREE, params, {detail}) returning a
 *   THREE.Group in METRES. y=0 is the bottom, x is centred, the back face
 *   sits at z=0 and the front faces +z (the same local frame as
 *   wall-fittings.js placeOnWall/localXSign). `detail` is 'full' or 'low'.
 *
 * Finish contract (plan review finding #3, item 78f2b614): the live renderer
 * merges meshes by finish, so every mesh must be tagged userData.finish from
 * the closed palette {matte, gloss, metal, glass, mirror, emissive} and use a
 * flat colour material -- no texture maps -- EXCEPT the one part explicitly
 * kept out of the merge. The text panel is that exception: it is drawn with a
 * CanvasTexture (the only texture this module uses) and is tagged
 * userData.keep = true so the merge leaves it as its own draw call.
 *
 * NODE / NO-DOM BUILDS: `document.createElement('canvas')` does not exist
 * under plain Node, which is where the builder-contract drift tests run this
 * module (bbox vs DEFAULTS, finish/keep tagging, low-detail triangle count).
 * So canvas creation is OPTIONAL: build() only calls it when a canvas factory
 * is available (either `opts.createCanvas(w, h)` passed in by a caller with
 * its own DOM/canvas polyfill, or a global `document` when running in a real
 * browser/spec page). With neither, the text panel still builds -- as a flat
 * `panelColor` plane, still tagged userData.keep so its geometry/position are
 * exercised by every test -- just without the CanvasTexture. This keeps
 * geometry and bbox fully testable in Node while the browser/spec page path
 * (which always has one of the two) is unaffected.
 *
 * TEXT: line1/line2 default to a stock retail sign phrase ("GIVE IT TO GOD" /
 * "and go to sleep") -- a common wall-decor sentiment, not any real
 * household's private wording, so it is fine as this public repo's default.
 * A real house's own wording, if different, lives only in a private overlay
 * outside this repo.
 */
import { makeFinish } from './finishes.js';
import { range, color, text } from './controls.js';

export const TYPE = 'wall-sign';

export const DEFAULTS = Object.freeze({
  width: 110,             // cm, overall frame width (landscape)
  height: 45,             // cm, overall frame height
  depth: 3,               // cm, OUTER FRAME depth (front to back), back at z=0
  panelDepth: 1.5,        // cm, inner panel/body depth -- its front (text) face
                           // sits at z=panelDepth, `depth` - `panelDepth` short
                           // of the frame's own front, so the frame projects
                           // forward past the panel by that difference.
  frameThickness: 2,      // cm, width of the frame member around the panel
  frameColor: '#151515',  // black frame
  panelColor: '#f2ede2',  // white-washed wood panel
  line1: 'GIVE IT TO GOD',  // serif caps
  line2: 'and go to sleep', // script
  textColor: '#1a1a1a'
});

const CM = 0.01;

/** A canvas factory from opts, or the global `document`, or null if neither exists. */
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

/**
 * Draw the two-line placeholder text onto a canvas sized to the panel's
 * aspect ratio, and return a THREE.CanvasTexture, or null if no canvas
 * factory is available (plain Node with no DOM/polyfill). line1 is rendered
 * in a serif small-caps style, line2 in an italic script-like style beneath
 * it -- this is the ONE textured part of the whole assembly.
 */
function buildTextTexture(THREE, panelWpx, panelHpx, params, createCanvas) {
  if (!createCanvas) return null;
  const canvas = createCanvas(panelWpx, panelHpx);
  const ctx = canvas.getContext && canvas.getContext('2d');
  if (!ctx) return null;
  ctx.fillStyle = params.panelColor;
  ctx.fillRect(0, 0, panelWpx, panelHpx);
  ctx.fillStyle = params.textColor;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const line1Size = Math.round(panelHpx * 0.22);
  ctx.font = `700 ${line1Size}px Georgia, "Times New Roman", serif`;
  ctx.fillText(String(params.line1 || '').toUpperCase(), panelWpx / 2, panelHpx * 0.38, panelWpx * 0.86);

  const line2Size = Math.round(panelHpx * 0.26);
  ctx.font = `italic 400 ${line2Size}px "Brush Script MT", "Segoe Script", cursive`;
  ctx.fillText(String(params.line2 || ''), panelWpx / 2, panelHpx * 0.68, panelWpx * 0.9);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace || texture.colorSpace;
  texture.needsUpdate = true;
  return texture;
}

/**
 * Build a framed wall sign. Returns a THREE.Group.
 * @param {object} THREE   the injected three.js module
 * @param {object} params  overrides merged onto DEFAULTS by the caller
 * @param {object} [opts]  { detail: 'full'|'low', createCanvas: (w,h) => canvas }
 *                         geometry here is already minimal (boxes + one
 *                         plane), so `detail` only affects whether the text
 *                         texture is drawn at full resolution; 'low' halves
 *                         it. `createCanvas`, if supplied, is used instead of
 *                         the global `document` (see the NODE / NO-DOM note
 *                         above).
 */
export function build(THREE, params, opts) {
  const p = Object.assign({}, DEFAULTS, params);
  const detail = (opts && opts.detail) || 'full';

  const W = p.width * CM;
  const H = p.height * CM;
  const D = p.depth * CM;                                    // outer frame depth
  const PANEL_D = Math.min(D, Math.max(0, p.panelDepth * CM)); // inner panel/body depth, clamped to [0, D]
  const FT = Math.max(0.5 * CM, p.frameThickness * CM);

  const group = new THREE.Group();
  group.name = 'wallSign';

  const frameMat = makeFinish(THREE, 'matte', p.frameColor);
  const backMat = makeFinish(THREE, 'matte', p.frameColor);

  const add = (mesh) => {
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    return mesh;
  };

  // ---- depth layout: TWO LEVELS, back at z=0 ----
  // The outer frame is `depth` (D) deep, front at z=D -- the sign's frontmost
  // surface. The inner white-washed body/panel is the shallower `panelDepth`
  // (PANEL_D): the reviewed number is its BODY's front face position, so the
  // backer box still runs from z=0 to z=PANEL_D. The frame projects forward
  // past the panel by (D - PANEL_D).
  //
  // The text plane is a SEPARATE mesh from the backer box, not a texture
  // painted on the backer's own front face -- so it cannot sit exactly on
  // that face: two coincident, differently-shaded surfaces at the same depth
  // z-fight (flicker into a moire of diagonal stripes that shifts with the
  // camera angle, found in review). Nudge the text plane PANEL_GAP forward of
  // the backer's face -- still to 1 decimal place of the reviewed 1.5cm
  // panelDepth, and still short of the frame front (z=D) as long as PANEL_GAP
  // < D - PANEL_D (true for the depth/panelDepth defaults and any sane
  // override; PANEL_GAP is clamped below so it never crosses the frame front
  // even if a caller sets panelDepth very close to depth).
  const PANEL_GAP = Math.min(0.1 * CM, Math.max(0, (D - PANEL_D) / 2)); // 1mm, or less if the two depths are nearly equal
  const backerFrontZ = PANEL_D;       // the reviewed "panel front" depth -- the body's own face
  const panelZ = backerFrontZ + PANEL_GAP; // the TEXT PLANE sits just in front of that face
  const frameFrontZ = D; // frame's front face is the sign's overall front

  // ---- panel body (fills the depth behind the text plane, i.e. the "inner
  // body" the spec calls out, from z=0 to z=backerFrontZ=PANEL_D) ----
  const bodyDepth = Math.max(0.05 * CM, backerFrontZ);
  const body = new THREE.Mesh(new THREE.BoxGeometry(W, H, bodyDepth), backMat);
  body.position.set(0, H / 2, bodyDepth / 2);
  add(body).name = 'signBacker';
  // The text plane sits just PANEL_GAP in front of this face (see above), so
  // the backer never needs to receive a shadow cast from a mesh immediately
  // in front of it -- turn that off (after add(), which defaults it on) to
  // avoid the shadow-acne variant of the same z-fighting-shaped visual bug.
  body.receiveShadow = false;

  // ---- frame: four flat matte members forming a rectangle-with-hole ring,
  // its front face flush with the sign's overall front (z=D), projecting
  // forward past the panel's own front face (z=PANEL_D) by (D - PANEL_D). ----
  const innerW = W - 2 * FT;
  const innerH = H - 2 * FT;
  const frameDepth = D; // the outer frame spans its full depth, back (z=0) to front (z=D)

  const topBar = new THREE.Mesh(new THREE.BoxGeometry(W, FT, frameDepth), frameMat);
  topBar.position.set(0, H - FT / 2, frameFrontZ - frameDepth / 2);
  add(topBar).name = 'signFrameTop';

  const botBar = new THREE.Mesh(new THREE.BoxGeometry(W, FT, frameDepth), frameMat);
  botBar.position.set(0, FT / 2, frameFrontZ - frameDepth / 2);
  add(botBar).name = 'signFrameBottom';

  const leftBar = new THREE.Mesh(new THREE.BoxGeometry(FT, innerH, frameDepth), frameMat);
  leftBar.position.set(-W / 2 + FT / 2, H / 2, frameFrontZ - frameDepth / 2);
  add(leftBar).name = 'signFrameLeft';

  const rightBar = new THREE.Mesh(new THREE.BoxGeometry(FT, innerH, frameDepth), frameMat);
  rightBar.position.set(W / 2 - FT / 2, H / 2, frameFrontZ - frameDepth / 2);
  add(rightBar).name = 'signFrameRight';

  // ---- text panel: the ONE textured, kept-out-of-merge part. Its geometry
  // and position are unconditional so the builder contract (bbox, keep flag)
  // holds whether or not a texture could be drawn. ----
  const createCanvas = resolveCreateCanvas(opts);
  const aspectPx = detail === 'low' ? 512 : 1024;
  const panelWpx = aspectPx;
  const panelHpx = Math.round(aspectPx * (innerH / innerW));
  const texture = buildTextTexture(THREE, panelWpx, panelHpx, p, createCanvas);
  const panelMat = new THREE.MeshStandardMaterial(Object.assign(
    { roughness: 0.9, metalness: 0 },
    texture ? { map: texture } : { color: p.panelColor }
  ));
  const panel = new THREE.Mesh(new THREE.PlaneGeometry(innerW, innerH), panelMat);
  panel.position.set(0, H / 2, panelZ);
  panel.name = 'signTextPanel';
  // Textured (CanvasTexture) when a canvas is available, so it is not part of
  // the flat-colour finish palette the merge groups by -- userData.keep is
  // what actually excludes it from that merge; `finish` is set too, for
  // introspection, and matches even in the no-canvas fallback (a flat
  // panelColor plane, same tagging).
  panel.userData.finish = 'matte';
  panel.userData.keep = true;
  panel.castShadow = false;
  panel.receiveShadow = true;
  group.add(panel);

  return group;
}

// ---- edit-mode controls ---------------------------------------------------------
// Ranges, steps, options and labels are copied from the spec page (see controls.js).
export const CONTROLS = [
  range('width', 'Width', 60, 200, 1, 'cm'),
  range('height', 'Height', 20, 100, 1, 'cm'),
  range('depth', 'Depth (outer frame)', 1, 8, 0.5, 'cm'),
  // The page bounds panelDepth by the live depth; as static data that is 0.5..8.
  range('panelDepth', 'Panel depth (inner body)', 0.5, 8, 0.5, 'cm'),
  range('frameThickness', 'Frame thickness', 1, 10, 0.5, 'cm'),
  color('frameColor', 'Frame colour'),
  color('panelColor', 'Panel colour'),
  text('line1', 'Line 1 (serif caps)'),
  text('line2', 'Line 2 (script)'),
  color('textColor', 'Text colour'),
];
