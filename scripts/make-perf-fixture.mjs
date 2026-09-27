#!/usr/bin/env node
/**
 * make-perf-fixture.mjs - write the synthetic FULL-HOUSE perf fixture.
 *
 *   node scripts/make-perf-fixture.mjs            -> houses/perf-full/
 *   node scripts/make-perf-fixture.mjs <outDir>
 *
 * The furniture perf budget (draws, programs, lights, the longest main-thread
 * task on attach) is stated against "a full house": ~90 items across 10 rooms,
 * every registered type that has a builder, fade auto and never mixed, some
 * items `minor`. The demo house has 7 rooms and 9 items, so it cannot answer
 * that question. This script writes an INVENTED ten-room house that can.
 *
 * Nothing here is measured from a real home. The layout is a plain 5 x 2 grid
 * of 4 m x 3.5 m rooms; the light fixture MIX (19 downlights, 3 bulbs, 2 spot
 * clusters, 9 accent strips, 3 lit cornices of which one is wide) is chosen to
 * give the same light COUNTS a typical furnished flat has, because light count
 * is what the tier budget is about. A type without a builder yet (sofa, at
 * the time of writing) is stood in by `box` at a plausible size.
 *
 * The output directory is under houses/, which .gitignore excludes (only
 * houses/demo is public), so a generated fixture is never committed. Load it
 * with `?house=perf-full`.
 *
 * Also importable: `makePerfFixture()` returns { geometry, rooms } without
 * touching the disk (scripts/test-furniture-render.mjs uses it).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const COLS = 5, ROWS = 2, RW = 400, RD = 350, SHELL = 20, PART = 10;

/** Wall ids: shell 1-4, the long east-west partition 9, north-row verticals 10-13, south-row 14-17. */
function wallsFor() {
  const W = COLS * RW, D = ROWS * RD;
  const segs = [
    { id: 1, start: [0, 0], end: [W, 0], thickness: SHELL, exterior: true },
    { id: 2, start: [W, 0], end: [W, D], thickness: SHELL, exterior: true },
    { id: 3, start: [W, D], end: [0, D], thickness: SHELL, exterior: true },
    { id: 4, start: [0, D], end: [0, 0], thickness: SHELL, exterior: true },
    { id: 9, start: [0, RD], end: [W, RD], thickness: PART }
  ];
  for (let c = 1; c < COLS; c++) {
    segs.push({ id: 9 + c, start: [c * RW, 0], end: [c * RW, RD], thickness: PART });
    segs.push({ id: 13 + c, start: [c * RW, RD], end: [c * RW, D], thickness: PART });
  }
  return { highestIdEverAssigned: 17, segments: segs };
}

function roomRect(c, r) {
  const x0 = c * RW + (c === 0 ? SHELL / 2 : PART / 2);
  const x1 = (c + 1) * RW - (c === COLS - 1 ? SHELL / 2 : PART / 2);
  const y0 = r === 0 ? SHELL / 2 : RD + PART / 2;
  const y1 = r === 0 ? RD - PART / 2 : ROWS * RD - SHELL / 2;
  return { x0, x1, y0, y1 };
}

/** The wall on one side of a room: 'N' | 'S' | 'E' | 'W'. */
function sideWall(c, r, side) {
  if (side === 'N') return r === 0 ? 1 : 9;
  if (side === 'S') return r === 0 ? 9 : 3;
  if (side === 'W') return c === 0 ? 4 : (r === 0 ? 9 + c : 13 + c);
  return c === COLS - 1 ? 2 : (r === 0 ? 10 + c : 14 + c);
}

// Ten rooms, north row then south row, west to east.
const ROOM_DEFS = [
  { id: 'living', label: 'Living' },
  { id: 'kitchen', label: 'Kitchen' },
  { id: 'dining', label: 'Dining' },
  { id: 'office', label: 'Office' },
  { id: 'bedroom', label: 'Bedroom' },
  { id: 'hall', label: 'Hall' },
  { id: 'bathroom', label: 'Bathroom' },
  { id: 'guest', label: 'Guest room' },
  { id: 'utility', label: 'Utility' },
  { id: 'study', label: 'Study' }
];

