#!/usr/bin/env node
/**
 * Curtain SLIDER command mapping: slider value -> `cover.set_cover_position`
 * payload, multi-motor fan-out, and unavailable/no-reading handling. No
 * framework, no install - `node scripts/test-curtain-slider-command.mjs`.
 *
 * This is deliberately separate from test-curtain-binding.mjs, which covers
 * the READ side (HA cover state -> { pct, moving }, cornice, daylight). This
 * script covers the WRITE side the sidebar slider added in this change relies
 * on: HAClient.coverPositionCommand() (index.html's sendCurtainToHA() is a
 * thin wrapper: build the command, hand it to ha.callServiceDebounced --
 * nothing left in the DOM layer worth a separate assertion) plus the
 * availability signal (HAClient's curtainAvailabilityCallbacks /
 * getCurtainAvailable) that disables a slider when its motor drops off.
 *
 * WHAT THIS GUARDS
 *
 *   1. coverPositionCommand(): clamps/rounds the position into [0,100],
 *      targets a single bound entity directly and fans out to several as an
 *      array, returns null (nothing to send) when the curtain has no bound
 *      entity at all -- the exact case rooms.json leaves possible for a
 *      curtain the geometry draws purely for looks -- and returns null
 *      (rather than inventing position 0 / fully CLOSE) for a non-numeric
 *      position: NaN, undefined, or a non-numeric string. This drives a
 *      physical motor, so "send nothing" is the only safe fallback (code
 *      review finding, PR #40 round 1).
 *   2. Curtain availability: 'unavailable' AND 'unknown' on the bound cover
 *      each resolve the curtain unavailable, ANY down motor on a multi-motor
 *      curtain makes the whole curtain unavailable (the slider can no longer
 *      promise to move every bound motor), a motor that has NEVER reported
 *      at all counts the same as unavailable rather than as available by
 *      default (a second round-1 finding: `undefined !== false` used to pass
 *      an every() check it should have failed), it flips back to available
 *      only once every bound motor has explicitly reported available, fires
 *      only on an actual change (no callback storm on a republish), and
 *      getCurtainAvailable() reports null before any reading has ever
 *      arrived -- distinct from a confirmed 'unavailable'.
 *   3. Availability is independent of the position path: an unavailable cover
 *      does not fire onCurtainChange (parseCover's existing "hold the last
 *      reading" contract, unit-tested in test-curtain-binding.mjs), and a
 *      position update does not fire the availability callback when nothing
 *      about availability changed.
 *   4. callServiceDebounced's own double-send bug (round-1 finding): a
 *      debounced 'input' send (200ms) followed by an immediate 'change' send
 *      (0ms, on release) for the SAME value must reach HA exactly once, not
 *      twice ~200ms apart. This is the literal mechanism the slider's
 *      input+change pair relies on, so it is tested directly against
 *      HAClient.create() + callServiceDebounced with a mocked fetch, one
 *      level below the DOM entirely.
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const imp = rel => import(pathToFileURL(path.join(root, rel)).href);
const { HAClient } = await imp('src/ha-client.js');

let failures = 0, passes = 0;
function check(name, cond, detail) {
  if (cond) { passes++; return; }
  failures++;
  console.error('FAIL ' + name + (detail !== undefined ? ' -- ' + JSON.stringify(detail) : ''));
}

// ---------------------------------------------------------------------------
// 1. coverPositionCommand(): the pure slider -> service-call mapping
// ---------------------------------------------------------------------------
{
  const single = HAClient.coverPositionCommand(42, ['cover.demo_bedroom_curtain']);
  check('single motor: domain/service', single.domain === 'cover' && single.service === 'set_cover_position', single);
  check('single motor: position passed through', single.data.position === 42, single);
  check('single motor: target is the bare entity id, not wrapped in an array',
    single.target.entity_id === 'cover.demo_bedroom_curtain', single);

  const multi = HAClient.coverPositionCommand(75, ['cover.demo_lounge_curtain_l', 'cover.demo_lounge_curtain_r']);
  check('multi-motor: fans out to every bound entity',
    Array.isArray(multi.target.entity_id) &&
    multi.target.entity_id.length === 2 &&
    multi.target.entity_id.includes('cover.demo_lounge_curtain_l') &&
    multi.target.entity_id.includes('cover.demo_lounge_curtain_r'),
    multi);
  check('multi-motor: same position sent to all motors', multi.data.position === 75, multi);

  check('position is clamped below 0', HAClient.coverPositionCommand(-30, ['cover.a']).data.position === 0);
  check('position is clamped above 100', HAClient.coverPositionCommand(140, ['cover.a']).data.position === 100);
  check('position is rounded to an integer', HAClient.coverPositionCommand(33.6, ['cover.a']).data.position === 34);

  // A physical motor has no safe default position, so a non-numeric pct must
  // produce NOTHING TO SEND rather than inventing position 0 (fully CLOSE).
  check('NaN position -> null, not position 0',
    HAClient.coverPositionCommand(NaN, ['cover.a']) === null);
  check('undefined position -> null, not position 0',
    HAClient.coverPositionCommand(undefined, ['cover.a']) === null);
  check('a non-numeric string position -> null, not position 0',
    HAClient.coverPositionCommand('not-a-number', ['cover.a']) === null);
  check('Infinity is finite-checked out too -> null',
    HAClient.coverPositionCommand(Infinity, ['cover.a']) === null);
  // A genuinely numeric string is still accepted (matches the slider's own
  // `+e.target.value`, which yields a real number for a range input, but a
  // caller could reasonably pass a numeric string directly).
  check('a numeric STRING position is accepted and rounds normally',
    HAClient.coverPositionCommand('42.4', ['cover.a']).data.position === 42);

  check('no bound entities at all -> null (nothing to send)',
    HAClient.coverPositionCommand(50, []) === null);
  check('missing entities argument -> null', HAClient.coverPositionCommand(50, undefined) === null);
  check('entities with a falsy id filtered out, real one still fans out',
    (() => {
      const cmd = HAClient.coverPositionCommand(50, ['cover.demo_real', null, undefined]);
      return cmd && cmd.target.entity_id === 'cover.demo_real'; // one real id left -> bare string, not [x]
    })());
  check('a bare string entity (not an array) is accepted',
    HAClient.coverPositionCommand(50, 'cover.demo_solo').target.entity_id === 'cover.demo_solo');
}

// ---------------------------------------------------------------------------
// 2 + 3. Curtain availability
// ---------------------------------------------------------------------------
{
  const ha = HAClient.create({
    url: 'http://ha.invalid', token: 'x',
    rooms: {},
    sensors: {
      curtains: {
        lounge_curtain: ['cover.demo_lounge_curtain'],
        twin: ['cover.demo_twin_a', 'cover.demo_twin_b'],
        silent_twin: ['cover.demo_silent_a', 'cover.demo_silent_b']
      }
    }
  });
  const availEvents = [];
  const curtainEvents = [];
  ha.onCurtainAvailabilityChange((id, available) => availEvents.push([id, available]));
  ha.onCurtainChange((id, st) => curtainEvents.push([id, st]));

  const cover = (state, pos) => ({ state, attributes: pos == null ? {} : { current_position: pos } });

  check('before any reading: availability is null, not false',
    ha.getCurtainAvailable('lounge_curtain') === null);

  ha._injectFittingState('cover.demo_lounge_curtain', cover('open', 80));
  check('first real reading -> available, fires the callback',
    availEvents.length === 1 && availEvents[0][0] === 'lounge_curtain' && availEvents[0][1] === true,
    availEvents);
  check('getCurtainAvailable reflects it', ha.getCurtainAvailable('lounge_curtain') === true);
  check('a real reading also fires the position callback (independent paths, same update)',
    curtainEvents.length === 1 && curtainEvents[0][1].pct === 80);

  ha._injectFittingState('cover.demo_lounge_curtain', cover('open', 81));
  check('a further real reading does not re-fire availability (already true, no change)',
    availEvents.length === 1, availEvents);
  check('...but does still fire its own position update (pct actually changed)',
    curtainEvents.length === 2 && curtainEvents[1][1].pct === 81, curtainEvents);

  ha._injectFittingState('cover.demo_lounge_curtain', cover('unavailable', null));
  check('unavailable -> availability flips false and fires',
    availEvents.length === 2 && availEvents[1][0] === 'lounge_curtain' && availEvents[1][1] === false,
    availEvents);
  check('unavailable does NOT fire a position update (last reading is held, not invented)',
    curtainEvents.length === 2, curtainEvents);
  check('getCurtainAvailable reflects the drop', ha.getCurtainAvailable('lounge_curtain') === false);

  ha._injectFittingState('cover.demo_lounge_curtain', cover('unavailable', null));
  check('repeated unavailable does not re-fire (no change)', availEvents.length === 2, availEvents);

  ha._injectFittingState('cover.demo_lounge_curtain', cover('open', 60));
  check('recovering to a real reading flips availability back true',
    availEvents.length === 3 && availEvents[2][1] === true, availEvents);

  // 'unknown' must be treated exactly like 'unavailable' -- a distinct HA
  // state (a cover that has not yet reported a position, e.g. right after a
  // restart) that the review found had no dedicated assertion even though
  // the header claimed to cover it.
  ha._injectFittingState('cover.demo_lounge_curtain', cover('unknown', null));
  check('unknown -> availability flips false and fires, same as unavailable',
    availEvents.length === 4 && availEvents[3][0] === 'lounge_curtain' && availEvents[3][1] === false,
    availEvents);
  check('getCurtainAvailable reflects unknown as unavailable',
    ha.getCurtainAvailable('lounge_curtain') === false);
  check('unknown does NOT fire a position update either',
    curtainEvents.length === 3, curtainEvents);

  ha._injectFittingState('cover.demo_lounge_curtain', cover('open', 60));
  check('recovering from unknown flips availability back true',
    availEvents.length === 5 && availEvents[4][1] === true, availEvents);

  // Multi-motor: ANY down motor takes the whole curtain unavailable.
  ha._injectFittingState('cover.demo_twin_a', cover('open', 50));
  ha._injectFittingState('cover.demo_twin_b', cover('open', 50));
  check('multi-motor: both up -> available', ha.getCurtainAvailable('twin') === true);

  ha._injectFittingState('cover.demo_twin_b', cover('unavailable', null));
  check('multi-motor: one motor drops -> whole curtain unavailable',
    ha.getCurtainAvailable('twin') === false);

  ha._injectFittingState('cover.demo_twin_b', cover('open', 55));
  check('multi-motor: recovering the down motor restores availability',
    ha.getCurtainAvailable('twin') === true);

  check('an unbound entity does not affect any curtain\'s availability',
    ha._injectFittingState('cover.demo_elsewhere', cover('unavailable', null)) === false);

  // A motor that has NEVER reported at all must NOT count as available by
  // default. Before this fix, curtainEntityAvailable.get(eid) === undefined
  // for a silent motor, and `undefined !== false` passed an every() check it
  // should have failed -- a bound-but-silent motor left the whole curtain
  // enabled on the OTHER motor's reading alone, with commands still fanning
  // out to the entity nobody has ever heard from (code review finding, round 1).
  ha._injectFittingState('cover.demo_silent_a', cover('open', 50));
  check('one motor reporting, its twin completely silent -> still unavailable',
    ha.getCurtainAvailable('silent_twin') === false);
  ha._injectFittingState('cover.demo_silent_b', cover('open', 50));
  check('once BOTH motors have explicitly reported -> available',
    ha.getCurtainAvailable('silent_twin') === true);
}

// ---------------------------------------------------------------------------
// 4. callServiceDebounced: no double-send on input(debounced) + change(now)
// ---------------------------------------------------------------------------
{
  // ha.connect() is never called, so `ws` stays null and callService() always
  // takes the REST fallback below -- no fake WebSocket needed to exercise the
  // exact bug the review found.
  const calls = [];
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body) });
    return { ok: true, json: async () => ({}) };
  };
  try {
    const ha = HAClient.create({ url: 'http://ha.invalid', token: 'x', rooms: {}, sensors: {} });

    // Simulate the slider's own sequence: a debounced 'input' send, then an
    // immediate 'change' send for the SAME value shortly after (this is
    // sendCurtainToHA's de-dupe skipping the redundant call in the real
    // handler -- here we call callServiceDebounced directly, one layer
    // below sendCurtainToHA, to pin the mechanism itself regardless of that
    // higher-level guard).
    const target = { entity_id: 'cover.demo_bedroom_curtain' };
    ha.callServiceDebounced('cover', 'set_cover_position', { position: 35 }, target, 'curtain-bedroom_curtain', 200);
    await new Promise(r => setTimeout(r, 20)); // well inside the 200ms window
    ha.callServiceDebounced('cover', 'set_cover_position', { position: 35 }, target, 'curtain-bedroom_curtain', 0);

    // Give the (now-cleared) 200ms timer a chance to fire if the bug is
    // present -- it must not, because the immediate call above must have
    // cancelled it.
    await new Promise(r => setTimeout(r, 250));

    check('exactly one call reaches HA for one release, not two ~200ms apart',
      calls.length === 1, calls);
    check('the one call carries the right position', calls[0] && calls[0].body.position === 35, calls);

    // A DIFFERENT value scheduled after the immediate send must still go
    // through on its own timer -- the fix must cancel the STALE pending
    // timer, not suppress debouncing altogether.
    calls.length = 0;
    ha.callServiceDebounced('cover', 'set_cover_position', { position: 10 }, target, 'curtain-bedroom_curtain', 200);
    await new Promise(r => setTimeout(r, 250));
    check('a fresh debounced call after an immediate send still fires once',
      calls.length === 1 && calls[0].body.position === 10, calls);
  } finally {
    global.fetch = realFetch;
  }
}

if (failures) {
  console.error(failures + ' failed, ' + passes + ' passed');
  process.exit(1);
}
console.log('ok -- ' + passes + ' passed, 0 failed');
