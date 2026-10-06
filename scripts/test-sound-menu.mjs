/**
 * The sound menu (src/sound-model.js, src/sound-menu.js): Now playing /
 * Play on / Sounds, mirroring the wall tablet's ambience pop-up.
 *
 *   node scripts/test-sound-menu.mjs
 *
 * WHAT THIS GUARDS
 *   1. The binding: normaliseSoundMenu keeps a good block, refuses one it
 *      cannot drive, drops a bad speaker, and maps a stray openFrom value to
 *      null.
 *   2. Reading the helpers: the selection, the recents (pairs AND legacy
 *      bare labels), the catalogue, the sound.
 *   3. SOUNDS order, the tablet Jinja's cases: recents first in recent
 *      order, a legacy label still matches, no tile twice, the rest A-Z
 *      (case-insensitively); six per page with NO page cap.
 *   4. NOW PLAYING: only 'playing' speakers, the tapped one first; the
 *      subtitle rule (38 characters); Stop all's visibility.
 *   5. Every command's exact shape: the toggle script, the select, the
 *      transport (volume steps clamp), a slide's Stop (+ 'None' when it was
 *      the last), Stop all (None + the speakers the automation cannot reach).
 *   6. The two races (plan review #1, #2): a tap on the SELECTED sound
 *      re-triggers it ('None', then the label once the stop has landed or
 *      after a timeout); the tiles are busy until the speakers report.
 *   7. End to end against the fake Home Assistant: nothing is sent on open or
 *      render; each tap sends exactly its command; offline sends nothing;
 *      the client records the menu's entities and announces their changes
 *      (not a media_position tick).
 *   8. Mock mode (no HA configured, the demo): taps move the sample and
 *      nothing is sent anywhere.
 *   9. The safety rule is mechanical (plan review #6): the fake refuses a
 *      socket to anything but its own .invalid host, and so does the runtime
 *      WebSocket whenever the fake is not installed.
 *  10. Tap routing: an openFrom item opens the menu (over an item card on the
 *      same id; a vacuum or plant still wins), and the page wiring.
 *
 * Fake Home Assistant only (scripts/fake-ha-websocket.mjs): never a real one.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { installFakeHA, isFakeHaUrl, RefusedWebSocket } from './fake-ha-websocket.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const imp = rel => import(pathToFileURL(path.join(root, rel)).href);
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');

let passes = 0, failures = 0;
function check(name, ok, detail) {
  if (ok) { passes++; console.log('  ok   ' + name); }
  else { failures++; console.error('  FAIL ' + name + (detail !== undefined ? '\n       ' + JSON.stringify(detail) : '')); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const J = v => JSON.stringify(v);

// Before ANY fake is installed: importing the fake already made the runtime's
// WebSocket the refusing one (checked again after install / restore in 9).
const refusingFromImport = globalThis.WebSocket === RefusedWebSocket;
const M = await imp('src/sound-model.js');
const { HAClient } = await imp('src/ha-client.js');
const { sendScript } = await imp('src/script-call.js');
const T = await imp('src/tap-popovers.js');

// Every id is a demo_ one (scripts/check-no-pii.sh); built, never a quoted literal list.
const SEL = 'input_text.demo_ambience_speakers', SCRIPT = 'script.demo_toggle_ambience_speaker';
const SOUND = 'input_select.demo_relaxing_sound', CAT = 'sensor.demo_ambience_sounds', RECENT = 'input_text.demo_ambience_recent';
const BED = 'media_player.demo_bedroom_speaker', LOUNGE = 'media_player.demo_lounge_speaker', STUDY = 'media_player.demo_study_speaker';
const RAW = {
  selection: SEL, toggleScript: SCRIPT, sound: SOUND, catalogue: CAT, recent: RECENT,
  speakers: [{ entity: BED, label: 'Bedroom' }, { entity: LOUNGE, label: 'Lounge' }, { entity: STUDY, label: 'Study' }],
  openFrom: { lounge_speaker: LOUNGE, bedroom_speaker: BED, hall_shelf: null },
};
const cfg = M.normaliseSoundMenu(RAW);
const st = (state, attributes) => ({ state, attributes: attributes || {} });

// ---- 1. the binding ----------------------------------------------------------------------
console.log('1. the binding');
{
  check('a full block normalises', !!cfg && cfg.speakers.length === 3 && cfg.recent === RECENT && cfg.openFrom.get('lounge_speaker') === LOUNGE);
  check('openFrom null is kept (opens with no speaker highlighted)', cfg.openFrom.has('hall_shelf') && cfg.openFrom.get('hall_shelf') === null);
  check('the demo house block normalises', !!M.normaliseSoundMenu(JSON.parse(read('houses/demo/rooms.json')).sensors.soundMenu));
  for (const k of ['selection', 'toggleScript', 'sound', 'catalogue']) {
    check('missing ' + k + ' -> null', M.normaliseSoundMenu(Object.assign({}, RAW, { [k]: undefined })) === null);
  }
  check('a helper of the wrong domain -> null', M.normaliseSoundMenu(Object.assign({}, RAW, { sound: 'input_text.demo_x' })) === null);
  check('no valid speaker -> null', M.normaliseSoundMenu(Object.assign({}, RAW, { speakers: [{ entity: 'light.demo_x' }] })) === null);
  const n = M.normaliseSoundMenu(Object.assign({}, RAW, { speakers: [{ entity: BED }, { entity: 'switch.demo_x' }, { entity: BED, label: 'Again' }],
    openFrom: { a: LOUNGE, 'Bad Id': BED } }));
  check('a wrong-domain speaker and a duplicate are dropped; no label -> the object id', n.speakers.length === 1 && n.speakers[0].label === 'demo_bedroom_speaker', n.speakers);
  check('an openFrom value that is not a speaker -> null; a bad item id is dropped', n.openFrom.get('a') === null && !n.openFrom.has('Bad Id'));
  check('recent is optional', M.normaliseSoundMenu(Object.assign({}, RAW, { recent: undefined })).recent === null);
  check('soundMenuEntities: helpers, catalogue, recent and every speaker', J(M.soundMenuEntities(cfg)) === J([SEL, SOUND, CAT, RECENT, BED, LOUNGE, STUDY]));
}

// ---- 2. reading the helpers ----------------------------------------------------------------
console.log('2. reading the helpers');
{
  check('selection: a JSON list', J(M.parseSelection(st(J([BED, LOUNGE])))) === J([BED, LOUNGE]));
  check('selection: garbage / unknown -> []', M.parseSelection(st('not json')).length === 0 && M.parseSelection(st('unknown')).length === 0 && M.parseSelection(null).length === 0);
  check('recents: pairs -> their ids', J(M.parseRecentIds(st(J([['rain', 'AB'], ['fan', 'A']])))) === '["rain","fan"]');
  check('recents: a legacy bare label is kept', J(M.parseRecentIds(st(J([['rain', 'A'], 'Ocean'])))) === '["rain","Ocean"]');
  check('recents: garbage -> []', M.parseRecentIds(st('{')).length === 0);
  const tiles = M.catalogueTiles(st('3', { tiles: [{ id: 'a', label: 'A', icon: 'mdi:fire' }, { id: 'b', label: 'B' }, { label: 'no id' }, 'x'] }));
  check('catalogue: malformed tiles dropped; a missing icon -> music-note', tiles.length === 2 && tiles[1].icon === 'mdi:music-note');
  check('sound: the option, None, and null while unknown', M.currentSound(st('Rain')) === 'Rain' && M.currentSound(st('None')) === 'None' &&
    M.currentSound(st('unavailable')) === null && M.currentSound(null) === null);
}

// ---- 3. SOUNDS order ----------------------------------------------------------------------
console.log('3. SOUNDS: recents first, then A-Z; six per page, no cap');
{
  const t = (id, label) => ({ id, label, icon: 'mdi:music-note' });
  const TILES = [t('zz', 'Zebra'), t('rain', 'Rain'), t('fan', 'fan'), t('ocean', 'Ocean'), t('brook', 'Brook'), t('cave', 'cave')];
  const ids = l => l.map(x => x.id).join();
  check('no recents: A-Z, case-insensitive (as Jinja sort is)', ids(M.orderSounds(TILES, [])) === 'brook,cave,fan,ocean,rain,zz', ids(M.orderSounds(TILES, [])));
  check('recents first, in recent order', ids(M.orderSounds(TILES, ['ocean', 'fan'])) === 'ocean,fan,brook,cave,rain,zz');
  check('a legacy bare label matches its tile', ids(M.orderSounds(TILES, ['Rain', 'fan'])) === 'rain,fan,brook,cave,ocean,zz');
  check('dedupe: an id twice, or by id and by label, appears once', ids(M.orderSounds(TILES, ['rain', 'Rain', 'rain'])) === 'rain,brook,cave,fan,ocean,zz');
  check('an unknown recent id is ignored', ids(M.orderSounds(TILES, ['gone', 'cave'])) === 'cave,brook,fan,ocean,rain,zz');
  const n19 = Array.from({ length: 19 }, (_, i) => t('s' + i, 'S' + String(i).padStart(2, '0')));
  check('19 sounds -> pages of 6, 6, 6, 1', J(M.pageSounds(n19).map(p => p.length)) === '[6,6,6,1]');
  check('25 sounds -> 5 pages (no fixed page cap)', M.pageSounds(n19.concat(n19.slice(0, 6))).length === 5);
  check('no sounds -> no pages', M.pageSounds([]).length === 0);
}

// ---- 4. NOW PLAYING ------------------------------------------------------------------------
console.log('4. NOW PLAYING');
{
  const states = new Map([[BED, st('playing', { media_title: 'Rain', volume_level: 0.25 })], [LOUNGE, st('paused')], [STUDY, st('playing', { volume_level: 0.4 })]]);
  const rawOf = e => states.get(e) || null;
  const s = M.nowPlaying(cfg, rawOf, 'Rain', null);
  check('only playing speakers, in configured order', s.map(x => x.entity).join() === [BED, STUDY].join());
  check('the tapped speaker is first (its slide is the initial one)', M.nowPlaying(cfg, rawOf, 'Rain', STUDY)[0].entity === STUDY && M.nowPlaying(cfg, rawOf, 'Rain', STUDY)[0].tapped);
  check('volume as a percentage, -- when none', s[0].volumeText === '25%' && M.nowPlaying(cfg, e => (e === BED ? st('playing') : null), 'None', null)[0].volumeText === '--');
  check('subtitle: media_title first', s[0].title === 'Rain');
  check('subtitle: else the selected sound', s[1].title === 'Rain');
  const long = 'x'.repeat(40);
  check('subtitle: cut to 38 with an ellipsis', M.slideTitle(st('playing', { media_title: long }), 'None') === 'x'.repeat(37) + '…');
  check('subtitle: media_content_id when there is no title', M.slideTitle(st('playing', { media_content_id: 'track/a' }), 'None') === 'track/a');
  check('subtitle: Playing when nothing else', M.slideTitle(st('playing'), 'None') === 'Playing');
  check('Stop all: shown for a selected sound with nothing playing (the tablet rule)', M.stopAllVisible('Rain', []) === true);
  check('Stop all: shown when a speaker plays with no sound selected (a superset)', M.stopAllVisible('None', [{}]) === true);
  check('Stop all: hidden when nothing is selected or playing', M.stopAllVisible('None', []) === false && M.stopAllVisible(null, []) === false);
  const rows = M.speakerRows(cfg, [LOUNGE], LOUNGE);
  check('PLAY ON: the tapped speaker is first and tagged; selected follows the helper', rows[0].entity === LOUNGE && rows[0].tapped && rows[0].selected &&
    rows.slice(1).every(r => !r.tapped && !r.selected));
  check('PLAY ON: no tapped speaker -> configured order', M.speakerRows(cfg, [], null).map(r => r.entity).join() === [BED, LOUNGE, STUDY].join());
}

// ---- 5. commands ---------------------------------------------------------------------------
console.log('5. commands');
{
  check('toggle: script.turn_on on the toggle script, variables { entity_id }', J(M.toggleSpeakerCommand(cfg, LOUNGE)) ===
    J({ domain: 'script', service: 'turn_on', data: { variables: { entity_id: LOUNGE } }, target: { entity_id: SCRIPT } }));
  check('sound: input_select.select_option { option: label } on the sound helper', J(M.selectSoundCommand(cfg, 'Rain')) ===
    J({ domain: 'input_select', service: 'select_option', data: { option: 'Rain' }, target: { entity_id: SOUND } }));
  const vol = (a, v) => M.transportCommand(BED, a, st('playing', { volume_level: v })).data.volume_level;
  check('volume +/- 0.05, rounded', vol('volUp', 0.25) === 0.3 && vol('volDown', 0.25) === 0.2);
  check('volume clamps to 0..1', vol('volDown', 0.02) === 0 && vol('volUp', 0.98) === 1);
  check('volume with none reported steps from 0.25', M.transportCommand(BED, 'volUp', st('playing')).data.volume_level === 0.3);
  check('prev / next / play-pause on that speaker', ['prev', 'next', 'playPause'].map(a => M.transportCommand(BED, a, null).service).join() ===
    'media_previous_track,media_next_track,media_play_pause' && M.transportCommand(BED, 'next', null).target.entity_id === BED);
  check('an unknown action -> null', M.transportCommand(BED, 'eject', null) === null);
  const two = [{ entity: BED }, { entity: STUDY }];
  check('slide Stop: media_stop on THAT speaker only, while another still plays', J(M.slideStopCommands(cfg, BED, two, 'Rain')) ===
    J([{ domain: 'media_player', service: 'media_stop', data: {}, target: { entity_id: BED } }]));
  check('slide Stop of the LAST playing speaker with a sound selected: + select None', M.slideStopCommands(cfg, BED, [{ entity: BED }], 'Rain').map(c => c.service + ':' + (c.data.option || '')).join() ===
    'media_stop:,select_option:None');
  check('... but not when no sound is selected', M.slideStopCommands(cfg, BED, [{ entity: BED }], 'None').length === 1);
  const all = M.stopAllCommands(cfg, 'Rain', [BED], [{ entity: BED }, { entity: STUDY }]);
  check('Stop all, a sound selected: None, plus media_stop on a playing speaker OUTSIDE the selection',
    all.length === 2 && all[0].data.option === 'None' && all[1].service === 'media_stop' && all[1].target.entity_id === STUDY, all);
  const none = M.stopAllCommands(cfg, 'None', [BED], [{ entity: BED }, { entity: STUDY }]);
  check('Stop all, no sound selected: media_stop on every playing speaker, no select', none.length === 2 && none.every(c => c.service === 'media_stop'));
  check('toggledSelection: add; remove; never the last (the script\'s min-1)', J(M.toggledSelection([BED], LOUNGE)) === J([BED, LOUNGE]) &&
    J(M.toggledSelection([BED, LOUNGE], BED)) === J([LOUNGE]) && J(M.toggledSelection([BED], BED)) === J([BED]));
  // A LOCAL sound is never played by the app: play_media is built in ONE
  // place, spotifyPlayCommands (and read by the demo's sample reducer), and
  // section 7 asserts no sound tap ever sends it.
  const code = read('src/sound-model.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  check('play_media is built only by spotifyPlayCommands', (code.match(/service: 'play_media'/g) || []).length === 1 &&
    /export function spotifyPlayCommands[\s\S]{0,400}service: 'play_media'/.test(code) && !/play_media/.test(read('src/sound-menu.js')));
}

// ---- 6. the races ---------------------------------------------------------------------------
console.log('6. re-tap and the busy window');
{
  check('a different sound: one select', J(M.soundTapPlan('Fan', 'Rain')) === J({ retrigger: false, first: 'Fan', then: null }));
  check('the SELECTED sound: re-trigger -- None, then the label', J(M.soundTapPlan('Rain', 'Rain')) === J({ retrigger: true, first: 'None', then: 'Rain' }));
  check('from None or unknown: one select', !M.soundTapPlan('Rain', 'None').retrigger && !M.soundTapPlan('Rain', null).retrigger);
  const playing = e => st(e === BED ? 'playing' : 'idle');
  const idle = () => st('idle');
  const G = M.RETRIGGER_GAP_MS, X = M.RETRIGGER_MAX_MS;
  check('re-trigger waits: not before the gap', !M.retriggerReady(0, G - 1, 'None', [BED], idle));
  check('re-trigger waits: not until the sound reads None', !M.retriggerReady(0, G, 'Rain', [BED], idle));
  check('re-trigger waits: not while a selected speaker still plays', !M.retriggerReady(0, G, 'None', [BED], playing));
  check('re-trigger goes: None landed, speakers stopped, gap passed', M.retriggerReady(0, G, 'None', [BED], idle));
  check('re-trigger goes at the timeout when None landed but a speaker never reports stopped', M.retriggerReady(0, X, 'None', [BED], playing) &&
    M.stopLanded(0, X, 'None', [BED], playing) === 'ready');
  check('re-trigger ABORTS at the timeout when the helper reads another sound (a53a59ba)', !M.retriggerReady(0, X, 'Ocean', [BED], idle) &&
    M.stopLanded(0, X, 'Ocean', [BED], idle) === 'abort' && M.stopLanded(0, X, 'Rain', [BED], playing) === 'abort' && M.stopLanded(0, X, null, [], idle) === 'abort');
  check('stopLanded waits until then', M.stopLanded(0, X - 1, 'Rain', [BED], idle) === 'wait' && M.stopLanded(0, G, 'None', [BED], idle) === 'ready');
  check('settled: the sound reads the target and every selected speaker plays', M.soundSettled('Rain', 'Rain', [BED], playing) &&
    !M.soundSettled('Rain', 'Rain', [BED, STUDY], playing) && !M.soundSettled('Rain', 'Fan', [BED], playing));
  check('settled for None: nothing selected plays', M.soundSettled('None', 'None', [STUDY], playing) && !M.soundSettled('None', 'None', [BED], playing));
  const B0 = { since: 0 };
  check('busy: always for BUSY_MIN_MS, even if settled', M.isBusy(B0, M.BUSY_MIN_MS - 1, true));
  check('busy: then until settled', M.isBusy(B0, M.BUSY_MIN_MS, false) && !M.isBusy(B0, M.BUSY_MIN_MS, true));
  check('busy: never past BUSY_MAX_MS', !M.isBusy(B0, M.BUSY_MAX_MS, false) && !M.isBusy(null, 0, false));
}

// ---- 7. end to end against the fake Home Assistant ---------------------------------------
console.log('7. against the fake Home Assistant');
const TILES = [{ id: 'rain', label: 'Rain', icon: 'mdi:weather-rainy' }, { id: 'fan', label: 'Fan', icon: 'mdi:fan' }, { id: 'ocean', label: 'Ocean', icon: 'mdi:waves' }];
const haStates = () => [
  { entity_id: SEL, state: J([BED]), attributes: {} },
  { entity_id: SOUND, state: 'Rain', attributes: {} },
  { entity_id: CAT, state: '3', attributes: { tiles: TILES } },
  { entity_id: RECENT, state: J([['fan', 'A']]), attributes: {} },
  { entity_id: BED, state: 'playing', attributes: { media_title: 'Rain', volume_level: 0.25, media_position: 1 } },
  { entity_id: LOUNGE, state: 'idle', attributes: {} },
  { entity_id: STUDY, state: 'playing', attributes: { media_title: 'Other', volume_level: 0.5 } },
  { entity_id: 'media_player.demo_unrelated', state: 'playing', attributes: {} },
];
{
  const fake = installFakeHA({ states: haStates() });
  const realLog = console.log; console.log = (...a) => { if (/^\s+(ok|FAIL)/.test(String(a[0]))) realLog(...a); };
  try {
    const ha = HAClient.create({ url: 'http://ha.invalid', token: 't', rooms: {}, sensors: { soundMenu: RAW } });
    const changes = [];
    ha.onSoundMenuChange((e, raw) => changes.push(e + '=' + raw.state));
    ha.connect();
    await fake.whenConnected(ha);
    check('the client records the menu\'s entities', ha.getRawState(SEL) && ha.getRawState(CAT).attributes.tiles.length === 3 && ha.getRawState(STUDY).state === 'playing');
    check('... and nothing it was not asked to', ha.getRawState('media_player.demo_unrelated') === null);
    check('the snapshot announces each menu entity once', changes.length === 7, changes);
    const ws = fake.sockets[0];
    changes.length = 0;
    ws.emitStateChanged({ entity_id: BED, state: 'playing', attributes: { media_title: 'Rain', volume_level: 0.25, media_position: 9 } });
    await sleep(5);
    check('a media_position tick is NOT announced', changes.length === 0, changes);
    ws.emitStateChanged({ entity_id: BED, state: 'playing', attributes: { media_title: 'Rain', volume_level: 0.3, media_position: 10 } });
    await sleep(5);
    check('a volume change IS announced', J(changes) === J([BED + '=playing']), changes);

    let t = 10000;
    const ctl = M.createSoundController({ cfg, getHa: () => ha, sendScript, now: () => t });
    ctl.setTapped(LOUNGE);
    const m = ctl.model();
    check('open + render sends NOTHING', fake.calls.length === 0 && m.live && m.statusKey === 'ok', fake.calls);
    check('the model: Rain selected, two slides, the tapped speaker first in PLAY ON, recents first in SOUNDS',
      m.sound === 'Rain' && m.slides.length === 2 && m.rows[0].entity === LOUNGE && m.pages[0].map(x => x.id).join() === 'fan,ocean,rain', m);

    // PLAY ON
    check('PLAY ON tap -> true', ctl.tap('spk', LOUNGE) === true);
    await sleep(5);
    check('... sends exactly script.turn_on { variables: { entity_id } } to the toggle script', fake.calls.length === 1 &&
      fake.calls[0].service === 'script/turn_on' && J(fake.calls[0].msg.service_data) === J({ variables: { entity_id: LOUNGE } }) &&
      fake.calls[0].msg.target.entity_id === SCRIPT, fake.calls);
    check('... and the row shows selected before the echo (optimistic)', ctl.model().rows.find(r => r.entity === LOUNGE).selected);
    check('a speaker that is not configured is refused', ctl.tap('spk', 'media_player.demo_unrelated') === false && fake.calls.length === 1);
    ws.emitStateChanged({ entity_id: SEL, state: J([BED, LOUNGE]), attributes: {} });
    await sleep(5);

    // SOUNDS: a different sound
    fake.calls.length = 0;
    check('SOUNDS tap (a different sound) -> one select', ctl.tap('snd', 'Fan') === true);
    await sleep(5);
    check('... exactly input_select.select_option { option: "Fan" }', fake.calls.length === 1 && fake.calls[0].service === 'input_select/select_option' &&
      J(fake.calls[0].msg.service_data) === J({ option: 'Fan' }) && fake.calls[0].msg.target.entity_id === SOUND, fake.calls);
    check('... the tiles are busy, the tapped one pending', J(ctl.model().busy) === J({ target: 'Fan' }));
    check('a second sound tap while busy is DROPPED (the automation is mode: single)', ctl.tap('snd', 'Ocean') === false && fake.calls.length === 1);
    ws.emitStateChanged({ entity_id: SOUND, state: 'Fan', attributes: {} });
    ws.emitStateChanged({ entity_id: BED, state: 'playing', attributes: { media_title: 'Fan', volume_level: 0.25 } });
    await sleep(5);
    check('still busy before BUSY_MIN_MS even once settled... ', ctl.model().busy !== null);
    t += M.BUSY_MIN_MS - 1;
    check('... still busy: the lounge (selected) has not reported playing', ctl.model().busy !== null);
    ws.emitStateChanged({ entity_id: LOUNGE, state: 'playing', attributes: { media_title: 'Fan', volume_level: 0.25 } });
    await sleep(5);
    t += 1;
    check('... free once every selected speaker reports', ctl.model().busy === null);

    // SOUNDS: the SELECTED sound re-triggers
    fake.calls.length = 0;
    check('SOUNDS tap on the SELECTED sound -> true', ctl.tap('snd', 'Fan') === true);
    await sleep(5);
    check('... first selects None', fake.calls.length === 1 && fake.calls[0].msg.service_data.option === 'None', fake.calls);
    check('... the tile stays busy on the label', J(ctl.model().busy) === J({ target: 'Fan' }) && ctl.pendingRetrigger());
    t += M.RETRIGGER_GAP_MS;
    check('... nothing more before None has landed', ctl.tick() === false && fake.calls.length === 1);
    ws.emitStateChanged({ entity_id: SOUND, state: 'None', attributes: {} });
    await sleep(5);
    check('... nothing more while the speakers still play', ctl.tick() === false && fake.calls.length === 1);
    ws.emitStateChanged({ entity_id: BED, state: 'idle', attributes: {} });
    ws.emitStateChanged({ entity_id: LOUNGE, state: 'idle', attributes: {} });
    await sleep(5);
    check('... then the label again, once', ctl.tick() === true && ctl.tick() === false);
    await sleep(5);
    check('... so the calls are exactly [None, Fan]', fake.calls.map(c => c.msg.service_data.option).join() === 'None,Fan', fake.calls);

    // None lands but a speaker never reports stopped: the label goes at the timeout.
    ws.emitStateChanged({ entity_id: SOUND, state: 'Fan', attributes: {} });
    ws.emitStateChanged({ entity_id: BED, state: 'playing', attributes: { media_title: 'Fan' } });
    ws.emitStateChanged({ entity_id: LOUNGE, state: 'playing', attributes: { media_title: 'Fan' } });
    await sleep(5);
    t += M.BUSY_MAX_MS;
    ctl.model();
    fake.calls.length = 0;
    ctl.tap('snd', 'Fan');
    ws.emitStateChanged({ entity_id: SOUND, state: 'None', attributes: {} });
    await sleep(5);
    t += M.RETRIGGER_MAX_MS - 1;
    check('timeout re-trigger: held until RETRIGGER_MAX_MS', ctl.tick() === false);
    t += 1;
    check('... then sent, the helper reading None', ctl.tick() === true);
    await sleep(5);
    check('... [None, Fan]', fake.calls.map(c => c.msg.service_data.option).join() === 'None,Fan', fake.calls);

    // The tablet picks another sound before our None lands: the re-trigger
    // ABORTS rather than overriding it (a53a59ba).
    ws.emitStateChanged({ entity_id: SOUND, state: 'Fan', attributes: {} });
    await sleep(5);
    t += M.BUSY_MAX_MS;
    ctl.model();
    fake.calls.length = 0;
    ctl.tap('snd', 'Fan');
    ws.emitStateChanged({ entity_id: SOUND, state: 'Ocean', attributes: {} });
    await sleep(5);
    t += M.RETRIGGER_MAX_MS;
    check('re-trigger overridden elsewhere: nothing more is sent', ctl.tick() === false && !ctl.pendingRetrigger());
    await sleep(5);
    check('... only the None went out, and the tiles are free again', fake.calls.map(c => c.msg.service_data.option).join() === 'None' && ctl.model().busy === null, fake.calls);
    ws.emitStateChanged({ entity_id: SOUND, state: 'Fan', attributes: {} });
    await sleep(5);
    t += M.BUSY_MAX_MS;

    // NOW PLAYING
    fake.calls.length = 0;
    ctl.tap('volUp', BED);
    ctl.tap('next', STUDY);
    await sleep(5);
    check('transport: volume_set and next on the slide\'s own speaker', fake.calls.map(c => c.service + '>' + c.msg.target.entity_id).join() ===
      ['media_player/volume_set>' + BED, 'media_player/media_next_track>' + STUDY].join(), fake.calls.map(c => c.service));
    fake.calls.length = 0;
    ctl.tap('stopAll');
    await sleep(5);
    check('Stop all: None, plus media_stop on the study (playing, not selected)', fake.calls.map(c => c.service + ':' + (c.msg.service_data.option || c.msg.target.entity_id)).join() ===
      'input_select/select_option:None,media_player/media_stop:' + STUDY, fake.calls.map(c => c.service));
    check('... and the tiles are busy stopping', J(ctl.model().busy) === J({ target: 'None' }));

    // Offline: nothing at all.
    t += M.BUSY_MAX_MS;
    ha.disconnect();
    fake.calls.length = 0;
    const off = ctl.model();
    check('offline: the model says so and is not live', off.statusKey === 'haOffline' && off.live === false);
    check('offline: every tap is refused and nothing is sent', ['spk', 'snd', 'stopAll', 'stop', 'volUp', 'playPause'].every(a => ctl.tap(a, a === 'snd' ? 'Ocean' : BED) === false) &&
      fake.calls.length === 0);
    check('no fetch, ever', fake.fetches.length === 0);
    check('no sound / speaker / transport tap ever sent play_media', !fake.sent.some(x => x.service === 'play_media'));
  } finally {
    console.log = realLog;
    fake.restore();
  }
}
{
  // A client with NO soundMenu block records none of it.
  const fake = installFakeHA({ states: haStates() });
  const realLog = console.log; console.log = () => {};
  try {
    const ha = HAClient.create({ url: 'http://ha.invalid', token: 't', rooms: {}, sensors: {} });
    ha.connect();
    await fake.whenConnected(ha);
    console.log = realLog;
    check('no soundMenu binding: none of its entities are recorded', ha.getRawState(SEL) === null && ha.getRawState(BED) === null);
    ha.disconnect();
  } finally { console.log = realLog; fake.restore(); }
}

// ---- 8. mock mode ---------------------------------------------------------------------------
console.log('8. mock mode (no Home Assistant configured)');
{
  const fake = installFakeHA();   // installed only to SEE that nothing reaches it
  try {
    let t = 0;
    const ctl = M.createSoundController({ cfg, getHa: () => null, sendScript, now: () => t });
    const m0 = ctl.model();
    check('the sample: live (mock), Rain on the first speaker, a full catalogue', m0.statusKey === 'mock' && m0.live && m0.sound === 'Rain' &&
      m0.slides.length === 1 && m0.slides[0].entity === BED && m0.pages.length === 3, m0.statusKey);
    check('the sample\'s recents lead SOUNDS', m0.pages[0].slice(0, 3).map(x => x.id).join() === 'rain,fan,ocean');
    ctl.tap('spk', LOUNGE);
    check('a speaker tap moves the sample', ctl.model().rows.find(r => r.entity === LOUNGE).selected);
    ctl.tap('spk', LOUNGE); ctl.tap('spk', BED);
    check('... and keeps at least one selected', ctl.model().rows.find(r => r.entity === BED).selected);
    ctl.tap('snd', 'Fan');
    const m1 = ctl.model();
    check('a sound tap plays it on the selected speaker in the sample', m1.sound === 'Fan' && m1.slides[0].title === 'Fan');
    t += M.BUSY_MIN_MS;
    check('... and the sample settles the busy window', ctl.model().busy === null);
    ctl.tap('snd', 'Fan');
    check('a re-tap in the sample: None first', ctl.model().sound === 'None' && ctl.pendingRetrigger());
    t += M.RETRIGGER_GAP_MS; ctl.tick();
    check('... then Fan again', ctl.model().sound === 'Fan' && !ctl.pendingRetrigger());
    ctl.tap('stopAll');
    check('Stop all in the sample: nothing playing', ctl.model().slides.length === 0 && ctl.model().sound === 'None');
    check('every sample command is marked mock', ctl.sent().length > 0 && ctl.sent().every(c => c.mock === true));
    check('NOTHING reached Home Assistant: no socket, no call, no fetch', fake.sockets.length === 0 && fake.calls.length === 0 && fake.fetches.length === 0);
    // Lounge joins the selection while Rain plays on the bedroom only: a
    // select of Rain again must NOT start the lounge (no state change, so HA's
    // automation never fires) -- the reason a re-tap has to re-trigger.
    const s0 = M.applyMockCommand(cfg, M.mockSoundStates(cfg), M.toggleSpeakerCommand(cfg, LOUNGE));
    const same = M.applyMockCommand(cfg, s0, M.selectSoundCommand(cfg, 'Rain'));
    check('selecting the sound that is already selected changes nothing (HA fires nothing)', J([...same]) === J([...s0]) && same.get(LOUNGE).state === 'idle');
  } finally { fake.restore(); }
}

// ---- 9. the safety rule is mechanical ----------------------------------------------------------
console.log('9. no real Home Assistant, mechanically');
{
  check('isFakeHaUrl: only a .invalid host', isFakeHaUrl('ws://ha.invalid/api/websocket') && isFakeHaUrl('wss://x.invalid/') &&
    !isFakeHaUrl('ws://homeassistant.local:8123/api/websocket') && !isFakeHaUrl('ws://192.0.2.10:8123/api/websocket') &&
    !isFakeHaUrl('ws://ha.invalid.example.com/') && !isFakeHaUrl('http://ha.invalid') && !isFakeHaUrl('nonsense'));
  const throws = fn => { try { fn(); return false; } catch (e) { return /refused a WebSocket/.test(e.message); } };
  check('importing the fake, before any install, already refuses real sockets', refusingFromImport);
  check('the fake not installed: the runtime WebSocket refuses every URL', globalThis.WebSocket === RefusedWebSocket &&
    throws(() => new WebSocket('ws://homeassistant.local:8123/api/websocket')) && throws(() => new WebSocket('ws://ha.invalid/api/websocket')));
  const fake = installFakeHA();
  const realLog = console.log, realWarn = console.warn; console.log = () => {}; console.warn = () => {};
  try {
    check('the fake installed: a socket to a real-looking host throws', throws(() => new WebSocket('ws://homeassistant.local:8123/api/websocket')));
    let threw = false;
    const ha = HAClient.create({ url: 'http://homeassistant.local:8123', token: 't', rooms: {}, sensors: { soundMenu: RAW } });
    try { ha.connect(); } catch (e) { threw = /refused/.test(e.message); }
    await sleep(10);
    check('a client pointed anywhere but the fake never gets a socket', threw && fake.sockets.length === 0 && ha.status !== 'connected');
    ha.disconnect();
  } finally { console.log = realLog; console.warn = realWarn; fake.restore(); }
  check('restore() puts the REFUSING WebSocket back, not the real one', globalThis.WebSocket === RefusedWebSocket);
}

// ---- 10. tap routing and page wiring --------------------------------------------------------------
console.log('10. an openFrom item opens the menu');
{
  const obj = { name: 'mesh' };
  const { normaliseItemBindings } = await imp('src/item-cards.js');
  const items = normaliseItemBindings({ lounge_speaker: { media: [{ entity: LOUNGE }] }, shelf: { media: [{ entity: LOUNGE }] } });
  const vac = new Map([['bedroom_speaker', { entity: 'vacuum.demo_x' }]]);
  const ctx = { items, vacuums: vac, plants: new Map(), climate: {}, soundOpenFrom: cfg.openFrom };
  const at = it => T.furnitureTarget(it, { x: 0, y: 0, z: 0 }, obj, ctx);
  const t1 = at({ id: 'lounge_speaker', type: 'box' });
  check('an openFrom item -> a soundMenu target carrying its speaker', t1 && t1.kind === 'soundMenu' && t1.itemId === 'lounge_speaker' && t1.speaker === LOUNGE, t1);
  check('... it wins over an item card on the same id', t1.kind === 'soundMenu');
  check('... a vacuum binding still wins over it', at({ id: 'bedroom_speaker', type: 'box' }).kind === 'vacuum');
  check('... openFrom null: the menu with no speaker', at({ id: 'hall_shelf', type: 'box' }).speaker === null);
  check('... an item NOT in openFrom keeps its card', at({ id: 'shelf', type: 'box' }).kind === 'item');
  check('... with no sound menu on the page, the card again', T.furnitureTarget({ id: 'lounge_speaker', type: 'box' }, { x: 0, y: 0, z: 0 }, obj,
    Object.assign({}, ctx, { soundOpenFrom: null })).kind === 'item');
  const tp = read('src/tap-popovers.js');
  check('tap-popovers: openFrom items are tappable', /\.\.\.\(soundOpenFrom \? soundOpenFrom\.keys\(\) : \[\]\)/.test(tp));
  // Since the focus contract (scripts/test-tap-focus-contract.mjs): a soundMenu
  // tap is a ROUTE like any other -- the camera flies to the speaker first.
  check('tap-popovers: a soundMenu tap is a dispatcher route that opens the menu (after the flight)',
    /kind: 'soundMenu',[\s\S]{0,400}d\.soundMenu\.open\(\{ itemId: t\.itemId, speaker: t\.speaker, onClose: why => d\.onClose\(t, why\) \}\);/.test(tp) &&
    !/kind: 'soundMenu',[^}]*focus: false/.test(tp));
  const page = read('index.html');
  check('index: imports createSoundMenu', /import \{ createSoundMenu \} from '\.\/src\/sound-menu\.js\?v=__VERSION__';/.test(page));
  check('index: builds it from sensors.soundMenu, closing any card on open', /createSoundMenu\(\{\s*soundMenu: sensors && sensors\.soundMenu, getHa: \(\) => ha,[\s\S]{0,160}onOpen: \(\) => \{ if \(tapPopovers && tapPopovers\.isOpen\(\)\) tapPopovers\.close\(\); \}/.test(page));
  check('index: hands it to the tap popovers', /getHa: \(\) => ha, HAClient, soundMenu,/.test(page));
  const sm = read('src/sound-menu.js');
  check('modal: swallows pointer, touch and click input at its root', /const SWALLOW = \[[^\]]*'pointerdown'[^\]]*'pointermove'[^\]]*'click'[^\]]*'touchstart'/.test(sm) &&
    /SWALLOW\.forEach\(ev => root\.addEventListener\(ev, swallow\)\)/.test(sm));
  check('modal: swallows the wheel (and blocks it outside the scrolling body)', /root\.addEventListener\('wheel', onWheel, \{ passive: false \}\)/.test(sm) &&
    /e\.stopPropagation\(\);\s*\/\/[^\n]*\n[^\n]*\n\s*if \(!\(body && body\.contains\(e\.target\)\)\) e\.preventDefault\(\);/.test(sm));
  check('modal: Esc closes, and no key reaches the page beneath', /win\.addEventListener\('keydown', onKeyDown, true\)/.test(sm) &&
    /e\.stopPropagation\(\);[^\n]*\n\s*if \(e\.key === 'Escape'\) \{\s*e\.preventDefault\(\);\s*if \(ctl\.pickerOpen\(\)\) \{ ctl\.closePicker\(\); render\(true\); \} else close\(true, 'escape'\);/.test(sm));
  check('modal: opening calls onOpen (closes any card) first', /function open\(t\) \{\s*if \(o\.onOpen\)/.test(sm));
  check('modal: aria-modal dialog (room nav stands down for it)', /setAttribute\('aria-modal', 'true'\)/.test(sm) && /\[aria-modal="true"\]/.test(page));
}

// ---- 11. Spotify: the pure half -------------------------------------------------------------------
console.log('11. Spotify: binding, results, calls, the play');
const ENTRY = 'DEMOENTRY0000000000000000A';   // a made-up config entry id
const SP = Object.assign({}, RAW, { spotify: { configEntryId: ENTRY } });
const spCfg = M.normaliseSoundMenu(SP);
{
  check('spotify: absent -> null (no tile)', cfg.spotify === null);
  check('spotify: {} -> on, entry looked up', J(M.normaliseSoundMenu(Object.assign({}, RAW, { spotify: {} })).spotify) === J({ configEntryId: null }));
  check('spotify: a configEntryId is kept; a malformed one dropped', spCfg.spotify.configEntryId === ENTRY &&
    M.normaliseSoundMenu(Object.assign({}, RAW, { spotify: { configEntryId: 'a b' } })).spotify.configEntryId === null);
  const item = (uri, image, name, artists) => ({ media_type: 'track', uri, name, image, artists: (artists || []).map(a => ({ name: a })) });
  const items = [
    item('library://track/1', 'http://192.0.2.5:8095/imageproxy?x', 'Local rain', ['Relaxing sounds']),   // a local file: dropped
    item('library://track/2', 'https://i.scdn.co/image/abc', 'Song A', ['Artist 1', 'Artist 2']),          // Spotify, in MA's library
    item('spotify--demo://track/3', null, 'Song B', ['Artist 3']),                                          // Spotify uri, no art
    item('library://track/2', 'https://i.scdn.co/image/abc', 'Song A again', []),                          // duplicate uri
    item('spotify--demo://track/4', 'http://i.scdn.co/insecure', 'Song C', []),                             // http art: no image
  ];
  const rows = M.spotifyTracks(items, 25);
  check('results: Spotify only (scdn artwork or a spotify uri), each uri once', rows.map(r => r.uri).join() === 'library://track/2,spotify--demo://track/3,spotify--demo://track/4', rows);
  check('results: title, artists joined, https artwork only', rows[0].title === 'Song A' && rows[0].artists === 'Artist 1, Artist 2' &&
    rows[0].image === 'https://i.scdn.co/image/abc' && rows[1].image === null && rows[2].image === null);
  const many = Array.from({ length: 40 }, (_, i) => item('spotify--demo://track/' + i, null, 'T' + i));
  check('results: at most 25', M.spotifyTracks(many, M.SPOTIFY_LIMIT).length === 25);
  check('results: garbage -> []', M.spotifyTracks(null).length === 0 && M.spotifyTracks([null, 'x', {}]).length === 0);
  check('recents call: get_library, tracks, last played first, 50', J(M.recentsCall(ENTRY)) === J({ domain: 'music_assistant', service: 'get_library',
    data: { config_entry_id: ENTRY, media_type: 'track', order_by: 'last_played_desc', limit: 50 } }));
  check('search call: search, tracks, 25', J(M.searchCall(ENTRY, 'moon')) === J({ domain: 'music_assistant', service: 'search',
    data: { config_entry_id: ENTRY, name: 'moon', media_type: ['track'], limit: 25 } }));
  check('query: under 2 characters -> recents; else a trimmed search', J(M.pickerWant(' a ')) === J({ kind: 'recents', query: '' }) &&
    J(M.pickerWant(' mo ')) === J({ kind: 'search', query: 'mo' }));
  check('config entry: a loaded one first, else the first, else null', M.pickConfigEntry([{ entry_id: 'X', domain: 'music_assistant', state: 'not_loaded' },
    { entry_id: 'Y', domain: 'music_assistant', state: 'loaded' }]) === 'Y' && M.pickConfigEntry([{ entry_id: 'X' }]) === 'X' && M.pickConfigEntry([]) === null);
  const play = M.spotifyPlayCommands([BED, LOUNGE], 'spotify--demo://track/3');
  check('play: repeat_set off, play_media, repeat_set off -- in that order', play.map(c => c.service).join() === 'repeat_set,play_media,repeat_set');
  check('play: every call targets exactly the selection', play.every(c => J(c.target.entity_id) === J([BED, LOUNGE])));
  check('play: play_media replaces the queue with the track', J(play[1].data) === J({ media_id: 'spotify--demo://track/3', media_type: 'track', enqueue: 'replace' }) &&
    J(play[0].data) === J({ repeat: 'off' }));
  check('errors: a timeout, a lost pairing, an unknown one', M.spotifyErrorText(new Error('Home Assistant did not answer')) === 'Music Assistant did not answer.' &&
    /sign-in may need redoing/.test(M.spotifyErrorText(new Error('No playable item found to start playback'))) &&
    M.spotifyErrorText(new Error('boom')) === 'Music Assistant: boom');
  check('the demo fixtures: generic names, spotify--demo uris, no artwork', M.SAMPLE_SPOTIFY_TRACKS.every(t => /^spotify--demo:\/\/track\/demo_\d+$/.test(t.uri) && t.image === null));
}

// ---- 12. the HA client's request path ---------------------------------------------------------------
console.log('12. HA client: request / callServiceForResponse');
{
  const fake = installFakeHA({ states: [], respond: msg => {
    if (msg.type === 'ping_ok') return { result: { pong: 1 } };
    if (msg.type === 'ping_err') return { error: { code: 'x', message: 'HA said no' } };
    if (msg.type === 'ping_hold') return { hold: true };
    if (msg.type === 'call_service' && msg.return_response) return { result: { context: {}, response: { tracks: [1, 2] } } };
    return undefined;
  } });
  const realLog = console.log; console.log = () => {};
  try {
    const ha = HAClient.create({ url: 'http://ha.invalid', token: 't', rooms: {}, sensors: {} });
    check('request before connecting rejects at once', await ha.request({ type: 'ping_ok' }).then(() => false, e => /not connected/.test(e.message)));
    ha.connect();
    await fake.whenConnected(ha);
    console.log = realLog;
    check('request resolves HA\'s result', J(await ha.request({ type: 'ping_ok' })) === J({ pong: 1 }));
    check('request rejects with HA\'s own error message', await ha.request({ type: 'ping_err' }).then(() => false, e => e.message === 'HA said no'));
    check('request times out: "did not answer"', await ha.request({ type: 'ping_hold' }, 30).then(() => false, e => /did not answer/.test(e.message)));
    const resp = await ha.callServiceForResponse('music_assistant', 'search', { name: 'x' });
    const sentMsg = fake.sent.filter(m => m.type === 'call_service').pop();
    check('callServiceForResponse: return_response true, resolves the response', J(resp) === J({ tracks: [1, 2] }) && sentMsg.return_response === true &&
      sentMsg.domain === 'music_assistant' && !('target' in sentMsg));
    const held = ha.request({ type: 'ping_hold' }, 5000);
    ha.disconnect();
    check('a request in flight rejects when the socket drops', await held.then(() => false, e => /disconnected/.test(e.message)));
    check('listEntities is built on request (one get_states)', /function listEntities\(domains, timeoutMs\) \{\s*return request\(\{ type: 'get_states' \}, timeoutMs\)/.test(read('src/ha-client.js')));
  } finally { console.log = realLog; fake.restore(); }
}

// ---- 13. the Spotify picker and play, against the fake Home Assistant ---------------------------
console.log('13. Spotify picker and play (fake HA)');
const SPOT = (n, name) => ({ media_type: 'track', uri: 'spotify--demo://track/' + n, name, image: 'https://i.scdn.co/image/demo' + n, artists: [{ name: 'Sample Artist' }] });
const LOCAL = { media_type: 'track', uri: 'library://track/9', name: 'Local', image: 'http://192.0.2.5/x', artists: [] };
{
  const searches = [];           // the held search answers, by query
  let playError = null, playHold = null;
  const fake = installFakeHA({ states: haStates(), respond: msg => {
    if (msg.type === 'config_entries/get') return { result: [{ entry_id: ENTRY, domain: 'music_assistant', state: 'loaded' }] };
    if (msg.type !== 'call_service') return undefined;
    if (msg.service === 'get_library') return { result: { context: {}, response: { items: [LOCAL, SPOT(1, 'Recent one'), SPOT(2, 'Recent two')] } } };
    if (msg.service === 'search') {
      return new Promise(res => searches.push({ q: msg.service_data.name, answer: () => res({ result: { context: {}, response: { tracks: [SPOT(10, 'Hit for ' + msg.service_data.name)] } } }),
        fail: m => res({ error: { code: 'home_assistant_error', message: m } }) }));
    }
    if (msg.service === 'play_media' && playError) return { error: { code: 'home_assistant_error', message: playError } };
    if (msg.service === 'play_media' && playHold) return new Promise(res => { playHold.release = () => res(undefined); });
    return undefined;
  } });
  const realLog = console.log; console.log = (...a) => { if (/^\s+(ok|FAIL)/.test(String(a[0]))) realLog(...a); };
  try {
    // No configEntryId: looked up once.
    const ha = HAClient.create({ url: 'http://ha.invalid', token: 't', rooms: {}, sensors: { soundMenu: Object.assign({}, RAW, { spotify: {} }) } });
    ha.connect();
    await fake.whenConnected(ha);
    const ws = fake.sockets[0];
    let t = 50000, changes = 0;
    const lookupCfg = M.normaliseSoundMenu(Object.assign({}, RAW, { spotify: {} }));
    const ctl = M.createSoundController({ cfg: lookupCfg, getHa: () => ha, sendScript, now: () => t, onChange: () => changes++ });
    const m0 = ctl.model();
    check('the Spotify tile is first on page 1', m0.pages[0][0].spotify === true && m0.pages[0][0].label === 'Spotify' && m0.pages[0].length === 4);
    check('... and only when configured', !M.createSoundController({ cfg, getHa: () => ha, sendScript, now: () => t }).model().pages[0].some(x => x.spotify));
    check('no picker without spotify configured', M.createSoundController({ cfg, getHa: () => ha, sendScript, now: () => t }).openPicker() === false);
    const before = fake.calls.length;
    check('openPicker -> true, loading recents', ctl.openPicker() === true && ctl.model().picker.status === 'loading');
    await sleep(20);
    const lookups = fake.sent.filter(m => m.type === 'config_entries/get');
    check('the config entry is looked up (config_entries/get, music_assistant)', lookups.length === 1 && lookups[0].domain === 'music_assistant');
    const lib = fake.calls.slice(before).filter(c => c.service === 'music_assistant/get_library');
    check('recents: get_library with the looked-up entry, return_response', lib.length === 1 && lib[0].msg.return_response === true &&
      J(lib[0].msg.service_data) === J(M.recentsCall(ENTRY).data), lib.map(c => c.msg));
    const p1 = ctl.model().picker;
    check('recents: Spotify rows only (the local file dropped)', p1.status === 'ok' && p1.kind === 'recents' && p1.items.map(i => i.title).join() === 'Recent one,Recent two', p1);
    check('the result repainted the menu (onChange)', changes > 0);
    check('opening the picker sent NO command (only reads)', fake.calls.slice(before).every(c => c.msg.return_response === true));

    // Search: debounce, minimum length, stale answers dropped.
    ctl.setQuery('m'); ctl.tick(); await sleep(5);
    check('1 character: no search', searches.length === 0);
    ctl.setQuery('mo'); t += M.SEARCH_DEBOUNCE_MS - 1; ctl.tick(); await sleep(5);
    check('2 characters: not before 400 ms', searches.length === 0);
    t += 1; ctl.tick(); await sleep(5);
    check('... then one search for "mo", reusing the entry (no second lookup)', searches.length === 1 && searches[0].q === 'mo' &&
      fake.sent.filter(m => m.type === 'config_entries/get').length === 1);
    ctl.setQuery('moo'); t += M.SEARCH_DEBOUNCE_MS; ctl.tick(); await sleep(5);
    check('a newer query searches again', searches.length === 2 && searches[1].q === 'moo');
    searches[1].answer(); await sleep(10);
    check('the newer answer shows', ctl.model().picker.items.map(i => i.title).join() === 'Hit for moo');
    searches[0].answer(); await sleep(10);
    check('the STALE older answer, arriving last, is dropped', ctl.model().picker.items.map(i => i.title).join() === 'Hit for moo');
    ctl.setQuery('moon'); t += M.SEARCH_DEBOUNCE_MS; ctl.tick(); await sleep(5);
    searches[2].fail('Spotify provider is not available');
    await sleep(10);
    const pe = ctl.model().picker;
    check('a failed search shows inline, the list emptied', pe.status === 'error' && pe.error === 'Music Assistant: Spotify provider is not available' && pe.items.length === 0, pe);
    ctl.setQuery(''); ctl.tick(); await sleep(150);
    check('clearing the query goes back to recents', ctl.model().picker.kind === 'recents' && ctl.model().picker.items.length === 2);

    // The play, with an ambience sound selected (plan review #1, #3).
    // Selected: the bedroom (from the snapshot); make the lounge selected too.
    ws.emitStateChanged({ entity_id: SEL, state: J([BED, LOUNGE]), attributes: {} });
    ws.emitStateChanged({ entity_id: LOUNGE, state: 'playing', attributes: { media_title: 'Rain' } });
    await sleep(5);
    const at = fake.calls.length;
    const uri = 'spotify--demo://track/1';
    check('a row tap -> true', ctl.playTrack(uri) === true);
    await sleep(10);
    let made = fake.calls.slice(at);
    check('#1: a selected sound is deselected FIRST, and nothing else goes yet', made.length === 1 && made[0].service === 'input_select/select_option' &&
      made[0].msg.service_data.option === 'None', made.map(c => c.service));
    check('... the row says it is stopping the ambience', J(ctl.model().picker.playing) === J({ uri, phase: 'stopping' }));
    check('a sound tile is refused while the play is pending', ctl.tap('snd', 'Ocean') === false);
    check('a second row tap is refused while the play is pending', ctl.playTrack('spotify--demo://track/2') === false);
    t += M.RETRIGGER_GAP_MS; ctl.tick(); await sleep(10);
    check('... still waiting: the helper has not read None yet', fake.calls.length === at + 1);
    ws.emitStateChanged({ entity_id: SOUND, state: 'None', attributes: {} });
    await sleep(5); ctl.tick(); await sleep(10);
    check('... still waiting: the automation has not stopped the speakers', fake.calls.length === at + 1);
    ws.emitStateChanged({ entity_id: BED, state: 'idle', attributes: {} });
    ws.emitStateChanged({ entity_id: LOUNGE, state: 'idle', attributes: {} });
    await sleep(5); ctl.tick(); await sleep(150);
    made = fake.calls.slice(at);
    check('#3: then repeat_set off, play_media, repeat_set off -- in that order', made.map(c => c.service).join() ===
      'input_select/select_option,media_player/repeat_set,music_assistant/play_media,media_player/repeat_set', made.map(c => c.service));
    check('#3: every call targets EXACTLY the selected speakers', made.slice(1).every(c => J(c.msg.target.entity_id) === J([BED, LOUNGE])), made.map(c => c.msg.target));
    check('... play_media: the track, replacing the queue', J(made[2].msg.service_data) === J({ media_id: uri, media_type: 'track', enqueue: 'replace' }));
    check('... each one waited for the previous answer (a request, not fire-and-forget)', made.slice(1).every(c => typeof c.msg.id === 'number'));
    const after = ctl.model();
    check('done: the sound tiles are not left busy (the speakers now play Spotify)', ctl.model().busy === null);
    check('done: back to the menu, "Playing on 2 speakers"', after.picker === null && J(after.notice) === J({ text: 'Playing on 2 speakers', kind: 'ok' }), [after.picker, after.notice]);
    t += M.NOTICE_MS;
    check('... and the notice clears', ctl.model().notice === null);

    // The tablet picks a sound while the play waits: abandoned, not fought.
    ws.emitStateChanged({ entity_id: SOUND, state: 'Rain', attributes: {} });
    await sleep(5);
    ctl.openPicker(); await sleep(20);
    const at2 = fake.calls.length;
    ctl.playTrack(uri);
    ws.emitStateChanged({ entity_id: SOUND, state: 'Ocean', attributes: {} });
    await sleep(5);
    t += M.RETRIGGER_MAX_MS; ctl.tick(); await sleep(150);
    check('helper changed elsewhere: only the None went out, no play', fake.calls.slice(at2).map(c => c.service).join() === 'input_select/select_option');
    check('... and the picker says why', /did not stop/.test(ctl.model().picker.error) && ctl.model().notice.kind === 'error' && ctl.playing() === null);

    // No sound selected: the play goes at once. A failed play_media stops the chain.
    ws.emitStateChanged({ entity_id: SOUND, state: 'None', attributes: {} });
    await sleep(5);
    t += M.BUSY_MAX_MS;
    playError = 'No playable item found to start playback';
    const at3 = fake.calls.length;
    ctl.playTrack(uri); await sleep(150);
    check('no sound selected: no select, straight to repeat_set + play_media', fake.calls.slice(at3).map(c => c.service).join() === 'media_player/repeat_set,music_assistant/play_media');
    check('a failed play shows inline (the pairing hint), and the chain stopped', /sign-in may need redoing/.test(ctl.model().picker.error) && ctl.model().picker !== null);
    playError = null;

    // While play_media is still being answered (no busy window any more), a
    // sound tile and another row are refused.
    playHold = {};
    const at6 = fake.calls.length;
    ctl.playTrack(uri); await sleep(150);
    check('play in flight: play_media sent, not yet answered', fake.calls.slice(at6).map(c => c.service).join() === 'media_player/repeat_set,music_assistant/play_media' &&
      ctl.playing().phase === 'starting' && ctl.model().busy === null);
    check('... a sound tile is refused (it would race the play)', ctl.tap('snd', 'Ocean') === false);
    check('... and so is another row', ctl.playTrack('spotify--demo://track/2') === false);
    playHold.release(); playHold = null; await sleep(150);
    check('... then the last repeat_set, and done', fake.calls.slice(at6).map(c => c.service).pop() === 'media_player/repeat_set' && ctl.playing() === null);
    ctl.openPicker(); await sleep(150);

    // Nothing selected.
    ws.emitStateChanged({ entity_id: SEL, state: '[]', attributes: {} });
    await sleep(5);
    const at4 = fake.calls.length;
    check('no speaker selected: refused, "Select a speaker first."', ctl.playTrack(uri) === false && ctl.model().picker.error === 'Select a speaker first.' && fake.calls.length === at4);
    ws.emitStateChanged({ entity_id: SEL, state: J([BED]), attributes: {} });
    await sleep(5);

    // Code review: only ever a configured speaker.
    const at5 = fake.calls.length;
    check('stop / transport on an UNCONFIGURED speaker are refused', ['stop', 'volUp', 'next', 'playPause'].every(a => ctl.tap(a, 'media_player.demo_unrelated') === false) && fake.calls.length === at5);

    // Offline: the picker cannot open, and a read fails inline.
    ctl.closePicker();
    ha.disconnect();
    check('offline: the picker does not open', ctl.openPicker() === false);
    check('no fetch, ever', fake.fetches.length === 0);
  } finally { console.log = realLog; fake.restore(); }
}
{
  // A configured entry is used as is: no lookup.
  const fake = installFakeHA({ states: haStates(), respond: msg => (msg.type === 'call_service' && msg.return_response ? { result: { context: {}, response: { items: [] } } } : undefined) });
  const realLog = console.log; console.log = () => {};
  try {
    const ha = HAClient.create({ url: 'http://ha.invalid', token: 't', rooms: {}, sensors: { soundMenu: SP } });
    ha.connect();
    await fake.whenConnected(ha);
    const ctl = M.createSoundController({ cfg: spCfg, getHa: () => ha, sendScript, now: () => 0 });
    ctl.openPicker(); await sleep(20);
    console.log = realLog;
    check('a configured configEntryId: used directly, no config_entries/get', !fake.sent.some(m => m.type === 'config_entries/get') &&
      fake.calls.some(c => c.msg.service_data.config_entry_id === ENTRY));
    check('... an empty recents list says so', ctl.model().picker.status === 'ok' && ctl.model().picker.items.length === 0);
    ha.disconnect();
  } finally { console.log = realLog; fake.restore(); }
}
{
  // Mock mode: fixtures, the sample moves, nothing is sent.
  const fake = installFakeHA();
  try {
    let t = 0;
    const ctl = M.createSoundController({ cfg: M.normaliseSoundMenu(Object.assign({}, RAW, { spotify: {} })), getHa: () => null, sendScript, now: () => t });
    ctl.openPicker(); await sleep(5);
    const p = ctl.model().picker;
    check('mock: recents from the fixtures, the local file filtered out', p.items.length === M.SAMPLE_SPOTIFY_TRACKS.length && !p.items.some(i => i.uri.startsWith('library://')));
    ctl.setQuery('harbour'); t += M.SEARCH_DEBOUNCE_MS; ctl.tick(); await sleep(5);
    check('mock: a search filters the fixtures', ctl.model().picker.items.map(i => i.title).join() === 'Harbour Lights');
    const uri = ctl.model().picker.items[0].uri;
    ctl.playTrack(uri);
    check('mock: Rain was selected, so None first', ctl.model().sound === 'None' && ctl.playing().phase === 'stopping');
    t += M.RETRIGGER_GAP_MS; ctl.tick();
    const m = ctl.model();
    check('mock: then the track plays on the selected speaker', m.picker === null && m.slides.length === 1 && m.slides[0].title === 'Harbour Lights');
    check('mock: nothing reached Home Assistant', fake.sockets.length === 0 && fake.calls.length === 0);
  } finally { fake.restore(); }
}
{
  const sm = read('src/sound-menu.js');
  check('picker UI: Esc closes the picker before the menu', /if \(ctl\.pickerOpen\(\)\) \{ ctl\.closePicker\(\); render\(true\); \} else close\(true, 'escape'\);/.test(sm));
  check('picker UI: the search box survives repaints (only the list is rebuilt)', /querySelector\('\[data-plist\]'\)\.innerHTML = pickerList\(m\)/.test(sm) &&
    /if \(force \|\| sheet\.dataset\.mode !== 'picker'\)/.test(sm));
  check('picker UI: artwork never sends a referrer', /referrerpolicy="no-referrer"/.test(sm));
  check('Phase 1 nit: the body scrolls instead of squeezing its sections', /\.sm-body \{[^}]*min-height: 0;/.test(sm) && /\.sm-body > \* \{ flex-shrink: 0; \}/.test(sm));
}

// ---- 14. code review round 2: who a play reaches, cancelling, late answers ------------------------
console.log('14. Spotify play: configured speakers only, cancel / detach, an unconfirmed play');
{
  const UNRELATED = 'media_player.demo_unrelated';
  const holds = {};   // service -> { release } while held
  const fake = installFakeHA({ states: haStates(), respond: msg => {
    if (msg.type !== 'call_service') return undefined;
    if (msg.return_response) return { result: { context: {}, response: { items: [SPOT(1, 'Recent one')] } } };
    if (holds[msg.service] && holds[msg.service].hold) {
      return holds[msg.service].mode === 'never' ? { hold: true } : new Promise(res => { holds[msg.service].release = () => res(undefined); });
    }
    return undefined;
  } });
  const realLog = console.log; console.log = (...a) => { if (/^\s+(ok|FAIL)/.test(String(a[0]))) realLog(...a); };
  try {
    const ha = HAClient.create({ url: 'http://ha.invalid', token: 't', rooms: {}, sensors: { soundMenu: SP } });
    ha.connect();
    await fake.whenConnected(ha);
    const ws = fake.sockets[0];
    let t = 90000;
    const ctl = M.createSoundController({ cfg: spCfg, getHa: () => ha, sendScript, now: () => t, playTimeoutMs: 800 });
    const uri = 'spotify--demo://track/1';
    const settle = async () => { await sleep(150); };
    // Start from no sound selected and idle speakers.
    ws.emitStateChanged({ entity_id: SOUND, state: 'None', attributes: {} });
    ws.emitStateChanged({ entity_id: BED, state: 'idle', attributes: {} });
    ws.emitStateChanged({ entity_id: STUDY, state: 'idle', attributes: {} });
    await settle();

    // BLOCKING: the helper lists a speaker the menu does not know.
    ws.emitStateChanged({ entity_id: SEL, state: J([BED, UNRELATED]), attributes: {} });
    await settle();
    ctl.openPicker(); await settle();
    let at = fake.calls.length;
    check('a play with an unconfigured speaker in the helper -> true', ctl.playTrack(uri) === true);
    await settle();
    let made = fake.calls.slice(at);
    check('... the play went out (repeat_set, play_media, repeat_set)', made.map(c => c.service).join() ===
      'media_player/repeat_set,music_assistant/play_media,media_player/repeat_set', made.map(c => c.service));
    check('... and NO call targets the unconfigured speaker', made.every(c => J(c.msg.target.entity_id) === J([BED])) &&
      !fake.calls.some(c => J(c.msg.target || {}).includes(UNRELATED)), made.map(c => c.msg.target));
    check('... the notice counts only the configured one', J(ctl.model().notice) === J({ text: 'Playing on 1 speaker', kind: 'ok' }));
    ws.emitStateChanged({ entity_id: SEL, state: J([UNRELATED]), attributes: {} });
    await settle();
    ctl.openPicker(); await settle();
    at = fake.calls.length;
    check('only an unconfigured speaker selected: "Select a speaker first.", nothing sent', ctl.playTrack(uri) === false &&
      ctl.model().picker.error === 'Select a speaker first.' && fake.calls.length === at);
    ws.emitStateChanged({ entity_id: SEL, state: J([BED]), attributes: {} });
    await settle();

    // Cancel while waiting on the 'None': nothing after it goes out.
    ws.emitStateChanged({ entity_id: SOUND, state: 'Rain', attributes: {} });
    await settle();
    ctl.openPicker(); await settle();
    at = fake.calls.length;
    ctl.playTrack(uri);
    ctl.closePicker();
    check('Back while stopping the ambience: the play is cancelled', ctl.playing() === null);
    ws.emitStateChanged({ entity_id: SOUND, state: 'None', attributes: {} });
    await settle();
    t += M.RETRIGGER_MAX_MS; ctl.tick(); await settle();
    check('... only the None went out, never repeat_set / play_media', fake.calls.slice(at).map(c => c.service).join() === 'input_select/select_option',
      fake.calls.slice(at).map(c => c.service));

    // Cancel while the first repeat_set is unanswered: play_media never goes.
    t += M.BUSY_MAX_MS;
    holds.repeat_set = { hold: true };
    ctl.openPicker(); await settle();
    at = fake.calls.length;
    ctl.playTrack(uri); await settle();
    ctl.closePicker();
    holds.repeat_set.release(); holds.repeat_set = null; await settle();
    check('Back before play_media went out: cancelled, play_media never sent', fake.calls.slice(at).map(c => c.service).join() === 'media_player/repeat_set',
      fake.calls.slice(at).map(c => c.service));

    // Detach once play_media has gone out: it finishes, the re-opened picker is left alone.
    holds.play_media = { hold: true };
    ctl.openPicker(); await settle();
    at = fake.calls.length;
    ctl.playTrack(uri); await settle();
    check('play_media in flight', fake.calls.slice(at).map(c => c.service).pop() === 'music_assistant/play_media');
    ctl.closePicker();
    ctl.openPicker(); await settle();
    check('re-opened picker while the old play finishes', ctl.model().picker !== null && ctl.playing() === null);
    holds.play_media.release(); holds.play_media = null; await settle();
    const p2 = ctl.model();
    check('... the old play finished (its last repeat_set went out)', fake.calls.slice(at).filter(c => !c.msg.return_response).map(c => c.service).join() ===
      'media_player/repeat_set,music_assistant/play_media,media_player/repeat_set', fake.calls.slice(at).map(c => c.service));
    check('... and did NOT close or post into the re-opened picker', p2.picker !== null && p2.picker.error === null && p2.notice === null, [p2.picker && p2.picker.error, p2.notice]);

    // HA never confirms play_media: a warning, not a failure.
    holds.play_media = { hold: true, mode: 'never' };
    at = fake.calls.length;
    ctl.playTrack(uri); await sleep(1100);
    const p3 = ctl.model();
    check('an unconfirmed play_media: a warning notice, back to the menu', J(p3.notice) === J({ text: M.PLAY_UNCONFIRMED, kind: 'warn' }) && p3.picker === null, [p3.notice, !!p3.picker]);
    check('... no error shown, and the job is over', ctl.playing() === null);
    holds.play_media = null;

    // A timeout BEFORE play_media went out is still an error.
    holds.repeat_set = { hold: true, mode: 'never' };
    ctl.openPicker(); await settle();
    ctl.playTrack(uri); await sleep(1100);
    check('a timeout before play_media: an error, picker kept', ctl.model().picker !== null && ctl.model().picker.error === 'Music Assistant did not answer.');
    holds.repeat_set = null;
    ha.disconnect();
  } finally { console.log = realLog; fake.restore(); }
}
{
  const hint = m => /sign-in may need redoing/.test(M.spotifyErrorText(new Error(m)));
  check('the re-pair hint: MA\'s playback-auth shapes', hint('No playable item found to start playback') && hint('MediaNotFoundError: x') &&
    hint('login5 rejected the credential') && hint('Spotify credentials are unauthorized'));
  check('... NOT anything merely mentioning auth or login', !hint('Authentication failed') && !hint('auth required') && !hint('Unauthorized') &&
    !hint('login page unreachable') && !hint('Validation error: Entry not found'));
}

console.log('\n' + passes + ' passed, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
