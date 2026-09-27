/**
 * house-loader.js - fetches a house profile and compiles it for the renderer.
 *
 * A house profile is a directory under houses/<id>/ holding geometry.json (the
 * physical model) and optionally rooms.json (the Home Assistant entity map).
 * See houses/schema.json for the format and docs/house-profile.md for prose.
 *
 * This module is the ONLY place that knows the profile's on-disk shape. It
 * turns a profile into the flat, pre-transformed structures home3d-scene.js
 * renders from, so the engine never parses schema fields itself. Two reasons
 * that boundary matters:
 *
 *   1. The engine used to hold one specific flat as module constants (a WALLS
 *      array, a ROOMS map, per-room `if (id === "living_room")` light-placement
 *      branches). Those are now data, and this file is where data becomes the
 *      shapes that code already expected -- so the renderer's geometry maths is
 *      untouched, which is what makes the refactor verifiable.
 *   2. Everything derived rather than authored (the corner-fill extension, room
 *      bounding boxes, the footprint) is computed HERE, once, from the authored
 *      centrelines and polygons. The profile stores what a human draws; the
 *      compiler stores what the renderer needs.
 *
 * Loaded as a classic (non-module) script like every other file here. Defines
 * one global, `HouseLoader`.
 *
 *   const house = await HouseLoader.load('demo');   // fetch + compile
 *   HouseLoader.compile(geometryDoc, baseUrl);      // compile an in-memory doc
 */

import { insidePoly } from './footstep-walk.js';
import { FINISHES, outsideVector, faceNormalToward, compassVector } from './wall-finish.js';

