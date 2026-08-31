/**
 * config-loader.js - resolves the app's runtime configuration.
 *
 * A no-build static app cannot read environment variables, so configuration
 * arrives by four different routes and this module decides between them. The
 * chain, HIGHEST PRIORITY FIRST:
 *
 *   1. ?haUrl=<url>          URL parameter. The embedder override.
 *   2. window.HOME3D_CONFIG  from config.js, generated at container start
 *                            from env vars by deploy/generate-config.sh.
 *   3. fetch('config.json')  a bind-mounted operator file. Gitignored.
 *   4. fetch('config.example.json')   the committed demo default.
 *
 * THE BOTTOM OF THE CHAIN ALWAYS WORKS. Tier 4 is committed to the repo, and
 * if even that fetch fails the module falls back to a hardcoded object built
 * into this file. A bare `git clone` followed by `python -m http.server` must
 * boot, select the demo house and report Home Assistant as disabled - not an
 * error page, not a blank canvas, not an uncaught exception. That is the
 * single acceptance criterion this module exists to guarantee: a stranger who
 * clones the repo gets a working app.
 *
 * Loaded as a classic (non-module) script, like every other file here. It
 * defines one global, `HomeConfig`.
 *
 *   await HomeConfig.load();      // resolve once; safe to call repeatedly
 *   const cfg = HomeConfig.get(); // synchronous accessor, after load()
 *
 * See docs/configuration.md for the operator-facing view.
 */

