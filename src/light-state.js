/**
 * The scene's initial light state, as a pure function (item 1a181e50) so it
 * can be tested in plain node: `node scripts/test-light-state.mjs`.
 *
 * One entry per room, one sub-entry per channel. A room with no 'main'
 * channel still gets a main entry so the controls panel and syncLights() can
 * address every room uniformly.
 *
 * The channels are the ones geometry draws a fixture for (LIGHTS[roomId])
 * PLUS every channel rooms.json binds for that room (boundChannels, from
 * boundLightChannels in src/room-panel.js). The second half matters: an
 * office whose ambient light is a cornice and desk strips draws no ambient
 * fixture, and without the bound channel its one Ambient row would have no
 * state to drive.
 *
 * @param {Object} rooms          roomId -> room (only the keys are read)
 * @param {Object} lights         roomId -> { channel -> fixtures }
 * @param {?Object} boundChannels roomId -> [channel]
 * @returns {Object} roomId -> { main: {...}, [channel]: {...} }
 */
export function seedLightState(rooms, lights, boundChannels) {
  const bound = boundChannels || {};
  const state = {};
  Object.keys(rooms || {}).forEach(id => {
    const groups = (lights && lights[id]) || {};
    state[id] = { main: { on: false, bri: 100, temp: 4000 } };
    const channels = Object.keys(groups);
    (Array.isArray(bound[id]) ? bound[id] : []).forEach(ch => {
      if (typeof ch === 'string' && channels.indexOf(ch) === -1) channels.push(ch);
    });
    channels.forEach(channel => {
      if (channel === 'main') return;
      // Accent channels default to a warm accent colour and a lower
      // brightness; that is a display default, not a fact about the house.
      state[id][channel] = { on: false, bri: 80, color: "#ff3300" };
    });
  });
  return state;
}