// Light mix per room (see the header). `ds`: downlights; `bulb`; `spots`: a
// spot cluster of n; `strips`: accent strip count.
const LIGHT_MIX = {
  living: { ds: 6, strips: 2 },
  kitchen: { ds: 4, strips: 2 },
  dining: { bulb: 1, strips: 1 },
  office: { spots: 5, strips: 1 },
  bedroom: { spots: 4, strips: 2 },
  hall: { ds: 3 },
  bathroom: { ds: 3 },
  guest: { bulb: 1, strips: 1 },
  utility: { bulb: 1 },
  study: { ds: 3 }
};

// Furniture per room. Wall-anchored: [type, side, frac, extra]. Free:
// [type, 'at', [fx, fy], extra] with fx/fy fractions of the room rect.
// A cabinet that overrides width or height must carry matching `fronts`: the
// default fronts row is 100 cm wide and 228 cm tall, and a mismatch makes the
// builder throw and the item be skipped (the render test asserts none is).
const E = (color) => ({ finish: 'emissive', color });
const FURNITURE = {
  living: [
    ['box', 'at', [0.5, 0.62], { rotation: 180, params: { width: 220, depth: 90, height: 85, color: '#6b6f7a' }, label: 'sofa stand-in' }],
    ['box', 'at', [0.5, 0.4], { priority: 'minor', params: { width: 90, depth: 50, height: 40, color: '#8a6a4a' }, label: 'coffee table' }],
    ['tv', 'N', 0.5, { elevation: 90 }],
    ['box', 'N', 0.5, { params: { width: 180, depth: 40, height: 45, color: '#3b3b3b', finish: 'gloss' }, label: 'TV console' }],
    ['subwoofer', 'N', 0.2, {}],
    ['radiator', 'E', 0.8, { elevation: 12 }],
    ['speaker', 'N', 0.12, { elevation: 150 }],
    ['speaker', 'N', 0.88, { elevation: 150 }],
    ['slat-panel', 'W', 0.5, { params: { height: 240 } }],
    ['hex-panel-cluster', 'E', 0.5, { elevation: 60, params: { rows: [2, 3, 2], width: 94, height: 90 } }],
    ['plant', 'at', [0.9, 0.85], {}],
    ['tube-floor-lamp', 'at', [0.1, 0.85], {}],
    ['box', 'N', 0.72, { elevation: 150, params: { width: 60, depth: 3, height: 3, ...E('#ff5a1a') }, label: 'LED edge' }]
  ],
  kitchen: [
    ['kitchen-base-run', 'N', 0.45, { params: { width: 300 } }],
    ['kitchen-wall-run', 'N', 0.45, { elevation: 145, params: { width: 240 } }],
    ['fridge-freezer', 'E', 0.2, {}],
    ['kitchen-base-run', 'W', 0.55, { params: { width: 180 } }],
    ['box', 'at', [0.55, 0.6], { params: { width: 120, depth: 70, height: 92, color: '#d8d4cc' }, label: 'island' }],
    ['box', 'at', [0.45, 0.8], { priority: 'minor', params: { width: 35, depth: 35, height: 65, color: '#222222' }, label: 'stool' }],
    ['box', 'at', [0.65, 0.8], { priority: 'minor', params: { width: 35, depth: 35, height: 65, color: '#222222' }, label: 'stool' }],
    ['wall-clock', 'S', 0.3, { elevation: 180 }],
    ['radiator', 'S', 0.7, { elevation: 12, params: { width: 60 } }],
    ['shelf', 'S', 0.7, { elevation: 150 }],
    ['box', 'E', 0.7, { params: { width: 70, depth: 40, height: 180, color: '#cfe3ea', finish: 'glass' }, label: 'glass case' }]
  ],
  dining: [
    ['dining-table', 'at', [0.5, 0.5], { params: { width: 160, depth: 90 } }],
    ['dining-chair', 'at', [0.35, 0.3], {}],
    ['dining-chair', 'at', [0.65, 0.3], {}],
    ['dining-chair', 'at', [0.35, 0.7], { rotation: 180 }],
    ['dining-chair', 'at', [0.65, 0.7], { rotation: 180 }],
    ['cabinet', 'W', 0.5, { params: { width: 90, height: 190, depth: 40, shelfLights: true,
      fronts: [{ height: 182, cells: [{ kind: 'glass' }, { kind: 'glass' }] }] } }],
    ['mirror', 'E', 0.5, { elevation: 120, params: { shape: 'round' } }],
    ['photo-frame', 'S', 0.5, { elevation: 140 }],
    ['plant', 'at', [0.9, 0.12], { params: { kind: 'wall-planter' } , priority: 'minor' }]
  ],
  office: [
    ['standing-desk', 'N', 0.5, { params: { width: 160 } }],
    ['monitor', 'N', 0.4, { offset: 20, elevation: 76 }],
    ['monitor', 'N', 0.6, { offset: 20, elevation: 76, params: { curved: true } }],
    ['gaming-chair', 'at', [0.5, 0.45], { rotation: 180 }],
    ['pc-tower', 'N', 0.85, {}],
    ['shelf', 'E', 0.5, { elevation: 120 }],
    ['shelf', 'W', 0.5, { elevation: 160 }],
    ['wall-sign', 'S', 0.5, { elevation: 150 }],
    ['hex-panel-cluster', 'W', 0.3, { elevation: 60, params: { rows: [2, 3, 2], width: 94, height: 90 } }],
    ['box', 'N', 0.2, { elevation: 100, params: { width: 40, depth: 3, height: 3, ...E('#40c0ff') }, label: 'LED edge' }]
  ],
  bedroom: [
    ['bed', 'at', [0.5, 0.5], { rotation: 180 }],
    ['cabinet', 'E', 0.5, {}],
    ['cabinet', 'S', 0.25, { params: { width: 45, height: 50, depth: 40, shelfLights: true,
      fronts: [{ height: 42, cells: [{ kind: 'glass' }] }] } }],
    ['cabinet', 'S', 0.75, { params: { width: 45, height: 50, depth: 40, shelfLights: true,
      fronts: [{ height: 42, cells: [{ kind: 'glass' }] }] } }],
    ['wall-sconce', 'S', 0.15, { elevation: 110 }],
    ['wall-sconce', 'S', 0.85, { elevation: 110 }],
    ['tv', 'W', 0.5, { elevation: 100 }],
    ['mirror', 'W', 0.2, { elevation: 60, params: { shape: 'pebble' } }],
    ['plant', 'at', [0.9, 0.12], { priority: 'minor' }]
  ],
  hall: [
    ['coat-rack', 'W', 0.5, { elevation: 170 }],
    ['mirror', 'N', 0.3, { elevation: 100 }],
    ['shelf', 'N', 0.7, { elevation: 110 }],
    ['box', 'S', 0.3, { params: { width: 100, depth: 35, height: 90, color: '#efe9df' }, label: 'shoe cabinet' }],
    ['plant', 'at', [0.85, 0.3], {}],
    ['photo-frame', 'S', 0.7, { elevation: 150, priority: 'minor' }],
    ['photo-frame', 'N', 0.5, { elevation: 150, priority: 'minor' }],
    ['wall-sign', 'E', 0.5, { elevation: 160 }],
    ['box', 'S', 0.3, { elevation: 12, params: { width: 90, depth: 3, height: 2, ...E('#ffd9a0') }, label: 'plinth LED' }]
  ],
  bathroom: [
    ['mirror', 'N', 0.5, { elevation: 110 }],
    ['box', 'N', 0.5, { params: { width: 80, depth: 45, height: 85, color: '#ffffff', finish: 'gloss' }, label: 'vanity' }],
    ['box', 'at', [0.5, 0.75], { params: { width: 170, depth: 75, height: 58, color: '#f4f4f4', finish: 'gloss' }, label: 'bath' }],
    ['box', 'S', 0.2, { params: { width: 90, depth: 2, height: 180, color: '#d0e8f0', finish: 'glass' }, label: 'shower screen' }],
    ['shelf', 'E', 0.5, { elevation: 140 }],
    ['radiator', 'W', 0.5, { elevation: 12, params: { width: 50, height: 80 } }],
    ['wall-sconce', 'N', 0.15, { elevation: 170, params: { kind: 'up-down' } }],
    ['plant', 'at', [0.1, 0.3], { priority: 'minor', params: { kind: 'wall-planter' } }],
    ['box', 'E', 0.3, { priority: 'minor', params: { width: 60, depth: 10, height: 80, color: '#7a8fa6' }, label: 'towel rail' }]
  ],
  guest: [
    ['bed', 'at', [0.5, 0.55], { rotation: 0, params: { width: 141 } }],
    ['cabinet', 'W', 0.5, { params: { width: 120, fronts: [{ height: 228, cells: [{ kind: 'mirror' }, { kind: 'mirror' }] }] } }],
    ['box', 'N', 0.7, { params: { width: 100, depth: 50, height: 75, color: '#9a7b5b' }, label: 'desk' }],
    ['tube-floor-lamp', 'at', [0.9, 0.2], {}],
    ['photo-frame', 'E', 0.4, { elevation: 140 }],
    ['photo-frame', 'E', 0.7, { elevation: 140, priority: 'minor' }],
    ['mirror', 'S', 0.8, { elevation: 60, params: { shape: 'triangle' } }],
    ['speaker', 'N', 0.2, { params: { kind: 'floor-standing' } }],
    ['box', 'W', 0.5, { elevation: 60, params: { width: 60, depth: 2, height: 2, ...E('#ff3060') }, label: 'LED edge' }]
  ],
  utility: [
    ['box', 'N', 0.25, { params: { width: 60, depth: 60, height: 85, color: '#f0f0f0' }, label: 'washer' }],
    ['box', 'N', 0.55, { params: { width: 60, depth: 60, height: 85, color: '#f0f0f0' }, label: 'dryer' }],
    ['shelf', 'E', 0.3, { elevation: 100 }],
    ['shelf', 'E', 0.7, { elevation: 140 }],
    ['cabinet', 'W', 0.5, { params: { width: 80, height: 200, fronts: [{ height: 192, cells: [{ kind: 'door' }, { kind: 'door' }] }] } }],
    ['box', 'at', [0.5, 0.8], { priority: 'minor', params: { width: 50, depth: 40, height: 35, color: '#9c8a6e' }, label: 'crate' }],
    ['box', 'at', [0.7, 0.8], { priority: 'minor', params: { width: 50, depth: 40, height: 35, color: '#9c8a6e' }, label: 'crate' }],
    ['subwoofer', 'S', 0.3, { priority: 'minor' }]
  ],
  study: [
    ['standing-desk', 'S', 0.5, {}],
    ['monitor', 'S', 0.5, { offset: 20, elevation: 76, params: { curved: true } }],
    ['gaming-chair', 'at', [0.5, 0.55], {}],
    ['pc-tower', 'S', 0.85, { params: { glassPanel: true } }],
    ['digital-piano', 'W', 0.5, {}],
    ['piano-bench', 'at', [0.2, 0.5], { rotation: 270 }],
    ['shelf', 'E', 0.5, { elevation: 170 }],
    ['speaker', 'S', 0.2, { elevation: 120 }],
    ['tv', 'N', 0.5, { elevation: 110 }],
    ['plant', 'at', [0.88, 0.2], {}],
    ['slat-panel', 'E', 0.5, { params: { width: 120, height: 240 } }],
    ['box', 'S', 0.5, { elevation: 60, params: { width: 120, depth: 2, height: 2, ...E('#8040ff') }, label: 'desk LED' }]
  ]
};