export const HouseLoader = (() => {
  'use strict';

  // The schema MAJOR this engine understands. A profile written against a
  // newer MAJOR may mean something different by a field we already read, so it
  // is refused rather than rendered wrongly. A newer MINOR is additive by the
  // schema's own contract, so it loads and any unknown field is ignored.
  const SUPPORTED_SCHEMA_MAJOR = 1;

  // Fallbacks for `defaults` keys the profile omits. Same numbers as the
  // schema's documented defaults -- kept in sync by hand, because a static app
  // cannot read the schema's `default` annotations at runtime.
  const DEFAULTS = Object.freeze({
    wallHeight: 250,
    wallThickness: 10,
    doorHeight: 203,
    doorThickness: 4,
    doorOpeningHeight: 207,
    doorFrameReveal: 8,
    // 0 = CLOSED. A door with no sensor bound to it has no known state, and a
    // closed door is the honest depiction of an unknown one -- it is also the
    // exact pose a bound sensor gives for `open === false`. This was 0.2, which
    // left EVERY door in EVERY house standing 20% open, including doors nothing
    // reports on (reported 2026-09-14: a sensorless door's panel read "Open:
    // 20%"). A SENSOR-BOUND door is unaffected: every sensor path sets the pose
    // explicitly rather than inheriting this rest value. A profile that wants a
    // door propped open says so per-door with `restOpenFraction`, which still
    // wins (see compileDoor).
    doorRestOpenFraction: 0
  });

  const MATERIAL_DEFAULTS = Object.freeze({
    wallColor: '#ece9e1',
    ceilingColor: '#f2efe9',
    doorSlabColor: '#ece4d4',
    exteriorColor: '#d9d4c8'
  });

  // A house id becomes a URL path segment, so it is constrained to the same
  // character class the schema uses. This is a path-traversal guard first and a
  // validation second: the id can arrive from ?house= in a URL.
  const HOUSE_ID_RE = /^[a-z][a-z0-9_-]*$/;

  // Texture paths resolve relative to the profile directory and must not escape
  // it. Mirrors the schema's own pattern -- a profile must not be able to point
  // the engine at an arbitrary host. Also rejects a percent-encoded '%2e'
  // (case-insensitive): the WHATWG URL parser decodes '%2e%2e' to '..' before
  // collapsing dot-segments, so a literal-only '..' check alone is not enough
  // -- each use site below adds a second, independent containment check on
  // the resolved URL.
  const TEXTURE_PATH_RE = /^(?!\/)(?!.*\.\.)(?!.*%2e)(?!https?:)[^\\]+\.(png|jpg|jpeg|webp)$/i;

  // Extra-overlay script paths resolve relative to the profile directory under
  // exactly the same rule as textures: profile-relative, no leading slash, no
  // '..', no absolute URL. This one matters MORE than the texture guard, not
  // less -- a texture that escapes the profile paints a wrong picture, whereas
  // a script that escapes it runs arbitrary code in the page's origin. A
  // profile is data; it must never name an arbitrary host to execute from.
  const OVERLAY_PATH_RE = /^(?!\/)(?!.*\.\.)(?!.*%2e)(?!https?:)[^\\]+\.js$/i;

  // Spec-page paths resolve relative to the profile directory under the same
  // rule again. A spec page is a static .html document opened in a new tab --
  // it is never executed in this page's origin, so the risk sits between the
  // texture case and the overlay case. The guard is identical anyway, because
  // a profile naming an arbitrary host is wrong for reasons that have nothing
  // to do with how dangerous the particular asset is.
  const SPEC_PATH_RE = /^(?!\/)(?!.*\.\.)(?!.*%2e)(?!https?:)[^\\]+\.html?$/i;

  /**
   * Second, independent layer for every profile-relative path above: even
   * with the %2e literal rejected by the regex, require the URL that would
   * actually be fetched to still sit inside the profile directory `dir`
   * (e.g. "houses/demo/"). Anchored the same way the page would resolve it.
   * Returns true iff `dir + relPath` stays contained.
   */
  function resolvesInsideProfile(dir, relPath) {
    const anchor = typeof location !== 'undefined' && location.href ? location.href : 'http://localhost/';
    try {
      const resolved = new URL(dir + relPath, anchor).href;
      // './' drops any query, hash and last path segment, so an empty dir
      // (compile(doc, '')) contains against the page's DIRECTORY, not the
      // page URL itself (/app/index.html?house=x -> /app/).
      const base = new URL('./', new URL(dir, anchor)).href;
      return resolved.startsWith(base);
    } catch (e) {
      // dir/relPath failed to parse as a URL at all -- treat as not contained
      // rather than letting an unparseable path through.
      return false;
    }
  }

  /** '#rrggbb' -> 0xrrggbb, for THREE.Color. Falls back when absent/malformed. */
  function hexToInt(hex, fallback) {
    if (typeof hex !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(hex)) return fallback;
    return parseInt(hex.slice(1), 16);
  }

  /** Signed-area shoelace, then absolute: polygon area in the profile's unit^2. */
  function polygonArea(poly) {
    let total = 0;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      total += a[0] * b[1] - b[0] * a[1];
    }
    return Math.abs(total) / 2;
  }

  /**
   * Axis-aligned bounding box of a polygon.
   *
   * THE PROFILE HAS NO RECT. The predecessor's ROOMS carried BOTH a polygon and
   * an x1/y1/x2/y2 rect: the poly drew the floor, the rect drove light centring
   * and the per-room shadow-light range. Two sources for one shape is a bug
   * waiting to happen (they can disagree, and did not have to be updated
   * together), so the schema keeps only the polygon and the bbox is derived
   * here. Anything that read the rect now reads this.
   */
  function polygonBounds(poly) {
    const xs = poly.map(p => p[0]);
    const ys = poly.map(p => p[1]);
    return {
      x1: Math.min.apply(null, xs), y1: Math.min.apply(null, ys),
      x2: Math.max.apply(null, xs), y2: Math.max.apply(null, ys)
    };
  }

  /**
   * Corner-fill geometry extension.
   *
   * Every wall is drawn exactly between its two authored centreline endpoints.
   * At a genuine L-corner (two walls that both physically END at the same point,
   * running in different directions -- as opposed to a T-junction, where one
   * wall runs through and the other merely touches its centreline), neither
   * wall's box picks up the other's half-thickness on the far side of the joint,
   * leaving a small unrendered notch of roughly (thickness/2 x thickness/2).
   *
   * Fix: at every such corner extend BOTH walls' shared endpoint outward past
   * the joint by half a wall thickness, so the boxes overlap through the corner.
   * T-junctions are left alone -- the through-wall already covers the crossing
   * wall's centreline for its whole length, so there is no notch to fill. A
   * corner is told from a T purely by whether the two walls sharing the point
   * are collinear (T) or not (L); there is no per-corner special-casing.
   *
   * This runs on the AUTHORED centrelines from the profile, which is why the
   * profile stores centrelines and not extended endpoints: the extension is a
   * rendering artifact, not a fact about the building. WALL_SEGMENTS_WORLD and
   * FOOTPRINT_BOUNDS both derive from the extended set, as they always did.
   */
  function extendWallsForCorners(walls, defaultThickness) {
    const EPS = 0.5;          // cm tolerance for "the same point"
    const ANGLE_EPS = 0.05;   // cross-product tolerance for "the same direction"

    const dirOf = (x1, y1, x2, y2) => {
      const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy);
      return len < 1e-6 ? [0, 0] : [dx / len, dy / len];
    };
    const samePoint = (ax, ay, bx, by) => Math.abs(ax - bx) < EPS && Math.abs(ay - by) < EPS;
    const collinear = (u, v) => Math.abs(u[0] * v[1] - u[1] * v[0]) < ANGLE_EPS;

    return walls.map((w, i) => {
      const dir = dirOf(w.x1, w.y1, w.x2, w.y2);
      // The extension is half a wall thickness, matching the notch the box
      // leaves. Uses the house-wide default thickness (not this wall's own
      // override) so a thick pillar meeting a thin wall does not shoot a long
      // spur past the joint -- the notch to fill is set by the pair, and the
      // default is the value the reference implementation used for every wall.
      const ext = defaultThickness / 2;
      let extendStart = false, extendEnd = false;
      walls.forEach((ow, j) => {
        if (j === i) return;
        const odir = dirOf(ow.x1, ow.y1, ow.x2, ow.y2);
        if ((samePoint(w.x1, w.y1, ow.x1, ow.y1) || samePoint(w.x1, w.y1, ow.x2, ow.y2)) && !collinear(dir, odir)) extendStart = true;
        if ((samePoint(w.x2, w.y2, ow.x1, ow.y1) || samePoint(w.x2, w.y2, ow.x2, ow.y2)) && !collinear(dir, odir)) extendEnd = true;
      });
      return {
        id: w.id,
        x1: extendStart ? w.x1 - dir[0] * ext : w.x1,
        y1: extendStart ? w.y1 - dir[1] * ext : w.y1,
        x2: extendEnd ? w.x2 + dir[0] * ext : w.x2,
        y2: extendEnd ? w.y2 + dir[1] * ext : w.y2,
        outer: w.outer,
        thickness: w.thickness != null ? w.thickness : defaultThickness,
        height: w.height,
        faceTexture: w.faceTexture,
        finishes: w.finishes || []
      };
    });
  }

  /**
   * Compass hinge/swing -> the engine's wall-relative letters.
   *
   * The schema names both as compass directions so they read straight off an
   * annotated plan. The renderer wants the older two-letter form, plus which
   * axis the wall runs along:
   *
   *   axis 'x'  east-west wall (spans along plan x); hinge e/w, swing n/s
   *   axis 'z'  north-south wall (spans along plan y); hinge n/s, swing e/w
   *
   * The mapping is the identity on the first letter -- the value of doing it
   * here is that an authoring mistake (a hinge parallel to the swing) is caught
   * at load with a message, rather than rendering a leaf inside its own wall.
   */
  function compileDoor(door, wallsById, defaults, warn) {
    const wall = wallsById[door.wall];
    if (!wall) {
      warn('door "' + door.id + '" references wall ' + door.wall + ', which does not exist -- skipped');
      return null;
    }
    const horizontal = Math.abs(wall.y1 - wall.y2) < Math.abs(wall.x1 - wall.x2);
    const axis = horizontal ? 'x' : 'z';
    // The wall's fixed coordinate: for an east-west wall that is its y, for a
    // north-south wall its x. Taken from the AUTHORED centreline (not the
    // corner-extended one) so the door sits on the wall's true centre plane.
    const at = horizontal ? wall.y1 : wall.x1;

    const hingeOk = horizontal ? ['east', 'west'] : ['north', 'south'];
    const swingOk = horizontal ? ['north', 'south'] : ['east', 'west'];
    if (hingeOk.indexOf(door.hinge) === -1) {
      warn('door "' + door.id + '" hinge "' + door.hinge + '" is not along its wall (' +
        (horizontal ? 'east-west' : 'north-south') + ') -- skipped');
      return null;
    }
    if (swingOk.indexOf(door.swing) === -1) {
      warn('door "' + door.id + '" swing "' + door.swing + '" does not cross its wall -- ' +
        'the leaf would render embedded in it; skipped');
      return null;
    }

    return {
      id: door.id,
      name: door.label || door.id,
      wall: axis,
      wallId: door.wall,
      at: at,
      c: door.centre,
      w: door.width,
      h: (door.height != null ? door.height : defaults.doorHeight) / 100,
      hinge: door.hinge[0],                 // 'e'|'w'|'n'|'s'
      swing: door.swing[0],
      ang: door.maxOpenDegrees,
      kind: door.kind || 'standard',
      // The collision solver asks "is this a cupboard?" to decide who yields.
      size: (door.kind === 'cupboard') ? 'cup' : 'std',
      room: door.room,
      rest: door.restOpenFraction != null ? door.restOpenFraction : defaults.doorRestOpenFraction,
      // Did the AUTHOR state this door's rest pose, or is `rest` just inherited
      // from the house-wide default? The renderer forces an unsensored door
      // CLOSED, but must not override a pose someone deliberately authored, so
      // it needs to tell the two apart -- and `rest` alone cannot, because an
      // authored 0.2 and an inherited 0.2 are the same number.
      restExplicit: door.restOpenFraction != null,
      color: door.color
    };
  }

  /**
   * Where a wall-mounted item (a window, a curtain, a wall-anchored piece of
   * furniture) sits relative to its wall: which way is INTO the room, and
   * where the wall's two faces are.
   *
   * A window has no natural compass field for its inside, and asking the
   * author for one invites a contradiction with the `room` they already named.
   * So it is DERIVED from `room` -- by PROBING, not by the room's bounding box.
   *
   * WHY A PROBE. This used to take the side of the wall's centreline that the
   * room's bounding-box MIDPOINT lay on. For a convex room that is right; for an
   * L-shaped one it is not. An L's bbox midpoint can sit on the far side of a
   * wall that bounds one of its arms, so an item on that wall was turned to
   * face out of the room -- a frame on the wrong face, a curtain hung outside
   * the building, a cabinet backed into the wall. So instead: step a short way
   * off each face of the wall, AT THE ITEM'S OWN POSITION along it, and ask
   * which of the two points is inside the room's polygon.
   *
   * The details, each for a reason:
   *   - The step is tried at several distances (WALL_SIDE_PROBE_CM past the
   *     face). A room polygon is traced a few cm off the wall face in some
   *     plans; a single fixed step shorter than that gap lands in the gap on
   *     both sides and reports "neither".
   *   - If the item's centre is ambiguous (an L's inside corner, a polygon
   *     vertex right at the probe), it is retried a centimetre in from each
   *     end of the item's width, before any fallback.
   *   - "Both sides" (the room wraps round a stub wall) falls back to the old
   *     bbox-midpoint rule and SAYS SO. "Neither side" (the room does not touch
   *     this wall there) is an authoring error: warn and skip.
   *
   * scripts/validate-house.py runs the same probe; keep the two in step.
   *
   * Returns null (with a warning) for a wall that is not axis-aligned, exactly
   * as compileDoor's hinge/swing check effectively does -- the carving code in
   * the renderer only cuts openings in walls that run along x or y.
   *
   * @param {string} kindLabel  'window' | 'curtain' | 'furniture', for messages
   * @param {Object} item       has id, wall, centre
   * @param {Object} wall       compiled raw wall (x1..y2, thickness)
   * @param {Object} room       compiled room (poly, bbox)
   * @param {Function} warn
   * @param {number} [width]    the item's width along the wall, cm, if known
   */
  function wallSide(kindLabel, item, wall, room, warn, width) {
    const dx = Math.abs(wall.x1 - wall.x2), dy = Math.abs(wall.y1 - wall.y2);
    if (dx >= 0.5 && dy >= 0.5) {
      warn(kindLabel + ' "' + item.id + '" is on wall ' + item.wall + ', which is not axis-aligned -- skipped');
      return null;
    }
    const horizontal = dy < dx;
    const at = horizontal ? wall.y1 : wall.x1;
    const probe = probeWallSide(room.poly, horizontal, at, wall.thickness,
      horizontal ? [wall.x1, wall.x2] : [wall.y1, wall.y2], item.centre, width);
    let inDir;
    if (probe.inDir) {
      inDir = probe.inDir;
      if (probe.far) {
        warn(kindLabel + ' "' + item.id + '": room "' + room.id + '" only reaches to ' + probe.gap.toFixed(1) +
          ' cm from wall ' + item.wall + '’s ' + (inDir > 0 ? (horizontal ? 'south' : 'east') : (horizontal ? 'north' : 'west')) +
          ' face at centre ' + item.centre + ' -- using that side, but the room may not be on this wall; check it');
      }
    } else if (probe.result === 'both') {
      const roomMid = horizontal ? (room.y1 + room.y2) / 2 : (room.x1 + room.x2) / 2;
      inDir = roomMid >= at ? 1 : -1;
      warn(kindLabel + ' "' + item.id + '": room "' + room.id + '" is on BOTH sides of wall ' + item.wall +
        ' at centre ' + item.centre + ' -- falling back to the room bounding-box midpoint (' +
        (inDir > 0 ? (horizontal ? 'south' : 'east') : (horizontal ? 'north' : 'west')) + ' side)');
    } else {
      warn(kindLabel + ' "' + item.id + '": room "' + room.id + '" is on neither side of wall ' + item.wall +
        ' at centre ' + item.centre + ' -- skipped');
      return null;
    }
    // +1: the room lies on the +y (south) / +x (east) side of the wall.
    return {
      axis: horizontal ? 'x' : 'z',
      at: at,
      inDir: inDir,
      thickness: wall.thickness,
      // Plan coordinate (on the wall's short axis) of each face.
      roomFace: at + inDir * wall.thickness / 2,
      outerFace: at - inDir * wall.thickness / 2
    };
  }

  // How far past each face of a wall the side probe steps, in cm, nearest
  // first. The first distance at which exactly one side is in the room wins.
  const WALL_SIDE_PROBE_CM = Object.freeze([5, 10, 20, 40]);

  /**
   * The pure half of wallSide(): which side of an axis-aligned wall `poly`
   * lies on, at position `centre` along it.
   *
   * @param {Array} poly        room polygon
   * @param {boolean} horizontal  the wall runs along plan x
   * @param {number} at         the wall's fixed coordinate (y if horizontal)
   * @param {number} thickness  cm
   * @param {Array} span        the wall's two end coordinates along its length
   * @param {number} centre     the item's centre along the wall
   * @param {number} [width]    the item's width along the wall
   * @returns {{result: 'plus'|'minus'|'both'|'neither', inDir: (1|-1|0), along: ?number}}
   */
  function probeWallSide(poly, horizontal, at, thickness, span, centre, width) {
    const lo = Math.min(span[0], span[1]), hi = Math.max(span[0], span[1]);
    const clamp = v => Math.max(lo, Math.min(hi, v));
    const c = typeof centre === 'number' && isFinite(centre) ? centre : (lo + hi) / 2;
    const alongs = [clamp(c)];
    if (typeof width === 'number' && width > 2) {
      alongs.push(clamp(c - (width / 2 - 1)), clamp(c + (width / 2 - 1)));
    }
    let sawBoth = false;
    let far = null;
    for (let a = 0; a < alongs.length; a++) {
      const along = alongs[a];
      for (let k = 0; k < WALL_SIDE_PROBE_CM.length; k++) {
        const e = thickness / 2 + WALL_SIDE_PROBE_CM[k];
        const inPlus = horizontal ? insidePoly(poly, along, at + e) : insidePoly(poly, at + e, along);
        const inMinus = horizontal ? insidePoly(poly, along, at - e) : insidePoly(poly, at - e, along);
        if (inPlus !== inMinus) {
          const dir = inPlus ? 1 : -1;
          // A hit only counts if the room actually reaches the wall here: its
          // boundary, walking back from the probe point toward the wall, must
          // come within WALL_SIDE_CONTACT_CM of the face. A far step can
          // otherwise land in the named room on the other side of something
          // else entirely (a corridor, a cupboard) and pick that side.
          const gap = faceGap(poly, horizontal, at + dir * thickness / 2, at + dir * e, along);
          const hit = { result: inPlus ? 'plus' : 'minus', inDir: dir, along: along, gap: gap, far: false };
          if (gap <= WALL_SIDE_CONTACT_CM) return hit;
          if (!far) { hit.far = true; far = hit; }
          continue;
        }
        if (inPlus && inMinus) sawBoth = true;
      }
    }
    // Only a far hit: the room is on that side but does not touch the wall.
    // Use it (skipping would drop an item that has rendered for months), but
    // the caller warns.
    if (far) return far;
    return { result: sawBoth ? 'both' : 'neither', inDir: 0, along: null, gap: null, far: false };
  }

  // How close (cm) the room's boundary must come to a wall's face, at the
  // probed position, for the probe to count the room as touching that wall.
  // Plans routinely trace a room a few cm off the face; more than this and
  // the room is probably not on this wall at all.
  const WALL_SIDE_CONTACT_CM = 10;

  /**
   * Distance from a wall face to the room's boundary, measured along the
   * perpendicular at `along`, walking back from a probe point that is inside
   * the room. 0 if the room reaches the face (or runs into the wall).
   *
   * @param {Array} poly
   * @param {boolean} horizontal  the wall runs along plan x
   * @param {number} face   the face's coordinate on the wall's short axis
   * @param {number} probe  the probe point's coordinate on the same axis
   * @param {number} along  position along the wall
   */
  function faceGap(poly, horizontal, face, probe, along) {
    const lo = Math.min(face, probe), hi = Math.max(face, probe);
    let crossing = null;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      // u = coordinate along the wall, v = across it.
      const ui = horizontal ? poly[i][0] : poly[i][1], vi = horizontal ? poly[i][1] : poly[i][0];
      const uj = horizontal ? poly[j][0] : poly[j][1], vj = horizontal ? poly[j][1] : poly[j][0];
      if ((ui > along) === (uj > along)) continue;
      const v = vi + (vj - vi) * (along - ui) / (uj - ui);
      if (v < lo || v > hi) continue;
      // Keep the crossing nearest the probe point: the room's edge on this line.
      if (crossing === null || Math.abs(v - probe) < Math.abs(crossing - probe)) crossing = v;
    }
    return crossing === null ? 0 : Math.abs(crossing - face);
  }

  // Window defaults. Centimetres, like every authored length.
  const WINDOW_DEFAULTS = Object.freeze({
    sill: 90,
    topSplit: 0.5,
    doorFraction: 0.25,
    frameColor: '#f1ede2'
  });

  /**
   * A window: an opening carved through its wall (and through any other
   * leaves of a cavity wall named in `throughWalls`) plus a glazed assembly.
   * Positioned exactly like a door -- wall id + centre along the wall -- so it
   * follows the wall when the wall moves.
   */
  function compileWindow(win, wallsById, rooms, warn) {
    const room = rooms[win.room];
    if (!room) {
      warn('window "' + win.id + '" belongs to room "' + win.room + '", which is not in this profile -- skipped');
      return null;
    }
    const wall = wallsById[win.wall];
    if (!wall) {
      warn('window "' + win.id + '" references wall ' + win.wall + ', which does not exist -- skipped');
      return null;
    }
    const side = wallSide('window', win, wall, room, warn, win.width);
    if (!side) return null;

    // Extra leaves the opening passes through. Each must run parallel to the
    // host wall, or a "through" cut would slice it crosswise.
    const through = [];
    (win.throughWalls || []).forEach(id => {
      const tw = wallsById[id];
      if (!tw) {
        warn('window "' + win.id + '" throughWalls names wall ' + id + ', which does not exist -- ignored');
        return;
      }
      const twHoriz = Math.abs(tw.y1 - tw.y2) < Math.abs(tw.x1 - tw.x2);
      if ((side.axis === 'x') !== twHoriz) {
        warn('window "' + win.id + '" throughWalls names wall ' + id + ', which is not parallel to wall ' +
          win.wall + ' -- ignored');
        return;
      }
      const twAt = twHoriz ? tw.y1 : tw.x1;
      through.push({ id: id, at: twAt, thickness: tw.thickness });
    });
    // How far the outermost face of the whole sandwich sits beyond the host
    // wall's own outer face, in cm (>= 0). The cill spans the full depth.
    let beyond = 0;
    through.forEach(t => {
      const outer = t.at - side.inDir * t.thickness / 2;
      beyond = Math.max(beyond, (side.outerFace - outer) * side.inDir);
    });

    const kind = win.kind || 'window';
    let doorEnd = null;
    if (kind === 'balcony') {
      const endOk = side.axis === 'x' ? ['east', 'west'] : ['north', 'south'];
      const wanted = win.doorSide || endOk[1];
      if (endOk.indexOf(wanted) === -1) {
        warn('window "' + win.id + '" doorSide "' + wanted + '" is not an end of its wall -- using ' + endOk[1]);
        doorEnd = endOk[1];
      } else {
        doorEnd = wanted;
      }
    }

    return {
      id: win.id,
      name: win.label || win.id,
      kind: kind,
      room: win.room,
      wallId: win.wall,
      throughWallIds: through.map(t => t.id),
      exterior: !!wall.outer,
      axis: side.axis,
      at: side.at,
      inDir: side.inDir,
      hostThickness: side.thickness,
      outerFace: side.outerFace,
      beyond: beyond,
      c: win.centre,
      w: win.width,
      h: win.height,
      sill: win.sill != null ? win.sill : WINDOW_DEFAULTS.sill,
      topSplit: win.topSplit != null ? win.topSplit : WINDOW_DEFAULTS.topSplit,
      doorFraction: win.doorFraction != null ? win.doorFraction : WINDOW_DEFAULTS.doorFraction,
      doorEnd: doorEnd,
      frameColor: hexToInt(win.frameColor, hexToInt(WINDOW_DEFAULTS.frameColor, 0xf1ede2))
    };
  }

  // Curtain defaults -- CurtainSpec's own illustrative defaults.
  const CURTAIN_DEFAULTS = Object.freeze({
    outerColor: '#d98aa8',
    innerColor: '#5f86c4',
    liningColor: '#e7dcc4',
    outerPleats: 5,
    innerPleats: 2,
    openPct: 100,
    opacity: 1,
    corniceColor: '#ffffff',
    corniceDepth: 18,
    corniceHeight: 24,
    corniceLightColor: '#ffe6bd',
    // Offset used when a curtain has neither an `offset` nor a cornice.
    offsetNoCornice: 9
  });

  // Fold-depth budget (cm). CurtainSpec's natural maximum fold amplitude --
  // 5.5 cm base, x2.3 when fully gathered -- plus the lining's distance behind
  // the face, the clearance kept off the wall, and the gap kept between two
  // curtains hung one behind the other.
  const CURTAIN_NATURAL_MAX_AMP = 5.5 * 2.3;
  const CURTAIN_LINING_GAP = 2;
  const CURTAIN_WALL_CLEARANCE = 2.5;
  const CURTAIN_LAYER_GAP = 1;

  /**
   * Stack curtains that share a wall so their folds cannot pass through each
   * other: a blackout with a sheer behind it, say. Each curtain gets `maxAmp`
   * (cm), the deepest its folds may swing about its hanging line, from the
   * room it has between whatever hangs BEHIND it (a curtain with a smaller
   * offset whose span overlaps) and its own hanging line. Processed nearest
   * the wall first, so each one sees the final reach of those behind it.
   */
  function stackCurtains(curtains) {
    const sorted = curtains.slice().sort((a, b) => a.offset - b.offset);
    sorted.forEach((c, i) => {
      let backLimit = CURTAIN_WALL_CLEARANCE;
      for (let j = 0; j < i; j++) {
        const b = sorted[j];
        if (String(b.wallId) !== String(c.wallId)) continue;
        const overlap = Math.min(b.c + b.w / 2, c.c + c.w / 2) - Math.max(b.c - b.w / 2, c.c - c.w / 2);
        if (overlap <= 0) continue;
        backLimit = Math.max(backLimit, b.offset + b.maxAmp + CURTAIN_LAYER_GAP);
      }
      const liningGap = c.sheer ? 0 : CURTAIN_LINING_GAP;
      c.maxAmp = Math.max(1, Math.min(CURTAIN_NATURAL_MAX_AMP, c.offset - liningGap - backLimit));
    });
    return curtains;
  }

  /**
   * Mark a cornice-less curtain that hangs INSIDE another curtain's cornice
   * (a sheer behind a blackout): same wall, overlapping along it, and hung
   * closer to the wall than that cornice is deep. Its heading must then stop
   * under the cornice lid like the owner's does (wall-fittings buildCurtain).
   */
  function markUnderCornice(curtains) {
    curtains.forEach(c => {
      c.underCornice = !c.cornice && curtains.some(o => {
        if (o === c || !o.cornice || String(o.wallId) !== String(c.wallId)) return false;
        const lo = o.cornice.sideFaces ? o.c - o.w * 0.52 : o.roomSpan[0];
        const hi = o.cornice.sideFaces ? o.c + o.w * 0.52 : o.roomSpan[1];
        return c.c + c.w / 2 > lo && c.c - c.w / 2 < hi && c.offset < o.cornice.depth;
      });
    });
    return curtains;
  }

  /**
   * A curtain hung on the room face of a wall. Colours are data (they are the
   * thing an owner most wants to change), so every one of them is a profile
   * field with CurtainSpec's defaults behind it. A sheer is the same curtain
   * with `opacity` below 1.
   */
  function compileCurtain(cur, wallsById, rooms, defaults, warn) {
    const room = rooms[cur.room];
    if (!room) {
      warn('curtain "' + cur.id + '" belongs to room "' + cur.room + '", which is not in this profile -- skipped');
      return null;
    }
    const wall = wallsById[cur.wall];
    if (!wall) {
      warn('curtain "' + cur.id + '" references wall ' + cur.wall + ', which does not exist -- skipped');
      return null;
    }
    const side = wallSide('curtain', cur, wall, room, warn, cur.width);
    if (!side) return null;
    const ceiling = defaults.ceilingHeight != null ? defaults.ceilingHeight : defaults.wallHeight;
    const top = cur.top != null ? cur.top : ceiling;
    const c = cur.cornice || {};
    const cornice = c.enabled === false ? null : {
      sideFaces: c.sideFaces !== false,
      color: hexToInt(c.color, hexToInt(CURTAIN_DEFAULTS.corniceColor, 0xffffff)),
      depth: c.depth != null ? c.depth : CURTAIN_DEFAULTS.corniceDepth,
      height: c.height != null ? c.height : CURTAIN_DEFAULTS.corniceHeight,
      light: c.light !== false,
      lightColor: hexToInt(c.lightColor, hexToInt(CURTAIN_DEFAULTS.corniceLightColor, 0xffe6bd))
    };
    const opacity = cur.opacity != null ? cur.opacity : CURTAIN_DEFAULTS.opacity;
    // The room's extent along the wall, for a wall-to-wall cornice.
    const roomSpan = side.axis === 'x' ? [room.x1, room.x2] : [room.y1, room.y2];
    return {
      id: cur.id,
      name: cur.label || cur.id,
      room: cur.room,
      wallId: cur.wall,
      exterior: !!wall.outer,
      axis: side.axis,
      at: side.at,
      inDir: side.inDir,
      roomFace: side.roomFace,
      roomSpan: roomSpan,
      c: cur.centre,
      w: cur.width,
      // The fully-open stack per side (wall-fittings curtainStackWidth): an
      // absolute width in cm, else cm per pleat x pleats; null = the default.
      stackWidth: cur.stackWidth != null && cur.stackWidth > 0 ? cur.stackWidth : null,
      stackPerPleat: cur.stackPerPleat != null && cur.stackPerPleat > 0 ? cur.stackPerPleat : null,
      top: top,
      drop: cur.height != null ? cur.height : top,
      openPct: cur.openPct != null ? cur.openPct : CURTAIN_DEFAULTS.openPct,
      opacity: opacity,
      // A sheer is one translucent layer: no lining behind it, and it keeps its
      // own opacity rather than joining the exterior-wall fade.
      sheer: opacity < 1,
      // Distance of the hanging line from the wall's room face, cm. Default:
      // the cornice's mid-depth, as CurtainSpec hangs it.
      offset: cur.offset != null ? cur.offset
        : (cornice ? cornice.depth / 2 : CURTAIN_DEFAULTS.offsetNoCornice),
      maxAmp: null,   // filled in by stackCurtains()
      outerColor: hexToInt(cur.outerColor, hexToInt(CURTAIN_DEFAULTS.outerColor, 0)),
      innerColor: hexToInt(cur.innerColor, hexToInt(CURTAIN_DEFAULTS.innerColor, 0)),
      liningColor: hexToInt(cur.liningColor, hexToInt(CURTAIN_DEFAULTS.liningColor, 0)),
      outerPleats: cur.outerPleats != null ? cur.outerPleats : CURTAIN_DEFAULTS.outerPleats,
      innerPleats: cur.innerPleats != null ? cur.innerPleats : CURTAIN_DEFAULTS.innerPleats,
      cornice: cornice
    };
  }

  // ---- Furniture (schemaVersion 1.2) --------------------------------------
  // Placement only. The loader knows nothing about builders: it resolves WHERE
  // an item stands and which way it faces, and passes `params` through
  // untouched. src/furniture/place.js turns this into a back-centre point once
  // the builder's DEFAULTS have filled `params`; src/furniture/registry.js
  // finds the builder. See docs/house-profile.md, "Furniture".

  const FURNITURE_TYPE_RE = /^[a-z][a-z0-9-]*$/;

  /**
   * Plan rotation (degrees clockwise, 0 = front faces +y/south) that makes an
   * item on an axis-aligned wall face INTO the room. The front direction for
   * rotation r is (-sin r, cos r), so:
   *   horizontal wall, room south (+y) -> front ( 0,  1) -> 0
   *   horizontal wall, room north (-y) -> front ( 0, -1) -> 180
   *   vertical wall,   room east  (+x) -> front ( 1,  0) -> 270
   *   vertical wall,   room west  (-x) -> front (-1,  0) -> 90
   */
  function rotationIntoRoom(axis, inDir) {
    if (axis === 'x') return inDir > 0 ? 0 : 180;
    return inDir > 0 ? 270 : 90;
  }

  const isNum = v => typeof v === 'number' && isFinite(v);

  /**
   * One `furniture[]` entry -> the compiled placement the renderer reads:
   *
   *   { id, room, type, origin: 'back'|'centre', x, y, rotationDeg, elevation,
   *     params, hostWallId, exterior, fade, priority, label }
   *
   * `origin: 'back'` (wall anchor): x/y is already the back-centre point.
   * `origin: 'centre'` (free anchor): x/y is the footprint centre, and the back
   * is found later from the resolved depth (place.js resolvePlacement).
   *
   * Every failure warns and skips just this item, like doors and windows.
   */
  function compileFurniture(f, wallsById, rooms, warn) {
    const id = f && f.id != null ? f.id : '?';
    const label = 'furniture "' + id + '"';
    if (!f || typeof f !== 'object') {
      warn('furniture entry is not an object -- skipped');
      return null;
    }
    if (typeof f.type !== 'string' || !FURNITURE_TYPE_RE.test(f.type)) {
      warn(label + ' has no valid type -- skipped');
      return null;
    }
    const room = rooms[f.room];
    if (!room) {
      warn(label + ' belongs to room "' + f.room + '", which is not in this profile -- skipped');
      return null;
    }
    const hasAt = f.at != null, hasWall = f.wall != null;
    if (hasAt === hasWall) {
      warn(label + (hasAt ? ' gives both `at` and `wall`' : ' gives neither `at` nor `wall`') +
        ' -- an item uses exactly one anchor; skipped');
      return null;
    }
    if (hasWall && f.rotation != null) {
      warn(label + ' gives `rotation` with a wall anchor -- a wall-anchored item always faces into ' +
        'its room; skipped');
      return null;
    }

    let fade = 'auto';
    if (f.fade === 'never' || f.fade === 'auto' || f.fade == null) {
      fade = f.fade || 'auto';
    } else if (typeof f.fade === 'object' && f.fade.wall != null) {
      if (!wallsById[f.fade.wall]) {
        warn(label + ' fade.wall names wall ' + f.fade.wall + ', which does not exist -- skipped');
        return null;
      }
      fade = { wall: f.fade.wall };
    } else {
      warn(label + ' fade ' + JSON.stringify(f.fade) + ' is not "auto", "never" or {wall} -- skipped');
      return null;
    }

    const params = (f.params && typeof f.params === 'object') ? Object.assign({}, f.params) : {};
    const elevation = isNum(f.elevation) ? f.elevation : 0;
    const out = {
      id: f.id,
      room: f.room,
      type: f.type,
      origin: null,
      x: 0,
      y: 0,
      rotationDeg: 0,
      elevation: elevation,
      params: params,
      hostWallId: null,
      exterior: false,
      fade: fade,
      priority: f.priority === 'minor' ? 'minor' : 'normal',
      label: f.label || f.id
    };

    if (hasAt) {
      if (!Array.isArray(f.at) || f.at.length !== 2 || !isNum(f.at[0]) || !isNum(f.at[1])) {
        warn(label + ' `at` is not [x, y] -- skipped');
        return null;
      }
      const r = isNum(f.rotation) ? f.rotation : 0;
      out.origin = 'centre';
      out.x = f.at[0];
      out.y = f.at[1];
      out.rotationDeg = ((r % 360) + 360) % 360;
      return out;
    }

    const wall = wallsById[f.wall];
    if (!wall) {
      warn(label + ' references wall ' + f.wall + ', which does not exist -- skipped');
      return null;
    }
    if (!isNum(f.centre)) {
      warn(label + ' is wall-anchored but has no numeric `centre` -- skipped');
      return null;
    }
    {
      // Same rule as scripts/validate-house.py: the back's centre must lie
      // on the wall. Off the end, the item would float beside it.
      const horiz = Math.abs(wall.y1 - wall.y2) < Math.abs(wall.x1 - wall.x2);
      const lo = Math.min(horiz ? wall.x1 : wall.y1, horiz ? wall.x2 : wall.y2);
      const hi = Math.max(horiz ? wall.x1 : wall.y1, horiz ? wall.x2 : wall.y2);
      if (f.centre < lo - 1e-6 || f.centre > hi + 1e-6) {
        warn(label + ' centre ' + f.centre + ' is outside wall ' + f.wall + '’s span (' + lo + '..' + hi + ') -- skipped');
        return null;
      }
    }
    const side = wallSide('furniture', f, wall, room, warn, isNum(params.width) ? params.width : undefined);
    if (!side) return null;
    const offset = isNum(f.offset) ? f.offset : 0;
    const perp = side.roomFace + side.inDir * offset;
    out.origin = 'back';
    if (side.axis === 'x') { out.x = f.centre; out.y = perp; } else { out.x = perp; out.y = f.centre; }
    out.rotationDeg = rotationIntoRoom(side.axis, side.inDir);
    out.hostWallId = f.wall;
    out.exterior = !!wall.outer;
    return out;
  }

  /**
   * Auto-place `n` fixtures over a room when the profile gives a count but no
   * positions. Deliberately simple and deliberately generic-looking: a grid
   * inset from the room's bounding box. It is the "you have not said where your
   * lights are" answer, not a layout engine -- one fixture lands at the room
   * centre, which is what a single pendant or bulb wants anyway.
   */
  function autoPlace(room, n) {
    const cx = (room.x1 + room.x2) / 2, cy = (room.y1 + room.y2) / 2;
    if (n <= 1) return [{ at: [cx, cy] }];
    const cols = Math.ceil(Math.sqrt(n));
    const rows = Math.ceil(n / cols);
    const w = room.x2 - room.x1, h = room.y2 - room.y1;
    const out = [];
    // Lay the grid out SYMMETRICALLY about the room centre. When n does not
    // fill the last row (5 into a 3x2 grid), spacing that row as if it were
    // full leaves the arrangement lopsided and drags its centroid off-centre --
    // and a spot cluster hangs its shared PointLight at exactly that centroid,
    // so the room ends up lit from a point that is not its middle. Each row is
    // therefore spaced across its OWN occupancy, which leaves a full grid
    // exactly where it was and only re-centres a short final row.
    for (let r = 0; r < rows && out.length < n; r++) {
      const inRow = Math.min(cols, n - r * cols);
      for (let c = 0; c < inRow; c++) {
        out.push({ at: [
          room.x1 + w * (c + 1) / (inRow + 1),
          room.y1 + h * (r + 1) / (rows + 1)
        ] });
      }
    }
    return out;
  }

  /**
   * A wall's `finishes` (schemaVersion 1.3), resolved for the renderer.
   *
   * Each entry names ONE long face -- `side: "exterior"` (the face pointing
   * away from the footprint centre), `side: <compass>`, or `room: <id>` (the
   * face fronting that room, probed exactly as a window's is) -- and this turns
   * it into a plan-space unit `normal`, so the renderer never re-derives it.
   * A bad entry is warned about and dropped: a finish is a decoration, and a
   * wall rendered plain is the right degradation.
   *
   * @returns {Array<{finish, normal:[number,number], from:number|null,
   *   to:number|null, along:[number,number]|null}>}
   */
  function compileWallFinishes(wall, rooms, centre, warn) {
    const out = [];
    const horizontal = Math.abs(wall.y2 - wall.y1) < Math.abs(wall.x2 - wall.x1);
    const axisAligned = Math.abs(wall.x1 - wall.x2) < 0.5 || Math.abs(wall.y1 - wall.y2) < 0.5;
    wall.finishes.forEach((f, i) => {
      const where = 'wall ' + wall.id + ' finishes[' + i + ']';
      if (!f || FINISHES.indexOf(f.finish) === -1) {
        warn(where + ': unknown finish "' + (f && f.finish) + '" (known: ' + FINISHES.join(', ') + ') -- skipped');
        return;
      }
      if ((f.side == null) === (f.room == null)) {
        warn(where + ': give exactly one of `side` or `room` -- skipped');
        return;
      }
      let along = null;
      if (f.along != null) {
        if (!Array.isArray(f.along) || f.along.length !== 2 || !f.along.every(Number.isFinite)) {
          warn(where + ': `along` must be [start, end] in plan cm -- skipped');
          return;
        }
        if (!axisAligned) {
          warn(where + ': `along` needs a wall that runs along plan x or y -- finishing the whole length');
        } else {
          along = [Math.min(f.along[0], f.along[1]), Math.max(f.along[0], f.along[1])];
        }
      }
      const from = Number.isFinite(f.from) ? f.from : null;
      const to = Number.isFinite(f.to) ? f.to : null;
      if (from !== null && to !== null && !(to > from)) {
        warn(where + ': `to` (' + to + ') must be above `from` (' + from + ') -- skipped');
        return;
      }
      let normal = null;
      let endAt = null;   // plan point of the END face this finish is on, if it is on one
      const dl = Math.hypot(wall.x2 - wall.x1, wall.y2 - wall.y1) || 1;
      const dir = [(wall.x2 - wall.x1) / dl, (wall.y2 - wall.y1) / dl];
      if (f.side === 'exterior') {
        normal = outsideVector(wall, centre);
      } else if (f.side === 'start' || f.side === 'end') {
        // A segment END face, named by which end of the authored segment.
        endAt = f.side === 'start' ? [wall.x1, wall.y1] : [wall.x2, wall.y2];
        normal = f.side === 'start' ? [-dir[0], -dir[1]] : dir;
      } else if (f.side != null) {
        const cv = compassVector(f.side);
        if (!cv) {
          warn(where + ': side "' + f.side + '" is not a compass side, "exterior", "start" or "end" -- skipped');
          return;
        }
        const ends = horizontal ? ['east', 'west'] : ['north', 'south'];
        if (axisAligned && ends.indexOf(f.side) !== -1) {
          // A compass side along the wall names that END face -- e.g. the
          // north face of a pillar authored as a short north-south segment.
          const startIsIt = (dir[0] * cv[0] + dir[1] * cv[1]) < 0;
          endAt = startIsIt ? [wall.x1, wall.y1] : [wall.x2, wall.y2];
          normal = cv;
        } else {
          normal = faceNormalToward(wall, cv);
        }
      } else {
        const room = rooms[f.room];
        if (!room) {
          warn(where + ': room "' + f.room + '" does not exist -- skipped');
          return;
        }
        const lo = horizontal ? Math.min(wall.x1, wall.x2) : Math.min(wall.y1, wall.y2);
        const hi = horizontal ? Math.max(wall.x1, wall.x2) : Math.max(wall.y1, wall.y2);
        const a = along ? Math.max(along[0], lo) : lo, b = along ? Math.min(along[1], hi) : hi;
        const side = wallSide('finish', { id: wall.id + '/' + i, wall: wall.id, centre: (a + b) / 2 },
          wall, room, warn, Math.max(0, b - a));
        if (!side) return;
        normal = side.axis === 'x' ? [0, side.inDir] : [side.inDir, 0];
      }
      if (!normal) return;
      if (endAt && along) {
        warn(where + ': `along` does not apply to an end face -- ignored');
        along = null;
      }
      // A wallpapered face under a finish: the finish is drawn over it, which
      // is almost certainly not what the author meant. Compass sides only --
      // that is how faceTexture names its face.
      const ftv = wall.faceTexture && compassVector(wall.faceTexture.side);
      if (!endAt && ftv && Math.abs(ftv[0] - normal[0]) < 1e-6 && Math.abs(ftv[1] - normal[1]) < 1e-6) {
        warn(where + ': this face also carries the wall’s faceTexture (wallpaper); the ' + f.finish +
          ' is drawn over it');
      }
      out.push({
        finish: f.finish, normal: normal, face: endAt ? 'end' : 'long', at: endAt,
        from: from, to: to, along: along,
        // Wrap the finish round the reveals of openings and the wall's own
        // ends: on by default for an exterior skin (brick returns into the
        // window reveals, as on the spec pages), off otherwise.
        reveals: typeof f.reveals === 'boolean' ? f.reveals : (f.side === 'exterior')
      });
    });
    return out;
  }

  /**
   * Compile a geometry document into the renderer's internal shapes.
   *
   * @param {Object} geo      a parsed geometry.json
   * @param {string} baseUrl  URL of the profile directory, used to resolve
   *                          texture paths. Trailing slash optional.
   * @returns {Object} the compiled house
   */
  function compile(geo, baseUrl) {
    const warnings = [];
    const warn = msg => { warnings.push(msg); console.warn('[HouseLoader] ' + msg); };

    if (!geo || geo.kind !== 'geometry') {
      throw new Error('not a geometry profile (expected kind: "geometry")');
    }
    const major = parseInt(String(geo.schemaVersion || '0.0').split('.')[0], 10);
    if (major !== SUPPORTED_SCHEMA_MAJOR) {
      throw new Error(
        'profile "' + geo.id + '" is schemaVersion ' + geo.schemaVersion + '; this engine understands ' +
        'major version ' + SUPPORTED_SCHEMA_MAJOR + '. A newer major may redefine a field we already ' +
        'read, so it is refused rather than rendered incorrectly.'
      );
    }

    const dir = baseUrl ? (baseUrl.charAt(baseUrl.length - 1) === '/' ? baseUrl : baseUrl + '/') : '';
    const defaults = Object.assign({}, DEFAULTS, geo.defaults || {});
    const materials = Object.assign({}, MATERIAL_DEFAULTS, geo.materials || {});

    // ---- Coordinate transform -------------------------------------------
    // PER HOUSE, never a constant: every plan export has its own arbitrary
    // origin (wherever the author started drawing), so a hardcoded offset makes
    // every other house render off-centre. worldX = (planX - originX) * scale.
    const ct = geo.coordinateTransform;
    const OX = ct.originX, OY = ct.originY, S = ct.scale;
    const tx = x => (x - OX) * S;
    const tz = y => (y - OY) * S;

    // ---- Walls ------------------------------------------------------------
    const rawWalls = (geo.walls.segments || []).map(w => ({
      id: w.id,
      x1: w.start[0], y1: w.start[1],
      x2: w.end[0], y2: w.end[1],
      outer: w.exterior ? 1 : 0,
      thickness: w.thickness != null ? w.thickness : defaults.wallThickness,
      height: w.height,
      faceTexture: w.faceTexture,
      // Raw here; resolved to face normals by compileWallFinishes once the
      // rooms and the footprint exist (see after the footprint below).
      finishes: Array.isArray(w.finishes) ? w.finishes : []
    }));
    const wallsExt = extendWallsForCorners(rawWalls, defaults.wallThickness);
    const wallsById = {};
    rawWalls.forEach(w => { wallsById[w.id] = w; });

    // Per-wall face textures, keyed by wall id, resolved to profile-relative
    // URLs. The predecessor hardcoded two PNG paths pointing into a deploy
    // directory (and kept a duplicate copy of each image so a deploy hook that
    // copied only one tree would ship them). A profile's textures live beside
    // the profile, so that duplication is retired.
    const wallFaceTextures = {};
    wallsExt.forEach(w => {
      const ft = w.faceTexture;
      if (!ft || !ft.texture || !ft.texture.path) return;
      const path = ft.texture.path;
      if (!TEXTURE_PATH_RE.test(path) || !resolvesInsideProfile(dir, path)) {
        warn('wall ' + w.id + ' faceTexture path "' + path + '" is not a safe profile-relative image path -- ignored');
        return;
      }
      wallFaceTextures[w.id] = {
        side: ft.side,
        url: dir + path,
        fit: (ft.texture.fit || 'stretch'),
        repeatMetres: ft.texture.repeatMetres || 1,
        clipToRoom: ft.clipToRoom || null
      };
    });

    // ---- Rooms ------------------------------------------------------------
    // The bbox is DERIVED from the polygon (see polygonBounds). `area` is the
    // shoelace area unless the profile declares an authoritative figure.
    const rooms = {};
    const roomOrder = [];
    (geo.rooms || []).forEach(r => {
      const poly = r.polygon;
      const b = polygonBounds(poly);
      const computedSqm = polygonArea(poly) * S * S;
      if (r.areaSqm != null && r.areaSqm > 0 && Math.abs(computedSqm - r.areaSqm) / r.areaSqm > 0.02) {
        warn('room "' + r.id + '" declares areaSqm ' + r.areaSqm + ' but its polygon measures ' +
          computedSqm.toFixed(2) + ' m2 -- displaying the declared figure; one of them is stale');
      }
      const areaSqm = r.areaSqm != null ? r.areaSqm : computedSqm;

      let rug = null;
      if (r.rug) {
        const inset = r.rug.inset != null ? r.rug.inset : 30;
        rug = {
          poly: r.rug.polygon || [
            [b.x1 + inset, b.y1 + inset], [b.x2 - inset, b.y1 + inset],
            [b.x2 - inset, b.y2 - inset], [b.x1 + inset, b.y2 - inset]
          ],
          color: hexToInt(r.rug.color, 0xffffff),
          textureUrl: null,
          repeatMetres: 1.2
        };
        const rt = r.rug.texture;
        if (rt && rt.path) {
          if (TEXTURE_PATH_RE.test(rt.path) && resolvesInsideProfile(dir, rt.path)) {
            rug.textureUrl = dir + rt.path;
            rug.repeatMetres = rt.repeatMetres || 1.2;
          } else {
            warn('room "' + r.id + '" rug texture path "' + rt.path + '" is not a safe profile-relative image path -- ignored');
          }
        }
      }

      // Optional manual footstep confinement (schema `footstepZone`). Authored
      // relative to this room's OWN bbox min corner so it survives the polygon
      // being nudged and so an author never has to re-derive the house's global
      // origin -- resolved here, once, to absolute plan coordinates so the scene
      // never has to know the field was relative at all. Anything malformed
      // (missing corner, unrecognised relativeTo) is dropped with a warning and
      // the room falls back to automatic placement, same as when the field is
      // absent entirely -- consistent with every other 'warn and carry on' guard
      // in this loader.
      let footstepZone = null;
      const fz = r.footstepZone;
      if (fz) {
        const validCorner = p => Array.isArray(p) && p.length === 2 &&
          typeof p[0] === 'number' && typeof p[1] === 'number';
        if (fz.relativeTo !== 'room') {
          warn('room "' + r.id + '" footstepZone has relativeTo "' + fz.relativeTo + '", which this engine does not understand -- falling back to automatic placement');
        } else if (!validCorner(fz.from) || !validCorner(fz.to)) {
          warn('room "' + r.id + '" footstepZone is missing a valid from/to corner -- falling back to automatic placement');
        } else {
          const ax = b.x1 + fz.from[0], ay = b.y1 + fz.from[1];
          const bx = b.x1 + fz.to[0], by = b.y1 + fz.to[1];
          footstepZone = {
            x1: Math.min(ax, bx), y1: Math.min(ay, by),
            x2: Math.max(ax, bx), y2: Math.max(ay, by)
          };
        }
      }

      // Optional authored footstep route (schema `footstepPath`): an ordered
      // list of waypoints, relative to the room's bbox min corner exactly like
      // footstepZone, resolved here to absolute plan coordinates. Every
      // waypoint must lie on this room's floor -- a waypoint outside the
      // polygon means the path was authored against the wrong room or before
      // the polygon moved, and walking it would draw prints in the next room.
      // Anything malformed warns and falls back (to footstepZone if present,
      // else automatic placement). When valid it takes precedence over
      // footstepZone.
      let footstepPath = null;
      const fp = r.footstepPath;
      if (fp) {
        const validPt = p => Array.isArray(p) && p.length === 2 &&
          typeof p[0] === 'number' && typeof p[1] === 'number' &&
          isFinite(p[0]) && isFinite(p[1]);
        if (fp.relativeTo !== 'room') {
          warn('room "' + r.id + '" footstepPath has relativeTo "' + fp.relativeTo + '", which this engine does not understand -- ignored');
        } else if (!Array.isArray(fp.points) || fp.points.length < 2 || !fp.points.every(validPt)) {
          warn('room "' + r.id + '" footstepPath needs at least two [x, y] waypoints -- ignored');
        } else {
          const abs = fp.points.map(p => [b.x1 + p[0], b.y1 + p[1]]);
          const bad = poly ? abs.findIndex(p => !insidePoly(poly, p[0], p[1])) : -1;
          if (bad !== -1) {
            warn('room "' + r.id + '" footstepPath waypoint ' + bad + ' ' + JSON.stringify(fp.points[bad]) +
              ' lies outside the room polygon -- ignored');
          } else {
            footstepPath = { points: abs, smooth: fp.smooth !== false };
          }
        }
      }

      rooms[r.id] = {
        id: r.id,
        name: r.label,
        x1: b.x1, y1: b.y1, x2: b.x2, y2: b.y2,   // DERIVED bbox, not authored
        poly: poly,
        area: areaSqm.toFixed(2) + ' m²',
        areaSqm: areaSqm,
        floor: hexToInt(r.floorColor, 0x9E8B72),
        floorMaterial: r.floorMaterial || 'tile',
        rug: rug,
        // Absolute plan-coordinate rectangle, or null for automatic placement.
        // See src/home3d-scene.js's footstep section for how this overrides the
        // polygon-derived walk.
        footstepZone: footstepZone,
        // {points: absolute plan-coordinate waypoints, smooth} or null. Takes
        // precedence over footstepZone in the scene.
        footstepPath: footstepPath
      };
      roomOrder.push(r.id);
    });

    // ---- Doors ------------------------------------------------------------
    const doors = [];
    (geo.doors || []).forEach(d => {
      if (!rooms[d.room]) {
        warn('door "' + d.id + '" belongs to room "' + d.room + '", which is not in this profile -- skipped');
        return;
      }
      const compiled = compileDoor(d, wallsById, defaults, warn);
      if (compiled) doors.push(compiled);
    });

    // ---- Windows and curtains ---------------------------------------------
    // Both optional; a profile without them compiles to empty lists, and the
    // renderer draws exactly what it drew before they existed.
    const windows = [];
    (Array.isArray(geo.windows) ? geo.windows : []).forEach(w => {
      const compiled = compileWindow(w, wallsById, rooms, warn);
      if (compiled) windows.push(compiled);
    });
    const curtains = [];
    (Array.isArray(geo.curtains) ? geo.curtains : []).forEach(c => {
      const compiled = compileCurtain(c, wallsById, rooms, defaults, warn);
      if (compiled) curtains.push(compiled);
    });
    stackCurtains(curtains);
    markUnderCornice(curtains);

    // ---- Furniture (schemaVersion 1.2) --------------------------------------
    // Optional; an older engine ignores the key, and a profile without it
    // compiles to an empty list. Duplicate ids keep the first.
    const furniture = [];
    const furnitureIds = new Set();
    (Array.isArray(geo.furniture) ? geo.furniture : []).forEach(f => {
      const compiled = compileFurniture(f, wallsById, rooms, warn);
      if (!compiled) return;
      if (furnitureIds.has(compiled.id)) {
        warn('furniture "' + compiled.id + '" is a duplicate id -- keeping the first');
        return;
      }
      furnitureIds.add(compiled.id);
      // The profile directory, for a type that loads a file from the profile
      // (src/furniture/model.js). Builders get it as build()'s opts.assetBase;
      // the type itself guards the path it resolves under it.
      compiled.assetBase = dir;
      furniture.push(compiled);
    });

    // ---- Lights -----------------------------------------------------------
    // THE BIG ONE. The predecessor placed fixtures inside the renderer with a
    // chain of `if (id === "living_room")` branches holding literal coordinates
    // and a per-room offset table. Here every fixture position is data: a group
    // is a channel with a list of explicit positions, or a `count` to auto-place
    // over the room's bounding box when the author has not said where they go.
    const lights = {};
    (geo.lights || []).forEach(entry => {
      const rid = entry.room;
      if (!rooms[rid]) {
        warn('lights are declared for room "' + rid + '", which is not in this profile -- skipped');
        return;
      }
      const groups = {};
      (entry.fixtures || []).forEach(f => {
        if (groups[f.channel]) {
          warn('room "' + rid + '" declares channel "' + f.channel + '" twice -- keeping the first');
          return;
        }
        const explicit = !!(f.positions && f.positions.length);
        const positions = explicit
          ? f.positions.map(p => ({ at: p.at, heightCm: p.heightCm, label: p.label, size: p.size }))
          : autoPlace(rooms[rid], f.count || 1);
        groups[f.channel] = {
          channel: f.channel,
          name: f.label || (rooms[rid].name + ' ' + f.channel),
          fixtureType: f.fixtureType || 'downlight',
          colorTemperatureK: f.colorTemperatureK || 2700,
          positions: positions,
          autoPlaced: !explicit
        };
      });
      lights[rid] = groups;
    });
    // A room with no `lights` entry has no lights; give it an empty group set so
    // every consumer can index by room id without a null check.
    roomOrder.forEach(rid => { if (!lights[rid]) lights[rid] = {}; });

    // ---- Slabs: the ONE floor and the ONE ceiling -------------------------
    // The house has exactly one floor and exactly one ceiling. Each is emitted
    // here as a LIST OF PIECES because THREE.Shape describes a single ring:
    // an authored outline is a one-piece list, a derived one is many pieces
    // extruded together into one geometry. The renderer does not branch.
    //
    // AUTHORED (profile has `slabs`): the two rings verbatim. They are
    // deliberately different outlines -- the floor traces the INNER faces of
    // the exterior walls (the walls stand on it and run down through it), the
    // ceiling traces their OUTER faces so it caps over the shell. Nothing here
    // can derive that asymmetry, which is exactly why a house that has measured
    // its shell states it.
    //
    // DERIVED (no `slabs`): rooms UNION every wall footprint. The rooms alone
    // are NOT enough and this is the bug that made the field necessary -- rooms
    // stop at the wall faces, so between any two rooms there is a strip of
    // exactly one wall thickness that no room polygon covers, and laying only
    // the rooms leaves a visible slot in the floor under every internal wall.
    // Adding each wall's own footprint rectangle (centreline expanded by half
    // its thickness) fills precisely those strips. Interior walls are included
    // for the floor as well as the ceiling: an interior wall separates two
    // rooms, so the gap under it is the one people actually see.
    //
    // The derived floor therefore reaches the OUTER face of the shell rather
    // than the inner one -- fractionally larger than a hand-trace would be, and
    // invisible from any angle because the walls cover it. Gap-free is worth
    // more than a hidden few centimetres.
    const wallFootprint = w => {
      const dx = w.x2 - w.x1, dy = w.y2 - w.y1;
      const len = Math.hypot(dx, dy) || 1;
      // Unit normal to the wall, scaled to half its thickness.
      const nx = (-dy / len) * (w.thickness / 2);
      const ny = (dx / len) * (w.thickness / 2);
      return [
        [w.x1 + nx, w.y1 + ny], [w.x2 + nx, w.y2 + ny],
        [w.x2 - nx, w.y2 - ny], [w.x1 - nx, w.y1 - ny]
      ];
    };
    const isRing = poly => Array.isArray(poly) && poly.length >= 3 &&
      poly.every(pt => Array.isArray(pt) && pt.length >= 2 &&
        typeof pt[0] === 'number' && typeof pt[1] === 'number');

    const slabsIn = geo.slabs || {};
    const derivedPieces = roomOrder.map(rid => rooms[rid].poly)
      .concat(wallsExt.map(wallFootprint));
    let floorPieces, ceilingPieces;
    if (slabsIn.floor != null) {
      if (isRing(slabsIn.floor)) {
        floorPieces = [slabsIn.floor.map(pt => [pt[0], pt[1]])];
      } else {
        warn('slabs.floor is not a ring of at least 3 [x, y] points -- deriving the floor from rooms + walls instead');
      }
    }
    if (slabsIn.ceiling != null) {
      if (isRing(slabsIn.ceiling)) {
        ceilingPieces = [slabsIn.ceiling.map(pt => [pt[0], pt[1]])];
      } else {
        warn('slabs.ceiling is not a ring of at least 3 [x, y] points -- deriving the ceiling from rooms + walls instead');
      }
    }
    const slabs = {
      floor: floorPieces || derivedPieces,
      ceiling: ceilingPieces || derivedPieces,
      floorAuthored: !!floorPieces,
      ceilingAuthored: !!ceilingPieces,
      // Centimetres in the profile, metres for the renderer -- like every other
      // length the engine consumes.
      thickness: (slabsIn.thickness != null && slabsIn.thickness > 0 ? slabsIn.thickness : 15) / 100
    };

    // ---- Site / sun rig ----------------------------------------------------
    // The predecessor hardcoded LAT = 51.49 and assumed solar noon at 12:00 UTC,
    // so a house anywhere else got its sun at the wrong time of day. Latitude
    // and longitude now come from the profile; longitude offsets solar noon
    // (4 minutes per degree east). Omitting `site` gives a fixed neutral
    // daylight rather than somebody else's sky.
    const site = geo.site
      ? {
          latitude: geo.site.latitude,
          longitude: geo.site.longitude != null ? geo.site.longitude : 0,
          locationLabel: geo.site.locationLabel || '',
          northOffsetDegrees: geo.site.northOffsetDegrees || 0,
          present: true
        }
      : { latitude: 0, longitude: 0, locationLabel: '', northOffsetDegrees: 0, present: false };

    // ---- Footprint --------------------------------------------------------
    // Derived from the CORNER-EXTENDED walls, as it always was: the overlays
    // draw their grid over what is actually rendered.
    const fpXs = [];
    const fpYs = [];
    wallsExt.forEach(w => { fpXs.push(w.x1, w.x2); fpYs.push(w.y1, w.y2); });
    const footprint = {
      minX: Math.min.apply(null, fpXs), maxX: Math.max.apply(null, fpXs),
      minY: Math.min.apply(null, fpYs), maxY: Math.max.apply(null, fpYs)
    };

    // ---- Wall finishes (schemaVersion 1.3) --------------------------------
    // Resolved here, after the rooms (a `room` finish probes its room) and the
    // footprint (an `exterior` one faces away from its centre) exist. The
    // corner-extended copy shares the resolved list: extension lengthens a
    // wall, it never turns it round.
    const fpCentre = [(footprint.minX + footprint.maxX) / 2, (footprint.minY + footprint.maxY) / 2];
    rawWalls.forEach(w => { w.finishes = compileWallFinishes(w, rooms, fpCentre, warn); });
    wallsExt.forEach(w => { w.finishes = wallsById[w.id].finishes; });
    // The point every default camera looks at, and where the ground plane and
    // the cloud field are centred. The footprint's geometric middle is the
    // right default, but it is not always the point a house is best FRAMED
    // from: a plan with a long thin projection (a hallway arm, an outhouse)
    // pulls the mean away from the part someone actually wants centred. So a
    // profile may state its own, and most should not bother.
    // ---- Extra overlay scripts (optional) --------------------------------
    // A profile may ship its own overlay script(s) next to its geometry. Each
    // entry is a profile-relative .js path, resolved here to a URL the page can
    // add a <script> tag for. Anything failing the path guard is dropped with a
    // warning rather than throwing: one bad entry must not cost the house its
    // render, which is the same 'warn and carry on' rule texture paths use.
    const extraOverlays = (Array.isArray(geo.extraOverlays) ? geo.extraOverlays : [])
      .filter(function (pth) {
        if (typeof pth !== 'string') return false;
        if (!OVERLAY_PATH_RE.test(pth) || !resolvesInsideProfile(dir, pth)) {
          warn('extraOverlays entry "' + pth + '" is not a safe profile-relative .js path -- ignored');
          return false;
        }
        return true;
      })
      .map(function (pth) { return { path: pth, url: dir + pth }; });

    // Spec pages the profile ships next to its geometry. Same shape and same
    // 'warn and carry on' rule as extraOverlays: an entry that fails the path
    // guard, or that omits either field, is dropped rather than throwing.
    // A spec page documents one particular house's fittings, so a house that
    // owns such a document carries it wherever its profile loads -- and, as
    // with overlays, this is what keeps house-specific documents out of a
    // public repository.
    const specPages = (Array.isArray(geo.specPages) ? geo.specPages : [])
      .filter(function (sp) {
        if (!sp || typeof sp !== 'object') return false;
        if (typeof sp.name !== 'string' || sp.name === '') {
          warn('specPages entry is missing a name -- ignored');
          return false;
        }
        if (typeof sp.path !== 'string' || !SPEC_PATH_RE.test(sp.path) || !resolvesInsideProfile(dir, sp.path)) {
          warn('specPages entry "' + sp.name + '" is not a safe profile-relative .html path -- ignored');
          return false;
        }
        return true;
      })
      .map(function (sp) {
        return {
          name: sp.name,
          path: sp.path,
          url: dir + sp.path,
          // Optional presentational grouping (Settings > Specs sections). Passed
          // through as-is, including when absent or unrecognised -- the page
          // decides how to bucket an unknown group name, not the loader.
          group: typeof sp.group === 'string' ? sp.group : undefined
        };
      });

    const centre = Array.isArray(geo.viewCentre) && geo.viewCentre.length === 2
      ? [geo.viewCentre[0], geo.viewCentre[1]]
      : [(footprint.minX + footprint.maxX) / 2, (footprint.minY + footprint.maxY) / 2];

    return {
      id: geo.id,
      name: geo.name,
      description: geo.description || '',
      schemaVersion: geo.schemaVersion,
      dir: dir,
      units: geo.units || 'cm',
      transform: { tx: tx, tz: tz, S: S, OX: OX, OY: OY },
      defaults: defaults,
      materials: {
        wallColor: hexToInt(materials.wallColor, 0xece9e1),
        ceilingColor: hexToInt(materials.ceilingColor, 0xf2efe9),
        doorSlabColor: hexToInt(materials.doorSlabColor, 0xece4d4),
        exteriorColor: hexToInt(materials.exteriorColor, 0xd9d4c8)
      },
      wallHeight: defaults.wallHeight / 100,          // metres
      ceilingHeight: (defaults.ceilingHeight != null ? defaults.ceilingHeight : defaults.wallHeight) / 100,
      wallThickness: defaults.wallThickness,          // cm
      walls: rawWalls,
      wallsExt: wallsExt,
      wallsById: wallsById,
      wallFaceTextures: wallFaceTextures,
      highestWallIdEverAssigned: geo.walls.highestIdEverAssigned,
      // The ONE floor and the ONE ceiling, each as a list of plan-space rings
      // (see the slab section above). Authored from `slabs` when the profile
      // states them, otherwise derived from rooms + wall footprints. thickness
      // is in METRES here; the profile authors centimetres.
      slabs: slabs,
      rooms: rooms,
      roomOrder: roomOrder,
      doors: doors,
      windows: windows,
      curtains: curtains,
      // Placed furniture (see compileFurniture). Empty when the profile has none.
      furniture: furniture,
      lights: lights,
      site: site,
      footprint: footprint,
      centre: centre,
      cameraPresets: geo.cameraPresets || {},
      // Opt-in bespoke decoration this house asks for (e.g. 'acoustic-panels').
      // Decor is furniture keyed to specific wall ids, not building fabric, so
      // it is neither derivable from the geometry nor wanted by every house —
      // the profile has to ask for it by name. Unknown names are harmless: the
      // engine only looks for the ones it implements.
      decor: Array.isArray(geo.decor) ? geo.decor.filter(d => typeof d === 'string') : [],
      // Optional extra overlay scripts this profile ships alongside itself,
      // resolved to profile-relative URLs (see OVERLAY_PATH_RE). Absent for
      // most houses -- the demo included -- and an empty list when absent, so
      // the page's loader is a no-op by default.
      //
      // WHY A PROFILE FIELD and not a page setting: an overlay of this kind
      // draws something true about ONE house, so a house that owns the drawing
      // owns it wherever its profile loads -- the same argument `decor` makes
      // for panelling. It is deliberately NOT part of `decor`: decor names
      // geometry this engine builds itself from a fixed enum, whereas this
      // points at a script the engine does not contain.
      extraOverlays: extraOverlays,
      // Profile-supplied spec pages, appended to the engine's built-in list in
      // the Settings panel. Same privacy argument as extraOverlays: a spec that
      // documents one real house's bathroom belongs to that house's profile,
      // not to this repository.
      specPages: specPages,
      warnings: warnings
    };
  }

  /** Guard a house id before it becomes a URL path segment. */
  function isValidHouseId(id) {
    return typeof id === 'string' && id.length <= 64 && HOUSE_ID_RE.test(id);
  }

  /**
   * Fetch and compile houses/<id>/geometry.json.
   *
   * @param {string} id       house profile id
   * @param {Object} [opts]
   * @param {string} [opts.basePath='houses/']  where profiles live
   * @returns {Promise<Object>} the compiled house
   */
  function load(id, opts) {
    const basePath = (opts && opts.basePath) || 'houses/';
    if (!isValidHouseId(id)) {
      return Promise.reject(new Error('house id ' + JSON.stringify(id) + ' is not a valid profile id'));
    }
    const dir = basePath + id + '/';
    const url = dir + 'geometry.json';
    return fetch(url)
      .catch(err => {
        throw new Error('could not fetch ' + url + ': ' + (err && err.message ? err.message : err));
      })
      .then(res => {
        if (!res.ok) {
          throw new Error('could not fetch ' + url + ': HTTP ' + res.status + ' ' + res.statusText);
        }
        return res.json().catch(err => {
          throw new Error(url + ' is not valid JSON: ' + (err && err.message ? err.message : err));
        });
      })
      .then(doc => compile(doc, dir));
  }

  /**
   * Load `id`. NEVER substitutes a different house for it.
   *
   * ## This function used to fall back, and deliberately no longer does
   *
   * It previously caught any failure loading `id` and rendered the demo house
   * instead, so that a stranger who mistyped HOME3D_HOUSE got a working app
   * and a console message rather than a black screen. That trade-off was
   * reversed on 2026-09-12 because the cost side of it turned out
   * to be much worse than the benefit:
   *
   *   - The profile is bind-mounted read-only into the container at
   *     houses/<id>/. nginx does not run as the file owner, so a permissions
   *     change, a NAS reboot or a mount that simply does not come back makes
   *     every houses/<id> request 404 -- WHILE THE CONTAINER STILL REPORTS
   *     HEALTHY. Nothing alerts.
   *   - The substitute then renders on a wall tablet or a phone as a fictional
   *     flat with no visible sign it is not the real home, and the Home
   *     Assistant integration wires REAL entities to those FAKE rooms.
   *   - A console line does not help: nobody reads a console on a wall tablet.
   *
   * So a wrong house that looks plausible is a worse outcome than a visible
   * error, and this function now produces the error. The contract is:
   *
   *   - `id` loads              -> resolves with the house. Unchanged.
   *   - `id` fails, id !== fallback -> REJECTS. No substitution, ever. The
   *     caller is responsible for putting a readable error ON SCREEN naming
   *     the house; see the boot sequence in index.html, which turns this
   *     rejection into the error card rather than a blank canvas.
   *   - `id` fails, id === fallback -> rejects, exactly as it always did.
   *
   * `fallbackId` is therefore no longer a substitute. It names the one id that
   * is allowed to be a default rather than an explicit choice, and it survives
   * only so the two call sites keep their existing shape; the parameter is
   * otherwise inert. An UNSET HOME3D_HOUSE still defaults to 'demo' upstream
   * in deploy/generate-config.sh -- that default is fine and is untouched.
   * What is refused is SUBSTITUTING for a house somebody explicitly named.
   *
   * The blank-canvas failure the old fallback existed to prevent is still
   * prevented, just one layer up: the caller must render an explicit error
   * state. Rejecting here and drawing nothing there would trade one silent
   * failure for another.
   */
  function loadWithFallback(id, fallbackId) {
    const fallback = fallbackId || 'demo';
    return load(id).catch(err => {
      // Re-thrown either way. The message differs only so the console says
      // which of the two cases happened; neither one substitutes a house.
      if (id === fallback) throw err;
      const e = new Error(
        'Could not load house "' + id + '": ' + err.message + '. ' +
        'Refusing to render a different house in its place -- "' + id + '" was ' +
        'named explicitly, so showing the "' + fallback + '" house instead would ' +
        'look like a working app while displaying the wrong home. Check that ' +
        'houses/' + id + '/geometry.json exists and is readable by the server ' +
        '(the container bind-mount needs a+rX), or set HOME3D_HOUSE / ?house= ' +
        'to a profile that does.'
      );
      // Carried so a caller can name the house in an on-screen error without
      // parsing the message. `houseId` is the id that failed; `cause` keeps the
      // underlying fetch/compile error for the console.
      e.houseId = id;
      e.cause = err;
      console.error('[HouseLoader] ' + e.message);
      throw e;
    });
  }

  return {
    load: load,
    loadWithFallback: loadWithFallback,
    compile: compile,
    isValidHouseId: isValidHouseId,
    polygonBounds: polygonBounds,
    polygonArea: polygonArea,
    extendWallsForCorners: extendWallsForCorners,
    stackCurtains: stackCurtains,
    markUnderCornice: markUnderCornice,
    wallSide: wallSide,
    probeWallSide: probeWallSide,
    faceGap: faceGap,
    WALL_SIDE_CONTACT_CM: WALL_SIDE_CONTACT_CM,
    compileFurniture: compileFurniture,
    rotationIntoRoom: rotationIntoRoom,
    WALL_SIDE_PROBE_CM: WALL_SIDE_PROBE_CM,
    SUPPORTED_SCHEMA_MAJOR: SUPPORTED_SCHEMA_MAJOR
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = HouseLoader;
