/**
 * photo-span.js - span ONE picture across the panels of a photo frame.
 *
 * A PAGE-ONLY helper for the SmallItemsSpec "preview an image" control: the
 * owner picks an image in the browser and sees it in any photo-frame preset,
 * and on a multi-panel frame the one image runs across all the panels, as a
 * split canvas does (the frame bars and the gaps between panels hide their
 * slice of it). The image never leaves the browser; placements in a house
 * keep taking theirs from the house's own files. Not read by the live scene.
 *
 * DOM-free: spanPanels() is pure maths on plain rectangles, and
 * applyPhotoSpan() takes THREE injected (no `import 'three'`), as the
 * builders do -- so both are unit-tested in Node by
 * scripts/test-photo-span.mjs against the real photo-frame builder.
 *
 * The picture COVERS the panels' combined area -- scaled to fill it and
 * centred, the overflow cropped, never stretched -- and each panel gets
 * the texture transform (uv' = uv * repeat + offset) that shows its slice.
 * A panel's uv runs 0..1 left to right and bottom to top across its face,
 * as a THREE.BoxGeometry front face does, and v runs up the image as a
 * texture with flipY does.
 */

/**
 * @param {Array<{minX:number,maxX:number,minY:number,maxY:number}>} panels
 *   each picture panel's face, in any one unit (x right, y up)
 * @param {number} imageAspect  the image's width / height
 * @returns {Array<{repeat:[number,number], offset:[number,number]}>} one per
 *   panel, in the same order
 */
export function spanPanels(panels, imageAspect) {
  if (!Array.isArray(panels) || !panels.length) return [];
  const x0 = Math.min(...panels.map(p => p.minX)), x1 = Math.max(...panels.map(p => p.maxX));
  const y0 = Math.min(...panels.map(p => p.minY)), y1 = Math.max(...panels.map(p => p.maxY));
  const W = Math.max(x1 - x0, 1e-9), H = Math.max(y1 - y0, 1e-9);
  const areaAspect = W / H;
  const img = imageAspect > 0 && Number.isFinite(imageAspect) ? imageAspect : areaAspect;
  // The share of the image's width (fx) and height (fy) the area shows.
  const fx = img > areaAspect ? areaAspect / img : 1;
  const fy = img > areaAspect ? 1 : img / areaAspect;
  const u0 = (1 - fx) / 2, v0 = (1 - fy) / 2;
  return panels.map(p => ({
    repeat: [fx * (p.maxX - p.minX) / W, fy * (p.maxY - p.minY) / H],
    offset: [u0 + fx * (p.minX - x0) / W, v0 + fy * (p.minY - y0) / H]
  }));
}

/**
 * Apply the span to a built photo frame: every picture panel wearing
 * `tex` (the builder's `image` + `textureLoader` hook put it there) gets
 * its own material and a clone of `tex` showing its slice -- the slice set
 * by where that panel sits, so the leftmost panel shows the image's left.
 * THREE is injected, as the builders take it.
 *
 * @returns {{ panels: number, disposables: Array }} the new materials and
 *   texture clones, for the caller to dispose on its next rebuild
 */
export function applyPhotoSpan(THREE, built, tex, imageAspect) {
  const pics = [];
  built.traverse(o => { if (o.isMesh && o.material && o.material.map === tex) pics.push(o); });
  const rects = pics.map(o => {
    o.updateMatrix();
    o.geometry.computeBoundingBox();
    const b = o.geometry.boundingBox.clone().applyMatrix4(o.matrix);
    return { mesh: o, minX: b.min.x, maxX: b.max.x, minY: b.min.y, maxY: b.max.y };
  });
  // Each slice comes from its panel's own position, so the traversal order
  // does not matter.
  const spans = spanPanels(rects, imageAspect);
  const shared = new Set(pics.map(o => o.material));
  const disposables = [];
  rects.forEach((r, i) => {
    const slice = tex.clone();
    slice.repeat.set(spans[i].repeat[0], spans[i].repeat[1]);
    slice.offset.set(spans[i].offset[0], spans[i].offset[1]);
    slice.needsUpdate = true;
    const mat = r.mesh.material.clone();
    mat.map = slice;
    r.mesh.material = mat;
    disposables.push(slice, mat);
  });
  // the builder's one shared panel material: replaced before it was drawn
  shared.forEach(m => m.dispose());
  return { panels: rects.length, disposables };
}
