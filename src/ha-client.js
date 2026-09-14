/**
 * Home Assistant WebSocket Client for 3dHome
 * Syncs 3D scene light state with real HA light entities.
 *
 * Usage:
 *   const ha = HAClient.create({ url, token, rooms, sensors, ... });
 *   ha.onStateChange((roomId, group, state) => { ... });
 *   ha.onPresenceChange((roomId, occupied) => { ... });
 *   ha.onDoorChange((doorId, open) => { ... });
 *   ha.onStatusChange(status => { ... });
 *   ha.connect();
 */

export const HAClient = (() => {

  function create(opts) {
    const {
      token,
      rooms,
      sensors = null,
      wsReconnectMs = 5000,
      pollIntervalMs = 5000
    } = opts;
    // Support url array or single string + optional fallbackUrl
    const urls = Array.isArray(opts.url)
      ? opts.url
      : [opts.url, opts.fallbackUrl].filter(Boolean);
    let urlIndex = 0;
    let url = urls[urlIndex];

    let ws = null;
    let wsId = 1;
    let status = 'disconnected';
    let reconnectTimer = null;
    let pollTimer = null;

    const stateCallbacks = [];
    const statusCallbacks = [];
    const presenceCallbacks = [];
    const doorCallbacks = [];

    // Reverse index: entityId -> { roomId, group }
    const entityIndex = new Map();
    Object.entries(rooms).forEach(([roomId, groups]) => {
      Object.entries(groups).forEach(([group, entities]) => {
        entities.forEach(eid => entityIndex.set(eid, { roomId, group }));
      });
    });

    // ---- Non-light sensors (presence, door contacts) ----
    //
    // A SECOND reverse index, deliberately separate from entityIndex: its
    // values are { roomId, group } and a door is not room-scoped, so a door
    // sensor has nowhere to live in that shape. Keeping them apart also keeps
    // a sensor entity out of the light path entirely -- it never reaches
    // normalizeState (which would invent a `bri` for a binary_sensor) and it
    // never reaches the first-entity-only filter in processStateUpdate.
    //
    // sensorIndex: entityId -> { kind: 'presence'|'door', targetId }
    // sensorGroups: kind -> targetId -> [entityId], so several entities on one
    // target can be OR-ed (any one 'on' wins).
    const sensorIndex = new Map();
    const sensorGroups = { presence: {}, door: {} };
    // Last RESOLVED boolean per target. This is what makes the sensor path
    // safe for an on-demand renderer: HA re-sends state_changed on
    // attribute-only updates (a battery level every 30s is the usual case),
    // and forwarding those would call requestRender() forever and silently
    // destroy the scene's zero-frame idle. We compare the resolved boolean and
    // drop the update when it has not actually changed.
    const sensorState = { presence: new Map(), door: new Map() };
    // Raw per-entity on/off, the input to the OR. Kept separate from
    // sensorState because with two entities on one door we must remember both
    // to know whether the OR has flipped.
    const sensorEntityOn = new Map();

    if (sensors) {
      const indexKind = (kind, map) => {
        Object.entries(map || {}).forEach(([targetId, entities]) => {
          if (!Array.isArray(entities) || !entities.length) return;
          sensorGroups[kind][targetId] = entities.slice();
          entities.forEach(eid => sensorIndex.set(eid, { kind, targetId }));
        });
      };
      indexKind('presence', sensors.presence);
      indexKind('door', sensors.doors);
    }

    function sensorCallbacksFor(kind) {
      return kind === 'presence' ? presenceCallbacks : doorCallbacks;
    }

    /**
     * Fold one entity's raw state into its target's OR-ed boolean, and notify
     * ONLY when that boolean actually changed.
     *
     * Returns true if a change was dispatched -- used by the initial sync so
     * it can tell "already correct" from "just changed".
     */
    function processSensorUpdate(entityId, haState) {
      const mapping = sensorIndex.get(entityId);
      if (!mapping) return false;
      const { kind, targetId } = mapping;

      // HA's convention for both an occupancy/motion sensor and a door/opening
      // contact is the same: 'on' means detected/open. 'unavailable' and
      // 'unknown' are NOT 'on', so a dropped sensor reads as empty/closed
      // rather than sticking at its last value.
      const on = haState.state === 'on';
      if (sensorEntityOn.get(entityId) === on) return false;
      sensorEntityOn.set(entityId, on);

      // OR across every entity bound to this target: any one 'on' wins, which
      // is how a room with two motion sensors should behave.
      const group = sensorGroups[kind][targetId] || [];
      const resolved = group.some(eid => sensorEntityOn.get(eid) === true);

      if (sensorState[kind].get(targetId) === resolved) return false;
      sensorState[kind].set(targetId, resolved);

      sensorCallbacksFor(kind).forEach(cb => {
        try { cb(targetId, resolved); } catch (e) { console.warn('HAClient sensorCb:', e); }
      });
      return true;
    }

    // Echo suppression
    const pendingCommands = new Map();

    function setStatus(s) {
      if (status === s) return;
      status = s;
      statusCallbacks.forEach(cb => { try { cb(s); } catch (e) { console.warn('HAClient statusCb:', e); } });
    }

    // ---- State normalization ----

    function normalizeState(haState, group) {
      const on = haState.state === 'on';
      const attrs = haState.attributes || {};
      const result = { on };

      if (group === 'main') {
        result.bri = (attrs.brightness != null) ? Math.round(attrs.brightness / 2.55) : (on ? 100 : 0);
        result.temp = (attrs.color_temp_kelvin != null) ? attrs.color_temp_kelvin : 4000;
      } else if (group === 'ambient') {
        result.bri = (attrs.brightness != null) ? Math.round(attrs.brightness / 2.55) : (on ? 80 : 0);
        if (attrs.rgb_color && Array.isArray(attrs.rgb_color)) {
          const [r, g, b] = attrs.rgb_color;
          result.color = '#' + [r, g, b].map(c => c.toString(16).padStart(2, '0')).join('');
        } else {
          result.color = '#ff3300';
        }
      } else if (group === 'galaxy') {
        result.bri = (attrs.brightness != null) ? Math.round(attrs.brightness / 2.55) : (on ? 50 : 0);
      }

      return result;
    }

    function processStateUpdate(entityId, haState, bypassEcho) {
      const mapping = entityIndex.get(entityId);
      if (!mapping) return;

      if (!bypassEcho) {
        const pendingTs = pendingCommands.get(entityId);
        if (pendingTs && (Date.now() - pendingTs) < 2000) return;
      }

      const { roomId, group } = mapping;
      const groupEntities = rooms[roomId]?.[group];
      // TODO: per-bulb tracking. Right now we only propagate the first entity's
      // state and drop the rest, so every 3D bulb in a group renders identical.
      // Future: pass entityId through to stateCallbacks and let the scene map
      // each entity to its own mesh/light. Sidebar/controls stay group-level
      // (callService already targets the whole entity_id list).
      if (!groupEntities || groupEntities[0] !== entityId) return;

      const normalized = normalizeState(haState, group);
      stateCallbacks.forEach(cb => {
        try { cb(roomId, group, normalized); } catch (e) { console.warn('HAClient stateCb:', e); }
      });
    }

    // ---- WebSocket ----

    let getStatesId = null;

    // Race all candidate URLs as WebSocket connections — first to get auth_required wins.
    // No HTTP probe needed; WebSocket has no CORS preflight.
    function openWS(candidate, onWin, onLose) {
      const wsUrl = candidate.replace(/^http/, 'ws') + '/api/websocket';
      let sock;
      try { sock = new WebSocket(wsUrl); } catch(e) { onLose(); return null; }
      sock.onmessage = e => {
        try {
          const msg = JSON.parse(e.data);
          if (msg.type === 'auth_required') onWin(sock, candidate);
        } catch(_) {}
      };
      sock.onerror = () => {};
      sock.onclose = () => onLose();
      return sock;
    }

    function connect() {
      if (ws) return;
      clearTimeout(reconnectTimer);

      if (urls.length === 1) {
        // Single URL — open directly
        attachWS(new WebSocket(urls[0].replace(/^http/, 'ws') + '/api/websocket'), urls[0]);
        return;
      }

      // Race all URLs — first to get auth_required wins, others are closed
      let won = false;
      let loseCount = 0;
      const socks = [];
      urls.forEach(candidate => {
        const s = openWS(candidate, (winSock, winUrl) => {
          if (won) { winSock.close(); return; }
          won = true;
          url = winUrl;
          console.log('HAClient: connected via', url);
          setStatus('syncing');
          // Close all other racing sockets
          socks.forEach(other => { if (other !== winSock) try { other.close(); } catch(_){} });
          attachWS(winSock, winUrl, true);
        }, () => {
          loseCount++;
          if (!won && loseCount === urls.length) {
            setStatus('disconnected');
            scheduleReconnect();
          }
        });
        if (s) socks.push(s);
      });
    }

    function attachWS(sock, activeUrl, seenAuthRequired) {
      ws = sock;
      ws.onmessage = (event) => {
        let msg;
        try { msg = JSON.parse(event.data); } catch (e) { return; }

        if (msg.type === 'auth_required') {
          ws.send(JSON.stringify({ type: 'auth', access_token: token }));
        } else if (msg.type === 'auth_ok') {
          console.log('HAClient: Authenticated via', activeUrl);
          setStatus('syncing');
          stopPolling();
          const id = wsId++;
          getStatesId = id;
          wsSend({ id, type: 'get_states' });
          wsSend({ id: wsId++, type: 'subscribe_events', event_type: 'state_changed' });
        } else if (msg.type === 'auth_invalid') {
          console.error('HAClient: Auth failed');
          setStatus('auth_failed');
          ws.close();
        } else if (msg.type === 'result' && msg.id === getStatesId) {
          if (msg.success && Array.isArray(msg.result)) {
            msg.result.forEach(state => {
              if (entityIndex.has(state.entity_id)) processStateUpdate(state.entity_id, state, true);
              // Sensors are folded in from the SAME get_states snapshot, so a
              // room that is already occupied (or a door already open) is
              // correct on first paint rather than only after the sensor
              // happens to change.
              else if (sensorIndex.has(state.entity_id)) processSensorUpdate(state.entity_id, state);
            });
            setStatus('connected');
          } else {
            setStatus('sync_failed');
          }
          getStatesId = null;
        } else if (msg.type === 'event' && msg.event?.event_type === 'state_changed') {
          const { entity_id, new_state } = msg.event.data;
          if (!new_state) return;
          if (entityIndex.has(entity_id)) processStateUpdate(entity_id, new_state, false);
          else if (sensorIndex.has(entity_id)) processSensorUpdate(entity_id, new_state);
        }
      };
      ws.onclose = () => {
        ws = null;
        if (status !== 'auth_failed') { setStatus('disconnected'); scheduleReconnect(); }
      };
      ws.onerror = () => {};

      // Race path: the probe handler in openWS() already consumed the one-shot
      // `auth_required` message, so HA won't send it again. Authenticate now.
      if (seenAuthRequired) {
        try { ws.send(JSON.stringify({ type: 'auth', access_token: token })); } catch (_) {}
      }
    }

    function wsSend(data) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(data));
      }
    }

    function scheduleReconnect() {
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(() => {
        if (status !== 'auth_failed') connect();
      }, wsReconnectMs);
    }

    function disconnect() {
      clearTimeout(reconnectTimer);
      stopPolling();
      if (ws) { ws.onclose = null; ws.close(); ws = null; }
      setStatus('disconnected');
    }

    // ---- REST polling fallback ----

    function startPolling() {
      if (pollTimer) return;
      setStatus('polling');
      pollOnce();
      pollTimer = setInterval(pollOnce, pollIntervalMs);
    }

    function stopPolling() {
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    }

    async function pollOnce() {
      try {
        const resp = await fetch(url + '/api/states', {
          headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(5000)
        });
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const states = await resp.json();
        states.forEach(state => {
          if (entityIndex.has(state.entity_id)) {
            processStateUpdate(state.entity_id, state, false);
          } else if (sensorIndex.has(state.entity_id)) {
            // Safe to run on every poll tick: processSensorUpdate dispatches
            // only on an actual change, so a 5s poll against an unchanging
            // sensor costs a Map lookup and nothing else -- no render request.
            processSensorUpdate(state.entity_id, state);
          }
        });
      } catch (e) {
        console.warn('HAClient: Poll failed:', e.message);
      }
    }

    // ---- Service calls ----

    const debounceTimers = {};

    function callService(domain, service, data, target) {
      const entities = target.entity_id;
      const now = Date.now();
      (Array.isArray(entities) ? entities : [entities]).forEach(eid => {
        pendingCommands.set(eid, now);
        setTimeout(() => pendingCommands.delete(eid), 3000);
      });

      if (ws && ws.readyState === WebSocket.OPEN) {
        wsSend({ id: wsId++, type: 'call_service', domain, service, service_data: data, target });
      } else {
        fetch(url + '/api/services/' + domain + '/' + service, {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...data, ...target })
        }).catch(e => console.warn('HAClient: Service call failed:', e.message));
      }
    }

    function callServiceDebounced(domain, service, data, target, debounceKey, delayMs) {
      if (delayMs <= 0) { callService(domain, service, data, target); return; }
      clearTimeout(debounceTimers[debounceKey]);
      debounceTimers[debounceKey] = setTimeout(() => callService(domain, service, data, target), delayMs);
    }

    return {
      connect,
      disconnect,
      startPolling,
      onStateChange(cb) { stateCallbacks.push(cb); },
      // cb(roomId, occupied) / cb(doorId, open). Fired ONLY when the OR-ed
      // boolean for that target actually changes, never on an attribute-only
      // republish -- the consumer may safely request a render on every call.
      onPresenceChange(cb) { presenceCallbacks.push(cb); },
      onDoorChange(cb) { doorCallbacks.push(cb); },
      onStatusChange(cb) { statusCallbacks.push(cb); },
      // Test/diagnostic seam: drive a sensor without a live HA socket. Returns
      // true if the resolved boolean changed (and callbacks fired).
      _injectSensorState(entityId, state) {
        return processSensorUpdate(entityId, { state });
      },
      callService,
      callServiceDebounced,
      get status() { return status; },
      get activeUrl() { return url; }
    };
  }

  /**
   * One-shot REST fetch of current light states, normalized for Home3DScene.
   * Returns { roomId: { group: { on, bri, temp?, color? } } } or null on failure.
   */
  async function fetchInitialState(url, token, rooms, fallbackUrl) {
    // Try primary URL, then fallback if provided
    const candidates = [url, fallbackUrl].filter(Boolean);
    let resp = null;
    for (const candidate of candidates) {
      try {
        const r = await fetch(candidate + '/api/states', {
          headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(4000)
        });
        if (r.ok) { resp = r; break; }
      } catch (e) { /* try next */ }
    }
    try {
      if (!resp) return null;
      const states = await resp.json();

      // Build entity lookup
      const entityMap = new Map();
      states.forEach(s => entityMap.set(s.entity_id, s));

      const result = {};
      Object.entries(rooms).forEach(([roomId, groups]) => {
        result[roomId] = {};
        Object.entries(groups).forEach(([group, entities]) => {
          const haState = entityMap.get(entities[0]);
          if (!haState) return;
          const on = haState.state === 'on';
          const attrs = haState.attributes || {};
          const s = { on };

          if (group === 'main') {
            s.bri = (attrs.brightness != null) ? Math.round(attrs.brightness / 2.55) : (on ? 100 : 0);
            s.temp = (attrs.color_temp_kelvin != null) ? attrs.color_temp_kelvin : 4000;
          } else if (group === 'ambient') {
            s.bri = (attrs.brightness != null) ? Math.round(attrs.brightness / 2.55) : (on ? 80 : 0);
            if (attrs.rgb_color && Array.isArray(attrs.rgb_color)) {
              const [r, g, b] = attrs.rgb_color;
              s.color = '#' + [r, g, b].map(c => c.toString(16).padStart(2, '0')).join('');
            } else {
              s.color = '#ff3300';
            }
          } else if (group === 'galaxy') {
            s.bri = (attrs.brightness != null) ? Math.round(attrs.brightness / 2.55) : (on ? 50 : 0);
          }

          result[roomId][group] = s;
        });
      });
      return result;
    } catch (e) {
      return null;
    }
  }  // end fetchInitialState

  return { create, fetchInitialState };
})();