// Three lit cornices: two narrow (3 downlights each), one wide (5).
const WINDOWS = [
  { room: 'living', side: 'N', width: 300, sill: 10, height: 200, curtain: 330 },
  { room: 'bedroom', side: 'N', width: 160, sill: 60, height: 150, curtain: 200 },
  { room: 'office', side: 'N', width: 140, sill: 90, height: 120, curtain: 190 }
];

export function makePerfFixture() {
  const walls = wallsFor();
  const rooms = [], lights = [], furniture = [], windows = [], curtains = [], doors = [];
  const roomsJson = { kind: 'rooms', schemaVersion: '1.2', house: 'perf-full',
    homeAssistant: { enabled: false, wsReconnectMs: 5000, pollIntervalMs: 5000 }, rooms: {}, sensors: {} };
  ROOM_DEFS.forEach((def, i) => {
    const c = i % COLS, r = Math.floor(i / COLS);
    const R = roomRect(c, r);
    const W = R.x1 - R.x0, D = R.y1 - R.y0;
    rooms.push({ id: def.id, label: def.label,
      polygon: [[R.x0, R.y0], [R.x1, R.y0], [R.x1, R.y1], [R.x0, R.y1]],
      floorColor: i % 2 ? '#b9a88d' : '#a89f94', floorMaterial: 'wood' });
    const px = f => Math.round(R.x0 + W * f), py = f => Math.round(R.y0 + D * f);
    const mix = LIGHT_MIX[def.id];
    const fixtures = [];
    if (mix.ds) {
      const cols = mix.ds > 4 ? 3 : (mix.ds === 3 ? 3 : 2), rowsN = Math.ceil(mix.ds / cols);
      const pos = [];
      for (let k = 0; k < mix.ds; k++) {
        const cc = k % cols, rr = Math.floor(k / cols);
        pos.push({ at: [px((cc + 1) / (cols + 1)), py((rr + 1) / (rowsN + 1))] });
      }
      fixtures.push({ channel: 'main', label: def.label + ' ceiling', fixtureType: 'downlight', colorTemperatureK: 3000, positions: pos });
    }
    if (mix.bulb) fixtures.push({ channel: 'main', label: def.label + ' pendant', fixtureType: 'bulb', colorTemperatureK: 2700, count: 1 });
    if (mix.spots) {
      const pos = [];
      for (let k = 0; k < mix.spots; k++) pos.push({ at: [px(0.25 + 0.5 * (k % 2)), py(0.25 + 0.5 * Math.floor(k / 2) / Math.max(1, Math.ceil(mix.spots / 2) - 1))] });
      fixtures.push({ channel: 'main', label: def.label + ' spots', fixtureType: 'spot', colorTemperatureK: 4000, positions: pos });
    }
    if (mix.strips) {
      const pos = [];
      for (let k = 0; k < mix.strips; k++) {
        pos.push(k % 2 === 0
          ? { at: [px(0.5), Math.round(R.y0 + 12)], heightCm: 236, size: [Math.round(W * 0.8), 2.5, 2.5] }
          : { at: [Math.round(R.x0 + 12), py(0.5)], heightCm: 60, size: [2.5, 8, Math.round(D * 0.6)] });
      }
      fixtures.push({ channel: 'ambient', label: def.label + ' accent', fixtureType: 'strip', colorTemperatureK: 2200, positions: pos });
    }
    lights.push({ room: def.id, fixtures });
    const ent = { main: ['light.demo_perf_' + def.id + '_main'] };
    if (mix.strips) ent.ambient = ['light.demo_perf_' + def.id + '_accent'];
    roomsJson.rooms[def.id] = ent;

    (FURNITURE[def.id] || []).forEach((spec, k) => {
      const [type, anchor, where, extra] = spec;
      const item = { id: def.id + '_' + k + '_' + type.replace(/-/g, '_'), room: def.id, type };
      if (anchor === 'at') {
        item.at = [px(where[0]), py(where[1])];
        if (extra.rotation != null) item.rotation = extra.rotation;
      } else {
        item.wall = sideWall(c, r, anchor);
        item.centre = (anchor === 'N' || anchor === 'S') ? px(where) : py(where);
        if (extra.offset != null) item.offset = extra.offset;
      }
      if (extra.elevation != null) item.elevation = extra.elevation;
      if (extra.priority) item.priority = extra.priority;
      if (extra.params) item.params = extra.params;
      // Every third item opts out of the fade; the rest are auto, so fading
      // wall-anchored items add their clone buckets to the count.
      item.fade = k % 3 === 2 ? 'never' : 'auto';
      item.label = extra.label || type;
      furniture.push(item);
    });

    if (i < COLS) {
      doors.push({ id: def.id + '_door', label: def.label + ' door', wall: 9, centre: px(0.5), width: 80,
        hinge: 'west', swing: 'north', maxOpenDegrees: 90, kind: 'standard', room: def.id });
    }
    const wn = WINDOWS.find(w => w.room === def.id);
    if (wn) {
      windows.push({ id: def.id + '_window', label: def.label + ' window', room: def.id, wall: sideWall(c, r, wn.side),
        centre: px(0.5), width: wn.width, sill: wn.sill, height: wn.height });
      curtains.push({ id: def.id + '_curtain', label: def.label + ' curtain', room: def.id, wall: sideWall(c, r, wn.side),
        centre: px(0.5), width: wn.curtain, openPct: 60 });
      roomsJson.sensors.corniceLights = roomsJson.sensors.corniceLights || {};
      roomsJson.sensors.corniceLights[def.id + '_curtain'] = ['light.demo_perf_' + def.id + '_cornice'];
    }
  });
  const geometry = {
    kind: 'geometry', schemaVersion: '1.2', id: 'perf-full', name: 'Perf fixture (synthetic)',
    description: 'Generated by scripts/make-perf-fixture.mjs. An invented ten-room house for the furniture perf budget.',
    units: 'cm',
    coordinateTransform: { originX: COLS * RW / 2, originY: ROWS * RD / 2, scale: 0.01, planAxes: 'x_east_y_south' },
    defaults: { wallHeight: 245, wallThickness: 10, doorHeight: 203, doorThickness: 4, doorOpeningHeight: 207,
      doorFrameReveal: 8, doorRestOpenFraction: 0.2 },
    materials: { wallColor: '#ece9e1', ceilingColor: '#f4f2ed', doorSlabColor: '#e6ded0', exteriorColor: '#cfc7b8' },
    site: { latitude: 52.5, longitude: 13.4, locationLabel: 'Invented', northOffsetDegrees: 0 },
    rooms, walls, doors, windows, curtains, furniture, lights, cameraPresets: {}
  };
  return { geometry, rooms: roomsJson };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const out = path.resolve(process.argv[2] || path.join(root, 'houses', 'perf-full'));
  const { geometry, rooms } = makePerfFixture();
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'geometry.json'), JSON.stringify(geometry, null, 2));
  fs.writeFileSync(path.join(out, 'rooms.json'), JSON.stringify(rooms, null, 2));
  const types = new Set(geometry.furniture.map(f => f.type));
  console.log('wrote ' + out + ': ' + geometry.rooms.length + ' rooms, ' + geometry.furniture.length +
    ' items (' + geometry.furniture.filter(f => f.priority === 'minor').length + ' minor), ' + types.size + ' types');
}
