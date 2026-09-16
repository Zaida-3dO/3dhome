# Cold-start performance

Where the time goes when this app is opened on a machine that has never
rendered the scene before, and which knobs actually move it.

Measured on a Radeon 780M (ANGLE/D3D11, `MAX_FRAGMENT_UNIFORM_VECTORS` 1024),
the 10-room house, a **fresh browser per run** — reusing one browser warms the
GPU shader cache and hides the entire effect.

> ⚠️ **Every draw-call figure below the "shape of a cold start" section is a
> PRE-CHANGE baseline, recorded 2026-09-01.** They are kept because they are the
> measurements that justified the shadow-caster work, and because the *shape* of
> the problem they describe is still correct. They are **not** current: room
> lights became `SpotLight`s with a single 2D shadow map in `1f6b993`, so the
> cubemap arithmetic they rest on no longer applies. See
> [After the shadow-caster change](#after-the-shadow-caster-change-2026-09-16).

## The shape of a cold start

Two blocking frames, not slow loading. Every resource fetch completes in under
50 ms; `DOMContentLoaded` is ~150 ms.

**Pre-change (2026-09-01), when each room light cast a cubemap:**

| frame | draw calls | first time | every later time |
|---|---:|---:|---:|
| beauty pass | ~410 | ~9–13 s | ~44 ms |
| + room-shadow pass | ~4,491 | ~30–45 s | ~26–33 ms |

Identical work, ~1,400x different cost. It is **one-time GPU/driver work**, not
per-frame rendering and not JavaScript: 0% of the block is inside any GL call,
and a CPU profile attributes it to the point where three.js first reads a
program back from the driver.

At the time of that measurement, 10 of the 11 shadow casters were `PointLight`s,
and a PointLight shadow is a **6-face cubemap** — so the shadow frame built ~60
shadow renders at once. **This is the thing `1f6b993` changed**; see below.

## After the shadow-caster change (2026-09-16)

`1f6b993` converted the room casters to `SpotLight`s with a single 2D shadow
map. Re-measured against the **real 10-room house** on the live deployment
(v0.8.0, `houses/ope`), two independent cache-busted loads:

| pass | render target | draw calls |
|---|---|---:|
| sun shadow | FBO 2048² | 240 |
| room shadows (10 passes, one per room) | FBO 1024² | 633 |
| beauty | screen | 408 |
| **first frame total** | | **1,281** |

**~4,491 → ~1,281 draw calls, roughly −71%** — exceeding the −62% measured on
the 7-room demo house, which is the direction predicted (the real house has more
casters, so the demo was a conservative floor).

Two things make this trustworthy rather than merely encouraging:

- **The instrument agrees with the old one where both measured.** The beauty
  pass came out at 408–412 draws against this doc's ~410 — so the counter is
  calibrated against the very figure it is being compared to.
- **The conversion is proven by render-target geometry, not inferred.** Room
  shadow maps render into a **1024×1024 square** framebuffer, ten times. A
  three.js PointLight cubemap renders into a `w*4 × h*2` atlas — 4096×2048 for a
  1024 map. A square target cannot be a cubemap.

⚠️ **The cold-start *timing* half is still unverified.** Those draw counts are
cache-independent and stand on their own, but the first-frame times behind them
came from a warm shared browser. As this doc says at the top, a reused browser
hides the entire effect — so the old ~30–45 s figure has **not** been re-measured
and must not be treated as refuted. Closing that gap needs a fresh browser
process per run.

## What actually helps

### Shader precompile (`renderer.compileAsync`) — shipped

three.js builds a program the first time a material is drawn and the driver
finishes linking lazily. `compileAsync()` does that work up front, polling
`program.isReady()` via `KHR_parallel_shader_compile` instead of blocking.

Measured cold on the real house, worst single blocking frame and time to a
fully-drawn scene, 5 interleaved pairs:

| | before | after |
|---|---:|---:|
| worst block | 31–70 s | **10–14 s** |
| fully drawn | 41–92 s | **10–15 s** |

The scene is structurally identical — same 390 meshes, 48 lights, 11 shadow
casters, 156 materials, 237 geometries, 37 textures, 520 objects.

Two things it is easy to get wrong:

- It is an **instance** method in r160. `WebGLRenderer.prototype.compileAsync`
  is `undefined`; feature-detect on the renderer instance.
- The scene renders **on demand**, so you must `requestRender()` when the
  promise resolves. Without it nothing repaints and the canvas stays blank —
  which measures as a spectacular (and completely false) speed-up.

### Number of shadow-casting lights — the real lever

Cost is linear in the number of room lights that cast. **Pre-change (2026-09-01)**,
when each caster was a separate cubemap:

| casting | draws/frame | worst block |
|---:|---:|---:|
| 10 (stock) | 4,491 | ~10–13 s |
| 5 | 2,447 | ~6–7 s |
| 2 | 1,410 | ~3–4 s |
| 0 | 649 | ~2–3 s |

The linear relationship still holds after `1f6b993`, but the **per-caster
constant is now far smaller** — a 2D map instead of six cube faces. Stock 10
casters measured 1,281 draws on the real house rather than 4,491, so treat the
absolute numbers in that table as historical and the *shape* as current.

This also matters when reading a measurement: a room that is **off** zeroes its
caster's intensity, and three.js then skips that shadow render entirely. A dark
house measures the bottom rung of this table no matter what else is true — which
is why a "fast" measurement of an unlit house proves nothing.

## What does NOT help

### Shadow-map resolution

`shadowMapScale` is plumbed to the sun (2048) and every room light (1024), so
it looks like the obvious knob. It is not: a **16x** cut in depth texels changes
nothing outside the noise.

| room shadow map | worst block (repeat runs) |
|---|---:|
| 1024² (stock) | 11.9 / 12.5 / 13.0 s |
| 512² | 12.9 / 13.3 s |
| 256² | 15.6 / 11.7 / 13.6 s |

The spread *within* one setting exceeds the difference *between* settings.

### A progressive shadow ramp — removed

Painting the first frames with shadows off and switching them on afterwards
looks appealing but is a net loss: toggling `shadowMap.enabled` invalidates
three.js's program cache and forces a full material recompile (shader compiles
24 → 36, program links 12 → 18). Cold, it settled at ~20 s with the ramp versus
~14.7 s without. It delays the room-shadow pass rather than avoiding it.

### Deferring scripts / lazy-loading the debug overlays

Real but negligible here. The three debug overlays compile in **0.3 ms**
combined, and on localhost every script fetch is already parallel and under
30 ms, so `defer` has no download latency to overlap with. Measured over 20
interleaved pairs it was a coin flip.

## Measuring this correctly

1. **Fresh browser and fresh process per run.** A reused browser has a warm
   shader cache and shows none of this.
2. **Close page → context → browser explicitly.** `browser.close()` alone
   leaks WebGL contexts; they accumulate and slow every later run.
3. **Do not stop at the first drawn frame.** The cheap beauty frame draws long
   before the expensive shadow frame. Wait for a frame with ≥4,000 draw calls.
4. **Assert you actually rendered** — draw count *and* screenshot size. A blank
   canvas is ~10 KB; a real frame is ~265 KB.
5. **Pixels cannot prove the image is unchanged.** The sun is time-of-day
   driven and clouds drift, so two captures of unmodified code differ by up to
   28% of pixels. Compare the scene graph instead (object, material, light,
   geometry and texture counts plus per-object parameters).
6. `page.screenshot()` times out on a continuously-rendering scene — use CDP
   `Page.captureScreenshot`. `canvas.toDataURL()` returns blank (there is no
   `preserveDrawingBuffer`).
