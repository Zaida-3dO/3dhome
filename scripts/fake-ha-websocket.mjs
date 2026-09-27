/**
 * A fake Home Assistant WebSocket API for the node tests -- NOT a test itself.
 *
 * src/ha-client.js talks to Home Assistant over /api/websocket ONLY (see
 * "Transport" in that file). The tests that used to drive its command path
 * through the REST fallback -- a mocked `fetch` -- now drive the real
 * WebSocket path instead, against this.
 *
 * installFakeHA({ states, holdAuth }) replaces globalThis.WebSocket with a
 * fake that plays HA's side of the handshake:
 *
 *   server: auth_required  ->  client: auth  ->  server: auth_ok
 *   client: get_states     ->  server: result (the `states` passed in)
 *   client: subscribe_events -> server: result
 *   client: call_service   ->  recorded, server: result
 *
 * and replaces globalThis.fetch with a recorder, so a test can assert that
 * NOTHING went over REST. Everything is asynchronous, like a real socket.
 *
 * Recorded commands keep the shape the REST-era assertions used --
 * { service: '<domain>/<service>', body: { ...service_data, ...target } } --
 * plus the raw message, so those assertions carry over unchanged.
 *
 * holdAuth: true stops after auth_required (the socket is OPEN but not yet
 * authenticated) until releaseAuth() is called.
 */
export function installFakeHA({ states = [], holdAuth = false } = {}) {
  const realWS = globalThis.WebSocket;
  const realFetch = globalThis.fetch;
  const calls = [];        // call_service commands, in order
  const sent = [];         // every client -> server message, in order
  const fetches = [];      // every fetch() the code under test attempted
  const sockets = [];
  let authHeld = holdAuth;
  const pendingAuth = [];

  class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    constructor(url) {
      this.url = url;
      this.readyState = FakeWebSocket.CONNECTING;
      this.onmessage = null;
      this.onclose = null;
      this.onerror = null;
      sockets.push(this);
      setTimeout(() => {
        if (this.readyState !== FakeWebSocket.CONNECTING) return;
        this.readyState = FakeWebSocket.OPEN;
        this._deliver({ type: 'auth_required', ha_version: 'fake' });
      }, 0);
    }
    _deliver(msg) {
      setTimeout(() => {
        if (this.readyState === FakeWebSocket.OPEN && this.onmessage) {
          this.onmessage({ data: JSON.stringify(msg) });
        }
      }, 0);
    }
    send(text) {
      if (this.readyState !== FakeWebSocket.OPEN) throw new Error('fake WS: send while not OPEN');
      const msg = JSON.parse(text);
      sent.push(msg);
      if (msg.type === 'auth') {
        if (authHeld) pendingAuth.push(this);
        else this._deliver({ type: 'auth_ok', ha_version: 'fake' });
      } else if (msg.type === 'get_states') {
        this._deliver({ id: msg.id, type: 'result', success: true, result: states });
      } else if (msg.type === 'call_service') {
        calls.push({
          service: msg.domain + '/' + msg.service,
          body: { ...(msg.service_data || {}), ...(msg.target || {}) },
          msg
        });
        this._deliver({ id: msg.id, type: 'result', success: true, result: null });
      } else {
        this._deliver({ id: msg.id, type: 'result', success: true, result: null });
      }
    }
    close() {
      if (this.readyState === FakeWebSocket.CLOSED) return;
      this.readyState = FakeWebSocket.CLOSED;
      setTimeout(() => { if (this.onclose) this.onclose({}); }, 0);
    }
    /** Push a state_changed event, as HA does for a live change. */
    emitStateChanged(newState) {
      this._deliver({ type: 'event', event: { event_type: 'state_changed',
        data: { entity_id: newState.entity_id, new_state: newState } } });
    }
  }

  globalThis.WebSocket = FakeWebSocket;
  globalThis.fetch = async (url, opts) => {
    fetches.push({ url: String(url), method: (opts && opts.method) || 'GET' });
    throw new Error('fake HA: fetch() is not a Home Assistant transport (' + url + ')');
  };

  return {
    calls,
    sent,
    fetches,
    sockets,
    /** Resolves once `ha` reports status `connected` (auth + snapshot done). */
    whenConnected(ha, timeoutMs = 2000) {
      return new Promise((resolve, reject) => {
        if (ha.status === 'connected') { resolve(); return; }
        const t = setTimeout(() => reject(new Error('fake HA: never connected (status ' + ha.status + ')')), timeoutMs);
        ha.onStatusChange(s => { if (s === 'connected') { clearTimeout(t); resolve(); } });
      });
    },
    releaseAuth() {
      authHeld = false;
      pendingAuth.splice(0).forEach(s => s._deliver({ type: 'auth_ok', ha_version: 'fake' }));
    },
    restore() {
      globalThis.WebSocket = realWS;
      globalThis.fetch = realFetch;
    }
  };
}
