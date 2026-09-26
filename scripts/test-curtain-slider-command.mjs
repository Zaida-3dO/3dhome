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
 *      array, and returns null (nothing to send) when the curtain has no
 *      bound entity at all -- the exact case rooms.json leaves possible for
 *      a curtain the geometry draws purely for looks.
 *   2. Curtain availability: 'unavailable'/'unknown' on the bound cover
 *      resolves the curtain unavailable, ANY down motor on a multi-motor
 *      curtain makes the whole curtain unavailable (the slider can no longer
 *      promise to move every bound motor), it flips back to available on a
 *      real reading, fires only on an actual change (no callback storm on a
 *      republish), and getCurtainAvailable() reports null before any
 *      reading has ever arrived -- distinct from a confirmed 'unavailable'.
 *   3. Availability is independent of the position path: an unavailable cover
 *      does not fire onCurtainChange (parseCover's existing "hold the last
 *      reading" contract, unit-tested in test-curtain-binding.mjs), and a
 *      position update does not fire the availability callback when nothing
 *      about availability changed.
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
  check('a non-numeric position falls back to 0 rather than NaN',
    HAClient.coverPositionCommand(undefined, ['cover.a']).data.position === 0);

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
        twin: ['cover.demo_twin_a', 'cover.demo_twin_b']
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
}

if (failures) {
  console.error(failures + ' failed, ' + passes + ' passed');
  process.exit(1);
}
console.log('ok -- ' + passes + ' passed, 0 failed');
