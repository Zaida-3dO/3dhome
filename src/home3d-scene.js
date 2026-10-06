/**
 * Home 3D Scene — vanilla JS Three.js scene builder
 * Converted from React JSX (house-3d-model.jsx).
 * Shared between the sidebar preview and the full-screen page.
 *
 * Usage:
 *   const scene = Home3DScene.create(containerEl, { interactive: true });
 *   // later: scene.dispose();
 */

import * as THREE from 'three';
import { detectMobileGpu, resolveTier } from './quality-tier.js';
import {
  LEVELS, maxLevelFor, levelForTier, defaultLevel, levelConfig, createController,
  storageKey, loadState, saveState, clearState, estimateVsync, capCadence, rafThrottle,
  pinKey, loadPin, savePin, resolveStart, recordFor, levelOptions, LEVEL_LABELS, equivalentLevel,
  MOBILE_START_RATIO, MIN_FPS_CAP, BLOCK_MS, COLD_FRAME_MS, createProbeScheduler
} from './adaptive-quality.js';
import { collapseEmitters } from './light-merge.js';
import { wallpaperFaceAxis, overlayFace, overlayUOffset } from './wallpaper-face.js';
import { seedLightState } from './light-state.js';
import { dolly, pushTarget, wheelFactor, wheelDeltaPx, createTwoFingerGesture } from './camera-gestures.js';
import { HouseLoader } from './house-loader.js';
import {
  insidePoly, clearRun, polyAreaSqm, printCount, walkFootsteps, printYaw, WALK_DEFAULTS,
  doorOpenings, placeTrail, DOOR_GAP_CM
} from './footstep-walk.js';
import {
  WINDOW_REVEAL_CM, windowVerticals, placeOnWall, buildWindow, buildCurtain,
  windowDaylight, curtainCoverIntervals, curtainTransmit,
  corniceSpotLayout, corniceLightCount, corniceLightBudget
} from './wall-fittings.js';
import {
  loadFurnitureModules, buildFurnitureSliced, buildFurnitureSync, scheduleFurnitureAttach, fadeRegistrations, furnitureItemAt,
  wallFadeTarget, wallFadeDepthWrite,
  disposeFurniture
} from './furniture.js';
import { startLiveClock } from './furniture/wall-clock.js';
import { applyLightPart, isLightPart } from './furniture/light-parts.js';
import { createTvScreens } from './furniture/tv-screen.js';
import { createHubScreens } from './furniture/hub-screen.js';
import { createBootGate } from './boot-gate.js';
import { rugPatternForBox } from './rug-pattern.js';
import { pickRoom, roomPolygons, sceneToHouse, isFurniture, stepBack } from './room-pick.js';
import { easeInOut, clonePose, deriveRoomView, deriveItemView, frontFromRotation, chooseItemView, ITEM_VIEW, segmentHitsBox, compileFocusView,
  ROOM_VIEW, chooseInRoomView, distToPolyEdge, eyeOf, planFlight, inRoomTapIsClickAway, clampRadiusInside, leavesRoom } from './camera-focus.js';
import { buildNavGraph, navInputsFromHouse, planWalk, outsideView } from './doorway-walk.js';
import { materialOpacity, isDrawn, OPACITY_SOLID } from './tap-popovers.js';
import { RUG_PATTERN_DEFAULTS } from './rug-pattern.js';
import {
  solarPosition, sunDirection, NIGHT,
  windowLightPieces, windowSegments, poolGainForFloor, colourBrightness
} from './sun-position.js';
import {
  FINISH_TYPES, makeFinishTexture, alongToMetres, finishRectOnBox, createFinishBatch, addLongFace,
  addCrossFace, buildFinishGeometry, revealEnds, finishKey, gridOriginY
} from './wall-finish.js';
import {
  applyRendererSettings, createSkyRig, presetSun, applyDaylight, applyNight,
  kelvinToHex, ROOM_LIGHT, createRoomShadowLight
} from './render-rig.js';
import {
  makeAshyOakTexture as makeAshyOakTextureShared, makeWallRoughnessTexture as makeWallRoughnessTextureShared
} from './room-finishes.js';

export const Home3DScene = (() => {
  // ---- The active house profile -------------------------------------------
  //
  // THIS ENGINE RENDERS WHATEVER HOUSE IT IS GIVEN. Everything that used to be
  // a module constant describing one specific flat -- the coordinate origin,
  // the wall list, the room polygons, the door schedule, where every light
  // fixture hangs, the site latitude -- now arrives as a compiled house profile
  // from src/house-loader.js. See houses/schema.json for the data format.
  //
  // `activeHouse` is the profile the module-level exports (ROOMS, LIGHTS,
  // WALL_SEGMENTS_WORLD, FOOTPRINT_BOUNDS, COORD_TRANSFORM, DOOR_LABELS_WORLD)
  // are derived from. Those exports are consumed by the debug overlays and by
  // embedders, so they must keep working; they are now DERIVED from the loaded
  // profile rather than frozen constants, and are refreshed whenever a scene is
  // created for a house. Read them after create() resolves, not before.
  let activeHouse = null;

  // Per-house values the scene builder reads. Bound by useHouse() below; every
  // function in this module reads them through these bindings rather than
  // closing over a literal, which is the whole point of the refactor.
  let HOUSE = null;              // the compiled profile
  let OX = 0, OY = 0, S = 0.01;  // coordinate transform (per house, never a constant)
  let WH = 2.5;                  // wall height, metres
  let WT_CM = 10;                // default wall thickness, cm
  let WT = 0.10;                 // the same, in metres (WT_CM * S)
  let WALLS = [];                // authored centrelines
  let WALL_EXT = [];             // corner-filled centrelines (see house-loader)
  let ROOMS = {};                // room id -> { poly, derived bbox, name, area, ... }
  let LIGHTS = {};               // room id -> channel -> fixture group
  let DOORS = [];                // compiled door schedule
  let WINDOWS = [];              // compiled windows (house-loader compileWindow)
  let CURTAINS = [];             // compiled curtains, sheers included (compileCurtain)
  let WALL_COLOR = 0xece9e1;
  let DOOR_SLAB_COLOR = 0xece4d4;
  let CEILING_COLOR = 0xf2efe9;

  // Plan centimetres -> world metres. Reassigned per house, so every call site
  // picks up the new transform automatically.
  let tx = x => (x - OX) * S;
  let tz = y => (y - OY) * S;

  // Door geometry defaults, in the units the render code wants (metres/cm).
  let DOOR_H = 2.03;    // default door leaf height (m)
  let DOOR_T = 0.04;    // door slab thickness (m)
  let OPEN_H = 2.07;    // wall opening height (m) -- wall stays as a lintel above
  let REVEAL_CM = 8;    // frame reveal each side (cm)
  // At-rest pose as a fraction of the solved max swing, from the house's
  // `defaults.doorRestOpenFraction`. NOTE this is the HOUSE-WIDE default and is
  // NOT what an unsensored door renders at -- see DOOR_SENSOR_BOUND_IDS and the
  // rest-pose site in the door builder, which forces CLOSED for a door nothing
  // reports on. Both demo and real profiles state 0.2 here explicitly.
  let DOOR_REST = 0;

  // The door ids that the house's rooms.json binds a contact sensor to, handed
  // in by the page (create({ sensorBoundDoorIds })).
  //
  // WHY THE SCENE NEEDS THIS: a door with a sensor has a KNOWN state, so it may
  // legitimately rest part-open until the first reading arrives. A door with NO
  // sensor has no known state at all, and standing it 20% open is a claim the
  // house cannot support -- it read as "Open: 20%" on the panel for doors
  // nothing reports on (reported 2026-09-14). Closed is the honest depiction,
  // and it is the same pose a bound sensor gives for `open === false`.
  //
  // This lives in the SCENE and not in the profile default because the profile
  // cannot express it: `defaults.doorRestOpenFraction` is house-wide, and BOTH
  // shipped profiles set it to 0.2 explicitly, so lowering the loader fallback
  // alone changes nothing for either house. Which doors have a sensor is known
  // only here, at the join between geometry and rooms.json.
  //
  // Empty set (the default) = nothing is sensor-bound = every door rests
  // CLOSED, which is the right answer for a profile with no HA wiring at all.
  let DOOR_SENSOR_BOUND_IDS = new Set();

  // Front-door leaf finish. A profile can override the leaf colour per door
  // (door.color); these are the fallbacks for a door of kind 'front'.
  const FRONT_DOOR_COLOR = 0x6E4A34;
  const FRONT_DOOR_GROOVE_COLOR = 0x2A1D14;

  /**
   * Bind a compiled house profile as the one this module renders.
   *
   * Called by create() before it builds a scene. Kept separate so the derived
   * exports can be refreshed in one place, and so a caller can compile a
   * profile once and hand it in repeatedly.
   */
  function useHouse(house) {
    if (!house) throw new Error('Home3DScene: no house profile supplied');
    activeHouse = HOUSE = house;

    OX = house.transform.OX;
    OY = house.transform.OY;
    S = house.transform.S;
    tx = house.transform.tx;
    tz = house.transform.tz;

    WH = house.wallHeight;
    WT_CM = house.wallThickness;
    WT = WT_CM * S;
    WALLS = house.walls;
    WALL_EXT = house.wallsExt;
    ROOMS = house.rooms;
    LIGHTS = house.lights;
    DOORS = house.doors;
    WINDOWS = house.windows || [];
    CURTAINS = house.curtains || [];

    WALL_COLOR = house.materials.wallColor;
    DOOR_SLAB_COLOR = house.materials.doorSlabColor;
    CEILING_COLOR = house.materials.ceilingColor;

    DOOR_H = house.defaults.doorHeight / 100;
    DOOR_T = house.defaults.doorThickness / 100;
    OPEN_H = house.defaults.doorOpeningHeight / 100;
    REVEAL_CM = house.defaults.doorFrameReveal;
    DOOR_REST = house.defaults.doorRestOpenFraction;

    refreshExports();
    return house;
  }

  // --- Door swing geometry helpers (cm space; x=east, y=south) ---
  // Returns the door's hinge point + basis: `along` (hinge->latch, closed) and
  // `normal` (into the room it opens into).
  function doorBasis(d) {
    let along, normal, oc;
    if (d.wall === 'x') { oc = [d.c, d.at]; along = [d.hinge === 'w' ? 1 : -1, 0]; normal = [0, d.swing === 's' ? 1 : -1]; }
    else { oc = [d.at, d.c]; along = [0, d.hinge === 'n' ? 1 : -1]; normal = [d.swing === 'e' ? 1 : -1, 0]; }
    const hinge = [oc[0] - along[0] * d.w / 2, oc[1] - along[1] * d.w / 2];
    return { hinge, along, normal };
  }
  // Free (latch) end of the leaf when opened `deg` degrees.
  function doorLeafTip(d, deg) {
    const b = doorBasis(d), r = deg * Math.PI / 180;
    const dx = b.along[0] * Math.cos(r) + b.normal[0] * Math.sin(r);
    const dy = b.along[1] * Math.cos(r) + b.normal[1] * Math.sin(r);
    return [b.hinge[0] + d.w * dx, b.hinge[1] + d.w * dy];
  }
  // Minimum distance between two 2-D segments (cm).
  function segSegDist(p, p2, q, q2) {
    const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
    const clamp01 = t => Math.max(0, Math.min(1, t));
    const u = sub(p2, p), v = sub(q2, q), w0 = sub(p, q);
    const a = dot(u, u), b = dot(u, v), c = dot(v, v), dd = dot(u, w0), e = dot(v, w0);
    const D = a * c - b * b;
    let sc, tc;
    if (D < 1e-9) { sc = 0; tc = (c > 1e-9 ? e / c : 0); }
    else { sc = clamp01((b * e - c * dd) / D); tc = clamp01((a * e - b * dd) / D); }
    // refine against clamped params
    sc = clamp01((b * tc - dd) / (a || 1));
    tc = clamp01((b * sc + e) / (c || 1));
    const cp = [p[0] + sc * u[0], p[1] + sc * u[1]];
    const cq = [q[0] + tc * v[0], q[1] + tc * v[1]];
    return Math.hypot(cp[0] - cq[0], cp[1] - cq[1]);
  }
  // Collision-aware max open angles: reduce swings so no two open leaves come
  // within CLEAR cm. Cupboard doors stay small; where two standard doors clash
  // they back off together; a standard vs a cupboard yields (the standard
  // reduces). Prevents doors from swinging into each other. The profile's
  // maxOpenDegrees is the INTENDED maximum -- this only ever lowers it.
  function computeDoorAngles(doors) {
    const ang = doors.map(d => d.ang);
    const CLEAR = 9, MIN_STD = 25, MIN_CUP = 18;
    const leaf = i => [doorBasis(doors[i]).hinge, doorLeafTip(doors[i], ang[i])];
    for (let it = 0; it < 120; it++) {
      let changed = false;
      for (let i = 0; i < doors.length; i++) for (let j = i + 1; j < doors.length; j++) {
        const si = leaf(i), sj = leaf(j);
        if (segSegDist(si[0], si[1], sj[0], sj[1]) < CLEAR) {
          const ci = doors[i].size === 'cup', cj = doors[j].size === 'cup';
          const minI = ci ? MIN_CUP : MIN_STD, minJ = cj ? MIN_CUP : MIN_STD;
          if (ci !== cj) { // the standard door reduces before a cupboard does
            const k = ci ? j : i, mk = k === i ? minI : minJ;
            if (ang[k] > mk) { ang[k] -= 2; changed = true; }
            else { const o = k === i ? j : i, mo = o === i ? minI : minJ; if (ang[o] > mo) { ang[o] -= 2; changed = true; } }
          } else { // same class -> back off together
            if (ang[i] > minI) { ang[i] -= 2; changed = true; }
            if (ang[j] > minJ) { ang[j] -= 2; changed = true; }
          }
        }
      }
      if (!changed) break;
    }
    return ang;
  }

  // Colour temperature -> hex: shared with the spec pages (src/render-rig.js).
  const k2h = kelvinToHex;

  // ---- Procedural floor textures (canvas-generated, no external files) ----
  function makeWoodTileTexture() {
    const size = 512;
    const c = document.createElement("canvas");
    c.width = c.height = size;
    const ctx = c.getContext("2d");

    // Base warm wood tone
    ctx.fillStyle = "#b89060";
    ctx.fillRect(0, 0, size, size);

    // Plank grain lines (horizontal, subtle variation)
    const plankH = 64; // pixels per plank row
    for (let row = 0; row < size / plankH; row++) {
      const y0 = row * plankH;
      // Slightly vary plank colour
      const v = (row % 2 === 0) ? 8 : -8;
      const r = 184 + v, g = 144 + v, b = 96 + v;
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.fillRect(0, y0, size, plankH - 1);

      // Fine grain lines within each plank
      ctx.strokeStyle = `rgba(80,50,20,0.08)`;
      ctx.lineWidth = 0.5;
      for (let i = 0; i < 6; i++) {
        const gy = y0 + Math.random() * plankH;
        ctx.beginPath();
        ctx.moveTo(0, gy);
        ctx.lineTo(size, gy + (Math.random() - 0.5) * 4);
        ctx.stroke();
      }
    }

    // Tile grout lines (grid — every 128px horizontal, every plankH vertical)
    ctx.strokeStyle = "rgba(60,40,20,0.35)";
    ctx.lineWidth = 2;
    for (let y = 0; y <= size; y += plankH) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(size, y); ctx.stroke();
    }
    for (let x = 0; x <= size; x += 128) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, size); ctx.stroke();
    }

    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    return tex;
  }

  function makeCarpetTexture(hexColor) {
    const size = 256;
    const c = document.createElement("canvas");
    c.width = c.height = size;
    const ctx = c.getContext("2d");
    const r = (hexColor >> 16) & 0xff;
    const g = (hexColor >> 8) & 0xff;
    const b = hexColor & 0xff;
    ctx.fillStyle = `rgb(${r},${g},${b})`;
    ctx.fillRect(0, 0, size, size);

    // Fine noise to simulate carpet pile
    const id = ctx.getImageData(0, 0, size, size);
    const data = id.data;
    for (let i = 0; i < data.length; i += 4) {
      const noise = (Math.random() - 0.5) * 28;
      data[i]   = Math.max(0, Math.min(255, data[i]   + noise));
      data[i+1] = Math.max(0, Math.min(255, data[i+1] + noise));
      data[i+2] = Math.max(0, Math.min(255, data[i+2] + noise));
    }
    ctx.putImageData(id, 0, 0);

    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    return tex;
  }

  function makeTileBathroomTexture() {
    const size = 256;
    const c = document.createElement("canvas");
    c.width = c.height = size;
    const ctx = c.getContext("2d");
    // Light grey-beige tile
    ctx.fillStyle = "#ccc4bc";
    ctx.fillRect(0, 0, size, size);

    // Grout lines every 64px
    ctx.strokeStyle = "rgba(100,90,85,0.5)";
    ctx.lineWidth = 2;
    for (let v = 0; v <= size; v += 64) {
      ctx.beginPath(); ctx.moveTo(0, v); ctx.lineTo(size, v); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(v, 0); ctx.lineTo(v, size); ctx.stroke();
    }

    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    return tex;
  }

  // Ashy Oak LVT floor texture: src/room-finishes.js (shared with the spec
  // pages' backdrops; moved there verbatim).
  function makeAshyOakTexture(widthM, depthM) { return makeAshyOakTextureShared(THREE, widthM, depthM); }

  // Matte-plaster wall roughness texture: src/room-finishes.js (shared with
  // the spec pages' backdrops; moved there verbatim).
  function makeWallRoughnessTexture() { return makeWallRoughnessTextureShared(THREE); }

  // Procedural oak-grain roughness map for the acoustic slat panels — subtle
  // low-contrast vertical streaks, tiled a few times up the ~2.5m slat height.
  // (Ported from experimental 2026-07-11, zabine-wall25.)
  function makeOakGrainTexture() {
    const w = 16, h = 256;
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#d9d9d9";
    ctx.fillRect(0, 0, w, h);
    for (let i = 0; i < 40; i++) {
      const x0 = Math.random() * w;
      const shade = 190 + Math.random() * 50; // subtle, low-contrast like wallRoughMap
      ctx.strokeStyle = `rgba(${shade},${shade},${shade},0.5)`;
      ctx.lineWidth = 0.4 + Math.random() * 0.6;
      ctx.beginPath();
      ctx.moveTo(x0, 0);
      ctx.bezierCurveTo(
        x0 + (Math.random() - 0.5) * 3, h * 0.33,
        x0 + (Math.random() - 0.5) * 3, h * 0.66,
        x0 + (Math.random() - 0.5) * 2, h
      );
      ctx.stroke();
    }
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(1, 5);
    return tex;
  }

  /**
   * Wall #25 bedroom-facing acoustic wood slat panel (Acupanel Contemporary
   * Oak). Ported from experimental 2026-07-11 (zabine-wall25) and re-fitted to
   * LIVE R4 #25 (centerline 953.5->931.1, run 447.8->453.0cm).
   *
   * Real product spec (mm): slats 27 wide x 10 deep, 13 gap (40 pitch), 9 felt
   * backing (19 total off the wall). Built as real parametric 3D — individual
   * slat meshes with real gaps — because the grooves have physical relief a flat
   * texture can't sell. A standalone THREE.Group bolted onto #25's existing
   * bedroom (-x) face; never touches WALL_EXT, the wall render loop, or #25's own
   * material. Reads #25's live geometry (position + own thickness) only.
   *
   * NO-FADE + BLACK-HALF FIX (2026-07-11, review-flagged): #25 is an INTERIOR
   * divider (outer:0). The bedroom slats must NEVER fade — an earlier attempt
   * registered them with outer:true (borrowing exterior wall #4's fade normal) so
   * they'd fade to let you see into the bedroom from outside, but that made the
   * slats go see-through whenever #4 faded, which reads wrong for an interior
   * panel. Fix: register the meshes with outer:false so the render-loop fade
   * block's `if (!outer) return` SKIPS them → opacity stays 1.0 forever. The panel
   * is a STACK of ~114 near-coplanar boxes; the experimental "black-half" bug was
   * an unstable transparent-pass sort making half the panel render solid BLACK,
   * swapping halves as the camera orbits. Because the slats are now always solid,
   * their materials are created with depthWrite:true (and no transparency) so the
   * z-buffer resolves the box stack from every angle — no black half, ever. (You
   * still see INTO the bedroom from outside via the exterior wall #4 fading; the
   * interior slat panel simply stays put, which is the correct real-world read.)
   */
  function buildAcousticPanelWall25(scene, wallMeshes) {
    const wall25 = WALLS.find(w => w.id === 25);
    if (!wall25) return;   // this house has no wall 25 — nothing to panel
    if (!wall25) return null;
    const wall25ThicknessCm = wall25.thickness != null ? wall25.thickness : (WT * 100);
    const wall25ThicknessM = wall25ThicknessCm * S;
    const wallCenterX = tx(wall25.x1);
    // SOUTH-END CLIP (2026-07-11, review-flagged): #25's raw span runs y 299.6..752.6,
    // but the bedroom bump-in pillar #31 (horizontal, centerline y=743.2,
    // thickness 18.8) sits across the south end — so its NORTH (bedroom-facing)
    // face is at y = 743.2 − 18.8/2 = 733.8cm. The slat run must STOP there, not
    // continue behind #31. Clip ONLY the bedroom slats' south end; the home_office
    // wallpaper on the +x face still covers the whole wall (built in the wall loop).
    const wall31 = WALLS.find(w => w.id === 31);
    const southYcm = wall31 ? (wall31.y1 - (wall31.thickness != null ? wall31.thickness : 18.8) / 2) : 733.8;
    const northYcm = Math.min(wall25.y1, wall25.y2); // 299.6 (north end, unchanged)
    const wz1 = tz(northYcm), wz2 = tz(southYcm);
    const wallCenterZ = (wz1 + wz2) / 2;
    const runLenM = Math.abs(wz2 - wz1); // clipped run: north end .. #31 north face
    // #25's own -x (bedroom) face, using #25's OWN thickness (10cm).
    const bedroomFaceX = wallCenterX - wall25ThicknessM / 2;

    // Acupanel Contemporary spec, mm -> m.
    const slatW = 0.027, slatD = 0.010, backingD = 0.009;
    const nomGap = 0.013;
    const EPS = 0.005; // mounting-gap offset off the wall face — avoids z-fighting

    // Fit whole slats; redistribute the sub-cm remainder into the gap.
    const nomPitch = slatW + nomGap;
    const n = Math.round(runLenM / nomPitch);
    const gap = (runLenM - n * slatW) / (n - 1);
    const pitch = slatW + gap;

    // Depth stack outward from the wall face into the bedroom: face -> EPS gap
    // -> felt backing -> slats. Slats protrude slatD past the backing — that step
    // IS the visible groove depth.
    const backingOuterX = bedroomFaceX - EPS;
    const backingInnerX = backingOuterX - backingD;
    const backingCenterX = (backingOuterX + backingInnerX) / 2;
    const slatOuterX = backingInnerX - slatD;
    const slatCenterX = (backingInnerX + slatOuterX) / 2;

    const group = new THREE.Group();
    group.name = 'wall25-acoustic-panel-bedroom';
    const panelMeshes = [];

    // Felt backing — dark recessed groove floor. #25 is an INTERIOR divider
    // (outer:0) so the slats must NEVER fade (2026-07-11, review-flagged: they were
    // going see-through when exterior wall #4 faded). They're registered below
    // with outer:false → the fade loop skips them → opacity stays 1.0 forever.
    // Because they're always solid, depthWrite is TRUE at creation (and never
    // toggled) so the ~114 near-coplanar boxes resolve in the z-buffer — that's
    // also what keeps the black-half bug fixed (solid + depthWrite → no black half).
    const backingMat = new THREE.MeshStandardMaterial({ color: 0x1c1815, roughness: 0.95, depthWrite: true });
    const backing = new THREE.Mesh(new THREE.BoxGeometry(backingD, WH, runLenM), backingMat);
    backing.position.set(backingCenterX, WH / 2, wallCenterZ);
    backing.receiveShadow = true;
    group.add(backing);
    panelMeshes.push(backing);

    // Slats — one shared geometry + material, n positioned instances.
    const grainMap = makeOakGrainTexture();
    const slatMat = new THREE.MeshStandardMaterial({
      color: 0xc9a06a, roughness: 0.55, roughnessMap: grainMap, depthWrite: true
    });
    const slatGeo = new THREE.BoxGeometry(slatD, WH, slatW);
    const startZ = Math.min(wz1, wz2);
    for (let i = 0; i < n; i++) {
      const zCenter = startZ + i * pitch + slatW / 2;
      const slat = new THREE.Mesh(slatGeo, slatMat);
      slat.position.set(slatCenterX, WH / 2, zCenter);
      slat.castShadow = true;
      slat.receiveShadow = true;
      group.add(slat);
      panelMeshes.push(slat);
    }

    scene.add(group);

    // Register the panel meshes with outer:false so the render-loop fade block's
    // `if (!outer) return` SKIPS them — they never fade (correct for an interior
    // divider; #25 is outer:0). Opacity stays 1.0, depthWrite stays true (set at
    // material creation), so the black-half bug stays fixed at every angle. (The
    // earlier outer:true made them borrow #4's fade and go see-through — the bug
    // review flagged 2026-07-11.) Kept in wallMeshes only for parity/traceability.
    if (wallMeshes) panelMeshes.forEach(mesh => wallMeshes.push({ mesh, nx: 0, nz: -1, outer: false }));

    return group;
  }


  // Subtle oak-grain roughness map shared by the acoustic slat panels. Low
  // contrast so it reads as texture, not stripes. (Ported from experimental.)
  function makeOakGrainTexture() {
    const w = 16, h = 256;
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#d9d9d9";
    ctx.fillRect(0, 0, w, h);
    for (let i = 0; i < 40; i++) {
      const x0 = Math.random() * w;
      const shade = 190 + Math.random() * 50; // subtle, low-contrast like wallRoughMap
      ctx.strokeStyle = `rgba(${shade},${shade},${shade},0.5)`;
      ctx.lineWidth = 0.4 + Math.random() * 0.6;
      ctx.beginPath();
      ctx.moveTo(x0, 0);
      ctx.bezierCurveTo(
        x0 + (Math.random() - 0.5) * 3, h * 0.33,
        x0 + (Math.random() - 0.5) * 3, h * 0.66,
        x0 + (Math.random() - 0.5) * 2, h
      );
      ctx.stroke();
    }
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(1, 5); // tile a few times up the 2.5m slat height
    return tex;
  }

  /**
   * Living-room acoustic wood slat panel — wall #1's room-facing (east) face +
   * the wall #3 step return, STRIVO Black Oak. Ported from the experimental
   * scene (buildAcousticPanelLivingRoomWall1Wall3).
   *
   * PATH: wall #1 (`{id:1, x1:x2:288.3, thickness:30}`) and wall #3
   * (`{id:3, x1:x2:307.4, thickness:15.8}`) are both vertical-in-plan and
   * near-parallel — #3 is thicker and widened room-ward so its east face sits
   * 12cm further into the living room than #1's, producing a real step at the
   * point #3 begins (y=707.8). The panel covers #1's face (north stop from
   * wall 1's `slats.along` in the house, y 353.4 when absent; south to the
   * step y=707.8) plus that short 12cm perpendicular return. It
   * does NOT continue onto wall #3's own wide face (visual review
   * 2026-07-09 locked this "shorter reading"). Living room sits east (+x) of
   * both walls — this is the house's west EXTERIOR wall, so slats protrude +x
   * on #1's face and -z on the step.
   *
   * DIMENSIONS: STRIVO Black Oak (600x2400x21mm; 56mm slat / 19mm gap = 75mm
   * pitch). 21mm total split as 9mm felt backing + 12mm slat protrusion.
   *
   * FADE + BLACK-HALF: transparent:true + depthWrite:false initial (the panel
   * is a stack of ~15 near-coplanar transparent boxes → without depthWrite the
   * stacked alpha compounds, and worse, from certain angles the painter's-sort
   * paints the near-black backing over the slats = the "black-half" bug). The
   * fix lives in the render-loop fade block: depthWrite is toggled per-frame to
   * `opacity > 0.98` — depth-write while solid (z-buffer resolves the stack, no
   * black-half) and off once faded (preserves see-through). The meshes are
   * registered into wallMeshes so that render-loop fix + the exterior-fade
   * reach them. Each segment gets its OWN material pair (materialFactory) —
   * seg1 (#1 face, normal (1,0)) and seg2 (step, normal (0,-1)) fade on
   * different schedules; one shared material froze in a static tug-of-war.
   *
   * Standalone group — reads only #1/#3's published geometry, never touches
   * WALL_EXT, the wall loop, or either wall's own box material.
   */
  // The panel's span on wall #1 when the house does not give one: the
  // original hardcoded stops (north y 353.4, the wall #3 step y 707.8).
  const SLAT_PANEL_DEFAULT_ALONG = [353.4, 707.8];
  function buildAcousticPanelLivingRoomWall1Wall3(scene, wallMeshes) {
    const wall1 = WALLS.find(w => w.id === 1);
    const wall3 = WALLS.find(w => w.id === 3);
    if (!wall1 || !wall3) return;   // this house lacks those walls — nothing to panel
    const wall1ThicknessM = (wall1.thickness != null ? wall1.thickness : WT_CM) * S;
    const wall3ThicknessM = (wall3.thickness != null ? wall3.thickness : WT_CM) * S;
    const wall1FaceX = tx(wall1.x1) + wall1ThicknessM / 2;  // wall #1's room-facing (east) face
    const wall3FaceX = tx(wall3.x1) + wall3ThicknessM / 2;  // wall #3's room-facing (east) face — used only to size the step return
    // The span along wall #1 comes from the house (`walls[].slats.along` on
    // wall 1, resolved by the loader); without it, the old fixed span. A
    // house sets the north stop where its kitchen worktop ends, as the real
    // panel runs right up to it.
    const span = (wall1.slats && wall1.slats.along) || SLAT_PANEL_DEFAULT_ALONG;
    const stepZ = tz(span[1]);                  // wall #1 -> wall #3 transition (wall #3's north end); panel's south end

    const stepLen = wall3FaceX - wall1FaceX;    // step-face run: ~12.0cm
    const seg1NorthZ = tz(span[0]);             // north stop
    const seg1Len = stepZ - seg1NorthZ;         // wall #1 face run, north stop to the step

    const slatW = 0.056, slatD = 0.012, backingD = 0.009;
    const nomGap = 0.019;
    const EPS = 0.005;

    const group = new THREE.Group();
    group.name = 'wall1-wall3-acoustic-panel-livingroom';

    // Light ASHY GREY-OAK (2026-07-11, review-flagged): the real #1 slats are a
    // light dove/ashy warm-grey with grey-brown wood grain — NOT the near-black
    // "STRIVO Black Oak" this used to render (backing 0x0e0b09 / slat 0x2b211c),
    // which read as an almost-black panel. Retoned to a light ashy warm-grey oak
    // in the #25 Acupanel family (the "looks perfect" reference) but greyer:
    // STRIVO Acoustic Slat Panel BLACK OAK (2026-07-11, product ref):
    // panelcompany.co.uk STRIVO Black Oak = a DARK charcoal/black-oak base with
    // SUBTLE lighter grey-brown vertical grain and dark recessed gaps. The "light
    // ashy" look in another reference photo was just bright window light hitting this dark
    // panel (the LIT appearance), not the base albedo. So the BASE is dark:
    //   slat  0x322e29 (dark warm-charcoal black-oak; warmer/greyer than dead-black
    //         0x0e0b09, darker than the ashy lit look) + grain roughnessMap for the
    //         subtle lighter grey-brown streaking seen in the product photo.
    //   backing 0x0e0b09 (near-black - correct for the DEEP recessed gaps between
    //         slats). Under bright light the charcoal reads lighter/ashy (the lit
    //         photo); in ambient it reads dark charcoal (product shots + dim render).
    // Roughness 0.6/0.95 = matte oak, no glossy sheen.
    // transparent:true so the render-loop exterior-fade can drive its opacity
    // (wall #1 is outer:1 → this panel fades see-through from outside).
    // materialFactory() makes a FRESH pair per segment so each segment owns its
    // own material (seg1 + seg2 now share a normal and fade in lockstep — see
    // the registration block below).
    // depthWrite:false INITIAL only — the render loop toggles it to
    // opacity>0.98 each frame (black-half fix, see scout-blackhalf report).
    const grainMap = makeOakGrainTexture();
    function materialFactory() {
      return {
        backing: new THREE.MeshStandardMaterial({ color: 0x0e0b09, roughness: 0.95, transparent: true, depthWrite: false }),
        slat: new THREE.MeshStandardMaterial({ color: 0x322e29, roughness: 0.6, roughnessMap: grainMap, transparent: true, depthWrite: false })
      };
    }

    const slatGeoZ = new THREE.BoxGeometry(slatD, WH, slatW);
    const slatGeoX = new THREE.BoxGeometry(slatW, WH, slatD);

    // Adds one straight run of slats + felt backing along world-z or world-x.
    // `normalSign` is the protrusion direction (+1/-1) on the perpendicular axis.
    // Returns the meshes so the caller can register them into wallMeshes.
    function addRun(axis, faceCoord, normalSign, spanStart, spanEnd, mats) {
      const runLen = Math.abs(spanEnd - spanStart);
      const nomPitch = slatW + nomGap;
      const n = Math.max(1, Math.round(runLen / nomPitch));
      const gap = n > 1 ? (runLen - n * slatW) / (n - 1) : 0;
      const pitch = slatW + gap;
      const start = Math.min(spanStart, spanEnd);

      const backingOuter = faceCoord + normalSign * EPS;
      const backingInner = backingOuter + normalSign * backingD;
      const backingCenter = (backingOuter + backingInner) / 2;
      const slatOuter = backingInner + normalSign * slatD;
      const slatCenter = (backingInner + slatOuter) / 2;

      const meshes = [];
      if (axis === 'z') {
        const backing = new THREE.Mesh(new THREE.BoxGeometry(backingD, WH, runLen), mats.backing);
        backing.position.set(backingCenter, WH / 2, (spanStart + spanEnd) / 2);
        backing.receiveShadow = true;
        group.add(backing);
        meshes.push(backing);
        for (let i = 0; i < n; i++) {
          const c = start + i * pitch + slatW / 2;
          const slat = new THREE.Mesh(slatGeoZ, mats.slat);
          slat.position.set(slatCenter, WH / 2, c);
          slat.castShadow = true;
          slat.receiveShadow = true;
          group.add(slat);
          meshes.push(slat);
        }
      } else {
        const backing = new THREE.Mesh(new THREE.BoxGeometry(runLen, WH, backingD), mats.backing);
        backing.position.set((spanStart + spanEnd) / 2, WH / 2, backingCenter);
        backing.receiveShadow = true;
        group.add(backing);
        meshes.push(backing);
        for (let i = 0; i < n; i++) {
          const c = start + i * pitch + slatW / 2;
          const slat = new THREE.Mesh(slatGeoX, mats.slat);
          slat.position.set(c, WH / 2, slatCenter);
          slat.castShadow = true;
          slat.receiveShadow = true;
          group.add(slat);
          meshes.push(slat);
        }
      }
      return { n, gap, meshes };
    }

    // Segment 1: wall #1 face, z from seg1NorthZ (north) to stepZ (south),
    // protrudes +x. Registered with wall #1's normal (1,0,outer:true).
    const seg1 = addRun('z', wall1FaceX, +1, seg1NorthZ, stepZ, materialFactory());
    if (wallMeshes) seg1.meshes.forEach(mesh => wallMeshes.push({ mesh, nx: 1, nz: 0, outer: true }));
    // Segment 2: step face (the SMALLER face near wall #1), x from wall1FaceX
    // to wall3FaceX, protrudes -z. Panel's south end (the pillar-#3 strip).
    // FADE-TOGETHER FIX (2026-07-11, review-flagged): register seg2 with the SAME
    // normal as seg1 (nx:1, nz:0 — wall #1's face normal) even though it
    // physically faces -z. The render-loop fade computes targetOpacity from
    // dot = nx*camDir.x + nz*camDir.z; giving both segments the identical normal
    // makes them compute the identical dot → identical target → they hide/show
    // in lockstep from every angle. With its own -z normal, seg2 crossed the
    // fade threshold at different camera angles than seg1, so the big face hid
    // while this pillar strip stayed solid (or vice versa). Keying the small
    // step off #1's normal is visually fine and keeps the two parts always in sync.
    const seg2 = addRun('x', stepZ, -1, wall1FaceX, wall3FaceX, materialFactory());
    if (wallMeshes) seg2.meshes.forEach(mesh => wallMeshes.push({ mesh, nx: 1, nz: 0, outer: true }));
    // Segment 3 (wall #3's own wide face) DELIBERATELY OMITTED per the owner's
    // 2026-07-09 visual review — wall #3's face stays bare wall.

    scene.add(group);
    return group;
  }

  // Cornice downlight intensity at full brightness, PER light (a cornice has
  // 3 or 5 -- see corniceSpotLayout in wall-fittings.js).
  const CORNICE_GLOW_INTENSITY = 0.35;
  // Daylight gains, applied to the sun/sky amount x curtain transmission.
  // The pools blend multiply-add (floor * (1 + gain)), so a gain of 1 doubles
  // the floor's brightness under full sun.
  const DAYLIGHT_SUN_POOL_GAIN = 1.4; // window-shaped direct-sun pool
  const DAYLIGHT_SKY_POOL_GAIN = 0.3;  // soft sky pool, every window by day
  const DAYLIGHT_SPOT_GAIN = 7;       // shared per-room SpotLight intensity

  /**
   * A soft light-pool alpha map for the daylight floor patch: brightest at
   * the window edge (v = 0), falling off into the room, soft at both sides.
   */
  function makeDaylightPatchTexture() {
    const c = document.createElement('canvas');
    c.width = 64; c.height = 64;
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(64, 64);
    for (let y = 0; y < 64; y++) {
      for (let x = 0; x < 64; x++) {
        const u = x / 63, v = y / 63;
        const along = Math.pow(1 - v, 1.6);
        const side = Math.min(1, Math.min(u, 1 - u) / 0.18);
        const a = Math.round(255 * along * side * side);
        const i = (y * 64 + x) * 4;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = a;
        img.data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    const tex = new THREE.CanvasTexture(c);
    // Canvas row 0 is the top; with flipY off, v = 0 samples row 0 (bright).
    tex.flipY = false;
    tex.needsUpdate = true;
    return tex;
  }

  /**
   * Build the full Three.js scene (walls, floors, furniture, lights).
   * Returns { scene, mainLights, mainMeshes, ambientLights, ambientMeshes }
   */
  function buildScene(scene, quality) {
    const mainLights = {}, mainMeshes = {}, ambientLights = {}, ambientMeshes = {};
    // Channels beyond 'main' and 'ambient' (a profile may declare any number --
    // the reference house had a 'galaxy' star projector). Keyed room -> channel.
    const extraLights = {}, extraMeshes = {};
    // quality = { tier, maxFragU, sunShadow, roomShadowLights, ambientStrips, shadowMapScale }
    // Set by create() based on the GPU's MAX_FRAGMENT_UNIFORM_VECTORS (and the
    // caller's `shadows` override). On low-uniform mobile GPUs (Z Fold 6 Adreno
    // = 256) the full light count blows past the shader's uniform limit and
    // nothing renders at all. The flags below trim per-tier so the shader fits.
    // shadowMapScale (default 1) shrinks shadow-map resolution for cheaper, very
    // slightly softer shadows (e.g. 0.25 => 2048->512) — used by the 'low' preset.
    const smScale = quality.shadowMapScale || 1;

    // Sky fill + directional sun (both set by updateSunlight()).
    // The fill is a HemisphereLight, not a flat AmbientLight: cool light from
    // above, a warm floor bounce from below, so tops read lighter than
    // undersides. It REPLACES the ambient one-for-one (same light count, a
    // couple of uniform rows more), and at night its sky and ground colours
    // are equal, which makes it exactly the old ambient.
    // Both come from src/render-rig.js, which the spec pages light with too
    // (colours, intensities and every shadow setting live there).
    const skyRig = createSkyRig(THREE, { castShadow: quality.sunShadow, shadowMapScale: smScale });
    const ambLight = skyRig.hemi;
    scene.add(ambLight);
    const sun = skyRig.sun;
    // Where the sun is comes from updateSunlight() (real solar position). The
    // light and its target are both placed about the house centre, so the
    // shadow frustum (+-15 m, SUN_SHADOW.halfExtent) is centred on the house
    // rather than the world origin.
    sun.position.set(tx(HOUSE.centre[0]) + 10, 18, tz(HOUSE.centre[1]) - 5);
    sun.target.position.set(tx(HOUSE.centre[0]), 0, tz(HOUSE.centre[1]));
    scene.add(sun.target);
    scene.add(sun);

    // Ground (color updated by updateSunlight)
    const gndMat = new THREE.MeshStandardMaterial({ color: 0x181828, roughness: 0.9 });
    // Sized and centred on THIS house's footprint (it used to be a fixed 30 m
    // square at one specific plan coordinate, which left a larger house sitting
    // off the edge of its own ground).
    const _groundSpan = Math.max(30, Math.max(
      (HOUSE.footprint.maxX - HOUSE.footprint.minX) * S,
      (HOUSE.footprint.maxY - HOUSE.footprint.minY) * S
    ) * 3);
    const gnd = new THREE.Mesh(new THREE.PlaneGeometry(_groundSpan, _groundSpan), gndMat);
    gnd.rotation.x = -Math.PI / 2;
    gnd.position.set(tx(HOUSE.centre[0]), -0.02, tz(HOUSE.centre[1]));
    gnd.receiveShadow = true;
    scene.add(gnd);

    // Walls — each gets its own material for per-wall opacity.
    // Where a door sits on a segment, the segment is split into full-height
    // sub-boxes around the opening plus a lintel box above it (OPEN_H up to the
    // wall top) so the wall stays solid above head height. Every resulting
    // sub-box is pushed into wallMeshes with the segment's ORIGINAL rotation,
    // normal and `outer` flag — the exterior-fade animation depends on those.
    // Matte-plaster roughness texture: one shared instance for every wall
    // material below (same object, not cloned — a single GPU upload). Gated
    // on GPU tier the same way ambientStrips is ('low' tier goes flat colour,
    // matching how the low tier already sheds the heaviest per-frame costs).
    const wallRoughMap = quality.tier !== 'low' ? makeWallRoughnessTexture() : null;

    // WALL FACE TEXTURES ---------------------------------------------------
    // A per-face material array lets a single wall box carry an image on ONE of
    // its 6 local faces (BoxGeometry default order [+x,-x,+y,-y,+z,-z]) while
    // every other face keeps the plain wall material. Which face is named by the
    // profile as a COMPASS side (`faceTexture.side`), because that is how a
    // person describes it standing in the room; it is resolved to a local box
    // face here against the wall's own orientation.
    //
    // The reference implementation hardcoded two image paths pointing into a
    // deploy directory, and kept a DUPLICATE COPY of each PNG so a deploy hook
    // that copied only one tree would still ship them. Profile-relative texture
    // paths retire that hack entirely: a texture lives in the house directory
    // beside the profile that references it.
    const wallTexLoader = new THREE.TextureLoader();
    // Every image this build loads, as a promise that settles (either way)
    // once its callback has run -- the cold-start overlay waits on them
    // (src/boot-gate.js), so a wallpaper never pops in after it comes down.
    const textureLoads = [];
    function loadTracked(loader, url, onLoad, onProgress, onError) {
      let settle;
      textureLoads.push(new Promise(r => { settle = r; }));
      loader.load(url,
        t => { try { onLoad(t); } finally { settle(); } },
        onProgress,
        e => { try { onError(e); } finally { settle(); } });
    }

    /**
     * The stretch of a north-south wall's line that a room's polygon fronts,
     * as [minY, maxY] in plan cm — or null if the room does not front it.
     *
     * Taken from the polygon rather than the room's bounding box: an L-shaped
     * room's box spans far more of the wall than the room's own edge does. The
     * hallway's box runs y 13.2..293.6 while the edge that actually fronts wall
     * #22 runs 95.6..293.6, so the box would claim ~0.9 m of wall that in fact
     * fronts a different room.
     */
    function _roomEdgeSpanOnWall(wall, roomId) {
      const room = ROOMS[roomId];
      if (!room || !Array.isArray(room.poly) || room.poly.length < 2) return null;
      if (Math.abs(wall.x1 - wall.x2) >= 0.5) return null;   // north-south walls only
      // The room's face sits half a wall thickness off the centreline, so allow
      // a little more than that — but stay tight enough to reject the room's
      // OTHER vertical edges (for the hallway the next-nearest is 37.5 cm away,
      // against the true edge's 9.5 cm).
      const tol = (wall.thickness != null ? wall.thickness : WT_CM) * 1.6;
      const ys = [];
      for (let i = 0; i < room.poly.length; i++) {
        const a = room.poly[i], b = room.poly[(i + 1) % room.poly.length];
        if (Math.abs(a[0] - b[0]) < 0.5 && Math.abs(a[0] - wall.x1) < tol) ys.push(a[1], b[1]);
      }
      if (!ys.length) return null;
      return [Math.min.apply(null, ys), Math.max.apply(null, ys)];
    }

    /**
     * Does `roomId` front effectively the WHOLE of this wall's face?
     *
     * Decides which of the two papering passes owns the wall (see their call
     * sites). The threshold is loose because a room polygon is inset from the
     * wall centreline at each end, so a room running the full length still
     * measures a few centimetres short of it.
     */
    function _roomCoversWholeFace(wall, roomId) {
      const span = _roomEdgeSpanOnWall(wall, roomId);
      if (!span) return false;
      const wallLen = Math.abs(wall.y2 - wall.y1);
      if (wallLen <= 0) return false;
      return ((span[1] - span[0]) / wallLen) >= 0.9;
    }

    /**
     * Will the room-clipped overlay pass actually build this wall?
     *
     * The two papering passes must partition the papered walls between them:
     * whatever the overlay will NOT build has to stay with the material array,
     * or the texture is simply lost. The overlay only handles a partly-fronted
     * NORTH-SOUTH wall, so an east-west wall keeps the array however little of
     * it the room fronts — the demo house papers an east-west wall exactly this
     * way, and routing it to the overlay would have made its texture disappear.
     */
    function _overlayPassOwns(wall, roomId) {
      if (!roomId) return false;
      if (Math.abs(wall.x1 - wall.x2) >= 0.5) return false;   // east-west: array's
      return !_roomCoversWholeFace(wall, roomId);
    }

    // wall id -> { faceAxis, url } for every wall the profile papers.
    const WALL_FACE_TEXTURES = {};
    Object.keys(HOUSE.wallFaceTextures).forEach(wid => {
      const ft = HOUSE.wallFaceTextures[wid];
      const wall = HOUSE.wallsById[wid];
      if (!wall) return;
      // EXACTLY ONE pass may paper a wall. There are two, and which is right
      // depends on how much of the wall the clipped room actually fronts:
      //
      //   whole face  -> this pass, a 6-entry material array on the wall box
      //                  (cheaper, and it tracks the wall's own geometry).
      //   part of it  -> the room-clipped OVERLAY pass further down, which
      //                  builds thin panels over just that stretch.
      //
      // Running both is what put wall #22's monstera on the hallway's INSIDE
      // face: the overlay drew it correctly on the west face while the material
      // array simultaneously painted the whole wall box, so the image showed up
      // on the far side too. The array cannot express a partial run, so a wall
      // the room only partly fronts is left entirely to the overlay. Wall #25,
      // whose home_office face IS fronted end to end, keeps the array — as does
      // any wall the overlay pass would not build at all.
      if (_overlayPassOwns(wall, ft.clipToRoom)) return;
      // Which of the box's long faces looks toward `side` depends on the way
      // the wall was drawn as well as on the side (src/wallpaper-face.js).
      const faceAxis = wallpaperFaceAxis(wall, ft.side, tx, tz);
      if (!faceAxis) {
        console.warn(
          '[Home3DScene] wall ' + wid + ' asks for a texture on its "' + ft.side + '" face, but that ' +
          'is an END of the wall, not one of its two long faces — ignored.'
        );
        return;
      }
      WALL_FACE_TEXTURES[wid] = { faceAxis: faceAxis, url: ft.url };
    });

    // One shared 1x1 opaque-white texture: the stand-in map every wallpapered
    // face starts with (see buildFaceTexturedMaterials). Created on first use
    // so a house with no wallpaper allocates nothing. sRGB like the real
    // photo, so the placeholder and the photo share one program variant.
    let _wallpaperPlaceholder = null;
    function wallpaperPlaceholderTex() {
      if (_wallpaperPlaceholder) return _wallpaperPlaceholder;
      const t = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
      if ('colorSpace' in t) t.colorSpace = THREE.SRGBColorSpace; // r152+
      else t.encoding = THREE.sRGBEncoding;
      t.needsUpdate = true;
      _wallpaperPlaceholder = t;
      return t;
    }
    // For dispose(): once every photo has loaded, the placeholder is on no
    // material, so the scene's material-texture sweep never reaches it.
    function disposeWallpaperPlaceholder() {
      if (_wallpaperPlaceholder) { _wallpaperPlaceholder.dispose(); _wallpaperPlaceholder = null; }
    }

    function buildFaceTexturedMaterials(faceAxis, url, plainMatFactory, lm, h, isOuter) {
      // Start as the ordinary wall paint. If the image loads it is applied on
      // top; if it does NOT (a profile referencing a texture that was not
      // shipped, a 404, a zero-byte placeholder) the wall simply stays painted.
      // Without this the face rendered as an unlit black panel, which looks like
      // a hole in the building rather than a missing decoration -- and a missing
      // texture is exactly what happens when a house profile is shared without
      // its images, so it has to degrade gracefully.
      // Built WITH a map from the start -- a 1x1 white placeholder, so it
      // still reads as plain paint (WALL_COLOR x white). A material that GAINS
      // a map later changes its shader program, and that new program was
      // compiled synchronously on the first frame after the image arrived:
      // the other half of the multi-second cold-start stall ("rAF handler
      // took 1038ms"), since the precompile had only ever seen the map-less
      // variant. With the placeholder, the precompile builds the mapped
      // program and swapping in the real photo is a texture bind, not a
      // compile.
      const wallpaperMat = new THREE.MeshStandardMaterial({
        color: WALL_COLOR,
        map: wallpaperPlaceholderTex(),
        roughness: 0.85, side: THREE.DoubleSide,
        transparent: !!isOuter, opacity: 1
      });
      loadTracked(wallTexLoader, url, (tex) => {
        if (!tex.image || !tex.image.width || !tex.image.height) {
          console.warn('[Home3DScene] wall texture "' + url + '" decoded to an empty image; ' +
            'leaving the wall painted.');
          return;
        }
        if ('colorSpace' in tex) tex.colorSpace = THREE.SRGBColorSpace; // r152+
        else tex.encoding = THREE.sRGBEncoding; // older three.js fallback
        tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
        // 1) object-fit:cover against the REAL visible rect (lm x WH, metres,
        //    not the padded box height h) — crop the excess dimension evenly so
        //    the photo is never stretched.
        const imgAspect = tex.image.width / tex.image.height;
        const boxAspect = lm / WH;
        let coverRX, coverOX, coverRY, coverOY;
        if (imgAspect >= boxAspect) {
          coverRX = boxAspect / imgAspect; coverOX = (1 - coverRX) / 2;
          coverRY = 1; coverOY = 0;
        } else {
          coverRX = 1; coverOX = 0;
          coverRY = imgAspect / boxAspect; coverOY = (1 - coverRY) / 2;
        }
        // 2) Re-target the cover-fit rect onto the box's ACTUAL V-range. Every
        //    wall box is padded below the floor so the wall never gaps at the
        //    seam; map the cover-fit V onto the visible sub-range [vFloor,1] so
        //    the photo isn't squeezed by the padding.
        const vFloor = (h - WH) / h; // box-space V where world Y=0 (floor) sits
        const rY = coverRY / (1 - vFloor);
        const oY = coverOY - rY * vFloor;
        tex.repeat.set(coverRX, rY);
        tex.offset.set(coverOX, oY);
        tex.needsUpdate = true;
        // The map multiplies the material colour, so drop the paint tint to
        // white or the photo would be shaded by it.
        wallpaperMat.color.setHex(0xffffff);
        wallpaperMat.map = tex;
        wallpaperMat.needsUpdate = true;
      }, undefined, () => {
        console.warn('[Home3DScene] wall texture "' + url + '" could not be loaded; ' +
          'leaving the wall painted.');
      });
      const plain = plainMatFactory();
      // BoxGeometry material groups, order [+x,-x,+y,-y,+z,-z].
      return faceAxis === 'px'
        ? [wallpaperMat, plain, plain, plain, plain, plain]
        : [plain, wallpaperMat, plain, plain, plain, plain];
    }

    // WALL FINISHES (wall.finishes, schemaVersion 1.3) -- brick, tile, ...
    // on ONE face of a wall, optionally over a height band and a span; see
    // src/wall-finish.js for the model and house-loader for how each face is
    // resolved. Every finished face of a wall, for one finish, is ONE merged
    // mesh (quads 1.5 mm proud of the painted boxes), so a finish costs one
    // draw per wall however many boxes the wall is split into, and the boxes
    // keep their single material. One texture and one material template per
    // finish LOOK (finishKey: the name, plus a tile's look) per scene, created
    // on first use so a house with no finishes allocates nothing; each wall's
    // mesh clones the template so it can fade on its own. The tint lives in
    // the map, so `color` stays white (the material.color x map multiply
    // trap, LEARNINGS #57). Every tier gets them: the canvases are 384 x 96
    // (brick) and 256 x 160 (the default tile; never over 512 a side) px,
    // below any mobile texture budget, and a brick house drawn plain on a
    // phone would be a different house rather than a cheaper one.
    const _finishTextures = {};
    const _finishTemplates = {};
    function finishMaterial(name, look, isOuter) {
      const fk = finishKey(name, look);
      if (!_finishTemplates[fk]) {
        const map = _finishTextures[fk] || (_finishTextures[fk] = makeFinishTexture(THREE, name, null, look));
        _finishTemplates[fk] = new THREE.MeshStandardMaterial({
          color: 0xffffff, roughness: FINISH_TYPES[name].roughness(look), map: map,
          // Seen from its own face only, and pulled toward the camera in
          // depth so it never z-fights the painted face 1.5 mm behind it.
          side: THREE.FrontSide,
          polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2
        });
      }
      const m = _finishTemplates[fk].clone();
      m.userData.finish = name;
      m.transparent = !!isOuter;
      m.opacity = 1;
      return m;
    }
    // wall id + finish key -> { batch, wallId, finish, look, outer }. Built into meshes
    // after the wall loop; they join the fade after the outward derivation.
    const finishBatches = new Map();
    const finishMeshes = [];   // { mesh, wallId }

    const wallMeshes = [];
    const wallEntryById = {};   // wall id -> its first wallMeshes entry (see addWallBox)
    // HEIGHTS REMODEL (2026-07-11, ACK'd) — wall vertical extents now depend
    // on the `outer` flag, and top at the CEILING UNDERSIDE (y=WH), not the
    // ceiling top:
    //   • INTERNAL walls (outer:0) span EXACTLY the room interior: y = 0 .. WH
    //     (from the floor's walkable TOP face to the ceiling's UNDERSIDE). They
    //     no longer poke into the floor slab below y=0 or the ceiling slab above
    //     WH. Height = WH, centred at WH/2.
    //   • EXTERNAL walls (outer:1, incl. pillars) span the full floor slab up
    //     to the ceiling underside: y = -slabThickness .. WH (start below,
    //     through the floor slab; STOP at the ceiling underside — NOT up
    //     through the ceiling).
    // (Previously ALL walls spanned the whole range, poking into both slabs.)
    // Doors sit at floor level (y=0) with OPEN_H well under WH, so internal
    // walls at height WH still frame every door + lintel comfortably.
    //
    // The external walls' base is the floor slab's UNDERSIDE, so it is read
    // from the same profile number the floor is extruded by. Hardcoding 0.15
    // here would open a seam at the base of every exterior wall the moment a
    // profile declared a thicker or thinner slab.
    const WALL_INT_BOTTOM_Y = 0;                          // internal: floor top
    const WALL_EXT_BOTTOM_Y = -HOUSE.slabs.thickness;     // external: floor bottom
    const WALL_TOP_Y = WH;                // BOTH cap at the ceiling underside
    WALL_EXT.forEach(({ id, x1, y1, x2, y2, outer, thickness, finishes }) => {
      // Per-wall vertical geometry, keyed off the outer flag (see block above).
      const WALL_BOTTOM_Y = outer ? WALL_EXT_BOTTOM_Y : WALL_INT_BOTTOM_Y;
      const WALL_YC = (WALL_TOP_Y + WALL_BOTTOM_Y) / 2;
      const WALL_FULL_H = WALL_TOP_Y - WALL_BOTTOM_Y;
      const wx1 = tx(x1), wz1 = tz(y1), wx2 = tx(x2), wz2 = tz(y2);
      const dx = wx2 - wx1, dz = wz2 - wz1;
      const len = Math.sqrt(dx*dx + dz*dz);
      if (len < 0.01) return;
      const angle = Math.atan2(dx, dz);
      const nx = Math.cos(angle), nz = -Math.sin(angle);
      // Per-wall thickness (m) — `thickness` (cm) always arrives set on
      // WALL_EXT entries (defaults to WT_CM there), so this is WT for every
      // wall except #3, which overrides it. Same units conversion WT itself
      // was defined with (WT_CM * S === WT).
      const wallWidthM = thickness * S;
      // Each finish's face slot, span (m from this wall's start) and height
      // range (world m), decided once per wall so every pier/cill/lintel box
      // of it agrees.
      // Each finish's batch, span (m from this wall's start) and height band
      // (world m), decided once per wall so every pier/cill/lintel box agrees.
      const frame = { wx1, wz1, ux: dx / len, uz: dz / len, T: wallWidthM };
      const wallFinishes = (finishes || []).map(f => {
        const key = id + '|' + finishKey(f.finish, f.look);
        if (!finishBatches.has(key)) {
          finishBatches.set(key, { batch: createFinishBatch(), wallId: id, finish: f.finish, look: f.look, outer: !!outer });
        }
        const range = [Math.max(WALL_BOTTOM_Y, f.from != null ? f.from * S : -Infinity),
                       Math.min(WALL_TOP_Y, f.to != null ? f.to * S : Infinity)];
        return {
          finish: f.finish, normal: f.normal, face: f.face, reveals: !!f.reveals,
          batch: finishBatches.get(key).batch,
          span: alongToMetres({ x1, y1, x2, y2 }, f.along, S),
          range: range,
          // The world height the tile grid starts at: 0 (the floor) unless
          // the entry anchors it at its own band's bottom (gridAnchor "from").
          vOrigin: gridOriginY(f.gridAnchor, range),
          // An END face: its wall distance, from the AUTHORED end point
          // projected onto this (corner-extended) centreline.
          endS: f.face === 'end' ? ((tx(f.at[0]) - wx1) * dx + (tz(f.at[1]) - wz1) * dz) / len : null
        };
      });
      // End faces belong to the wall, not to a box: one quad each.
      wallFinishes.forEach(wf => {
        if (wf.face !== 'end' || !(wf.range[1] - wf.range[0] > 0.005)) return;
        const facing = (wf.normal[0] * dx + wf.normal[1] * dz) >= 0 ? 1 : -1;
        addCrossFace(wf.batch, frame, wf.endS, facing, wf.range[0], wf.range[1], wf.vOrigin);
      });
      // One wall box centred at (mx,mz): length lm (m), vertical centre yc, height h.
      // Reuses the segment's rotation + normal so sub-boxes of a descending
      // segment don't flip their exterior-fade direction.
      const addWallBox = (mx, mz, lm, yc, h) => {
        if (lm < 0.01) return;
        // TRANSPARENCY BUG FIX (LEARNINGS #50): only OUTER walls (exterior shell +
        // the feature pillars #3/#12/#26/#31, outer:1) ever fade, so only they need
        // to live in the transparent render pass. INTERIOR partitions (outer:0) never
        // fade — making them transparent:true put them in the transparent pass with
        // unreliable depth-write, so a faded exterior wall in front of them made them
        // read as see-through (e.g. #25 from the SE corner). Keying transparent off
        // `outer` puts partitions in the normal OPAQUE pass → they stay solid behind
        // faded shell walls. Outer/pillar fade behaviour is unchanged.
        const plainMatFactory = () => new THREE.MeshStandardMaterial({
          color: WALL_COLOR, roughness: 0.82, roughnessMap: wallRoughMap,
          side: THREE.DoubleSide, transparent: !!outer, opacity: 1
        });
        // Face-textured walls (e.g. #25 home_office wallpaper mural) get a
        // 6-material array with the photo on one local face + plain on the rest;
        // every other wall keeps the single plain material. (zabine-wall25.)
        const faceTex = WALL_FACE_TEXTURES[id];
        const mat = faceTex
          ? buildFaceTexturedMaterials(faceTex.faceAxis, faceTex.url, plainMatFactory, lm, h, outer)
          : plainMatFactory();
        // This box's place on the wall -- metres from the wall's start, and
        // its world bottom/top -- and the finished quads it contributes to
        // its wall's finish mesh. The box already stops at any opening, so
        // the quads do too.
        const boxS0 = ((mx - wx1) * dx + (mz - wz1) * dz) / len - lm / 2;
        const boxSpan = [boxS0, boxS0 + lm], boxY = [yc - h / 2, yc + h / 2];
        wallFinishes.forEach(wf => {
          if (wf.face === 'end') return;
          const rect = finishRectOnBox(boxSpan, boxY, wf.span, wf.range);
          if (!rect) return;
          const r = rect.full ? { s0: boxSpan[0], s1: boxSpan[1], y0: boxY[0], y1: boxY[1] } : rect;
          addLongFace(wf.batch, frame, wf.normal, r.s0, r.s1, r.y0, r.y1, wf.vOrigin);
          // Reveals: the finish returns round a full-height box's ends -- the
          // jambs of the openings beside it and the wall's own ends.
          if (wf.reveals && revealEnds(h, WALL_FULL_H)) {
            if (r.s0 - boxSpan[0] < 1e-3) addCrossFace(wf.batch, frame, boxSpan[0], -1, r.y0, r.y1, wf.vOrigin);
            if (boxSpan[1] - r.s1 < 1e-3) addCrossFace(wf.batch, frame, boxSpan[1], 1, r.y0, r.y1, wf.vOrigin);
          }
        });
        const wall = new THREE.Mesh(new THREE.BoxGeometry(wallWidthM, h, lm), mat);
        wall.position.set(mx, yc, mz);
        wall.rotation.y = angle;
        wall.castShadow = true;
        wall.receiveShadow = true;
        scene.add(wall);
        const entry = { mesh: wall, nx, nz, outer: !!outer };
        wallMeshes.push(entry);
        // First registered box per wall id: windows and curtains on this wall
        // borrow its (derived-outward) normal so they fade in lockstep with it.
        if (!wallEntryById[id]) wallEntryById[id] = entry;
      };
      const horiz = Math.abs(y2 - y1) < 0.01, vert = Math.abs(x2 - x1) < 0.01;
      // Doors sitting on this segment
      const dts = DOORS.filter(d => {
        if (d.wall === 'x' && horiz && Math.abs(y1 - d.at) < 1.5) {
          const lo = Math.min(x1, x2), hi = Math.max(x1, x2);
          return d.c > lo - 1 && d.c < hi + 1;
        }
        if (d.wall === 'z' && vert && Math.abs(x1 - d.at) < 1.5) {
          const lo = Math.min(y1, y2), hi = Math.max(y1, y2);
          return d.c > lo - 1 && d.c < hi + 1;
        }
        return false;
      });
      // Windows cut through this segment -- as its host wall or as another
      // leaf of the same cavity wall. Matched by wall ID, not by coordinate:
      // the profile names the walls explicitly (see house-loader compileWindow).
      const wts = WINDOWS.filter(wn => (horiz || vert) &&
        (String(wn.wallId) === String(id) || wn.throughWallIds.some(t => String(t) === String(id))));
      if (dts.length === 0 && wts.length === 0) {
        addWallBox((wx1+wx2)/2, (wz1+wz2)/2, len, WALL_YC, WALL_FULL_H);
        return;
      }
      // Carve openings along the wall axis. a..b are cm coords along the axis.
      const boxAt = (a, b, yc, h) => {
        if (b - a < 1) return; // skip sub-centimetre slivers
        const mid = (a + b) / 2;
        addWallBox(horiz ? tx(mid) : wx1, horiz ? wz1 : tz(mid), (b - a) * S, yc, h);
      };
      const p1 = horiz ? x1 : y1, p2 = horiz ? x2 : y2;
      const lo = Math.min(p1, p2), hi = Math.max(p1, p2);
      // Each opening: a..b along the wall axis (cm), and the vertical hole
      // bot..top (m). A door's hole runs down to the wall's own base (nothing
      // below it); a window's hole leaves wall below the cill as well as the
      // lintel above.
      const ops = dts.map(d => {
        const cw = d.w + 2 * REVEAL_CM;
        return { a: d.c - cw / 2, b: d.c + cw / 2, bot: WALL_BOTTOM_Y, top: OPEN_H };
      }).concat(wts.map(wn => {
        const v = windowVerticals(wn);
        const cw = wn.w + 2 * WINDOW_REVEAL_CM;
        return { a: wn.c - cw / 2, b: wn.c + cw / 2, bot: v.holeBot, top: v.holeTop };
      })).sort((u, v) => u.a - v.a);
      let cur = lo;
      ops.forEach(o => {
        boxAt(cur, Math.min(Math.max(o.a, lo), hi), WALL_YC, WALL_FULL_H);
        cur = Math.max(cur, Math.min(o.b, hi));
      });
      boxAt(cur, hi, WALL_YC, WALL_FULL_H);
      // Lintel above each opening (wall remains from the hole's top up to the
      // wall top, WALL_TOP_Y = WH = the ceiling underside, so the lintel caps
      // the opening up to the ceiling — no longer through the ceiling slab),
      // and for a window the wall below its cill.
      ops.forEach(o => {
        const a = Math.max(o.a, lo), b = Math.min(o.b, hi);
        if (WALL_TOP_Y - o.top > 0.005) boxAt(a, b, (o.top + WALL_TOP_Y) / 2, WALL_TOP_Y - o.top);
        if (o.bot - WALL_BOTTOM_Y > 0.005) boxAt(a, b, (WALL_BOTTOM_Y + o.bot) / 2, o.bot - WALL_BOTTOM_Y);
      });
    });

    // One mesh per wall per finish (see WALL FINISHES above): a single draw,
    // no shadow cast (the painted box behind it already casts that shadow).
    finishBatches.forEach(({ batch, wallId, finish, look, outer }) => {
      const geo = buildFinishGeometry(THREE, batch);
      if (!geo) return;
      const mesh = new THREE.Mesh(geo, finishMaterial(finish, look, outer));
      mesh.receiveShadow = true;
      mesh.castShadow = false;
      mesh.name = 'wall-finish:' + wallId + ':' + finish;
      mesh.userData.wallFinish = { wall: wallId, finish: finish };
      scene.add(mesh);
      finishMeshes.push({ mesh, wallId });
    });

    // ---- Hallway wallpaper overlay — wall #22, hallway segment ONLY ----
    // a real photographed monstera wallpaper (photowall.co.uk product shot)
    // on wall #22's HALLWAY-facing (west) surface. Ported from the experimental
    // scene (bunmi-wall22, 2026-07-11). Unlike wall #25's 6-material-array trick
    // (buildFaceTexturedMaterials), #22 already has 2 doors carved into it
    // (Bathroom c=145.0, En-suite c=389.7, both wall:'z' at:1068.9) — touching
    // #22's own box/material construction would risk those openings — so this is
    // a SEPARATE thin flush-mounted overlay mesh on the hallway face only, the
    // same technique the acoustic panels use. Zero collision risk with the
    // door-carving loop above.
    //
    // #22 SPLIT QUESTION — ANSWERED (scout-textures): NO split. The experimental
    // 3-segment version (ids 22/48/49) was a wall-thickness-remap artifact, not a
    // wallpaper requirement. LIVE R4 #22 is ONE uniform vertical wall
    // {x=1068.9, y 91.2..455.4, thk 10}, so this is a single run.
    //
    // Clip to the HALLWAY portion only: hallway borders #22 for y 95.6..293.6
    // (ROOMS.hallway.poly east edge: [1059.4,95.6],[1059.4,293.6]). South of
    // ~293.6 the west side faces home_office (not hallway), so the wallpaper
    // stops there. Only the Bathroom door (c=145.0) falls inside this range; the
    // overlay skips its opening and keeps the lintel above it. (En-suite door
    // c=389.7 is outside the clip and never sees wallpaper.)
    //
    // outer:0 (interior partition) → these overlays never fade, so they are NOT
    // pushed into wallMeshes (no exterior-fade wiring). Gated on quality.tier
    // like every other procedural/photo texture — 'low' tier stays plain wall.
    // Runs for EVERY wall whose profile entry asks for a texture clipped to one
    // room (`faceTexture.clipToRoom`). A long wall often runs past several rooms
    // while the paper covers only one of them; without the clip the image
    // stretches across the whole run. Which wall, which room and which image are
    // all profile data — this used to be hardcoded for one wall and one room.
    Object.keys(HOUSE.wallFaceTextures).forEach(_wid => {
      const _overlaySpec = HOUSE.wallFaceTextures[_wid];
      if (!_overlaySpec.clipToRoom) return;
      const _clipRoom = ROOMS[_overlaySpec.clipToRoom];
      if (!_clipRoom) return;
      // Only north-south walls take this path today (the clip is expressed as a
      // y-range along the wall). An east-west wall keeps the whole-face texture
      // built in the wall loop above.
      const wall22 = WALL_EXT.find(w => String(w.id) === String(_wid) && Math.abs(w.x1 - w.x2) < 0.5);
      if (wall22 && quality.tier !== 'low') {
        const panelThicknessM = 0.006; // thin flush overlay, nudged outward to avoid z-fighting with the wall's own face
        const overlayTexUrl = _overlaySpec.url;
        // The clipped room's extent along the wall, from the room's DERIVED
        // bounding box — authoritative, and not the wall's full span, which
        // continues past the room into its neighbours.
        // Clip to the stretch of wall the room ACTUALLY fronts, taken from the
        // room polygon — not from its bounding box. An L-shaped room's bbox
        // spans far more of the wall than the room's own edge does: the hallway
        // bbox runs y 13.2..293.6, while the polygon edge that fronts wall #22
        // runs only y 95.6..293.6. Using the bbox papered ~0.9 m of wall that
        // fronts a different room entirely, and stretched the mural to fit it.
        //
        // A wall the room fronts ENTIRELY was already papered by the material
        // array in the wall loop above, which is the better path for a full
        // face; papering it again here would double the image up.
        if (_roomCoversWholeFace(wall22, _overlaySpec.clipToRoom)) return;
        const _span = _roomEdgeSpanOnWall(wall22, _overlaySpec.clipToRoom);
        const northY = _span ? _span[0] : _clipRoom.y1;
        const southY = _span ? _span[1] : _clipRoom.y2;
        // The overlay panels are unrotated boxes (thickness along world X,
        // length along world Z), so only two things depend on the profile's
        // `side`: which world-X face they sit proud of, and which way along Z
        // the image runs so it reads correctly from that side. Both come from
        // src/wallpaper-face.js -- this used to hardcode the WEST face whatever
        // `side` said.
        const wallThicknessM = (wall22.thickness != null ? wall22.thickness : WT_CM) * S;
        const _face = overlayFace(wall22, _overlaySpec.side, tx, tz, wallThicknessM, panelThicknessM);
        if (!_face) {
          console.warn('[Home3DScene] wall ' + _wid + ' asks for a texture on its "' + _overlaySpec.side +
            '" face, but that is an END of the wall, not one of its two long faces — ignored.');
          return;
        }
        const overlayX = _face.overlayX;                     // just proud of the papered face
        const overlayPanels = []; // {tex} collected for deferred image attach
        // STRETCH-TO-FIT, ONE COPY, NO TILING. the monstera is a single mural
        // image, not a repeating pattern — so the wallpaper maps as ONE continuous
        // image STRETCHED across the ENTIRE hallway portion of #22's face (the
        // full image UV 0..1 spans the whole hallway rect: Z northY..southY, Y
        // floor..ceiling). The Bathroom door splits that face into >1 mesh, so
        // each panel samples its OWN sub-window of the single stretched image
        // (continuous UVs) — the leaves line up across the door/lintel seam and
        // there is exactly ONE monstera on the wall, never a per-panel full copy
        // and never a repeated tile grid. ClampToEdgeWrapping (never wrap/tile);
        // a per-panel repeat<1 samples a CROP-slice of the one image, it does not
        // repeat it. Full-face reference rect:
        const faceZ0 = tz(northY), faceZ1 = tz(southY);   // world-Z extent of the hallway face
        const faceLen = Math.abs(faceZ1 - faceZ0);         // total run length (m)
        const faceZMin = Math.min(faceZ0, faceZ1);         // near (min-Z) edge of the face
        const faceZMax = Math.max(faceZ0, faceZ1);         // far (max-Z) edge of the face
        const faceY0 = 0, faceY1 = WH;                     // floor .. ceiling underside
        const faceH = faceY1 - faceY0;
        // Build one overlay panel covering [a,b] (cm along Z) at vertical centre
        // yc / height h (m). Its UV window is its own position WITHIN the full
        // face rect → one stretched image; the panel just samples its slice.
        const addOverlayPanel = (a, b, yc, h) => {
          const lm = (b - a) * S;
          if (lm < 0.01 || h < 0.01) return;
          const zc = tz((a + b) / 2);                       // panel centre in world Z
          const tex = new THREE.Texture();
          tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping; // never tile
          // U spans this panel's Z-slice of the whole face; V its Y-slice.
          const uRepeat = lm / faceLen;
          const uOffset = overlayUOffset(_face, zc - lm / 2, zc + lm / 2, faceZMin, faceZMax);
          const yBottom = yc - h / 2;
          const vRepeat = h / faceH;
          const vOffset = (yBottom - faceY0) / faceH;        // V=0 at floor
          tex.repeat.set(uRepeat, vRepeat);
          tex.offset.set(uOffset, vOffset);
          const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.88 });
          const mesh = new THREE.Mesh(new THREE.BoxGeometry(panelThicknessM, h, lm), mat);
          mesh.position.set(overlayX, yc, zc);
          mesh.receiveShadow = true;
          // HIDDEN UNTIL THE IMAGE ARRIVES. tex is an empty THREE.Texture until
          // the loader fills it in, and an empty map samples black -- so a
          // profile whose texture is missing or 404s would paste a black panel
          // over the wall, which reads as a hole in the building. The panel is
          // only shown once a real image is in hand; otherwise the wall behind
          // it simply stays as it is.
          mesh.visible = false;
          scene.add(mesh);
          overlayPanels.push({ tex, mesh });
        };
        // Mirror the main door-carving loop's solid/opening split for whichever
        // doors on this wall fall inside the hallway clip — found live (not
        // assumed to be "just the Bathroom door") so a future door move reflows.
        // The wallpaper skips each door opening but DOES continue over the lintel
        // above it (solid wall there). Matched against wall22.x1.
        const doorOps = DOORS.filter(d => d.wall === 'z' && Math.abs(d.at - wall22.x1) < 1.5 &&
            d.c > northY && d.c < southY)
          .map(d => ({ a: d.c - (d.w + 2 * REVEAL_CM) / 2, b: d.c + (d.w + 2 * REVEAL_CM) / 2 }))
          .sort((u, v) => u.a - v.a);
        let cur = northY;
        doorOps.forEach(op => {
          const a = Math.max(op.a, northY), b = Math.min(op.b, southY);
          addOverlayPanel(cur, a, WH / 2, WH);                        // solid, floor-to-ceiling up to the opening
          addOverlayPanel(a, b, (OPEN_H + WH) / 2, WH - OPEN_H);      // lintel above the opening only
          cur = Math.max(cur, b);
        });
        addOverlayPanel(cur, southY, WH / 2, WH);                     // solid run south of the last opening
        // Load the shared photo once; hand its decoded image to every panel.
        // Each panel's UV window (repeat/offset) was already set at build time
        // from its slice of the full face, so here we only attach the image —
        // one stretched monstera across the whole hallway face, no tiling.
        // (Panels are built synchronously above, so this async callback always
        // sees the full set — same pattern as wall #25's wallpaper.)
        if (overlayPanels.length) {
          loadTracked(new THREE.TextureLoader(),
            overlayTexUrl,
            (loaded) => {
              const img = loaded.image;
              if (!img || !img.width || !img.height) {
                console.warn('[Home3DScene] wall overlay texture "' + overlayTexUrl +
                  '" decoded to an empty image; leaving the wall as it is.');
                return;
              }
              overlayPanels.forEach(p => {
                p.tex.image = img;
                if ('colorSpace' in p.tex) p.tex.colorSpace = THREE.SRGBColorSpace; // r152+
                else p.tex.encoding = THREE.sRGBEncoding; // older three.js fallback
                p.tex.needsUpdate = true;
                p.mesh.visible = true;
              });
            },
            undefined,
            () => console.warn('[Home3DScene] wall overlay texture "' + overlayTexUrl +
              '" could not be loaded; leaving the wall as it is.')
          );
        }
      }
    });

    // === Door assemblies (frame + swinging slab + handles, per DoorSpec) ===
    // One Group per door pivoted at the hinge edge; slab + grooves + mirrored
    // handles + frame as children. The pivot rotates on Y by a fixed-sign,
    // clamped-non-negative angle — one-direction swing only. Max angles are
    // collision-solved (computeDoorAngles) so no two fully-open leaves ever
    // intersect; the rendered rest pose is DOOR_REST of each door's solved max.
    // doorByRoom: ROOMS key → live door record, driving the panel's per-room
    // openness slider via the getDoorOpen/setDoorOpen API below.
    //
    // doorById: DOOR id → the SAME record object, for the HA door-sensor
    // binding. Two indexes over one set of records rather than two sets, so a
    // door driven by its sensor and the same door dragged on the panel slider
    // read and write one `openPct` and cannot disagree.
    //
    // Why a second index is needed at all: doorByRoom is keyed by ROOM, so a
    // room with two doors keeps only the last one and a door with no `room`
    // is unreachable entirely. A sensor binds to a specific door, so it needs
    // the door's own id. The room-keyed index and its slider are untouched.
    const doorByRoom = {};
    const doorById = {};
    {
      // Same paint as the walls (DOOR_SLAB_COLOR/frameMat both derive from
      // WALL_COLOR) — differentiation from the wall's matte-plaster finish is
      // via roughness only (wood-grain-under-paint reads a touch smoother/less
      // matte than plasterboard), not a second texture, to keep this cheap.
      const slabMat = new THREE.MeshStandardMaterial({ color: DOOR_SLAB_COLOR, roughness: 0.6 });
      const frameMat = new THREE.MeshStandardMaterial({ color: WALL_COLOR, roughness: 0.5 });
      const chromeMat = new THREE.MeshStandardMaterial({ color: 0xCFD6DA, roughness: 0.25, metalness: 0.85 });
      const grooveMat = new THREE.MeshStandardMaterial({ color: 0xCBC3B4, roughness: 0.8 });
      // Front-door-only leaf material + seam colour (frame stays frameMat —
      // only the swinging slab changes). Same MeshStandardMaterial, zero new
      // draw calls or textures — reuses the existing groove-box technique
      // below with a different count/colour, not a new rendering path.
      const frontDoorSlabMat = new THREE.MeshStandardMaterial({ color: FRONT_DOOR_COLOR, roughness: 0.65 });
      const frontDoorGrooveMat = new THREE.MeshStandardMaterial({ color: FRONT_DOOR_GROOVE_COLOR, roughness: 0.9 });
      const V = THREE.Vector3;
      const doorLeafMatCache = {};
      const doorAngles = computeDoorAngles(DOORS); // collision-aware max open angles (deg)
      DOORS.forEach((d, di) => {
        // A front door gets an exterior finish (a darker leaf, an extra groove).
        // Keyed off the profile's `kind`, NOT off the door's display label --
        // matching the English string "Front door" meant a house whose door was
        // labelled anything else, in any other language, silently rendered as an
        // internal door. `kind` is the schema's field for exactly this.
        const isFrontDoor = d.kind === "front";
        const w = d.w * S, H = DOOR_H, T = DOOR_T;
        // opening centre in world (on the wall line, at floor level)
        const oc = d.wall === 'x' ? new V(tx(d.c), 0, tz(d.at)) : new V(tx(d.at), 0, tz(d.c));
        // along = unit vector hinge->latch; normal = unit vector into the room the door opens into
        let along, normal;
        if (d.wall === 'x') {
          along = new V(d.hinge === 'w' ? 1 : -1, 0, 0);
          normal = new V(0, 0, d.swing === 's' ? 1 : -1);
        } else {
          along = new V(0, 0, d.hinge === 'n' ? 1 : -1);
          normal = new V(d.swing === 'e' ? 1 : -1, 0, 0);
        }
        const hingeWorld = oc.clone().addScaledVector(along, -w / 2);
        // mount: rotate about Y so local +X points along `along`
        const theta = Math.atan2(-along.z, along.x);
        const mount = new THREE.Group();
        mount.position.copy(hingeWorld);
        mount.rotation.y = theta;
        scene.add(mount);
        // static frame: jambs + head (mount-local: x 0..w, y up, z across wall thickness).
        // Jamb width = REVEAL_CM so the frame fully plugs the carved reveal gap.
        const fj = REVEAL_CM * S, fdep = WT * 1.4, fh = 0.06;
        const jamb = lx => {
          const m = new THREE.Mesh(new THREE.BoxGeometry(fj, H + fh, fdep), frameMat);
          m.position.set(lx, (H + fh) / 2, 0);
          m.castShadow = true;
          // Receives too: an unshadowed frame is lit by the sun straight
          // through the building whenever it faces the sun, which a sun that
          // moves round the house now does (a glowing door outline).
          m.receiveShadow = true;
          mount.add(m);
        };
        jamb(-fj / 2);
        jamb(w + fj / 2);
        const head = new THREE.Mesh(new THREE.BoxGeometry(w + 2 * fj, fh, fdep), frameMat);
        head.position.set(w / 2, H + fh / 2, 0);
        head.castShadow = true;
        head.receiveShadow = true;
        mount.add(head);
        // swinging leaf: pivot at the hinge (local origin); leaf extends +X to the latch edge
        const pivot = new THREE.Group();
        mount.add(pivot);
        const maxDeg = Math.max(0, doorAngles[di] ?? d.ang ?? 90);
        // REST POSE — closed unless something actually knows better (2026-09-14).
        // Precedence, highest first:
        //   1. An explicit per-door `restOpenFraction` in the profile. An author
        //      saying "this door sits open" is a deliberate statement about a
        //      real door (a permanently-propped archway), so it wins outright,
        //      sensor or no sensor.
        //   2. A door with a contact sensor bound to it: rest at the house
        //      default. Its state is KNOWN and the first reading will drive it
        //      explicitly anyway, so this is only the pose before HA answers.
        //   3. Everything else: CLOSED. Nothing reports on this door, so the
        //      house cannot claim it is open. Standing every sensorless door
        //      20% ajar is what made a panel read "Open: 20%" for doors with no
        //      sensor at all.
        // `d.rest` is ALWAYS populated (loader falls back to the house default),
        // so `restExplicit` is what distinguishes an authored pose from an
        // inherited one -- an authored 0.2 and an inherited 0.2 are both 0.2.
        const restFraction = d.restExplicit ? d.rest
          : (d.id && DOOR_SENSOR_BOUND_IDS.has(d.id) ? d.rest : 0);
        const restRad = maxDeg * restFraction * Math.PI / 180;
        // local +Z maps to this world dir; fixed sign so the leaf only ever swings toward `normal`
        const locZ = new V(Math.sin(theta), 0, Math.cos(theta));
        const swingSign = locZ.dot(normal) > 0 ? -1 : 1;
        pivot.rotation.y = swingSign * restRad;
        // doorProfileId: the schema's doors[].id -- what rooms.json binds a
        // sensor to (doorId above is the DISPLAY label). Read by the
        // tap-popover picker (src/tap-popovers.js).
        mount.userData = { doorId: d.name, doorProfileId: d.id || null, maxAngleDeg: maxDeg, swingSign };
        // openPct must agree with the pose actually rendered above, or the
        // panel's "Open: N%" readout contradicts the door on screen.
        const doorRec = { id: d.id, name: d.name, pivot, maxDeg, swingSign, openPct: restFraction * 100 };
        if (d.room) doorByRoom[d.room] = doorRec;
        // Same record, keyed by the door's own id. Unconditional: a door
        // without a `room` still has an id and is still bindable to a sensor.
        //
        // ⚠️ `d.id` and NOT `d.name`: the loader compiles `name` as
        // `door.label || door.id`, so `name` is the DISPLAY label ("Store
        // cupboard") and only coincides with the id for a door that has no
        // label. rooms.json binds sensors by the schema's `doors[].id`, so
        // keying this index on anything else would silently fail to match for
        // every labelled door — which is all of them in the demo house.
        if (d.id) doorById[d.id] = doorRec;
        // A door may name its own leaf colour in the profile; otherwise a front
        // door gets the exterior finish and everything else the house's default
        // internal slab colour. Per-door materials are cached so a house with
        // many same-coloured doors still shares one material.
        let leafMat;
        if (d.color) {
          const key = String(d.color).toLowerCase();
          if (!doorLeafMatCache[key]) {
            doorLeafMatCache[key] = new THREE.MeshStandardMaterial({
              color: new THREE.Color(d.color), roughness: 0.65
            });
          }
          leafMat = doorLeafMatCache[key];
        } else {
          leafMat = isFrontDoor ? frontDoorSlabMat : slabMat;
        }
        const slab = new THREE.Mesh(new THREE.BoxGeometry(w, H, T), leafMat);
        slab.position.set(w / 2, H / 2, 0);
        slab.castShadow = true;
        slab.receiveShadow = true;
        pivot.add(slab);
        // subtle panel grooves on both faces — front door gets 5 horizontal
        // bands with a dark recessed seam (wood-plank look off the reference
        // photo); every other door keeps the original 4-band light groove.
        const NG = isFrontDoor ? 5 : 4, secH = H / NG;
        const gMat = isFrontDoor ? frontDoorGrooveMat : grooveMat;
        for (let i = 1; i < NG; i++) for (const sgn of [1, -1]) {
          const g = new THREE.Mesh(new THREE.BoxGeometry(Math.max(w - 0.1, 0.05), 0.02, 0.006), gMat);
          g.position.set(w / 2, secH * i, sgn * (T / 2));
          pivot.add(g);
        }
        // lever handle near the latch edge, mirrored on both faces
        const hx = w - 0.06, hy = H * 0.45;
        [1, -1].forEach(zs => {
          const hg = new THREE.Group();
          const ros = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.01, 16), chromeMat);
          ros.rotation.x = Math.PI / 2;
          ros.position.set(0, 0, zs * (T / 2 + 0.005));
          hg.add(ros);
          const lev = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.02, 0.02), chromeMat);
          lev.position.set(-0.04, 0, zs * (T / 2 + 0.03));
          hg.add(lev);
          hg.position.set(hx, hy, 0);
          pivot.add(hg);
        });
      });
    }

    // === Windows + curtains (per WindowSpec / BalconyWindowSpec / CurtainSpec) ===
    // The wall loop above has already carved each window's opening (through
    // its host wall and any `throughWalls` leaves). Each assembly is built in
    // its own wall-local frame (wall-fittings.js) and placed on the wall: a
    // window at the host wall's OUTER face, a curtain at its ROOM face.
    //
    // FADE: on an exterior wall the opaque parts must fade with the wall, or
    // looking into a room from outside would show a frame and a pair of
    // curtains floating where the wall was. They are registered into
    // wallMeshes AFTER deriveOutwardNormals below, borrowing the host wall's
    // own (by then corrected) normal, so they cross the fade threshold in
    // lockstep with it. Glass and sheers are already translucent and stay out
    // of the fade -- it would drive them to opacity 1.
    const fittingFades = [];   // { mesh, wallId }
    WINDOWS.forEach(wn => {
      const built = buildWindow(THREE, wn, wn.exterior);
      placeOnWall(built.group, wn, wn.outerFace, tx, tz);
      scene.add(built.group);
      if (wn.exterior) built.fadeMeshes.forEach(mesh => fittingFades.push({ mesh, wallId: wn.wallId }));
    });
    // curtainById: id -> { cu, built, glows, cornice } -- the handles the
    // Home Assistant cover / cornice-light bindings drive at runtime.
    const curtainById = {};
    CURTAINS.forEach(cu => {
      const built = buildCurtain(THREE, cu, cu.exterior);
      placeOnWall(built.group, cu, cu.roomFace, tx, tz);
      scene.add(built.group);
      if (cu.exterior) built.fadeMeshes.forEach(mesh => fittingFades.push({ mesh, wallId: cu.wallId }));
      const entry = { cu, built, glows: [], cornice: null };
      curtainById[cu.id] = entry;
    });
    // A cornice's LED strip throws light as well as glowing: a row of
    // unshadowed downlights (3 on a narrow cornice, 5 on a wide one), aimed
    // out of the box's open bottom so none of them can light the cornice's
    // own faces -- see corniceSpotLayout. Same tier gate as the ambient
    // strips (it is the same kind of light, and it replaces the 'curtain
    // cornice' strip a profile would otherwise list under its room's ambient
    // channel -- see docs/house-profile.md).
    //
    // Budget: a SpotLight is 7 fragment-uniform vectors (a PointLight 4).
    // On the reference house (3 + 3 + 5 = 11 lights) the ultra shader
    // measured ~384 of 1024; the mid tier drops the 10 shadowed room lights,
    // estimated ~265 of 512. quality.corniceLightCap bounds the TOTAL so a
    // house with many cornices cannot push mid over: corniceLightBudget
    // takes lights off the fullest cornices first. Low: none (strip glows).
    //
    // They do NOT join the exterior-wall fade. The fade makes occluding
    // geometry see-through (the cornice box and its strip are geometry, so
    // they fade); a light is not geometry, and like every other room light
    // it keeps lighting the room you are looking into.
    if (quality.ambientStrips) {
      const lit = Object.values(curtainById).filter(e => e.built.corniceStrip);
      const want = lit.map(e => corniceLightCount(e.built.corniceStrip.userData.cornice.width * 100));
      // Below ultra each cornice is at most quality.cornicePerCornice lights
      // (task cd6d5d05: a cornice is ONE light channel, driven by one HA
      // entity), spread along it by corniceSpotLayout; each carries the
      // share of the wanted count it stands for (userData.gain), so the
      // cornice throws the same total light. Ultra keeps 3/5 when the
      // budget allows.
      const perCornice = quality.cornicePerCornice;
      const capped = want.map(n => (perCornice ? Math.min(n, perCornice) : n));
      const counts = corniceLightBudget(capped, quality.corniceLightCap);
      lit.forEach((entry, i) => {
        if (!counts[i]) return;
        const built = entry.built;
        const layout = corniceSpotLayout(built.corniceStrip.userData.cornice, counts[i]);
        layout.spots.forEach(sp => {
          const gain = want[i] / counts[i];
          const glow = new THREE.SpotLight(built.corniceStrip.userData.restColor,
            CORNICE_GLOW_INTENSITY * gain, layout.range, layout.angle, 1, 2);
          glow.name = 'corniceGlow';
          glow.userData.gain = gain;
          glow.position.set(sp.x, sp.y, sp.z);
          glow.target.position.set(sp.tx, sp.ty, sp.tz);
          built.group.add(glow);
          built.group.add(glow.target);
          entry.glows.push(glow);
        });
      });
    }

    // === Daylight through the windows ===
    // The global sun + sky fill light the house as a whole; this is the part
    // that comes in THROUGH A WINDOW, so it is what a curtain can shut out.
    // Cheap by design, per the uniform budget the quality tiers protect:
    //   * every tier: one unlit floor mesh per window (MeshBasicMaterial -- no
    //     light uniforms at all). When the sun is on this window's side of the
    //     house it is the SUN POOL: the window opening projected along the
    //     real sun ray onto the floor (windowSunPool in sun-position.js), so a
    //     window-shaped patch that moves and stretches through the day. When
    //     the sun is round the other side it is a faint SKY POOL in the old
    //     soft shape. Blended multiply-add (dst * (1 + src)), so it brightens
    //     the floor's own colour instead of greying it;
    //   * mid/ultra only: ONE unshadowed SpotLight per room that has windows,
    //     shared by all of them, aimed into the room (re-aimed by
    //     updateDaylight() toward the windows actually letting light in).
    // Geometry is rebuilt by updateDaylightPools() (sun moved) and colours by
    // updateDaylight() (sun or a curtain moved); built dark.
    const daylight = { windows: [], rooms: {} };
    if (WINDOWS.length) {
      const patchTex = makeDaylightPatchTexture();
      // Every rug is a plane at y = 0.01; the pool sits just above so it
      // lights a rug too rather than vanishing at its edge.
      const POOL_Y = 0.012;
      WINDOWS.forEach(wn => {
        const curtains = CURTAINS.filter(cu =>
          String(cu.wallId) === String(wn.wallId) && cu.room === wn.room);
        const roomFace = wn.outerFace + wn.inDir * wn.hostThickness;   // plan cm
        const v = windowVerticals(wn);
        // Sky-pool reach into the room: a tall window throws light further.
        // Clamped to the room's own depth so it never crosses the far wall.
        const room = ROOMS[wn.room];
        const roomDepth = room
          ? (wn.axis === 'x' ? Math.abs(room.y2 - room.y1) : Math.abs(room.x2 - room.x1))
          : 300;
        const reach = Math.min(roomDepth * 0.9, 80 + (v.openTop - v.openBot) * 100 * 0.9);  // cm
        const half = wn.w / 2;
        const toWorld = ([along, across]) => wn.axis === 'x'
          ? [tx(along), tz(across)] : [tx(across), tz(along)];
        // The opening on each face of the wall, world [x, y, z], in order
        // round the rectangle -- what windowSunPool() projects.
        const faceRect = across => {
          const a = toWorld([wn.c - half, across]), b = toWorld([wn.c + half, across]);
          return [[a[0], v.openBot, a[1]], [b[0], v.openBot, b[1]],
            [b[0], v.openTop, b[1]], [a[0], v.openTop, a[1]]];
        };
        // Capacity: per curtain opening, a sky-pool slice (2 triangles) and a
        // sun-pool piece clipped by an L-shaped room (well under 16
        // vertices). Two curtain layers split a window into at most ~5 runs,
        // so 240 triangle corners is ample and fixed: updating it is a
        // sub-range upload, never a reallocation. Per-vertex colour carries
        // sun vs sky light AND each piece's curtain transmission, so all of it
        // is ONE mesh and one draw call per window.
        const MAX_CORNERS = 240;
        const pos = new Float32Array(MAX_CORNERS * 3);
        const uv = new Float32Array(MAX_CORNERS * 2);
        const col = new Float32Array(MAX_CORNERS * 3);
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
        geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2).setUsage(THREE.DynamicDrawUsage));
        geo.setAttribute('color', new THREE.BufferAttribute(col, 3).setUsage(THREE.DynamicDrawUsage));
        geo.setDrawRange(0, 0);
        const mat = new THREE.MeshBasicMaterial({
          // Vertex colour = sun or sky light x gain x the curtain
          // transmission and tint of that piece (updateDaylightPools).
          map: patchTex, color: 0xffffff, vertexColors: true, transparent: true,
          // out = src * dst + dst: the floor's own colour, brightened.
          blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
          blendSrc: THREE.DstColorFactor, blendDst: THREE.OneFactor,
          depthWrite: false, toneMapped: false,
          side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2
        });
        const patch = new THREE.Mesh(geo, mat);
        patch.name = 'daylightPatch:' + wn.id;
        patch.castShadow = false; patch.receiveShadow = false;
        patch.renderOrder = 2;
        patch.frustumCulled = false;   // the geometry moves; no stale bounds
        scene.add(patch);
        const inward = wn.axis === 'x' ? [0, wn.inDir] : [wn.inDir, 0];
        // A full-height rectangle on a curtain's hanging plane between two
        // along-wall positions (plan cm), world corners -- what a curtain gap
        // or fabric panel is, for windowLightPieces().
        const curtainRect = (lo, hi, across) => {
          const a = toWorld([lo, across]), b = toWorld([hi, across]);
          return [[a[0], 0, a[1]], [b[0], 0, b[1]], [b[0], WH, b[1]], [a[0], WH, a[1]]];
        };
        // Sky-pool slice for the window run [lo, hi] (plan cm): the soft
        // trapezoid cut at the same openings, with u kept across the WHOLE
        // window so its soft side edges stay at the window's edges.
        const skySlice = (lo, hi) => {
          const far = s => wn.c + (s - wn.c) * 1.25;
          const w = wn.w || 1;
          const u = s => (s - (wn.c - half)) / w;
          return {
            pts: [[lo, roomFace], [hi, roomFace],
              [far(lo), roomFace + wn.inDir * reach], [far(hi), roomFace + wn.inDir * reach]].map(toWorld),
            uv: [[u(lo), 0], [u(hi), 0], [u(lo), 1], [u(hi), 1]]
          };
        };
        // The brightest thing on this room's floor (floor colour, rug colour
        // or its pattern's palette) caps the pool gain: see poolGainForFloor.
        let floorAlbedo = room ? colourBrightness(room.floor) : 0.6;
        if (room && room.rug) {
          if (room.rug.pattern) {
            const cols = (room.rug.pattern.colors && room.rug.pattern.colors.length)
              ? room.rug.pattern.colors : RUG_PATTERN_DEFAULTS.colors;
            cols.forEach(c => { floorAlbedo = Math.max(floorAlbedo, colourBrightness(parseInt(String(c).replace('#', ''), 16))); });
          } else {
            floorAlbedo = Math.max(floorAlbedo, colourBrightness(room.rug.color));
          }
        }
        const entry = {
          win: wn, curtains, patch, mat, geo, transmit: 1, tint: [1, 1, 1],
          mode: 'none', poolY: POOL_Y, skySlice, curtainRect, span: [wn.c - half, wn.c + half],
          floorAlbedo, curtainKey: null,
          outer: faceRect(wn.outerFace), inner: faceRect(roomFace), inward,
          roomPoly: room && Array.isArray(room.poly) ? room.poly.map(p => [tx(p[0]), tz(p[1])]) : null
        };
        daylight.windows.push(entry);

        const r = daylight.rooms[wn.room] || (daylight.rooms[wn.room] = { windows: [], light: null });
        r.windows.push(entry);
        // Window centre on the room face, in world metres, and the inward
        // unit vector -- used per room to place the shared light.
        const [cxW, czW] = toWorld([wn.c, roomFace]);
        entry.faceWorld = [cxW, (v.openBot + v.openTop) / 2, czW];
        entry.inWorld = inward;
      });
      if (quality.tier !== 'low') {
        Object.keys(daylight.rooms).forEach(roomId => {
          const r = daylight.rooms[roomId];
          const spot = new THREE.SpotLight(0xffffff, 0, 7, 1.05, 0.9, 1.4);
          spot.name = 'daylight:' + roomId;
          spot.castShadow = false;
          scene.add(spot.target);   // a SpotLight target must be in the graph
          scene.add(spot);
          r.light = spot;
        });
      }
    }

    // ── The ONE house-wide FLOOR + the ONE CEILING ────────────────────────
    // Two concerns are decoupled here: (1) ONE visible floor and ONE ceiling,
    // each a real solid slab bounded by the walls; (2) per-room INVISIBLE
    // click-catcher meshes carry the roomId for "click room -> light controls"
    // (the visible floor is a single mesh, so it cannot carry per-room ids).
    // Rugs are separate objects sitting on top. Built once, up front, before
    // the room loop.
    //
    // BOTH OUTLINES COME FROM THE PROFILE (house-loader's slab section). They
    // are deliberately NOT the same outline: the FLOOR reaches the INNER
    // (room-facing) faces of the exterior walls, while the CEILING reaches
    // their OUTER faces and caps over them. External walls run from
    // y = -SLAB_THICK (through the floor) up to the ceiling underside;
    // internal walls run y = 0 .. WH.
    //
    // Each outline arrives as a LIST OF PIECES, because THREE.Shape describes
    // exactly one ring. A profile that authored its outlines gives one piece
    // per surface -- a single continuous ring, which is what a real floor is.
    // A profile that did not gives the derived union of its rooms and wall
    // footprints, several abutting pieces. ExtrudeGeometry takes an array of
    // shapes and emits ONE geometry either way, so this is a single mesh and a
    // single draw call in both cases and the code below never branches.
    const SLAB_PIECES = HOUSE.slabs.floor;
    const CEIL_PIECES = HOUSE.slabs.ceiling;
    const SLAB_THICK = HOUSE.slabs.thickness; // metres; profile authors cm
    // Build a THREE.Shape from a cm polygon using the same (tx, -tz) convention
    // the per-room floors used, so the -PI/2 X-rotation lands it correctly.
    const shapeFromPoly = poly => {
      const sh = new THREE.Shape();
      sh.moveTo(tx(poly[0][0]), -tz(poly[0][1]));
      for (let i = 1; i < poly.length; i++) sh.lineTo(tx(poly[i][0]), -tz(poly[i][1]));
      sh.closePath();
      return sh;
    };
    const slabShapes = SLAB_PIECES.map(shapeFromPoly);
    const ceilShapes = CEIL_PIECES.map(shapeFromPoly);

    // Whole-house floor material: Ashy Oak LVT (Floored.co.uk "LVT Ashy Oak") —
    // the home's real flooring. Weathered grey-toned oak, 18.5cm x 121.5cm planks, long
    // axis N-S, semi-random stagger. Procedurally baked (no external image file).
    //
    // We bake the ENTIRE floor into one canvas and map it so ONE canvas copy covers
    // the whole slab — the plank stagger is then genuinely non-repeating across the
    // floor (no tiling seam gives the pattern away).
    //
    // ⚠️ UV — DO NOT TRUST ExtrudeGeometry's built-in UVs. Its WorldUVGenerator
    // emits uvs from the shape coords for the caps BUT also emits SIDE-WALL uvs for
    // the 15cm extrude depth, so the geometry's actual emitted uv range is NOT the
    // slab's position bbox (measured live: ~17.183 x 8.358, not 9.782 x 7.386).
    // Keying repeat/offset off the position bbox therefore shrinks every plank
    // (gibbs-r4b, LEARNINGS #54). FIX (robust): OVERWRITE the floor geometry's uv
    // attribute with our OWN planar UVs derived straight from each vertex's world
    // position (u = worldX metres, v = worldZ metres). Then the uv range is EXACTLY
    // the slab's world extent by construction, independent of ExtrudeGeometry's
    // quirk, and repeat = 1/extent + offset = -min/extent makes ONE canvas cover
    // the slab with planks at the true 18.5 x 121.5 cm. Only the top face is ever
    // visible (bottom is underground, sides hidden in the walls), so cap/side uvs
    // sharing this planar mapping is harmless.
    const _sxAll = [], _syAll = [];
    SLAB_PIECES.forEach(poly => poly.forEach(pt => { _sxAll.push(pt[0]); _syAll.push(pt[1]); }));
    const _sx = _sxAll, _sy = _syAll;
    const slabMinXW = tx(Math.min(..._sx)), slabMaxXW = tx(Math.max(..._sx)); // E-W world (u)
    const _yA = -tz(Math.min(..._sy)), _yB = -tz(Math.max(..._sy));           // shape-Y = -tz(y)
    const slabMinYW = Math.min(_yA, _yB), slabMaxYW = Math.max(_yA, _yB);     // N-S world (v)
    const slabWidthM = slabMaxXW - slabMinXW; // E-W metres (plank WIDTH axis / u)
    const slabDepthM = slabMaxYW - slabMinYW; // N-S metres (plank LENGTH axis / v)
    const floorTileTex = makeAshyOakTexture(slabWidthM, slabDepthM);
    floorTileTex.wrapS = floorTileTex.wrapT = THREE.ClampToEdgeWrapping; // one copy only
    floorTileTex.repeat.set(1 / slabWidthM, 1 / slabDepthM);
    floorTileTex.offset.set(-slabMinXW / slabWidthM, -slabMinYW / slabDepthM);
    floorTileTex.needsUpdate = true;
    // Neutral-white tint so the baked canvas colours show true (matte LVT).
    const floorMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.82, metalness: 0.0, map: floorTileTex });
    // Floor: extrude 15cm; after the -PI/2 X-rotation the extrude runs to world
    // +Y, so drop the mesh by SLAB_THICK-0.005 to put the walkable TOP face at
    // y=0.005 and the 15cm body BELOW it (grows downward, into the ground).
    // ExtrudeGeometry accepts an array of shapes and emits one geometry, so the
    // multi-piece floor is still a single mesh and a single draw call.
    const floorGeo = new THREE.ExtrudeGeometry(slabShapes, { depth: SLAB_THICK, bevelEnabled: false });
    // --- Custom planar UVs (the fix). The shape is authored in the X-Y plane
    // (shape.x = world X, shape.y = -tz(y)); after the -PI/2 X-rotation shape.y
    // becomes world Z. Both are already in metres. Write uv = (shape.x, shape.y)
    // straight from position, so the uv range == the slab's world extent exactly.
    {
      const pos = floorGeo.attributes.position;
      const uvArr = new Float32Array(pos.count * 2);
      for (let i = 0; i < pos.count; i++) {
        uvArr[i * 2]     = pos.getX(i); // world X metres  -> u
        uvArr[i * 2 + 1] = pos.getY(i); // shape Y metres  -> v (becomes world Z)
      }
      floorGeo.setAttribute("uv", new THREE.BufferAttribute(uvArr, 2));
      floorGeo.attributes.uv.needsUpdate = true;
    }
    const floorSlab = new THREE.Mesh(floorGeo, floorMat);
    floorSlab.rotation.x = -Math.PI / 2;
    floorSlab.position.set(0, -(SLAB_THICK - 0.005), 0);
    floorSlab.receiveShadow = true;
    scene.add(floorSlab);

    // Ceiling: the OUTER-FLUSH outline (ceilShapes — the full building
    // footprint), SLAB_THICK deep, growing UPWARD from WH (visible underside
    // stays at y=WH; the body extends up toward the roof). The ceiling is
    // BIGGER than the floor: it caps OVER the external walls out to their outer
    // faces, while the floor stays at their inner faces. Keeps the fade-from-outside behaviour
    // (transparent when the camera is above the house, solid from inside) —
    // driven by ceilingMesh.material.opacity in the render loop.
    const ceilMat = new THREE.MeshStandardMaterial({
      color: CEILING_COLOR, roughness: 0.9, side: THREE.DoubleSide,
      transparent: true, opacity: 0, depthWrite: false
    });
    const ceilGeo = new THREE.ExtrudeGeometry(ceilShapes, { depth: SLAB_THICK, bevelEnabled: false });
    const ceilingMesh = new THREE.Mesh(ceilGeo, ceilMat);
    ceilingMesh.rotation.x = -Math.PI / 2;
    ceilingMesh.position.set(0, WH, 0);
    ceilingMesh.castShadow = true;
    ceilingMesh.receiveShadow = true;
    scene.add(ceilingMesh);

    // Rug diffuse — a procedural plush-pile texture, generated at runtime like
    // every other floor material here. It replaces an embedded base64
    // PHOTOGRAPH of a specific real rug that used to live in this file: a photo
    // of somebody's furniture is not something a general-purpose renderer should
    // carry, it cannot be licensed onward, and it made the engine 14 KB heavier
    // for one house's benefit. A house that wants its own rug image supplies one
    // through the profile (`room.rug.texture`), which is loaded over this.
    //
    // The pattern is a warm-neutral grey with fine directional noise, which is
    // what reads as cut pile at the scale a rug is seen from.
    //
    // TONE. The mean is 94,93,87 -- a warm-neutral MID-grey, measured from the
    // rug photograph this procedural texture replaced. It is deliberately not a
    // lighter grey: a rug covers a whole room's floor, so its value drives how
    // the whole room reads, and an earlier lighter pile (150,145,138) lifted
    // both carpeted rooms visibly against the reference render.
    //
    // This is the engine's DEFAULT, not one house's preference. Rugs are dark
    // relative to a floor, and a renderer's built-in should look like a rug
    // rather than like an unpainted placeholder. A house that wants a different
    // tone says so with `rug.color`, and one that wants a specific rug supplies
    // `rug.texture`; neither has to know this number.
    const PILE_MEAN_RGB = [94, 93, 87];
    // Build a pile texture whose MEAN is `mean` ([r,g,b] 0-255). The rug's
    // colour is baked in here rather than applied as a material tint, because a
    // material colour multiplies its map and so can only ever DARKEN it: a rug
    // paler than the built-in pile could not be expressed at all, and three
    // differently-coloured demo rugs all clamped to the same grey. Generating
    // the texture at the requested value has no such ceiling and needs no
    // colour-space correction dance at the material.
    const makeRugPile = (mean) => {
      const size = 128;
      const c = document.createElement('canvas');
      c.width = c.height = size;
      const g = c.getContext('2d');
      const img = g.createImageData(size, size);
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const i = (y * size + x) * 4;
          // Per-pixel pile noise plus a faint vertical streak, so the pile has
          // a lie to it. Amplitude is a fixed number of levels, not a fraction
          // of the mean -- cut pile of any colour has much the same grain.
          const streak = Math.sin(x * 0.9) * 4;
          const n = (Math.random() - 0.5) * 26 + streak;
          img.data[i]     = Math.max(0, Math.min(255, mean[0] + n));
          img.data[i + 1] = Math.max(0, Math.min(255, mean[1] + n));
          img.data[i + 2] = Math.max(0, Math.min(255, mean[2] + n));
          img.data[i + 3] = 255;
        }
      }
      g.putImageData(img, 0, 0);
      const tex = new THREE.CanvasTexture(c);
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      tex.anisotropy = 4;
      tex.needsUpdate = true;
      return tex;
    };
    const rugDiffuseTex = makeRugPile(PILE_MEAN_RGB);

    // Procedural rug LOOK (`rooms[].rug.pattern`, src/rug-pattern.js): one
    // texture spanning the WHOLE rug, not a tile -- a chevron is a picture of
    // the rug, so it is stretched over the rug's bounding box exactly once.
    // Cached by (settings, size, resolution) so identical rugs share a texture
    // and a rebuild never regenerates one it already has. 512 px along the long
    // side (0.4 cm/px on a 2 m rug, the spec page's own size); the 'low' tier
    // halves it, a quarter of the memory and fill time on a weak phone.
    const rugPatternCache = new Map();
    const rugPatternTexture = (pattern, spanXCm, spanYCm) => {
      const longPx = quality.tier === 'low' ? 256 : 512;
      const key = JSON.stringify([pattern, Math.round(spanXCm), Math.round(spanYCm), longPx]);
      let tex = rugPatternCache.get(key);
      if (tex) return tex;
      const img = rugPatternForBox(spanXCm, spanYCm, pattern, longPx);
      const c = document.createElement('canvas');
      c.width = img.width;
      c.height = img.height;
      const g = c.getContext('2d');
      const id = g.createImageData(img.width, img.height);
      id.data.set(img.data);
      g.putImageData(id, 0, 0);
      tex = new THREE.CanvasTexture(c);
      // The palette is authored as sRGB hex (the photo's colours), and the
      // spec page it was signed off on renders it as sRGB -- so say so, or the
      // renderer treats the bytes as linear and the rug washes out pale.
      if ('colorSpace' in tex) tex.colorSpace = THREE.SRGBColorSpace; // r152+
      tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.anisotropy = 4;
      tex.needsUpdate = true;
      rugPatternCache.set(key, tex);
      return tex;
    };

    // Rooms (invisible click-catchers, rugs, lights)
    Object.entries(ROOMS).forEach(([id, rm]) => {
      const w = (rm.x2 - rm.x1) * S, d = (rm.y2 - rm.y1) * S;
      const cx = tx((rm.x1 + rm.x2) / 2), cz = tz((rm.y1 + rm.y2) / 2);

      // Per-room INVISIBLE click-catcher (replaces the old visible per-room
      // floor as the room-selection raycast target). opacity:0 (NOT visible:false
      // — an invisible-flagged mesh doesn't raycast; a zero-opacity one still
      // does). Carries roomId + clickable, sits at floor level. Built from the
      // room's D5 poly (or its rect if no poly).
      let ccGeo;
      if (rm.poly) {
        const shape = new THREE.Shape();
        shape.moveTo(tx(rm.poly[0][0]), -tz(rm.poly[0][1]));
        for (let i = 1; i < rm.poly.length; i++) shape.lineTo(tx(rm.poly[i][0]), -tz(rm.poly[i][1]));
        shape.closePath();
        ccGeo = new THREE.ShapeGeometry(shape);
      } else {
        ccGeo = new THREE.PlaneGeometry(w, d);
      }
      const cc = new THREE.Mesh(ccGeo, new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }));
      cc.rotation.x = -Math.PI / 2;
      if (!rm.poly) cc.position.set(cx, 0.006, cz);
      else cc.position.set(0, 0.006, 0);
      cc.userData = { roomId: id, clickable: true };
      scene.add(cc);

      // Rug objects — full-room rugs on the Ashy Oak floor in the bedroom + home
      // office (replaces the old baked carpet:true floors). A thin flat mesh over
      // the plank floor (y=0.01, above the tile to avoid z-fight).
      // R4 (2026-07-10, ACK'd): the rug covers the ENTIRE room floor and
      // IGNORES the pillar notches (#31 in bedroom, #26 in home_office) — the rug
      // laps over/under where the pillar bumps in, as if the pillars weren't there.
      // ENSUITE CUT (2026-07-11, rhaenys-rug, requested): the home_office rug must
      // follow home_office's actual L-SHAPE and STOP at the ensuite walls — the
      // ensuite (a whole room carved out of home_office's NE corner, x1071.2..1281.8
      // y303..448) must NOT be carpeted. So the home_office rug is a ShapeGeometry
      // built from home_office's outer L-boundary EXCLUDING the ensuite (opposite of
      // the pillar-notch rule: a whole ROOM is cut, but the #26 pillar bump is still
      // ignored/lapped-over). The BEDROOM rug stays a full RECTANGLE (still ignores
      // #31). See HO_RUG_POLY below — a squared-off L (no #26 notch) that only
      // excludes the ensuite.
      // COLOUR (2026-07-10, research-rug2): uses the REAL CGTrader grey plush-rug
      // diffuse (embedded data-URI, shared rugDiffuseTex above) with material tint
      // 0xFFFFFF so the photo's own correct warm-neutral MID-grey shows true. This
      // replaces the old 0xE2DFDA procedural fill, which was far too light (it
      // double-multiplied to a pale oatmeal, not the mid-grey of the reference).
      // Rugs — a thin flat mesh over the floor (y=0.01, above the slab to avoid
      // z-fighting). WHICH rooms have one, and what shape, is now profile data
      // (`room.rug`): the reference implementation hardcoded two room ids and an
      // inline polygon. A rug's outline is deliberately independent of the room
      // polygon — a rug laps over a pillar and stops short of a doorway, so it is
      // neither the room shape nor a plain rectangle — which is exactly why the
      // profile stores it separately rather than deriving it.
      if (rm.rug) {
        const rug = rm.rug;
        // Clone so each rug can set its own repeat without the rugs fighting
        // over one texture's repeat state. A CanvasTexture clone shares the
        // already-drawn canvas, so it is usable immediately.
        const rt = rugDiffuseTex.clone();
        rt.wrapS = rt.wrapT = THREE.RepeatWrapping;
        rt.needsUpdate = true;
        // Built from the rug polygon exactly like the floor slab's ShapeGeometry,
        // so the -PI/2 X-rotation lands it flat and correctly positioned. The
        // shape is authored at absolute world coords, so the mesh sits at the
        // origin rather than being translated to the room centre.
        const shape = new THREE.Shape();
        shape.moveTo(tx(rug.poly[0][0]), -tz(rug.poly[0][1]));
        for (let i = 1; i < rug.poly.length; i++) shape.lineTo(tx(rug.poly[i][0]), -tz(rug.poly[i][1]));
        shape.closePath();
        const rugGeo = new THREE.ShapeGeometry(shape);
        // ShapeGeometry emits UVs straight from the shape's world-metre coords,
        // so one texture copy per `repeatMetres` of rug keeps the pile at a
        // sensible real-world scale.
        //
        // A RECTANGULAR rug additionally rounds to a WHOLE number of copies
        // across each axis, so the pile pattern is not cut mid-tile at the rug's
        // own edge (a visible seam along the border). That rounding is only
        // meaningful when the rug's outline IS its bounding box; on an L-shaped
        // rug the box is bigger than the rug, so rounding against it would skew
        // the pile scale and the flat per-metre rate is the correct one.
        const _rb = { x1: Infinity, y1: Infinity, x2: -Infinity, y2: -Infinity };
        rug.poly.forEach(pt => {
          if (pt[0] < _rb.x1) _rb.x1 = pt[0];
          if (pt[0] > _rb.x2) _rb.x2 = pt[0];
          if (pt[1] < _rb.y1) _rb.y1 = pt[1];
          if (pt[1] > _rb.y2) _rb.y2 = pt[1];
        });
        const _rw = (_rb.x2 - _rb.x1) * S, _rd = (_rb.y2 - _rb.y1) * S;
        // Rectangular iff its area fills its bounding box (4-point outlines and
        // the degenerate collinear cases included).
        const _rugArea = Math.abs((function () {
          let s = 0;
          for (let i = 0; i < rug.poly.length; i++) {
            const a = rug.poly[i], b = rug.poly[(i + 1) % rug.poly.length];
            s += a[0] * b[1] - b[0] * a[1];
          }
          return s / 2;
        })()) * S * S;
        const _isRect = _rw > 0 && _rd > 0 && Math.abs(_rugArea - _rw * _rd) / (_rw * _rd) < 0.01;
        if (_isRect) {
          rt.repeat.set(
            Math.max(1, Math.round(_rw / rug.repeatMetres)) / _rw,
            Math.max(1, Math.round(_rd / rug.repeatMetres)) / _rd
          );
        } else {
          rt.repeat.set(1 / rug.repeatMetres, 1 / rug.repeatMetres);
        }
        // `color` is the colour the rug renders as, and it is baked into this
        // rug's own pile texture (see makeRugPile). White -- the default, and
        // what a house means by "just show me a rug" -- reuses the shared
        // default pile rather than generating an identical copy per room.
        //
        // Done in the texture, not as a material tint, for the reason given at
        // makeRugPile: a tint multiplies and therefore only darkens, so a rug
        // paler than the built-in pile was inexpressible and several distinct
        // colours collapsed onto the same clamped grey.
        // Read the profile's hex as PLAIN sRGB BYTES. THREE.Color would convert
        // it to linear on construction, and the canvas this feeds is written in
        // sRGB bytes -- mixing the two spaces silently lands about three times
        // too dark, which is exactly how an earlier attempt at this went wrong.
        const _rugHex = (typeof rug.color === 'number')
          ? rug.color
          : parseInt(String(rug.color).replace('#', ''), 16);
        const _rugRGB = [(_rugHex >> 16) & 255, (_rugHex >> 8) & 255, _rugHex & 255];
        const _wantsDefaultPile = _rugRGB[0] > 252 && _rugRGB[1] > 252 && _rugRGB[2] > 252;
        let rugTex;
        if (rug.pattern) {
          // A pattern supersedes `color`: the palette IS the rug's colour.
          // The texture is laid out in plan orientation by rugPatternForBox
          // (the zig-zag spans the rug's long side, or its short side with
          // `across: 'short'`, whichever plan axis that is), so the UVs here are simply each vertex's position
          // within the rug's bounding box -- replacing ShapeGeometry's
          // per-metre UVs, which suit a tiling pile but not a whole-rug picture.
          // The inverse of the shape transform is taken from tx/tz at the box
          // corners, so a house transform with a flipped axis maps correctly.
          const X1 = tx(_rb.x1), X2 = tx(_rb.x2), Y1 = -tz(_rb.y1), Y2 = -tz(_rb.y2);
          const pos = rugGeo.attributes.position, uv = rugGeo.attributes.uv;
          for (let i = 0; i < pos.count; i++) {
            const u = X2 !== X1 ? (pos.getX(i) - X1) / (X2 - X1) : 0;
            const vPlan = Y2 !== Y1 ? (pos.getY(i) - Y1) / (Y2 - Y1) : 0;
            // CanvasTexture flips Y: canvas row 0 (plan y1) is v = 1.
            uv.setXY(i, u, 1 - vPlan);
          }
          uv.needsUpdate = true;
          rugTex = rugPatternTexture(rug.pattern, _rb.x2 - _rb.x1, _rb.y2 - _rb.y1);
        } else {
          rugTex = _wantsDefaultPile ? rt : makeRugPile(_rugRGB);
          rugTex.wrapS = rugTex.wrapT = THREE.RepeatWrapping;
          rugTex.repeat.copy(rt.repeat);
          rugTex.anisotropy = 4;
          rugTex.needsUpdate = true;
        }
        const rugMesh = new THREE.Mesh(rugGeo, new THREE.MeshStandardMaterial({
          color: 0xffffff, roughness: 0.95, metalness: 0.0, map: rugTex
        }));
        rugMesh.rotation.x = -Math.PI / 2;
        rugMesh.position.set(0, 0.01, 0);
        rugMesh.receiveShadow = true;
        scene.add(rugMesh);
        if (rug.textureUrl) {
          // A profile-supplied rug image replaces the built-in pile texture.
          // Loaded after the mesh exists, so the callback has something to
          // assign to; a failure leaves the procedural pile in place.
          loadTracked(new THREE.TextureLoader(),
            rug.textureUrl,
            loaded => {
              loaded.wrapS = loaded.wrapT = THREE.RepeatWrapping;
              loaded.anisotropy = 4;
              loaded.repeat.set(1 / rug.repeatMetres, 1 / rug.repeatMetres);
              rugMesh.material.map = loaded;
              rugMesh.material.needsUpdate = true;
            },
            undefined,
            () => console.warn('[Home3DScene] rug texture "' + rug.textureUrl +
              '" could not be loaded; using the procedural pile instead.')
          );
        }
      }

      // ---- Room lights ---------------------------------------------------
      //
      // DATA-DRIVEN. This used to be a chain of `if (id === "living_room")`
      // branches placing fixtures at literal coordinates, with a per-room
      // DL_SHIFT table nudging them whenever a room moved -- the single biggest
      // reason the engine only rendered one flat. Every fixture position now
      // comes from the profile (geometry.json -> lights[].fixtures[].positions),
      // so this code places whatever it is given and knows nothing about any
      // particular room.
      //
      // A fixture group is a `channel` (the join key to a Home Assistant entity
      // in rooms.json) with a `fixtureType` telling us what to draw and a list
      // of positions in plan centimetres. Positions the author did not supply
      // were auto-placed over the room bbox by the loader.
      const mls = [], mms = [];
      const groups = LIGHTS[id] || {};

      // One shadow-casting light per room for wall occlusion. Skipped on
      // low-uniform GPUs — these × ~14 fragment-uniform vectors each alone
      // exceeds the Adreno 256 budget. The room still has its main fixture
      // lights; just no wall-shadowing from a hidden point source.
      //
      // Its range keys off the room's bounding box, which is now DERIVED from
      // the room polygon rather than read from a separately-authored rect.
      const FY = 0;
      const roomRange = Math.max(w, d) * 1.2;
      if (quality.roomShadowLights) {
        // A DOWNWARD SPOTLIGHT, NOT A POINT LIGHT. This light is invisible and
        // exists only to cast wall/floor occlusion from ceiling height, so a
        // downward cone models it at least as honestly as a sphere does -- and
        // costs ~6x less, because a PointLight shadow is a SIX-FACE CUBEMAP
        // while a SpotLight shadow is a single 2D map. That is the dominant
        // cold-start cost in this app (see docs/perf-cold-start.md).
        //
        // The three upward faces of the old cubemap rendered the ceiling slab
        // from above and contributed nothing a viewer can see; the cone keeps
        // the hemisphere that does the visible work.
        // Built by src/render-rig.js (createRoomShadowLight), which the spec
        // pages' night room light uses too. Cone half-angle: wide enough to
        // cover the room's own floor plan from ceiling height (WH - 0.15),
        // with margin, clamped to ~80 deg; derived from the room's
        // half-diagonal so a long thin room still gets its corners lit rather
        // than a circle inscribed in its short side. Range: 1.2 x the longer
        // side (roomRange).
        //
        // A SpotLight aims at its `target`, whose default is the origin -- so
        // WITHOUT one every room's cone would point at the middle of the house
        // instead of at its own floor. The target must also be IN THE SCENE
        // GRAPH: three reads target.matrixWorld, which is only updated for
        // objects the renderer walks. This is the single easiest way to get a
        // SpotLight conversion silently wrong.
        const roomShadowLight = createRoomShadowLight(THREE,
          { cx, cz, w, d, floorY: FY, ceiling: WH, shadowMapScale: smScale });
        scene.add(roomShadowLight.target);
        scene.add(roomShadowLight);
        mls.push(roomShadowLight);
      }

      // --- Fixture builders, one per fixtureType --------------------------
      // Each takes a world-space position and returns nothing; it pushes the
      // visible fixture mesh into `meshes` and its light EMITTER (position,
      // range, decay -- not yet a light) into `lights`. The channel's
      // emitters become one or two real PointLights once the channel is
      // built (collapseEmitters, task cd6d5d05): three.js pays every light
      // on every fragment of the house, so one light per fixture was the
      // single biggest per-pixel cost on a phone or tablet GPU.
      // The emissive disc/sphere is what the user clicks to select the room, so
      // every fixture carries { roomId, clickable }.

      // Flush ceiling disc.
      const addDownlight = (px, py, pz, meshes, lights, tint) => {
        const bm = new THREE.MeshStandardMaterial({ color: 0xfff8e0, emissive: tint, emissiveIntensity: 1.5 });
        const b = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.07, 0.03, 10), bm);
        b.position.set(px, py, pz);
        b.userData = { roomId: id, clickable: true };
        scene.add(b);
        meshes.push(b);
        lights.push({ x: px, y: py - 0.06, z: pz, intensity: 1,
          distance: Math.max(w, d) * ROOM_LIGHT.downlightDistanceK, decay: ROOM_LIGHT.downlightDecay });
      };

      // Surface-mounted spot: a small sphere. Historically a room's five spots
      // were drawn as a fixed cluster around the room centre; they are now five
      // ordinary positions like any other fixture, and a group of spots shares
      // ONE PointLight at the group's centroid (the cluster was always lit by a
      // single light -- five would blow the fragment-uniform budget for no
      // visible gain).
      const addSpotMesh = (px, py, pz, meshes, tint) => {
        const bm = new THREE.MeshStandardMaterial({ color: 0xfff8e0, emissive: tint, emissiveIntensity: 1.5 });
        const b = new THREE.Mesh(new THREE.SphereGeometry(0.05, 10, 10), bm);
        b.position.set(px, py, pz);
        b.userData = { roomId: id, clickable: true };
        scene.add(b);
        meshes.push(b);
      };

      // Bare bulb / pendant hanging below the ceiling.
      const addBulb = (px, py, pz, meshes, lights, tint) => {
        const bm = new THREE.MeshStandardMaterial({ color: 0xfff8e0, emissive: tint, emissiveIntensity: 1.5 });
        const b = new THREE.Mesh(new THREE.SphereGeometry(0.045, 10, 10), bm);
        b.position.set(px, py, pz);
        b.userData = { roomId: id, clickable: true };
        scene.add(b);
        meshes.push(b);
        lights.push({ x: px, y: py, z: pz, intensity: 1, distance: 4, decay: 2 });
      };

      // Linear LED run. `size` is the emitter's [length, height, depth] in cm,
      // straight from the profile, so a 2 m cornice reads as a line not a point.
      // `pos.drawn === false`: the light only, no emitter mesh -- a furniture
      // item draws the strip itself and follows the same channel (a bedside
      // table level, cabinet.js `channel.light`). `pos.reachCm`: the light's
      // cut-off distance (default 2.5 m), short for a light tucked into
      // furniture so it lights what is round it and not the room.
      // `pos.aim`: a plan direction [dx, dy] -- the light becomes a SpotLight
      // (no shadow) pointing that way, lighting only within `pos.spreadDeg`
      // (default 90: the whole half-space in front). A bedside level's light faces out of the table,
      // so it washes the fronts beside it and the floor in front, but never
      // reaches straight up or down to the OTHER level's channel.
      const addStrip = (px, py, pz, size, meshes, lights, tint, pos) => {
        const [sl, sh, sd] = size;
        const reach = pos && pos.reachCm > 0 ? pos.reachCm / 100 : 2.5;
        const aimed = pos && Array.isArray(pos.aim) && pos.aim.length === 2 && (pos.aim[0] || pos.aim[1])
          ? { aim: [pos.aim[0], pos.aim[1]], spread: pos.spreadDeg > 0 ? Math.min(90, pos.spreadDeg) : 90 } : {};
        if (pos && pos.drawn === false) {
          lights.push(Object.assign({ x: px, y: py, z: pz, intensity: 1, distance: reach, decay: 2 }, aimed));
          return;
        }
        const m = new THREE.Mesh(
          new THREE.BoxGeometry(sl / 100, sh / 100, sd / 100),
          new THREE.MeshStandardMaterial({
            color: tint, emissive: tint, emissiveIntensity: 0.8,
            transparent: true, opacity: 0.85
          })
        );
        m.position.set(px, py, pz);
        m.userData = { roomId: id, clickable: true };
        scene.add(m);
        meshes.push(m);
        lights.push(Object.assign({ x: px, y: py, z: pz, intensity: 1, distance: reach, decay: 2 }, aimed));
      };

      /**
       * Resolve a fixture position to world space.
       *
       * `at` is plan [x, y] in centimetres. `heightCm` is height above THIS
       * room's floor; omitted means a ceiling fixture, which sits just below
       * the ceiling. That default is what lets a profile list a downlight as a
       * bare [x, y] without repeating the ceiling height on every entry.
       */
      const fixtureY = (pos, ceilingDrop) => (
        pos.heightCm != null ? FY + pos.heightCm / 100 : FY + WH - ceilingDrop
      );

      // Build every channel this room declares. 'main' and 'ambient' get their
      // own light/mesh arrays because the controls panel and the HA binding
      // switch them independently; any other channel is its own group too.
      const groupLights = {}, groupMeshes = {};
      Object.keys(groups).forEach(channel => {
        const g = groups[channel];
        // Ambient/accent groups are the decorative layer and are dropped on the
        // low tier (~12 PointLights x 6 vec4 of fragment uniforms we cannot
        // afford on an Adreno 256). Visual loss is moderate; "nothing renders
        // at all" is not.
        const isAccent = (channel !== 'main');
        if (isAccent && !quality.ambientStrips) return;

        const ls = [], ms = [];
        // Fixture tint from the group's colour temperature. Ambient strips have
        // historically been a saturated accent colour rather than a white, and
        // a profile expresses that by giving the group a low kelvin.
        const tint = (g.fixtureType === 'strip' && isAccent) ? 0xff3300 : k2h(g.colorTemperatureK);

        (g.positions || []).forEach(pos => {
          const px = tx(pos.at[0]), pz = tz(pos.at[1]);
          switch (g.fixtureType) {
            case 'downlight':
              addDownlight(px, fixtureY(pos, 0.02), pz, ms, ls, tint);
              break;
            case 'spot':
              addSpotMesh(px, fixtureY(pos, 0.12), pz, ms, tint);
              break;
            case 'pendant':
            case 'bulb':
              addBulb(px, pos.heightCm != null ? FY + pos.heightCm / 100 : FY + WH * 0.7, pz, ms, ls, tint);
              break;
            case 'strip':
              addStrip(px, fixtureY(pos, 0.06), pz, pos.size || [Math.max(w, d) * 70, 2.5, 2.5], ms, ls, tint, pos);
              break;
            case 'projector':
              // A special-effect emitter (e.g. a star projector). It gets NO
              // fixture geometry and NO point light: the real device is a small
              // matt-black puck that throws points of light onto the ceiling,
              // so drawing it as an emissive bulb put a glowing ball in mid-air
              // in the middle of the room — and because an accent channel is
              // tinted #ff3300, that ball rendered as a stray red dot. The
              // channel still exists in lightState, so it keeps its own toggle
              // in the controls panel; it simply has nothing to draw.
              break;
            case 'none':
              // Light with no visible fixture geometry.
              ls.push({ x: px, y: fixtureY(pos, 0.08), z: pz, intensity: 1, distance: Math.max(w, d) * 1.8, decay: 1.8 });
              break;
            default:
              addDownlight(px, fixtureY(pos, 0.02), pz, ms, ls, tint);
          }
        });

        // The channel's emitters -> one PointLight (two when its fixtures
        // are more than 2.5 m apart, one per end), at their centroid and
        // mean height, as bright as the separate fixtures were on the
        // room's floor (see src/light-merge.js). Strips are never merged:
        // a strip's light is a glow on the surface it runs along.
        // `userData.gain` is the merged light's intensity relative to one
        // fixture; syncLights() multiplies the channel's per-fixture
        // intensity by it, so on/off, brightness and colour work as before.
        const emitters = ls.splice(0, ls.length);
        collapseEmitters(emitters, { minX: tx(rm.x1), maxX: tx(rm.x2), minZ: tz(rm.y1), maxZ: tz(rm.y2) },
          { merge: g.fixtureType !== 'strip', floorY: FY, houseBox: HOUSE.footprint ? {
            minX: tx(HOUSE.footprint.minX), maxX: tx(HOUSE.footprint.maxX),
            minZ: tz(HOUSE.footprint.minY), maxZ: tz(HOUSE.footprint.maxY) } : null })
          .forEach(m => {
            let pl;
            if (m.aim) {
              // Plan x east / y south map to world +x / +z (tx, tz).
              const len = Math.hypot(m.aim[0], m.aim[1]);
              pl = new THREE.SpotLight(tint, 0.6, m.distance, m.spread * Math.PI / 180, 0.3, m.decay);
              pl.castShadow = false;
              pl.target.position.set(m.x + m.aim[0] / len, m.y, m.z + m.aim[1] / len);
              scene.add(pl.target);
            } else {
              pl = new THREE.PointLight(tint, 0.6, m.distance, m.decay);
            }
            pl.position.set(m.x, m.y, m.z);
            pl.userData.gain = m.intensity;
            pl.userData.fixtures = m.count;
            pl.name = 'roomLight:' + id + ':' + channel;
            scene.add(pl);
            ls.push(pl);
          });

        // A spot cluster shares one PointLight — see addSpotMesh. WHERE it
        // hangs depends on whether the profile said where the spots are:
        //
        //   AUTHORED positions mark real fixtures, so their centroid is the
        //     genuine centre of illumination and is the right place for it.
        //
        //   AUTO-PLACED positions are an arbitrary grid the loader invented
        //     because the profile gave only a count. Their centroid is an
        //     artefact of that grid -- a part-filled last row (5 spots into a
        //     3x2) weights it toward the fuller row -- so the light would hang
        //     off-centre for a reason that has nothing to do with the house.
        //     Use the room's own centre, which is what was meant by "put N
        //     spots in this room".
        if (g.fixtureType === 'spot' && g.positions && g.positions.length) {
          let lx, lz;
          if (g.autoPlaced) {
            lx = cx; lz = cz;
          } else {
            let sx = 0, sz = 0;
            g.positions.forEach(pos => { sx += tx(pos.at[0]); sz += tz(pos.at[1]); });
            lx = sx / g.positions.length; lz = sz / g.positions.length;
          }
          const pl = new THREE.PointLight(tint, 1.0, Math.max(w, d) * ROOM_LIGHT.spotClusterDistanceK, ROOM_LIGHT.spotClusterDecay);
          pl.position.set(lx, FY + WH - ROOM_LIGHT.spotClusterDrop, lz);
          scene.add(pl);
          ls.push(pl);
        }

        // Tag each fixture with its channel -- the join key to rooms.json's
        // rooms[roomId][channel] -- so a tap on the fixture can resolve the
        // entity it controls (src/tap-popovers.js).
        ms.forEach(m => { m.userData.lightChannel = channel; });
        groupLights[channel] = ls;
        groupMeshes[channel] = ms;
      });

      // 'main' feeds the room's primary light arrays (and the room shadow light
      // rides along with it, as it always did). Every other channel is stored
      // under its own name.
      mls.push.apply(mls, groupLights.main || []);
      mms.push.apply(mms, groupMeshes.main || []);
      mainLights[id] = mls;
      mainMeshes[id] = mms;

      // Accent channels. 'ambient' keeps its dedicated arrays because the
      // controls panel and updateLights() address it by name; anything else is
      // kept in the same per-channel maps so a profile can declare a third
      // switchable group without an engine change.
      ambientLights[id] = groupLights.ambient || [];
      ambientMeshes[id] = groupMeshes.ambient || [];
      Object.keys(groupLights).forEach(channel => {
        if (channel === 'main' || channel === 'ambient') return;
        extraLights[id] = extraLights[id] || {};
        extraMeshes[id] = extraMeshes[id] || {};
        extraLights[id][channel] = groupLights[channel];
        extraMeshes[id][channel] = groupMeshes[channel];
      });
    });

    // ── Presence footsteps ──────────────────────────────────────────────────
    //
    // One flat mesh per room, a trail of footprint quads laid on the floor,
    // shown while that room's presence sensor reads occupied.
    //
    // Built for EVERY room up front and left invisible, rather than created on
    // the first presence event: building geometry and compiling a shader is
    // the expensive thing in this scene (GPU program link dominates cold
    // start), and doing it lazily would pay that cost as a visible stall at
    // the exact moment someone walks into the room. Built once, the runtime
    // cost of a presence change is setting `visible` and `opacity`.
    //
    // Deliberately cheap, three ways:
    //   * ONE shared MeshBasicMaterial per room — unlit, so it stays out of
    //     the expensive lit-shader permutation set and needs no light uniforms.
    //   * castShadow/receiveShadow both false. Shadow cost is the dominant
    //     startup expense here and 10 of 11 casters are cubemap PointLights;
    //     adding a caster for a decal would be the single most costly thing we
    //     could do. It also means setPresence() must NOT invalidateShadows().
    //   * ONE merged geometry per room, so a visible trail is 1 draw call.
    const footstepsByRoom = {};
    {
      // A single procedural footprint: a rounded sole plus a separate ball
      // pad, drawn white on transparent and used as an alpha map so the
      // material's own colour shows through. Procedural CanvasTexture is the
      // established convention in this file (9 other sites), so this adds no
      // asset and no loader.
      const fpCanvas = document.createElement('canvas');
      fpCanvas.width = fpCanvas.height = 64;
      const fpc = fpCanvas.getContext('2d');
      fpc.clearRect(0, 0, 64, 64);
      fpc.fillStyle = '#ffffff';
      // Heel + sole: one tapered blob down the lower two-thirds.
      fpc.beginPath();
      fpc.ellipse(32, 42, 13, 19, 0, 0, Math.PI * 2);
      fpc.fill();
      // Ball of the foot / toes: a wider pad set slightly forward, with a gap
      // so the print reads as a foot rather than a pill at a glance.
      fpc.beginPath();
      fpc.ellipse(32, 15, 15, 11, 0, 0, Math.PI * 2);
      fpc.fill();
      const footprintTex = new THREE.CanvasTexture(fpCanvas);

      // NOTE: placement used to draw from a pseudo-random generator seeded per
      // room id, so that a trail at least stayed put between reloads and a
      // visual review could compare against an earlier capture. It is gone
      // because placement no longer contains any random quantity at all: every
      // number below is derived from the room's polygon and its doors. That is
      // strictly stronger than a seeded rand for the property we needed — the
      // same house always yields the same trails — and it is also what stops
      // the direction from looking arbitrary, which was the actual complaint.
      // If anything here ever needs to vary again, seed it; never Math.random().

      // insidePoly / clearRun / polyAreaSqm / printCount / walkFootsteps all
      // live in src/footstep-walk.js now (imported at the top of this file).
      // They are pure arithmetic over a polygon with no THREE or DOM in them,
      // and they were moved out so they could be tested: the step-back-and-
      // turn-once branch inside walkFootsteps never runs on the houses that
      // ship today (the count caps below always stop the walk first), so it
      // needed a synthetic fixture to exercise it. See that module's header and
      // scripts/test-footstep-turn.mjs. Rendering all stays here.

      // Every door you could walk through to ENTER this room, with the inward
      // direction and how much clear floor lies beyond it.
      //
      // Deliberately NOT restricted to doors whose `room` is this room. A
      // hallway is entered mostly through OTHER rooms' doors, and on the real
      // house the hallway's own door (the front door) offers a shorter run
      // than the kitchen door does — so considering only the owned door would
      // walk the trail the wrong way down an L-shaped hall.
      //
      // The inward direction is resolved by PROBING both sides of the wall
      // with insidePoly, not by reading the door's `swing`. Swing says which
      // way the leaf opens, which is frequently not the way you walk.
      const doorApproaches = (poly, padCm) => {
        const PROBE = 26;
        const out = [];
        DOORS.forEach(d => {
          const onX = (d.wall === 'x');
          const px = onX ? d.c : d.at;
          const py = onX ? d.at : d.c;
          const nx = onX ? 0 : 1, ny = onX ? 1 : 0;
          [1, -1].forEach(s => {
            const ux = nx * s, uy = ny * s;
            if (!insidePoly(poly, px + ux * PROBE, py + uy * PROBE)) return;
            const sx = px + ux * padCm, sy = py + uy * padCm;
            if (!insidePoly(poly, sx, sy)) return;   // room too shallow to pad into
            out.push({ id: d.id, room: d.room, ux, uy, sx, sy,
                       run: clearRun(poly, sx, sy, ux, uy, 1200) });
          });
        });
        return out;
      };

      // Every door opening in the house, for the door gap (DOOR_GAP_CM): no
      // print of ANY trail -- authored or automatic -- is laid within that
      // distance of a doorway, so a trail always reads as squarely inside one
      // room rather than straddling a threshold. See src/footstep-walk.js.
      const openings = doorOpenings(DOORS);

      Object.entries(ROOMS).forEach(([id, rm]) => {
        // An authored route (schema `rooms[].footstepPath`) beats everything
        // below: prints go along its waypoints, in order, and neither the
        // zone nor the door-approach heuristics apply. The loader has already
        // checked every waypoint lies on this room's floor.
        // Precedence and the door gap both live in placeTrail() so they are
        // tested (scripts/test-footstep-path.mjs); this file only renders.
        const { prints } = placeTrail({
          room: rm, openings, gapCm: DOOR_GAP_CM,
          auto: () => autoPrints(id, rm),
        });
        if (!prints.length) return;
        buildTrail(id, prints);
      });

      // The automatic walk: a zone rectangle if the room has one, else the
      // room's own polygon entered through its best door. Returns null when
      // the room has no floor to stand on.
      function autoPrints(id, rm) {
        // A room may override automatic placement with a manual footstepZone
        // (schema `rooms[].footstepZone`, resolved to absolute plan coordinates
        // by house-loader.js). When present, walk the RECTANGLE instead of the
        // room's actual polygon -- for every purpose below: door-approach
        // probing, area, and the walk itself. This is deliberately a full
        // substitution rather than an extra clip on top of the polygon, because
        // the whole point is to let a room owner confine the trail to floor the
        // polygon alone does not describe as clear (the gap between a kitchen's
        // counters and its table, say). Absent -> today's behaviour exactly,
        // unchanged: `poly` stays the room's own polygon.
        const zone = rm.footstepZone;
        const poly = zone
          ? [[zone.x1, zone.y1], [zone.x2, zone.y1], [zone.x2, zone.y2], [zone.x1, zone.y2]]
          : rm.poly;
        // Stride constants live with the walk itself, so this file and the
        // test cannot drift to two different ideas of a stride.
        const { STEP_CM, STRIDE_CM, PRINT_CM, PAD_CM } = WALK_DEFAULTS;

        // Someone walks IN THROUGH A DOOR. That one idea fixes all three of the
        // things that looked wrong before: the direction stops being arbitrary
        // (it was literally rand() * 2PI, so two identical bathrooms walked
        // different ways), the trail starts inside the room instead of being
        // centred on a bounding box, and it can be kept on the room's own floor
        // because we know where it began.
        //
        // The entry chosen is the one with the LONGEST CLEAR RUN inside this
        // room. For a plain rectangular room that is simply its own door. For
        // an L-shaped hallway it picks the door that looks down the long leg of
        // the L, which is what makes the trail read as walking along the hall
        // rather than heading into whatever sits in the notch.
        const approaches = poly ? doorApproaches(poly, PAD_CM) : [];
        // Longest run wins. The run is bucketed to 40cm so two comparable
        // approaches do not flip on a centimetre, then a door belonging to this
        // room breaks the tie, then the id — fully deterministic, no rand().
        approaches.sort((a, b) => {
          const ra = Math.round(a.run / 40), rb = Math.round(b.run / 40);
          if (ra !== rb) return rb - ra;
          const oa = (a.room === id) ? 0 : 1, ob = (b.room === id) ? 0 : 1;
          if (oa !== ob) return oa - ob;
          return a.id < b.id ? -1 : 1;
        });

        // Bounding box to fall back on when no door approach lands inside
        // `poly`. Ordinarily the room's own derived bbox; when a footstepZone
        // is active it must be the ZONE's bbox instead, or a room with a zone
        // but no reachable door approach would silently fall back to wandering
        // the whole room again -- defeating the very confinement the zone asks
        // for.
        const bx1 = zone ? zone.x1 : rm.x1, by1 = zone ? zone.y1 : rm.y1;
        const bx2 = zone ? zone.x2 : rm.x2, by2 = zone ? zone.y2 : rm.y2;

        let sx, sy, ux, uy, run;
        if (approaches.length) {
          const a = approaches[0];
          sx = a.sx; sy = a.sy; ux = a.ux; uy = a.uy; run = a.run;
        } else {
          // No door opens into this room (the real house has one such room), or
          // the profile carries no polygon at all. Fall back to the long axis
          // of the bounding box — but seeded from a point PROVEN to be inside
          // the room. An L-shaped polygon's bbox centre can lie in the notch,
          // i.e. outside the room entirely, so it is never trusted blind.
          let cx = (bx1 + bx2) / 2, cy = (by1 + by2) / 2;
          if (poly && !insidePoly(poly, cx, cy)) {
            let found = false;
            for (let i = 1; i < 24 && !found; i++) {
              for (let j = 1; j < 24 && !found; j++) {
                const qx = bx1 + (bx2 - bx1) * i / 24;
                const qy = by1 + (by2 - by1) * j / 24;
                if (insidePoly(poly, qx, qy)) { cx = qx; cy = qy; found = true; }
              }
            }
            if (!found) return null;   // degenerate polygon: no floor to stand on
          }
          const w = bx2 - bx1, h = by2 - by1;
          ux = (w >= h) ? 1 : 0; uy = (w >= h) ? 0 : 1;
          // Back up along the axis so the trail straddles the room rather than
          // starting at its middle, then measure forward from there.
          const back = poly ? clearRun(poly, cx, cy, -ux, -uy, 400) : Math.min(w, h) / 2;
          sx = cx - ux * Math.min(back * 0.5, 60);
          sy = cy - uy * Math.min(back * 0.5, 60);
          run = poly ? clearRun(poly, sx, sy, ux, uy, 1200) : Math.max(w, h);
        }

        // How many prints. Two limits, whichever is tighter: what physically
        // fits in the clear run ahead, and what suits the room's size. A small
        // room such as an en suite or a bathroom should read as a few steps in
        // through the door, not as a march from one wall to the other.
        const areaSqm = poly ? polyAreaSqm(poly) : Math.abs((rm.x2 - rm.x1) * (rm.y2 - rm.y1)) / 10000;
        const nPrints = printCount(areaSqm, run, STEP_CM);

        // WHERE the prints go — pure arithmetic, no geometry. See
        // src/footstep-walk.js, including the turn-at-the-corner rule.
        return walkFootsteps({
          poly,
          bounds: { x1: bx1, y1: by1, x2: bx2, y2: by2 },
          sx, sy, ux, uy, nPrints,
          stepCm: STEP_CM, strideCm: STRIDE_CM,
        }).prints;
      }

      // ...and what they LOOK like. One flat quad per print.
      function buildTrail(id, prints) {
        const { PRINT_CM } = WALK_DEFAULTS;
        const geos = prints.map(p => {
          const g = new THREE.PlaneGeometry(PRINT_CM * S * 0.62, PRINT_CM * S);
          // Lay flat, then turn the print to face along the walking line.
          g.rotateX(-Math.PI / 2);
          g.rotateY(printYaw(p.dirx, p.diry));   // toe leads; see printYaw
          g.translate(tx(p.x), 0.012, tz(p.y));
          return g;
        });

        // Merge to ONE geometry so the whole trail is a single draw call.
        // Done by hand rather than via BufferGeometryUtils: every print is the
        // same PlaneGeometry layout (position/normal/uv, indexed), so
        // concatenating the arrays and offsetting the indices is exact, and it
        // avoids adding an addon import to the vendored three build.
        let vCount = 0, iCount = 0;
        geos.forEach(g => { vCount += g.attributes.position.count; iCount += g.index.count; });
        const pos = new Float32Array(vCount * 3);
        const nor = new Float32Array(vCount * 3);
        const uv = new Float32Array(vCount * 2);
        const idx = new Uint16Array(iCount);
        let vo = 0, io = 0;
        geos.forEach(g => {
          pos.set(g.attributes.position.array, vo * 3);
          nor.set(g.attributes.normal.array, vo * 3);
          uv.set(g.attributes.uv.array, vo * 2);
          const gi = g.index.array;
          for (let k = 0; k < gi.length; k++) idx[io + k] = gi[k] + vo;
          vo += g.attributes.position.count;
          io += gi.length;
          g.dispose();
        });
        const merged = new THREE.BufferGeometry();
        merged.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        merged.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
        merged.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
        merged.setIndex(new THREE.BufferAttribute(idx, 1));

        const mat = new THREE.MeshBasicMaterial({
          color: 0x3c3a36,
          alphaMap: footprintTex,
          transparent: true,
          opacity: 0,            // faded in on arrival; see setPresence()
          depthWrite: false,     // a flat decal over the floor must not z-fight
          side: THREE.DoubleSide
        });
        const mesh = new THREE.Mesh(merged, mat);
        mesh.castShadow = false;
        mesh.receiveShadow = false;
        // Starts hidden. `visible` is the real on/off; opacity drives the fade.
        mesh.visible = false;
        mesh.renderOrder = 2;
        // Plan-cm placements, kept for getFootstepDebug(): lets a check read
        // exactly where each print went without inverting the world transform.
        mesh.userData.prints = prints.map(p => ({ x: +p.x.toFixed(1), y: +p.y.toFixed(1),
                                                  dirx: +p.dirx.toFixed(3), diry: +p.diry.toFixed(3) }));
        scene.add(mesh);
        footstepsByRoom[id] = mesh;
      }
    }

    // (The single house-wide ceiling slab is built up front with the floor slab
    // — see the floor/ceiling section before the room loop above. It keeps the
    // fade-from-outside behaviour via ceilingMesh.material.opacity in the loop.)

    // Living-room black-oak acoustic slat panel on wall #1's room-facing (east)
    // face + the 12cm step-return where wall #3 begins (y=707.8). The span is
    // wall 1's `slats.along` (default north stop y=353.4, south end at the
    // step y=707.8); does NOT continue onto wall #3's
    // own wide face (visual review 2026-07-09). Ported from experimental
    // (buildAcousticPanelLivingRoomWall1Wall3) WITH the black-half depthWrite
    // fix (see scout-blackhalf report + the render-loop fade block). wallMeshes
    // is passed so the panel meshes register into the SAME exterior-fade loop as
    // wall #1 (#1 is outer:1, so the panel DOES fade see-through from outside).
    // Decorative slat panelling. This is bespoke geometry keyed to specific wall
    // ids of the house it was modelled for; the only schema field for it is
    // wall 1's optional `slats` span. It is therefore OPT-IN: a house asks
    // for it by passing `decor: ['acoustic-panels']` to create(). Every house that
    // does not ask (the demo house included) simply skips it, and the functions
    // themselves no-op when the wall ids they need are absent, so an opt-in from a
    // house without those walls degrades quietly rather than throwing.
    if (quality.decor.indexOf('acoustic-panels') !== -1) {
      buildAcousticPanelLivingRoomWall1Wall3(scene, wallMeshes);
    }

    // Clouds — drifting puff sprites in the sky. Shared canvas texture (a few
    // overlapping radial gradients fake a fluffy outline). Tinted by sun mode.
    const cloudTex = (() => {
      const c = document.createElement('canvas');
      c.width = 256; c.height = 128;
      const g = c.getContext('2d');
      const blobs = [[80,70,60],[130,55,55],[180,70,50],[105,85,45],[155,85,45]];
      blobs.forEach(([x, y, r]) => {
        const grd = g.createRadialGradient(x, y, 0, x, y, r);
        grd.addColorStop(0, 'rgba(255,255,255,0.85)');
        grd.addColorStop(0.4, 'rgba(255,255,255,0.55)');
        grd.addColorStop(1, 'rgba(255,255,255,0)');
        g.fillStyle = grd;
        g.fillRect(0, 0, 256, 128);
      });
      const tex = new THREE.CanvasTexture(c);
      tex.needsUpdate = true;
      return tex;
    })();
    const clouds = [];
    const CLOUD_COUNT = 14;
    const CLOUD_SPREAD = 70;
    const HOME_CX = tx(HOUSE.centre[0]), HOME_CZ = tz(HOUSE.centre[1]);
    const wrapMinX = HOME_CX - CLOUD_SPREAD / 2;
    const wrapMaxX = HOME_CX + CLOUD_SPREAD / 2;
    for (let i = 0; i < CLOUD_COUNT; i++) {
      const mat = new THREE.SpriteMaterial({
        map: cloudTex, transparent: true, opacity: 0.85,
        color: 0xffffff, depthWrite: false
      });
      const sp = new THREE.Sprite(mat);
      const sc = 8 + Math.random() * 6;
      sp.scale.set(sc * 2, sc, 1);
      sp.position.set(
        wrapMinX + Math.random() * CLOUD_SPREAD,
        22 + Math.random() * 10,
        HOME_CZ + (Math.random() - 0.5) * CLOUD_SPREAD
      );
      sp.userData.driftSpeed = 0.3 + Math.random() * 0.4;
      sp.userData.wrapMinX = wrapMinX;
      sp.userData.wrapMaxX = wrapMaxX;
      scene.add(sp);
      clouds.push(sp);
    }

    // Wall #25 bedroom-facing acoustic slat panel (Acupanel Oak). Standalone
    // group bolted onto #25's -x face; registers its meshes into wallMeshes so
    // it fades with the bedroom's exterior wall (#4) and gets the black-half
    // depthWrite fix in the render loop. (zabine-wall25, ported 2026-07-11.)
    if (quality.decor.indexOf('acoustic-panels') !== -1) {
      buildAcousticPanelWall25(scene, wallMeshes);
    }

    // ── OUTWARDNESS DERIVATION (2026-09-14) ────────────────────────────────
    // The exterior-fade loop needs each outer wall's TRUE OUTWARD normal. It
    // used to assume the registered (nx,nz) was already outward, on the
    // reasoning that "the shell is a consistently-wound loop". That holds for
    // the demo house and NOT for real floor plans. Measured on both:
    //
    //   demo       4 outer walls  ->  4/4 already OUTWARD  (dots +1.000)
    //   a real 10-room plan      11 outer walls  -> 11/11 INWARD (-0.585..-1.000)
    //
    // A real plan is not authored as one clean loop — adjacent segments run in
    // opposite directions — so NO FIXED SIGN in the fade test serves both. A
    // sign flip fixes one house by breaking the other, which is exactly the
    // regression this block exists to end. Instead DERIVE the sign here, from
    // geometry, once at build time.
    //
    // Method: take the house bounding-box centre and, for each registered
    // entry, dot its normal against (centre -> that entry's midpoint). Positive
    // already points away from the centre (outward); negative means the
    // registered normal is inward, so flip it. The fade loop then reads a
    // normal that is outward by construction for ANY winding, including mixed.
    //
    // ⚠️ Derived PER REGISTRATION ENTRY, never per mesh. The living-room slat
    // panel registers seg1 and seg2 with the SAME borrowed normal (nx:1,nz:0)
    // on purpose, so the two segments cross the fade threshold in lockstep
    // (2026-07-11 review fix). Re-deriving from each MESH's own position would
    // give seg2 (which physically faces -z) the opposite sign and split that
    // pair apart again. Grouping by the registered normal keeps them together:
    // entries sharing a normal get one shared sign, decided by their COMBINED
    // midpoint, so a borrowed-normal group still fades as one unit.
    (function deriveOutwardNormals() {
      const fp = HOUSE && HOUSE.footprint;
      if (!fp) return;   // no footprint (no house bound) -> leave normals as authored
      const ccx = tx((fp.minX + fp.maxX) / 2);
      const ccz = tz((fp.minY + fp.maxY) / 2);
      // Group outer entries by their registered normal, so borrowed-normal
      // groups (seg1/seg2) are judged once, together, not mesh by mesh.
      const groups = new Map();
      wallMeshes.forEach(entry => {
        if (!entry.outer) return;
        const key = entry.nx.toFixed(4) + ',' + entry.nz.toFixed(4);
        let g = groups.get(key);
        if (!g) { g = []; groups.set(key, g); }
        g.push(entry);
      });
      groups.forEach(entries => {
        // Score every entry in the group independently, then let the group
        // decide ONCE by summed evidence. Summing the per-entry dots (rather
        // than dotting against an averaged midpoint) matters: two members on
        // opposite sides of the house would average to a midpoint near the
        // centre, where the outward direction is meaningless and a rounding
        // error picks the sign. Summed dots instead weight each member by how
        // unambiguous it individually is, so confident members outvote
        // near-edge-on ones and a tie stays a tie.
        let score = 0;
        entries.forEach(e => {
          let ox = e.mesh.position.x - ccx, oz = e.mesh.position.z - ccz;
          const L = Math.hypot(ox, oz);
          if (L < 1e-6) return;          // sits on the centre: casts no vote
          score += (e.nx * ox + e.nz * oz) / L;
        });
        // score === 0 means no usable evidence either way (every member
        // edge-on or centred). Leave the authored normal alone rather than
        // flipping on noise.
        if (score < 0) {
          // Registered normal points INWARD — store the corrected outward one.
          entries.forEach(e => { e.nx = -e.nx; e.nz = -e.nz; });
        }
      });
    })();

    // Windows + curtains on exterior walls join the fade now, with their host
    // wall's DERIVED outward normal (see the fittings block above). Pushed
    // after the derivation on purpose: the derivation groups entries by
    // normal and votes on mesh positions, and these meshes sit inside
    // wall-local groups whose `position` is not a world position.
    fittingFades.forEach(({ mesh, wallId }) => {
      const host = wallEntryById[wallId];
      if (!host || !host.outer) return;
      wallMeshes.push({ mesh, nx: host.nx, nz: host.nz, outer: true });
    });
    // Wall finish meshes likewise fade with their host wall.
    finishMeshes.forEach(({ mesh, wallId }) => {
      const host = wallEntryById[wallId];
      if (!host || !host.outer) return;
      wallMeshes.push({ mesh, nx: host.nx, nz: host.nz, outer: true });
    });

    return { mainLights, mainMeshes, ambientLights, ambientMeshes, extraLights, extraMeshes, sun, ambLight, gndMat, wallMeshes, wallEntryById, ceilingMesh, clouds, doorByRoom, doorById, footstepsByRoom, curtainById, daylight, textureLoads, disposeWallpaperPlaceholder };
  }

  /**
   * Turn a failed WebGL context into something the person looking at the
   * screen can act on, and return the error to throw.
   *
   * The caller is a browser on someone's sofa, not a developer with DevTools
   * open. Before this existed the whole failure surfaced as a black rectangle
   * and a console line.
   *
   * Deliberately built from DOM calls and inline styles rather than a CSS
   * class: this runs precisely when the page is already in trouble, so it must
   * not depend on any stylesheet, asset or font having loaded.
   */
  function webglUnavailable(container, cause, reason) {
    // Which of the two genuinely different failures is this?
    //
    // Chrome tells us, and the difference decides whether our advice is
    // useful or actively wrong. "Web page caused context loss and was
    // blocked" means the browser ran out of graphics memory -- typically a
    // pile of open tabs each holding contexts -- and closing some fixes it
    // within seconds. The driver/hardware-acceleration advice is useless
    // there, and was what a real user was shown while the actual cause sat in
    // the console.
    //
    // Matching is on the reason string the browser supplied, never on a
    // guess: with no reason string we fall through to the general wording,
    // which is the honest answer when we were not told.
    // Each alternative is a phrase that only appears when the cause is
    // exhaustion. A bare "contexts" was deliberately NOT used: it matches
    // plenty of messages that mean something else entirely, and a wrong
    // "close some tabs" is worse than the general wording.
    const reasonText = String(reason || (cause && cause.message) || '');
    const outOfMemory =
      /context loss|too many (?:active )?(?:webgl )?contexts|out of memory|memory exhaust/i
        .test(reasonText);

    try {
      if (container) {
        const box = document.createElement('div');
        box.className = 'home3d-webgl-unavailable';
        box.setAttribute('role', 'alert');
        box.style.cssText = [
          // z-index matters: the page's cold-start loading card is
          // position:fixed with z-index 9999 and is STILL UP at this point
          // (the scene never reached onReady, so nothing dismissed it).
          // Without a higher stacking order this message paints correctly and
          // is covered completely -- which is exactly what happened in the
          // field.
          'position:absolute', 'inset:0', 'z-index:10001',
          'display:flex', 'flex-direction:column',
          'align-items:center', 'justify-content:center', 'gap:10px',
          'padding:24px', 'box-sizing:border-box', 'text-align:center',
          'background:#0f0f1a', 'color:#e8e8f0',
          'font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif'
        ].join(';');

        const h = document.createElement('div');
        h.textContent = outOfMemory
          ? 'The browser ran out of graphics memory'
          : 'This device cannot display the 3D home';
        h.style.cssText = 'font-size:18px;font-weight:600';

        const p = document.createElement('div');
        p.textContent = outOfMemory
          // "Usually" is doing honest work here. Closing tabs is a reliable
          // fix; the number needed is not predictable, because anything else
          // holding a graphics context counts too. Naming a number would be
          // inventing precision we do not have.
          ? 'The browser refused to give this view the graphics context it ' +
            'needs to draw, because too much is already in use. That is ' +
            'usually a lot of open tabs rather than a fault with your device ' +
            'or with the home itself.'
          : 'The browser could not start WebGL, which this view needs to draw ' +
            'anything at all. It is usually a graphics driver that is switched ' +
            'off or out of date rather than a fault with the home itself.';
        p.style.cssText = 'max-width:44ch;opacity:0.85';

        const action = document.createElement('div');
        if (outOfMemory) {
          action.textContent = 'Close some tabs or other apps, then reload.';
          action.style.cssText = 'max-width:44ch;font-weight:600';
        }

        const hint = document.createElement('div');
        hint.textContent = outOfMemory
          // Kept, but demoted: if closing tabs did not do it, this is the next
          // thing worth trying.
          ? 'If that does not help, try another browser, or check that ' +
            'hardware acceleration is enabled.'
          : 'Try another browser, or check that hardware acceleration is enabled.';
        hint.style.cssText = 'max-width:44ch;opacity:0.6;font-size:13px';

        box.appendChild(h); box.appendChild(p);
        if (outOfMemory) box.appendChild(action);
        box.appendChild(hint);
        if (getComputedStyle(container).position === 'static') {
          container.style.position = 'relative';
        }
        container.appendChild(box);
      }
    } catch (e) {
      // A failure to render the failure message must never replace the real
      // error with a less informative one.
    }
    console.error(
      '[home3d] WebGL is unavailable; cannot create a renderer.',
      reasonText ? '(reason: ' + reasonText + ')' : '(no reason given)',
      cause
    );
    const err = new Error('Home3DScene: WebGL is unavailable in this browser.');
    err.cause = cause;
    // Carried for the page's startup-failure handler: it must know this
    // message is already on screen so it does not cover it with the generic
    // one. `webglReason` is preserved for diagnostics, since the browser only
    // ever says it once.
    err.webglReason = reasonText;
    err.webglOutOfMemory = outOfMemory;
    err.code = 'WEBGL_UNAVAILABLE';
    return err;
  }

  /**
   * Create a 3D home instance attached to a DOM container.
   *
   * THE HOUSE IS AN ARGUMENT. Pass either a compiled profile (from
   * HouseLoader.load / .compile) as `opts.house`, or a profile id as
   * `opts.houseId` and this will load it, falling back to the demo house if it
   * cannot. Because loading is asynchronous, the id form returns a PROMISE of
   * the instance; the compiled form returns the instance synchronously, so an
   * embedder that already has a profile keeps the original call shape.
   *
   *   // synchronous — you already have a profile
   *   const house = await HouseLoader.load('demo');
   *   const scene = Home3DScene.create(el, { house, interactive: true });
   *
   *   // asynchronous — let the engine fetch it
   *   const scene = await Home3DScene.create(el, { houseId: 'demo' });
   *
   * The module-level exports (ROOMS, LIGHTS, WALL_SEGMENTS_WORLD,
   * FOOTPRINT_BOUNDS, COORD_TRANSFORM, DOOR_LABELS_WORLD) are refreshed to the
   * house being rendered, so read them AFTER this resolves.
   *
   * @param {HTMLElement} container
   * @param {Object} opts
   * @param {Object}  opts.house       - a compiled house profile (preferred)
   * @param {string}  opts.houseId     - a profile id to load; returns a Promise
   * @param {string}  opts.fallbackHouseId - names the id that is allowed to be a
   *          default rather than an explicit choice. NOT a substitute: a houseId
   *          that cannot be loaded REJECTS rather than rendering another house
   *          (see loadWithFallback in src/house-loader.js).
   * @param {boolean} opts.interactive  - enable orbit/click (full page mode)
   * @param {boolean} opts.autoRotate   - slow auto-rotation (preview mode)
   * @param {number}  opts.pixelRatio   - override devicePixelRatio
   * @param {Function} opts.onRoomClick - callback(roomId) when a room is clicked
   * @param {boolean} opts.furniture   - false = build no furniture until
   *          setFurnitureVisible(true) (the page's ?furniture=0). Default true.
   * @param {Object}  opts.boundChannels - roomId -> [channel]: the light
   *          channels the house's rooms.json BINDS for each room. Each gets a
   *          lightState entry even when geometry draws no fixture for it, so
   *          a room's switch and its HA state do not depend on a fixture
   *          existing (an office whose only ambient light is a cornice and a
   *          desk strip still has its Ambient channel).
   * @returns {Object|Promise<Object>} the instance, or a Promise of it when
   *          `houseId` was given.
   */
  function create(container, opts = {}) {
    // The id form is asynchronous: fetch, compile, then build synchronously.
    if (!opts.house && opts.houseId) {
      // Was a `typeof HouseLoader === 'undefined'` check back when both files
      // were classic scripts and load order was the caller's problem. It is now
      // a static `import` at the top of this file, so the module graph makes
      // the dependency unmissable: if house-loader.js cannot be fetched, THIS
      // module never evaluates and create() is never reachable to begin with.
      // Keeping the old check would be worse than useless -- `typeof` on an
      // uninitialised import binding throws a TDZ ReferenceError rather than
      // returning 'undefined', so it could not fire the friendly error it
      // promises anyway.
      return HouseLoader.loadWithFallback(opts.houseId, opts.fallbackHouseId)
        .then(loaded => create(container, Object.assign({}, opts, { house: loaded, houseId: null })));
    }
    if (!opts.house) {
      throw new Error(
        'Home3DScene.create() requires a house: pass opts.house (a compiled profile from ' +
        'HouseLoader) or opts.houseId (a profile id under houses/). The engine no longer ' +
        'carries a built-in house.'
      );
    }
    // Bind the profile. Everything below — and every export — now describes it.
    useHouse(opts.house);

    const {
      interactive = false,
      autoRotate = false,
      rotateSpeed = 0.024, // radians/second (~262s per full turn — homepage preview default)
      pixelRatio = Math.min(devicePixelRatio, 2),
      onRoomClick = null,
      initialState = null,
      // ── Power/quality knobs (default to the original full-fat behaviour) ──
      // shadows: 'auto' = GPU-tier decides (original); 'low' = sun shadow only at
      //   1/4 map size, no room shadow lights; 'off' = no shadows at all.
      shadows = 'auto',
      // maxFps: 0 = uncapped (original). The preview tile passes a low cap (it's a
      //   tiny slowly-rotating thumbnail — 60–240fps was pure waste); the loop
      //   stays time-correct so rotation speed is unchanged.
      maxFps = 0,
      // antialias: cheap to drop on the preview tile (barely visible at 379x163).
      antialias = true,
      // ── Cold-start progress reporting (both optional) ─────────────────────
      // onCompileStart: fired when shader precompilation begins — the start of
      //   the one genuinely slow, genuinely progress-less phase (9-45s cold on
      //   the real house). Not fired at all when the renderer has no
      //   compileAsync, because then there is no such phase.
      // onReady: fired exactly once when the scene is ready to draw, on EVERY
      //   path including precompile failure and no-compileAsync. This is the
      //   signal a caller's loading overlay should dismiss on. Guaranteed
      //   single-shot, so it is safe to hang a latch off it.
      onCompileStart = null,
      onReady = null,
      // onFurnished(info): fired exactly once when the house is VISUALLY
      //   COMPLETE -- onReady has fired, the furniture is built, compiled and
      //   attached (or failed, or there is none), every boot-time image has
      //   loaded (or failed), and a frame has been drawn with all of it. Or
      //   BOOT_COMPLETE_FALLBACK_MS after onReady, whichever is first:
      //   info = { timedOut, pending, ms }. This is the signal the loading
      //   overlay dismisses on (it used to be onReady, which left the house
      //   empty for a second or more while the furniture arrived).
      // onFurnishProgress(done, total): the furniture build's item count, a
      //   few times a second while it runs.
      onFurnished = null,
      onFurnishProgress = null,
      // sensorBoundDoorIds: the door ids rooms.json binds a contact sensor to
      //   (any iterable of ids; the page passes its own Set). Doors NOT in it
      //   render CLOSED at rest — see DOOR_SENSOR_BOUND_IDS. Omitting it means
      //   "no door is sensor-bound", so every door rests closed: the correct
      //   reading for a profile with no HA wiring, and a safe default because
      //   it never claims a door is open on no evidence.
      sensorBoundDoorIds = null,
    } = opts;
    // Bound BEFORE buildScene() below, which is where the rest pose is baked in.
    DOOR_SENSOR_BOUND_IDS = new Set(sensorBoundDoorIds || []);

    const W = container.clientWidth, H = container.clientHeight;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0f0f1a);

    const cam = new THREE.PerspectiveCamera(50, W / H, 0.1, 200);
    // ─── Renderer construction, guarded ─────────────────────────────────────
    // create() previously assumed it always got a context. That was already
    // optimistic: WebGLRenderer THROWS FROM ITS CONSTRUCTOR when the browser
    // will not give it a context, so the failure never reached the capability
    // probe below and surfaced as a black rectangle plus one console line the
    // person holding the phone cannot open.
    //
    // NOTE THE PLACEMENT: this wraps `new THREE.WebGLRenderer(...)`, not the
    // ren.getContext()/getParameter() probe underneath. A try/catch around the
    // probe is the obvious-looking spot and would catch nothing, because
    // execution never gets there.
    //
    // This matters for real hardware. The tiering immediately below exists
    // because mobile Adreno parts advertise as few as 256 fragment uniform
    // vectors -- the WebGL spec minimum -- and one such Android device is a
    // primary target for this app. On the vendored r160 build such a device
    // still gets a context (r160 tries webgl2, then webgl, then
    // experimental-webgl) and degrades to the 'low' tier, which is why it
    // works today. This guard is for the genuinely context-less case.
    // WHY WE SUPPLY THE CANVAS: the browser explains *why* it refused a
    // context exactly once, in the `statusMessage` of a
    // `webglcontextcreationerror` event fired at the canvas. three.js listens
    // for that event, console.errors the reason, and then throws an Error
    // whose message has dropped it ("Error creating WebGL context."). So the
    // one fact that decides which advice is useful -- out of graphics memory
    // vs. no GPU at all -- is visible in the console and unreachable from the
    // throw. The event does not bubble, so it cannot be caught on document
    // either. Passing our own canvas is the only place we can attach a
    // listener and keep the reason.
    const glCanvas = document.createElement('canvas');
    // three.js's own createCanvasElement sets this, and supplying a canvas
    // replaces that default -- so without it the canvas is display:inline and
    // carries a baseline descender, measured at 4px of extra scrollHeight
    // (904 against a clientHeight of 900). Harmless here only because body
    // sets overflow:hidden; an embedded host without it would see the gap.
    glCanvas.style.display = 'block';
    let contextErrorReason = '';
    glCanvas.addEventListener('webglcontextcreationerror', (ev) => {
      // Both attempts below share this canvas, so the last reason wins --
      // which is the one belonging to the failure we ultimately report.
      if (ev && ev.statusMessage) contextErrorReason = String(ev.statusMessage);
    }, false);

    let ren;
    try {
      ren = new THREE.WebGLRenderer({ antialias, canvas: glCanvas });
    } catch (err) {
      // Retry once without antialiasing. three.js distinguishes "your selected
      // attributes were refused" from "no context at all" by asking a second
      // time with no attributes, but a canvas only ever produces one context,
      // so that second probe repeats the first failure and the distinction is
      // unreachable in practice -- measured, not assumed. Retrying and letting
      // the retry answer the question is what actually degrades. An aliased
      // house beats no house.
      if (antialias) {
        console.warn(
          '[home3d] WebGL renderer construction failed; retrying without antialiasing.',
          err
        );
        try {
          ren = new THREE.WebGLRenderer({ antialias: false, canvas: glCanvas });
        } catch (err2) {
          throw webglUnavailable(container, err2, contextErrorReason);
        }
      } else {
        throw webglUnavailable(container, err, contextErrorReason);
      }
    }
    ren.setSize(W, H);
    ren.setPixelRatio(pixelRatio);

    // ─── GPU capability tiering ─────────────────────────────────────────────
    // The scene uses ~64 lights (10 room shadow + ~24 main fixtures + ~12
    // ambient strips + sun + amb) → ~360+ fragment uniform vectors with
    // shadows. Desktop GPUs allow 1024+; mobile Adreno can advertise as low
    // as 256 (the WebGL minimum), in which case shaders fail to compile and
    // NOTHING renders — only the scene.background "sky" colour is visible.
    // We classify the GPU and skip the heaviest light categories on low tier.
    const gl = ren.getContext();
    const maxFragU = gl.getParameter(gl.MAX_FRAGMENT_UNIFORM_VECTORS);
    // The uniform count answers "will the shader compile?"; it says nothing
    // about fill rate. A mobile GPU (task b37115bc, src/quality-tier.js) is
    // capped at 'mid' and a pixel ratio of 1.5 whatever it reports, and
    // `opts.tier` (the page's ?tier=) overrides both for A/B testing -- never
    // above what the uniform budget compiles.
    let gpuName = '';
    try {
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      gpuName = String(gl.getParameter(dbg ? dbg.UNMASKED_RENDERER_WEBGL : gl.RENDERER) || '');
    } catch (e) { /* no name: the user agent decides */ }
    const gpu = detectMobileGpu({
      renderer: gpuName,
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
      coarsePointer: typeof matchMedia === 'function' ? matchMedia('(pointer: coarse)').matches : undefined,
      maxTouchPoints: typeof navigator !== 'undefined' ? navigator.maxTouchPoints : 0
    });
    const tierInfo = resolveTier({ maxFragU, mobileGpu: gpu.mobileGpu, override: opts.tier });
    // A mobile GPU that ?tier= has not pinned (?tier= lifts every mobile cap).
    const mobileGpu = tierInfo.mobileCaps;

    // ─── Adaptive quality (task 230713da, src/adaptive-quality.js) ─────────
    // The GPU class only picks where a device STARTS. Measured frame times
    // then move it: the pixel-ratio ceiling live (the loop below), and the
    // structural LEVEL -- tier, room shadows, minor furniture -- for the NEXT
    // load, because changing one of those under a running scene is a full
    // material recompile (see the shadow-ramp tombstone below). This load
    // builds exactly one level, once.
    //
    // Off, and the scene behaves exactly as before, when: ?tier= pins the
    // tier; the scene is the auto-rotating preview; or a frame-rate cap below
    // MIN_FPS_CAP puts the frame floor above the headroom threshold.
    // `opts.level` (the /diagnostics benchmark only; see src/diagnostics/)
    // pins the structural LEVEL -- any rung of the ladder, mid-lite and
    // ultra-lite included, which ?tier= cannot reach -- and turns adaptation
    // off so it neither fights the benchmark nor persists anything. Clamped to
    // what the uniform budget compiles. Absent (every normal caller), nothing
    // here changes.
    const levelPinned = !tierInfo.overridden && Number.isInteger(opts.level);
    const adaptiveOff = tierInfo.overridden ? '?tier= pins it'
      : levelPinned ? 'level pinned (diagnostics)'
      : autoRotate ? 'auto-rotating preview'
      : (maxFps > 0 && maxFps < MIN_FPS_CAP) ? `maxFps ${maxFps} < ${MIN_FPS_CAP}`
      : null;
    let qStorage = null;
    try { qStorage = typeof localStorage !== 'undefined' ? localStorage : null; } catch (e) { qStorage = null; }
    const qKey = storageKey(gpuName, maxFragU, shadows);
    const maxLevel = tierInfo.overridden ? levelForTier(tierInfo.tier) : maxLevelFor(tierInfo.compileTier);
    const levelCtx = { maxLevel, mobile: mobileGpu === true, shadows };
    // Settings > Quality (task e7e10870): a MANUAL level, per device and per
    // shadows= mode (so the page and the HA popup each keep their own), read
    // unless ?tier= or the diagnostics level pins the build, or this is the
    // auto-rotating preview. It wins over the adaptive record and locks the
    // ladder: only the pixel ratio adapts under it.
    const qPinKey = pinKey(gpuName, maxFragU, shadows);
    const pinAllowed = !tierInfo.overridden && !levelPinned && !autoRotate;
    const manualLevel = pinAllowed ? loadPin(qStorage, qPinKey, maxLevel) : null;
    const stored = adaptiveOff ? null : loadState(qStorage, qKey, maxLevel);
    const loadStart = resolveStart({ stored, pin: manualLevel, defaultLevel: defaultLevel(mobileGpu === true, maxLevel), wall: Date.now() });
    const startLevelIdx = tierInfo.overridden ? maxLevel
      : levelPinned ? Math.max(0, Math.min(maxLevel, opts.level))
      : loadStart.level;
    const levelFrom = tierInfo.overridden ? '?tier=' : levelPinned ? 'pinned' : loadStart.from;
    // The build. At a device's default level this is the pre-adaptive build
    // exactly (scripts/test-adaptive-quality.mjs compares every uniform tier
    // x shadows= value against the old formula): the `shadows` opt still
    // wins ('off' drops every shadow, 'low' the room-shadow lights and 3/4 of
    // the sun map), 'high' forces room-shadow lights only at the top level
    // (the old `!capped`), and a mobile GPU starts at mid-lite (PR #54).
    const startLevel = levelConfig(startLevelIdx, levelCtx);
    const tier = startLevel.tier;
    // Pixel ratio: the ramp's hard ceiling is the pixelRatio opt; a mobile GPU
    // STARTS at 1.5 and climbs past it only on measured headroom. With
    // adaptation off it keeps PR #54's hard 1.5 cap.
    const scenePixelRatio = (mobileGpu && adaptiveOff) ? Math.min(pixelRatio, MOBILE_START_RATIO) : pixelRatio;
    const dprStart = mobileGpu ? Math.min(scenePixelRatio, MOBILE_START_RATIO) : scenePixelRatio;
    if (scenePixelRatio !== pixelRatio) {
      ren.setPixelRatio(scenePixelRatio);
      ren.setSize(W, H);
    }
    const quality = {
      tier,
      maxFragU,
      mobileGpu,
      level: startLevelIdx,
      levelName: startLevel.name,
      // mid-lite (a mobile GPU's start) skips `priority: "minor"` furniture.
      dropMinorFurniture: startLevel.dropMinorFurniture,
      sunShadow: startLevel.sunShadow,
      roomShadowLights: startLevel.roomShadowLights,
      ambientStrips:    tier !== 'low',
      // Total cornice downlights (see buildScene). Ultra: uncapped; mid: 12
      // (84 fragment-uniform vectors); low builds none (ambientStrips off).
      corniceLightCap:  tier === 'ultra' ? null : 12,
      // ...and at most this many per cornice below ultra (null: 3 or 5).
      cornicePerCornice: tier === 'ultra' ? null : 2,
      shadowMapScale: startLevel.shadowMapScale,
      // Opt-in bespoke decoration (see the acoustic panels below). Empty by
      // default: a house gets only what its profile describes. The PROFILE is
      // the primary source — decor is per-house data, so a house that owns
      // slat panelling should render it wherever it is loaded, without the
      // embedding page having to know and pass a flag. The `decor` create()
      // option still works and is unioned in, for an embedder that wants to
      // add decoration on top of the profile's own.
      decor: (HOUSE.decor || []).concat(Array.isArray(opts.decor) ? opts.decor : []),
    };
    // The shadow configuration this scene was asked for, applied up front.
    //
    // There used to be a "progressive" ramp here that painted the first frames
    // with the shadow pass off and switched it on afterwards. Measured COLD on
    // the real 10-room house it was a net LOSS: toggling shadowMap.enabled
    // invalidates three.js's program cache and forces a full material
    // recompile (shader compiles 24 -> 36, program links 12 -> 18), and the
    // settled scene arrived at ~20s with the ramp versus ~14.7s without it.
    // The expensive part of a cold start is the first room-shadow pass, which
    // the ramp only delays rather than avoids.
    const wantShadows = quality.sunShadow || quality.roomShadowLights;
    ren.shadowMap.enabled = wantShadows;
    // Shadow maps are re-rendered ONLY when something asks for it (see
    // invalidateShadows() below). Left on, three re-renders every shadow map
    // on every rendered frame — and 10 of the 11 casters are PointLights, so
    // that is ~60 shadow renders of unmoved geometry per frame during a drag.
    // NOTE this is orthogonal to shadowMap.enabled, which must NOT be used as
    // a quality knob: toggling THAT invalidates the program cache and forces a
    // full material recompile (see the tombstone above). autoUpdate costs
    // nothing to change — it only gates when the maps refresh.
    // The first frame still needs one, and .enabled=true implies an initial
    // update, but be explicit rather than relying on it.
    ren.shadowMap.autoUpdate = false;
    ren.shadowMap.needsUpdate = wantShadows;
    // ─────────────────────────────────────────────────────────────────────────

    // Tone mapping, exposure, colour space and shadow type: src/render-rig.js,
    // shared with the spec pages so an item looks the same on both.
    applyRendererSettings(THREE, ren);
    ren.domElement.style.touchAction = 'none';
    container.appendChild(ren.domElement);

    // Furniture builders start loading NOW, in parallel with the scene build
    // and its precompile (plan amendment A2). Nothing is built until both are
    // done -- see the furniture block after the precompile below.
    let furnitureItems = (Array.isArray(HOUSE.furniture) ? HOUSE.furniture : [])
      .filter(item => !(quality.dropMinorFurniture && item.priority === 'minor'));
    let furnitureVisible = opts.furniture !== false;
    let furnitureModules = (furnitureItems.length && furnitureVisible)
      ? loadFurnitureModules(furnitureItems) : null;

    const { mainLights, mainMeshes, ambientLights, ambientMeshes, extraLights, extraMeshes, sun, ambLight, gndMat, wallMeshes, wallEntryById, ceilingMesh, clouds, doorByRoom, doorById, footstepsByRoom, curtainById, daylight, textureLoads, disposeWallpaperPlaceholder } = buildScene(scene, quality);
    {
      // The tier line, with what the tier actually built: light counts are
      // the per-pixel cost on a phone or tablet (every light, every fragment).
      const lc = { point: 0, spot: 0, spotShadow: 0, dir: 0 };
      scene.traverse(o => {
        if (!o.isLight) return;
        if (o.isPointLight) lc.point++;
        else if (o.isSpotLight) { lc.spot++; if (o.castShadow) lc.spotShadow++; }
        else if (o.isDirectionalLight) lc.dir++;
      });
      console.info(
        `[Home3DScene] Quality tier=${tier} ` +
        `(MAX_FRAGMENT_UNIFORM_VECTORS=${maxFragU}; mobileGpu=${gpu.mobileGpu} [${gpu.reason}]` +
        // Below what compiles because of the LEVEL this load was built at
        // (a mobile start, or a measured step down) -- not the GPU class.
        `${!tierInfo.overridden && tier !== tierInfo.compileTier ? '; capped from ' + tierInfo.compileTier : ''}` +
        `${tierInfo.overridden ? '; ?tier=' + opts.tier : ''}) ` +
        `shadows=${shadows} maxFps=${maxFps || 'uncapped'} pixelRatio<=${scenePixelRatio}. ` +
        `adaptive=${adaptiveOff ? 'off (' + adaptiveOff + ')' : 'on'} ` +
        `level=${startLevel.name} (${startLevelIdx}/${maxLevel}, ${levelFrom})` +
        `${adaptiveOff ? '' : ' dprStart=' + dprStart}. ` +
        `sunShadow=${quality.sunShadow} ` +
        `roomShadowLights=${quality.roomShadowLights} ` +
        `shadowMapScale=${quality.shadowMapScale} ` +
        `ambientStrips=${quality.ambientStrips}. ` +
        `lights: point=${lc.point} spot=${lc.spot} (shadowed ${lc.spotShadow}) dir=${lc.dir}`
      );
    }

    // ── On-demand render requests ──────────────────────────────────────────
    // A NON-auto-rotating scene (the #3d popup) only changes when the user moves
    // the camera, a light/sun/HA state changes, or an opacity transition is still
    // settling. These flags let the loop skip rendering entirely when idle
    // (≈0 GPU for an open-but-untouched popup) and snap straight to maxFps the
    // instant the user interacts. The auto-rotating preview ignores this (it
    // always has motion) and just runs at its maxFps cap. Declared before
    // syncLights() so a light change can requestRender() without a TDZ error.
    let needsRender = true;        // paint at least the first frame
    let wakeUntil = 0;             // keep rendering until this ts (post-interaction tail)
    let transitionsActive = true;  // wall/ceiling opacity still easing toward target
    // Total frames actually drawn. Exposed via getFrameCount() so the
    // on-demand gate can be VERIFIED rather than assumed: sample it, wait,
    // sample again, and an idle scene must return the same number. That is the
    // one property most easily lost by accident here, and reasoning about it
    // is no substitute for counting.
    let framesRendered = 0;
    function requestRender() { needsRender = true; }
    function wake(ms) { wakeUntil = Math.max(wakeUntil, performance.now() + (ms || 0)); needsRender = true; }

    // ── Explicit shadow invalidation ────────────────────────────────────────
    // shadowMap.autoUpdate is turned off after construction (below), so three
    // stops re-rendering every shadow map on every rendered frame and only
    // does it when we say so. This scene has ~11 shadow casters and 10 of them
    // are PointLights, whose shadow is a SIX-FACE CUBEMAP — so a frame that
    // redundantly re-renders them is paying for ~60 shadow renders of geometry
    // that did not move. During a sustained drag that is a real thermal cost
    // on a phone.
    //
    // ⚠️ The bargain: every mutation that changes what a shadow should look
    // like MUST call this, or the shadow silently goes stale. The sites are
    // enumerated at the call sites below; the rule is "if it moves geometry,
    // or changes a light's intensity/colour/visibility, or moves the sun, it
    // invalidates". Camera movement does NOT — shadow maps are rendered from
    // the LIGHT's point of view, so orbiting cannot stale them. That exclusion
    // is the entire point: updCam() fires on every drag frame, and invalidating
    // there would give back exactly the cost this is meant to save.
    //
    // needsUpdate is a ONE-SHOT: three resets it to false after the next
    // render, so this is "refresh once", not "turn updating back on".
    function invalidateShadows() {
      ren.shadowMap.needsUpdate = true;
      needsRender = true;
    }

    // ── Presence footsteps: bounded fade in AND out ─────────────────────────
    //
    // ⚠️ THE CONSTRAINT THIS DESIGN EXISTS TO SATISFY: footsteps are STATIC
    // once shown. They fade in when a room becomes occupied and fade out when
    // it empties, and in between they are simply drawn while the scene renders
    // ZERO frames. A continuously animating trail would keep the on-demand
    // gate open for as long as anyone is home — measured at roughly 45%
    // sustained main-thread occupancy when embedded in a dashboard sidebar, where
    // this scene runs in-page and shares the host page's thread. The fade is
    // bounded precisely so that cost is paid once per arrival, not forever.
    //
    // The fade is driven from the render loop's own dt and reports whether it
    // is still moving, so the existing `transitionsActive` settle logic is
    // what stops the rendering. There is deliberately NO timer here: a
    // setInterval re-arming wake() would defeat the gate while looking like it
    // respected it.
    const FOOTSTEP_FADE_MS = 500;   // the bounded fade, in each direction
    const FOOTSTEP_MAX_OPACITY = 0.55;
    // roomId -> { from, to, startedAt }.
    //
    // Interpolated from elapsed wall-clock time for the same reason the door
    // swing is — see the note there. The loop's dt is clamped to 0.1s, which
    // is a fifth of this fade in a single frame, so a dt-accumulating fade
    // would visibly step rather than glide on exactly the frame that matters.
    const footstepFades = new Map();

    function tickFootstepFades() {
      if (!footstepFades.size) return false;
      let moving = false;
      const now = performance.now();
      footstepFades.forEach((fd, roomId) => {
        const mesh = footstepsByRoom[roomId];
        if (!mesh) { footstepFades.delete(roomId); return; }
        const t = Math.min(1, (now - fd.startedAt) / FOOTSTEP_FADE_MS);
        mesh.material.opacity = fd.from + (fd.to - fd.from) * t;
        if (t >= 1) {
          // Arrived. Settle exactly on the target and STOP reporting movement,
          // which is what lets the scene fall back to zero frames.
          mesh.material.opacity = fd.to;
          if (fd.to === 0) mesh.visible = false;
          footstepFades.delete(roomId);
        } else {
          moving = true;
        }
      });
      return moving;
    }

    // ── Sensor-driven door swings: bounded, then still ──────────────────────
    //
    // Same shape as the footstep fade and for the same reason: the swing
    // advances toward a fixed target percentage and reports when it is still
    // moving, so the loop settles to zero frames the moment the leaf arrives.
    const DOOR_SWING_MS = 400;
    // doorId -> { from, to, startedAt }.
    //
    // ⚠️ Interpolated from ELAPSED WALL-CLOCK TIME, not by accumulating the
    // loop's dt. dt is clamped to 0.1s so a long idle cannot make the scene
    // jump, and the first frame after an idle scene wakes is exactly that
    // clamped 0.1s — a quarter of this animation's whole duration in one step.
    // A dt-accumulating version therefore covered the full 20% travel on its
    // very first frame and the door SNAPPED rather than swinging. Measured in
    // the browser: openPct read 20 on every one of twelve consecutive
    // animation frames. Time-based interpolation is immune, because the
    // fraction is derived from when the swing started rather than from how
    // coarse the frames happen to be.
    const doorSwings = new Map();

    function applyDoorPct(dr, pct) {
      dr.openPct = Math.max(0, Math.min(100, pct));
      dr.pivot.rotation.y = dr.swingSign * (dr.maxDeg * dr.openPct / 100) * Math.PI / 180;
    }

    function tickDoorSwings() {
      if (!doorSwings.size) return false;
      let moving = false;
      const now = performance.now();
      doorSwings.forEach((sw, doorId) => {
        const dr = doorById[doorId];
        if (!dr) { doorSwings.delete(doorId); return; }
        const t = Math.min(1, (now - sw.startedAt) / DOOR_SWING_MS);
        // Ease in-out, so the leaf starts and stops gently rather than
        // beginning at full speed.
        const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
        applyDoorPct(dr, sw.from + (sw.to - sw.from) * e);
        if (t >= 1) doorSwings.delete(doorId);
        else moving = true;
        // MOVES GEOMETRY — a door is a shadow caster, so without this the door
        // swings while its shadow stays where the door used to be. The single
        // most visible way to get this wrong. Paid per frame only for the
        // bounded duration of the swing, which is why the swing is bounded.
        invalidateShadows();
      });
      return moving;
    }

    // ── Curtains: HA-driven open/close, bounded like a door swing ───────────
    //
    // Two paces. A settled reading (a position with no motion) glides there
    // quickly; an 'opening'/'closing' state runs toward its end stop at a
    // motor-like pace, and the eventual settled reading corrects it. Both are
    // interpolated from elapsed wall-clock time (see doorSwings for why).
    const CURTAIN_SETTLE_MS_PER_100 = 2500;
    const CURTAIN_MOTOR_MS_PER_100 = 12000;
    const curtainMotions = new Map();   // id -> { from, to, startedAt, ms, pace }
    let lastCurtainShadowAt = 0;

    function tickCurtainMotions() {
      if (!curtainMotions.size) return false;
      let moving = false;
      const now = performance.now();
      curtainMotions.forEach((m, id) => {
        const e = curtainById[id];
        if (!e) { curtainMotions.delete(id); return; }
        const t = Math.min(1, (now - m.startedAt) / m.ms);
        const k = m.pace === 'settle' ? (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2) : t;
        e.built.setOpen(m.from + (m.to - m.from) * k);
        if (t >= 1) curtainMotions.delete(id);
        else moving = true;
      });
      updateDaylight();
      // MOVES GEOMETRY -- the fabric casts shadows. Throttled to ~4/s while
      // moving (a curtain travels for seconds, unlike a 400 ms door swing),
      // and always refreshed on arrival.
      if (!moving || now - lastCurtainShadowAt > 250) {
        lastCurtainShadowAt = now;
        invalidateShadows();
      }
      return moving;
    }

    // What the sun is doing now, recorded by updateSunlight() so the window
    // daylight can be recomputed when only a curtain moved:
    //   daylightSunF    0..1 daytime (the sky), daylightDirect 0..1 direct sun,
    //   daylightHigh    0..1 how high it is (0 horizon .. 1 at 40 deg+),
    //   daylightToSun   world unit vector toward the sun (the REAL one; the
    //                   light itself may be held steeper on the low tier).
    let daylightSunF = 0;
    let daylightDirect = 0;
    let daylightHigh = 0;
    let daylightToSun = [0, 1, 0];
    const daylightSunColor = new THREE.Color(1, 1, 1);
    const daylightSkyColor = new THREE.Color(1, 1, 1);

    // Each curtain on a window as a light filter: which along-wall spans its
    // fabric covers right now, where it hangs, and what gets through it.
    function curtainLayers(e) {
      const pctOf = id => (curtainById[id] ? curtainById[id].built.getOpen() : null);
      return e.curtains.map(cu => {
        const live = pctOf(cu.id);
        const pct = live != null ? live : cu.openPct;
        let tint = [1, 1, 1];
        if (cu.sheer) {
          const hex = cu.outerColor | 0;
          const c = [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];
          const m = Math.max(c[0], c[1], c[2]) || 1;
          tint = c.map(x => x / m);
        }
        return {
          id: cu.id, pct,
          covered: curtainCoverIntervals(cu, pct),
          across: cu.roomFace + cu.inDir * cu.offset,
          transmit: curtainTransmit(cu), tint
        };
      });
    }

    // Rebuild window floor meshes for the current sun and curtains: by day
    // the soft SKY pool, plus the SUN pool where direct sun comes in -- both
    // cut to the curtains' OPEN parts, with whatever comes through fabric
    // (a sheer) dimmed and tinted piece by piece. Runs when the sun moves
    // (60 s tick, a preset, a time pin) for every window, and when a curtain
    // moves for that window only, once its openness has changed by a
    // visible amount (curtainKey) -- never per frame for a still scene.
    function updateDaylightPools(only) {
      // Direct sun on a floor scales with how high the sun is (a low sun's
      // pool is long and faint), but never so far that a morning pool vanishes.
      const sunBase = daylightDirect * (0.5 + 0.5 * daylightHigh) * DAYLIGHT_SUN_POOL_GAIN;
      const skyK = daylightSunF * DAYLIGHT_SKY_POOL_GAIN;
      daylight.windows.forEach(e => {
        if (only && !only.has(e)) return;
        const layers = curtainLayers(e);
        e.curtainKey = layers.map(l => Math.round(l.pct * 4)).join(',');
        // Capped by the room's brightest floor so a light floor keeps its
        // texture instead of clipping to white (poolGainForFloor).
        const sunK = sunBase > 0 ? Math.min(sunBase, poolGainForFloor(DAYLIGHT_SUN_POOL_GAIN, e.floorAlbedo)) : 0;
        const posAttr = e.geo.attributes.position, uvAttr = e.geo.attributes.uv, colAttr = e.geo.attributes.color;
        const pos = posAttr.array, uv = uvAttr.array, col = colAttr.array;
        const cap = pos.length / 3;
        let n = 0;
        const put = (x, z, u, v, c, k, tint) => {
          if (n >= cap) return;
          pos[n * 3] = x; pos[n * 3 + 1] = e.poolY; pos[n * 3 + 2] = z;
          uv[n * 2] = u; uv[n * 2 + 1] = v;
          col[n * 3] = c.r * k * tint[0]; col[n * 3 + 1] = c.g * k * tint[1]; col[n * 3 + 2] = c.b * k * tint[2];
          n++;
        };
        if (skyK > 0.001) {
          windowSegments(e.span[0], e.span[1], layers).forEach(sg => {
            const sl = e.skySlice(sg.lo, sg.hi);
            [0, 2, 1, 1, 2, 3].forEach(i => put(sl.pts[i][0], sl.pts[i][1], sl.uv[i][0], sl.uv[i][1],
              daylightSkyColor, skyK * sg.transmit, sg.tint));
          });
        }
        const pieces = (sunK > 0.001 && e.roomPoly)
          ? windowLightPieces({ outer: e.outer, inner: e.inner, inward: e.inward,
              toSun: daylightToSun, room: e.roomPoly, floorY: 0,
              layers, rect: e.curtainRect, span: [e.span[0] - 1000, e.span[1] + 1000] })
          : [];
        pieces.forEach(pc => {
          // uv (0.5, 0) is the patch texture's full-strength texel: a sun pool
          // is evenly lit with a sharp edge, as direct sun is.
          const tris = THREE.ShapeUtils.triangulateShape(pc.poly.map(p => new THREE.Vector2(p[0], p[1])), []);
          tris.forEach(t => t.forEach(i => put(pc.poly[i][0], pc.poly[i][1], 0.5, 0,
            daylightSunColor, sunK * pc.transmit, pc.tint)));
        });
        e.mode = pieces.length ? 'sun' : (n ? 'sky' : 'none');
        e.pool = pieces.length ? pieces.map(pc => pc.poly) : null;
        e.pieces = pieces.map(pc => ({ transmit: pc.transmit, area: polyArea2(pc.poly) }));
        e.sunK = sunK;
        e.patch.visible = n > 0;
        e.geo.setDrawRange(0, n);
        posAttr.needsUpdate = true;
        uvAttr.needsUpdate = true;
        colAttr.needsUpdate = true;
      });
    }
    function polyArea2(poly) {
      let a = 0;
      for (let i = 0; i < poly.length; i++) {
        const p = poly[i], q = poly[(i + 1) % poly.length];
        a += p[0] * q[1] - q[0] * p[1];
      }
      return Math.abs(a) / 2;
    }

    function updateDaylight() {
      const pctOf = id => (curtainById[id] ? curtainById[id].built.getOpen() : null);
      // A curtain that moved re-cuts its window's pools (the light comes in
      // only through the open part); a still one costs a string compare.
      const moved = new Set();
      daylight.windows.forEach(e => {
        const d = windowDaylight(e.win, e.curtains, pctOf);
        e.transmit = d.transmit;
        e.tint = d.tint;
        const key = e.curtains.map(cu => {
          const live = pctOf(cu.id);
          return Math.round((live != null ? live : cu.openPct) * 4);
        }).join(',');
        if (key !== e.curtainKey) moved.add(e);
      });
      if (moved.size) updateDaylightPools(moved);
      // The room's shared daylight spot: placed at, and aimed through, the
      // windows actually letting light in -- weighted by width, curtain
      // transmission and whether the sun is coming through that window. The
      // old plain average pointed straight down from mid-room when a room had
      // windows on opposite walls (their inward vectors cancel); when the
      // weighted aim is that weak, the strongest window wins outright.
      const sunH = [daylightToSun[0], daylightToSun[2]];
      Object.keys(daylight.rooms).forEach(roomId => {
        const r = daylight.rooms[roomId];
        if (!r.light) return;
        let sw = 0, tr = 0, tint = [0, 0, 0], sunW = 0;
        let px = 0, py = 0, pz = 0, ix = 0, iz = 0, wsum = 0, best = null, bestW = -1;
        r.windows.forEach(e => {
          const w = e.win.w;
          sw += w; tr += e.transmit * w;
          tint = tint.map((c, i) => c + e.tint[i] * e.transmit * w);
          const facing = e.mode === 'sun' ? daylightDirect * Math.max(0, -(sunH[0] * e.inWorld[0] + sunH[1] * e.inWorld[1])) : 0;
          const wt = w * (0.05 + e.transmit) * (0.3 + facing);
          wsum += wt;
          sunW += facing * e.transmit * w;
          px += e.faceWorld[0] * wt; py += e.faceWorld[1] * wt; pz += e.faceWorld[2] * wt;
          ix += e.inWorld[0] * wt; iz += e.inWorld[1] * wt;
          if (wt > bestW) { bestW = wt; best = e; }
        });
        if (wsum > 0) { px /= wsum; py /= wsum; pz /= wsum; }
        let il = Math.hypot(ix, iz);
        if (best && il < 0.35 * wsum) {
          [px, py, pz] = best.faceWorld;
          [ix, iz] = best.inWorld;
          il = 1;
        }
        il = il || 1;
        ix /= il; iz /= il;
        r.light.position.set(px + ix * 0.25, Math.min(WH - 0.1, py + 0.4), pz + iz * 0.25);
        r.light.target.position.set(px + ix * 2.2, 0, pz + iz * 2.2);
        r.light.target.updateMatrixWorld();
        const transmit = sw ? tr / sw : 0;
        // Intensity only -- never `visible`: toggling a light's visibility
        // changes the light count and forces every lit material to recompile.
        r.light.intensity = daylightSunF * transmit * DAYLIGHT_SPOT_GAIN;
        // Sky-coloured, warming toward the sun's colour as sun comes in.
        const sunFrac = tr > 0 ? Math.min(1, sunW / tr) : 0;
        const base = [
          daylightSkyColor.r + (daylightSunColor.r - daylightSkyColor.r) * sunFrac,
          daylightSkyColor.g + (daylightSunColor.g - daylightSkyColor.g) * sunFrac,
          daylightSkyColor.b + (daylightSunColor.b - daylightSkyColor.b) * sunFrac
        ];
        const norm = tr > 0 ? tr : 1;
        r.light.color.setRGB(base[0] * tint[0] / norm, base[1] * tint[1] / norm, base[2] * tint[2] / norm);
      });
    }

    // ── Adaptive pixel ratio ────────────────────────────────────────────────
    // setPixelRatio is the ONE meaningful quality knob with no shader
    // recompile — it reallocates the drawing buffer and nothing else. Every
    // other knob worth having (shadow-casting light count, shadowMap.enabled,
    // shadowMap.type, antialias) forces a full material recompile or a new
    // WebGL context. See the shadow-ramp tombstone above: that is why the
    // obvious "start low, upgrade later" adaptive-quality design does not
    // work here, and why THIS is the fragment of it that does.
    //
    // TWO independent consumers drive the same knob, so they are deliberately
    // expressed as ONE resolver rather than two callers racing to write it:
    //
    //   basePixelRatio    the ratio this scene was constructed with. A hard
    //                     upper bound — the preview tile is handed 1 by its
    //                     embedder and must never be raised above it.
    //   ceilingRatio      the post-load ramp's current allowance. Starts at
    //                     RAMP_START on a scene that ramps, and rises toward
    //                     basePixelRatio once measured frame headroom allows.
    //   interactionRatio  the cap applied while the user is actively moving
    //                     the camera (the Blender-viewport technique: noisier
    //                     while you navigate, settles when you stop).
    //
    // The applied value is always min(ceiling, interacting ? cap : ceiling).
    // Because the ramp only ever moves the CEILING and the drag only ever
    // moves the CAP, and the applied value is their minimum, an in-flight
    // ramp-up structurally CANNOT stomp a drag-triggered ramp-down — there is
    // no ordering in which the two can oscillate against each other.
    const basePixelRatio = scenePixelRatio;
    // The two diagnostics knobs (instance.diagnostics, the /diagnostics
    // benchmark only). Inert at their defaults: a null pin leaves the resolver
    // below as it was, and `false` leaves the on-demand gate as it was.
    let diagPixelRatio = null;
    let diagContinuous = false;
    // Cap while dragging. Held at 1 rather than 0.75: below 1 the softening
    // reads as a defect on a phone rather than as responsiveness, and the win
    // from 1 -> 0.75 is a further 44% of a buffer that is already the smaller
    // cost once shadows dominate the frame.
    const interactionRatio = Math.min(1, basePixelRatio);

    // ── Post-load resolution ramp ───────────────────────────────────────────
    // First paint at RAMP_START, then raise toward basePixelRatio once
    // MEASURED frame time says there is headroom. Frame time is the honest
    // signal for this workload: navigator.deviceMemory and .connection do not
    // exist on iOS Safari, and the existing MAX_FRAGMENT_UNIFORM_VECTORS probe
    // already predicts capability better than either.
    //
    // Deliberately NOT the "YouTube adaptive bitrate" design. That analogy
    // breaks here: ABR works because quality costs BANDWIDTH — continuously
    // variable, nearly free to switch — whereas the dimensions that actually
    // drive this app's startup cost (shadow-casting light count,
    // shadowMap.enabled) cost a discrete, one-time, expensive shader
    // recompile. Ramping THOSE means paying the cheap compile and then the
    // expensive one anyway; it was built, measured at ~20s vs ~14.7s, and
    // removed (tombstone above). Pixel ratio is the exception, so the ramp
    // runs on pixel ratio ALONE — genuinely useful, honestly modest.
    //
    // Only ramps when there is something to ramp TO. A scene already at or
    // below the start ratio (the preview tile, handed 1) never ramps at all.
    const RAMP_START = Math.min(1, basePixelRatio);
    const RAMP_SETTLE_MS = 900;   // ignore the first frames: shader compile/link
    const RAMP_SAMPLES = 20;      // consecutive good frames required
    // Budget for the ren.render() CALL, not for a whole frame. CPU-side
    // submission time, so the bar is well under a 16.7ms frame: a device that
    // cannot submit this scene in 8ms has no headroom to spend on 4x the
    // pixels. Deliberately conservative — the cost of not ramping is a
    // slightly soft image, the cost of ramping a device that cannot take it
    // is a scene that janks for the whole session.
    const RAMP_BUDGET_MS = 8;
    // Hard stop. The ramp drives its own frames while measuring, so without a
    // deadline a device that never meets the budget would render continuously
    // forever — turning an idle-at-zero-GPU scene into a permanently busy one,
    // which is far worse than the soft image the ramp was trying to fix. On
    // expiry the scene simply stays at the start ratio and goes idle.
    const RAMP_DEADLINE_MS = 6000;
    // Ratios below this apart are the same ratio. Without it, a
    // basePixelRatio fractionally above 1 (some browsers report
    // 1.0000000149011612) makes RAMP_START collapse to exactly 1 via
    // Math.min(1, basePixelRatio), so ceilingRatio === basePixelRatio never
    // holds and a full self-driven ramp runs for a ~1.5e-8 resolution gain —
    // pure wasted draw calls, no visible change. Shared with applyPixelRatio
    // below so "done ramping" and "no-op re-apply" agree on what "the same
    // ratio" means.
    const RATIO_EPSILON = 0.001;
    let ceilingRatio = basePixelRatio > RAMP_START ? RAMP_START : basePixelRatio;
    let rampDone = ceilingRatio >= basePixelRatio - RATIO_EPSILON;
    let rampStartedAt = 0;        // set on the first rendered frame
    let rampGoodFrames = 0;
    let appliedRatio = ceilingRatio;

    // The renderer was constructed at basePixelRatio (see setPixelRatio above),
    // so when the ramp starts lower the FIRST PAINT has to be re-asserted here
    // — otherwise the ramp is a no-op that only ever ramps "up" to a value the
    // scene was already using, and the cheap first frame never happens.
    // setSize() is what makes setPixelRatio() take effect, so both are needed.
    if (ceilingRatio !== basePixelRatio) {
      ren.setPixelRatio(ceilingRatio);
      ren.setSize(W, H);
    }

    // Apply a resolved ratio. setPixelRatio() ALONE DOES NOTHING — it records
    // the ratio and only takes effect on the next setSize(), so the two must
    // always travel together. Guarded on a change: setSize reallocates the
    // drawing buffer, so re-applying the same value every frame would be a
    // per-frame realloc rather than a no-op.
    function applyPixelRatio(next) {
      if (Math.abs(next - appliedRatio) < RATIO_EPSILON) return;
      const w = container.clientWidth, h = container.clientHeight;
      if (w === 0 || h === 0) return; // detached/collapsed: leave it for resize
      appliedRatio = next;
      ren.setPixelRatio(next);
      ren.setSize(w, h);
      needsRender = true;
    }

    // Resolve the ratio for the current frame. `interacting` is passed in from
    // the loop, which already computes it.
    function resolvePixelRatio(interacting) {
      // The diagnostics pin (instance.diagnostics.setPixelRatio) beats the
      // ramp, the adaptive ceiling and the drag cap. null in normal use.
      if (diagPixelRatio != null) return diagPixelRatio;
      return interacting ? Math.min(ceilingRatio, interactionRatio) : ceilingRatio;
    }

    // Sample one rendered frame's cost and raise the ceiling once a run of
    // frames comes in under budget. Called from the loop with the measured
    // frame delta.
    //
    // Frames spent INTERACTING are skipped, not counted as bad: the whole
    // point of the drag ramp-down is that those frames are cheap for a
    // different reason, so letting them satisfy the headroom test would raise
    // the ceiling on evidence that says nothing about the cost of rendering at
    // full resolution. A bad frame resets the run rather than aborting the
    // ramp — a single hitch (a GC pause, the sun update) should not disqualify
    // a device forever.
    function sampleRampFrame(frameNow, frameMs, interacting) {
      if (rampDone) return;
      if (!rampStartedAt) { rampStartedAt = frameNow; return; }
      // Let shader compile/link and the first paints get out of the way; those
      // frames are one-time cost and would fail every device.
      // Keep the loop alive while measuring. This scene renders ON DEMAND, so
      // left alone after load it paints its opening frames and then stops —
      // and a ramp that waits for RAMP_SAMPLES consecutive frames would simply
      // never complete. MEASURED: untouched for 10s, the scene sat at the
      // start ratio forever, which would have shipped a PERMANENTLY softer
      // image than today's for any user who does not immediately drag.
      // Requesting the next frame is what makes the ramp self-driving; it ends
      // the moment the ramp resolves, so the idle-at-zero-GPU property is
      // preserved for the whole life of the scene bar this one short window.
      if (frameNow - rampStartedAt > RAMP_DEADLINE_MS) {
        rampDone = true; // give up: stay at RAMP_START and let the scene idle
        console.info(
          `[Home3DScene] Resolution ramp: stayed at ${RAMP_START} — no sustained ` +
          `headroom within ${RAMP_DEADLINE_MS}ms.`
        );
        return;
      }
      needsRender = true;
      if (frameNow - rampStartedAt < RAMP_SETTLE_MS) return;
      if (interacting) return;
      if (frameMs > RAMP_BUDGET_MS) { rampGoodFrames = 0; return; }
      if (++rampGoodFrames < RAMP_SAMPLES) return;
      rampDone = true;
      ceilingRatio = basePixelRatio;
      needsRender = true; // repaint at the new resolution
      console.info(
        `[Home3DScene] Resolution ramp: ${RAMP_START} -> ${basePixelRatio} ` +
        `after ${RAMP_SAMPLES} frames under ${RAMP_BUDGET_MS}ms.`
      );
    }

    // ── Adaptive quality: the live half (task 230713da) ─────────────────────
    // With adaptation on, this REPLACES the ramp above (which still runs,
    // unchanged, when it is off -- ?tier=, the preview, a low fps cap). The
    // ramp's one jump (RAMP_START -> the start ratio) is now the controller's
    // first up-decision, and the controller can then keep going: +/- DPR
    // notches live, and a structural level proposed for the NEXT load.
    //
    // THE SIGNAL is the interval between consecutive RENDERED frames, not the
    // ren.render() call's CPU time the ramp uses. WebGL is asynchronous, so the
    // CPU time under-reads a fill-bound frame -- exactly how a tablet GPU
    // fails -- whereas a GPU that cannot keep up stretches the rAF cadence.
    // A sample only counts when the previous tick rendered too (or was skipped
    // by the maxFps cap alone): `frameContinuous`, cleared by every early
    // return below, so an idle gap on this on-demand scene is never a sample.
    //
    // PROBES: the scene idles at zero frames, so measuring needs frames. A
    // probe self-drives rendering (as the ramp did) for at most PROBE_MS,
    // once after warm-up and once after each DPR step to verify it, and ends
    // the moment the controller reaches a verdict. Bounded per session by
    // MAX_PROBES and PROBE_BUDGET_MS. Otherwise the controller only sees
    // naturally continuous runs (drag tails, fades, doors), so a tablet that
    // throttles later is still caught without a single forced frame.
    const PROBE_MS = 4000;
    const MAX_PROBES = 6;
    const PROBE_BUDGET_MS = 20000;
    // In active use, one short probe at most this often, outside the load
    // budget. Drag frames are drawn at the reduced interaction ratio and so
    // say nothing about the ceiling; without this, a tablet that heats up
    // during a long session would only be caught by the odd fade or door
    // swing. Only after an interaction in the last minute, never while one
    // is in progress: an untouched scene still costs zero frames.
    const MAINT_PROBE_EVERY_MS = 180000;
    const MAINT_PROBE_MS = 2500;
    const MAINT_ACTIVE_MS = 60000;
    // After onReady, and again after the furniture attaches: the time-sliced
    // furniture build and its first frames would read as slow frames.
    const WARMUP_MS = 900;
    const RESUME_QUIET_MS = 1000;
    // A ratio this level failed above on an earlier load (plan r2, M3): the
    // session starts under it instead of re-trying the failed notch.
    // resolveStart() keeps a cap only for the level it was learnt at.
    const storedCap = loadStart.dprCap;
    const adaptive = adaptiveOff ? null : createController({
      floor: RAMP_START, startRatio: dprStart, maxRatio: basePixelRatio,
      level: startLevelIdx, ctx: levelCtx, blocked: loadStart.blocked,
      dprCap: storedCap ? storedCap.ratio : null,
      defaultLevel: defaultLevel(mobileGpu === true, maxLevel),
      // A floor failure at this level on an earlier load (mobile; see
      // floorFailure() in src/adaptive-quality.js).
      strike: loadStart.strike,
      // A manual level: the ladder does not move, only the pixel ratio.
      locked: loadStart.locked
    });
    // The cold frames (plan r2, M5): the ren.render() time of the first
    // rendered frames after onReady and after the furniture attaches -- the
    // frames that pay the full shadow pass. Counted down per phase.
    let coldFramesLeft = adaptive ? 5 : 0;
    // The display's refresh, from rAF tick-to-tick deltas (every tick, drawn
    // or not), and the cadence the fps cap allows on it (plan r2, M1).
    const tickDeltas = [];
    let lastTickTs = 0;
    let ticksSinceVsync = 0;
    let lastTickDelta = 0;
    // Browser-side rAF throttling (see rafThrottle): the deltas of IDLE ticks
    // only -- consecutive ticks on which the on-demand gate found nothing to
    // draw -- so our own GPU work can never be what slowed them.
    const idleDeltas = [];
    let gateIdleTicks = 0;
    let throttleNoted = false;
    // True while frame times cannot be trusted: the browser throttles rAF, or
    // there is not yet enough idle evidence to know it does not (so a probe
    // waits for the scene to have idled for a few ticks first).
    function browserThrottled() {
      if (idleDeltas.length < 5) return true;
      const t = rafThrottle(idleDeltas);
      if (t.throttled !== throttleNoted) {
        throttleNoted = t.throttled;
        console.info(t.throttled
          ? `[Home3DScene] Adaptive quality: paused -- the browser is holding animation frames at ~${t.fps} fps ` +
            'while the scene is idle (power saving, or a background window), so frame times say nothing about the GPU.'
          : '[Home3DScene] Adaptive quality: animation frames are no longer throttled; measuring again.');
        notifyQuality();
      }
      return t.throttled;
    }
    const UNMEASURED_JUMP_MS = 8000;
    let vsyncMs = 0;
    let cadenceMs = 0;
    let dprCapState = storedCap;
    let frameContinuous = false;
    let prevRenderAt = 0;
    // When to probe, and when to jump to the start ratio unmeasured: the
    // decisions live in createProbeScheduler (src/adaptive-quality.js, task
    // 7991c667) so a test can drive them; the side effects stay here.
    const probes = createProbeScheduler({
      enabled: !!adaptive,
      probeMs: PROBE_MS, maxProbes: MAX_PROBES, budgetMs: PROBE_BUDGET_MS, warmupMs: WARMUP_MS,
      maintEveryMs: MAINT_PROBE_EVERY_MS, maintMs: MAINT_PROBE_MS, maintActiveMs: MAINT_ACTIVE_MS,
      unmeasuredJumpMs: UNMEASURED_JUMP_MS,
      throttled: browserThrottled,
      throttleNoted: () => throttleNoted,
      jumpToStart: () => adaptive.jumpToStart(),
      applyJump(d, noted) {
        applyAdaptiveDecision(d, noted
          ? 'the browser is throttling frames, so no measurement'
          : 'no idle frames to judge the browser by, so no measurement');
        notifyQuality();
      },
      // Bounded, so a build that never lands cannot stop probing.
      furnitureBusy: now => furnitureStarted && !furnitureResult && now - furnitureTimeline.start < 30000,
      onSettled: () => logAdaptiveSettled()
    });
    let adaptiveSettledLogged = false;
    let storageWarned = false;
    const qualityListeners = [];

    function levelName(l) { return l == null ? null : LEVELS[l].name; }
    // Set by resetQuality(): the rest of this session writes nothing, so a
    // Re-measure cannot be undone by a decision, a settle or a maintenance
    // probe that lands afterwards. The next load starts from the default.
    let qualityForgotten = false;
    function persistQuality(extra) {
      // A manual level writes nothing: Auto resumes from the record as it was.
      if (!adaptive || qualityForgotten || adaptive.locked) return;
      const ok = saveState(qStorage, qKey, recordFor(adaptive, startLevelIdx, dprCapState, extra));
      if (!ok && !storageWarned) {
        storageWarned = true;
        console.info('[Home3DScene] Adaptive quality: storage unavailable; adapting for this session only.');
      }
    }
    function qualityStatus() {
      const pending = adaptive && !qualityForgotten ? adaptive.pending : null;
      const blocked = adaptive && adaptive.blocked && (Date.now() < adaptive.blocked.until || adaptive.blocked.loadsLeft > 0) ? adaptive.blocked : null;
      const pinNext = pinAllowed ? loadPin(qStorage, qPinKey, maxLevel) : null;
      return {
        adaptive: !!adaptive,
        reason: adaptiveOff || (throttleNoted ? 'paused: the browser is throttling frames'
          : probes.wantProbe || probes.probing ? 'measuring' : 'settled'),
        // Settings > Quality (task e7e10870). mode: 'manual' (a pinned
        // level), 'auto' (the ladder), or 'fixed' (?tier=, diagnostics, the
        // preview, or a low fps cap: nothing to choose). `pin` is what this
        // load was built with, `pinNext` what the next load will use; they
        // differ after a change until the reload. `levels`: the choices, with
        // why an unavailable one is unavailable.
        mode: levelFrom === 'manual' ? 'manual' : adaptive ? 'auto' : 'fixed',
        canPin: pinAllowed,
        pin: levelFrom === 'manual' ? startLevelIdx : null,
        pinNext,
        // Named as the cheapest level that builds the same thing (task
        // e7e10870 r2): ultra in the popup is High, as Settings lists it.
        levelLabel: LEVEL_LABELS[equivalentLevel(startLevelIdx, levelCtx)],
        levelLabelName: LEVELS[equivalentLevel(startLevelIdx, levelCtx)].name,
        levels: pinAllowed ? levelOptions(levelCtx) : [],
        level: startLevelIdx, levelName: startLevel.name, levelFrom, maxLevel, tier,
        dpr: ceilingRatio, dprStart: adaptive ? dprStart : null, dprMax: basePixelRatio,
        dprCap: adaptive && adaptive.sessionMax < basePixelRatio ? adaptive.sessionMax : null,
        p95: adaptive && Number.isFinite(adaptive.lastP95) ? Math.round(adaptive.lastP95 * 10) / 10 : null,
        thresholds: adaptive && adaptive.lastThresholds ? {
          up: Math.round(adaptive.lastThresholds.up * 10) / 10, down: Math.round(adaptive.lastThresholds.down * 10) / 10 } : null,
        vsyncMs: vsyncMs ? Math.round(vsyncMs * 100) / 100 : null,
        nextLevel: pending, nextLevelName: levelName(pending),
        nextLevelLabel: pending == null ? null : LEVEL_LABELS[pending],
        // Levels at or above this are not proposed until `until`.
        blockedFrom: blocked ? { level: blocked.level, levelName: levelName(blocked.level), until: blocked.until, loadsLeft: blocked.loadsLeft || 0 } : null
      };
    }
    function notifyQuality() {
      const s = qualityStatus();
      for (let i = 0; i < qualityListeners.length; i++) {
        try { qualityListeners[i](s); } catch (e) { /* a listener must not break the loop */ }
      }
    }
    function endProbe(now) { probes.end(now); }
    // Called from the loop, before the on-demand gate: start or continue a
    // probe. Returns true while one is running (the loop then keeps drawing).
    function tickProbe(now, interacting) { return probes.tick(now, interacting); }
    function logAdaptiveSettled() {
      if (adaptiveSettledLogged || !adaptive) return;
      adaptiveSettledLogged = true;
      const pending = adaptive.pending;
      const t = adaptive.lastThresholds;
      console.info(
        `[Home3DScene] Adaptive quality settled: level=${startLevel.name} DPR ${ceilingRatio}` +
        `${Number.isFinite(adaptive.lastP95) ? ' p95 ' + adaptive.lastP95.toFixed(1) + ' ms' : ' (no measurement)'}` +
        `${t ? ' (up < ' + t.up.toFixed(1) + ', down > ' + t.down.toFixed(1) + ' ms)' : ''}` +
        `${pending != null ? '; next load: ' + levelName(pending) : '; next load: same'}` +
        ` (${probes.probesRun} probe${probes.probesRun === 1 ? '' : 's'}, ${Math.round(probes.probeSpentMs)} ms).`
      );
      persistQuality({ settled: { level: startLevelIdx, dpr: ceilingRatio,
        p95: Number.isFinite(adaptive.lastP95) ? Math.round(adaptive.lastP95 * 10) / 10 : null, at: Date.now() } });
      notifyQuality();
    }
    // Apply and report one controller decision (a verdict's, or a cold frame's).
    function applyAdaptiveDecision(d, why) {
      if (d.to != null) { ceilingRatio = d.to; needsRender = true; }
      if (d.cap != null) dprCapState = { level: startLevelIdx, ratio: d.cap, until: Date.now() + BLOCK_MS };
      const bits = [];
      if (d.to != null) bits.push(`DPR ${d.to}`);
      if (d.revoke) bits.push('next-load step up withdrawn');
      if (d.proposeLevel != null) bits.push(`next load: ${levelName(d.proposeLevel)}`);
      if (d.block) bits.push(`${levelName(d.block.level)} and above blocked for 7 days${d.block.loadsLeft ? ' and ' + d.block.loadsLeft + ' loads' : ''}`);
      if (d.strike) bits.push(`strike at ${levelName(d.strike.level)} (the next load that fails at DPR ${adaptive.floor} steps it down)`);
      if (d.strikeCleared) bits.push('earlier strike cleared');
      console.info(`[Home3DScene] Adaptive quality: ${why} at DPR ${d.from} (level ${startLevel.name}) -> ${bits.join('; ')}.`);
      if (d.proposeLevel != null || d.revoke || d.block || d.cap != null || d.strike || d.strikeCleared) persistQuality();
      // A step down after "settled" re-opens the record of where it settled.
      if (d.kind === 'down') adaptiveSettledLogged = false;
    }
    function onAdaptiveVerdict(r, now) {
      const d = r.decision;
      if (d) {
        const t = r.thresholds;
        applyAdaptiveDecision(d, `p95 ${r.p95.toFixed(1)} ms over ${r.samples} frames, ` +
          (d.kind === 'up' ? `headroom (< ${t.up.toFixed(1)} ms)` : `too slow (> ${t.down.toFixed(1)} ms)`) +
          `, sustained`);
      }
      if (r.verdict !== 'pending') {
        endProbe(now);
        // Verify a DPR step with one more probe; anything else is an answer.
        probes.wantProbe = !!(d && d.to != null);
        if (!probes.wantProbe) logAdaptiveSettled();
      }
      notifyQuality();
    }
    // The first frames of a load pay the full shadow pass (and any compile
    // the precompile missed). The rolling p95 excludes them by design, so they
    // are judged on their own: see coldFrame() in src/adaptive-quality.js.
    function sampleColdFrame(renderMs) {
      if (!adaptive || coldFramesLeft <= 0) return;
      coldFramesLeft--;
      const d = adaptive.coldFrame(renderMs, Date.now());
      if (!d) return;
      coldFramesLeft = 0;
      applyAdaptiveDecision(d, `a cold frame blocked ${Math.round(renderMs)} ms (> ${COLD_FRAME_MS} ms)`);
      notifyQuality();
    }

    // ── Shader precompile, off the critical path ───────────────────────────
    // three.js builds a program the first time a material is drawn, and the
    // driver finishes the link lazily -- the stall surfaces later, when three
    // reads the program back (its info log / uniforms / attributes). Measured
    // cold on the real house that is one frame blocking for tens of seconds.
    //
    // renderer.compileAsync() does the same work ahead of time, polling
    // program.isReady() via KHR_parallel_shader_compile instead of blocking on
    // the driver, and finishes in ~2.5s. The programs built are the same ones,
    // from the same materials, so NOTHING about the rendered image changes --
    // only when the work happens.
    //
    // Note this is an INSTANCE method in r160; WebGLRenderer.prototype
    // .compileAsync is undefined, so feature-detect on `ren`, not the prototype.
    //
    // onReady fires when the scene is genuinely ready to show something, which
    // is the point the caller's loading affordance should come down. It is
    // called EXACTLY ONCE on every path below, including the failure and the
    // no-compileAsync ones — a caller hiding an overlay here must never be
    // left waiting on a callback that cannot arrive.
    let readyFired = false;
    // The scene's own precompile, AFTER its catch and shadowMap restore, so it
    // always resolves and resolves only once the house's programs exist. The
    // furniture waits on this (review nit 2), never on the raw compileAsync.
    let precompileDone = Promise.resolve();
    // See the fallback timer and the context-restored listener below.
    const READY_FALLBACK_MS = 10000;
    let readyFallbackTimer = null;
    let onGlContextRestored = null;
    // ── Boot-complete gate (src/boot-gate.js; 2026-10-06) ──────────────────
    // onReady means "the house can draw"; onFurnished means "the house is
    // finished". The overlay waits for the second. The waits are registered
    // below (house here, then furniture and images after startFurniture),
    // and the gate completes on the first frame drawn after all of them
    // settle. The fallback runs from onReady, not from create(): the house
    // precompile before it has its own 10 s fallback, and a cold one alone
    // can take most of that.
    const BOOT_COMPLETE_FALLBACK_MS = 15000;
    let houseReadyResolve;
    const bootGate = createBootGate({
      requestFrame: () => requestRender(),
      onDone: info => {
        if (info.timedOut) {
          console.warn('[Home3DScene] the house was not complete ' + BOOT_COMPLETE_FALLBACK_MS +
            ' ms after onReady (still waiting on: ' + (info.pending.join(', ') || 'a drawn frame') +
            '); dismissing the loading overlay anyway.');
        }
        if (typeof onFurnished === 'function') {
          try { onFurnished(info); } catch (e) { console.warn('[Home3DScene] onFurnished threw.', e); }
        }
      }
    });
    bootGate.wait('house', new Promise(r => { houseReadyResolve = r; }));
    function fireReady() {
      if (readyFired) return;
      readyFired = true;
      houseReadyResolve();
      bootGate.startTimeout(BOOT_COMPLETE_FALLBACK_MS);
      if (typeof onReady === 'function') {
        // Never let a caller's callback break scene construction.
        try { onReady(); } catch (e) { console.warn('[Home3DScene] onReady threw.', e); }
      }
    }

    // See the precompile below. One stand-in per distinct shadow SIDE the
    // scene's casters need: three draws a caster's shadow with
    // material.shadowSide, or else its side flipped (Front -> Back, Back ->
    // Front, Double stays Double), and the side is part of the program key.
    // The real house's casters are all DoubleSide, so guessing BackSide (the
    // furniture's choice, right for ITS materials) compiled a program the
    // shadow pass never used -- derive it instead. Resolves once every
    // stand-in's program is ready; always frees what it made.
    const SHADOW_SIDE = { [THREE.FrontSide]: THREE.BackSide, [THREE.BackSide]: THREE.FrontSide, [THREE.DoubleSide]: THREE.DoubleSide };
    function shadowDepthSides(root) {
      const sides = new Set();
      root.traverseVisible(o => {
        if (!o.isMesh || !o.castShadow || !o.material) return;
        (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => {
          sides.add(m.shadowSide != null ? m.shadowSide : SHADOW_SIDE[m.side]);
        });
      });
      return [...sides].filter(v => v !== undefined);
    }
    // The stand-in materials are KEPT until dispose(). Freeing one releases
    // its program (three deletes a program the moment nothing uses it), so
    // disposing them as soon as the precompile resolved threw the compiled
    // program away before the shadow pass could reuse it -- measured: the
    // first frame rebuilt it anyway. They cost a few bytes each.
    const shadowDepthProbeMats = [];
    function precompileShadowDepth() {
      const geo = new THREE.BoxGeometry(0.01, 0.01, 0.01);
      const mats = shadowDepthSides(scene).map(side =>
        new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, side }));
      shadowDepthProbeMats.push(...mats);
      const rt = new THREE.WebGLRenderTarget(1, 1);
      const prev = ren.getRenderTarget();
      const pending = [];
      try {
        ren.setRenderTarget(rt);
        mats.forEach(mat => pending.push(ren.compileAsync(new THREE.Mesh(geo, mat), cam, scene)));
      } finally {
        ren.setRenderTarget(prev);
      }
      // The geometry and render target were only the vehicle; the programs
      // live on the materials, so these two can go now.
      const free = () => { rt.dispose(); geo.dispose(); };
      return Promise.all(pending).then(free, e => { free(); throw e; });
    }

    if (typeof ren.compileAsync === 'function') {
      // Shadow programs are a separate set from the beauty-pass ones, so make
      // sure the precompile covers them too when this scene uses shadows.
      const shadowWasEnabled = ren.shadowMap.enabled;
      ren.shadowMap.enabled = wantShadows;
      // Tell the caller the multi-second, progress-less phase has begun. This
      // is the ONLY milestone worth naming: everything before it is a couple
      // of hundred milliseconds, and everything inside it is opaque.
      if (typeof onCompileStart === 'function') {
        try { onCompileStart(); } catch (e) { /* advisory only */ }
      }
      const jobs = [Promise.resolve().then(() => ren.compileAsync(scene, cam))];
      // The shadow pass's DEPTH program too. compileAsync() builds only the
      // beauty-pass programs; the shadow pass draws every caster with three's
      // internal depth material (RGBA packing, side flipped FrontSide ->
      // BackSide) into a render target, and that program was otherwise built
      // synchronously on the first real frame (~100 ms cold on the real
      // house). A stand-in mesh with the same material settings, compiled
      // while a render target is bound (so the output colour space matches
      // the shadow map's), has the same program key -- the same trick the
      // furniture uses for its own casters (furniture.js, depthPrecompile).
      if (wantShadows) jobs.push(Promise.resolve().then(() => precompileShadowDepth()));
      // Fallback (review nit 1212b378 #1): r160's compileAsync polls
      // program.isReady() forever, so a context lost mid-compile leaves the
      // promise pending and the gate shut -- a blank canvas for good (under
      // ?preview=true there is no overlay to explain it). Open the gate
      // anyway after READY_FALLBACK_MS; the first frame then compiles
      // whatever is left, which is the old, slower-but-working behaviour.
      readyFallbackTimer = setTimeout(() => {
        readyFallbackTimer = null;
        if (readyFired) return;
        console.warn('[Home3DScene] shader precompile did not settle in ' +
          READY_FALLBACK_MS + ' ms; drawing anyway.');
        requestRender();
        fireReady();
      }, READY_FALLBACK_MS);
      precompileDone = Promise.all(jobs)
        .catch((e) => console.warn('[Home3DScene] shader precompile failed; ' +
          'falling back to compiling on first render.', e))
        .then(() => {
          ren.shadowMap.enabled = shadowWasEnabled;
          if (readyFallbackTimer !== null) { clearTimeout(readyFallbackTimer); readyFallbackTimer = null; }
          // REQUIRED: this scene renders on demand, so without an explicit
          // repaint request nothing draws after the precompile resolves and
          // the canvas stays blank. Invalidate too: shadowMap.enabled was
          // toggled around the precompile, and with autoUpdate off the maps
          // would otherwise never be built for the first real frame.
          invalidateShadows();
          requestRender();
          // After requestRender(), not before: the overlay should come down as
          // the real frame is being asked for, not while the canvas is still
          // blank. Note the .catch() above means this .then() runs on the
          // failure path too — a precompile that rejected still leaves a
          // usable scene (it just compiles on first draw), so the overlay must
          // come down there as well rather than hanging forever.
          fireReady();
        });
    } else {
      // No compileAsync (older three, or a renderer that lacks it): there is
      // no precompile phase to wait for, so the scene is as ready as it will
      // get right now and the first render does the compiling. Firing here is
      // what stops a caller's overlay staying up forever on this path.
      requestRender();
      fireReady();
    }

    // A restored context is a usable context: three rebuilds its programs on
    // the next draw. If the gate is still shut because the precompile never
    // settled (the context was lost mid-compile), open it now rather than
    // waiting out the fallback timer. Removed in dispose().
    onGlContextRestored = () => {
      if (readyFired) return;
      if (readyFallbackTimer !== null) { clearTimeout(readyFallbackTimer); readyFallbackTimer = null; }
      requestRender();
      fireReady();
    };
    ren.domElement.addEventListener('webglcontextrestored', onGlContextRestored);

    // ── Furniture (plan PR1b; src/furniture.js)─────────────────────────────
    // Attached AFTER the house's own precompile, already compiled, one render
    // later -- it never delays onReady, and never adds a program that would
    // compile synchronously on a later draw (the multi-second stall in
    // docs/perf-cold-start.md). ?furniture=0 (create opt `furniture: false`)
    // builds nothing at all until setFurnitureVisible(true) asks for it.
    let furnitureResult = null;
    let furnitureStarted = false;
    let furnitureAttached = null;   // startFurniture's promise: the attached result, or null
    const furnitureTimeline = { start: null, buildStart: null, buildEnd: null, attachedAt: null, stats: null };
    // Live clocks (item 059873ed): itemId -> the stop() startLiveClock
    // returned. A wall-clock's hands are a "dynamic" part (merge.js), so
    // they reach the scene as their own live mesh (result.dynamicByItemId),
    // not folded into a static bucket -- this is what actually lets
    // setClockTime keep moving them once the house is built, closing the
    // KNOWN GAP wall-clock.js's own header used to document. Stopped on
    // dispose/teardown (stopLiveClocks below), including a dispose that
    // lands mid-build (scheduleFurnitureAttach already frees a mid-build
    // dispose's geometry; this only needs to also clear its timers, since a
    // mid-build dispose never reaches attachFurniture in the first place).
    const liveClockStops = new Map();
    // TV screens (src/furniture/tv-screen.js createTvScreens): the built
    // screens and whether each set is on as last told by setTvScreen (HA or
    // the ?debug=1 seam). A reading that lands before the furniture attaches
    // is applied when it does; a real change repaints one frame.
    const tvScreens = createTvScreens(() => requestRender());
    // Smart displays' now-playing screens (src/furniture/hub-screen.js): the
    // content each was last told by setHubScreen, drawn on its own small
    // canvas texture only when that content changes; one repaint per change.
    // The progress bar ticks at 0.5 Hz, and a screen outside the camera's
    // frustum (or a hidden tab) only every fifth tick.
    const hubFrustum = new THREE.Frustum(), hubProj = new THREE.Matrix4();
    const hubScreens = createHubScreens({ THREE, repaint: () => requestRender(), isVisible: mesh => {
      if (typeof document !== 'undefined' && document.hidden) return false;
      hubProj.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
      return hubFrustum.setFromProjectionMatrix(hubProj).intersectsObject(mesh);
    } });
    function stopLiveClocks() {
      liveClockStops.forEach(stop => stop());
      liveClockStops.clear();
    }
    // What a furniture build needs beyond being in the scene graph: its wall
    // fade registrations, the light-following parts, the TV screens and the
    // live clocks. Called by attachFurniture for the one view-mode build, and
    // again by edit mode (below) after any part of the furniture is rebuilt --
    // so everything here first DROPS what the previous build registered.
    // `snap`: start each new fade mesh at the opacity the fade loop is easing
    // toward (an edit-mode rebuild mid-orbit must not flash solid).
    function applyFurnitureExtras(result, snap) {
      for (let k = wallMeshes.length - 1; k >= 0; k--) if (wallMeshes[k].furniture) wallMeshes.splice(k, 1);
      stopLiveClocks();
      // Fade buckets join the wall fade with their host wall's DERIVED outward
      // normal, exactly as window and curtain fittings do. Each is registered
      // with the opacity it returns to (task f7324d3f: glass fades WITH its
      // item, from and back to its own 0.25, never to 1).
      fadeRegistrations(result).forEach(({ mesh, wallId, baseOpacity, baseDepthWrite }) => {
        const host = wallEntryById[wallId];
        if (!host || !host.outer) return;
        const entry = { mesh, nx: host.nx, nz: host.nz, outer: true, base: baseOpacity, baseDepthWrite, furniture: true };
        wallMeshes.push(entry);
        if (snap) snapFade(entry);
      });
      // Light-following parts (a bedside table's level strip and glow band):
      // index them by the item's room and their channel, then pose them.
      Object.keys(furnitureLightParts).forEach(k => delete furnitureLightParts[k]);
      Object.keys(result.dynamicByItemId || {}).forEach(itemId => {
        const dyn = result.dynamicByItemId[itemId], info = result.byId[itemId];
        if (!dyn || !info) return;
        dyn.group.traverse(o => {
          if (!o.isMesh || !isLightPart(o)) return;
          const byCh = furnitureLightParts[info.room] || (furnitureLightParts[info.room] = {});
          (byCh[o.userData.lightChannel] || (byCh[o.userData.lightChannel] = [])).push(o);
        });
      });
      if (Object.keys(furnitureLightParts).length) syncLights();
      // TV screens: index each built TV's screen, in the look its set was
      // last reported in (dark if none has been); painted by the render below.
      tvScreens.attach(result.dynamicByItemId);
      hubScreens.attach(result.dynamicByItemId);
      // Start a live clock for every placed wall-clock. onTick asks for a
      // single repaint (requestRender, not wake()) -- a one-shot redraw per
      // second-boundary tick, never a sustained render loop; see the
      // render-on-demand note near requestRender()/wake() above for why a
      // re-arming timer here would defeat that gate while looking like it
      // respected it (this one does NOT re-arm: startLiveClock owns its own
      // setInterval entirely outside the render loop).
      Object.keys(result.byId).forEach(itemId => {
        if (result.byId[itemId].type !== 'wall-clock') return;
        const dyn = result.dynamicByItemId[itemId];
        if (!dyn) return; // e.g. a clock preset with no dynamic hands somehow
        const stop = startLiveClock(dyn.group, { onTick: () => requestRender() });
        liveClockStops.set(itemId, stop);
      });
    }
    function snapFade(entry) {
      const camDir = new THREE.Vector3().subVectors(orb.tgt, cam.position).normalize();
      const op = eyeInRoom([cam.position.x, cam.position.y, cam.position.z]) ? (entry.base == null ? 1 : entry.base)
        : wallFadeTarget(entry.nx * camDir.x + entry.nz * camDir.z, entry.base == null ? 1 : entry.base);
      entry.mesh.material.opacity = op;
      entry.mesh.material.depthWrite = wallFadeDepthWrite(op, entry.base, entry.baseDepthWrite);
    }
    function attachFurniture(result) {
      furnitureResult = result;
      result.root.visible = furnitureVisible;
      scene.add(result.root);
      furnitureTimeline.attachedAt = performance.now();
      furnitureTimeline.stats = result.stats;
      applyFurnitureExtras(result, false);
      // Adaptive quality: the attach frame repaints every shadow map with the
      // new casters (a cold frame worth judging), and the frames around the
      // attach are not the steady cost -- go quiet before sampling again.
      if (adaptive) {
        coldFramesLeft = Math.max(coldFramesLeft, 3);
        adaptive.quiet(furnitureTimeline.attachedAt, WARMUP_MS);
      }
      // MOVES GEOMETRY (new casters) -> shadows must refresh once.
      invalidateShadows();
      requestRender();
    }
    function startFurniture() {
      if (furnitureStarted || !furnitureItems.length) return;
      furnitureStarted = true;
      furnitureTimeline.start = performance.now();
      if (!furnitureModules) furnitureModules = loadFurnitureModules(furnitureItems);
      furnitureAttached = scheduleFurnitureAttach({
        precompileDone,
        modulesLoaded: furnitureModules,
        isDisposed: () => _disposed,
        // Time-sliced (task c399c2a4): the build hands the main thread back
        // every few ms, so a full house never lands as one long task -- on
        // an embedding dashboard that task would freeze the host page
        // itself. A dispose mid-build stops it and frees what it had made.
        build: builders => {
          furnitureTimeline.buildStart = performance.now();
          return buildFurnitureSliced(THREE, furnitureItems, builders, {
            tx, tz, quality, walls: WALLS, isCancelled: () => _disposed,
            onProgress: typeof onFurnishProgress === 'function' && !bootGate.isDone() ? onFurnishProgress : null
          }).then(result => {
            furnitureTimeline.buildEnd = performance.now();
            return result;
          });
        },
        renderer: ren,
        camera: cam,
        scene,
        wantShadows,
        makeRenderTarget: () => new THREE.WebGLRenderTarget(1, 1),
        attach: attachFurniture
      });
    }
    if (furnitureVisible) startFurniture();
    // The boot gate's remaining waits: the boot furniture build (when one
    // started -- ?furniture=0 and an unfurnished house have none) and every
    // image buildScene loads. Sealed here, so a LATER build (edit mode,
    // setFurnitureVisible) never holds it.
    if (furnitureAttached) bootGate.wait('furniture', furnitureAttached);
    if (textureLoads.length) bootGate.wait('images', Promise.all(textureLoads));
    bootGate.seal();

    // ── Edit-mode furniture (src/edit-mode.js, plan B1 + plan-review #13) ──
    // View mode keeps the ONE house-scope build above. Edit mode swaps it for
    // one build per ROOM (each its own small result: buckets, proxy, dynamic
    // parts), so changing one item rebuilds only its room. The selected item
    // is LIFTED: its room is rebuilt without it and it is built standalone,
    // so a drag or a slider change rebuilds that one item and nothing else.
    // Deselecting drops it back into its room (one room rebuild). Moves are
    // confined to the item's room, so a room rebuild is always enough. On
    // leaving edit mode the house-scope build comes back, from the edited
    // items. None of this runs unless edit mode asks: view mode is untouched.
    //
    //   parts    'room:<id>' | 'item:<id>' -> a buildFurnitureSync result
    //   items    the compiled furniture, in profile order (edits land here)
    //   lifted   the lifted item's id, or null
    // `furnitureResult` is a COMPOSITE of the parts while editing, so every
    // reader of it (furnitureItemAt, itemView, the occlusion test, dispose)
    // keeps working unchanged.
    let editFurn = null;
    const editKeep = item => !(quality.dropMinorFurniture && item.priority === 'minor');
    function editCompose() {
      const c = { root: editFurn.root, beauty: [], shadowProxies: [], dynamicByItemId: {}, byId: {}, warnings: [],
        stats: { items: 0, beautyDraws: 0, proxyDraws: 0, dynamicDraws: 0, parts: editFurn.parts.size },
        depthPrecompile: null, materials: [], extraDisposables: [] };
      editFurn.parts.forEach((r, key) => {
        r.beauty.forEach(m => c.beauty.push(m));
        r.shadowProxies.forEach(m => c.shadowProxies.push(m));
        // The placement ghost is drawn but is not an item: never picked,
        // never a live clock or TV screen.
        if (key === 'ghost') return;
        Object.assign(c.dynamicByItemId, r.dynamicByItemId);
        Object.assign(c.byId, r.byId);
        r.warnings.forEach(w => c.warnings.push(w));
        (r.extraDisposables || []).forEach(d => c.extraDisposables.push(d));
        c.stats.items += r.stats.items; c.stats.beautyDraws += r.stats.beautyDraws;
        c.stats.proxyDraws += r.stats.proxyDraws; c.stats.dynamicDraws += r.stats.dynamicDraws;
      });
      furnitureResult = c;
      editFurn.root.visible = furnitureVisible;
      applyFurnitureExtras(c, true);
      editHighlight(editFurn.highlight);
      invalidateShadows();
      requestRender();
    }
    function editDisposePart(key) {
      const r = editFurn.parts.get(key);
      if (!r) return;
      editFurn.parts.delete(key);
      // Its live clocks are stopped by the applyFurnitureExtras that follows.
      disposeFurniture(r);
    }
    // (Re)build one part synchronously. Returns ms.
    function editBuildPart(key, items) {
      const t0 = performance.now();
      editDisposePart(key);
      const list = items.filter(editKeep);
      if (list.length) {
        const r = buildFurnitureSync(THREE, list, editFurn.builders, { tx, tz, quality, walls: WALLS });
        r.root.name = 'furniture-edit:' + key;
        editFurn.root.add(r.root);
        editFurn.parts.set(key, r);
      }
      return performance.now() - t0;
    }
    function editRoomItems(room) {
      return editFurn.items.filter(it => it.room === room && it.id !== editFurn.lifted);
    }
    function editItem(id) { return editFurn.items.find(it => it.id === id) || null; }
    // Edit mode turned furniture ON (it was hidden by ?furniture=0): Done hides it again.
    let editShowedFurniture = false;
    async function beginFurnitureEdit() {
      if (editFurn) return { ms: 0 };
      if (!furnitureVisible) { editShowedFurniture = true; furnitureVisible = true; }
      if (!furnitureStarted) startFurniture();
      if (furnitureAttached) await furnitureAttached;
      if (_disposed || editFurn) return { ms: 0 };
      const builders = await (furnitureModules || loadFurnitureModules(furnitureItems));
      if (_disposed || editFurn) return { ms: 0 };
      const t0 = performance.now();
      if (furnitureResult) { stopLiveClocks(); disposeFurniture(furnitureResult); furnitureResult = null; }
      const root = new THREE.Group();
      root.name = 'furniture-edit';
      scene.add(root);
      editFurn = { root, parts: new Map(), items: furnitureItems.slice(), lifted: null, builders, highlight: null };
      const rooms = [];
      editFurn.items.forEach(it => { if (rooms.indexOf(it.room) < 0) rooms.push(it.room); });
      rooms.forEach(room => editBuildPart('room:' + room, editRoomItems(room)));
      editCompose();
      return { ms: performance.now() - t0 };
    }
    function liftFurnitureItem(id) {
      if (!editFurn) return null;
      const t0 = performance.now();
      const prev = editFurn.lifted;
      if (prev === (id || null)) return { ms: 0 };
      editFurn.lifted = null;
      if (prev) {
        const p = editItem(prev);
        editDisposePart('item:' + prev);
        if (p) editBuildPart('room:' + p.room, editRoomItems(p.room));
      }
      const it = id ? editItem(id) : null;
      if (it) {
        editFurn.lifted = id;
        editBuildPart('room:' + it.room, editRoomItems(it.room));
        editBuildPart('item:' + id, [it]);
      }
      editCompose();
      return { ms: performance.now() - t0 };
    }
    // Replace (or, with no match, append) one compiled item and rebuild what
    // shows it: only its own part when it is lifted, else its room.
    function updateFurnitureItem(item) {
      if (!editFurn || !item) return null;
      const t0 = performance.now();
      const k = editFurn.items.findIndex(it => it.id === item.id);
      const old = k >= 0 ? editFurn.items[k] : null;
      if (k >= 0) editFurn.items[k] = item; else editFurn.items.push(item);
      let buildMs;
      if (editFurn.lifted === item.id) buildMs = editBuildPart('item:' + item.id, [item]);
      else {
        buildMs = editBuildPart('room:' + item.room, editRoomItems(item.room));
        if (old && old.room !== item.room) buildMs += editBuildPart('room:' + old.room, editRoomItems(old.room));
      }
      editCompose();
      return { ms: performance.now() - t0, buildMs };
    }
    // A NEW item (the library, B2): appended to the items and built LIFTED
    // (standalone), because it arrives selected -- its room is not rebuilt
    // at all. Only a previously lifted item goes back into its own room.
    function addFurnitureItem(item) {
      if (!editFurn || !item) return null;
      const t0 = performance.now();
      if (editItem(item.id)) return updateFurnitureItem(item);
      const prev = editFurn.lifted;
      editFurn.lifted = null;
      if (prev) {
        const p = editItem(prev);
        editDisposePart('item:' + prev);
        if (p) editBuildPart('room:' + p.room, editRoomItems(p.room));
      }
      editFurn.items.push(item);
      editFurn.lifted = item.id;
      const buildMs = editBuildPart('item:' + item.id, [item]);
      editCompose();
      return { ms: performance.now() - t0, buildMs };
    }
    // The builder for `type`, loaded now if no item in the house uses it yet
    // (the library offers every type). Resolves to it, or null.
    async function loadFurnitureBuilder(type) {
      const map = editFurn ? editFurn.builders : await (furnitureModules || (furnitureModules = loadFurnitureModules(furnitureItems)));
      if (map.has(type)) return map.get(type);
      const m = await loadFurnitureModules([{ type }]);
      const b = m.get(type) || null;
      if (b) map.set(type, b);
      return b;
    }
    // The placement preview: one item built on its own ('ghost' part) and
    // then only TRANSLATED while it follows the pointer (offset in house
    // cm from where it was built), so hovering costs no rebuilds.
    function setFurnitureGhost(item) {
      if (!editFurn) return null;
      const t0 = performance.now();
      editDisposePart('ghost');
      if (item) {
        editBuildPart('ghost', [item]);
        const g = editFurn.parts.get('ghost');
        if (g) { g.root.name = 'furniture-edit-ghost'; g.root.traverse(o => { o.raycast = () => {}; }); }
      }
      editCompose();
      return { ms: performance.now() - t0 };
    }
    function moveFurnitureGhost(dxCm, dyCm) {
      const g = editFurn && editFurn.parts.get('ghost');
      if (!g) return;
      g.root.position.set(dxCm * S, 0, dyCm * S);
      requestRender();
    }
    function removeFurnitureItem(id) {
      if (!editFurn) return null;
      const t0 = performance.now();
      const it = editItem(id);
      if (!it) return { ms: 0 };
      editFurn.items = editFurn.items.filter(x => x.id !== id);
      if (editFurn.lifted === id) { editFurn.lifted = null; editDisposePart('item:' + id); }
      else editBuildPart('room:' + it.room, editRoomItems(it.room));
      if (editFurn.highlight === id) editFurn.highlight = null;
      editCompose();
      return { ms: performance.now() - t0 };
    }
    // Leave edit mode: back to ONE house-scope build of `items` (the edited
    // furniture; default the current edit items), compiled before it shows,
    // exactly as at boot. Resolves once it is attached.
    function endFurnitureEdit(items) {
      if (!editFurn) return Promise.resolve(null);
      const next = (items || editFurn.items).filter(editKeep);
      const builders = editFurn.builders;
      editFurn.highlight = null;
      editHighlight(null);
      stopLiveClocks();
      Array.from(editFurn.parts.keys()).forEach(editDisposePart);
      scene.remove(editFurn.root);
      editFurn = null;
      furnitureResult = null;
      furnitureItems = next;
      applyFurnitureExtras({ byId: {}, dynamicByItemId: {}, beauty: [] }, false);
      invalidateShadows();
      requestRender();
      if (editShowedFurniture) {
        // Back to hidden (?furniture=0): nothing to build until someone shows
        // it, and then setFurnitureVisible starts it from these items.
        editShowedFurniture = false;
        furnitureVisible = false;
        furnitureStarted = false;
        furnitureAttached = null;
        return Promise.resolve(null);
      }
      if (!next.length) return Promise.resolve(null);
      furnitureAttached = scheduleFurnitureAttach({
        precompileDone: Promise.resolve(),
        modulesLoaded: loadFurnitureModules(next.filter(it => !builders.has(it.type)))
          .then(m => { builders.forEach((b, t) => { if (!m.has(t)) m.set(t, b); }); return m; }),
        isDisposed: () => _disposed || !!editFurn,
        build: b => buildFurnitureSliced(THREE, next, b, { tx, tz, quality, walls: WALLS, isCancelled: () => _disposed || !!editFurn }),
        renderer: ren, camera: cam, scene, wantShadows,
        makeRenderTarget: () => new THREE.WebGLRenderTarget(1, 1),
        attach: attachFurniture
      });
      return furnitureAttached;
    }
    // The selection outline: the item's world box as amber lines, drawn over
    // everything. Never pickable (a LineSegments raycast catches every tap
    // near it).
    let editBox = null;
    function editHighlight(id) {
      if (editBox) { scene.remove(editBox); editBox.geometry.dispose(); editBox.material.dispose(); editBox = null; }
      if (editFurn) editFurn.highlight = id || null;
      const e = id && furnitureResult && furnitureResult.byId ? furnitureResult.byId[id] : null;
      if (e && e.worldBox) {
        const b = new THREE.Box3(new THREE.Vector3().fromArray(e.worldBox.min), new THREE.Vector3().fromArray(e.worldBox.max));
        b.expandByScalar(0.015);
        editBox = new THREE.Box3Helper(b, 0xf59e0b);
        editBox.material.depthTest = false;
        editBox.material.transparent = true;
        editBox.renderOrder = 999;
        editBox.raycast = () => {};
        editBox.name = 'furniture-edit-highlight';
        editBox.userData.editHelper = true;
        scene.add(editBox);
      }
      requestRender();
    }
    // The furniture item under a client-pixel point, edit mode only: the
    // first SOLID drawn surface along the ray decides (a wall in front hides
    // what is behind it; see-through surfaces pass), and a furniture hit
    // names its item by the smallest world box holding the hit point.
    const _editRc = new THREE.Raycaster();
    const _editNdc = new THREE.Vector2();
    function editRay(clientX, clientY) {
      const r = container.getBoundingClientRect();
      _editNdc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
      _editRc.setFromCamera(_editNdc, cam);
      return _editRc;
    }
    function furnitureEditPick(clientX, clientY) {
      if (!editFurn || !furnitureResult || !furnitureVisible) return null;
      const hits = editRay(clientX, clientY).intersectObjects(scene.children, true);
      for (let i = 0; i < hits.length; i++) {
        const h = hits[i], o = h.object;
        if (!o || !o.isMesh || !isDrawn(o)) continue;
        if (o.userData && (o.userData.clickable || o.userData.furniture === 'proxy')) continue;
        // Furniture first: an item fading with its exterior wall is see-through
        // only because that wall is, so it is still what was tapped.
        if (isFurniture(o)) {
          const it = furnitureItemAt(furnitureResult.byId, h.point);
          if (it) return { id: it.id, point: [h.point.x, h.point.y, h.point.z] };
          continue;
        }
        if (materialOpacity(o.material, h.face ? h.face.materialIndex : 0) < OPACITY_SOLID) continue;
        return null;
      }
      return null;
    }
    // Edit mode, placing a new item (B2 review finding 1): the room a tap
    // means, decided by the SAME picker as a room tap (room-pick.js: walls
    // block and resolve to the side tapped, furniture passes the tap on),
    // plus a point inside it -- where the ray met the floor catcher, or a
    // wall hit stepped back off its face. { room, point: [x, y] house cm, via }.
    function placementPick(clientX, clientY) {
      const rc = editRay(clientX, clientY);
      const toHouse = sceneToHouse(S, OX, OY);
      const picked = pickRoom(rc.intersectObjects(scene.children, true), rc.ray.direction, roomPolygons(ROOMS), toHouse, null);
      let point = null;
      const h = picked.hit;
      if (h && h.point) {
        if (picked.via === 'wall') {
          const st = stepBack(h, rc.ray.direction);
          point = toHouse(h.point.x + st.x * 0.05, h.point.z + st.z * 0.05);
        } else point = toHouse(h.point.x, h.point.z);
      }
      return { room: picked.roomId || null, point, via: picked.via };
    }
    // Where a client-pixel ray meets the horizontal plane at height y
    // (metres), in house cm [x, y]; null when it never does (looking up).
    function screenToPlan(clientX, clientY, y) {
      const ray = editRay(clientX, clientY).ray;
      const o = ray.origin, d = ray.direction;
      if (Math.abs(d.y) < 1e-6) return null;
      const t = ((y || 0) - o.y) / d.y;
      if (!(t > 0)) return null;
      return [(o.x + d.x * t) / S + OX, (o.z + d.z * t) / S + OY];
    }

    // Light state — one entry per room, one sub-entry per channel the profile
    // declares for it. A room with no 'main' channel still gets a main entry so
    // the controls panel and syncLights() can address every room uniformly.
    // Geometry's channels plus every channel rooms.json binds (src/light-state.js).
    const ids = Object.keys(ROOMS);
    const lightState = seedLightState(ROOMS, LIGHTS, opts.boundChannels);

    // Apply initial HA state if provided
    if (initialState) {
      ids.forEach(id => {
        const init = initialState[id];
        if (!init) return;
        Object.keys(init).forEach(group => {
          if (lightState[id][group]) Object.assign(lightState[id][group], init[group]);
        });
      });
    }

    // TODO: per-bulb tracking. Today every bulb in a room/group renders with
    // the same intensity/color because lightState[id].main is a single object
    // shared by all bulbs. To make each 3D bulb mirror its own HA entity, swap
    // lightState[id].main for an array (one entry per entity in rooms[id].main)
    // and look up mainLights[id][i] against its matching entity here. Sidebar
    // controls stay group-level — only the visual state goes per-bulb.
    // A merged room light stands for several fixtures (buildScene); any other
    // light stands for one.
    const lightGain = l => (l.userData && l.userData.gain > 0 ? l.userData.gain : 1);
    // Furniture parts that follow a room light channel (src/furniture/
    // light-parts.js): roomId -> channel -> [mesh]. Filled when the furniture
    // attaches (attachFurniture); posed here from the same channel state as
    // the channel's real light.
    const furnitureLightParts = {};
    function syncLights() {
      ids.forEach(id => {
        const s = lightState[id];
        if (!s) return;
        const mc = k2h(s.main.temp), mb = s.main.on ? s.main.bri / 100 : 0;
        (mainLights[id] || []).forEach(l => { l.intensity = mb * ROOM_LIGHT.mainGain * lightGain(l); l.color.setHex(mc); });
        (mainMeshes[id] || []).forEach(m => {
          m.material.emissive.setHex(s.main.on ? mc : 0x222222);
          m.material.emissiveIntensity = s.main.on ? mb * 2 : 0.05;
        });
        // Accent channels. 'ambient' has dedicated arrays; any other channel a
        // profile declares is driven through the same code path from the
        // per-channel maps, so a third switchable group needs no engine change.
        const applyAccent = (state, lights, meshes) => {
          if (!state) return;
          const ac = parseInt(String(state.color).replace("#", ""), 16);
          const ab = state.on ? state.bri / 100 : 0;
          (lights || []).forEach(l => { l.intensity = ab * 0.3 * lightGain(l); l.color.setHex(ac); });
          (meshes || []).forEach(m => {
            m.material.color.setHex(ac);
            m.material.emissive.setHex(state.on ? ac : 0x111111);
            m.material.emissiveIntensity = state.on ? ab * 1.5 : 0;
            m.material.opacity = state.on ? 0.85 : 0.15;
          });
        };
        applyAccent(s.ambient, ambientLights[id], ambientMeshes[id]);
        Object.keys(s).forEach(channel => {
          if (channel === 'main' || channel === 'ambient') return;
          applyAccent(s[channel], (extraLights[id] || {})[channel], (extraMeshes[id] || {})[channel]);
        });
        const parts = furnitureLightParts[id];
        if (parts) Object.keys(parts).forEach(channel => {
          if (s[channel]) parts[channel].forEach(m => applyLightPart(m, s[channel]));
        });
      });
      // Light state changed → repaint (matters when idle/on-demand) AND
      // refresh the shadow maps: this sets intensity/colour/visibility on the
      // room lights, all of which change what their shadows should look like.
      invalidateShadows();
      requestRender();
    }
    syncLights();

    // Orbit state — `pan` mirrors `drag` but for a right-drag translate of the
    // look-at target instead of a rotate; the two are mutually exclusive
    // (pointerdown picks one based on e.button), so px/py are shared between
    // them as "last pointer position for whichever drag is active".
    // The orbit target is the centre of the house's own footprint (derived from
    // the walls), not a hardcoded plan coordinate — a different house has a
    // different centre, and framing it on somebody else's is how a model ends up
    // off-screen. `_defaultDistance` frames the footprint's larger dimension in
    // the camera's field of view, so a bigger or smaller house is framed
    // correctly without the profile having to say anything about cameras.
    const _homeTgt = () => new THREE.Vector3(tx(HOUSE.centre[0]), 0, tz(HOUSE.centre[1]));
    const _fpW = (HOUSE.footprint.maxX - HOUSE.footprint.minX) * S;
    const _fpD = (HOUSE.footprint.maxY - HOUSE.footprint.minY) * S;
    const _defaultDistance = Math.max(6, Math.max(_fpW, _fpD) / (2 * Math.tan(cam.fov * Math.PI / 360)) * 1.15);
    const _t0 = _homeTgt();
    const orb = { drag: false, pan: false, px: 0, py: 0, th: Math.PI * 0.22, ph: Math.PI * 0.32, r: _defaultDistance, tgt: _t0 };
    const clickStart = { x: 0, y: 0 };
    const rc = new THREE.Raycaster();
    const mouse = new THREE.Vector2();

    // Pan bounds — derived from the wall geometry (not hardcoded) so a future
    // edit to the house footprint doesn't silently desync these. Generous
    // margin beyond the footprint (not tightly tuned — just stops the target
    // being dragged arbitrarily far from the model, same spirit as the
    // orb.r zoom clamp below). Y (vertical pan) gets a flat, small range since
    // there's no wall geometry to derive it from.
    const PAN_MARGIN_CM = 500;
    const wallXs = WALLS.flatMap(w => [w.x1, w.x2]);
    const wallYs = WALLS.flatMap(w => [w.y1, w.y2]);
    const PAN_BOUNDS = {
      minX: tx(Math.min(...wallXs) - PAN_MARGIN_CM), maxX: tx(Math.max(...wallXs) + PAN_MARGIN_CM),
      minZ: tz(Math.min(...wallYs) - PAN_MARGIN_CM), maxZ: tz(Math.max(...wallYs) + PAN_MARGIN_CM),
      minY: -2, maxY: 6
    };

    function updCam() {
      cam.position.set(
        orb.tgt.x + orb.r * Math.sin(orb.ph) * Math.cos(orb.th),
        orb.tgt.y + orb.r * Math.cos(orb.ph),
        orb.tgt.z + orb.r * Math.sin(orb.ph) * Math.sin(orb.th)
      );
      cam.lookAt(orb.tgt);
      requestRender();
    }
    updCam();

    // ---- Named camera view presets (for `?camera=<preset>` — see home3d.html) ----
    // Lets visual-review agents jump straight to a useful angle instead of
    // driving OrbitControls via synthetic mouse events (which the custom orbit
    // camera resists — First Mate LEARNINGS #55). Each preset sets the orbit
    // state {th, ph, r} and optionally re-targets orb.tgt; the user can still
    // orbit/pan freely afterwards (this only overrides the INITIAL pose).
    //
    // Angle convention (see updCam above): th = azimuth in the XZ plane; the
    // camera sits at th and looks back at the target. In model space x=East,
    // y=South, so world +X=East, +Z=South. Camera on the:
    //   +X (th=0)      side → looks West  (shows the EAST face)
    //   +Z (th=π/2)    side → looks North (shows the SOUTH face)
    //   -X (th=π)      side → looks East  (shows the WEST face)
    //   -Z (th=3π/2)   side → looks South (shows the NORTH face)
    // The front door is in the north wall (model y≈-4.8), so the ENTRANCE/front
    // elevation is the north face → camera on the -Z side (th=3π/2). ph is the
    // polar angle from +Y: ph→0 = straight top-down, ph=π/2 = eye-level.
    const PI = Math.PI;
    // The useful presets are DIRECTIONS — top-down, the four corner three-quarter
    // views, the four elevations — and a direction is house-independent. What
    // genuinely varies is the framing distance, and that is computed from the
    // footprint above. So a profile that says nothing about cameras still gets a
    // sensible set for its own size; `cameraPresets` in the profile overrides any
    // of them, wholly or in part, for a house whose shape wants a different angle.
    const _R = _defaultDistance;
    const CAMERA_PRESETS = {
      // Straight top-down floor-plan view. ph tiny-but-nonzero avoids a
      // gimbal-flat lookAt.
      top:     { th: -PI / 2, ph: 0.02, r: _R * 1.15 },
      // Four corner 3/4 aerial views — camera in the named corner looking into
      // the interior.
      se:      { th: PI * 0.25, ph: PI * 0.34, r: _R },
      sw:      { th: PI * 0.75, ph: PI * 0.34, r: _R },
      nw:      { th: PI * 1.25, ph: PI * 0.34, r: _R },
      ne:      { th: PI * 1.75, ph: PI * 0.34, r: _R },
      // Elevations — camera dead-on a face, near eye-level (ph high).
      front:   { th: PI * 1.5, ph: PI * 0.46, r: _R * 1.08 },
      back:    { th: PI * 0.5, ph: PI * 0.46, r: _R * 1.08 },
      east:    { th: 0,        ph: PI * 0.46, r: _R * 1.08 },
      west:    { th: PI,       ph: PI * 0.46, r: _R * 1.08 },
      // Default pleasant isometric-ish 3/4 (mirrors the scene's own default).
      iso:     { th: PI * 0.22, ph: PI * 0.32, r: _R },
    };
    // Per-house overrides. The profile expresses a preset in orbit terms
    // (azimuth/polar/distance, plus an optional plan-space target); map those
    // onto the engine's th/ph/r. A partial override keeps the engine default for
    // any key it omits.
    Object.keys(HOUSE.cameraPresets || {}).forEach(name => {
      const p = HOUSE.cameraPresets[name];
      const base = CAMERA_PRESETS[name] || CAMERA_PRESETS.iso;
      CAMERA_PRESETS[name] = {
        th: p.azimuth != null ? p.azimuth : base.th,
        ph: p.polar != null ? p.polar : base.ph,
        r: p.distance != null ? p.distance : base.r,
        tgt: p.target ? new THREE.Vector3(tx(p.target[0]), 0, tz(p.target[1])) : undefined
      };
    });
    // topdown is an alias for top
    CAMERA_PRESETS.topdown = CAMERA_PRESETS.top;

    // Apply a named preset (case-insensitive). Unknown/absent name → no-op
    // (keeps the current/default view). Returns true if a preset was applied.
    function setView(name) {
      if (!name) return false;
      const p = CAMERA_PRESETS[String(name).toLowerCase()];
      if (!p) return false;
      cancelFlight();
      orb.th = p.th;
      orb.ph = p.ph;
      orb.r = p.r;
      orb.tgt.copy(p.tgt || _homeTgt());
      updCam();
      return true;
    }

    // ---- Camera flights (camera focus, src/camera-focus.js) -------------
    //
    // flyTo(pose) eases the orbit camera from where it is to `pose` over ~0.7 s
    // (ease-in-out, azimuth by the shortest arc, distance in log space). It is
    // BOUNDED like the door swings: tickCameraFlight() feeds `animating` in the
    // loop, so the scene renders exactly until the flight lands and then goes
    // back to zero frames. Any pointer / wheel / touch / camera key, a resize,
    // or an API jump (setView / setOrbit) cancels it where it is -- no jump.
    // A newer flyTo supersedes an older one. Each resolves its promise once:
    // 'landed', 'cancelled' or 'superseded'. Under prefers-reduced-motion the
    // flight is a jump.
    let flight = null;   // { from, to, t0, ms, resolve }
    let pickFocusRoom = null;   // () => the focused room id, or null (setPickFocus)
    function getPose() {
      return { th: orb.th, ph: orb.ph, r: orb.r, tgt: [orb.tgt.x, orb.tgt.y, orb.tgt.z], fov: cam.fov };
    }
    function applyPose(p) {
      orb.th = p.th; orb.ph = p.ph; orb.r = p.r;
      orb.tgt.set(p.tgt[0], p.tgt[1], p.tgt[2]);
      const fov = p.fov != null ? p.fov : cam.fov;
      if (Math.abs(fov - cam.fov) > 1e-9) { cam.fov = fov; cam.updateProjectionMatrix(); }
      updCam();
    }
    function endFlight(status) {
      if (!flight) return;
      const f = flight;
      flight = null;
      if (status !== 'superseded') releaseWalkDoors(status === 'cancelled');
      try { f.resolve(status); } catch (e) { /* a resolver never throws */ }
    }
    function reducedMotion() {
      try { return typeof window !== 'undefined' && typeof window.matchMedia === 'function' &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; }
    }
    function flyTo(pose, opts) {
      const from = getPose(), to = clonePose(pose);
      const route = flightRoute(from, to);
      const mode = route.mode;
      // Doors: a walk swings open every door it passes through, and a room
      // seen from outside (a cupboard) keeps its own door open while it is
      // the view. Anything held before and not wanted now swings back.
      walkViewDoor = outsideDoorFor(to);
      setViewDoor(walkViewDoor);
      const wanted = new Set((route.plan ? route.plan.portals : []).filter(id => doorById[id]).concat(walkViewDoor ? [walkViewDoor] : []));
      endFlight('superseded');
      holdDoorsOpen(wanted);
      const ms = opts && opts.ms != null ? opts.ms : (mode === 'walk' ? route.plan.ms : mode === 'arc' ? 1200 : 700);
      if (!(ms > 0) || reducedMotion()) { applyPose(pose); releaseWalkDoors(); wake(250); return Promise.resolve('landed'); }
      return new Promise(resolve => {
        const plan = route.plan || planFlight(from, to, { mode, clearY: WH + 0.5 });
        flight = { from, to, plan, mode, arc: mode === 'arc', walk: mode === 'walk', t0: performance.now(), ms, resolve };
        wake(ms + 50);
      });
    }
    // How a flight travels: between two views from outside, the orbit lerp
    // as ever (camera-focus.js planFlight); within one room, a straight line;
    // between two views INSIDE the house, a walk through the doorways, below
    // the ceiling (src/doorway-walk.js planWalk). Only a flight with one end
    // outside the house (the home view) -- or between rooms the walk cannot
    // connect -- still goes up over the walls and down again: the orbit lerp
    // would slide the camera through them.
    function flightRoute(from, to) {
      const a = eyeOf(from), b = eyeOf(to);
      const ra = eyeInRoom(a), rb = eyeInRoom(b);
      if (!ra && !rb) return { mode: 'orbit' };
      // Same room: a straight line only when it crosses none of the room's
      // edges (exact; 9 samples could miss a sharp notch between them).
      if (ra && ra === rb && !leavesRoom(roomShape(ra).map(p => [tx(p[0]), tz(p[1])]), a, b, 0)) return { mode: 'eye' };
      if (ra && rb) {
        const plan = planWalk(navGraph(), from, ra, to, rb, { obstacles: walkObstacles() });
        lastWalk = plan ? { from: ra, to: rb, rooms: plan.rooms, portals: plan.portals, length: +plan.length.toFixed(2), ms: plan.ms,
          maxY: +plan.maxY.toFixed(3), ceiling: navGraph().ceiling, waypoints: plan.waypoints.map(p => p.map(v => +v.toFixed(3))),
          path: plan.path.map(p => p.map(v => +v.toFixed(3))) } : { from: ra, to: rb, failed: true };
        if (plan) return { mode: 'walk', plan };
      }
      return { mode: 'arc' };
    }
    // The navigation graph (src/doorway-walk.js), built once from the house.
    let _navGraph = null, lastWalk = null;
    function navGraph() {
      if (!_navGraph) _navGraph = buildNavGraph(navInputsFromHouse(HOUSE));
      return _navGraph;
    }
    // Tall furniture the walk steps round (a wardrobe, a fridge); anything
    // under the walking eye's knees is walked over.
    function walkObstacles() {
      const byId = furnitureResult && furnitureVisible && furnitureResult.byId ? furnitureResult.byId : null;
      if (!byId) return [];
      return Object.keys(byId).map(k => byId[k].worldBox).filter(b => b && b.max[1] > 1.2);
    }
    // ---- Doors held open for a walk / an outside view ----
    // door id -> the openness to go back to. A sensor or the panel slider
    // setting a held door updates this instead of swinging it shut mid-walk.
    const walkDoorHold = new Map();
    let walkViewDoor = null;
    function swingDoor(id, pct) {
      const dr = doorById[id];
      if (!dr) return;
      const sw = doorSwings.get(id);
      if (sw ? sw.to === pct : dr.openPct === pct) return;
      doorSwings.set(id, { from: dr.openPct, to: pct, startedAt: performance.now() });
    }
    function holdDoorsOpen(ids) {
      ids.forEach(id => {
        const dr = doorById[id];
        if (!dr) return;
        if (!walkDoorHold.has(id)) { const sw = doorSwings.get(id); walkDoorHold.set(id, sw ? sw.to : dr.openPct); }
        swingDoor(id, 100);
      });
      // Held, but not wanted any more: back to where it was.
      walkDoorHold.forEach((pct, id) => { if (!ids.has(id)) { walkDoorHold.delete(id); swingDoor(id, pct); } });
      requestRender();
    }
    // The door of a cupboard that is the view is HIDDEN while it is: one that
    // opens only 28 degrees otherwise fills the frame, and the shot is of the
    // cupboard, not its door. Shown again the moment another flight starts.
    let hiddenViewDoor = null;
    function setViewDoor(id) {
      if (hiddenViewDoor === id) return;
      const show = hiddenViewDoor && doorById[hiddenViewDoor];
      if (show && show.pivot) show.pivot.visible = true;
      hiddenViewDoor = id && doorById[id] && doorById[id].pivot ? id : null;
      if (hiddenViewDoor) doorById[hiddenViewDoor].pivot.visible = false;
      invalidateShadows();
      requestRender();
    }
    // After a flight: only the destination's outside-view door stays open --
    // and, when the user stopped the walk, any door the camera is standing
    // in or next to (within 1 m), so a leaf never swings shut through it.
    // Those go back at the next flight.
    function releaseWalkDoors(cancelled) {
      const keep = new Set(walkViewDoor ? [walkViewDoor] : []);
      if (cancelled) {
        const c = cam.position;
        walkDoorHold.forEach((pct, id) => {
          const p = navGraph().portals.find(q => q.id === id);
          if (p && Math.hypot(c.x - p.c[0], c.z - p.c[1]) < 1) keep.add(id);
        });
      }
      holdDoorsOpen(keep);
    }
    // The door of the room whose outside view this pose is, or null.
    function outsideDoorFor(pose) {
      const e = eyeOf(pose);
      for (const v of outsideViews.values()) {
        if (!v) continue;
        const f = eyeOf(v.pose);
        if (Math.hypot(e[0] - f[0], e[1] - f[1], e[2] - f[2]) < 0.02) return doorById[v.portal] ? v.portal : null;
      }
      return null;
    }
    function cancelFlight() {
      if (!flight) return false;
      endFlight('cancelled');
      wake(250);
      return true;
    }
    function tickCameraFlight(now) {
      if (!flight) return false;
      const t = (now - flight.t0) / flight.ms;
      if (t >= 1) { applyPose(flight.to); endFlight('landed'); return false; }
      applyPose(flight.plan.at((flight.plan.ease || easeInOut)(Math.max(0, t))));
      return true;
    }

    // ---- Focus views ------------------------------------------------------
    // The pose the camera flies to for a selection. A profile `view` (geometry
    // schemaVersion 1.4, compiled by house-loader) wins; otherwise the view is
    // DERIVED, so any house works with nothing authored. A room's derived view
    // is taken from INSIDE the room (inRoomView below: the corner shot that
    // shows the most of its floor and furniture). Only a room no camera can
    // usefully stand in (a cupboard) falls back to the view from above, at the
    // house's own home angle (the `iso` preset, which a profile may override).
    function roomShape(id) {
      const rm = ROOMS[id];
      if (!rm) return null;
      return rm.poly || [[rm.x1, rm.y1], [rm.x2, rm.y1], [rm.x2, rm.y2], [rm.x1, rm.y2]];
    }
    function roomView(id, opts) {
      const poly = roomShape(id);
      if (!poly) return null;
      const home = CAMERA_PRESETS.iso;
      const above = () => deriveRoomView({
        poly, toWorld: (x, y) => [tx(x), tz(y)], th: home.th, ph: home.ph, fov: ROOM_VIEW.fov,
        aspect: cam.aspect, inset: opts && opts.inset, maxR: _defaultDistance * 3,
        height: HOUSE.ceilingHeight || WH,
      });
      const v = ROOMS[id].view;
      if (v) {
        const d = v.tgt ? null : above();
        return { th: v.th, ph: v.ph, r: v.r, tgt: v.tgt ? v.tgt.slice() : [d.tgt[0], v.targetHeight || 0, d.tgt[2]], fov: v.fov };
      }
      return inRoomView(id, opts) || outsideRoomView(id) || above();
    }
    // A room no camera can stand in (a cupboard) is seen from the room it
    // opens onto, through its door, at walking eye height -- inside the
    // house, never from above (src/doorway-walk.js outsideView). flyTo holds
    // its door open while it is the view.
    const outsideViews = new Map();   // room id -> { pose, portal, standIn } | null
    function outsideRoomView(id) {
      // Every door's leaf where it is heading (a swing's target, else where
      // it stands): the neighbours' doors as they will be when the camera
      // arrives. The cupboard's own door is hidden while it is the view
      // (setViewDoor). Chosen per request -- doors move -- and cheap.
      const leaves = (DOORS || []).filter(d => doorById[d.id]).map(d => {
        const dr = doorById[d.id], sw = doorSwings.get(d.id), pct = sw ? sw.to : dr.openPct;
        const h = doorBasis(d).hinge, t = doorLeafTip(d, dr.maxDeg * pct / 100);
        return [[tx(h[0]), tz(h[1])], [tx(t[0]), tz(t[1])], d.id];
      });
      outsideViews.set(id, outsideView(navGraph(), id, { leaves, aspect: cam.aspect }));
      const v = outsideViews.get(id);
      return v ? clonePose(v.pose) : null;
    }
    // ---- In-room room views (src/camera-focus.js chooseInRoomView) --------
    //
    // Chosen once per room and cached; the cache is keyed by the canvas
    // aspect and the covering sidebar (the frame depends on both) and is
    // dropped whenever the furniture is rebuilt -- every edit-mode change
    // (move, add, delete, a draft applied) assigns a new furnitureResult --
    // shown or hidden, or the aspect changes.
    // lastRoomViewStats() reports what the last one cost and chose.
    const roomViewCache = new Map();
    let roomViewCacheFurn = null, roomViewCacheVis = null, roomViewCacheAspect = null;
    let lastRoomViewStats = null;
    let lastRoomViewInputs = null;   // what the last computed room view was chosen from (checks / tuning)
    function roomItems(id, poly) {
      const byId = furnitureResult && furnitureVisible && furnitureResult.byId ? furnitureResult.byId : null;
      if (!byId) return [];
      const out = [];
      Object.keys(byId).forEach(k => {
        const e = byId[k], b = e.worldBox;
        if (!b) return;
        // Its own room's, and standing in it: a wall-mounted item may sit on
        // the boundary, but one outside it (a balcony deck tagged to the room
        // it opens off) is not part of the shot.
        const cx = (b.min[0] + b.max[0]) / 2, cz = (b.min[2] + b.max[2]) / 2;
        const inRoom = insidePoly(poly, cx, cz) || distToPolyEdge(poly, cx, cz) < 0.2;
        if ((e.room == null || e.room === id) && inRoom) out.push({ id: k, box: b });
      });
      // Its curtains too: a window wall is half of what a room looks like.
      CURTAINS.forEach(cu => {
        const e = curtainById[cu.id];
        if (cu.room !== id || !e || !e.built || !e.built.group) return;
        const bb = new THREE.Box3().setFromObject(e.built.group);
        if (bb.isEmpty()) return;
        out.push({ id: cu.id, kind: 'curtain', box: { min: bb.min.toArray(), max: bb.max.toArray() } });
      });
      return out;
    }
    function inRoomView(id, opts) {
      // Dropped on a furniture rebuild, on a furniture show/hide (a view chosen
      // with the furniture hidden can stand the eye in a wardrobe), and when
      // the aspect changes (only the latest is kept: a resize is not a leak).
      const aspectKey = cam.aspect.toFixed(2);
      if (roomViewCacheFurn !== furnitureResult || roomViewCacheVis !== furnitureVisible || roomViewCacheAspect !== aspectKey) {
        roomViewCache.clear(); roomViewCacheFurn = furnitureResult; roomViewCacheVis = furnitureVisible; roomViewCacheAspect = aspectKey;
      }
      const ins = opts && opts.inset && opts.inset.right > 0 ? opts.inset : null;
      const key = id + '|' + cam.aspect.toFixed(2) + '|' + (ins ? [ins.right, ins.width, ins.height].map(Math.round).join('x') : '-');
      let res = roomViewCache.get(key);
      const hit = !!res;
      if (!res) { res = computeInRoomView(id, ins); roomViewCache.set(key, res); }
      lastRoomViewStats = Object.assign({ room: id, cached: hit }, res.stats);
      return res.pose ? clonePose(res.pose) : null;
    }
    function computeInRoomView(id, inset) {
      const t0 = performance.now();
      const poly = roomShape(id).map(p => [tx(p[0]), tz(p[1])]);
      const ceiling = HOUSE.ceilingHeight || WH;
      const items = roomItems(id, poly);
      const lights = [];
      const groups = LIGHTS[id] || {};
      Object.keys(groups).forEach(ch => ((groups[ch] && groups[ch].positions) || []).forEach(p => {
        if (!p || !p.at) return;
        const y = p.heightCm != null ? Math.min(ceiling - 0.03, p.heightCm / 100) : ceiling - 0.05;
        lights.push([tx(p.at[0]), y, tz(p.at[1])]);
      }));
      const doors = [];
      (DOORS || []).forEach(d => {
        const c = d.wall === 'x' ? [d.c, d.at] : [d.at, d.c];
        const w = [tx(c[0]), tz(c[1])];
        if (distToPolyEdge(poly, w[0], w[1]) < 0.3) doors.push(w);
      });
      // The building's meshes near the room, judged as an in-room camera
      // draws them: every wall solid (eyeInRoom), the ceiling never in the
      // way of anything under it, glass and the floor click-catchers not.
      let cx = 0, cz = 0;
      poly.forEach(p => { cx += p[0]; cz += p[1]; });
      cx /= poly.length; cz /= poly.length;
      let reach = 0;
      poly.forEach(p => { reach = Math.max(reach, Math.hypot(p[0] - cx, p[1] - cz)); });
      // Only what stands INSIDE the room can hide part of it from a camera in
      // it: the room's own walls are its polygon (the chooser tests that
      // itself), so meshes are kept when their box reaches into the room's
      // box shrunk by 5 cm -- doors, curtains, fittings, a chimney breast --
      // which keeps the ray test to a fraction of the building.
      const rb = new THREE.Box3(
        new THREE.Vector3(Math.min(...poly.map(p => p[0])) + 0.05, 0.01, Math.min(...poly.map(p => p[1])) + 0.05),
        new THREE.Vector3(Math.max(...poly.map(p => p[0])) - 0.05, ceiling - 0.01, Math.max(...poly.map(p => p[1])) - 0.05));
      const _mb = new THREE.Box3();
      const list = occluderList([cx, ceiling / 2, cz], reach + 1.5).filter(o => {
        if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
        return _mb.copy(o.geometry.boundingBox).applyMatrix4(o.matrixWorld).intersectsBox(rb);
      });
      const fadeOf = new Map();
      wallMeshes.forEach(w => fadeOf.set(w.mesh, w));
      const blocks = h => {
        const o = h.object;
        if (o === ceilingMesh) return false;
        const f = fadeOf.get(o);
        if (f) return (f.base == null ? 1 : f.base) >= OPACITY_SOLID;
        return materialOpacity(o.material, h.face ? h.face.materialIndex : 0) >= OPACITY_SOLID;
      };
      const PAD = 0.03;
      const occluded = (eye, s, own) => {
        _occO.set(eye[0], eye[1], eye[2]);
        _occD.set(s[0] - eye[0], s[1] - eye[1], s[2] - eye[2]);
        const dist = _occD.length();
        if (!(dist > 0.05)) return false;
        _occD.divideScalar(dist);
        _occRc.set(_occO, _occD);
        _occRc.near = 0; _occRc.far = dist - 0.03;
        const hits = _occRc.intersectObjects(list, false);
        for (let k = 0; k < hits.length; k++) {
          const p = hits[k].point;
          // A hit on the item itself (a curtain is a building mesh) is not in the way.
          if (own && p.x > own.min[0] - PAD && p.x < own.max[0] + PAD && p.y > own.min[1] - PAD && p.y < own.max[1] + PAD &&
            p.z > own.min[2] - PAD && p.z < own.max[2] + PAD) continue;
          if (blocks(hits[k])) return true;
        }
        return false;
      };
      lastRoomViewInputs = { room: id, poly, ceiling, items, lights, doors, aspect: cam.aspect, inset };
      const res = chooseInRoomView({ poly, ceiling, items, lights, doors, aspect: cam.aspect, inset, occluded });
      const eyePlan = res.eye ? sceneToHouse(S, OX, OY)(res.eye[0], res.eye[2]) : null;
      return { pose: res.pose, stats: {
        ms: +(performance.now() - t0).toFixed(2), fallback: res.fallback, coverage: +res.coverage.toFixed(3),
        score: +res.score.toFixed(3), kind: res.kind, eyes: res.tried, rays: res.rays, items: items.length,
        lights: lights.length, doors: doors.length, occluders: list.length,
        eyePlan: eyePlan ? [Math.round(eyePlan[0]), Math.round(eyePlan[1])] : null,
        eyeHeight: res.eye ? +res.eye[1].toFixed(2) : null,
        pitchDeg: res.pose ? +(90 - res.pose.ph * 180 / Math.PI).toFixed(1) : null,
        fov: res.pose ? +res.pose.fov.toFixed(1) : null,
      } };
    }
    // The room an eye (world [x, y, z]) stands in, below the wall tops; or
    // null. From inside a room every wall renders solid: the outside-camera
    // fade (a wall facing the camera goes see-through) would open the room's
    // own side walls onto the garden at the edges of a wide lens.
    let _toHouse = null;
    function eyeInRoom(eye) {
      if (!(eye[1] < WH)) return null;
      if (!_toHouse) _toHouse = sceneToHouse(S, OX, OY);
      const p = _toHouse(eye[0], eye[2]);
      for (const id of Object.keys(ROOMS)) {
        const poly = roomShape(id);
        if (poly && insidePoly(poly, p[0], p[1])) return id;
      }
      return null;
    }
    function authoredOwner(kind, id) {
      if (kind === 'room') return ROOMS[id] || null;
      if (kind === 'furniture') return (HOUSE.furniture || []).find(f => f.id === id) || null;
      if (kind === 'curtain') return (HOUSE.curtains || []).find(c => c.id === id) || null;
      return null;
    }
    function authoredView(v, fallbackTgt) {
      return { th: v.th, ph: v.ph, r: v.r, tgt: v.tgt ? v.tgt.slice() : fallbackTgt, fov: v.fov };
    }
    // ---- Occlusion-aware device framing (src/camera-focus.js chooseItemView)
    //
    // A device view shows the WHOLE item as close as that allows, from the
    // angle nearest its front where nothing stands in the way: a plant behind
    // a shelf is framed from the side or from above instead. The chooser is
    // pure; this supplies its two scene questions:
    //   occluded(eye, samples)  how many rays from the camera to points on the
    //                           item hit something solid first. "Solid" is
    //                           judged as the frame AT THAT CAMERA will draw it:
    //                           an exterior wall that fades from that side, the
    //                           ceiling seen from above, glass and the floor
    //                           click-catchers do not block; anything inside
    //                           the item's own box is the item itself.
    //   allowed(eye)            below wall height the camera must be inside the
    //                           item's room -- never behind a wall.
    // Computed once per tap (never per frame); lastFocusStats() reports the
    // cost so it can be measured on the wall tablet.
    let lastFocusStats = null;
    const _occRc = new THREE.Raycaster();
    const _occO = new THREE.Vector3(), _occD = new THREE.Vector3(), _occS = new THREE.Sphere();
    // Occluders, gathered once per tap. Two kinds, because raycasting a merged
    // furniture mesh walks every triangle of every item in it (measured: up to
    // 1.9 s a tap on the real house on a desktop) while a box test is free:
    //   meshes  the building -- walls, doors, fittings, curtains, fixtures --
    //           raycast, within `reach` of the item;
    //   boxes   every OTHER furniture item, as its world box. Conservative
    //           (a table's box blocks under its top too). Skipped: an item
    //           whose box holds the target's centre (the cabinet a thing
    //           stands in), and per camera, one that fades with its wall.
    function occluderList(centre, reach) {
      const c = new THREE.Vector3(centre[0], centre[1], centre[2]);
      const out = [];
      scene.traverse(o => {
        if (!o.isMesh || !o.geometry || !isDrawn(o)) return;
        if (o.userData && o.userData.clickable) return;   // floor click-catchers
        if (isFurniture(o)) return;                       // tested as boxes below
        if (!o.geometry.boundingSphere) o.geometry.computeBoundingSphere();
        _occS.copy(o.geometry.boundingSphere).applyMatrix4(o.matrixWorld);
        if (_occS.center.distanceTo(c) - _occS.radius > reach) return;
        out.push(o);
      });
      return out;
    }
    function furnitureBoxes(centre, reach, targetId) {
      const byId = furnitureResult && furnitureVisible && furnitureResult.byId ? furnitureResult.byId : null;
      if (!byId) return [];
      const out = [];
      Object.keys(byId).forEach(id => {
        if (id === targetId) return;
        const e = byId[id], b = e.worldBox;
        if (!b) return;
        if (centre[0] >= b.min[0] && centre[0] <= b.max[0] && centre[1] >= b.min[1] && centre[1] <= b.max[1] &&
          centre[2] >= b.min[2] && centre[2] <= b.max[2]) return;
        const dx = Math.max(b.min[0] - centre[0], 0, centre[0] - b.max[0]);
        const dy = Math.max(b.min[1] - centre[1], 0, centre[1] - b.max[1]);
        const dz = Math.max(b.min[2] - centre[2], 0, centre[2] - b.max[2]);
        if (Math.hypot(dx, dy, dz) > reach) return;
        const host = e.fadeWallId != null ? wallEntryById[e.fadeWallId] : null;
        out.push({ box: b, host: host && host.outer ? host : null });
      });
      return out;
    }
    function makeOcclusionTest(box, reach, targetId) {
      const centre = [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, (box.min[2] + box.max[2]) / 2];
      const list = occluderList(centre, reach);
      const boxes = furnitureBoxes(centre, reach, targetId);
      const fadeOf = new Map();
      wallMeshes.forEach(w => fadeOf.set(w.mesh, w));
      const PAD = 0.03;
      const inBox = p => p.x > box.min[0] - PAD && p.x < box.max[0] + PAD && p.y > box.min[1] - PAD && p.y < box.max[1] + PAD &&
        p.z > box.min[2] - PAD && p.z < box.max[2] + PAD;
      let rays = 0;
      const test = (eye, samples, limit, look) => {
        // The camera's view direction, as the render loop's wall fade reads
        // it: eye -> the pose's look-at point (orb.tgt once it lands), which
        // a covering sidebar shifts off the item's centre.
        const aim = look || centre;
        let dx = aim[0] - eye[0], dy = aim[1] - eye[1], dz = aim[2] - eye[2];
        const dl = Math.hypot(dx, dy, dz) || 1; dx /= dl; dy /= dl; dz /= dl;
        // From inside a room nothing fades (eyeInRoom): the render loop draws every wall solid.
        const inside = !!eyeInRoom(eye);
        const fades = w => !inside && wallFadeTarget(w.nx * dx + w.nz * dz, w.base) < OPACITY_SOLID;
        const blocks = h => {
          if (inBox(h.point)) return false;                         // the item itself
          const o = h.object;
          if (o === ceilingMesh) return eye[1] <= WH;                 // hidden from above
          const f = fadeOf.get(o);
          if (f && f.outer) return !fades(f);
          return materialOpacity(o.material, h.face ? h.face.materialIndex : 0) >= OPACITY_SOLID;
        };
        // Furniture that stays solid from THIS camera.
        const solidBoxes = boxes.filter(b => !(b.host && fades(b.host)));
        _occO.set(eye[0], eye[1], eye[2]);
        let n = 0;
        for (let i = 0; i < samples.length; i++) {
          const s = samples[i];
          rays++;
          let hit = false;
          for (let k = 0; k < solidBoxes.length && !hit; k++) if (segmentHitsBox(eye, s, solidBoxes[k].box)) hit = true;
          if (!hit) {
            _occD.set(s[0] - eye[0], s[1] - eye[1], s[2] - eye[2]);
            const dist = _occD.length();
            if (!(dist > 1e-6)) continue;
            _occD.divideScalar(dist);
            _occRc.set(_occO, _occD);
            _occRc.near = 0; _occRc.far = Math.max(0, dist - 0.01);
            const hits = _occRc.intersectObjects(list, false);
            for (let k = 0; k < hits.length; k++) if (blocks(hits[k])) { hit = true; break; }
          }
          if (hit) { n++; if (n >= limit) return n; }
        }
        return n;
      };
      test.stats = () => ({ occluders: list.length, boxes: boxes.length, rays });
      return test;
    }
    function makeAllowed(roomId) {
      const toHouse = sceneToHouse(S, OX, OY);
      const polys = roomId && roomShape(roomId) ? [roomShape(roomId)] : Object.keys(ROOMS).map(roomShape);
      return eye => {
        if (eye[1] < 0.15) return false;                 // under the floor
        if (eye[1] >= WH + 0.05) return true;            // above the walls: the dollhouse view
        const p = toHouse(eye[0], eye[2]);
        return polys.some(poly => poly && insidePoly(poly, p[0], p[1]));
      };
    }
    function framedView(box, baseTh, roomId, opts, targetId) {
      const t0 = performance.now();
      const occluded = makeOcclusionTest(box, OCCLUSION_REACH, targetId);
      const res = chooseItemView({ box, baseTh, basePh: ITEM_VIEW.ph, fov: cam.fov, aspect: cam.aspect,
        inset: opts && opts.inset, occluded, allowed: makeAllowed(roomId), aboveY: WH + 0.3 });
      const st = occluded.stats();
      lastFocusStats = { ms: +(performance.now() - t0).toFixed(2), tried: res.tried, occludedRays: res.occluded,
        penalty: +res.penalty.toFixed(3), fallback: res.fallback || null, occluders: st.occluders, boxes: st.boxes, rays: st.rays,
        dTh: +(res.pose.th - baseTh).toFixed(3), ph: +res.pose.ph.toFixed(3), r: +res.pose.r.toFixed(2) };
      return res.pose;
    }
    // How far from the item an occluder can matter: the farthest a candidate
    // camera goes (chooseItemView's maxR) plus a margin.
    const OCCLUSION_REACH = 15;
    const vec3 = p => [p.x != null ? p.x : p[0], p.y != null ? p.y : p[1], p.z != null ? p.z : p[2]];
    const pointBox = (p, h) => ({ min: [p[0] - h, p[1] - h, p[2] - h], max: [p[0] + h, p[1] + h, p[2] + h] });

    function itemView(id, point, opts) {
      const entry = furnitureResult && furnitureResult.byId ? furnitureResult.byId[id] : null;
      const placed = (HOUSE.furniture || []).find(f => f.id === id);
      const pt = point ? vec3(point) : [orb.tgt.x, orb.tgt.y, orb.tgt.z];
      const box = entry && entry.worldBox ? entry.worldBox : pointBox(pt, 0.2);
      const rot = entry && entry.placement ? entry.placement.rotationDeg : (placed ? placed.rotationDeg : 0);
      const f = frontFromRotation(rot);
      if (placed && placed.view) {
        const c = [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, (box.min[2] + box.max[2]) / 2];
        return authoredView(placed.view, c);
      }
      const room = (entry && entry.room) || (placed && placed.room) || null;
      return framedView(box, Math.atan2(f[1], f[0]), room, opts, id);
    }
    function curtainView(id, opts) {
      const c = (HOUSE.curtains || []).find(k => k.id === id);
      if (!c) return null;
      const off = (c.offset || 0) * c.inDir;
      const lo = Math.max(0, (c.top - c.drop)) / 100, hi = c.top / 100;
      let box, front;
      if (c.axis === 'x') {
        const y = c.at + off;
        box = { min: [tx(c.c - c.w / 2), lo, tz(y) - 0.05], max: [tx(c.c + c.w / 2), hi, tz(y) + 0.05] };
        front = [0, c.inDir];
      } else {
        const x = c.at + off;
        box = { min: [tx(x) - 0.05, lo, tz(c.c - c.w / 2)], max: [tx(x) + 0.05, hi, tz(c.c + c.w / 2)] };
        front = [c.inDir, 0];
      }
      if (c.view) return authoredView(c.view, [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, (box.min[2] + box.max[2]) / 2]);
      return framedView(box, Math.atan2(front[1], front[0]), c.room, opts);
    }
    // A light fixture (or any target with no box): a small box round the
    // tapped fixture, preferred from the current azimuth.
    function pointView(point, opts) {
      return framedView(pointBox(vec3(point), 0.15), orb.th, opts && opts.room, opts);
    }

    // Pan — translates orb.tgt (the look-at point) along the camera's actual
    // world-space right/up basis vectors, same approach Three.js OrbitControls
    // uses for its right-drag pan. Scaled by target distance (orb.r) and FOV so
    // a given pixel drag moves the same apparent screen-space amount regardless
    // of zoom level (matches the "consistent pan speed" behavior orbit
    // controls are known for) rather than a flat pixel->world constant.
    function panCam(dx, dy) {
      cam.updateMatrixWorld();
      const e = cam.matrixWorld.elements;
      const right = new THREE.Vector3(e[0], e[1], e[2]);
      const up = new THREE.Vector3(e[4], e[5], e[6]);
      const h = container.clientHeight || 1;
      const targetDistance = Math.abs(orb.r) * Math.tan((cam.fov / 2) * Math.PI / 180);
      const scale = (2 * targetDistance) / h;
      // Drag right -> content follows cursor right -> camera/target shift left
      // (negative right); drag down -> content follows cursor down -> camera/
      // target shift up (positive up). Standard "grab and drag the world" feel.
      orb.tgt.addScaledVector(right, -dx * scale);
      orb.tgt.addScaledVector(up, dy * scale);
      orb.tgt.x = Math.max(PAN_BOUNDS.minX, Math.min(PAN_BOUNDS.maxX, orb.tgt.x));
      orb.tgt.y = Math.max(PAN_BOUNDS.minY, Math.min(PAN_BOUNDS.maxY, orb.tgt.y));
      orb.tgt.z = Math.max(PAN_BOUNDS.minZ, Math.min(PAN_BOUNDS.maxZ, orb.tgt.z));
      updCam();
    }

    // ---- Sunlight from the house's own location -------------------------
    //
    // GEOLOCATED PER HOUSE. Latitude and longitude come from the profile's
    // `site` block, and the sun is put where it really is in the sky --
    // direction, not just brightness -- so its light comes through the right
    // windows and moves through the day and the year. `northOffsetDegrees`
    // turns plan-north to true north. A profile that omits `site` gets a fixed
    // neutral daylight instead of somebody else's sky.
    //
    // Where the position comes from, first match wins:
    //   1. a Settings preset (morning / noon / night), for today's date;
    //   2. a pinned time (?time= / &date=, or setSunTime()) -- reproducible
    //      screenshots at any wall-clock time;
    //   3. Home Assistant's sun.sun azimuth/elevation, while it is fresh;
    //   4. computed from the site and the clock.
    const LAT = HOUSE.site.latitude;
    const LON = HOUSE.site.longitude;
    const HAS_SITE = HOUSE.site.present;
    const NORTH_OFFSET = HOUSE.site.northOffsetDegrees || 0;
    const HOUSE_CX = tx(HOUSE.centre[0]), HOUSE_CZ = tz(HOUSE.centre[1]);
    const skyRig = { sun, hemi: ambLight };
    // With no site: the old fixed sun direction (from the +x/-z side, ~58 deg
    // up), full daylight.
    const NO_SITE_SUN = { azimuth: 63.4, elevation: 58 };
    // sun.sun older than this is treated as gone (HA dropped) and the sun is
    // computed instead. HA republishes it every few minutes by day.
    const HA_SUN_STALE_MS = 20 * 60000;

    let sunEnabled = true;
    // "auto" | "morning" | "noon" | "night"
    let sunMode = "auto";
    let sunTimeOverride = null;   // Date, or null to follow the clock
    let haSun = null;             // { azimuth, elevation, at }
    let lastSun = null;           // what updateSunlight() last used (debug)

    function currentSun() {
      const now = sunTimeOverride ? new Date(sunTimeOverride.getTime()) : new Date();
      // Settings presets (morning / noon / evening / night): src/render-rig.js,
      // the same presets the spec pages' time-of-day control uses.
      const preset = presetSun(sunMode, { hasSite: HAS_SITE, latitude: LAT, longitude: LON, now });
      if (preset) return preset;
      if (sunTimeOverride) {
        return HAS_SITE ? Object.assign(solarPosition(now, LAT, LON), { source: 'time' })
          : Object.assign({}, NO_SITE_SUN, { source: 'fixed' });
      }
      if (haSun && Date.now() - haSun.at < HA_SUN_STALE_MS) {
        return { azimuth: haSun.azimuth, elevation: haSun.elevation, source: 'ha' };
      }
      if (!HAS_SITE) return Object.assign({}, NO_SITE_SUN, { source: 'fixed' });
      return Object.assign(solarPosition(now, LAT, LON), { source: 'site' });
    }

    function updateSunlight() {
      // The sun is a shadow-casting directional light, so ANY change here
      // (intensity, colour, direction, or being switched off entirely) changes
      // its shadow. Invalidating inside the function rather than at each call
      // site covers every caller at once -- setSun(), setSunMode(),
      // setSunTime(), a sun.sun reading, and the loop's own 60-second tick --
      // so a future caller cannot forget to.
      invalidateShadows();
      if (!sunEnabled) {
        daylightSunF = 0;
        daylightDirect = 0;
        lastSun = null;
        updateDaylightPools();
        updateDaylight();
        applyNight(skyRig);
        gndMat.color.setRGB(0x18/255, 0x18/255, 0x18/255);
        scene.background.setRGB(NIGHT.background[0], NIGHT.background[1], NIGHT.background[2]);
        clouds.forEach(c => { c.material.opacity = 0; });
        return;
      }
      const s = currentSun();
      // The sun light and the sky fill (hemisphere: cool from above, warm
      // bounce from below), set by src/render-rig.js exactly as a spec page
      // sets them. Without sun shadows (the low tier) nothing stops an
      // unshadowed sun, so a low one would light interior walls straight
      // through the building: applyDaylight holds it steep there -- azimuth
      // still follows the day, and the pools carry the real angle. With
      // shadows it is held above 3 deg, so the shadow camera is never edge-on
      // to the floor (the light has faded out by then anyway).
      const c = applyDaylight(skyRig, s, {
        northOffset: NORTH_OFFSET, centre: [HOUSE_CX, HOUSE_CZ],
        shadowed: quality.sunShadow && ren.shadowMap.enabled
      });
      lastSun = Object.assign({}, s, { day: c.day, direct: c.direct });
      // The REAL direction drives the window pools on every tier.
      daylightToSun = sunDirection(s.azimuth, s.elevation, NORTH_OFFSET);
      gndMat.color.setRGB(c.ground[0], c.ground[1], c.ground[2]);
      scene.background.setRGB(c.background[0], c.background[1], c.background[2]);
      // Daylight through the windows follows the same sun, gated per window
      // by its curtains.
      daylightSunF = c.day;
      daylightDirect = c.direct;
      daylightHigh = c.high;
      daylightSunColor.setRGB(c.sun[0], c.sun[1], c.sun[2]);
      daylightSkyColor.setRGB(c.sky[0], c.sky[1], c.sky[2]);
      updateDaylightPools();
      updateDaylight();
      // Clouds: lit by the sun's own colour by day, the old dim gold at night.
      const cw = 0.55;
      const cr = 1.0 + (c.sun[0] + (1 - c.sun[0]) * cw - 1.0) * c.day;
      const cg = 0.82 + (c.sun[1] + (1 - c.sun[1]) * cw - 0.82) * c.day;
      const cb = 0.65 + (c.sun[2] + (1 - c.sun[2]) * cw - 0.65) * c.day;
      const cloudOpacity = 0.25 + c.day * 0.6;
      clouds.forEach(cl => {
        cl.material.color.setRGB(cr, cg, cb);
        cl.material.opacity = cloudOpacity;
      });
    }
    updateSunlight();

    let lastSunCheck = 0;

    // ── Pause control ──────────────────────────────────────────────────────
    // The render loop keeps requesting frames (cheap) but does NO work while
    // paused. Two independent reasons to pause, OR'd together:
    //   _hidden   — the tab/app is backgrounded (Page Visibility API). Handled
    //               internally below for every mode.
    //   _inactive — the embedder called setActive(false): the preview is behind
    //               an open popup, off the active swipe slide, or scrolled out.
    // Unpausing resets the clock so rotation/cloud drift don't lurch forward.
    let _hidden = (typeof document !== 'undefined' && document.hidden) || false;
    let _inactive = false;
    let paused = _hidden || _inactive;
    function applyPause() {
      const p = _hidden || _inactive;
      if (p === paused) return;
      paused = p;
      // Adaptive quality: a hidden or inactive scene measures nothing. Drop
      // any probe (its budget spent so far still counts) and go quiet on
      // resume, so the resume gap and its first frames are never samples.
      frameContinuous = false;
      if (paused) endProbe(performance.now());
      else if (adaptive) adaptive.quiet(performance.now(), RESUME_QUIET_MS);
      if (!paused) { lastRender = performance.now(); needsRender = true; } // repaint on resume
    }

    // onRender subscribers — external overlays (e.g. the compass rose in
    // home3d.html) that must update every rendered frame, in lockstep with the
    // on-demand render loop below. Each fn is called AFTER ren.render() with
    // { cam }. Kept as a plain additive list so nothing existing changes
    // behaviour; a throwing subscriber can't break the render loop (guarded).
    const onRenderSubs = [];

    // onDispose subscribers — teardown callbacks registered by whoever OWNS a
    // resource this module cannot reach. The three debug overlays in
    // src/overlays/ are attached by the EMBEDDER (index.html), not by this
    // module, so each one's own dispose() is a handle only the embedder holds.
    // Without this list those overlays would be orphaned on teardown: their
    // groups sit in `scene` (so the traverse below would free their GPU
    // resources) but their window-level keydown listeners and DOM legends would
    // leak, and the overlay would be left holding a disposed scene. The
    // embedder registers each handle here so a single home.dispose() tears the
    // whole assembly down. Subscribers run BEFORE the scene traverse so an
    // overlay can still remove its own group first (they all do).
    const onDisposeSubs = [];
    // Latch so a second dispose() is a no-op rather than a double-free: three.js
    // dispose() is idempotent per-resource, but forceContextLoss() on an
    // already-lost context and removeChild on a detached canvas are not worth
    // re-running, and a second traverse of a torn-down scene is pure noise.
    let _disposed = false;

    // Render loop — frame-rate-capped + pausable. minFrameMs gates the heavy
    // work; dt is measured from the last RENDERED frame so motion stays
    // time-correct regardless of the cap (a 15fps cap rotates at the same speed
    // as uncapped, just in bigger steps).
    let animId;
    let autoAngle = 0;
    const minFrameMs = maxFps > 0 ? (1000 / maxFps) - 1 : 0;
    let lastRender = performance.now();
    let lastRenderTs = 0;          // rAF timestamp of the last drawn frame (the fps cap)
    (function loop(rafTs) {
      animId = requestAnimationFrame(loop);
      // The rAF timestamp (vsync-aligned) times the fps cap and the adaptive
      // samples; performance.now() at callback start jitters by up to a
      // millisecond, which is the whole slack in the 60 fps cap's gate.
      const tickTs = typeof rafTs === 'number' ? rafTs : performance.now();
      if (adaptive) {
        // Every tick, drawn or not: the display's refresh (see estimateVsync).
        lastTickDelta = lastTickTs ? tickTs - lastTickTs : 0;
        if (lastTickTs) {
          tickDeltas.push(tickTs - lastTickTs);
          if (tickDeltas.length > 240) tickDeltas.shift();
          if (++ticksSinceVsync >= 30) {
            ticksSinceVsync = 0;
            vsyncMs = estimateVsync(tickDeltas, vsyncMs);
            cadenceMs = capCadence(minFrameMs, vsyncMs);
          }
        }
        lastTickTs = tickTs;
      }
      if (paused) { frameContinuous = false; gateIdleTicks = 0; return; }
      // First-frame gate: draw NOTHING until the shader precompile above has
      // settled (readyFired is set on every path: success, failure, and no
      // compileAsync at all). Drawing earlier defeats the precompile outright:
      // the frame asks three for programs whose link is still in flight, and
      // three blocks on the driver until it finishes -- one rAF handler that
      // measured 3.0 s cold on the real house (Chrome's "[Violation]
      // 'requestAnimationFrame' handler took 1950ms"), while compileAsync was
      // doing the same work off the main thread in parallel. The loading
      // overlay covers the canvas until onReady, so the frames skipped here
      // were never visible anyway; they only froze the page.
      if (!readyFired) {
        // Nothing is drawn before onReady, so these ticks are idle evidence too.
        frameContinuous = false;
        if (adaptive && ++gateIdleTicks >= 3 && lastTickDelta > 0) {
          idleDeltas.push(lastTickDelta);
          if (idleDeltas.length > 20) idleDeltas.shift();
        }
        return;
      }
      const frameNow = performance.now();
      if (minFrameMs && (tickTs - lastRenderTs) < minFrameMs) { gateIdleTicks = 0; return; }

      // On-demand gate: a non-auto-rotating scene (the #3d popup) renders only
      // while the user is interacting (drag, or the short tail after a wheel/
      // pinch via wakeUntil), while an opacity transition is still settling, or
      // when a redraw was explicitly requested (camera/light/sun/HA change,
      // resize, resume). Otherwise it idles at ~0 GPU — an open-but-untouched
      // popup costs nothing. The preview (autoRotate) always has motion, so it
      // skips this gate and just honours the maxFps cap.
      const interacting = orb.drag || orb.pan || frameNow < wakeUntil;

      // Adaptive pixel ratio: drop while the camera is moving, restore on the
      // trailing edge of the wake tail (~250ms after the last drag/wheel/pinch).
      // Resolved BEFORE the frame is drawn so the buffer is already the right
      // size for this frame rather than the previous one. This is the ONLY
      // writer of the renderer's pixel ratio after construction.
      //
      // ⚠️ ORDER MATTERS: this MUST sit ABOVE the on-demand gate below.
      // The restore is triggered by `interacting` going false, which is the
      // very condition that makes the gate return early — resolve it after the
      // gate and the restoring frame is the one frame that never runs, leaving
      // the scene stuck at dragging resolution until something else happens to
      // request a render. applyPixelRatio() sets needsRender when it changes
      // anything, so the gate below then lets that repaint through.
      applyPixelRatio(resolvePixelRatio(interacting));

      // An adaptive-quality probe keeps the frames coming while it measures.
      if (tickProbe(frameNow, interacting)) needsRender = true;

      if (!autoRotate && !needsRender && !interacting && !transitionsActive && !diagContinuous) {
        // Idle: the next drawn frame's gap is idleness, not cost.
        frameContinuous = false;
        if (adaptive && ++gateIdleTicks >= 3 && lastTickDelta > 0) {
          idleDeltas.push(lastTickDelta);
          if (idleDeltas.length > 20) idleDeltas.shift();
        }
        return;
      }
      gateIdleTicks = 0;

      // Seconds since last rendered frame, clamped so a long idle/pause doesn't jump
      const dt = Math.min((frameNow - lastRender) / 1000, 0.1);
      lastRender = frameNow;
      needsRender = false;


      // A camera flight moves the camera BEFORE this frame's wall fade reads
      // its direction, and reports "still moving" into `animating` below.
      const flightMoving = tickCameraFlight(frameNow);
      if (autoRotate && !orb.drag && !orb.pan) {
        autoAngle += rotateSpeed * dt;
        orb.th = Math.PI * 0.22 + autoAngle;
        updCam();
      }
      // Update sunlight every 60 seconds
      const now = Date.now();
      if (now - lastSunCheck > 60000) { updateSunlight(); lastSunCheck = now; }

      // Transparent walls / ceiling ease toward target; track whether anything is
      // still moving so the loop knows to keep rendering until it settles.
      let animating = false;
      const camDir = new THREE.Vector3().subVectors(orb.tgt, cam.position).normalize();
      // From inside a room every wall is solid (eyeInRoom).
      // A walk is inside throughout, its doorways included.
      const camInside = !!(flight && flight.walk) || !!eyeInRoom([cam.position.x, cam.position.y, cam.position.z]);
      wallMeshes.forEach(({ mesh, nx, nz, outer, base, baseDepthWrite }) => {
        if (!outer) return;
        // `base`: the opacity this mesh is drawn at when its wall is solid.
        // 1 for walls, fittings and opaque furniture; a furniture glass or
        // translucent bucket's own (task f7324d3f), so it fades with its
        // wall and comes back to 0.25, not to 1.
        const b = base == null ? 1 : base;
        const dot = nx * camDir.x + nz * camDir.z;
        // `camDir` runs FROM the camera INTO the screen, and (nx,nz) is the wall's
        // OUTWARD normal — guaranteed outward by the derivation pass at the end of
        // buildScene(), which tests each registered normal against the house bbox
        // centre and flips the inward ones. Do NOT re-derive that from the authored
        // winding: it is NOT consistent across houses (the demo's 4 outer walls are
        // all authored outward, a real 10-room plan's 11 are all authored INWARD),
        // which is why the sign is computed rather than assumed. A wall BETWEEN the
        // camera and the interior has its outward normal pointing back at the
        // camera — ANTI-parallel to camDir — giving dot < 0.
        // Fade those; leave the far side solid so the house still reads as a
        // building rather than an open shell. Walls seen edge-on sit at dot ~= 0
        // and stay solid, which is what keeps the side walls from popping.
        const targetOpacity = camInside ? b : wallFadeTarget(dot, b); // 0.05 x base facing the camera (was 0.12) — design intent: exterior walls fainter when facing camera
        mesh.material.opacity += (targetOpacity - mesh.material.opacity) * 0.12;
        // BLACK-HALF FIX (scout-blackhalf): the living-room acoustic slat panel
        // meshes are a stack of coplanar transparent boxes registered here —
        // write depth only while effectively opaque so the z-buffer resolves the
        // stack (kills the half-solid-black artifact), and stop writing depth
        // once faded so the panel still reads see-through with its exterior wall.
        // Plain single-box walls are unaffected (harmless: they read as opaque).
        // A translucent furniture bucket keeps its own depthWrite (glass:
        // off) while solid, and never writes depth once fading.
        mesh.material.depthWrite = wallFadeDepthWrite(mesh.material.opacity, b, baseDepthWrite);
        if (Math.abs(targetOpacity - mesh.material.opacity) > 0.004) animating = true;
      });
      // Ceilings — see-through while the camera is above the house, solid once
      // it dips below ceiling height (i.e. you're looking from inside a room).
      // A flight over the walls (into or out of a room) clears it from the
      // start and quickly, so the camera never rises through a solid one.
      const arcFlight = !!(flight && flight.arc);
      const ceilTarget = arcFlight || cam.position.y > WH ? 0 : 1.0;
      ceilingMesh.material.opacity += (ceilTarget - ceilingMesh.material.opacity) * (arcFlight ? 0.3 : 0.12);
      if (Math.abs(ceilTarget - ceilingMesh.material.opacity) > 0.004) animating = true;

      // Clouds drift only while the scene is "awake" (auto-rotating preview, or a
      // popup the user is actively moving). An idle popup freezes the sky so it
      // can stop rendering entirely.
      if (autoRotate || interacting) {
        clouds.forEach(cl => {
          cl.position.x += cl.userData.driftSpeed * dt;
          if (cl.position.x > cl.userData.wrapMaxX) cl.position.x = cl.userData.wrapMinX;
        });
      }
      // ── Presence footstep fades + sensor-driven door swings ────────────────
      //
      // Both are BOUNDED: each advances toward a fixed target and reports
      // whether it is still moving. Folding that into `animating` means the
      // existing settle logic owns them — the scene keeps rendering exactly
      // until the last one arrives, then `transitionsActive` goes false and it
      // returns to ZERO frames. Nothing here re-arms a timer or a wake(), so
      // an occupied room costs nothing once its fade has finished.
      // ⚠️ These MUST run before `transitionsActive` is written below, and
      // each returns "still moving" so the flag keeps the loop alive until it
      // finishes. Without that the fade advances on the single frame
      // requestRender() bought and then stalls part-way — observed in the
      // browser as footsteps frozen at opacity 0.31 with the scene idle,
      // which looks like a rendering bug and is actually a stopped animation.
      if (tickFootstepFades()) animating = true;
      if (tickDoorSwings()) animating = true;
      if (tickCurtainMotions()) animating = true;
      if (flightMoving) animating = true;

      transitionsActive = animating;
      // Time the render itself rather than the gap between frames. The gap is
      // the wrong signal twice over: with a maxFps cap it is floored at
      // minFrameMs (a 15fps preview would read ~66ms and never ramp, though
      // its frames are cheap), and on an on-demand scene an idle gap is
      // idleness rather than slowness. ren.render() is the work.
      // NOTE this is CPU-side time. WebGL is asynchronous, so this captures
      // the driver-facing submission cost, not the GPU's own completion — it
      // under-reads a GPU-bound frame. That is acceptable here because it is
      // used only as a permissive "is there obvious headroom" gate, and the
      // ramp is reversible in the sense that raising the ceiling never blocks
      // the drag ramp-down from cutting back in.
      const renderT0 = performance.now();
      ren.render(scene, cam);
      framesRendered++;
      const renderMs = performance.now() - renderT0;
      // The boot gate completes on the first frame drawn after everything it
      // waits on has settled (a no-op every other time). After renderMs, so
      // the overlay's dismiss is never billed to the frame's cost.
      bootGate.frameRendered();
      if (adaptive) {
        // The CPU time of the call, or -- for a GPU-bound shadow pass, which the
        // call does not wait for -- the gap it left before this frame.
        sampleColdFrame(Math.max(renderMs, frameContinuous && prevRenderAt ? tickTs - prevRenderAt : 0));
        if (prevRenderAt && !browserThrottled()) {
          const r = adaptive.feed({ ms: tickTs - prevRenderAt, now: frameNow, continuous: frameContinuous, lowered: appliedRatio < ceilingRatio - RATIO_EPSILON, cadence: cadenceMs, vsync: vsyncMs, wall: Date.now() });
          if (r) onAdaptiveVerdict(r, frameNow);
        }
        prevRenderAt = tickTs;
        frameContinuous = true;
      } else {
        sampleRampFrame(frameNow, renderMs, interacting);
      }
      lastRenderTs = tickTs;

      // Notify onRender subscribers (compass overlay etc.) after the frame is
      // drawn, so screen-space overlays can track the current camera. Guarded
      // so a bad subscriber can't wedge the render loop.
      for (let i = 0; i < onRenderSubs.length; i++) {
        try { onRenderSubs[i](cam); } catch (e) { /* overlay error must not break render */ }
      }
    })();

    // Event handlers (only if interactive or auto-rotate preview needs resize)
    const handlers = [];
    const on = (el, ev, fn, opts) => { el.addEventListener(ev, fn, opts); handlers.push([el, ev, fn, opts]); };

    // Pause whenever the tab/app is backgrounded (every mode). The embedder
    // adds further reasons via setActive() (popup open / off-screen preview).
    on(document, "visibilitychange", () => { _hidden = document.hidden; applyPause(); });

    if (interactive) {
      // Touch contacts currently down. With two or more, one-finger rotate is
      // off: the second finger's pointerdown used to re-arm rotate with its own
      // position as the last point, so the first finger's next pointermove
      // rotated the camera by the whole gap between the fingers.
      const touchIds = new Set();
      const twoFinger = createTwoFingerGesture();

      // One zoom step (src/camera-gestures.js): a factor below 1 moves the
      // camera forward along its view ray -- shortening the orbit radius
      // until PUSH_DISTANCE, then pushing the target itself forward, so
      // zoom-in never stops and never flips. Above 1 zooms out.
      // While the camera stands in the FOCUSED room (an in-room room view),
      // a zoom-out or an orbit keeps the eye in that room, clear of its
      // walls: the user looks round the room rather than backing through the
      // wall behind it into the outside fade rules. A click-away (or another
      // room) flies out as ever. Returns the room to hold, or null.
      function heldRoom() {
        const fr = pickFocusRoom ? pickFocusRoom() : null;
        return fr && eyeInRoom([cam.position.x, cam.position.y, cam.position.z]) === fr ? fr : null;
      }
      function keepEyeInRoom(room) {
        if (!room || !roomShape(room)) return;
        const poly = roomShape(room), wpoly = poly.map(p => [tx(p[0]), tz(p[1])]), toHouse = sceneToHouse(S, OX, OY);
        const inside = e => {
          if (!(e[1] < WH - 0.05)) return false;
          const h = toHouse(e[0], e[2]);
          return insidePoly(poly, h[0], h[1]) && distToPolyEdge(wpoly, e[0], e[2]) > 0.12;
        };
        orb.r = clampRadiusInside([orb.tgt.x, orb.tgt.y, orb.tgt.z], orb.th, orb.ph, orb.r, inside);
      }
      function zoomBy(factor) {
        const held = factor > 1 ? heldRoom() : null;
        const d = dolly(orb.r, factor);
        orb.r = d.r;
        if (d.push > 0) {
          const sp = Math.sin(orb.ph);
          const dir = { x: -sp * Math.cos(orb.th), y: -Math.cos(orb.ph), z: -sp * Math.sin(orb.th) };
          const t = pushTarget(orb.tgt, dir, d.push);
          orb.tgt.set(
            Math.max(PAN_BOUNDS.minX, Math.min(PAN_BOUNDS.maxX, t.x)),
            Math.min(PAN_BOUNDS.maxY, t.y),
            Math.max(PAN_BOUNDS.minZ, Math.min(PAN_BOUNDS.maxZ, t.z)));
        }
        keepEyeInRoom(held);
      }

      on(container, "pointerdown", e => {
        cancelFlight();   // the user takes the camera: stop where it is
        container.setPointerCapture(e.pointerId);
        if (e.pointerType === "touch") touchIds.add(e.pointerId);
        // button: 0=left (rotate, existing), 1=middle, 2=right (pan, new) —
        // industry convention (Three.js OrbitControls, Blender/Maya/SketchUp).
        // Touch contacts always report button 0, so touch keeps rotating here;
        // touch-pan is handled separately below via 2-finger touchmove.
        if (e.button === 2) { orb.pan = true; } else { orb.drag = touchIds.size < 2; }
        orb.px = e.clientX; orb.py = e.clientY;
        clickStart.x = e.clientX; clickStart.y = e.clientY;
      });
      on(container, "pointermove", e => {
        const r = container.getBoundingClientRect();
        mouse.x = ((e.clientX - r.left) / r.width) * 2 - 1;
        mouse.y = -((e.clientY - r.top) / r.height) * 2 + 1;
        if (orb.drag && touchIds.size < 2) {
          const held = heldRoom();
          orb.th += (e.clientX - orb.px) * 0.005;
          orb.ph = Math.max(0.05, Math.min(Math.PI - 0.05, orb.ph - (e.clientY - orb.py) * 0.005));
          keepEyeInRoom(held);
          orb.px = e.clientX; orb.py = e.clientY;
          updCam();
        } else if (orb.pan) {
          panCam(e.clientX - orb.px, e.clientY - orb.py);
          orb.px = e.clientX; orb.py = e.clientY;
        }
      });
      on(container, "pointerup", e => {
        container.releasePointerCapture(e.pointerId);
        touchIds.delete(e.pointerId);
        orb.drag = false;
        orb.pan = false;
        wake(250); // brief tail so the release settles smoothly under on-demand
      });
      on(container, "pointercancel", e => {
        container.releasePointerCapture(e.pointerId);
        touchIds.delete(e.pointerId);
        orb.drag = false;
        orb.pan = false;
        // Same tail as pointerup. REQUIRED for the adaptive pixel ratio: this
        // scene renders on demand, so clearing drag without scheduling a frame
        // leaves the scene stuck at the reduced dragging ratio with nothing
        // queued to restore it — it would stay soft until the user touched it
        // again. A cancelled touch (browser gesture takeover, an incoming call,
        // a stray palm) is common on a phone, which is exactly the device this
        // change is for.
        wake(250);
      });
      // Right-drag is repurposed for pan — suppress the browser's native
      // right-click context menu on the canvas so it doesn't pop up mid-drag.
      on(container, "contextmenu", e => { e.preventDefault(); });
      on(container, "click", e => {
        if (Math.abs(e.clientX - clickStart.x) > 5 || Math.abs(e.clientY - clickStart.y) > 5) return;
        rc.setFromCamera(mouse, cam);
        // Walls block and resolve to the side tapped; furniture and
        // see-through surfaces pass the tap on (src/room-pick.js).
        // ROOMS and the transform are per house, so both are read per tap.
        // Camera focus: while a room is focused the embedder names it, and
        // the tap prefers it (room-pick.js preferFocused). floorPoint is
        // where the ray meets the floor plane, in house cm.
        const toHouse = sceneToHouse(S, OX, OY);
        let focus = null;
        const fr = pickFocusRoom ? pickFocusRoom() : null;
        if (fr) {
          const o = rc.ray.origin, d = rc.ray.direction;
          const t = d.y < -1e-6 ? -o.y / d.y : -1;
          focus = { roomId: fr, floorPoint: t > 0 ? toHouse(o.x + d.x * t, o.z + d.z * t) : null };
        }
        const hits = rc.intersectObjects(scene.children, true);
        const picked = pickRoom(hits, rc.ray.direction, roomPolygons(ROOMS), toHouse, focus);
        // From inside the focused room, a tap on its own walls, ceiling or
        // floor is the click-away: no room click, so the page's background
        // handler sees an empty tap and the camera flies home.
        const first = hits.find(h => isDrawn(h.object));
        if (inRoomTapIsClickAway({ cameraRoom: eyeInRoom([cam.position.x, cam.position.y, cam.position.z]), focusedRoom: fr,
          pickedRoom: picked.roomId, hitFurniture: !!(first && isFurniture(first.object)) })) return;
        if (picked.roomId && onRoomClick) onRoomClick(picked.roomId);
      });
      on(container, "wheel", e => {
        e.preventDefault();
        cancelFlight();
        // See zoomBy above. The old additive step with a -30 floor let r
        // cross zero, which flipped the camera to the far side of the target
        // and turned further zoom-in into zoom-out.
        zoomBy(wheelFactor(wheelDeltaPx(e.deltaY, e.deltaMode)));
        updCam();
        wake(250);
      }, { passive: false });

      // Two fingers: pan OR pinch, decided per gesture (src/camera-gestures.js).
      // One finger still rotates through the pointer handlers above.
      const pt = t => ({ x: t.clientX, y: t.clientY });
      on(container, "touchstart", e => {
        cancelFlight();
        if (e.touches.length === 2) twoFinger.start(pt(e.touches[0]), pt(e.touches[1]));
      }, { passive: true });
      on(container, "touchmove", e => {
        if (e.touches.length === 2) {
          e.preventDefault();
          orb.drag = false;
          const step = twoFinger.move(pt(e.touches[0]), pt(e.touches[1]));
          if (step.zoom !== 1) zoomBy(step.zoom);
          if (step.panDx || step.panDy) panCam(step.panDx, step.panDy); // also updCam()s
          else if (step.zoom !== 1) updCam();
          wake(250);
        } else {
          twoFinger.end();
        }
      }, { passive: false });
      const endTouches = e => { if (e.touches.length < 2) twoFinger.end(); };
      // Keyboard camera input cancels a flight too. The orbit camera has no
      // keyboard controls of its own today; these are the keys one would use,
      // so a future binding (or a browser's own arrow-key handling) never
      // fights a flight in progress.
      const CAMERA_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', '+', '-', '=']);
      on(window, "keydown", e => { if (flight && CAMERA_KEYS.has(e.key)) cancelFlight(); });
      on(container, "touchend", endTouches);
      on(container, "touchcancel", endTouches);
    }

    on(window, "resize", () => {
      // The view a flight is heading to was framed for the old size.
      cancelFlight();
      const w = container.clientWidth, h = container.clientHeight;
      if (w === 0 || h === 0) return;
      cam.aspect = w / h;
      cam.updateProjectionMatrix();
      // Re-assert the CURRENT adaptive ratio before sizing. setSize() alone
      // reuses whatever ratio the renderer last recorded, so a resize landing
      // mid-drag (mobile browser chrome collapsing, orientation change) would
      // otherwise bake the dragging ratio in until the next ratio CHANGE — and
      // applyPixelRatio's change-guard would then treat it as already applied.
      ren.setPixelRatio(appliedRatio);
      ren.setSize(w, h);
      requestRender();
    });

    return {
      scene,
      // The live WebGLRenderer. Exposed so a caller can read `renderer.info`
      // (memory.geometries / memory.textures / programs) — the only way to
      // VERIFY that dispose() actually released anything rather than merely
      // having been called. Returned by reference; callers must not mutate it.
      renderer: ren,
      lightState,
      updateLights: syncLights,
      ROOMS,
      LIGHTS,
      roomIds: ids,
      setSun(enabled) {
        sunEnabled = enabled;
        updateSunlight();
        requestRender();
      },
      setSunMode(mode) {
        sunMode = mode;
        updateSunlight();
        requestRender();
      },
      getSunMode() { return sunMode; },
      // Pin the sun to a moment (a Date, or anything Date accepts), or pass
      // null to follow the clock again. Drives ?time= / &date=: reproducible
      // morning / noon / evening / night renders at any wall-clock time.
      // Returns false (and changes nothing) for an unparseable value.
      setSunTime(when) {
        if (when == null) sunTimeOverride = null;
        else {
          const d = when instanceof Date ? new Date(when.getTime()) : new Date(when);
          if (!Number.isFinite(d.getTime())) return false;
          sunTimeOverride = d;
        }
        updateSunlight();
        requestRender();
        return true;
      },
      getSunTime() { return sunTimeOverride ? new Date(sunTimeOverride.getTime()) : null; },
      // Home Assistant's sun.sun: { azimuth, elevation } in degrees (its own
      // attributes). Ignored unless both are finite; a reading older than
      // HA_SUN_STALE_MS falls back to the computed sun.
      setSunFromHA(reading) {
        if (!reading || !Number.isFinite(reading.azimuth) || !Number.isFinite(reading.elevation)) return false;
        haSun = { azimuth: reading.azimuth, elevation: reading.elevation, at: Date.now() };
        updateSunlight();
        requestRender();
        return true;
      },
      // Per-room door openness (panel slider — UI only, no HA wiring).
      // pct: 0 = fully closed, 100 = fully open at the door's collision-solved
      // max angle, always in its fixed single swing direction (swingSign).
      // Returns null for rooms without a door (living room).
      getDoorOpen(roomId) {
        const dr = doorByRoom[roomId];
        return dr ? dr.openPct : null;
      },
      setDoorOpen(roomId, pct) {
        const dr = doorByRoom[roomId];
        if (!dr) return;
        if (dr.id && walkDoorHold.has(dr.id)) { walkDoorHold.set(dr.id, Math.max(0, Math.min(100, +pct || 0))); return; }
        // A manual set wins outright over an in-flight sensor swing on the
        // same door: cancel the animation rather than letting the two fight
        // over openPct frame by frame.
        if (dr.id) doorSwings.delete(dr.id);
        dr.openPct = Math.max(0, Math.min(100, +pct || 0));
        dr.pivot.rotation.y = dr.swingSign * (dr.maxDeg * dr.openPct / 100) * Math.PI / 180;
        // MOVES GEOMETRY — a door is a shadow caster, so without this the door
        // swings while its shadow stays where the door used to be. The single
        // most visible way to get this wrong.
        invalidateShadows();
        requestRender();
      },
      // Which doors the scene knows, by their profile id. Lets the panel ask
      // "is this room's door the one a sensor is bound to?" without reaching
      // into the scene's internals.
      getDoorIdForRoom(roomId) {
        const dr = doorByRoom[roomId];
        return dr && dr.id ? dr.id : null;
      },
      getDoorOpenById(doorId) {
        const dr = doorById[doorId];
        return dr ? dr.openPct : null;
      },
      /**
       * Swing a door by its PROFILE ID, animated over DOOR_SWING_MS.
       *
       * pct is a PERCENTAGE of that door's own collision-solved maximum, not
       * an angle — `maxDeg` is already the solved value, so the demo's store
       * cupboard (capped at 28 degrees by its return wall) stops at 28 and
       * never at 90, for free and by construction.
       *
       * Bounded: the swing advances from the render loop and stops reporting
       * movement the moment it arrives, so the scene returns to zero-frame
       * idle. Nothing is left ticking afterwards.
       */
      setDoorOpenById(doorId, pct) {
        const dr = doorById[doorId];
        if (!dr) return;
        const target = Math.max(0, Math.min(100, +pct || 0));
        // Held open by a walk or an outside view: applied when it is let go.
        if (walkDoorHold.has(doorId)) { walkDoorHold.set(doorId, target); return; }
        const inFlight = doorSwings.get(doorId);
        if (inFlight && inFlight.to === target) return;   // already on its way
        if (!inFlight && dr.openPct === target) {
          // Already there. Requesting a frame here would turn a republished
          // sensor state into a render tick, which is the thing this feature
          // must not do.
          return;
        }
        doorSwings.set(doorId, { from: dr.openPct, to: target, startedAt: performance.now() });
        requestRender();
      },
      /**
       * Show or hide a room's footsteps, with a bounded fade in either
       * direction. Idempotent: setting the state a room is already in does
       * nothing at all and requests NO frame, so a sensor republishing its
       * current value cannot cost a render.
       */
      setPresence(roomId, occupied) {
        const mesh = footstepsByRoom[roomId];
        if (!mesh) return;
        const target = occupied ? FOOTSTEP_MAX_OPACITY : 0;
        const inFlight = footstepFades.get(roomId);
        if (inFlight && inFlight.to === target) return;   // already fading there
        if (!inFlight && mesh.material.opacity === target) return;
        footstepFades.set(roomId, {
          from: mesh.material.opacity,
          to: target,
          startedAt: performance.now()
        });
        // Made visible for the whole fade INCLUDING the fade out; the tick
        // clears `visible` only once it has actually reached zero.
        if (occupied) mesh.visible = true;
        // Deliberately NO invalidateShadows(): the footstep mesh has
        // castShadow/receiveShadow false and moves no geometry that casts, so
        // invalidating here would pay for ~60 cubemap shadow renders to show a
        // decal that cannot appear in any of them.
        requestRender();
      },
      /**
       * Drive a curtain by its PROFILE id from a Home Assistant cover.
       * pct: 0 closed .. 100 open (HA current_position). moving: 'opening' |
       * 'closing' | null -- while moving, the curtain runs toward its end stop
       * at a motor-like pace until a settled reading arrives. Idempotent: a
       * republish of the state it is already in requests no frame.
       */
      setCurtainOpen(curtainId, pct, moving) {
        const e = curtainById[curtainId];
        if (!e) return;
        let target = Math.max(0, Math.min(100, +pct || 0));
        let pace = 'settle';
        if (moving === 'opening') { target = 100; pace = 'motor'; }
        else if (moving === 'closing') { target = 0; pace = 'motor'; }
        const inFlight = curtainMotions.get(curtainId);
        if (inFlight && inFlight.to === target && inFlight.pace === pace) return;
        const from = e.built.getOpen();
        if (!inFlight && Math.abs(from - target) < 0.01) return;
        const perHundred = pace === 'motor' ? CURTAIN_MOTOR_MS_PER_100 : CURTAIN_SETTLE_MS_PER_100;
        curtainMotions.set(curtainId, {
          from, to: target, pace, startedAt: performance.now(),
          ms: Math.max(150, Math.abs(target - from) / 100 * perHundred)
        });
        requestRender();
      },
      getCurtainOpen(curtainId) {
        const e = curtainById[curtainId];
        return e ? e.built.getOpen() : null;
      },
      getCurtainIds() { return Object.keys(curtainById); },
      /**
       * Drive a curtain's cornice LED strip from its own light entity.
       * state: { on, bri (0..100), color ('#rrggbb' or null = the profile's
       * cornice colour) }. No-op for a curtain with no lit cornice.
       */
      setCorniceLight(curtainId, state) {
        const e = curtainById[curtainId];
        if (!e || !e.built.corniceStrip) return;
        const st = { on: !!(state && state.on), bri: state && state.bri != null ? +state.bri : 100,
          color: (state && state.color) || null };
        if (e.cornice && e.cornice.on === st.on && e.cornice.bri === st.bri && e.cornice.color === st.color) return;
        e.cornice = st;
        const strip = e.built.corniceStrip;
        const col = new THREE.Color(st.color || strip.userData.restColor);
        const k = st.on ? Math.max(0.05, Math.min(1, st.bri / 100)) : 0;
        strip.material.emissive.copy(col);
        strip.material.emissiveIntensity = 1.5 * k;
        // Off: an unlit LED strip reads as a dim grey line, not a coloured one.
        strip.material.color.copy(st.on ? col : new THREE.Color(0x3a3a3a));
        e.glows.forEach(g => { g.color.copy(col); g.intensity = CORNICE_GLOW_INTENSITY * k * (g.userData.gain || 1); });
        requestRender();
      },
      /**
       * Set a TV's screen (a `tv` furniture item, by its id): 'on' (or
       * true) -> the home-screen picture, 'art' -> the art-mode picture,
       * 'off' (or false) -> black glass. Only uniforms and the emissive
       * map's texture change (tv-screen.js applyTvScreenLook): no light, no
       * shader, and one repaint only when something actually changed.
       * Remembered, so a call before the furniture has attached takes
       * effect when it does.
       */
      setTvScreen(itemId, on) { tvScreens.set(itemId, on); },
      /**
       * Set a smart display's screen (a `smart-display` hub, by item id) to
       * hub-screen.js content: { mode: 'playing', title, artist, art } draws
       * the now-playing card (art: a URL, a { gradient } cover, or null for
       * text only); { mode: 'idle' } restores its built look; 'hold' keeps
       * what is showing. Redrawn and repainted only when the content changed.
       * Remembered, so a call before the furniture attaches takes effect then.
       */
      setHubScreen(itemId, content) { hubScreens.set(itemId, content); },
      // Every built hub screen and what it shows, for tests and the debug seam.
      getHubScreens() {
        return hubScreens.entries().map(([itemId, mesh]) => {
          const c = new THREE.Box3().setFromObject(mesh).getCenter(new THREE.Vector3());
          const st = hubScreens.state(itemId);
          return { itemId, mode: st.mode, art: st.art, version: st.version, draws: hubScreens.stats.draws, barPx: st.barPx,
            emissiveIntensity: mesh.material.emissiveIntensity, centre: c.toArray() };
        });
      },
      // Every built TV screen and its live look, for tests and the debug seam:
      // where it is (world centre, metres) and which way it faces (the
      // horizontal unit normal of its front), so a check can aim setOrbit.
      getTvScreens() {
        return tvScreens.entries().map(([itemId, mesh]) => {
          const c = new THREE.Box3().setFromObject(mesh).getCenter(new THREE.Vector3());
          const n = new THREE.Vector3(0, 0, 1).transformDirection(mesh.matrixWorld);
          return { itemId, on: !!mesh.material.userData.tvOn, mode: mesh.material.userData.tvMode,
            emissive: '#' + mesh.material.emissive.getHexString(), emissiveIntensity: mesh.material.emissiveIntensity,
            hasPicture: !!mesh.material.emissiveMap, centre: c.toArray(), facing: [n.x, n.z] };
        });
      },
      // The cornice downlights actually built for a curtain, in world space,
      // with their live colour/intensity -- for checking the tier counts and
      // that the HA binding reaches every light, not just the first.
      getCorniceGlowDebug(curtainId) {
        const e = curtainById[curtainId];
        if (!e) return null;
        return e.glows.map(g => {
          const p = new THREE.Vector3(), t = new THREE.Vector3();
          g.getWorldPosition(p); g.target.getWorldPosition(t);
          return { pos: p.toArray(), target: t.toArray(), color: '#' + g.color.getHexString(),
            intensity: g.intensity, angle: g.angle, distance: g.distance };
        });
      },
      getCorniceLight(curtainId) {
        const e = curtainById[curtainId];
        if (!e || !e.built.corniceStrip) return null;
        return e.cornice || { on: true, bri: 100, color: null, rest: true };
      },
      // What the window daylight is ACTUALLY doing -- the canvas cannot be
      // read back (preserveDrawingBuffer:false), so this is how a test checks
      // that a closed blackout shuts the light out.
      getDaylightDebug() {
        return {
          sunFactor: daylightSunF,
          direct: daylightDirect,
          sun: lastSun ? { azimuth: lastSun.azimuth, elevation: lastSun.elevation, source: lastSun.source,
            toSun: daylightToSun.slice(), light: [sun.position.x - sun.target.position.x,
              sun.position.y - sun.target.position.y, sun.position.z - sun.target.position.z] } : null,
          fill: { intensity: ambLight.intensity, sky: [ambLight.color.r, ambLight.color.g, ambLight.color.b],
            ground: [ambLight.groundColor.r, ambLight.groundColor.g, ambLight.groundColor.b] },
          windows: daylight.windows.map(e => ({
            id: e.win.id, room: e.win.room, transmit: e.transmit, tint: e.tint.slice(),
            mode: e.mode, pool: e.pool ? e.pool.map(poly => poly.map(p => p.slice())) : null,
            pieces: e.pieces ? e.pieces.map(pc => Object.assign({}, pc)) : [], sunGain: e.sunK || 0,
            patchVisible: e.patch.visible,
            drawCorners: e.geo.drawRange.count
          })),
          rooms: Object.keys(daylight.rooms).map(roomId => {
            const r = daylight.rooms[roomId];
            return { room: roomId, light: r.light ? {
              intensity: r.light.intensity, color: [r.light.color.r, r.light.color.g, r.light.color.b]
            } : null };
          })
        };
      },
      // Frames drawn since construction. Monotonic, and flat while idle.
      getFrameCount() { return framesRendered; },
      // Adaptive quality (task 230713da): where this device is and why.
      // { adaptive, reason ('measuring'|'settled'|why it is off), level,
      //   levelName, levelFrom ('default'|'stored'|'manual'|'?tier='|'pinned'),
      //   maxLevel, tier, dpr, dprStart, dprMax, dprCap, p95, thresholds,
      //   vsyncMs, nextLevel, nextLevelName, blockedFrom, and for Settings >
      //   Quality: mode, canPin, pin, pinNext, levelLabel, levels }
      getQualityStatus() { return qualityStatus(); },
      // fn(status) on every adaptive decision or settle. Returns an unsubscribe.
      onQualityChange(fn) {
        if (typeof fn !== 'function') return () => {};
        qualityListeners.push(fn);
        return () => { const i = qualityListeners.indexOf(fn); if (i !== -1) qualityListeners.splice(i, 1); };
      },
      // Forget this device's measurements (Settings "Re-measure"): the next
      // load starts from the default level again. This load is unchanged.
      // With adaptation off (?tier=, preview, a low fps cap) it touches
      // nothing and returns false: ?tier= must never read or write storage.
      resetQuality() {
        if (!adaptive) return false;
        qualityForgotten = true;
        adaptive.forget();          // drop the pending proposal and any block
        dprCapState = null;
        const ok = clearState(qStorage, qKey);
        console.info('[Home3DScene] Adaptive quality: measurements cleared; the next load starts from the default level.');
        return ok;
      },
      // Settings > Quality (task e7e10870): pin a level for THIS device and
      // shadows= mode (the page and the HA popup keep separate pins), or
      // null for Auto. Nothing structural changes under the running scene:
      // it applies on the next load, and the caller offers the reload.
      // Refused (ok false, with a reason) when ?tier=, the diagnostics level
      // or the preview decides the build, or for a level this device cannot
      // build. { ok, reason?, needsReload }
      setQualityPin(level) {
        if (!pinAllowed) return { ok: false, reason: '?tier= or the page decides the quality here', needsReload: false };
        if (level != null) {
          const opt = Number.isInteger(level) ? levelOptions(levelCtx)[level] : null;
          if (!opt || !opt.available) return { ok: false, reason: opt ? opt.reason : 'no such level', needsReload: false };
        }
        const ok = savePin(qStorage, qPinKey, level == null ? null : level);
        if (!ok) return { ok: false, reason: 'storage unavailable', needsReload: false };
        const now = levelFrom === 'manual' ? startLevelIdx : null;
        console.info(`[Home3DScene] Quality: ${level == null ? 'Auto' : 'manual ' + LEVELS[level].name} from the next load.`);
        notifyQuality();
        return { ok: true, needsReload: (level == null ? null : level) !== now };
      },
      // What the exterior-fade loop is ACTUALLY doing, per outer wall. Same
      // reasoning as getFootstepDebug below: preserveDrawingBuffer is false, so
      // a screenshot reads the canvas back as a single flat colour and a pixel
      // diff can neither confirm nor deny that the right walls faded. This
      // reports the state a capture cannot.
      //
      // `outwardDot` is the wall's DERIVED outward normal dotted with the
      // camera direction -- the exact quantity the fade test thresholds at
      // -0.3. Negative = the wall faces back at the camera (it is between you
      // and the interior) and should be fading; near zero = edge-on, which
      // deliberately stays solid.
      getWallFadeDebug() {
        const camDir = new THREE.Vector3().subVectors(orb.tgt, cam.position).normalize();
        return wallMeshes.filter(w => w.outer).map(w => ({
          nx: +w.nx.toFixed(4),
          nz: +w.nz.toFixed(4),
          outwardDot: +(w.nx * camDir.x + w.nz * camDir.z).toFixed(4),
          opacity: +w.mesh.material.opacity.toFixed(4),
          depthWrite: w.mesh.material.depthWrite,
          transparent: w.mesh.material.transparent,
          pos: [+w.mesh.position.x.toFixed(2), +w.mesh.position.z.toFixed(2)]
        }));
      },
      // What a room's footstep mesh actually IS in the scene graph. The
      // renderer runs with preserveDrawingBuffer:false, so a screenshot cannot
      // read the canvas back and a pixel diff can neither confirm nor deny
      // that footsteps are drawn. This reports the state a capture cannot.
      getFootstepDebug(roomId) {
        const m = footstepsByRoom[roomId];
        if (!m) return null;
        m.geometry.computeBoundingBox();
        const bb = m.geometry.boundingBox;
        return {
          visible: m.visible,
          opacity: m.material.opacity,
          prints: m.geometry.index.count / 6,
          inScene: !!m.parent,
          castShadow: m.castShadow,
          receiveShadow: m.receiveShadow,
          bbox: { min: bb.min.toArray(), max: bb.max.toArray() },
          // Each print's centre and heading in PLAN cm, walking order.
          placements: m.userData.prints || null
        };
      },
      getPresence(roomId) {
        const mesh = footstepsByRoom[roomId];
        if (!mesh) return null;
        const fd = footstepFades.get(roomId);
        if (fd) return fd.to > 0;
        return mesh.material.opacity > 0;
      },
      // Embedder pause control: setActive(false) halts the render loop (no GPU
      // work) without tearing down the scene; setActive(true) resumes. Used by
      // the preview tile to stop rendering behind an open popup / when off-screen.
      setActive(active) { _inactive = !active; applyPause(); },
      setShadows(enabled) {
        ren.shadowMap.enabled = enabled;
        // An unshadowed sun is held steep (see updateSunlight); re-place it.
        updateSunlight();
        // Still correct with autoUpdate off: needsUpdate is the one-shot that
        // refreshes the maps after the toggle. (This setter is the expensive
        // program-cache path — see the tombstone — and is NOT used as a
        // quality knob by anything in the render loop.)
        invalidateShadows();
        // Force all materials to recompile with/without shadow defines
        scene.traverse(obj => { if (obj.material) obj.material.needsUpdate = true; });
        requestRender();
      },
      // Generic on-demand-render trigger for external callers that mutate the
      // scene graph directly (e.g. js/wall-debug-overlay.js toggling its
      // label group's visibility outside any of the setters above) -- this
      // render loop only repaints on requestRender()/wake(), so a direct
      // `scene.add`/`.visible = x` from outside is otherwise invisible until
      // the next drag/scroll.
      requestRender() { requestRender(); },
      // Companion to requestRender() for an external caller that moves real
      // GEOMETRY or changes a LIGHT, rather than just toggling an overlay's
      // labels. Shadow maps only refresh on demand (shadowMap.autoUpdate is
      // off), so a direct scene mutation that casts a shadow needs this or the
      // shadow keeps describing the old position. The existing debug overlays
      // do not need it — they toggle label visibility, and labels do not cast.
      invalidateShadows() { invalidateShadows(); },
      // Show or hide every piece of furniture: its beauty meshes AND its
      // shadow proxies (an invisible object also skips the shadow pass), so
      // the shadows are invalidated too. Showing furniture that was never
      // built (?furniture=0) builds it now, off the critical path as usual.
      setFurnitureVisible(visible) {
        furnitureVisible = !!visible;
        if (furnitureResult) {
          furnitureResult.root.visible = furnitureVisible;
          invalidateShadows();
          requestRender();
        } else if (furnitureVisible) {
          startFurniture();
        }
      },
      getFurnitureVisible() { return furnitureVisible; },
      // The built furniture item whose world box holds `point` (a world
      // position, e.g. a raycast hit), optionally only among `onlyIds` (a
      // Set). { id, type } or null -- null too while furniture is hidden or
      // not yet built. Furniture renders merged, so this is how a tap on a
      // bucket names its item (src/tap-popovers.js, the robot vacuum).
      furnitureItemAt(point, onlyIds) {
        if (!furnitureResult || !furnitureVisible) return null;
        return furnitureItemAt(furnitureResult.byId, point, onlyIds);
      },
      // ---- Edit mode (src/edit-mode.js; see "Edit-mode furniture" above) ----
      // Never called in view mode. begin swaps the house-scope build for one
      // build per room; lift/update/remove rebuild one item or one room and
      // resolve { ms }; end restores the house-scope build from the edits.
      beginFurnitureEdit() { return beginFurnitureEdit(); },
      liftFurnitureItem(id) { return liftFurnitureItem(id); },
      updateFurnitureItem(item) { return updateFurnitureItem(item); },
      removeFurnitureItem(id) { return removeFurnitureItem(id); },
      addFurnitureItem(item) { return addFurnitureItem(item); },
      loadFurnitureBuilder(type) { return loadFurnitureBuilder(type); },
      setFurnitureGhost(item) { return setFurnitureGhost(item); },
      moveFurnitureGhost(dxCm, dyCm) { moveFurnitureGhost(dxCm, dyCm); },
      endFurnitureEdit(items) { return endFurnitureEdit(items); },
      furnitureEditing() { return !!editFurn; },
      // { parts, lifted, items } while editing, else null (checks and diagnostics).
      furnitureEditInfo() {
        return editFurn ? { parts: Array.from(editFurn.parts.keys()), lifted: editFurn.lifted, items: editFurn.items.length } : null;
      },
      highlightFurniture(id) { editHighlight(id); },
      furnitureEditPick(clientX, clientY) { return furnitureEditPick(clientX, clientY); },
      screenToPlan(clientX, clientY, y) { return screenToPlan(clientX, clientY, y); },
      placementPick(clientX, clientY) { return placementPick(clientX, clientY); },
      // The loaded builders (type -> { DEFAULTS, CONTROLS?, defaultsFor? }): the param panel's source.
      furnitureBuilders() { return furnitureModules || (furnitureModules = loadFurnitureModules(furnitureItems)); },
      // Diagnostics for the perf measurement and the visual review: what was
      // built (draws, triangles, which rooms' proxies dropped to low detail)
      // and when it attached, on the performance.now() clock.
      getFurnitureInfo() {
        return {
          items: furnitureItems.length,
          started: furnitureStarted,
          attached: !!furnitureResult,
          visible: furnitureVisible,
          startedAt: furnitureTimeline.start,
          buildStart: furnitureTimeline.buildStart,
          buildEnd: furnitureTimeline.buildEnd,
          attachedAt: furnitureTimeline.attachedAt,
          stats: furnitureTimeline.stats,
          programs: ren.info && ren.info.programs ? ren.info.programs.length : null,
          warnings: furnitureResult ? furnitureResult.warnings.slice() : []
        };
      },
      /**
       * The /diagnostics benchmark's hooks (src/diagnostics/, item 112ec00c).
       * An explicit, documented surface so the benchmark never reaches into
       * this closure. Nothing here runs unless called: the app never calls
       * it, and every knob is inert at its default.
       *
       *   renderer / scene / camera  read-only handles for MEASUREMENT
       *       (renderer.info, the GL context for timer queries,
       *       scene.onBeforeRender/onAfterRender to bracket a frame).
       *   quality()             what this load decided and built.
       *   setPixelRatio(r)      pin the drawing-buffer ratio (null: unpin).
       *   setContinuous(on)     draw every tick instead of on demand.
       *   addPointLights(n)     add n synthetic, shadowless PointLights in a
       *                         grid under the ceiling (a light-count change
       *                         recompiles every lit material, as in the app).
       *   clearPointLights()    remove them all again.
       *   lightCounts()         lights in the scene, by type.
       *   getOrbit()/homeOrbit()  the orbit camera, in world units; drive it
       *                         with setOrbit().
       */
      diagnostics: {
        version: 1,
        renderer: ren,
        scene,
        camera: cam,
        quality() {
          return {
            tier, compileTier: tierInfo.compileTier, level: startLevelIdx, levelName: startLevel.name,
            levelFrom, maxLevel, defaultLevel: defaultLevel(mobileGpu === true, maxLevelFor(tierInfo.compileTier)),
            mobileGpu: gpu.mobileGpu, mobileReason: gpu.reason, mobileCaps: tierInfo.mobileCaps,
            maxFragU, shadows, maxFps, adaptive: adaptiveOff ? 'off: ' + adaptiveOff : 'on',
            sunShadow: quality.sunShadow, roomShadowLights: quality.roomShadowLights,
            shadowMapScale: quality.shadowMapScale, dropMinorFurniture: quality.dropMinorFurniture,
            shadowMapEnabled: ren.shadowMap.enabled, basePixelRatio, furnitureItems: furnitureItems.length
          };
        },
        setPixelRatio(r) {
          diagPixelRatio = (r > 0 && Number.isFinite(r)) ? r : null;
          applyPixelRatio(resolvePixelRatio(false));
          needsRender = true;
          return appliedRatio;
        },
        getPixelRatio() { return appliedRatio; },
        setContinuous(on) { diagContinuous = !!on; needsRender = true; },
        addPointLights(n) {
          let g = scene.getObjectByName('diagnostics-synthetic-lights');
          if (!g) { g = new THREE.Group(); g.name = 'diagnostics-synthetic-lights'; scene.add(g); }
          const fp = HOUSE.footprint;
          const target = g.children.length + Math.max(0, n | 0);
          const cols = Math.max(1, Math.ceil(Math.sqrt(target)));
          const rows = Math.max(1, Math.ceil(target / cols));
          while (g.children.length < target) {
            const k = g.children.length;
            const c = k % cols, rr = Math.floor(k / cols) % rows;
            const x = fp.minX + (fp.maxX - fp.minX) * (c + 0.5) / cols;
            const y = fp.minY + (fp.maxY - fp.minY) * (rr + 0.5) / rows;
            const l = new THREE.PointLight(0xfff1dc, 0.15, 4, 2);
            l.castShadow = false;
            l.position.set(tx(x), WH - 0.25, tz(y));
            g.add(l);
          }
          invalidateShadows();
          return g.children.length;
        },
        /**
         * Add synthetic lights from explicit specs (the strip-light cost
         * stages): {type: 'point'|'rect', position: [x,y,z] world metres,
         * lookAt?: [x,y,z], color?, intensity, distance?, decay?, width?,
         * height?}. A 'rect' is a THREE.RectAreaLight, which renders only
         * after RectAreaLightUniformsLib.init() -- the caller's job. Removed
         * by clearPointLights() with the rest. Returns the synthetic count.
         */
        addLights(specs) {
          let g = scene.getObjectByName('diagnostics-synthetic-lights');
          if (!g) { g = new THREE.Group(); g.name = 'diagnostics-synthetic-lights'; scene.add(g); }
          (specs || []).forEach(s => {
            const color = s.color != null ? s.color : 0xfff1dc;
            let l;
            if (s.type === 'rect') {
              l = new THREE.RectAreaLight(color, s.intensity, s.width || 1, s.height || 0.02);
            } else {
              l = new THREE.PointLight(color, s.intensity, s.distance || 0, s.decay != null ? s.decay : 2);
              l.castShadow = false;
            }
            l.position.set(s.position[0], s.position[1], s.position[2]);
            g.add(l);
            if (s.lookAt) { l.updateMatrixWorld(); l.lookAt(s.lookAt[0], s.lookAt[1], s.lookAt[2]); }
          });
          invalidateShadows();
          return g.children.length;
        },
        /**
         * n anchor points for synthetic strips, spread evenly along the
         * house's authored walls (longest first, round-robin): 0.9 m up,
         * 5 cm off the wall on the side facing the house centre, with `along`
         * (unit, world) the wall's direction and `facing` a point 1 m into
         * the room. World metres. Geometry only -- no names, no ids.
         */
        stripAnchors(n) {
          const walls = WALLS.map(w => ({ w, len: Math.hypot(w.x2 - w.x1, w.y2 - w.y1) }))
            .filter(e => e.len > 60).sort((a, b) => b.len - a.len);
          const out = [];
          if (!walls.length) return out;
          const cx = tx(HOUSE.centre[0]), cz = tz(HOUSE.centre[1]);
          const count = Math.max(0, n | 0);
          const perWall = walls.map(() => 0);
          for (let i = 0; i < count; i++) perWall[i % walls.length]++;
          walls.forEach((e, wi) => {
            const k = perWall[wi];
            for (let j = 0; j < k; j++) {
              const t = (j + 1) / (k + 1);
              const x = tx(e.w.x1 + (e.w.x2 - e.w.x1) * t), z = tz(e.w.y1 + (e.w.y2 - e.w.y1) * t);
              const ax = (e.w.x2 - e.w.x1) / e.len, az = (e.w.y2 - e.w.y1) / e.len;
              let nx = -az, nz = ax;
              if ((cx - x) * nx + (cz - z) * nz < 0) { nx = -nx; nz = -nz; }
              const px = x + nx * (WT / 2 + 0.05), pz = z + nz * (WT / 2 + 0.05);
              out.push({ position: [px, 0.9, pz], along: [ax, 0, az], facing: [px + nx, 0.9, pz + nz] });
            }
          });
          return out.slice(0, count);
        },
        clearPointLights() {
          const g = scene.getObjectByName('diagnostics-synthetic-lights');
          if (g) {
            scene.remove(g);
            g.children.slice().forEach(l => { g.remove(l); if (typeof l.dispose === 'function') l.dispose(); });
          }
          invalidateShadows();
          return 0;
        },
        lightCounts() {
          const lc = { point: 0, pointShadow: 0, spot: 0, spotShadow: 0, directional: 0, directionalShadow: 0,
            hemisphere: 0, ambient: 0, rectArea: 0, synthetic: 0, total: 0 };
          scene.traverse(o => {
            if (!o.isLight) return;
            lc.total++;
            if (o.parent && o.parent.name === 'diagnostics-synthetic-lights') lc.synthetic++;
            if (o.isPointLight) { lc.point++; if (o.castShadow) lc.pointShadow++; }
            else if (o.isSpotLight) { lc.spot++; if (o.castShadow) lc.spotShadow++; }
            else if (o.isDirectionalLight) { lc.directional++; if (o.castShadow) lc.directionalShadow++; }
            else if (o.isHemisphereLight) lc.hemisphere++;
            else if (o.isAmbientLight) lc.ambient++;
            else if (o.isRectAreaLight) lc.rectArea++;
          });
          return lc;
        },
        getOrbit() { return { th: orb.th, ph: orb.ph, r: orb.r, target: [orb.tgt.x, orb.tgt.y, orb.tgt.z] }; },
        homeOrbit() {
          const t = _homeTgt();
          return { th: Math.PI * 0.22, ph: Math.PI * 0.32, r: _defaultDistance, target: [t.x, t.y, t.z] };
        },
        footprintMetres() { return { width: _fpW, depth: _fpD }; }
      },
      // The live orbit camera — external overlays that project world points into
      // screen space (e.g. the compass rose) read this each frame. Returned by
      // reference; callers must not mutate it.
      getCamera() { return cam; },
      // Jump the orbit camera to a named preset view (top/se/front/iso/…) —
      // powers `?camera=<preset>` for scriptable visual review. Unknown/absent
      // name is a no-op (default view unchanged). Returns true if applied.
      setView(name) { return setView(name); },
      // Free camera pose for visual checks: orbit angles plus a world-space
      // look-at point (metres), since the presets can only aim at the floor.
      setOrbit(th, ph, r, target) {
        cancelFlight();
        orb.th = th; orb.ph = ph; orb.r = r;
        if (target) orb.tgt.set(target[0], target[1], target[2]);
        updCam();
      },
      // Preset names, for callers that want to validate/enumerate.
      viewPresets: Object.keys(CAMERA_PRESETS),
      // Camera focus (src/camera-focus.js). getPose/flyTo/cancelFlight drive
      // the flight; isFlying for checks. The *View helpers return the pose a
      // selection frames: a profile `view` when the house authors one, else
      // the derived view. All return null for an unknown id.
      getPose,
      flyTo(pose, opts) { return flyTo(pose, opts); },
      cancelFlight() { return cancelFlight(); },
      isFlying() { return !!flight; },
      // fn() => the room camera focus has framed, or null. A room tap then
      // prefers it over a neighbour reached through a faded wall.
      setPickFocus(fn) { pickFocusRoom = typeof fn === 'function' ? fn : null; },
      roomView(id, opts) { return roomView(id, opts); },
      // opts: { inset } (a covering sidebar), and for pointView { room }.
      // Device views are occlusion-aware (framedView above); lastFocusStats()
      // is what the last one cost and chose.
      itemView(id, point, opts) { return itemView(id, point, opts); },
      curtainView(id, opts) { return curtainView(id, opts); },
      pointView(point, opts) { return pointView(point, opts); },
      // Edit mode ("Frame the view", src/edit-mode.js): replace the authored
      // `view` of a room / furniture item / curtain in the RUNNING house, so a
      // view saved to the draft applies at once, without a reload. `view` is
      // the profile shape ($defs/focusView, plan cm), compiled here exactly as
      // house-loader compiles it; null removes it (back to the derived view).
      // Returns false for an unknown owner or a malformed view.
      setAuthoredView(kind, id, view) {
        const v = view == null ? null : compileFocusView(view, tx, tz);
        if (view != null && !v) return false;
        const e = authoredOwner(kind, id);
        if (!e) return false;
        e.view = v;
        return true;
      },
      hasAuthoredView(kind, id) { const e = authoredOwner(kind, id); return !!(e && e.view); },
      lastFocusStats() { return lastFocusStats; },
      // What the last room view (in-room chooser) cost and chose: ms, coverage,
      // fallback (true = no in-room vantage was good enough), eye, pitch, fov.
      lastRoomViewStats() { return lastRoomViewStats; },
      // The inputs that view was chosen from (world metres), for offline tuning.
      lastRoomViewInputs() { return lastRoomViewInputs; },
      // The last room-to-room walk planned (src/doorway-walk.js): rooms and
      // doors passed, length, duration, highest eye vs the ceiling, and the
      // sampled path (world metres) -- or { failed: true } when it fell back
      // to the flight over the walls. null before the first.
      lastWalk() { return lastWalk; },
      // The navigation graph's portals (doors and open-plan joins), for checks.
      navPortals() { return navGraph().portals.map(p => ({ id: p.id, kind: p.kind, rooms: p.rooms.slice(), width: +p.width.toFixed(3) })); },
      // Where the camera is mid-flight: 'walk' | 'arc' | 'eye' | 'orbit', or null.
      flightMode() { return flight ? flight.mode : null; },
      // The cupboard door hidden while its cupboard is the view, or null.
      hiddenViewDoor() { return hiddenViewDoor; },
      // A built furniture item's world box { min, max } (metres), or null.
      furnitureBox(id) {
        const e = furnitureResult && furnitureResult.byId ? furnitureResult.byId[id] : null;
        return e && e.worldBox ? { min: e.worldBox.min.slice(), max: e.worldBox.max.slice() } : null;
      },
      // Subscribe an overlay to post-render frames. fn(cam) runs after every
      // rendered frame (see onRenderSubs above). Returns an unsubscribe fn.
      // The scene renders on demand, so also nudge one frame now in case the
      // scene is currently idle when the subscriber attaches.
      onRender(fn) {
        if (typeof fn !== "function") return () => {};
        onRenderSubs.push(fn);
        requestRender();
        return () => {
          const i = onRenderSubs.indexOf(fn);
          if (i >= 0) onRenderSubs.splice(i, 1);
        };
      },
      // Subscribe a teardown callback, run when dispose() is called. Returns an
      // unsubscribe fn. This is how an EMBEDDER hands back ownership of things
      // it attached to our scene (the debug overlays in src/overlays/ are
      // attached from index.html, so their dispose handles live there, not
      // here). Registering an overlay handle's dispose is what stops it being
      // orphaned when the scene goes away. A throwing subscriber must not
      // abort the rest of the teardown — the renderer MUST still be freed — so
      // each is guarded, same as onRender.
      onDispose(fn) {
        if (typeof fn !== "function") return () => {};
        onDisposeSubs.push(fn);
        return () => {
          const i = onDisposeSubs.indexOf(fn);
          if (i >= 0) onDisposeSubs.splice(i, 1);
        };
      },
      // Full teardown: stop the loop, detach listeners, hand control back to
      // any onDispose subscriber, then FREE THE GPU RESOURCES and drop the
      // WebGL context.
      //
      // Why the traverse is necessary: ren.dispose() releases the renderer's
      // own internal state, NOT the geometries/materials/textures uploaded
      // through it. This app generates most of its textures procedurally at
      // runtime (9 CanvasTexture sites), so those uploads have no other owner
      // and nothing else will ever release them. Before this, a torn-down
      // scene left every buffer and texture resident until the context was
      // garbage-collected — which, while the embedder still held the returned
      // object, was never.
      //
      // Materials are deduped through a Set because the house shares materials
      // heavily across meshes (walls, floors and the light-bulb meshes each
      // reuse one instance); disposing the same material once per mesh would
      // be wasted work. This mirrors the established in-repo idiom in
      // src/overlays/wall-debug-overlay.js.
      dispose() {
        if (_disposed) return;
        _disposed = true;
        endFlight('cancelled');   // an awaited flight never hangs past teardown
        // Before the traverse below: the furniture owns materials the scene
        // graph cannot reach (a proxy's customDepthMaterial, the depth
        // precompile material). A still-pending attach sees _disposed and
        // frees its own build instead of attaching it (scheduleFurnitureAttach
        // calls disposeFurniture directly on that path -- attachFurniture,
        // and so liveClockStops, never runs for a mid-build dispose, so
        // there is nothing to stop there; stopLiveClocks() below only ever
        // has entries once a clock was actually attached and ticking).
        stopLiveClocks();
        if (furnitureResult) { disposeFurniture(furnitureResult); furnitureResult = null; }
        tvScreens.clear();
        hubScreens.clear();
        shadowDepthProbeMats.forEach(m => m.dispose());
        shadowDepthProbeMats.length = 0;
        // The first-frame gate's fallback timer and context-restored listener:
        // neither may fire into a disposed scene.
        if (readyFallbackTimer !== null) { clearTimeout(readyFallbackTimer); readyFallbackTimer = null; }
        bootGate.cancel();
        if (onGlContextRestored) {
          ren.domElement.removeEventListener('webglcontextrestored', onGlContextRestored);
          onGlContextRestored = null;
        }
        // The shared wallpaper placeholder (see buildScene).
        disposeWallpaperPlaceholder();

        cancelAnimationFrame(animId);
        handlers.forEach(([el, ev, fn, o]) => el.removeEventListener(ev, fn, o));
        handlers.length = 0;
        // Drop render subscribers too: they close over `cam` and would keep the
        // embedder's overlay objects alive through this module.
        onRenderSubs.length = 0;

        // Embedder-owned teardown first, so an overlay can remove its own group
        // from the scene before we traverse what remains.
        onDisposeSubs.forEach((fn) => {
          try { fn(); } catch (e) { /* one bad subscriber must not leak the GPU */ }
        });
        onDisposeSubs.length = 0;

        // Free every GPU resource reachable from the scene graph.
        const seenMaterials = new Set();
        const disposeMaterial = (m) => {
          if (!m || seenMaterials.has(m)) return;
          seenMaterials.add(m);
          // Every texture-valued slot a material can carry, not just .map —
          // this app uses .map plus roughness/normal/emissive/alpha maps, and
          // a missed slot is a silently retained GPU texture.
          for (const key in m) {
            const v = m[key];
            if (v && v.isTexture) v.dispose();
          }
          m.dispose();
        };
        scene.traverse((obj) => {
          if (obj.geometry) obj.geometry.dispose();
          const mat = obj.material;
          if (Array.isArray(mat)) mat.forEach(disposeMaterial);
          else disposeMaterial(mat);
          // SHADOW MAPS are the single biggest allocation here and they are NOT
          // reachable from any material: a light's shadow map is a
          // WebGLRenderTarget hanging off `light.shadow`, owned by the light.
          // Measured on the demo house: 8 of the 35 lights carry one (7
          // PointLight cube atlases at 4096x2048 + one 2048x2048 directional,
          // UnsignedInt depth = 4 bytes/texel), and they account for 8 of the
          // 17 live textures. That is ~240 MB — against ~0.3 MB of geometry
          // and ~19 MB of material textures, so the shadow maps ARE the
          // reclaim, by roughly an order of magnitude. Skipping this line
          // would leave almost all of the freeable memory resident.
          if (obj.isLight && obj.shadow && obj.shadow.map) {
            obj.shadow.map.dispose();
            obj.shadow.map = null;
          }
        });
        // Background may be a texture in other configurations; today it is a
        // Color, which has no dispose(). Guarded so it stays correct if that
        // ever changes.
        if (scene.background && scene.background.isTexture) scene.background.dispose();
        if (scene.environment && scene.environment.isTexture) scene.environment.dispose();
        // Detach children so nothing holds the (now disposed) resources.
        scene.clear();

        ren.dispose();
        // Actually relinquish the WebGL context. Without this the canvas keeps
        // a live context (and its driver-side allocations) until GC decides
        // otherwise; browsers also cap concurrent contexts, so a create/dispose
        // cycle without this eventually loses the OLDEST context and blanks a
        // still-live scene.
        ren.forceContextLoss();
        if (container.contains(ren.domElement)) container.removeChild(ren.domElement);
      }
    };
  }

  // ---- Derived data exports ------------------------------------------------
  //
  // These are the module's PUBLIC SURFACE, consumed by the debug overlays in
  // src/overlays/ and by embedders (index.html reads ROOMS and LIGHTS to build
  // the controls panel). They used to be constants computed once from a
  // hardcoded house. They are now DERIVED FROM THE LOADED PROFILE and rebuilt
  // by refreshExports() whenever useHouse() binds a new one.
  //
  // The exported object identity is stable -- `api` below is created once and
  // its properties are reassigned in place -- so a caller that captured
  // `Home3DScene` at load time sees the current house's data. What a caller
  // must NOT do is destructure a value out before create() has resolved: until
  // a house is bound these are empty. Read them after create().
  //
  // Everything here derives from WALL_EXT (the corner-filled centrelines), not
  // from the authored WALLS, because the overlays draw over what is actually
  // rendered.
  function refreshExports() {
    // Wall segments in WORLD space for wall-debug-overlay.js. `id` is carried
    // through so the overlay labels by the wall's PERMANENT id, never by array
    // position -- position shifts whenever a wall is retired, the id does not.
    api.WALL_SEGMENTS_WORLD = WALL_EXT.map(w => ({
      id: w.id, x1: tx(w.x1), z1: tz(w.y1), x2: tx(w.x2), z2: tz(w.y2)
    }));

    // Door label anchors in WORLD space for door-debug-overlay.js. Each door
    // gets a stable 1-based `num` (its position in the schedule + 1 -- these
    // are user-facing debug labels like "door #3", not permanent ids) plus its
    // opening centre. Centre in cm: for an x-wall door that is [c, at]; for a
    // z-wall door it is [at, c] (see doorBasis).
    api.DOOR_LABELS_WORLD = DOORS.map((d, i) => {
      const cxCm = d.wall === 'x' ? d.c : d.at;
      const cyCm = d.wall === 'x' ? d.at : d.c;
      return { num: i + 1, id: d.id, name: d.name, x: tx(cxCm), z: tz(cyCm) };
    });

    // Model-space footprint for home3d-grid-overlay.js. The grid draws in MODEL
    // coordinates (cm -- the same numbers as the profile) but must place its
    // geometry in WORLD space, so it needs the bounds AND the transform.
    api.FOOTPRINT_BOUNDS = HOUSE
      ? { minX: HOUSE.footprint.minX, maxX: HOUSE.footprint.maxX,
          minY: HOUSE.footprint.minY, maxY: HOUSE.footprint.maxY }
      : { minX: 0, maxX: 0, minY: 0, maxY: 0 };

    // Exported so the overlays position their lines and labels with the exact
    // same transform the scene uses for walls, guaranteeing registration.
    api.COORD_TRANSFORM = { tx, tz, S, OX, OY };

    api.ROOMS = ROOMS;
    api.LIGHTS = LIGHTS;
    api.WALL_HEIGHT = WH;
    api.HOUSE = activeHouse;
    // The compiled furniture placements (house-loader compileFurniture).
    api.FURNITURE = (HOUSE && HOUSE.furniture) || [];
  }

  // The stable public object. Built once; refreshExports() reassigns the
  // house-derived properties in place so the identity never changes.
  const api = {
    create,
    useHouse,
    k2h,
    ROOMS: {},
    LIGHTS: {},
    HOUSE: null,
    FURNITURE: [],
    WALL_HEIGHT: 2.5,
    WALL_SEGMENTS_WORLD: [],
    DOOR_LABELS_WORLD: [],
    FOOTPRINT_BOUNDS: { minX: 0, maxX: 0, minY: 0, maxY: 0 },
    COORD_TRANSFORM: { tx, tz, S, OX, OY }
  };

  return api;
})();
