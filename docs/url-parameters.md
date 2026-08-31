# URL parameters

The viewer is configured entirely by query string. This document is the **frozen
contract**: these parameters have live embedders (a dashboard sidebar tile and a
Home Assistant tablet dashboard) that break silently if a name or a default
changes. Treat any change here as a breaking change.

All values are read from `window.location.search`. Every parameter is optional
except where noted. Unknown parameters are ignored.

> Hostnames in this document are placeholders (`example.com`). Substitute your
> own deployment origin.

---

## Quick reference

| Parameter | Values | Default | Summary |
|---|---|---|---|
| [`preview`](#preview) | `true` | off | Chrome-less auto-rotating thumbnail mode |
| [`embed`](#embed) | `1` \| `true` | off | Interactive, page chrome hidden |
| [`haUrl`](#haurl) | absolute http/https URL | unset | Home Assistant origin override |
| [`parentOrigin`](#parentorigin) | origin / absolute URL | unset | Pins the embedder allowed to drive the visibility channel |
| [`house`](#house) | house profile id | `demo` | Which house profile to render |
| [`rotateSpeed`](#rotatespeed) | float, rad/s | `2π/120` | Preview rotation speed |
| [`camera`](#camera) | preset name | unset | Initial camera pose |
| [`shadows`](#shadows) | `auto` \| `low` \| `off` | mode-dependent | Shadow quality |
| [`fps`](#fps) | integer | `15` preview / `60` else | Frame-rate cap |
| [`debug`](#debug) | `1` | off | Eruda mobile DevTools + error banner |
| [`debugWalls`](#debugwalls) | `1` \| `true` | off | Wall-number overlay |
| [`grid`](#grid) | `1` \| `true` | off | Coordinate grid overlay |
| [`proposed`](#proposed) | — | — | **Removed. No-op.** |
| [`debugDoors`](#debugdoors) | `1` \| `true` | off | Door-number overlay |
| [`_`](#_-cache-bust) | any token | unset | Cache-bust; **must be session-stable** |

---

## Modes

### `preview`

`?preview=true` — the only accepted value; anything else is off.

A small, non-interactive, continuously auto-rotating thumbnail, designed to sit
in a sidebar tile. It:

- hides `.back-btn`, `.title-overlay`, `.room-tooltip`, `.top-right-btns` and
  `.panel`;
- **keeps the HA status dot** (`#ha-status`) as a tiny health indicator —
  colour only, with its text children and version badge hidden, and its
  background/backdrop/padding stripped. It is shown from the start so the
  colour transition is visible as HA connects;
- sets `body.background` to `transparent`, so the host tile's own background
  shows through;
- forces `pixelRatio` to `1` and disables antialiasing;
- defaults `shadows` to `low` and `fps` to `15`.

It also **suppresses the favicon `<link>`** — see [Favicon suppression](#favicon-suppression).

Preview mode is the only mode in which [`rotateSpeed`](#rotatespeed) has any
effect, and the only mode that **ignores** [`camera`](#camera).

### `embed`

`?embed=1` or `?embed=true`.

Fully interactive — orbit, room selection and the Light Controls panel all work
— but page chrome is hidden (`.back-btn`, `.title-overlay`, `.room-tooltip`) so
it sits cleanly inside a dashboard pop-up iframe.

Defaults `shadows` to `high`, which always includes the full set of room shadow
lights; on-demand rendering keeps this near-free while idle and only reaches
60 fps while the user is moving the camera.

It also **suppresses the favicon `<link>`** — see below.

### Favicon suppression

Both `preview` and `embed` deliberately skip inserting the
`<link rel="icon" href="assets/icons/favicon.png">` tag. This is **not** an
oversight and must not be "fixed".

The embedded modes run as iframes inside Home Assistant, where the mirrored copy
of the app does not ship `assets/icons/` — that directory is excluded from the
deploy mirror because HA's Samba addon vetoes 5-character `icon?` filenames
(`veto_files: icon?`), which would make the file invisible over Samba. Requesting
the favicon there would simply 404 on every load. Inserting the `<link>`
conditionally avoids that.

See `deploy/post-commit` for the mirroring rules and the matching exclude.

---

## Home Assistant

### `haUrl`

`?haUrl=<absolute-url>` — an absolute `http:` or `https:` URL.

Overrides the Home Assistant origin the viewer connects to, for both the initial
state fetch and the WebSocket.

**This parameter disables the fallback race entirely.** Normally the loader has
a configured `url` and `fallbackUrl` and races them to connect. When `haUrl` is
set, `fallbackUrl` is **cleared** and only this URL is used. That is deliberate:
the embedder has stated authoritatively which origin to use, and racing it
against a deployment default could send the access token to a host the embedder
never named — producing a connection that works in testing and fails in the
frame.

**It is mandatory for cross-origin embeds.** An iframe served from a different
origin than its host cannot infer the host's HA origin, so an embedder must pass
it explicitly:

```
https://home3d.example.com/?preview=true&haUrl=https://homeassistant.example.com
```

Validation (in `src/config-loader.js`, **not** in `index.html` — by the time
`cfg.url` is read the override is already folded in; do not re-apply it):

- resolved against `window.location.href`, so a relative value is accepted;
- **protocol restricted to `http:`/`https:`** — the access token is sent to this
  origin, so a `javascript:` or `data:` value must never reach the HA client.
  A rejected value logs a warning and is ignored;
- an unparseable value logs a warning and is ignored;
- trailing slashes are stripped so callers can concatenate paths predictably.

---

### `house`

`?house=<id>` — the id of a profile directory under `houses/`.

Selects which house to render, overriding `HOME3D_HOUSE` and any `config.json`
value. Useful for showing several houses from one deployment, and for a reviewer
who wants a specific profile without restarting the container.

```
https://home3d.example.com/?house=cottage
```

It is independent of [`haUrl`](#haurl): which house to draw and which Home
Assistant to talk to are separate questions, and an embedder may set either
without the other.

Validation (in `src/config-loader.js`):

- the id must match `[a-z][a-z0-9_-]*` — lowercase, starting with a letter;
- **this is a path-traversal guard, not only a style rule.** The id becomes a
  URL path segment (`houses/<id>/geometry.json`), so a value containing `..`,
  `/` or an encoded slash fails the character class and is rejected;
- a rejected value logs a warning and falls back to the configured house, so a
  mistyped link degrades to the normal view rather than a broken app;
- naming a profile that does not exist is **not** an error here — the house
  loader reports it and falls back to `demo`.

---

### `parentOrigin`

`?parentOrigin=<origin>` — an origin (`https://dashboard.example.com`) or any
absolute `http:`/`https:` URL, from which the origin is taken.

Declares which embedder is allowed to drive the [off-screen pause
channel](#off-screen-pause-cross-origin). When set, **only** that exact origin is
accepted and no handshake can change it.

**Pass it whenever you embed cross-origin.** Without it the viewer falls back to
*trust-on-first-use*: the first page to complete the handshake pins itself. Since
a page that frames the viewer genuinely *is* `window.parent`, a hostile framer
that handshakes first can pin itself and pause the render loop.

The blast radius is small and worth stating plainly: `setActive()` is the only
capability the channel exposes — no scene mutation, no configuration, no HA
access — so the worst case is a decorative tile that stops animating, not data
exposure. But it costs one parameter to close off, so close it off.

Invalid or non-http(s) values log a warning and are ignored, which falls back to
trust-on-first-use.

---

## Appearance and performance

### `rotateSpeed`

`?rotateSpeed=<radians-per-second>` — a float.

**Only takes effect with `?preview=true`**, because auto-rotation is off in every
other mode. Default is `(2 * Math.PI) / 120` — one turn every 2 minutes
(≈0.0524 rad/s).

To convert from seconds-per-turn: `rad/s = (2 * Math.PI) / seconds_per_turn`.

| Value | Effect |
|---|---|
| *(unset)* | 2 min/turn (≈0.0524) |
| `0.1047` | 1 min/turn |
| `0.01745` | 6 min/turn |
| `0` | Frozen — no rotation |

A non-finite value falls back to the default. Note that `Home3DScene.create()`'s
own internal default differs (`0.024` rad/s, ≈262 s/turn) and applies only when
no `rotateSpeed` is passed at all by a programmatic caller.

### `camera`

`?camera=<preset>` — jumps the orbit camera to a named view on load.

This exists so visual-review agents can reach a useful angle without driving
OrbitControls through synthetic mouse events, which the custom orbit camera
resists.

Presets (defined as `CAMERA_PRESETS` in the scene engine):

| Preset | View |
|---|---|
| `top`, `topdown` | Straight top-down floor-plan |
| `front` | North / entrance elevation |
| `back`, `east`, `west` | The other three elevations |
| `se`, `sw`, `ne`, `nw` | The four corner ¾ aerial views |
| `iso` | Default ¾ isometric-ish |

Two semantics that are easy to get wrong:

- **It only sets the INITIAL pose.** The user can orbit and pan freely
  afterwards; nothing re-applies it.
- **It is ignored in `?preview=true`**, which auto-rotates from its own pose.

An unknown or absent value leaves the default view unchanged. Applied *after*
scene creation.

### `shadows`

`?shadows=auto|low|off`.

Defaults are per-mode and were chosen deliberately: the preview tile previously
rendered the full scene (10 shadow-casting lights, antialiasing, dpr 2) at the
display's full refresh rate forever — a constant GPU furnace.

| Mode | Default | Meaning |
|---|---|---|
| `?preview=true` | `low` | Sun shadow at 512², no room-shadow lights — a soft grounded drop shadow, near-negligible at 15 fps, with no 10-cubemap room-light passes |
| `?embed=1` | `high` | Always the full set including the 10 room-shadow lights |
| standalone | `auto` | The best the device can do when viewed directly |

An explicit `?shadows=` value overrides the mode default in every mode.

### `fps`

`?fps=<integer>` — caps the render loop.

Defaults to `15` in preview mode and `60` otherwise. A non-integer value falls
back to that default. Combined with `?shadows=`, this is the A/B knob for power
and quality tuning.

### `_` (cache bust)

`?_=<token>` — an arbitrary token, ignored by the app itself. Its only purpose is
to make the URL unique so a host forces a fresh load rather than reusing a cached
iframe document.

> **The token must be session-stable, not per-render.**
>
> Embedders that regenerate it on every render — a template re-evaluated on each
> state change, `Date.now()` inlined in a card config — change the iframe `src`
> on every re-render, which tears down and **rebuilds the entire WebGL scene**
> each time. Compute it once per session (or per deploy) and reuse that value.

---

## Debug parameters

All four are off by default and are dev tools; none should appear in a
production embed URL.

### `debug`

`?debug=1` — the only accepted value.

Loads [Eruda](https://github.com/liriliri/eruda) (mobile DevTools) from a CDN and
shows a floating icon for console/network/elements. It also installs a
`window.onerror` + `unhandledrejection` listener that paints a red banner at the
top of the page, so failures are visible **before** Eruda loads and even if Eruda
itself fails to load.

### `debugWalls`

`?debugWalls=1` or `?debugWalls=true`. Wall-numbering overlay — yellow sprite
labels at each wall's ID, repeated along its length. Also reachable from the
Settings sidebar's "Wall numbers" switch, or `Shift+D`.

### `grid`

`?grid=1` or `?grid=true`. Coordinate grid overlay with axis labels (`x=650`,
`y=400`) drawn as camera-facing sprites with `depthTest: false`, so they stay
legible through geometry from any orbit angle.

### `debugDoors`

`?debugDoors=1` or `?debugDoors=true`. Door-numbering overlay, in a cyan accent
to distinguish it from the yellow wall labels. Also reachable from the Settings
sidebar's "Door numbers" switch.

### `proposed`

**Removed — this parameter is a no-op in the public app.**

It previously toggled a "proposed renovation" overlay. That overlay depicted a
real, specific renovation of a real home and was deliberately left behind when
the viewer was extracted into this public repository. Passing `?proposed=1` does
nothing at all; no code reads it.

It is documented here rather than omitted so that an old bookmark, dashboard
card or saved URL carrying it can be explained rather than mistaken for a bug.

---

## Embedding the preview tile

A cross-origin host embeds the tile like this:

```html
<iframe
  src="https://home3d.example.com/?preview=true&haUrl=https://homeassistant.example.com&parentOrigin=https://dashboard.example.com"
  title="3D Home preview"
  loading="lazy"
  referrerpolicy="no-referrer"></iframe>
```

`haUrl` is **mandatory** here — see [`haUrl`](#haurl). `parentOrigin` is
strongly recommended — see [`parentOrigin`](#parentorigin).

### Off-screen pause (cross-origin)

A WebGL scene in a hidden tile renders continuously on a page that is often left
open all day. The viewer pauses itself when the tab is backgrounded, but it
**cannot see whether its own iframe is on screen** — an iframe cannot be observed
from inside.

Same-origin hosts need no code: the viewer reads the parent location and
constructs an `IntersectionObserver` in the parent realm against its own
`frameElement`.

**Cross-origin hosts must drive it over `postMessage`.** The parent observes the
iframe element and posts visibility across; the viewer calls `setActive()`.

Protocol — versioned, and origin-checked on **both** ends:

| Direction | Message |
|---|---|
| frame → host | `{ proto: 'home3d.visibility', v: 1, type: 'hello-from-frame' }` |
| host → frame | `{ proto: 'home3d.visibility', v: 1, type: 'hello' }` |
| frame → host | `{ proto: 'home3d.visibility', v: 1, type: 'ready' }` |
| host → frame | `{ proto: 'home3d.visibility', v: 1, type: 'visibility', visible: <boolean> }` |

Rules:

- The trusted origin is set by [`parentOrigin`](#parentorigin) when present.
  Otherwise the **first valid `hello`** pins it (trust-on-first-use). Every later
  message must arrive from that same origin and from `window.parent`, or it is
  dropped silently. An opaque (`"null"`) origin is refused.
- **Never post with `'*'`** for anything meaningful. The single exception is the
  frame's initial `hello-from-frame`, which carries no information the host does
  not already have — it created the frame. Everything else is sent to a specific
  origin.
- The host must likewise verify `event.origin` against the viewer's origin on
  every message it receives.
- `setActive()` is the **only** capability exposed through this channel: no scene
  mutation, no configuration, no HA access. The blast radius of a spoofed message
  is a paused render loop.

Host side:

```js
const VIEWER_ORIGIN = 'https://home3d.example.com';
const PROTO = 'home3d.visibility', V = 1;
const iframe = document.getElementById('home3d-frame');
let ready = false, pending = null;

const send = (visible) => {
  if (!iframe.contentWindow) return;
  if (!ready) { pending = visible; return; }
  iframe.contentWindow.postMessage(
    { proto: PROTO, v: V, type: 'visibility', visible }, VIEWER_ORIGIN
  );
};

window.addEventListener('message', (e) => {
  if (e.origin !== VIEWER_ORIGIN) return;            // origin check
  if (e.source !== iframe.contentWindow) return;
  const d = e.data;
  if (!d || d.proto !== PROTO || d.v !== V) return;  // versioned
  if (d.type === 'hello-from-frame') {
    e.source.postMessage({ proto: PROTO, v: V, type: 'hello' }, VIEWER_ORIGIN);
  } else if (d.type === 'ready') {
    ready = true;
    if (pending !== null) { const p = pending; pending = null; send(p); }
  }
});

new IntersectionObserver((entries) => {
  const en = entries[entries.length - 1];
  send(en.isIntersecting && en.intersectionRatio > 0.1);
}, { threshold: [0, 0.1, 0.5] }).observe(iframe);
```

The host should also send `false` when the tile is hidden for reasons an
`IntersectionObserver` cannot see — a closed mobile drawer that translates the
element off-screen usually stops intersecting anyway, but a modal covering it,
or a `visibility: hidden` ancestor, does not.

---

## Testing

`docs/smoke-test.html` asserts that each mode hides and shows the chrome
described above, so a future refactor cannot quietly break the HA dashboard's
embed. Open it directly in a browser; it loads the viewer in an iframe once per
mode and reports pass/fail per assertion.
