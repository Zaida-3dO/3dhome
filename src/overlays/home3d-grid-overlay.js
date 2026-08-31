/**
 * Coordinate-grid overlay — a flat cm-coordinate grid hovering above the
 * house, so you can read the X/Y numbers used in the WALLS/ROOMS coordinate
 * tables directly on the 3D map ("x=642.5 is HERE"). Companion to the compass:
 * the grid's legend cites the same orientation fact (North = smaller y = -Z).
 *
 * OFF by default. Toggle with either:
 *   - The "Grid" switch in the Controls sidebar (wired from home3d.html)
 *   - Keyboard shortcut: 'G' (plain key; the wall-debug overlay uses Shift+D,
 *     so no clash — see onKeydown below)
 *
 * Design goal: total isolation, same as js/wall-debug-overlay.js. This is the
 * ONLY file that knows about the coordinate grid. Wired in from exactly one
 * call site in home3d.html:
 *
 *   const grid = HomeGridOverlay.attachGridOverlay(home.scene, {
 *     bounds: Home3DScene.FOOTPRINT_BOUNDS,
 *     transform: Home3DScene.COORD_TRANSFORM,
 *     wallHeight: Home3DScene.WALL_HEIGHT,
 *     requestRender: home.requestRender,
 *   });
 *   // grid.setEnabled(true/false), grid.toggle(), grid.isEnabled()
 *
 * To fully remove later: delete this file, its one call site + <script> tag in
 * home3d.html, the "Grid" toggle in renderPanel(), and (optionally) the
 * FOOTPRINT_BOUNDS/COORD_TRANSFORM export block in home3d-scene.js. Nothing
 * else reads any of it.
 */

/* global THREE */

