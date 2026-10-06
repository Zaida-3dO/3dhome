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
  const src = read('src/sound-model.js') + read('src/sound-menu.js');
  check('the app never plays a local sound itself (no play_media anywhere in the menu)', !/play_media/.test(src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')));
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
  check('re-trigger goes anyway at the timeout', M.retriggerReady(0, X, 'Rain', [BED], playing));
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

    // A re-trigger whose None never echoes still sends the label at the timeout.
    ws.emitStateChanged({ entity_id: SOUND, state: 'Fan', attributes: {} });
    ws.emitStateChanged({ entity_id: BED, state: 'playing', attributes: { media_title: 'Fan' } });
    ws.emitStateChanged({ entity_id: LOUNGE, state: 'playing', attributes: { media_title: 'Fan' } });
    await sleep(5);
    t += M.BUSY_MAX_MS;
    ctl.model();
    fake.calls.length = 0;
    ctl.tap('snd', 'Fan');
    t += M.RETRIGGER_MAX_MS - 1;
    check('timeout re-trigger: held until RETRIGGER_MAX_MS', ctl.tick() === false);
    t += 1;
    check('... then sent anyway', ctl.tick() === true);
    await sleep(5);
    check('... [None, Fan]', fake.calls.map(c => c.msg.service_data.option).join() === 'None,Fan', fake.calls);
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
  check('tap-popovers: a soundMenu tap opens the menu (no card, no camera flight)', /res\.target\.kind === 'soundMenu'\)[\s\S]{0,400}o\.soundMenu\.open\(\{ itemId: res\.target\.itemId, speaker: res\.target\.speaker \}\);\s*return;/.test(tp));
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
    /e\.stopPropagation\(\);[^\n]*\n\s*if \(e\.key === 'Escape'\) \{ e\.preventDefault\(\); close\(true\); return; \}/.test(sm));
  check('modal: opening calls onOpen (closes any card) first', /function open\(t\) \{\s*if \(o\.onOpen\)/.test(sm));
  check('modal: aria-modal dialog (room nav stands down for it)', /setAttribute\('aria-modal', 'true'\)/.test(sm) && /\[aria-modal="true"\]/.test(page));
}

console.log('\n' + passes + ' passed, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
