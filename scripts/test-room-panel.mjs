#!/usr/bin/env node
/**
 * Room sidebar v2: the rows' service-call mappings, status reductions and
 * the shared slider write path. No framework, no install --
 * `node scripts/test-room-panel.mjs`.
 *
 * WHAT THIS GUARDS
 *
 *   1. climate.set_temperature mapping (HAClient.climateTargetCommand):
 *      value -> payload, clamping to the entity's min/max, rounding to its
 *      target_temp_step, and sending NOTHING for a non-number, for an 'off'
 *      thermostat or a null target, and for an unavailable entity.
 *   2. parseClimate: limits from min_temp / max_temp / target_temp_step,
 *      step defaulting to 0.5, null target / 'off' -> off.
 *   3. Curtain Open / Close buttons (coverOpenCloseCommand): service names,
 *      multi-motor fan-out, refusal of anything else.
 *   4. Motion OR-reduction and door status: any 'on' wins; unavailable only
 *      when EVERY bound sensor is unavailable/unknown/silent; the text each
 *      status maps to. Also through HAClient itself (onSensorStatusChange),
 *      including that it fires only on a real change.
 *   5. Row markup: disabled when it must be (slider AND buttons), limits on
 *      the temperature slider.
 *   6. createDragSender -- the index.html slider logic, extracted so it can be
 *      tested (follow-up b2d7f49a): one send per release, per-drag dedupe
 *      reset, NaN sends nothing, a button cancels a pending slider send, the
 *      drag lock releases, and a refused build (thermostat off) sends
 *      nothing even on release. Run against the REAL
 *      HAClient.callServiceDebounced over a fake HA WebSocket.
 *   7. index.html actually wires it that way (pointerup ends the drag, no
 *      door slider left, both senders cleared on a full re-render).
 *   8. Sidebar polish: each section header has the popover's icon and a
 *      sentence-case title; the ambience row has ONE colour square inline
 *      with its slider (no swatch grid, no colour bar, no strip list);
 *      curtain Open / Close are icon buttons; the thermometer is orange
 *      while heating.
 *   9. curtainsToRevert: the curtains to put back to HA's last report when
 *      HA goes offline with an unsent drag showing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const imp = rel => import(pathToFileURL(path.join(root, rel)).href);
const { installFakeHA } = await import(pathToFileURL(path.join(root, 'scripts/fake-ha-websocket.mjs')).href);
const { HAClient } = await imp('src/ha-client.js');
const RP = await imp('src/room-panel.js');

let failures = 0, passes = 0;
function check(name, cond, detail) {
  if (cond) { passes++; return; }
  failures++;
  console.error('FAIL ' + name + (detail !== undefined ? ' -- ' + JSON.stringify(detail) : ''));
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

const TRV = 'climate.demo_bedroom_radiator';
const onReading = (over = {}) => HAClient.parseClimate({
  state: 'heat',
  attributes: { current_temperature: 20.4, temperature: 21, min_temp: 5, max_temp: 30, target_temp_step: 0.5, ...over }
});

// ---------------------------------------------------------------------------
// 1. climateTargetCommand
// ---------------------------------------------------------------------------
{
  const r = onReading();
  const c = HAClient.climateTargetCommand(22, TRV, r);
  check('climate: domain/service', c && c.domain === 'climate' && c.service === 'set_temperature', c);
  check('climate: value passed through as temperature', c && c.data.temperature === 22, c);
  check('climate: targets the bound entity', c && c.target.entity_id === TRV, c);
  check('climate: payload carries nothing but temperature', c && Object.keys(c.data).join() === 'temperature', c);

  check('climate: above max clamps to max', HAClient.climateTargetCommand(99, TRV, r).data.temperature === 30);
  check('climate: below min clamps to min', HAClient.climateTargetCommand(-4, TRV, r).data.temperature === 5);
  check('climate: rounds to step 0.5 (21.3 -> 21.5)', HAClient.climateTargetCommand(21.3, TRV, r).data.temperature === 21.5);
  check('climate: rounds to step 0.5 (21.2 -> 21)', HAClient.climateTargetCommand(21.2, TRV, r).data.temperature === 21);
  const r1 = onReading({ target_temp_step: 1 });
  check('climate: step 1 (21.6 -> 22)', HAClient.climateTargetCommand(21.6, TRV, r1).data.temperature === 22);
  const r01 = onReading({ target_temp_step: 0.1 });
  // 217 * 0.1 is 21.700000000000003 in floating point: this fails if the
  // toFixed() clean-up is removed.
  const t01 = HAClient.climateTargetCommand(21.7, TRV, r01).data.temperature;
  check('climate: step 0.1 has no float noise (21.7 -> 21.7)', t01 === 21.7, t01);
  const noStep = HAClient.parseClimate({ state: 'heat', attributes: { temperature: 20, min_temp: 10, max_temp: 32 } });
  check('climate: missing step -> default 0.5 rounding (20.3 -> 20.5)',
    HAClient.climateTargetCommand(20.3, TRV, noStep).data.temperature === 20.5);
  check('climate: numeric string from a range input is accepted',
    HAClient.climateTargetCommand('23.5', TRV, r).data.temperature === 23.5);

  // Nothing to send.
  [NaN, undefined, null, '', '  ', 'warm', Infinity, true].forEach(v => {
    check('climate: non-number ' + String(v) + ' -> null', HAClient.climateTargetCommand(v, TRV, r) === null);
  });
  const offState = HAClient.parseClimate({ state: 'off', attributes: { temperature: 21, min_temp: 5, max_temp: 30 } });
  check('climate: hvac off -> null even with a target', HAClient.climateTargetCommand(21, TRV, offState) === null);
  const nullTarget = HAClient.parseClimate({ state: 'heat', attributes: { temperature: null, min_temp: 5, max_temp: 30 } });
  check('climate: null target -> null', HAClient.climateTargetCommand(21, TRV, nullTarget) === null);
  const unav = HAClient.parseClimate({ state: 'unavailable', attributes: { temperature: 21 } });
  check('climate: unavailable -> null', HAClient.climateTargetCommand(21, TRV, unav) === null);
  const unknown = HAClient.parseClimate({ state: 'unknown', attributes: { temperature: 21 } });
  check('climate: unknown -> null', HAClient.climateTargetCommand(21, TRV, unknown) === null);
  check('climate: no reading yet -> null', HAClient.climateTargetCommand(21, TRV, null) === null);
  check('climate: no bound entity -> null', HAClient.climateTargetCommand(21, null, r) === null);
}

// ---------------------------------------------------------------------------
// 2. parseClimate
// ---------------------------------------------------------------------------
{
  const r = onReading();
  check('parse: limits from attributes', r.min === 5 && r.max === 30 && r.step === 0.5, r);
  check('parse: current + target', r.current === 20.4 && r.target === 21 && r.off === false && r.available === true, r);
  const bare = HAClient.parseClimate({ state: 'heat', attributes: { temperature: 20 } });
  check('parse: absent limits -> 7..35 step 0.5', bare.min === 7 && bare.max === 35 && bare.step === 0.5, bare);
  const bad = HAClient.parseClimate({ state: 'heat', attributes: { temperature: 20, min_temp: 40, max_temp: 10, target_temp_step: 0 } });
  check('parse: min > max and step 0 fall back to defaults', bad.min === 7 && bad.max === 35 && bad.step === 0.5, bad);
  const off = HAClient.parseClimate({ state: 'off', attributes: { temperature: 21 } });
  check('parse: state off -> off, target hidden', off.off === true && off.target === null && off.available === true, off);
  const nt = HAClient.parseClimate({ state: 'heat', attributes: { temperature: null } });
  check('parse: null target -> off', nt.off === true && nt.target === null, nt);
  const un = HAClient.parseClimate({ state: 'unavailable', attributes: {} });
  check('parse: unavailable -> available false', un.available === false, un);
  check('parse: no state object -> unavailable', HAClient.parseClimate(null).available === false);
}

// ---------------------------------------------------------------------------
// 3. Curtain Open / Close buttons
// ---------------------------------------------------------------------------
{
  const one = HAClient.coverOpenCloseCommand('open', ['cover.demo_bedroom_curtain']);
  check('open: cover.open_cover', one && one.domain === 'cover' && one.service === 'open_cover', one);
  check('open: single target is a bare id', one && one.target.entity_id === 'cover.demo_bedroom_curtain', one);
  check('open: no position in the payload', one && Object.keys(one.data).length === 0, one);
  const two = HAClient.coverOpenCloseCommand('close', ['cover.demo_lounge_l', 'cover.demo_lounge_r']);
  check('close: cover.close_cover', two && two.service === 'close_cover', two);
  check('close: fans out to every motor', two && Array.isArray(two.target.entity_id) && two.target.entity_id.length === 2, two);
  check('bogus action -> null', HAClient.coverOpenCloseCommand('stop', ['cover.demo_x']) === null);
  check('no bound motor -> null', HAClient.coverOpenCloseCommand('open', []) === null);
  // The position mapping kept its guard against the `+x` trap: +null is 0,
  // which would be "fully CLOSE".
  check('coverPositionCommand(null) sends nothing (not position 0)',
    HAClient.coverPositionCommand(null, ['cover.demo_x']) === null);
  check('coverPositionCommand(\'\') sends nothing', HAClient.coverPositionCommand('', ['cover.demo_x']) === null);
}

// ---------------------------------------------------------------------------
// 4. Motion OR-reduction and door status
// ---------------------------------------------------------------------------
{
  const R = HAClient.reduceBinarySensorStates;
  check('OR: one of three on -> on', R(['off', 'on', 'off']) === 'on');
  check('OR: on wins over unavailable', R(['unavailable', 'on']) === 'on');
  check('OR: all off -> off', R(['off', 'off', 'off']) === 'off');
  check('OR: off + unavailable -> off (some sensor is reporting)', R(['off', 'unavailable', undefined]) === 'off');
  check('OR: all unavailable -> unavailable', R(['unavailable', 'unavailable']) === 'unavailable');
  check('OR: unknown counts as unavailable', R(['unknown', 'unavailable']) === 'unavailable');
  check('OR: never reported -> unavailable', R([undefined, undefined]) === 'unavailable');
  check('OR: empty -> unavailable', R([]) === 'unavailable');

  check('motion label on', RP.motionLabel('on') === 'Motion detected');
  check('motion label off', RP.motionLabel('off') === 'No motion');
  check('motion label unavailable', RP.motionLabel('unavailable') === 'Unavailable');
  check('motion label no reading', RP.motionLabel(null) === 'Unavailable');
  check('door label open', RP.doorLabel('on') === 'Door: open');
  check('door label closed', RP.doorLabel('off') === 'Door: closed');
  check('door label unavailable', RP.doorLabel('unavailable') === 'Door: unavailable');
  check('door label no reading', RP.doorLabel(null) === 'Door: unavailable');

  // Through HAClient: three zone sensors on one room.
  const zones = ['binary_sensor.demo_zone_a', 'binary_sensor.demo_zone_b', 'binary_sensor.demo_zone_c'];
  const ha = HAClient.create({ url: 'http://ha.invalid', token: 'x', rooms: {},
    sensors: { presence: { lounge: zones }, doors: { front_door: ['binary_sensor.demo_front_contact'] } } });
  const seen = [];
  ha.onSensorStatusChange((kind, id, status) => seen.push(kind + ':' + id + ':' + status));
  const presenceBool = [];
  ha.onPresenceChange((id, occ) => presenceBool.push(occ));

  check('status is null before any reading', ha.getSensorStatus('presence', 'lounge') === null);
  ha._injectSensorState(zones[0], 'off');
  check('first reading off -> off', ha.getSensorStatus('presence', 'lounge') === 'off', seen);
  ha._injectSensorState(zones[1], 'on');
  check('any zone on -> on', ha.getSensorStatus('presence', 'lounge') === 'on', seen);
  ha._injectSensorState(zones[0], 'off');
  check('republished same state fires nothing', seen.length === 2, seen);
  ha._injectSensorState(zones[2], 'on');
  ha._injectSensorState(zones[2], 'off');
  check('a second zone flipping while the room is already on fires nothing', seen.length === 2, seen);
  ha._injectSensorState(zones[1], 'unavailable');
  check('the on zone drops -> off (zone a still reports)', ha.getSensorStatus('presence', 'lounge') === 'off', seen);
  ha._injectSensorState(zones[0], 'unavailable');
  check('zone c still reporting off -> off', ha.getSensorStatus('presence', 'lounge') === 'off', seen);
  ha._injectSensorState(zones[2], 'unknown');
  check('every zone unavailable/unknown -> unavailable',
    ha.getSensorStatus('presence', 'lounge') === 'unavailable', seen);
  check('each change fired exactly once',
    seen.join() === 'presence:lounge:off,presence:lounge:on,presence:lounge:off,presence:lounge:unavailable', seen);
  // The boolean the 3D footsteps use is unchanged in behaviour: unavailable
  // folds into "not occupied", and off -> unavailable is NOT a boolean change
  // (first off, on, off -- nothing for the two unavailable transitions).
  check('3D presence boolean unchanged by status tracking', presenceBool.join() === 'false,true,false', presenceBool);

  ha._injectSensorState('binary_sensor.demo_front_contact', 'on');
  check('door on -> status on', ha.getSensorStatus('door', 'front_door') === 'on');
  ha._injectSensorState('binary_sensor.demo_front_contact', 'unknown');
  check('door unknown -> unavailable', ha.getSensorStatus('door', 'front_door') === 'unavailable');
}

// ---------------------------------------------------------------------------
// 4b. HAClient climate path
// ---------------------------------------------------------------------------
{
  const ha = HAClient.create({ url: 'http://ha.invalid', token: 'x', rooms: {},
    sensors: { climate: { bedroom: TRV, landing: 'climate.demo_shared', attic: 'climate.demo_shared' } } });
  const got = [];
  ha.onClimateChange((room, r) => got.push(room + ':' + r.target));
  const st = t => ({ state: 'heat', attributes: { current_temperature: 20, temperature: t, min_temp: 5, max_temp: 30,
    target_temp_step: 0.5, hvac_action: 'heating' } });
  check('climate: getClimate null before a reading', ha.getClimate('bedroom') === null);
  check('climate: first reading fires', ha._injectClimateState(TRV, st(21)) === true && got.join() === 'bedroom:21', got);
  const same = st(21); same.attributes.hvac_action = 'idle';
  check('climate: attribute the row does not show -> no fire', ha._injectClimateState(TRV, same) === false, got);
  ha._injectClimateState(TRV, st(22));
  check('climate: target change fires', got.join() === 'bedroom:21,bedroom:22', got);
  check('climate: getClimate returns the parsed reading', ha.getClimate('bedroom').target === 22);
  check('climate: climateEntityFor', ha.climateEntityFor('bedroom') === TRV && ha.climateEntityFor('nowhere') === null);
  ha._injectClimateState('climate.demo_shared', st(19));
  check('climate: one entity bound to two rooms updates both',
    ha.getClimate('landing').target === 19 && ha.getClimate('attic').target === 19, got);
  check('climate: unbound entity is ignored', ha._injectClimateState('climate.demo_other', st(18)) === false);
}

// ---------------------------------------------------------------------------
// 5. Row markup
// ---------------------------------------------------------------------------
{
  const dis = html => /data-action="climate-target"[^>]*\sdisabled/.test(html) || /\sdisabled[^>]*data-action="climate-target"/.test(html);
  const on = RP.climateRowHtml(onReading());
  check('climate row: enabled when on', !dis(on), on);
  check('climate row: min/max/step from the entity',
    /min="5"/.test(on) && /max="30"/.test(on) && /step="0.5"/.test(on) && /value="21"/.test(on), on);
  check('climate row: shows current and target', /20\.4/.test(on) && /Target: 21\.0/.test(on), on);
  const off = RP.climateRowHtml(HAClient.parseClimate({ state: 'off', attributes: { temperature: null, min_temp: 10, max_temp: 32 } }));
  check('climate row: off -> disabled', dis(off), off);
  check('climate row: off -> says off', /Target: off/.test(off), off);
  check('climate row: no reading -> disabled + Unavailable', dis(RP.climateRowHtml(null)) && /Unavailable/.test(RP.climateRowHtml(null)));
  check('climate row: unavailable -> disabled',
    dis(RP.climateRowHtml(HAClient.parseClimate({ state: 'unavailable', attributes: { temperature: 21 } }))));

  const cu = { id: 'lounge_sheer', label: 'Lounge Sheer' };
  const avail = RP.curtainRowHtml(cu, 40, true);
  const down = RP.curtainRowHtml(cu, 40, false);
  const count = (h, re) => (h.match(re) || []).length;
  check('curtain row: Open + Close buttons', /data-cmd="open"/.test(avail) && /data-cmd="close"/.test(avail), avail);
  check('curtain row: available -> nothing disabled', count(avail, /\sdisabled/g) === 0, avail);
  check('curtain row: unavailable -> slider AND both buttons disabled', count(down, /\sdisabled/g) === 3, down);
  check('curtain row: keyed for single-row repaint', /data-row="curtain:lounge_sheer"/.test(avail));

  const door = RP.doorRowHtml({ id: 'store_door', name: 'Store cupboard' }, 'on', false);
  check('door row: status text only, no slider', /Door: open/.test(door) && !/type="range"/.test(door), door);
  check('door row: name shown only when asked', !/Store cupboard/.test(door) &&
    /Store cupboard/.test(RP.doorRowHtml({ id: 'store_door', name: 'Store cupboard' }, 'off', true)));
  check('motion row: tag text', /Motion detected/.test(RP.motionRowHtml('on')) && /No motion/.test(RP.motionRowHtml('off')));
  check('row markup escapes profile text', /&lt;b&gt;/.test(RP.curtainRowHtml({ id: 'x', label: '<b>' }, 0, true)));
}

// ---------------------------------------------------------------------------
// 5b. Sidebar polish: popover icons, sentence case, colour square, no strips
// ---------------------------------------------------------------------------
{
  const { ICONS } = await imp('src/ui-icons.js');
  const has = (html, p) => html.indexOf('d="' + p + '"') !== -1;
  const label = html => (html.match(/<span class="control-label">([^<]*)<\/span>/) || [])[1];
  const lightOn = { on: true, bri: 17, temp: 3000, color: '#00CCFF' };
  const lightOff = { on: false, bri: 17, temp: 3000, color: '#00ccff' };

  const main = RP.mainLightRowHtml(lightOn, false);
  check('main light: bulb icon (lit), sentence-case title', has(main, ICONS.bulb) && /row-ico light-on/.test(main) && label(main) === 'Main light', main);
  check('main light off: the off bulb', has(RP.mainLightRowHtml(lightOff, false), ICONS.bulbOff));

  const amb = RP.ambientRowHtml(lightOn, 'Office Ambience', false);
  check('ambience: bulb icon, sentence-case title (never ALL CAPS)', has(amb, ICONS.bulb) && label(amb) === 'Office ambience', label(amb));
  check('ambience: ONE colour square showing the current colour',
    (amb.match(/type="color"/g) || []).length === 1 && /class="color-square" value="#00ccff"/.test(amb), amb);
  check('ambience: the 10-swatch grid and long colour bar are gone',
    !/color-swatch/.test(amb) && !/color-input/.test(amb) && RP.AMBIENT_SWATCHES === undefined);
  check('ambience: square INLINE with the slider and its value -- [square] slider 17%',
    /<div class="slider-row inline-row">\s*<input type="color"[^>]*>\s*<input type="range"[^>]*data-action="bri-ambient"[^>]*>\s*<span class="inline-val">17%<\/span>/.test(amb), amb);
  check('ambience: square is labelled and sends through data-action', /data-action="color-ambient" aria-label="Colour"/.test(amb));
  check('ambience: unknown colour -> the default, never an invalid value', /value="#ff3300"/.test(RP.ambientRowHtml({ on: true, bri: 50 }, 'A', false)));
  const wOnly = RP.ambientRowHtml(lightOn, 'A', false, false);
  check('ambience, white-only entity: slider + value, no colour square', !/type="color"/.test(wOnly) && /data-action="bri-ambient"/.test(wOnly) && /17%/.test(wOnly));
  check('ambience off: no square, no slider', !/type="color"|type="range"/.test(RP.ambientRowHtml(lightOff, 'A', false)));

  check('galaxy: bulb icon, sentence case', label(RP.galaxyRowHtml(lightOn, false)) === 'Galaxy projector');

  const cu = RP.curtainRowHtml({ id: 'lounge_curtain', label: 'Lounge Curtain' }, 40, true, false);
  check('curtain: curtain icon + sentence-case title', has(cu, ICONS.curtains) && label(cu) === 'Lounge curtain', label(cu));
  check('curtain closed: the closed-curtain icon', has(RP.curtainRowHtml({ id: 'c', label: 'C' }, 0, true, false), ICONS.curtainsClosed));
  check('curtain: Open / Close are ICON buttons (no text), with hover labels + aria-labels',
    /<button class="row-ib" data-action="curtain-cmd" data-cmd="close"[^>]*aria-label="Close curtain" title="Close"[^>]*><svg/.test(cu)
    && /<button class="row-ib" data-action="curtain-cmd" data-cmd="open"[^>]*aria-label="Open curtain" title="Open"[^>]*><svg/.test(cu)
    && has(cu, ICONS.cOpen) && has(cu, ICONS.cClose) && !/>Open<|>Close</.test(cu), cu);

  const heat = RP.climateRowHtml(onReading(), false, true), idle = RP.climateRowHtml(onReading(), false, false);
  check('temperature: thermometer icon, sentence case', has(idle, ICONS.thermometer) && label(idle) === 'Temperature');
  check('temperature: thermometer orange while heating', /row-ico heat/.test(heat) && !/row-ico heat/.test(idle));

  const mo = RP.motionRowHtml('on');
  check('motion: motion icon, "Motion" (not MOTION)', has(mo, ICONS.motion) && label(mo) === 'Motion' && !/MOTION/.test(mo));
  check('door: door icon by state', has(RP.doorRowHtml({ id: 'd' }, 'on'), ICONS.doorOpen) && has(RP.doorRowHtml({ id: 'd' }, 'off'), ICONS.doorClosed));

  const all = [main, amb, cu, heat, mo, RP.galaxyRowHtml(lightOn, false)].join('');
  check('no ALL-CAPS section headers left', !/control-label">[A-Z ]{4,}</.test(all));

  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  check('index.html: "Strip positions" list is gone (markup, builder and CSS)',
    !/Strip positions/.test(html) && !/stripInfoHtml/.test(html) && !/\.strip-info/.test(html));
  check('index.html: colour square handler does not repaint the row under an open picker',
    /if \(action === 'color-ambient'\) onWrite\(el, 'input', e => \{\s*s\.ambient\.color = e\.target\.value; home\.updateLights\(\); sendToHA\(rid, 'ambient', s\.ambient, 200, true\);\s*\}\);/.test(html));
  check('index.html: brightness value sits after the slider', /el\.nextElementSibling\.textContent = `\$\{s\.ambient\.bri\}%`;/.test(html));
  const src = fs.readFileSync(path.join(root, 'src/tap-popovers.js'), 'utf8');
  check('icons are shared, not copied: tap-popovers has no inline MDI paths', /from '\.\/ui-icons\.js'/.test(src) && !/M12,2A7,7 0 0,0 5,9/.test(src));
}

// ---------------------------------------------------------------------------
// 6. createDragSender against the real callServiceDebounced
// ---------------------------------------------------------------------------
{
  // Commands go over a fake WebSocket (scripts/fake-ha-websocket.mjs):
  // ha-client has no REST path any more, so there is no fetch to mock.
  const fake = installFakeHA();
  const calls = fake.calls;
  try {
    const ha = HAClient.create({ url: 'http://ha.invalid', token: 'x', rooms: {}, sensors: {} });
    ha.connect();
    await fake.whenConnected(ha);
    const motors = ['cover.demo_bedroom_curtain'];
    const sender = RP.createDragSender({
      build: (id, pct) => HAClient.coverPositionCommand(pct, motors),
      dispatch: (cmd, id, delay) => ha.callServiceDebounced(cmd.domain, cmd.service, cmd.data, cmd.target, 'curtain-' + id, delay)
    });
    const positions = () => calls.map(c => c.body.position);

    // (a) drag then release inside the debounce window on the last value.
    sender.input('c', 30); sender.input('c', 40);
    check('drag: lock held while dragging', sender.isDragging('c'));
    await sleep(20);
    sender.commit('c', 40);
    await sleep(260);
    check('release on last debounced value -> ONE send', positions().join() === '40', calls);
    check('release unlocks', !sender.isDragging('c'));

    // (b) release after the window: debounced send already landed, the
    //     release must not send it again.
    calls.length = 0;
    sender.input('c', 55);
    await sleep(260);
    sender.commit('c', 55);
    await sleep(50);
    check('release after window -> still ONE send', positions().join() === '55', calls);

    // (c) a new drag to the value the PREVIOUS drag sent (55) still sends:
    //     the curtain may have been moved by a remote since.
    calls.length = 0;
    sender.input('c', 55);
    sender.commit('c', 55);
    await sleep(260);
    check('new drag to the previous drag value is not deduped away', positions().join() === '55', calls);

    // (d) NaN sends nothing, on input or on release.
    calls.length = 0;
    sender.input('c', NaN); sender.commit('c', NaN);
    await sleep(260);
    check('NaN -> nothing sent', calls.length === 0, calls);

    // (e) a button press cancels a slider send still pending.
    calls.length = 0;
    sender.input('c', 70);
    sender.press('c', HAClient.coverOpenCloseCommand('close', motors));
    await sleep(260);
    check('button cancels the pending slider send', calls.length === 1 && calls[0].service === 'cover/close_cover', calls);
    sender.end('c');

    // (f) the drag lock: end() (pointerup) releases without sending; a drag
    //     that returns to its start value fires no 'change', so pointerup is
    //     the only thing that frees it.
    calls.length = 0;
    sender.input('c', 12);
    sender.end('c');
    check('pointerup releases the lock', !sender.isDragging('c'));
    await sleep(260);
    check('pointerup itself sends nothing extra', positions().join() === '12', calls);
    sender.input('c', 13);
    sender.clear();
    check('clear() (full re-render) releases every lock', !sender.isDragging('c'));
    await sleep(260);
    // A re-render does not swallow the user's own pending value.
    check('clear() leaves the pending user send intact', positions().join() === '12,13', calls);

    // (g) climate: a refused build sends nothing even on release.
    calls.length = 0;
    let reading = HAClient.parseClimate({ state: 'off', attributes: { temperature: null } });
    const cs = RP.createDragSender({
      build: (room, v) => HAClient.climateTargetCommand(v, TRV, reading),
      dispatch: (cmd, room, delay) => ha.callServiceDebounced(cmd.domain, cmd.service, cmd.data, cmd.target, 'climate-' + room, delay)
    });
    cs.input('bedroom', 22); cs.commit('bedroom', 22);
    await sleep(260);
    check('climate off: nothing sent', calls.length === 0, calls);
    reading = onReading();
    cs.input('bedroom', 21.3); cs.input('bedroom', 21.6); cs.commit('bedroom', 21.6);
    await sleep(260);
    check('climate on: one send, step-rounded',
      calls.length === 1 && calls[0].service === 'climate/set_temperature' && calls[0].body.temperature === 21.5, calls);
  } finally {
    fake.restore();
  }
}

// ---------------------------------------------------------------------------
// 7. index.html wiring
// ---------------------------------------------------------------------------
{
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const block = action => {
    const i = html.indexOf("if (action === '" + action + "')");
    return i < 0 ? '' : html.slice(i, html.indexOf('\n          }\n', i));
  };
  const curtain = block('curtain-open');
  const climate = block('climate-target');
  check('index: curtain slider goes through curtainSender.input/commit',
    /curtainSender\.input\(/.test(curtain) && /curtainSender\.commit\(/.test(curtain), curtain.slice(0, 200));
  check('index: curtain pointerup ends the drag (b2d7f49a)', /'pointerup',\s*endDrag/.test(curtain));
  check('index: climate slider goes through climateSender.input/commit',
    /climateSender\.input\(/.test(climate) && /climateSender\.commit\(/.test(climate));
  check('index: climate pointerup ends the drag', /'pointerup',\s*endDrag/.test(climate));
  check('index: no door slider anywhere', !/data-action="door-open"/.test(html) && !/door-use-sensor/.test(html));
  check('index: full re-render clears both drag locks',
    /curtainSender\.clear\(\);\s*climateSender\.clear\(\);\s*panelBody\.innerHTML = html;/.test(html));
  check('index: climate going off/unavailable cancels its pending send',
    /if \(!climateCanTakeTarget\(roomId\)\) climateSender\.cancel\(roomId\);/.test(html));
  check('index: cover going unavailable cancels its pending send',
    /if \(!available\) curtainSender\.cancel\(curtainId\);/.test(html));
  check('index: both debounced sends carry a fire-time guard',
    /'curtain-' \+ curtainId, delayMs,\s*\(\) => curtainIsAvailable\(curtainId\)\)/.test(html) &&
    /'climate-' \+ roomId, delayMs,\s*\(\) => climateCanTakeTarget\(roomId\)\)/.test(html));
  check('index: curtain slider build checks availability',
    /curtainSliderCommand\(HAClient\.coverPositionCommand, pct,\s*curtainEntities\.get\(curtainId\), curtainIsAvailable\(curtainId\)\)/.test(html));
  check('index: a reading held by the lock marks the row dirty (both kinds)',
    /climateSender\.markDirty\(roomId\)/.test(html) && (html.match(/curtainSender\.markDirty\(curtainId\)/g) || []).length === 2);
  check('index: curtain row paints the reported position, not the animated one',
    /const pct = curtainShownPct\(cu\.id\);/.test(html));
  // Four: the two senders, sendToHA's one light call (lightServiceCall picks
  // turn_on / turn_off) and vacuumSend (the robot vacuum block), which is
  // itself gated on haOffline + 'connected'. The room script's confirm sends
  // through the shared sendScript (src/script-call.js), gated likewise --
  // one call site, checked here; its guard is tested in
  // scripts/test-frame-art.mjs and scripts/test-room-script.mjs.
  check('index: no callService outside the senders, sendToHA and vacuumSend',
    (html.match(/ha\.callService(Debounced)?\(/g) || []).length === 4);
  check('index: the only other send is the room script, through sendScript',
    (html.match(/sendScript\(/g) || []).length === 1);
  const vacSend = (html.match(/function vacuumSend\([\s\S]*?\n      \}/) || [''])[0];
  check('index: vacuumSend refuses offline and sends only when connected',
    /if \(!b \|\| haOffline\(ha\)\) return;/.test(vacSend) && /ha\.status === 'connected'/.test(vacSend) &&
    /ha\.callService\(/.test(vacSend), vacSend.slice(0, 200));
}

// ---------------------------------------------------------------------------
// 8. Review round 1 (follow-up 2b96f055): nothing queued reaches a device
//    that went off / unavailable, and a row held by the drag lock is
//    repainted when the lock releases.
// ---------------------------------------------------------------------------
{
  // Commands go over a fake WebSocket (scripts/fake-ha-websocket.mjs):
  // ha-client has no REST path any more, so there is no fetch to mock.
  const fake = installFakeHA();
  const calls = fake.calls;
  try {
    const ha = HAClient.create({ url: 'http://ha.invalid', token: 'x', rooms: {}, sensors: {} });
    ha.connect();
    await fake.whenConnected(ha);
    const hasApi = typeof ha.cancelDebounced === 'function';
    check('HAClient exposes cancelDebounced', hasApi);

    // (a) guard re-checked when the debounced timer FIRES.
    let live = true;
    ha.callServiceDebounced('climate', 'set_temperature', { temperature: 22 }, { entity_id: TRV },
      'climate-g', 200, () => live);
    live = false; // thermostat went off inside the window
    await sleep(260);
    check('debounced send re-checks its guard at fire time and drops', calls.length === 0, calls);

    // The index.html wiring: sender with cancel + guard, exactly as shipped.
    let reading = onReading();
    const canTake = () => !!(reading && reading.available && !reading.off);
    const mk = () => RP.createDragSender({
      build: (room, v) => HAClient.climateTargetCommand(v, TRV, reading),
      dispatch: (cmd, room, delay) => ha.callServiceDebounced(cmd.domain, cmd.service, cmd.data, cmd.target,
        'climate-' + room, delay, canTake),
      cancel: room => { if (hasApi) ha.cancelDebounced('climate-' + room); }
    });

    // (b) thermostat goes off inside the debounce window -> applyClimate
    //     cancels the pending send.
    calls.length = 0;
    let cs = mk();
    cs.input('bedroom', 22);
    reading = HAClient.parseClimate({ state: 'off', attributes: { temperature: null } });
    if (typeof cs.cancel === 'function') cs.cancel('bedroom');
    await sleep(260);
    check('climate: pending set_temperature cancelled when the thermostat goes off', calls.length === 0, calls);

    // (c) release refused by build() cancels the input already queued --
    //     with NO guard, so it is the commit path itself that must cancel.
    calls.length = 0;
    reading = onReading();
    cs = RP.createDragSender({
      build: (room, v) => HAClient.climateTargetCommand(v, TRV, reading),
      dispatch: (cmd, room, delay) => ha.callServiceDebounced(cmd.domain, cmd.service, cmd.data, cmd.target,
        'climate-' + room, delay),
      cancel: room => { if (hasApi) ha.cancelDebounced('climate-' + room); }
    });
    cs.input('bedroom', 23);
    reading = HAClient.parseClimate({ state: 'unavailable', attributes: {} });
    cs.commit('bedroom', 23);
    await sleep(260);
    check('climate: a refused release cancels the queued input send', calls.length === 0, calls);

    // (d) curtains: cover goes unavailable -> pending position send cancelled.
    calls.length = 0;
    let avail = true;
    const motors = ['cover.demo_bedroom_curtain'];
    const curtain = RP.createDragSender({
      build: (id, pct) => (typeof RP.curtainSliderCommand === 'function'
        ? RP.curtainSliderCommand(HAClient.coverPositionCommand, pct, motors, avail)
        : HAClient.coverPositionCommand(pct, motors)),
      dispatch: (cmd, id, delay) => ha.callServiceDebounced(cmd.domain, cmd.service, cmd.data, cmd.target,
        'curtain-' + id, delay),
      cancel: id => { if (hasApi) ha.cancelDebounced('curtain-' + id); }
    });
    curtain.input('c', 30);
    avail = false;
    if (typeof curtain.cancel === 'function') curtain.cancel('c');
    await sleep(260);
    check('curtain: pending position send cancelled when the cover goes unavailable', calls.length === 0, calls);

    // (e) the curtain SLIDER itself refuses while unavailable, like the buttons.
    calls.length = 0;
    curtain.end('c');
    curtain.input('c', 45); curtain.commit('c', 45);
    await sleep(260);
    check('curtain: slider sends nothing while the cover is unavailable', calls.length === 0, calls);
    check('curtainSliderCommand: unavailable / unknown -> null',
      typeof RP.curtainSliderCommand === 'function' &&
      RP.curtainSliderCommand(HAClient.coverPositionCommand, 50, motors, false) === null &&
      RP.curtainSliderCommand(HAClient.coverPositionCommand, 50, motors, null) === null);
    check('curtainSliderCommand: available -> the position command',
      typeof RP.curtainSliderCommand === 'function' &&
      RP.curtainSliderCommand(HAClient.coverPositionCommand, 50, motors, true).data.position === 50);
  } finally {
    fake.restore();
  }

  // (f) a reading held back by the lock is repainted on release.
  const released = [];
  const s = RP.createDragSender({
    build: (id, v) => ({ domain: 'x', service: 'y', data: { v }, target: { entity_id: 'x' } }),
    dispatch: () => {},
    onRelease: (id, wasDirty) => released.push(id + ':' + wasDirty)
  });
  s.input('r', 1);
  if (typeof s.markDirty === 'function') s.markDirty('r');
  s.end('r');
  check('dirty lock -> onRelease(id, true) on pointerup', released.join() === 'r:true', released);
  s.input('r', 2);
  s.commit('r', 2);
  check('clean lock -> onRelease(id, false) on change', released.join() === 'r:true,r:false', released);
  s.end('r');
  check('releasing an unheld lock does not call onRelease again', released.length === 2, released);
  s.input('r', 3);
  if (typeof s.markDirty === 'function') s.markDirty('r');
  s.forget && s.forget('r');
  s.input('r', 4); s.end('r');
  check('forget() (row replaced) drops the dirty flag without a repaint', released[2] === 'r:false', released);
}

// 9. curtainsToRevert (item 349848ef): on going offline, every curtain whose
//    shown value differs from HA's last report goes back to HA's value.
{
  const target = new Map([['a', 30], ['b', 100], ['c', 0], ['d', 55]]);
  const reported = new Map([['a', 100], ['b', 100], ['c', 40], ['e', 70]]);
  const r = RP.curtainsToRevert(target, reported);
  check('curtainsToRevert: a diverged curtain goes back to HA\'s value', r.some(([id, p]) => id === 'a' && p === 100), r);
  check('curtainsToRevert: every diverged curtain, and only those', JSON.stringify(r) === JSON.stringify([['a', 100], ['c', 40]]), r);
  check('curtainsToRevert: a curtain HA never reported is left alone (d)', !r.some(([id]) => id === 'd'), r);
  check('curtainsToRevert: a report with nothing shown is not invented (e)', !r.some(([id]) => id === 'e'), r);
  check('curtainsToRevert: nothing diverged -> []', RP.curtainsToRevert(new Map([['a', 100]]), new Map([['a', 100]])).length === 0);
  check('curtainsToRevert: missing maps -> []', RP.curtainsToRevert(null, reported).length === 0 && RP.curtainsToRevert(target, null).length === 0);
}

if (failures) {
  console.error(failures + ' failed, ' + passes + ' passed');
  process.exit(1);
}
console.log('ok -- ' + passes + ' passed, 0 failed');
