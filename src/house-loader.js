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

const HouseLoader = (() => {
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
    doorRestOpenFraction: 0.2
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
  // the engine at an arbitrary host.
  const TEXTURE_PATH_RE = /^(?!\/)(?!.*\.\.)(?!https?:)[^\\]+\.(png|jpg|jpeg|webp)$/i;

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
        faceTexture: w.faceTexture
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
      color: door.color
    };
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
      faceTexture: w.faceTexture
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
      if (!TEXTURE_PATH_RE.test(path)) {
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
          if (TEXTURE_PATH_RE.test(rt.path)) {
            rug.textureUrl = dir + rt.path;
            rug.repeatMetres = rt.repeatMetres || 1.2;
          } else {
            warn('room "' + r.id + '" rug texture path "' + rt.path + '" is not a safe profile-relative image path -- ignored');
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
        rug: rug
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
    // The point every default camera looks at, and where the ground plane and
    // the cloud field are centred. The footprint's geometric middle is the
    // right default, but it is not always the point a house is best FRAMED
    // from: a plan with a long thin projection (a hallway arm, an outhouse)
    // pulls the mean away from the part someone actually wants centred. So a
    // profile may state its own, and most should not bother.
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
      rooms: rooms,
      roomOrder: roomOrder,
      doors: doors,
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
   * Load `id`, falling back to `fallbackId` when it cannot be loaded.
   *
   * A missing or broken profile must never be a blank canvas or an uncaught
   * exception: the app says loudly what went wrong and renders the demo house,
   * so a stranger who mistypes HOME3D_HOUSE sees a working app and a clear
   * console message rather than a black screen.
   */
  function loadWithFallback(id, fallbackId) {
    const fallback = fallbackId || 'demo';
    return load(id).catch(err => {
      if (id === fallback) throw err;
      console.error(
        '[HouseLoader] Could not load house "' + id + '": ' + err.message + '\n' +
        '[HouseLoader] Falling back to the "' + fallback + '" house. Check that houses/' + id +
        '/geometry.json exists and is being served, or set HOME3D_HOUSE / ?house= to a profile that does.'
      );
      return load(fallback).then(house => {
        house.fallbackFrom = id;
        return house;
      });
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
    SUPPORTED_SCHEMA_MAJOR: SUPPORTED_SCHEMA_MAJOR
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = HouseLoader;