const HomeGridOverlay = (() => {
  // ---- Tunables ----
  // Gridline spacing in MODEL centimetres (same units as WALLS/ROOMS coords).
  // 100cm chosen as a readable balance: fine enough to locate a coordinate,
  // coarse enough that labels don't overcrowd (the footprint is ~1000×740cm,
  // so ~10 lines each way). Change here to re-space the whole grid.
  const GRID_SPACING_CM = 100;
  // Extra margin beyond the wall footprint, so the grid frames the house
  // rather than being flush to its outermost walls.
  const MARGIN_CM = 100;
  // Height (world metres) at which the flat grid hovers. WALL_HEIGHT is ~2.5m;
  // sit a touch above the walls so the grid reads as a ceiling-plane reference
  // that doesn't z-fight with floors/furniture. Flat (constant Y) by design.
  const GRID_Y_ABOVE_WALLS_M = 0.15;
  // Grid line colours (major axis lines vs the regular grid).
  const LINE_COLOR = 0x4fa3ff;      // regular gridlines (soft blue)
  const LINE_OPACITY = 0.5;
  // World-space size of each coordinate label sprite.
  const LABEL_SIZE_M = 0.32;

  // Round n DOWN / UP to the nearest multiple of `step`.
  const floorTo = (n, step) => Math.floor(n / step) * step;
  const ceilTo = (n, step) => Math.ceil(n / step) * step;

  function isEnabledFromUrl() {
    try {
      const v = new URLSearchParams(window.location.search).get('grid');
      return v === '1' || v === 'true';
    } catch (e) {
      return false;
    }
  }

  // A coordinate label sprite ("x=650" / "y=400"). depthTest:false keeps it
  // readable through geometry; sprites always face the camera, so labels stay
  // legible from any orbit angle (solves the "labels facing the camera" issue).
  function makeLabelSprite(text, color) {
    const w = 256, h = 96;
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, w, h);
    const pad = 6, r = 14;
    ctx.fillStyle = 'rgba(15, 20, 30, 0.82)';
    ctx.beginPath();
    ctx.moveTo(pad + r, pad);
    ctx.arcTo(w - pad, pad, w - pad, h - pad, r);
    ctx.arcTo(w - pad, h - pad, pad, h - pad, r);
    ctx.arcTo(pad, h - pad, pad, pad, r);
    ctx.arcTo(pad, pad, w - pad, pad, r);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.font = 'bold 46px "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, w / 2, h / 2 + 2);

    const tex = new THREE.CanvasTexture(canvas);
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    const mat = new THREE.SpriteMaterial({
      map: tex, transparent: true, depthTest: false, depthWrite: false, sizeAttenuation: true
    });
    const sprite = new THREE.Sprite(mat);
    // Labels are ~2.7× wider than tall (256×96) — keep that aspect so text
    // isn't squashed.
    sprite.scale.set(LABEL_SIZE_M * (w / h), LABEL_SIZE_M, 1);
    sprite.renderOrder = 998; // just under the wall-debug labels (999)
    return sprite;
  }

  function buildGroup(bounds, transform, wallHeight) {
    const { tx, tz } = transform;
    const group = new THREE.Group();
    group.name = 'home-coord-grid-overlay';
    const gridY = wallHeight + GRID_Y_ABOVE_WALLS_M;

    // Grid extent in MODEL cm, snapped outward to whole spacing multiples so
    // labels land on round numbers (x=600, x=700, …).
    const minXcm = floorTo(bounds.minX - MARGIN_CM, GRID_SPACING_CM);
    const maxXcm = ceilTo(bounds.maxX + MARGIN_CM, GRID_SPACING_CM);
    const minYcm = floorTo(bounds.minY - MARGIN_CM, GRID_SPACING_CM);
    const maxYcm = ceilTo(bounds.maxY + MARGIN_CM, GRID_SPACING_CM);

    // World-space extents (tz maps model y -> world Z, tx maps model x -> X).
    const wMinX = tx(minXcm), wMaxX = tx(maxXcm);
    const wMinZ = tz(minYcm), wMaxZ = tz(maxYcm);

    const lineMat = new THREE.LineBasicMaterial({
      color: LINE_COLOR, transparent: true, opacity: LINE_OPACITY, depthTest: false, depthWrite: false
    });

    const positions = [];
    // Constant-X lines (run along model-Y / world-Z) — one per x value.
    for (let xcm = minXcm; xcm <= maxXcm; xcm += GRID_SPACING_CM) {
      const wx = tx(xcm);
      positions.push(wx, gridY, wMinZ, wx, gridY, wMaxZ);
    }
    // Constant-Y lines (run along model-X / world-X) — one per y value.
    for (let ycm = minYcm; ycm <= maxYcm; ycm += GRID_SPACING_CM) {
      const wz = tz(ycm);
      positions.push(wMinX, gridY, wz, wMaxX, gridY, wz);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    const lines = new THREE.LineSegments(geo, lineMat);
    lines.renderOrder = 997;
    group.add(lines);

    // X-axis coordinate labels — placed along the NORTH edge (model y = minY =
    // smaller y = -Z), which is the "top" of the plan. Colour-coded amber for X.
    const X_COLOR = 'rgba(255, 200, 90, 0.95)';
    for (let xcm = minXcm; xcm <= maxXcm; xcm += GRID_SPACING_CM) {
      const s = makeLabelSprite('x=' + xcm, X_COLOR);
      s.position.set(tx(xcm), gridY, wMinZ);
      group.add(s);
    }
    // Y-axis coordinate labels — placed along the WEST edge (model x = minX =
    // -X). Colour-coded cyan for Y.
    const Y_COLOR = 'rgba(120, 230, 255, 0.95)';
    for (let ycm = minYcm; ycm <= maxYcm; ycm += GRID_SPACING_CM) {
      const s = makeLabelSprite('y=' + ycm, Y_COLOR);
      s.position.set(wMinX, gridY, tz(ycm));
      group.add(s);
    }

    group.userData.disposables = [geo, lineMat];
    return group;
  }

  // Small always-on-screen legend (DOM), shown only while the grid is enabled.
  // Explains axes, units, and ties to the compass orientation (N = -y).
  function buildLegend() {
    const el = document.createElement('div');
    el.id = 'grid-legend';
    Object.assign(el.style, {
      position: 'absolute', left: '12px', bottom: '12px', zIndex: '40',
      background: 'rgba(15, 20, 30, 0.82)', color: '#dfe7f2',
      font: '11px/1.5 "Segoe UI", sans-serif', padding: '8px 10px',
      borderRadius: '8px', pointerEvents: 'none', display: 'none',
      boxShadow: '0 4px 16px rgba(0,0,0,0.4)', maxWidth: '190px'
    });
    el.innerHTML =
      '<div style="font-weight:700;margin-bottom:4px;">Coordinate grid</div>' +
      '<div><span style="color:#ffc85a;font-weight:700;">X</span> = East(+) / West(−)</div>' +
      '<div><span style="color:#78e6ff;font-weight:700;">Y</span> = South(+) / North(−)</div>' +
      '<div style="opacity:0.75;margin-top:3px;">Units: cm · same as room table</div>' +
      '<div style="opacity:0.75;">North = smaller y (−y) · matches compass</div>';
    return el;
  }

  function attachGridOverlay(scene, opts = {}) {
    const bounds = opts.bounds;
    const transform = opts.transform;
    if (!scene || !bounds || !transform || typeof transform.tx !== 'function') {
      // Data not available (older home3d-scene.js without the export) — no-op.
      return { setEnabled() {}, toggle() {}, isEnabled: () => false, dispose() {} };
    }
    const wallHeight = opts.wallHeight || 2.5;
    const requestRender = typeof opts.requestRender === 'function' ? opts.requestRender : () => {};
    let onChange = typeof opts.onChange === 'function' ? opts.onChange : () => {};

    let group = null;
    let legend = null;
    let enabled = opts.enabled !== undefined ? !!opts.enabled : isEnabledFromUrl();

    function ensureBuilt() {
      if (!group) {
        group = buildGroup(bounds, transform, wallHeight);
        scene.add(group);
      }
      if (!legend) {
        legend = buildLegend();
        document.body.appendChild(legend);
      }
    }

    function setEnabled(next) {
      enabled = !!next;
      ensureBuilt();
      group.visible = enabled;
      legend.style.display = enabled ? 'block' : 'none';
      requestRender();
      onChange(enabled);
    }

    setEnabled(enabled);

    function onKeydown(e) {
      // 'G' toggles the grid. Plain key (no modifier): the only other global
      // shortcut is the wall-debug overlay's Shift+D, so there's no clash.
      // Ignore when typing in a field (none exist today, but future-proof).
      if (e.key === 'g' || e.key === 'G') {
        const t = e.target;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
        if (e.ctrlKey || e.metaKey || e.altKey) return; // leave browser/app chords alone
        setEnabled(!enabled);
      }
    }
    window.addEventListener('keydown', onKeydown);

    return {
      setEnabled,
      toggle() { setEnabled(!enabled); },
      isEnabled() { return enabled; },
      dispose() {
        window.removeEventListener('keydown', onKeydown);
        if (group) {
          scene.remove(group);
          (group.userData.disposables || []).forEach(d => d.dispose && d.dispose());
          group.traverse(obj => {
            if (obj.material) {
              if (obj.material.map) obj.material.map.dispose();
              obj.material.dispose();
            }
          });
          group = null;
        }
        if (legend && legend.parentNode) { legend.parentNode.removeChild(legend); legend = null; }
      },
    };
  }

  return { attachGridOverlay };
})();