const HomeConfig = (() => {
  'use strict';

  // ---------------------------------------------------------------------
  // The last-resort default.
  //
  // This is tier 4's tier 4. config.example.json is committed and should
  // always be fetchable, but "should" is not "will": someone may deploy a
  // subset of the tree, or serve from a path where the fetch 404s. Rather
  // than let that become a blank screen, the same shape is inlined here.
  //
  // Home Assistant off, demo house, sane timings. Deliberately no URL and no
  // token - there is no sensible default for either, and inventing one would
  // point a stranger's browser at somebody else's host.
  // ---------------------------------------------------------------------
  const BUILTIN_DEFAULT = Object.freeze({
    version: 'dev',
    enabled: false,
    url: '',
    fallbackUrl: '',
    token: '',
    house: 'demo',
    wsReconnectMs: 5000,
    pollIntervalMs: 5000
  });

  const CONFIG_JSON_URL = 'config.json';
  const CONFIG_EXAMPLE_URL = 'config.example.json';

  // Resolved state. `resolved` is what get() returns; `loadPromise` makes
  // load() idempotent so several call sites can await it without racing.
  let resolved = null;
  let loadPromise = null;

  // ---------------------------------------------------------------------
  // Normalisation
  //
  // Every tier produces a partial object of unknown quality - a hand-edited
  // config.json is the most likely source of a typo in the whole system. This
  // coerces each field to the right type and range, so nothing downstream has
  // to defend itself. A bad value is warned about and replaced, never thrown
  // on: a mistyped poll interval should not take the app down.
  // ---------------------------------------------------------------------

  function asString(value, fallback) {
    if (typeof value === 'string') return value;
    if (value === null || value === undefined) return fallback;
    return String(value);
  }

  function asPositiveInt(value, fallback, label) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) {
      if (value !== undefined && value !== null && value !== '') {
        console.warn(
          '[HomeConfig] ' + label + ' is not a positive number (' +
          JSON.stringify(value) + '); using ' + fallback + '.'
        );
      }
      return fallback;
    }
    return Math.round(n);
  }

  function asBoolean(value, fallback) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      const v = value.trim().toLowerCase();
      if (v === 'true' || v === '1' || v === 'yes' || v === 'on') return true;
      if (v === 'false' || v === '0' || v === 'no' || v === 'off' || v === '') return false;
    }
    if (typeof value === 'number') return value !== 0;
    return fallback;
  }

  // A house id joins config to houses/<id>/. It becomes a URL path segment, so
  // it is constrained to the same character class the house schema uses. This
  // is a path-traversal guard as much as a validation: `house` can arrive from
  // a hand-edited JSON file or (in future) a URL parameter.
  const HOUSE_ID_RE = /^[a-z][a-z0-9_-]*$/;

  // ---------------------------------------------------------------------
  // The version, and the unstamped-placeholder case.
  //
  // deploy/generate-config.sh replaces every __VERSION__ in index.html with
  // APP_VERSION at container start, and writes the same value into config.js.
  // One source, so the badge and every ?v= cache-buster are identical by
  // construction rather than by anyone remembering to keep them in step.
  //
  // But the entrypoint only runs in the container. Someone who clones the repo
  // and runs `python -m http.server` never executes it, so they get the raw
  // placeholder: a badge reading "v__VERSION__" and script URLs ending
  // "?v=__VERSION__". That is functionally FINE - the placeholder is a
  // perfectly good constant cache key, identical across every tag - but it
  // reads as a broken build to anyone seeing the repo for the first time,
  // which is exactly the audience a public repo has.
  //
  // So an unsubstituted placeholder normalises to 'dev' - the same word the
  // entrypoint uses when APP_VERSION is unset, so the two paths agree. The
  // badge is repaired in the DOM (see stampVersionIntoDom below); the ?v=
  // query strings are deliberately LEFT ALONE, because rewriting a script URL
  // after the browser has already fetched it would re-request every asset for
  // no benefit.
  // ---------------------------------------------------------------------
  const VERSION_PLACEHOLDER = '__' + 'VERSION' + '__';

  function asHouseId(value, fallback) {
    const s = asString(value, '').trim();
    if (!s) return fallback;
    if (!HOUSE_ID_RE.test(s)) {
      console.warn(
        '[HomeConfig] house id ' + JSON.stringify(s) + ' is not valid ' +
        '(lowercase letters, digits, _ and -, starting with a letter); ' +
        'using "' + fallback + '".'
      );
      return fallback;
    }
    return s;
  }

  /**
   * Resolve a version string, mapping the unsubstituted build placeholder to
   * 'dev'. Anything else is passed through trimmed - the value is stamped from
   * APP_VERSION and is not this module's to validate.
   */
  function asVersion(value, fallback) {
    const s = asString(value, '').trim();
    if (!s) return fallback;
    if (s === VERSION_PLACEHOLDER) return fallback;
    return s;
  }

  /**
   * Fold a raw config object from any tier onto the built-in defaults.
   * Unknown keys are preserved: a house profile or a future field can ride
   * along without this module needing to know about it.
   */
  function normalise(raw) {
    const src = (raw && typeof raw === 'object') ? raw : {};
    const out = Object.assign({}, src);

    out.version = asVersion(src.version, BUILTIN_DEFAULT.version);
    out.url = asString(src.url, BUILTIN_DEFAULT.url).trim();
    out.fallbackUrl = asString(src.fallbackUrl, BUILTIN_DEFAULT.fallbackUrl).trim();
    out.token = asString(src.token, BUILTIN_DEFAULT.token);
    out.house = asHouseId(src.house, BUILTIN_DEFAULT.house);
    out.wsReconnectMs = asPositiveInt(
      src.wsReconnectMs, BUILTIN_DEFAULT.wsReconnectMs, 'wsReconnectMs');
    out.pollIntervalMs = asPositiveInt(
      src.pollIntervalMs, BUILTIN_DEFAULT.pollIntervalMs, 'pollIntervalMs');

    // `enabled` is intentionally the last word, and it is conservative. Even
    // where a tier says enabled:true, a connection is impossible without both
    // a URL and a token - so rather than let the app fail at runtime with a
    // red status dot and repeated failing requests, it is downgraded here and
    // the reason is logged once. Same rule the entrypoint applies server-side;
    // enforcing it in both places means neither can be the single point that
    // gets it wrong.
    const wants = asBoolean(src.enabled, BUILTIN_DEFAULT.enabled);
    const canConnect = out.url !== '' && out.token !== '';
    out.enabled = wants && canConnect;

    if (wants && !canConnect) {
      const missing = [];
      if (out.url === '') missing.push('url');
      if (out.token === '') missing.push('token');
      console.warn(
        '[HomeConfig] Home Assistant is configured as enabled but ' +
        missing.join(' and ') + ' ' + (missing.length > 1 ? 'are' : 'is') +
        ' empty, so it has been DISABLED. The house will render without live ' +
        'light state. Set HOME3D_HA_URL and HOME3D_HA_TOKEN (or the ' +
        'equivalent keys in config.json) to enable it.'
      );
    }

    return out;
  }

  // ---------------------------------------------------------------------
  // Tier 1 - the ?haUrl= URL parameter
  //
  // PRESERVE THESE SEMANTICS EXACTLY. This parameter is not a convenience; it
  // is load-bearing for the Home Assistant embed, which injects
  // location.origin so the iframe talks to the HA instance that is serving it
  // rather than to whatever hostname the deployment happens to know about.
  //
  // The critical part - and the reason this is not just "another way to set
  // url" - is that when haUrl is present it is used ALONE. No fallbackUrl, no
  // race between two candidate URLs. The embedder has stated authoritatively
  // which origin to use; racing it against a deployment default could send the
  // token to a host the embedder did not name, and would produce a connection
  // that works in testing and fails in the frame.
  //
  // Any other absolute URL is accepted, but the protocol is restricted to
  // http/https: the resolved url is where the token gets sent, so a javascript:
  // or data: value must never reach the HA client.
  // ---------------------------------------------------------------------
  function readHaUrlParam() {
    let raw;
    try {
      raw = new URLSearchParams(window.location.search).get('haUrl');
    } catch (e) {
      return null;
    }
    if (!raw) return null;

    const value = raw.trim();
    if (!value) return null;

    let parsed;
    try {
      parsed = new URL(value, window.location.href);
    } catch (e) {
      console.warn(
        '[HomeConfig] ?haUrl=' + JSON.stringify(value) +
        ' is not a valid URL; ignoring it.'
      );
      return null;
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      console.warn(
        '[HomeConfig] ?haUrl uses the ' + parsed.protocol + ' scheme. Only ' +
        'http and https are accepted, because the access token is sent to ' +
        'this origin. Ignoring it.'
      );
      return null;
    }

    // Trailing slash removed so callers can concatenate paths predictably;
    // this matches what the previous inline bootstrap did with the value.
    return parsed.href.replace(/\/+$/, '');
  }

  // ---------------------------------------------------------------------
  // Tiers 3 and 4 - fetched JSON
  //
  // A missing file is the NORMAL case for config.json, not an error: most
  // deployments never create one. So a failed fetch resolves to null quietly
  // and the chain moves on. Only a file that exists but does not parse is
  // worth a warning - that is a real operator mistake and silently ignoring it
  // would be the worst outcome (their settings would simply not apply, with no
  // clue why).
  // ---------------------------------------------------------------------
  async function fetchJson(url) {
    let response;
    try {
      response = await fetch(url, { cache: 'no-store' });
    } catch (e) {
      return { ok: false, reason: 'unreachable', data: null };
    }
    if (!response.ok) {
      return { ok: false, reason: 'http ' + response.status, data: null };
    }
    try {
      const data = await response.json();
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        console.warn(
          '[HomeConfig] ' + url + ' parsed but is not a JSON object; ignoring it.'
        );
        return { ok: false, reason: 'not an object', data: null };
      }
      return { ok: true, reason: null, data: data };
    } catch (e) {
      console.warn(
        '[HomeConfig] ' + url + ' exists but is not valid JSON, so it has been ' +
        'ignored and the next configuration source is being used. Parse error: ' +
        e.message
      );
      return { ok: false, reason: 'invalid json', data: null };
    }
  }

  // ---------------------------------------------------------------------
  // stampVersionIntoDom - the non-container half of the version story.
  //
  // WHY THIS EXISTS AT ALL. The container path is already correct: the
  // entrypoint substitutes __VERSION__ everywhere before nginx starts, so a
  // deployed page never contains a placeholder. This function is for the OTHER
  // path - a bare checkout served by `python -m http.server`, which is how the
  // README tells a stranger to try the app, and how every contributor runs it.
  //
  // Without it that reader sees a badge reading literally "v__VERSION__".
  // Nothing is broken - it is one consistent cache key across all six script
  // tags - but it looks like a build that failed, and a public repo's first
  // impression is worth more than the four lines this costs.
  //
  // WHAT IT DELIBERATELY DOES NOT DO. It does not touch the ?v= query strings.
  // By the time this runs the browser has already requested those URLs;
  // rewriting them would force a second fetch of every asset to change a
  // cache key that was already doing its job. The placeholder is a valid
  // cache key - it just is not a pretty one, and only the visible badge is
  // seen by a human.
  //
  // It is also a no-op on a stamped page: the text only changes if the
  // placeholder is actually still there. So the container path is untouched,
  // and this cannot itself become a source of drift - it has no version of
  // its own, it only ever writes the one value the config chain resolved.
  // ---------------------------------------------------------------------
  function stampVersionIntoDom(version) {
    if (typeof document === 'undefined' || !version) return;

    const apply = () => {
      try {
        const status = document.getElementById('ha-status');
        if (!status) return;
        // Walk the text nodes rather than matching a selector or a class: the
        // badge is an unlabelled <span> inside #ha-status and giving this
        // function a structural dependency on that markup would make an
        // unrelated edit to index.html silently disable it.
        const walker = document.createTreeWalker(status, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
          if (node.nodeValue && node.nodeValue.indexOf(VERSION_PLACEHOLDER) !== -1) {
            node.nodeValue = node.nodeValue.split(VERSION_PLACEHOLDER).join(version);
          }
        }
      } catch (e) {
        // Cosmetic only. A failure here must never affect the app.
      }
    };

    // config-loader.js is a blocking script in <head>-order terms but the
    // badge markup sits above it in the body, so it is normally present
    // already. readyState is checked anyway rather than assumed.
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', apply, { once: true });
    } else {
      apply();
    }
  }

  // ---------------------------------------------------------------------
  // The resolver
  // ---------------------------------------------------------------------

  async function resolve() {
    // Tiers 2-4 supply the base object; tier 1 is an override applied on top,
    // because ?haUrl= sets one field, not a whole configuration.
    let base = null;
    let source = null;
    let sourceDetail = null;

    // --- Tier 2: window.HOME3D_CONFIG (generated config.js) ---
    if (typeof window !== 'undefined' &&
        window.HOME3D_CONFIG &&
        typeof window.HOME3D_CONFIG === 'object') {
      base = window.HOME3D_CONFIG;
      source = 'window.HOME3D_CONFIG';
      sourceDetail = 'generated config.js (environment variables)';
    }

    // --- Tier 3: config.json ---
    if (!base) {
      const result = await fetchJson(CONFIG_JSON_URL);
      if (result.ok) {
        base = result.data;
        source = CONFIG_JSON_URL;
        sourceDetail = 'operator config file';
      }
    }

    // --- Tier 4: config.example.json (committed) ---
    if (!base) {
      const result = await fetchJson(CONFIG_EXAMPLE_URL);
      if (result.ok) {
        base = result.data;
        source = CONFIG_EXAMPLE_URL;
        sourceDetail = 'committed demo default';
      }
    }

    // --- Tier 4b: the built-in. The chain cannot end here in failure. ---
    if (!base) {
      base = BUILTIN_DEFAULT;
      source = 'built-in default';
      sourceDetail = 'no configuration file was reachable';
      console.warn(
        '[HomeConfig] No configuration source could be loaded - not ' +
        'config.js, not config.json, not config.example.json. Falling back ' +
        'to the built-in default: the demo house with Home Assistant ' +
        'disabled. The app will run; it just has nothing to connect to.'
      );
    }

    const config = normalise(base);

    // --- Tier 1: ?haUrl= override, applied last so it wins ---
    const haUrlParam = readHaUrlParam();
    if (haUrlParam) {
      config.url = haUrlParam;
      // THE fallbackUrl IS CLEARED ON PURPOSE. See readHaUrlParam's comment:
      // an explicit haUrl means "use exactly this", and leaving a fallback in
      // place would let the client race a second host it was never told to
      // talk to. This one line is the whole reason tier 1 is an override
      // rather than just another config source.
      config.fallbackUrl = '';
      config.haUrlOverride = true;
      // The override supplies a URL but never a token; a token from a lower
      // tier still applies, and enabled is recomputed against the new pair.
      config.enabled = config.token !== '';
      source = '?haUrl= (over ' + source + ')';
      sourceDetail = 'embedder override - fallbackUrl deliberately not used';
    } else {
      config.haUrlOverride = false;
    }

    config.source = source;

    // ---------------------------------------------------------------------
    // Tell the operator where their configuration came from.
    //
    // This costs one console line and repeatedly saves the "why is it not
    // picking up my settings" conversation, which is otherwise close to
    // undiagnosable from the outside: four sources, silent fallback between
    // them, and a symptom (HA not connecting) identical across all four.
    // ---------------------------------------------------------------------
    console.info(
      '[HomeConfig] configuration source: ' + source +
      ' (' + sourceDetail + ')  house=' + config.house +
      '  version=' + config.version +
      '  homeAssistant=' + (config.enabled ? 'enabled' : 'disabled')
    );

    // Repair an unstamped badge on the non-container path. No-op otherwise.
    stampVersionIntoDom(config.version);

    return config;
  }

  /**
   * Resolve the configuration. Idempotent: the first call does the work, later
   * calls await the same promise and get the same object.
   *
   * Never rejects. A failure anywhere in the chain degrades to the built-in
   * default rather than propagating, because there is no useful thing a
   * caller could do with a rejection except show a blank page.
   *
   * @returns {Promise<object>} the resolved config.
   */
  function load() {
    if (!loadPromise) {
      loadPromise = resolve()
        .catch(err => {
          console.error(
            '[HomeConfig] configuration resolution failed unexpectedly; ' +
            'falling back to the built-in default.', err
          );
          return normalise(BUILTIN_DEFAULT);
        })
        .then(config => {
          resolved = config;
          return config;
        });
    }
    return loadPromise;
  }

  /**
   * The resolved config, synchronously. Returns null before load() completes.
   * Intended for code that runs after the app has booted and does not want to
   * thread a promise through.
   */
  function get() {
    return resolved;
  }

  /** True once load() has completed. */
  function isLoaded() {
    return resolved !== null;
  }

  /**
   * Reset the memoised result. Test-support only; nothing in the app calls it.
   */
  function reset() {
    resolved = null;
    loadPromise = null;
  }

  return {
    load: load,
    get: get,
    isLoaded: isLoaded,
    reset: reset,
    BUILTIN_DEFAULT: BUILTIN_DEFAULT
  };
})();

// Expose on window as well as the bare global, so an embedder or a console
// user can reach it by name without relying on classic-script scoping rules.
if (typeof window !== 'undefined') {
  window.HomeConfig = HomeConfig;
}
