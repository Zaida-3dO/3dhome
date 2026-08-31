/**
 * Door-numbering debug overlay — a dev-only tool to reference exact
 * doors in future correction prompts ("door #3 needs X"). NOT a shipped
 * end-user feature. Modelled directly on js/wall-debug-overlay.js (the wall
 * equivalent) — same total-isolation design, same sprite-label technique.
 *
 * OFF by default. Driven ENTIRELY by the Settings sidebar's "Door numbers"
 * toggle (there is no keyboard shortcut here — Shift+D already belongs to the
 * wall overlay; a door toggle in Settings is the intended surface). It can
 * also be forced on via ?debugDoors=1 for quick manual checks.
 *
 * Design goal: total isolation. This is the ONLY file that knows about door
 * IDs/labels/sprites. It is wired in from exactly one call site in
 * home3d.html:
 *
 *   const doorNums = DoorDebugOverlay.attachDoorDebugOverlay(
 *     home.scene, Home3DScene.DOOR_LABELS_WORLD,
 *     { doorHeight: 2.03, requestRender: home.requestRender });
 *   // later, from the Settings toggle: doorNums.setEnabled(true/false)
 *
 * To fully remove this tool later: delete this file, delete that one call
 * (+ its <script src="js/door-debug-overlay.js"> tag + the Settings toggle),
 * and optionally drop the small DOOR_LABELS_WORLD export block in
 * home3d-scene.js (clearly marked there, harmless to leave in place —
 * nothing else in the scene reads it).
 */

/* global THREE */

const DoorDebugOverlay = (() => {
  // World-space size of each label sprite. Slightly larger than the wall
  // overlay's (0.275) because there is exactly ONE label per door (vs several
  // repeats per wall) so there is no crowding to guard against, and a door is
  // a small target that benefits from a bolder tag.
  const SPRITE_SIZE_M = 0.34;
  // How far (metres) to float each label ABOVE the door's top edge, so the
  // number rests just over the door head rather than buried in the leaf.
  const LABEL_ABOVE_DOOR_M = 0.14;

  function isEnabledFromUrl() {
    try {
      const params = new URLSearchParams(window.location.search);
      const v = params.get('debugDoors');
      return v === '1' || v === 'true';
    } catch (e) {
      return false;
    }
  }

  // One SpriteMaterial per unique label text. Rounded translucent backing so
  // the number stays legible against any door colour / lighting. Uses a cyan
  // accent to visually distinguish door tags from the wall overlay's yellow.
  function makeLabelMaterial(text) {
    const size = 128;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, size, size);
    const r = 20, pad = 6;
    ctx.fillStyle = 'rgba(12, 18, 22, 0.80)';
    ctx.beginPath();
    ctx.moveTo(pad + r, pad);
    ctx.arcTo(size - pad, pad, size - pad, size - pad, r);
    ctx.arcTo(size - pad, size - pad, pad, size - pad, r);
    ctx.arcTo(pad, size - pad, pad, pad, r);
    ctx.arcTo(pad, pad, size - pad, pad, r);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(80, 220, 235, 0.9)';
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.fillStyle = '#7fe8f5';
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
      // depthTest TRUE so a wall in front of a door still occludes the tag
      // (consistent with the wall overlay's 2026-07-10 behaviour). depthWrite
      // false — transparent overlay shouldn't stamp the depth buffer.
      depthTest: true,
      depthWrite: false,
      sizeAttenuation: true,
    });
  }

  function buildGroup(doorLabels, doorHeight) {
    const group = new THREE.Group();
    group.name = 'door-debug-overlay';
    // Sprite is centred on labelY, so add half its height on top of the
    // clearance so its bottom edge clears the door head too.
    const labelY = doorHeight + LABEL_ABOVE_DOOR_M + SPRITE_SIZE_M * 0.5;

    doorLabels.forEach((d) => {
      const label = '#' + d.num;
      const mat = makeLabelMaterial(label);
      const sprite = new THREE.Sprite(mat);
      sprite.scale.set(SPRITE_SIZE_M, SPRITE_SIZE_M, 1);
      sprite.renderOrder = 999; // draw after opaque geometry for correct blending
      sprite.position.set(d.x, labelY, d.z);
      group.add(sprite);
    });

    return group;
  }

  function attachDoorDebugOverlay(scene, doorLabels, opts = {}) {
    if (!scene || !Array.isArray(doorLabels) || !doorLabels.length) {
      // Data not available (e.g. an older home3d-scene.js without the
      // export) -- degrade to a no-op rather than throwing.
      return { setEnabled() {}, toggle() {}, isEnabled: () => false, dispose() {} };
    }

    const doorHeight = opts.doorHeight || 2.03;
    // The scene uses on-demand rendering (repaints only on drag/scroll/an
    // explicit requestRender()) -- without this, a live toggle after the first
    // frame would silently do nothing until the next camera move.
    const requestRender = typeof opts.requestRender === 'function' ? opts.requestRender : () => {};
    let group = null;
    let enabled = opts.enabled !== undefined ? !!opts.enabled : isEnabledFromUrl();

    function ensureGroup() {
      if (!group) {
        group = buildGroup(doorLabels, doorHeight);
        scene.add(group);
      }
      return group;
    }

    function setEnabled(next) {
      enabled = !!next;
      if (enabled) {
        ensureGroup().visible = true;
      } else if (group) {
        group.visible = false;
      }
      requestRender();
    }

    setEnabled(enabled);

    return {
      setEnabled,
      toggle() { setEnabled(!enabled); },
      isEnabled() { return enabled; },
      dispose() {
        if (group) {
          scene.remove(group);
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

  return { attachDoorDebugOverlay };
})();
