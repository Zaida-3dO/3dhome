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
 * PRIVACY: the public repo must not carry any real household's sign wording.
 * DEFAULTS below are generic placeholder text; real wording, if any, lives
 * only in a private overlay outside this repo.
 */

export const TYPE = 'wall-sign';

export const DEFAULTS = Object.freeze({
  width: 110,             // cm, overall frame width (landscape)
  height: 45,             // cm, overall frame height
  depth: 3,               // cm, frame depth (front to back)
  frameThickness: 4,      // cm, width of the frame member around the panel
  frameColor: '#2b2620',  // thin dark frame
  panelColor: '#f2ede2',  // white-washed wood panel
  line1: 'HOME',          // serif caps, generic placeholder (privacy)
  line2: 'sweet home',    // script, generic placeholder (privacy)
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
  const D = p.depth * CM;
  const FT = Math.max(0.5 * CM, p.frameThickness * CM);

  const group = new THREE.Group();
  group.name = 'wallSign';

  const matteMat = (color) => new THREE.MeshStandardMaterial({ color, roughness: 0.85, metalness: 0 });

  const frameMat = matteMat(p.frameColor);
  const backMat = matteMat(p.frameColor);

  const add = (mesh, finish) => {
    mesh.userData.finish = finish;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    return mesh;
  };

  // ---- depth layout (back at z=0, overall front at z=D) ----
  // The frame's front face is the sign's frontmost surface (z=D). The panel
  // sits in a shallow rebate just behind it, and the backer fills the rest of
  // the depth behind the panel -- so the backer's OWN front face must stop
  // short of the panel, never reach or pass it (that would bury the panel
  // inside an opaque box, which is invisible from the front no matter how
  // bright the panel's own material is).
  const REBATE = Math.min(D * 0.3, 0.4 * CM); // how far the panel sits behind the frame's front face
  const panelZ = D - REBATE;
  const backerDepth = Math.max(0.1 * CM, panelZ - 0.05 * CM); // stop just short of the panel
  const frameDepth = Math.min(D, Math.max(FT * 0.5, D * 0.6));
  const frameFrontZ = D; // frame's front face is the sign's front

  // ---- backer board (fills the depth behind the panel) ----
  const backer = new THREE.Mesh(new THREE.BoxGeometry(W, H, backerDepth), backMat);
  backer.position.set(0, H / 2, backerDepth / 2);
  add(backer, 'matte').name = 'signBacker';

  // ---- frame: four flat matte members forming a rectangle-with-hole ring,
  // its front face flush with the sign's overall front (z=D), proud of the
  // panel so the panel sits in a shallow rebate. ----
  const innerW = W - 2 * FT;
  const innerH = H - 2 * FT;

  const topBar = new THREE.Mesh(new THREE.BoxGeometry(W, FT, frameDepth), frameMat);
  topBar.position.set(0, H - FT / 2, frameFrontZ - frameDepth / 2);
  add(topBar, 'matte').name = 'signFrameTop';

  const botBar = new THREE.Mesh(new THREE.BoxGeometry(W, FT, frameDepth), frameMat);
  botBar.position.set(0, FT / 2, frameFrontZ - frameDepth / 2);
  add(botBar, 'matte').name = 'signFrameBottom';

  const leftBar = new THREE.Mesh(new THREE.BoxGeometry(FT, innerH, frameDepth), frameMat);
  leftBar.position.set(-W / 2 + FT / 2, H / 2, frameFrontZ - frameDepth / 2);
  add(leftBar, 'matte').name = 'signFrameLeft';

  const rightBar = new THREE.Mesh(new THREE.BoxGeometry(FT, innerH, frameDepth), frameMat);
  rightBar.position.set(W / 2 - FT / 2, H / 2, frameFrontZ - frameDepth / 2);
  add(rightBar, 'matte').name = 'signFrameRight';

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
