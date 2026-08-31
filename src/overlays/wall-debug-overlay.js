/**
 * Wall-numbering debug overlay — a dev-only tool to reference exact
 * wall segments in future correction prompts ("wall #14 needs X"). NOT a
 * shipped end-user feature.
 *
 * OFF by default. Toggle with either:
 *   - URL query param: ?debugWalls=1
 *   - Keyboard shortcut: Shift+D (once the scene has loaded)
 *
 * Design goal: total isolation. This is the ONLY file that knows about wall
 * IDs/labels/sprites. It is wired in from exactly one call site in
 * home3d.html:
 *
 *   WallDebugOverlay.attachWallDebugOverlay(home.scene, Home3DScene.WALL_SEGMENTS_WORLD,
 *     { wallHeight: Home3DScene.WALL_HEIGHT, requestRender: home.requestRender });
 *
 * To fully remove this tool later: delete this file, delete that one call
 * (+ its <script src="js/wall-debug-overlay.js"> tag), and optionally drop
 * the small WALL_SEGMENTS_WORLD/WALL_HEIGHT export block in
 * home3d-scene.js (clearly marked there, harmless to leave in place —
 * nothing else in the scene reads them). The rest of the app is untouched
 * either way; no other file has an `if (debug)` branch for this.
 */

/* global THREE */

