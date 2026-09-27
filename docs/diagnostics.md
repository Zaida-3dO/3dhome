# /diagnostics — the device benchmark

Open `/diagnostics` on any device (a wall tablet, a phone, a desktop, or inside the Home
Assistant companion app's embedded view), tap **Start**, and it benchmarks the real 3D view on
that device: quality levels, pixel ratios, shadows, extra lights, furniture and scripted camera
moves. At the end, **Copy result** puts one JSON document on the clipboard for an agent to
analyse, and **Save diagnostic run** (when the server allows it) stores it on the server.

It answers: *can this device run the current graphics level, could it take more, or should it be
reduced — and by how much?*

- Page: `diagnostics.html`, served at `/diagnostics` (`/diagnostics/` redirects there).
- Code: `src/diagnostics/` — `runner.js` (drives the scene), `matrix.js` (what runs),
  `camera-motion.js`, `stats.js`, `telemetry.js`, `device-info.js`, `verdict.js`, `result.js`,
  `page-io.js`.
- Scene hooks: `instance.diagnostics` and the `level` create option in `src/home3d-scene.js`
  (below).
- Save endpoint: `deploy/njs/diagnostics.js`, `deploy/diagnostics-on.conf` / `-off.conf`,
  switched by `deploy/entrypoint.sh`.
- Tests: `scripts/test-diagnostics-{stats,verdict,device,save}.mjs`.

## Running it

- **Full** (about 6-7 minutes) or **Quick** (about 3 minutes). Most of the time is not the
  measuring: every change in the number of lights makes three.js recompile every lit material
  **synchronously** (measured 12-21 s per change on a desktop GPU for the demo house), and the
  light and strip stages each pay it once. A tablet will pay more; the ETA is an estimate.
- **Benchmark as**: *the 3D page* (`shadows=auto`) or *the Home Assistant popup*
  (`shadows=low`, what `?embed=1` uses). The two keep separate adaptive-quality records, so pick
  the one this device really shows. `?shadows=low` or `?embed=1` on the URL preselects the popup;
  `?mode=quick` preselects Quick.
- Keep the screen on and the tab in front. The page asks for a screen wake lock where the browser
  supports it (never waiting on the answer). A hidden page, or a browser that throttles animation
  frames (an occluded window, power saving), invalidates the stage that was running — it is marked
  invalid with the reason rather than recorded as slow.
- The **device name** ("Wall tablet") is optional and remembered on the device.
- **Abort** stops after the current frame and still produces a partial result.
- **Apply recommended level** (on the done screen, only when the verdict recommends a level other
  than the one the device runs): writes that level into the app's own adaptive-quality record for
  this device and mode, for the next load of the 3D view, and shows the previous value with an
  **Undo**. The app keeps measuring afterwards and steps down by itself if the device cannot hold
  it. Nothing else in the benchmark writes that record (see *The app's own record* below).

### Locally

```sh
node scripts/dev-server.mjs --port 8792 --save-dir ./diagnostic-runs
# http://localhost:8792/diagnostics
```

No dependencies. Without `--save-dir` the save endpoint is off, exactly like the container's
default. The dev server imports the same validation file nginx runs, so Save behaves the same.

## What it measures

### What the device runs today

Before anything runs, the device block records the app's **current decision** here, computed with
the app's own functions (`quality-tier.js`, `adaptive-quality.js`) from the same inputs the scene
reads: `compileTier`, `mobileGpu` and why, `maxLevel`, the default level, the adaptive-quality
record for this GPU in **both** shadows modes (`storedAdaptiveState.auto` / `.low`, with their
`storageKeys`), and from those the **level the device actually runs** (`currentLevel`,
`currentLevelFrom`: `stored` or `default`), what that level builds (`currentLevelConfig`: tier,
room shadows, minor-furniture drop, `furnitureDetail` — `low` only at tier `low`, see
`furnitureBuildSteps` in `src/furniture.js`) and the ratio it runs at (`currentDpr`: where the
record last settled at this level, else the app's start ratio — 1.5 on a mobile GPU).

### The matrix

Not a cartesian product. Every structural knob (level, shadows) is a full shader recompile and
needs its own scene build, so the plan is:

| Build | Stages |
|---|---|
| **base** — the level the device runs **now** (stored, else default), the chosen shadows mode, furniture on | `baseline` (static, current ratio) · `dpr-*` (static at each of 1, 1.5, device max, and the current ratio) · `motion-*` (idle, slow orbit, fast orbit, pan, zoom, swipe burst — at the app's interaction ratio) · `lights+10/25/50` (synthetic shadowless PointLights) · `furniture-none` · `sustained` (slow orbit, 60 s) |
| **level-&lt;name&gt;** — every other rung of the app's ladder the GPU compiles (`low`, `mid-lite`, `mid`, `ultra-lite`, `ultra`), each with furniture at the detail **that rung builds** | static at each pixel ratio |
| **shadows-&lt;mode&gt;** — the current level in the other two shadows modes (skipped when identical to base) | static, current ratio |
| **strip** — the strip-light cost group, at the level and ratio the grid **recommends** (else the current ones), decided at run time after the grid | `strip-0` (reference) · `strip-A13` (13 PointLights — today's approach) · `strip-B13x3` / `strip-B13x6` (13 strips × 3 or 6 dim PointLights, reach 2.5 m, decay 2) · `strip-C13` / `strip-C25` (RectAreaLights, 1 m × 2 cm) |

Quick mode keeps the base build's baseline, two ratios, slow orbit, swipe burst, +10 lights,
furniture off and a 10 s sustained stage, **every rung at the current ratio**, and the strip
group's reference, A13, B13x3 and C13.

"Distinct" is decided by `levelConfig()` from `src/adaptive-quality.js`, so two rungs that build
the same scene (ultra-lite and ultra under `shadows=low`) are not run twice.

Strips are placed by `instance.diagnostics.stripAnchors(n)`: spread along the house's walls,
longest first, 0.9 m up and 5 cm off the wall, facing into the house. The RectAreaLight stages
need three's LTC tables: `vendor/three-r160/addons/lights/RectAreaLightUniformsLib.js` is the
unmodified file from the `three@0.160.0` npm tarball (sha256
`08085bc942253cd54948bf936fecb66b54514a135872656e475a1cab09b55214`, the same file the strip-light
branch vendors), loaded lazily only when a C stage runs.

Motion stages run at the **interaction ratio** (`min(1, current)`) because the app drops to it
while a finger is down; that is what a swipe really costs.

Camera moves are functions of time only (`camera-motion.js`), so a slow device and a fast one
see the same camera at the same moment:

| Move | Definition |
|---|---|
| idle | static home view, drawing every frame |
| orbit-slow | 0.25 rad/s |
| orbit-fast | 1.5 rad/s |
| pan | target over ±30 % of the footprint (4 s × 3 s Lissajous) |
| zoom | 0.55× – 1.35× the home distance, 3 s period |
| swipe-burst | 0.25 s flicks at up to 5 rad/s with ease-out, 0.35 s rest, alternating |

The sun is pinned to 12:00 local time so every device lights the same scene. During stages the
scene renders **continuously and uncapped** (the app itself renders on demand, capped at 60 fps).

### A stage

1. Apply the settings (pixel ratio, lights, furniture, camera).
2. Wait for two frames drawn with them — the **change frames**, recorded as `changeFrameMs` (a
   light-count change recompiles every lit material; that hitch is kept out of the numbers).
3. Warm up for `warmupMs` with the camera already moving; discarded.
4. Measure for `measureMs`.
5. Stop drawing and time idle animation-frame ticks: if the browser is throttling them, the stage
   is invalid.

A **build** records `compileMs` (create → ready: the shader precompile), `furnitureAttachMs`,
`firstFrameMs`, and what the scene actually built (`quality`).

## The result document (`schemaVersion` 1)

One JSON object, under ~200 KB (the save endpoint caps a body at 256 KB). Keys in this order:

| Key | What |
|---|---|
| `schema` | always `"home3d-diagnostics"` |
| `schemaVersion` | `1` |
| `summary` | array of plain-English lines: device, what it runs today, verdict, every rung, furniture, strip lights, per-light cost, thermal, the adaptive record, invalid stages |
| `app` | `version`, `houseId`, `house` (**counts only**: rooms, walls, doors, windows, curtains, furnitureItems), `page` |
| `run` | `mode`, `shadows`, `startedAt`, `finishedAt`, `durationMs`, `estimatedMs`, `aborted`, `abortReason`, `hiddenEvents`, `stagesRun`, `stagesInvalid`, `adaptiveState` (`untouched`, `restored` — see below) |
| `device` | the device block (below) |
| `matrix` | the plan that ran: `mode`, `timing`, `shadows`, `currentLevel`/`Name`, `currentDpr`, `interactionDpr`, `dprs`, `levels`, `builds` (ids, level, shadows, what each builds incl. `furnitureDetail`, stage ids; the strip build's `chosenFrom`), `stripOptions`, `motions`, `histogramEdgesMs`, `sun`, `maxFragmentUniformVectors`, `notes` |
| `builds` | per build: `compileMs`, `furnitureAttachMs`, `firstFrameMs`, `shaderErrors`, `quality` (the scene's own report), `renderer`, `lights`, `heap`, `crossCheck` |
| `stages` | per stage (below) |
| `verdict` | the on-device first answer (below) |
| `trimmed` | anything dropped to fit the size cap (per-frame series first) |
| `save` | added on Copy/Save: `deviceId`, `deviceIdPersistent`, `deviceName`, `appVersion`, `clientTimestamp`, `schemaVersion` |
| `server` | added by the save endpoint only: `receivedAt`, `file`, `bytes` |

### `device`

Every field is always present. An API the browser lacks, refuses or throws from is `null`, and
**`device.nullReasons["<dotted.path>"]`** says why. Nothing is omitted.

`userAgent`, `platform`, `language`, `userAgentData`, `userAgentDataHighEntropy`
(architecture, bitness, model, platformVersion, fullVersionList, formFactors — where granted),
`hardwareConcurrency`, `deviceMemoryGB`, `maxTouchPoints`, `screen`, `devicePixelRatio`,
`viewport`, `orientation`, `colorGamut`, `dynamicRange`, `prefersReducedMotion`, `pointerCoarse`,
`hover`, `refreshRateHz` + `refreshCalibration` (idle rAF), `embedding` (`inIframe`,
`referrerOrigin` — **origin only**, `ancestorOrigins`, `standalone`, `webviewHint`,
`secureContext`, `origin`), `battery` (`level` 0–1, `charging`, times), `network`
(`navigator.connection`), `memory` (`performance.memory`), `longTaskSupported`,
`wakeLockSupported`, `webgl` (version, vendor/renderer and the **unmasked** ones, `limits` —
`MAX_FRAGMENT_UNIFORM_VECTORS`, `MAX_VERTEX_UNIFORM_VECTORS`, `MAX_TEXTURE_SIZE`, `MAX_SAMPLES`
and more — `extensions`, `timerQuery`, `parallelShaderCompile`, `highpFragment`), `webgpu`
(adapter info where exposed), and `app` — the app's own decision recomputed with its own
functions: `mobileGpu`, `mobileReason`, `mobileCaps`, `compileTier`, `tier`, `maxLevel`,
`defaultLevel`/`Name`, `shadowsMode`, `storageKeys` and `storedAdaptiveState` (per shadows mode:
what adaptive quality has learnt on this device, if anything), `currentLevel`/`Name`,
`currentLevelFrom`, `currentLevelConfig` (incl. `furnitureDetail`), `startDpr`, `currentDpr`,
`currentDprFrom` — see *What the device runs today*.

### A stage

| Field | Meaning |
|---|---|
| `id`, `build`, `group` | `group`: `baseline`, `dpr`, `motion`, `lights`, `furniture`, `sustained`, `grid`, `shadows`, `strip` |
| `grid` | a settings point the verdict may choose (static, no extra lights, furniture on) |
| `level`, `levelName`, `shadows`, `dpr`, `dprApplied`, `camera`, `lightsAdded`, `furniture` | the settings |
| `config` | what the build builds: `tier`, `furnitureDetail`, `dropMinorFurniture`, `sunShadow`, `roomShadowLights`, `shadowMapScale` |
| `strip` | strip stages: `option` (A/B/C/ref), `kind`, `strips`, `perStrip`, `label` |
| `uniforms` | baseline, lights and strip stages: `lightVectorsEstimate` (lights only, three r160 structs), `measuredMaxVectors` (largest active-uniform footprint of the programs alive at the end of the stage, vertex+fragment), `maxFragmentUniformVectors` |
| `valid`, `invalidReason` | never used by the verdict when invalid |
| `compileFailed`, `shaderErrors` | a shader failed to compile (too many lights for the uniform budget) |
| `changeFrameMs` | time for the settings change to reach the screen (compile hitch; a light-count change is a full synchronous recompile). Over 180 s the stage is invalid |
| `idleTick` | `{medianMs, fps, throttled}` — the browser-throttling check |
| `frames` | `frames`, `durationMs`, `fpsMean`, `meanMs`, `p50Ms`, `p90Ms`, `p95Ms`, `p99Ms`, `maxMs`, `minMs`, `over33`, `over50`, `pctOver33`, `pctOver50`, `longestStallMs`, `jankFrames`, `jankPct` |
| `histogram` | frame counts per bucket; edges in `matrix.histogramEdgesMs` (last bucket open) |
| `series`, `seriesNote` | per-frame intervals, downsampled keeping each bucket's **max** (≤ 240 points) |
| `gpu`, `gpuReason`, `gpuDisjointDrops` | GPU ms per frame (`EXT_disjoint_timer_query_webgl2`): `samples`, `meanMs`, `p50Ms`, `p95Ms`, `maxMs`; null with a reason where unavailable |
| `cpu` | CPU ms of the render call (scene.onBeforeRender → onAfterRender) |
| `drift`, `gpuDrift` | sustained stage only: per-window means/medians and `driftPct` (first window → last) |
| `renderer` | `renderer.info`: `drawCalls`, `triangles`, `points`, `lines` (last frame, main pass), `geometries`, `textures`, `programs` |
| `lights` | lights by type (`point`, `pointShadow`, `spot`, `spotShadow`, `directional`, `hemisphere`, `synthetic`, `total`) |
| `heap`, `heapReason` | `performance.memory` at stage start/end (Chromium only) |
| `longTasks`, `longTasksReason` | `{count, totalMs, maxMs}` of main-thread tasks > 50 ms (Chromium only) |
| `renderedFrames`, `ticks`, `wallMs` | bookkeeping |

**Definitions** (`src/diagnostics/stats.js`): percentiles are nearest-rank (always a real
sample). `over33` counts frames **strictly** over 33.4 ms, so a steady 30 fps is not a miss.
`jank` is a frame over twice the stage's median **and** more than one 60 Hz refresh over it (so
a 120 Hz device is not charged for an ordinary 17 ms frame). `longestStallMs` is the longest
contiguous run of frames over 33.4 ms, summed.

### `verdict`

- **Target:** a setting *holds* when valid, `p95 ≤ 33.4 ms` **and** `≤ 2 %` of frames over 50 ms.
- `current` — the setting the device runs **today** (`levelFrom`: `stored` or `default`), with `holds`, `p95Ms`, `costMs`, `headroomPct`, `furnitureDetail`.
- `best` — the highest sustainable grid point (holds the target), ranked by level, then pixel ratio; `recommendedLevel`/`Name` is its level.
- `levels` / `levelLines` — every rung measured: its tier, furniture detail, minor-item drop, and the highest ratio it holds at (`holdsAtDpr`, null when it holds nowhere).
- `furniture` — `currentDetail`, `currentDropsMinorItems`, `fullDetailAffordable` (a holding setting builds full-detail furniture), `allItemsFullDetailAffordable` (…and keeps the minor items), and a `line` in words.
- `stripLights` — the strip group: the level/ratio it ran at, each option's `deltaP95Ms` and `deltaCostMs` against the +0 reference, uniform use, whether it `compiled`, `holds` and is `tenable` (valid, compiled, holds), `tenable` per option A/B/C, and `lines` in words.
- `recommendation` — `raise`, `keep`, `reduce`, `reduce-below-lowest` or `unknown`; `summary` says it in words.
- `basis` — `gpu` (GPU timer p95, maxed with CPU p95) or `frame` (frame-interval p95, which vsync
  floors at the refresh interval, so headroom is **understated**). Headroom is
  `1 − cost / 33.4 ms`.
- `perLightMs` — least-squares slope of mean ms against synthetic lights added: `gpu`, `frame`,
  the points, and `firstFailingLights`.
- `thermal` — sustained-stage `driftPct`, `gpuDriftPct`, `throttlingSuspected` (> 15 %).

The agent reading the result should re-derive from `stages`; the verdict is a first answer.

### The app's own adaptive-quality record

The 3D view keeps what adaptive quality has learnt per device in `localStorage`
(`home3d.quality.v1|<GPU>|<uniform vectors>|<shadows mode>`). The benchmark must not disturb it:
every build pins its level (`opts.level`), which turns adaptive quality off for that build, so
nothing is read from or written to the record by the scene. The runner snapshots every
`home3d.quality.v1|` key before the run and compares after; `run.adaptiveState.untouched` says
whether anything moved, and if something did it is restored (`restored: true`). The only writer
is the explicit **Apply recommended level** button, which the user presses, and which shows the
previous value and offers Undo.

### Scene hooks (`src/home3d-scene.js`)

Additive and inert unless called; the app never calls them.

- `create(..., { level })` — pins the structural level (0 `low` … 4 `ultra`, clamped to what
  compiles) and turns adaptive quality off for that scene. Absent: unchanged behaviour.
- `instance.diagnostics` — `renderer`, `scene`, `camera` (read-only handles for measurement),
  `quality()`, `setPixelRatio(r|null)`, `setContinuous(bool)`, `addPointLights(n)`,
  `addLights(specs)` (point or RectAreaLight), `stripAnchors(n)`, `clearPointLights()`,
  `lightCounts()`, `getOrbit()`, `homeOrbit()`, `footprintMetres()`.

`src/diagnostics/telemetry.js` (frame recorder, GPU timer query, CPU timer, long tasks,
`renderer.info`) and `stats.js` are written to be reused by any other perf HUD.

## Privacy

No owner names, no Home Assistant entity ids, no house coordinates or room names. The house is
reduced to counts. The referrer is reduced to its origin. The device id is a random UUID
generated on the device (kept in `localStorage`, `deviceIdPersistent: false` when storage is
unavailable); nothing ties it to a person.

## The save endpoint — `POST /api/diagnostics`

**Off by default.** The page reads `diagnosticsSave` from the generated `config.js` and disables
Save with an explanation when it is false.

### Contract (identical in nginx/njs and `scripts/dev-server.mjs`)

| Request | Answer |
|---|---|
| not `POST` | 405 |
| `Content-Type` not `application/json` (a `charset` is fine) | 415 |
| body over 256 KB (262144 bytes) | 413 (nginx rejects before njs runs) |
| body not a JSON object | 400 |
| `schema` ≠ `"home3d-diagnostics"` or `schemaVersion` ≠ `1` | 422 |
| more than 6 a minute from one address (burst 3) | 429 |
| write failed (directory missing or not writable) | 507 |
| otherwise | 201 `{"ok":true,"id":"<file name without .json>","receivedAt":"<ISO>"}` |

- **Write-only.** There is no read, list or delete over HTTP. Runs are read on the host.
- **Server-generated names:** `<receivedAt ISO with : → ->_<device id>_<version>.json`, the id
  reduced to `[A-Za-z0-9-]` (≤ 64) and the version to `[A-Za-z0-9._+-]` (≤ 40, no leading dot);
  missing values become `unknown`. Nothing the client sends can contain `/`. Files are created
  exclusively — a clash gets `-2`, `-3`… and never overwrites.
- The stored record is the client document plus `server: {receivedAt, file, bytes}`.
- Behind a reverse proxy the rate limit keys on the proxy's address, so it is effectively
  global (6/min across everyone) — the safe direction for a public write endpoint.

### Switching it on (container)

1. Create a host directory for the runs and make it writable by the nginx worker (uid 101 in
   `nginx:alpine`): `chown 101:101 <host dir>`.
2. Mount it into the container and name it:

   ```yaml
   environment:
     HOME3D_DIAGNOSTICS_DIR: /data/diagnostics
   volumes:
     - <host dir>:/data/diagnostics
   ```

3. Restart. The log says `diagnostics saving: ON -> /data/diagnostics`, or `OFF` with the reason.

At start-up `deploy/entrypoint.sh` checks the path (absolute, `[A-Za-z0-9/._-]` only, no `..`,
an existing directory) and that the image has the njs module. Only then does it install
`diagnostics-on.conf` as `/etc/nginx/home3d-diagnostics.conf` with the directory filled in,
prepend `load_module /etc/nginx/modules/ngx_http_js_module.so;` to `/etc/nginx/nginx.conf`
(once), and publish `diagnosticsSave: true` in `config.js`. Anything wrong leaves all three off.
It warns when the directory is not writable by the worker.

**Why njs.** The image is `nginx:alpine` with no backend, and the official image already ships
the njs module (unloaded). Using it keeps the image, adds no process and no build step. The
alternative — a small sidecar service reached by `proxy_pass` — would add a container, a port and
a runtime for one endpoint. The njs handler and the dev server share one file so they cannot
drift.
