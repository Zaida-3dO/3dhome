#!/usr/bin/env node
/**
 * Accent-light colour: the conversions behind the sidebar / popover colour
 * square (src/light-color.js), and the Home Assistant client reading an
 * ambient light's colour from rgb_color OR hs_color. No framework, no
 * install -- `node scripts/test-light-color.mjs`.
 *
 * WHAT THIS GUARDS
 *   1. hex <-> rgb round-trips, and junk in gives null (never a made-up colour).
 *   2. hs_color -> rgb at the primaries, a mid saturation, zero saturation,
 *      and hue wrap-around.
 *   3. colorFromAttributes: rgb_color wins, hs_color is the fallback, a light
 *      reporting neither (off) gives null.
 *   4. swatchColor: always the lowercase '#rrggbb' an <input type="color">
 *      needs, the default for an unknown colour.
 *   5. isColorChannel: accent channels yes; main and galaxy no.
 *   6. HAClient (over the fake HA WebSocket): an ambient light reporting only
 *      hs_color reaches the sidebar as that colour; one that goes off keeps
 *      its last colour (the event carries no colour) instead of snapping to a
 *      default; a non-'ambient' accent channel carries its colour too.
 *   7. index.html sends rgb_color for a non-ambient accent channel only when
 *      the colour was picked (withColor), and follows HA's colour for every
 *      colour channel.
 *   8. lightServiceCall: a power switch turns a light on with NO brightness
 *      (HA restores its last level) -- sidebar and popover switches alike;
 *      the brightness sliders still send their level.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { installFakeHA } from './fake-ha-websocket.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const imp = rel => import(pathToFileURL(path.join(root, rel)).href);
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');

let passes = 0, failures = 0;
function check(name, ok, detail) {
  if (ok) { passes++; console.log('  ok   ' + name); }
  else { failures++; console.error('  FAIL ' + name + (detail !== undefined ? '\n       ' + JSON.stringify(detail) : '')); }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const C = await imp('src/light-color.js');

// 1. hex <-> rgb
check('hexToRgb #00ccff', eq(C.hexToRgb('#00ccff'), [0, 204, 255]), C.hexToRgb('#00ccff'));
check('hexToRgb upper case + no hash', eq(C.hexToRgb('FF3300'), [255, 51, 0]));
check('hexToRgb short form', eq(C.hexToRgb('#0cf'), [0, 204, 255]));
check('hexToRgb junk -> null', C.hexToRgb('#12345') === null && C.hexToRgb('red') === null && C.hexToRgb(null) === null);
check('rgbToHex pads and lowercases', C.rgbToHex([0, 12, 255]) === '#000cff', C.rgbToHex([0, 12, 255]));
check('rgbToHex clamps and rounds', C.rgbToHex([300, -5, 127.6]) === '#ff0080', C.rgbToHex([300, -5, 127.6]));
check('rgbToHex junk -> null', C.rgbToHex([1, 2]) === null && C.rgbToHex(['a', 0, 0]) === null && C.rgbToHex(null) === null);
for (const hex of ['#000000', '#ffffff', '#7f3a91', '#00ff66']) {
  check('round trip ' + hex, C.rgbToHex(C.hexToRgb(hex)) === hex);
}

// 2. hs -> rgb
check('hs red (0, 100)', eq(C.hsToRgb(0, 100), [255, 0, 0]), C.hsToRgb(0, 100));
check('hs green (120, 100)', eq(C.hsToRgb(120, 100), [0, 255, 0]), C.hsToRgb(120, 100));
check('hs blue (240, 100)', eq(C.hsToRgb(240, 100), [0, 0, 255]), C.hsToRgb(240, 100));
check('hs yellow (60, 100)', eq(C.hsToRgb(60, 100), [255, 255, 0]), C.hsToRgb(60, 100));
check('hs magenta (300, 100)', eq(C.hsToRgb(300, 100), [255, 0, 255]), C.hsToRgb(300, 100));
check('hs orange half-saturated (30, 50)', eq(C.hsToRgb(30, 50), [255, 191, 128]), C.hsToRgb(30, 50));
check('hs zero saturation -> white', eq(C.hsToRgb(200, 0), [255, 255, 255]));
check('hs hue wraps (360 = red, -120 = blue)', eq(C.hsToRgb(360, 100), [255, 0, 0]) && eq(C.hsToRgb(-120, 100), [0, 0, 255]));
check('hs saturation clamps', eq(C.hsToRgb(0, 150), [255, 0, 0]));
check('hs junk -> null', C.hsToRgb('a', 1) === null && C.hsToRgb(NaN, 50) === null);

// 3. attributes
check('rgb_color wins over hs_color', C.colorFromAttributes({ rgb_color: [0, 204, 255], hs_color: [0, 100] }) === '#00ccff');
check('hs_color alone', C.colorFromAttributes({ hs_color: [120, 100] }) === '#00ff00', C.colorFromAttributes({ hs_color: [120, 100] }));
check('neither (off: HA nulls them) -> null', C.colorFromAttributes({ rgb_color: null, hs_color: null }) === null
  && C.colorFromAttributes({}) === null && C.colorFromAttributes(null) === null);

// 4. swatch
check('swatchColor lowercases', C.swatchColor('#00CCFF') === '#00ccff');
check('swatchColor expands short form', C.swatchColor('#0cf') === '#00ccff');
check('swatchColor unknown -> the default', C.swatchColor(undefined) === C.DEFAULT_ACCENT_COLOR && C.swatchColor('bogus') === '#ff3300');

// 5. channels
check('ambient + other accents are colour channels', C.isColorChannel('ambient') && C.isColorChannel('cove') && C.isColorChannel('tv'));
check('main, galaxy, nothing are not', !C.isColorChannel('main') && !C.isColorChannel('galaxy') && !C.isColorChannel(''));

// 5b. supported_color_modes
check('supportsColor: rgb / hs / xy / rgbw / rgbww modes -> yes',
  ['rgb', 'hs', 'xy', 'rgbw', 'rgbww'].every(m => C.supportsColor({ supported_color_modes: ['onoff', m] })));
check('supportsColor: white-only (brightness / color_temp / onoff / white) -> no',
  !C.supportsColor({ supported_color_modes: ['brightness'] }) && !C.supportsColor({ supported_color_modes: ['color_temp', 'white'] })
  && !C.supportsColor({ supported_color_modes: ['onoff'] }));
check('supportsColor: unknown (no raw state / no modes reported) -> yes, the square stays',
  C.supportsColor(null) && C.supportsColor({}) && C.supportsColor({ supported_color_modes: null }));

// 6. HAClient over the fake socket (fictional entity ids -- public repo)
{
  const { HAClient } = await imp('src/ha-client.js');
  const E = { amb: 'light.demo_study_strip', cove: 'light.demo_study_cove' };
  const ROOMS = { study: { ambient: [E.amb], cove: [E.cove] } };
  const states = [
    { entity_id: E.amb, state: 'on', attributes: { brightness: 128, hs_color: [240, 100] } },
    { entity_id: E.cove, state: 'on', attributes: { brightness: 255, rgb_color: [0, 255, 102] } },
  ];
  const fake = installFakeHA({ states });
  const realLog = console.log, realWarn = console.warn;
  console.log = () => {}; console.warn = () => {};
  const seen = [];
  try {
    const ha = HAClient.create({ url: 'http://ha.invalid', token: 't', rooms: ROOMS, sensors: {}, wsReconnectMs: 15 });
    ha.onStateChange((roomId, group, st) => seen.push({ roomId, group, st }));
    ha.connect();
    await fake.whenConnected(ha);
    const last = g => seen.filter(x => x.group === g).pop();
    console.log = realLog;
    check('ambient reporting only hs_color reaches the panel as that colour', last('ambient') && last('ambient').st.color === '#0000ff', last('ambient'));
    check('ambient brightness still parsed', last('ambient') && last('ambient').st.bri === 50, last('ambient'));
    check('a non-ambient accent channel carries its colour', last('cove') && last('cove').st.color === '#00ff66', last('cove'));
    console.log = () => {};
    fake.sockets[fake.sockets.length - 1].emitStateChanged({ entity_id: E.amb, state: 'off', attributes: { rgb_color: null, hs_color: null } });
    await sleep(20);
    console.log = realLog;
    const off = last('ambient');
    check('light goes off: event carries NO colour (last known stands)', off && off.st.on === false && !('color' in off.st), off);
    console.log = () => {};
    fake.sockets[fake.sockets.length - 1].emitStateChanged({ entity_id: E.cove, state: 'off', attributes: { rgb_color: null } });
    await sleep(20);
    console.log = realLog;
    check('named channel going off: no colour either', last('cove') && last('cove').st.on === false && !('color' in last('cove').st), last('cove'));
    ha.disconnect();
  } finally {
    console.log = realLog; console.warn = realWarn;
    fake.restore();
  }
}

// 7. index.html wiring (source level)
{
  const html = read('index.html');
  // sendToHA builds its call with lightServiceCall (section 8 tests it).
  check('sendToHA: the call is lightServiceCall(group, state, { withColor, power })',
    /const call = lightServiceCall\(group, state, \{ withColor, power \}\);\s*ha\.callServiceDebounced\('light', call\.service, call\.data, target, key, debounceMs \|\| 0\);/.test(html));
  check('HA colour followed for every accent channel (#65: any non-main)',
    /if \(state\.color !== undefined && group !== 'main'\) ls\[group\]\.color = state\.color;/.test(html));
  check('sidebar square gated on the ambient entity supporting colour',
    /ambientRowHtml\(s\.ambient, ambientRowLabel\(lc\.ambient, rm && rm\.name\), offline, ambientColorable\(rid\)\)/.test(html)
    && /return supportsColor\(raw && raw\.attributes\);/.test(html));
  const tp = read('src/tap-popovers.js');
  check('popover square gated on supported_color_modes', /colorable: isColorChannel\(t\.channel\) && supportsColor\(r && r\.attributes\),/.test(tp));
}

// 8. lightServiceCall: the sidebar / popover light call. A POWER switch
//    turns on with no brightness (HA restores the last level); the slider sends one.
{
  const L = await imp('src/light-color.js');
  const html = read('index.html');
  const tp = read('src/tap-popovers.js');
  const main = { on: true, bri: 40, temp: 3000 };
  const pw = L.lightServiceCall('main', main, { power: true });
  // Mutation: drop `!o.power &&` -> brightness 102 -> fails.
  check('power switch on: turn_on with NO brightness key', pw.service === 'turn_on' && !('brightness' in pw.data), pw);
  const sl = L.lightServiceCall('main', main, {});
  check('slider: brightness from bri (the old rounding)', sl.service === 'turn_on' && sl.data.brightness === 102 && sl.data.color_temp_kelvin === 3000, sl);
  check('off: turn_off, no data', eq(L.lightServiceCall('main', { on: false, bri: 40 }, { power: true }), { service: 'turn_off', data: {} }));
  check('colour temp only on main', !('color_temp_kelvin' in L.lightServiceCall('cove', { on: true, temp: 3000 }, {}).data));
  check('rgb_color for ambient always, other colour channels only when picked',
    eq(L.lightServiceCall('ambient', { on: true, color: '#ff8000' }, { power: true }).data.rgb_color, [255, 128, 0]) &&
    !('rgb_color' in L.lightServiceCall('cove', { on: true, color: '#ff8000' }, {}).data) &&
    eq(L.lightServiceCall('cove', { on: true, color: '#ff8000' }, { withColor: true }).data.rgb_color, [255, 128, 0]) &&
    !('rgb_color' in L.lightServiceCall('galaxy', { on: true, color: '#ff8000' }, { withColor: true }).data));
  // A colour pick on an OFF light (power + withColor): the colour, no brightness.
  const pk = L.lightServiceCall('cove', { on: true, bri: 100, color: '#ff8000' }, { withColor: true, power: true });
  check('colour pick turning a light on: rgb_color, no brightness', !('brightness' in pk.data) && eq(pk.data.rgb_color, [255, 128, 0]), pk);
  check('a colour that is not a colour is not sent', !('rgb_color' in L.lightServiceCall('ambient', { on: true, color: 'junk' }, {}).data));
  // Wiring: every power switch passes power = true; the sliders do not.
  // Mutation: drop `, false, true` from any toggle -> fails.
  ['main', 'ambient', 'galaxy'].forEach(ch => check('sidebar ' + ch + ' switch sends as a power switch',
    html.indexOf("sendToHA(rid, '" + ch + "', s." + ch + ", 0, false, true); refreshRoomRow('" + ch + "');") !== -1));
  check('sidebar sliders are not power switches', (html.match(/sendToHA\(rid, '\w+', s\.\w+, 200(, true)?\);/g) || []).length === 5);
  check('popover sendLight forwards power', /sendLight: \(roomId, channel, state, debounceMs, withColor, power\) => sendToHA\(roomId, channel, state, debounceMs, withColor, power\),/.test(html));
  check('popover light switch sends as a power switch', /o\.sendLight\(t\.roomId, t\.channel, st, 0, false, true\);/.test(tp));
  check('popover light slider is not a power switch', /o\.sendLight\(t\.roomId, t\.channel, st, 200\);/.test(tp));
}

console.log('\n' + passes + ' passed, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