const WallDebugOverlay = (() => {
  // Fixed repeat positions along a wall's length, as fractions (25%/50%/75%)
  // — not an absolute-distance interval — so every wall shows the same
  // pattern regardless of length. Walls shorter than MIN_LEN_FOR_REPEATS_M
  // just get a single centered label; three would overcrowd a short run
  // (2026-07-08, review-flagged: labels were overlapping/unreadable near each
  // other — this is also what caused the "18 vs 7/8" ambiguity during the
  // wall-corner fix work, alongside the label size below).
  const REPEAT_FRACTIONS = [0.25, 0.5, 0.75];
  const MIN_LEN_FOR_REPEATS_M = 1.8; // below this, one centered label instead of three
  // Halved from 0.55 (2026-07-08, review-flagged: labels were too big, causing
  // nearby wall numbers to overlap and become unreadable).
  const SPRITE_SIZE_M = 0.275; // world-space size of each label sprite

  function isEnabledFromUrl() {
    try {
      const params = new URLSearchParams(window.location.search);
      const v = params.get('debugWalls');
      return v === '1' || v === 'true';
    } catch (e) {
      return false;
    }
  }

  // One shared SpriteMaterial per unique label text (a wall's ID repeats
  // several times along its length -- no need for a separate canvas/texture
  // per repeat). Sprites always render on top regardless of which side of a
  // wall the camera is on (depthTest: false below), so a single sprite per
  // repeat point -- not one per face -- is already visible from both sides.
  function makeLabelMaterial(text) {
    const size = 128;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, size, size);
    // Rounded-rect translucent backing so the ID stays legible against any
    // wall colour / lighting condition.
    const r = 20, pad = 6;
    ctx.fillStyle = 'rgba(15, 15, 20, 0.78)';
    ctx.beginPath();
    ctx.moveTo(pad + r, pad);
    ctx.arcTo(size - pad, pad, size - pad, size - pad, r);
    ctx.arcTo(size - pad, size - pad, pad, size - pad, r);
    ctx.arcTo(pad, size - pad, pad, pad, r);
    ctx.arcTo(pad, pad, size - pad, pad, r);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 224, 102, 0.9)';
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.fillStyle = '#ffe066';
    ctx.font = 'bold 52px "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, size / 2, size / 2 + 2);

    const tex = new THREE.CanvasTexture(canvas);
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    return new THREE.SpriteMaterial({
      map: tex,
      transparent: true,
      // depthTest TRUE (2026-07-10, requested): labels must be OCCLUDED by
      // walls in front of them instead of punching through. depthWrite stays
      // false (sprites are transparent overlays — they shouldn't stamp the depth
      // buffer and occlude each other / real geometry behind them). To stay
      // readable on EITHER face of the wall it labels, we emit one sprite per
      // face pushed just proud of that face (see buildGroup) — a single
      // centreline sprite would be culled by its own wall's near face.
      depthTest: true,
      depthWrite: false,
      sizeAttenuation: true,
    });
  }

  // How far (metres) to float each label ABOVE its wall's top surface. the owner's
  // rule (2026-07-10): a wall must NEVER hide its OWN label, but OTHER walls in
  // front of it SHOULD occlude it, and the primary view is TOP-DOWN. Sitting the
  // sprite proud of the wall TOP (rather than at the centreline, buried inside
  // the geometry) means from above it rests on top of its own wall — visible —
  // while a taller/closer wall between it and the camera still occludes it under
  // depthTest:true. The sprite is centred on this point, so half of it dips
  // toward the wall; a small clearance keeps the whole label above the top edge.
  const LABEL_ABOVE_TOP_M = 0.12;

  function buildGroup(wallSegments, wallHeight) {
    const group = new THREE.Group();
    group.name = 'wall-debug-overlay';
    // Float labels just above the wall TOP (was mid-wall centreline, which the
    // wall's own faces buried once depth testing was enabled). Sprite is centred
    // on labelY, so add half the sprite's height on top of the clearance so its
    // bottom edge clears the wall top too.
    const labelY = wallHeight + LABEL_ABOVE_TOP_M + SPRITE_SIZE_M * 0.5;
    const materialCache = new Map(); // label text -> shared SpriteMaterial

    wallSegments.forEach((seg) => {
      // seg.id is the wall's PERMANENT id (Home3DScene.WALL_SEGMENTS_WORLD,
      // 2026-07-08 refactor) -- NOT the array index. Retiring/merging walls
      // shrinks/reorders this array over time, so index would silently
      // relabel surviving walls; id does not.
      const id = seg.id;
      const dx = seg.x2 - seg.x1, dz = seg.z2 - seg.z1;
      const len = Math.sqrt(dx * dx + dz * dz);
      if (len < 0.01) return;
      const ux = dx / len, uz = dz / len;

      const label = '#' + id;
      let mat = materialCache.get(label);
      if (!mat) {
        mat = makeLabelMaterial(label);
        materialCache.set(label, mat);
      }

      const fractions = len < MIN_LEN_FOR_REPEATS_M ? [0.5] : REPEAT_FRACTIONS;
      fractions.forEach(t => {
        // Single sprite per repeat point, floating above the wall top and
        // centred over the wall's centreline. The Y-RAISE is what stops a wall
        // burying its own label: the sprite sits above the wall top, so from
        // above (the primary view) no wall geometry is between it and the
        // camera. depthTest:true still lets OTHER walls physically in front of
        // it occlude it. renderOrder 999 only controls DRAW ORDER (draw the
        // transparent sprite after opaque walls for correct blending) — it does
        // NOT defeat depth testing, so other-wall occlusion still holds.
        const sprite = new THREE.Sprite(mat);
        sprite.scale.set(SPRITE_SIZE_M, SPRITE_SIZE_M, 1);
        sprite.renderOrder = 999;
        sprite.position.set(seg.x1 + ux * len * t, labelY, seg.z1 + uz * len * t);
        group.add(sprite);
      });
    });

    return group;
  }

  function attachWallDebugOverlay(scene, wallSegments, opts = {}) {
    if (!scene || !Array.isArray(wallSegments) || !wallSegments.length) {
      // Data not available (e.g. an older home3d-scene.js without the
      // export) -- degrade to a no-op rather than throwing.
      return { setEnabled() {}, toggle() {}, isEnabled: () => false, dispose() {} };
    }

    const wallHeight = opts.wallHeight || 2.5;
    // The scene uses on-demand rendering (repaints only on drag/scroll/an
    // explicit requestRender()) -- without this, a live toggle after the
    // first frame would silently do nothing until the next camera move.
    const requestRender = typeof opts.requestRender === 'function' ? opts.requestRender : () => {};
    // Optional callback fired whenever `enabled` changes -- lets a caller (e.g.
    // the Settings sidebar switch in home3d.html) stay in sync when the overlay
    // is flipped by the Shift+D keyboard shortcut instead of the switch. Not
    // fired for the initial setEnabled() below (that's the caller's own known
    // starting state, and firing during attach would run before the sidebar's
    // deps exist -- same TDZ trap the grid/proposed overlays guard against).
    const onChange = typeof opts.onChange === 'function' ? opts.onChange : () => {};
    let group = null;
    let enabled = opts.enabled !== undefined ? !!opts.enabled : isEnabledFromUrl();

    function ensureGroup() {
      if (!group) {
        group = buildGroup(wallSegments, wallHeight);
        scene.add(group);
      }
      return group;
    }

    function setEnabled(next, notify) {
      enabled = !!next;
      if (enabled) {
        ensureGroup().visible = true;
      } else if (group) {
        group.visible = false;
      }
      requestRender();
      if (notify) onChange(enabled);
    }

    setEnabled(enabled); // initial state -- no onChange (see note above)

    function onKeydown(e) {
      // Shift+D toggles the overlay. Chosen to avoid colliding with the only
      // other global shortcut in this app (Escape, used elsewhere for menus).
      // notify=true so a keyboard toggle keeps the sidebar switch in sync.
      if (e.shiftKey && (e.key === 'D' || e.key === 'd')) {
        setEnabled(!enabled, true);
      }
    }
    window.addEventListener('keydown', onKeydown);

    return {
      // Public setEnabled notifies by default so any external driver stays in
      // sync; the internal init call above passes notify explicitly (false).
      setEnabled: (next) => setEnabled(next, true),
      toggle() { setEnabled(!enabled, true); },
      isEnabled() { return enabled; },
      dispose() {
        // Not currently called from home3d.html -- this app never tears down
        // its own scene (home.dispose() has no caller today). Kept for
        // correctness/reuse if that ever changes; harmless to leave unused.
        window.removeEventListener('keydown', onKeydown);
        if (group) {
          scene.remove(group);
          // Sprites for the same wall ID share one SpriteMaterial (see
          // materialCache in buildGroup) -- dispose each unique one once.
          const disposed = new Set();
          group.traverse((obj) => {
            if (obj.material && !disposed.has(obj.material)) {
              disposed.add(obj.material);
              if (obj.material.map) obj.material.map.dispose();
              obj.material.dispose();
            }
          });
          group = null;
        }
      },
    };
  }

  return { attachWallDebugOverlay };
})();
