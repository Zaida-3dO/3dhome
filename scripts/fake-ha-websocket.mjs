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
 *
 * respond(msg): optional, consulted for every command other than auth and
 * get_states (call_service included, return_response or not; and
 * config_entries/get, ...). Return undefined for the default (success,
 * result null); { result } to answer with that result -- for a
 * return_response call that is { context, response }; { error: { code,
 * message } } to fail it as HA does (success: false); { hold: true } to
 * never answer (a timeout); or a Promise of any of these to answer later
 * (out of order, for the stale-response tests). Commands are recorded in
 * `calls` / `sent` exactly as before whatever it returns.
 *
 * NO REAL HOME ASSISTANT, MECHANICALLY. Tests drive a client that can play
 * audio and move curtains in a real home, so "only ever use the fake" is not
 * left to prose:
 *   - the fake refuses (throws) a socket to any URL that is not the fake's
 *     own: a host under the reserved `.invalid` TLD (RFC 2606), which can
 *     never resolve -- every test uses http://ha.invalid;
 *   - importing this module replaces the runtime's own WebSocket with one
 *     that refuses EVERY URL, and restore() puts that refusing one back, not
 *     the real one. A test that imports the fake cannot open a real socket
 *     before installing it or after restoring it.
 * scripts/test-sound-menu.mjs pins both.
 */

/** The only URLs a test may open a socket to: ws(s)://<anything>.invalid. */
export function isFakeHaUrl(url) {
  try {
    const u = new URL(String(url));
    return (u.protocol === 'ws:' || u.protocol === 'wss:') && /\.invalid$/i.test(u.hostname);
  } catch (e) {
    return false;
  }
}

function refuse(url, why) {
  throw new Error('fake HA: refused a WebSocket to ' + url + ' -- ' + why +
    '. Tests may only talk to the fake Home Assistant (installFakeHA, url http://ha.invalid).');
}

/** What globalThis.WebSocket is whenever the fake is NOT installed. */
export class RefusedWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  constructor(url) { refuse(url, 'the fake is not installed'); }
}
globalThis.WebSocket = RefusedWebSocket;

export function installFakeHA({ states = [], holdAuth = false, respond = null } = {}) {
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
      if (!isFakeHaUrl(url)) refuse(url, 'not the fake HA host (a .invalid name)');
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
        this._answer(msg);
      } else {
        this._answer(msg);
      }
    }
    _answer(msg) {
      const out = respond ? respond(msg) : undefined;
      const deliver = r => {
        if (r && r.hold) return;
        if (r && r.error) this._deliver({ id: msg.id, type: 'result', success: false, error: r.error });
        else this._deliver({ id: msg.id, type: 'result', success: true, result: r && 'result' in r ? r.result : null });
      };
      if (out && typeof out.then === 'function') out.then(deliver);
      else deliver(out);
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
      globalThis.WebSocket = RefusedWebSocket;
      globalThis.fetch = realFetch;
    }
  };
}
