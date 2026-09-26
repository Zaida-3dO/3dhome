#!/usr/bin/env node
/**
 * Curtains driven from Home Assistant: the cover / cornice-light binding, the
 * openPct geometry, and the daylight gating. No framework, no install -
 * `node scripts/test-curtain-binding.mjs`.
 *
 * WHAT THIS GUARDS
 *
 *   1. ha-client resolves a cover entity to { pct, moving } for the right
 *      curtain id, and fires ONLY on a real change -- an attribute-only
 *      republish must not become a render tick. 'unavailable' keeps the last
 *      reading rather than snapping the curtain somewhere invented.
 *   2. A cornice light resolves to { on, bri, color } for its curtain and
 *      never leaks into the room-light path (the double-drive this binding
 *      exists to avoid).
 *   3. The openPct geometry: re-posing a built curtain with setOpen(p) lands
 *      on exactly the vertices a fresh build at openPct p has, and each half
 *      stays anchored at its OWN wall end, gathering toward it.
 *   4. Daylight: a closed blackout lets ~nothing through, a closed sheer lets
 *      a dim, warm share through, an open curtain lets it all through, and
 *      the amount changes monotonically as the curtain moves.
 *   5. The fully-open stack: 4.7 cm a pleat by default, `stackPerPleat` and
 *      `stackWidth` overrides in that order of precedence, clamped to a
 *      closed half -- and the fabric and the daylight use the same span.
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const imp = rel => import(pathToFileURL(path.join(root, rel)).href);
const { HAClient } = await imp('src/ha-client.js');
const THREE = await imp('vendor/three-r160/three.module.min.js');
const F = await imp('src/wall-fittings.js');

let failures = 0, passes = 0;
function check(name, cond, detail) {
  if (cond) { passes++; return; }
  failures++;
  console.error('FAIL ' + name + (detail !== undefined ? ' -- ' + JSON.stringify(detail) : ''));
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

// ---------------------------------------------------------------------------
// 1 + 2. HA binding
// ---------------------------------------------------------------------------
{
  const ha = HAClient.create({
    url: 'http://ha.invalid', token: 'x',
    rooms: { lounge: { ambient: ['light.demo_lounge_cove'] } },
    sensors: {
      curtains: {
        lounge_curtain: ['cover.demo_lounge_curtain'],
        twin: ['cover.demo_twin_a', 'cover.demo_twin_b']
      },
      corniceLights: { lounge_curtain: ['light.demo_lounge_cornice'] }
    }
  });
  const curtainEvents = [], corniceEvents = [], lightEvents = [];
  ha.onCurtainChange((id, st) => curtainEvents.push([id, st]));
  ha.onCorniceChange((id, st) => corniceEvents.push([id, st]));
  ha.onStateChange((room, group, st) => lightEvents.push([room, group, st]));

  const cover = (state, pos, extra) => ({ state, attributes: Object.assign(
    pos == null ? {} : { current_position: pos }, extra || {}) });

  check('cover: first reading fires',
    ha._injectFittingState('cover.demo_lounge_curtain', cover('open', 40)) === true);
  check('cover: resolves to the bound curtain id with its position',
    curtainEvents.length === 1 && curtainEvents[0][0] === 'lounge_curtain' &&
    curtainEvents[0][1].pct === 40 && curtainEvents[0][1].moving === null, curtainEvents);

  check('cover: attribute-only republish does NOT fire',
    ha._injectFittingState('cover.demo_lounge_curtain', cover('open', 40, { battery: 81 })) === false &&
    curtainEvents.length === 1);

  ha._injectFittingState('cover.demo_lounge_curtain', cover('opening', 55));
  check('cover: opening is reported as moving',
    curtainEvents.length === 2 && curtainEvents[1][1].moving === 'opening' && curtainEvents[1][1].pct === 55,
    curtainEvents[1]);
  ha._injectFittingState('cover.demo_lounge_curtain', cover('closing', 50));
  check('cover: closing is reported as moving',
    curtainEvents[2] && curtainEvents[2][1].moving === 'closing', curtainEvents[2]);

  check('cover: unavailable keeps the last reading (no event)',
    ha._injectFittingState('cover.demo_lounge_curtain', cover('unavailable', null)) === false &&
    curtainEvents.length === 3);

  ha._injectFittingState('cover.demo_lounge_curtain', cover('closed', null));
  check('cover: positionless closed -> 0',
    curtainEvents[3] && curtainEvents[3][1].pct === 0 && curtainEvents[3][1].moving === null, curtainEvents[3]);

  ha._injectFittingState('cover.demo_twin_a', cover('open', 100));
  ha._injectFittingState('cover.demo_twin_b', cover('open', 20));
  const lastTwin = curtainEvents.filter(e => e[0] === 'twin').pop();
  check('cover: two motors on one curtain are averaged', lastTwin && lastTwin[1].pct === 60, lastTwin);

  check('cover: an unbound entity is ignored',
    ha._injectFittingState('cover.demo_elsewhere', cover('open', 10)) === false);

  // Cornice light
  ha._injectFittingState('light.demo_lounge_cornice',
    { state: 'on', attributes: { brightness: 128, rgb_color: [255, 170, 0] } });
  check('cornice: resolves on/bri/color for the curtain',
    corniceEvents.length === 1 && corniceEvents[0][0] === 'lounge_curtain' &&
    corniceEvents[0][1].on === true && corniceEvents[0][1].bri === 50 && corniceEvents[0][1].color === '#ffaa00',
    corniceEvents);
  ha._injectFittingState('light.demo_lounge_cornice', { state: 'off', attributes: {} });
  check('cornice: off resolves to bri 0',
    corniceEvents[1] && corniceEvents[1][1].on === false && corniceEvents[1][1].bri === 0, corniceEvents[1]);
  check('cornice: never reaches the room-light path', lightEvents.length === 0, lightEvents);
}

// ---------------------------------------------------------------------------
// 3. openPct geometry
// ---------------------------------------------------------------------------
const baseCurtain = {
  id: 'c', w: 200, top: 240, drop: 240, openPct: 100, opacity: 1, sheer: false,
  offset: 12, maxAmp: 5.5, outerColor: 0x3b6e8f, innerColor: 0xe0a458, liningColor: 0xe7dcc4,
  outerPleats: 5, innerPleats: 2, cornice: null, axis: 'x', inDir: 1, c: 500, roomSpan: [0, 1000]
};
const positionsOf = built => {
  const out = {};
  built.group.children.forEach(m => {
    if (m.name && m.name.startsWith('curtain_')) out[m.name] = Array.from(m.geometry.getAttribute('position').array);
  });
  return out;
};
const xRange = (arr) => {
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < arr.length; i += 3) { lo = Math.min(lo, arr[i]); hi = Math.max(hi, arr[i]); }
  return [lo, hi];
};
{
  for (const target of [0, 37, 100]) {
    const moved = F.buildCurtain(THREE, Object.assign({}, baseCurtain, { openPct: 100 }), false);
    moved.setOpen(target);
    const fresh = F.buildCurtain(THREE, Object.assign({}, baseCurtain, { openPct: target }), false);
    const a = positionsOf(moved), b = positionsOf(fresh);
    let maxDiff = 0;
    Object.keys(b).forEach(k => {
      for (let i = 0; i < b[k].length; i++) maxDiff = Math.max(maxDiff, Math.abs(a[k][i] - b[k][i]));
    });
    check('setOpen(' + target + ') matches a fresh build at that openPct',
      Object.keys(a).length === 4 && maxDiff < 1e-6, { maxDiff, keys: Object.keys(a) });
    check('getOpen() reports ' + target, near(moved.getOpen(), target));
  }

  const W = baseCurtain.w / 100;
  const open = F.buildCurtain(THREE, Object.assign({}, baseCurtain, { openPct: 100 }), false);
  const shut = F.buildCurtain(THREE, Object.assign({}, baseCurtain, { openPct: 0 }), false);
  const L_open = xRange(positionsOf(open).curtain_L_front), R_open = xRange(positionsOf(open).curtain_R_front);
  const L_shut = xRange(positionsOf(shut).curtain_L_front), R_shut = xRange(positionsOf(shut).curtain_R_front);
  check('open: left half anchored at its own (-x) wall end', near(L_open[0], -W / 2, 1e-6), L_open);
  check('open: right half anchored at its own (+x) wall end', near(R_open[1], W / 2, 1e-6), R_open);
  // 5 + 2 pleats a half at the default 4.7 cm a pleat: a 32.9 cm stack.
  check('open: left half gathered to a 32.9 cm stack', near(L_open[1], -W / 2 + 0.329, 1e-6), L_open);
  check('open: right half gathered to a 32.9 cm stack', near(R_open[0], W / 2 - 0.329, 1e-6), R_open);
  check('closed: the halves meet past the centre line', L_shut[1] > 0 && R_shut[0] < 0, { L_shut, R_shut });
  check('closed: anchors do not move', near(L_shut[0], -W / 2, 1e-6) && near(R_shut[1], W / 2, 1e-6));
}

// ---------------------------------------------------------------------------
// 4. Daylight gating (pure maths)
// ---------------------------------------------------------------------------
{
  const win = { id: 'w', wallId: 1, c: 500, w: 150 };
  const blackout = Object.assign({}, baseCurtain, { id: 'b', wallId: 1, c: 500, w: 250, sheer: false, opacity: 1 });
  const sheer = Object.assign({}, baseCurtain, { id: 's', wallId: 1, c: 500, w: 250, sheer: true, opacity: 0.4,
    outerColor: 0xd9b86a });
  const at = (pcts) => id => pcts[id];

  const bClosed = F.windowDaylight(win, [blackout], at({ b: 0 }));
  check('blackout closed: near zero light', bClosed.transmit <= 0.03, bClosed);
  const bOpen = F.windowDaylight(win, [blackout], at({ b: 100 }));
  check('blackout fully open: all the light (curtain wider than the window)', near(bOpen.transmit, 1), bOpen);

  let prev = -1, monotonic = true;
  for (let p = 0; p <= 100; p += 5) {
    const t = F.windowDaylight(win, [blackout], at({ b: p })).transmit;
    if (t < prev - 1e-9) monotonic = false;
    prev = t;
  }
  check('blackout: light rises monotonically as it opens', monotonic);
  check('blackout half open lets part of the light in',
    (() => { const t = F.windowDaylight(win, [blackout], at({ b: 50 })).transmit; return t > 0.2 && t < 0.95; })());

  const sClosed = F.windowDaylight(win, [sheer], at({ s: 0 }));
  check('sheer closed: dimmed but not dark', sClosed.transmit > 0.15 && sClosed.transmit < 0.5, sClosed);
  check('sheer closed: warm-golden tint (red > green > blue)',
    sClosed.tint[0] > sClosed.tint[1] && sClosed.tint[1] > sClosed.tint[2], sClosed.tint);
  const sOpen = F.windowDaylight(win, [sheer], at({ s: 100 }));
  check('sheer open: untinted', near(sOpen.tint[2], 1) && near(sOpen.transmit, 1), sOpen);

  const both = F.windowDaylight(win, [sheer, blackout], at({ s: 0, b: 0 }));
  check('sheer + blackout closed: blackout wins', both.transmit <= 0.03 * sClosed.transmit + 1e-9, both);

  const elsewhere = Object.assign({}, blackout, { wallId: 2 });
  check('a curtain on another wall does not gate this window',
    near(F.windowDaylight(win, [elsewhere], at({ b: 0 })).transmit, 1));

  // A curtain much wider than its glazing (wall-to-wall): the light is
  // measured over the WINDOW's span, so a partly-open curtain still shades
  // the glass until its gathered stack clears it.
  const glazing = { id: 'g', wallId: 1, c: 480, w: 250 };
  const wide = Object.assign({}, blackout, { id: 'wide', c: 479.7, w: 328.7 });
  const tWide = p => F.windowDaylight(glazing, [wide], at({ wide: p })).transmit;
  check('wide curtain 30% open still covers most of the glazing', tWide(30) < 0.4, tWide(30));
  check('wide curtain fully open: stack clears the glazing', near(tWide(100), 1), tWide(100));
  // 30% open: each half spans 169.28 + (32.9 - 169.28) x 0.3 = 128.37 cm,
  // so the halves end at 443.72 and start at 515.68.
  check('wide curtain: coverage is measured over the window, not the curtain',
    near(F.curtainCoverage(glazing, wide, 30), (443.72 - 355 + 605 - 515.68) / 250, 0.01),
    F.curtainCoverage(glazing, wide, 30));

  check('no live reading falls back to the profile openPct',
    F.windowDaylight(win, [Object.assign({}, blackout, { openPct: 0 })], () => null).transmit <= 0.03);
}

// ---------------------------------------------------------------------------
// 5. The fully-open stack: one rule, shared by the fabric and the daylight
// ---------------------------------------------------------------------------
{
  // Rule: stackWidth (cm) > stackPerPleat x pleats > 4.7 cm x pleats, and
  // never wider than a closed half (half x 1.03).
  const st = F.curtainStackWidth;
  check('default stack = 4.7 cm x pleats (5 + 2)', near(st({ outerPleats: 5, innerPleats: 2 }), 32.9, 1e-9),
    st({ outerPleats: 5, innerPleats: 2 }));
  check('default stack = 4.7 cm x pleats (3 + 3)', near(st({ outerPleats: 3, innerPleats: 3 }), 28.2, 1e-9));
  check('default stack = 4.7 cm x pleats (10 + 2)', near(st({ outerPleats: 10, innerPleats: 2 }), 56.4, 1e-9));
  check('default stack does not depend on the width',
    near(F.curtainGatheredSpan(80, { outerPleats: 5, innerPleats: 2 }),
      F.curtainGatheredSpan(150, { outerPleats: 5, innerPleats: 2 }), 1e-9));
  check('stackPerPleat overrides the default',
    near(st({ outerPleats: 5, innerPleats: 2, stackPerPleat: 3 }), 21, 1e-9));
  check('stackWidth overrides stackPerPleat',
    near(st({ outerPleats: 5, innerPleats: 2, stackPerPleat: 3, stackWidth: 40 }), 40, 1e-9));
  check('a zero / missing override falls through to the next rule',
    near(st({ outerPleats: 5, innerPleats: 2, stackWidth: 0, stackPerPleat: null }), 32.9, 1e-9));
  check('clamped to the closed half', near(F.curtainGatheredSpan(20, { outerPleats: 5, innerPleats: 2 }), 20.6, 1e-9),
    F.curtainGatheredSpan(20, { outerPleats: 5, innerPleats: 2 }));
  check('closed half-span is unchanged (x 1.03)', near(F.curtainHalfSpan(100, { outerPleats: 5, innerPleats: 2 }, 0), 103, 1e-9));

  // The fabric the scene draws and the interval the daylight uses must be
  // the SAME span, for every rule and at every openness.
  const variants = [
    ['default', {}],
    ['stackPerPleat', { stackPerPleat: 6.2 }],
    ['stackWidth', { stackWidth: 44 }],
    ['clamped', { w: 50 }]
  ];
  for (const [label, extra] of variants) {
    for (const pct of [100, 60, 0]) {
      const cur = Object.assign({}, baseCurtain, { openPct: pct, wallId: 1 }, extra);
      const built = F.buildCurtain(THREE, cur, false);
      const L = xRange(positionsOf(built).curtain_L_front), R = xRange(positionsOf(built).curtain_R_front);
      const iv = F.curtainCoverIntervals(cur, pct);
      const fabricSpan = (L[1] - L[0]) * 100;
      const want = F.curtainHalfSpan(cur.w / 2, cur, pct / 100);
      if (iv.length === 2) {
        const coverSpan = iv[0][1] - iv[0][0];
        check('coverage span = fabric span (' + label + ', ' + pct + '%)', near(coverSpan, fabricSpan, 1e-3),
          { coverSpan, fabricSpan });
        check('right half mirrors the left (' + label + ', ' + pct + '%)',
          near((R[1] - R[0]) * 100, iv[1][1] - iv[1][0], 1e-3));
      } else {
        // Closed: the halves overlap, so coverage is the whole width.
        check('closed: fabric overlaps past the centre (' + label + ')', fabricSpan > cur.w / 2, fabricSpan);
      }
      check('fabric span follows the shared rule (' + label + ', ' + pct + '%)', near(fabricSpan, want, 1e-3),
        { fabricSpan, want });
    }
  }
  const open100 = Object.assign({}, baseCurtain, { wallId: 1, stackWidth: 44 });
  const iv = F.curtainCoverIntervals(open100, 100);
  check('coverage at 100% with stackWidth 44: 44 cm at each end',
    iv.length === 2 && near(iv[0][1] - iv[0][0], 44, 1e-9) && near(iv[1][1] - iv[1][0], 44, 1e-9), iv);
  // A wider stack keeps shading the glass when fully open (it used to clear it).
  const glass = { id: 'g2', wallId: 1, c: 500, w: 160 };   // 420..580, curtain 400..600
  const t100 = F.windowDaylight(glass, [open100], () => 100).transmit;
  check('a 44 cm stack over a window 20 cm in from each end still blocks 2 x 24 cm',
    near(t100, 1 - (48 / 160) * (1 - F.BLACKOUT_TRANSMIT), 1e-9), t100);
}

if (failures) {
  console.error(failures + ' failed, ' + passes + ' passed');
  process.exit(1);
}
console.log('ok -- ' + passes + ' passed, 0 failed');
