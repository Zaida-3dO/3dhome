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
| [`tier`](#tier) | `ultra` \| `mid` \| `low` | detected | Force the GPU quality tier (A/B testing) |
| [`fps`](#fps) | integer | `15` preview / `60` else | Frame-rate cap |
| [`furniture`](#furniture) | `0` \| `false` \| `off` | shown | Start with the house's furniture hidden and unbuilt |
| [`time`](#time-and-date) | `HH:MM` | the clock | Pin the sun to that local time |
| [`date`](#time-and-date) | `YYYY-MM-DD` | today | Pin the sun to that day |
| [`debug`](#debug) | `1` | off | Eruda mobile DevTools + error banner |
| [`debugWalls`](#debugwalls) | `1` \| `true` | off | Wall-number overlay |
| [`grid`](#grid) | `1` \| `true` | off | Coordinate grid overlay |
| [`proposed`](#proposed) | `1` \| `true` | off | Handled by a profile's overlay, if it ships one; otherwise inert |
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

Defaults `shadows` to `low` (changed 2026-09-01). It used to be `high` — the
full set of room-shadow lights — which cost a ~40–57 s freeze on every cold
popup open. On-demand rendering does keep an *idle* popup near-free, but that
says nothing about the first frame, and the first frame is where the cost is.

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
| `?embed=1` | `low` | One shadow light rather than eleven — the same house, reached in ~1.7 s instead of ~17 s. See the note below |
| standalone | `auto` | The best the device can do when viewed directly |

An explicit `?shadows=` value overrides the mode default in every mode.

> **Why `?embed=1` defaults to `low`.** Room-shadow lights are the dominant
> startup cost: each is a six-face cubemap, and the first frame that renders all
> ten blocks for ~30–45 s on a cold GPU shader cache (every later frame costs
> ~30 ms). The old `high` default therefore froze a cold popup for ~40–57 s.
>
> `low` renders the same house — walls, wallpaper, fixtures and the sun's
> grounding shadow — with one shadow light instead of eleven, reaching a drawn
> scene in ~1.7 s. What it loses is soft *interior* shadowing, which at the
> default camera is largely hidden behind walls and ceilings anyway.
>
> Note that shadow-map **resolution** is not the lever here: a 16× cut in texels
> sits inside the measurement noise, while light **count** is linear. And on a
> top-tier GPU `high` and `auto` resolve to identical settings, so `high` only
> ever differed on mid-tier hardware, where it overrode the tier gate.
>
> Pass `?embed=1&shadows=auto` for the old behaviour. The standalone page is
> unchanged and still defaults to `auto`. See [perf-cold-start.md](perf-cold-start.md).

### `tier`

`?tier=ultra|mid|low` forces the quality tier. Any other value is ignored.

By default the tier is detected on two axes (`src/quality-tier.js`):

- **What compiles.** `MAX_FRAGMENT_UNIFORM_VECTORS` ≥ 1024 gives `ultra`,
  ≥ 512 gives `mid`, and anything less gives `low`.
- **A mobile GPU.** This is true when the GPU's renderer string names Mali,
  Immortalis, Adreno, PowerVR or Xclipse, or names "Apple GPU" on iOS or
  iPadOS. Failing that, it is true for Android or iOS/iPadOS with a coarse
  pointer. A mobile-class GPU in a desktop OS without a touch pointer (a
  Snapdragon X Windows laptop's Adreno) is not treated as mobile. A mobile GPU
  **starts** at `mid-lite` (see below):
  - no room-shadow lights, even with `?shadows=high`
  - a pixel ratio of 1.5
  - no `priority: "minor"` furniture

**Adaptive quality** (`src/adaptive-quality.js`) then moves it on measured
frame times. The GPU class only decides where a device starts.

- **The levels**, cheapest first:

  | level | tier | room-shadow lights | minor furniture |
  |---|---|---|---|
  | `low` | low | no | skipped |
  | `mid-lite` | mid | no | skipped (a mobile GPU's start) |
  | `mid` | mid | only with `?shadows=high` | built (a 512-uniform desktop's start) |
  | `ultra-lite` | ultra | no | built |
  | `ultra` | ultra | yes | built (a 1024-uniform desktop's start) |

  A device never goes above what its uniform budget compiles. A level that
  would build the same thing as its neighbour under the current `shadows=`
  (e.g. `ultra-lite` and `ultra` under the embed's `shadows=low`) is skipped.
- **What is measured.** The interval between consecutive drawn frames (95th
  percentile over a window of up to 60 frames, or 1.5 s), after a warm-up
  and never across an idle gap, a hidden tab, or a drag at reduced
  resolution. The scene renders on demand, so it draws a few short "probe"
  bursts after load (at most 4 s each, 6 per session) and, while someone is
  using it, one 2.5 s burst every 3 minutes at most; otherwise it measures
  only frames it was drawing anyway. An untouched scene costs nothing.
- **A throttled browser is not a slow GPU.** When the browser itself holds
  animation frames down while the scene is idle (a power-saving mode, a
  background window), nothing is measured: the pixel ratio goes straight to
  the start ratio, as it did before adaptive quality, the level stays where
  it is, and the console says so.
- **Thresholds.** Headroom is a 95th percentile under 20 ms, or under the
  frame-rate cap's own cadence if that is slower (the 60 fps cap lands on
  20.8 ms at 144 Hz). Too slow is over 34 ms, and at least one refresh
  beyond the headroom line: 34 ms rather than 33 so that a steady,
  vsync-locked 30 fps holds instead of flip-flopping. On a 75 Hz display the
  60 fps cap already draws every 26.7 ms, which puts "too slow" at 46.7 ms
  there. Between the two, nothing moves. Either way it takes two windows in
  a row.
- **What moves when.** The pixel ratio moves **live**, in 0.25 steps: first
  from the cheap 1.0 first paint to the start ratio (1.5 on a mobile GPU,
  the full ratio elsewhere), then above it up to 2. The **level** is decided
  now and applied on the **next load**: changing lights or shadows under a
  running scene would recompile every material, which is a multi-second
  freeze. A step down always lowers the pixel ratio first. After that the
  order depends on the GPU:
  - **A mobile GPU gives up sharpness before detail.** The pixel ratio falls
    all the way to 1.0 before any level is stepped down. A level is stepped
    down only when it still fails **at 1.0**, and only when that happens on
    **two separate loads**. The first failure is recorded as a *strike*, and
    sustained headroom at that level on a later load clears it. At 1.0 with
    headroom, it proposes the next level up for the next load, as before.
    Measured on a wall tablet (Mali-G925, 60 Hz): `mid-lite` and
    `ultra-lite` both hold 60 fps at 1.0 and fail at 1.5, so it settles on
    `ultra-lite` at 1.0. The old order settled it on `low` at a sharp ratio.
  - **A desktop is unchanged.** A level is stepped down as soon as the ratio
    falls below its start ratio.
- **No flip-flop.** A pixel-ratio notch that failed is not tried again for
  this level for 7 days. A level stepped down from is blocked, along with
  everything above it, for 7 days. A first frame that blocks for over a
  second at a level above the device's default counts as a failure on its
  own. That covers a cold room-shadow pass. On a desktop, and at a level
  with room-shadow lights, it steps the level down at once: that pass is
  rendered cold on every load. On a mobile GPU at a level without them,
  it is a strike, because a one-off shader compile is cached for the next
  load. The wall tablet's first frames measured 17–42 ms at every level, so
  it never trips there.
- **Settings > Quality.** **Auto (recommended)**, the default, runs the
  ladder above. You can also pin a level: Low, Medium – fewer small items
  (`mid-lite`), Medium, High (`ultra-lite`) or Max (`ultra`). A pin applies
  to this device in this context only, so the page and the popup keep
  separate pins (`home3d.quality.pin.v1|…`). It persists across loads. While
  pinned, the ladder does not move the level, and the pixel ratio still
  adapts down to 1.0 so the view stays smooth. A change applies on the next
  load, and the row offers **Reload**. The dropdown disables any level the
  GPU cannot compile, and any that builds the same thing as a cheaper one
  here (Max in the popup), and says why. The readout under it says **Auto**,
  **Manual** or **Fixed**, then the level and the current sharpness (pixel
  ratio). `?tier=` still wins over both, and hides the choice.
- **Desktop.** A desktop starts exactly where it did before. It only moves
  if it is measured as slow.
- **Stored per device**, in `localStorage` under
  `home3d.quality.v2|<GPU name>|<uniform budget>|<shadows mode>`, so the page
  and the HA popup (`?embed=1`) each keep their own. Records under the old
  `v1` key were written by the sharpness-first order and are not read. A
  device with one starts from its default and re-learns, with nobody
  touching it. In Auto, **Re-measure** forgets the record. It does not
  clear a manual pin.
- Tests: `scripts/test-adaptive-quality.mjs` (the pieces) and
  `scripts/test-adaptive-convergence.mjs` (load after load: the wall tablet
  from its stale `v1` record, a desktop, the cold frame, a manual pin).

`?tier=` wins over all of this: it pins the tier, turns adaptation off (no
probes, nothing read or stored), and lifts the pixel-ratio ceiling and the
minor-furniture skip, which is what makes it an A/B knob on a tablet. It never
goes **above** what the uniform budget compiles: `?tier=ultra`
on a 256-vector phone stays `low`, because the ultra shader would not compile
and nothing would render. Adaptation is also off in the auto-rotating preview
and with `?fps=` below 50. With it off, the pixel ratio ramps once after load
exactly as it always did.

The detected values, including `mobileGpu`, the reason for it, the level and
where it came from, and the light counts, are printed in the console's
`[Home3DScene] Quality tier=` line. Every adaptive step prints an
`[Home3DScene] Adaptive quality:` line, and the end of measuring prints
`Adaptive quality settled: level=… DPR … p95 … ms; next load: …`.

### `fps`

`?fps=<integer>` — caps the render loop.

Defaults to `15` in preview mode and `60` otherwise. A non-integer value falls
back to that default. Combined with `?shadows=`, this is the A/B knob for power
and quality tuning.

### `furniture`

`?furniture=0` (also `false` or `off`) starts the scene with the profile's
`furniture[]` hidden. Nothing is built or compiled either, so it is also the
A/B knob for what the furniture costs. Any other value, or none, shows it.

The Settings panel's **Show furniture** switch toggles the same thing at
runtime: it hides every furniture mesh and its shadow, and turning it on in a
`?furniture=0` session builds the furniture then. The switch only appears for
a house that has furniture.

### `time` and `date`

`?time=HH:MM` (24-hour, the viewer's local time) and/or `&date=YYYY-MM-DD` pin
the sun to that moment instead of following the clock, so a render at morning,
noon, evening or night is reproducible whenever it is taken:

```
?time=09:00&date=2026-06-21     midsummer morning
?time=13:00                     today, 1 pm
?date=2026-12-21                midwinter, at the current clock time
```

The sun's direction, height and colour are computed from the profile's `site`
(latitude, longitude, `northOffsetDegrees`) for that moment. A pinned time wins
over Home Assistant's `sun.sun`, which otherwise drives the sun whenever it is
reporting. The Settings panel's morning / noon / night presets still win over
both. A malformed value is ignored with a console warning; a profile with no
`site` keeps its fixed neutral daylight.

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

**Not handled by this repo — it belongs to an overlay a house profile may bring
with it.**

`?proposed=1` previously toggled a "proposed renovation" overlay. That overlay
depicted a real, specific renovation of a real home, so it was deliberately left
behind when the viewer was extracted into this public repository. No code *here*
reads the parameter, and on a stock checkout — including the demo house — it
does nothing.

It is not, however, permanently dead. An overlay script loaded through a house
profile's [`extraOverlays`](house-profile.md#overlay-scripts-a-profile-brings-with-it)
field owns its own URL parameters and keyboard shortcuts, and the overlay that
originally used this one reads `?proposed=1` itself and binds `P` (toggle the
plan) and `L` (toggle its labels, only while the plan is shown). Mount a profile
that ships it and the parameter works again; load any profile that does not and
it stays inert.

So: an old bookmark, dashboard card or saved URL carrying `?proposed=1` is
explained rather than a bug, and whether it *does* anything depends entirely on
which house profile is loaded.

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
