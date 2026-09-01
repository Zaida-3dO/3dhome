# Cold-start performance

Where the time goes when this app is opened on a machine that has never
rendered the scene before, and which knobs actually move it.

Measured on a Radeon 780M (ANGLE/D3D11, `MAX_FRAGMENT_UNIFORM_VECTORS` 1024),
the 10-room house, a **fresh browser per run** — reusing one browser warms the
GPU shader cache and hides the entire effect.

## The shape of a cold start

Two blocking frames, not slow loading. Every resource fetch completes in under
50 ms; `DOMContentLoaded` is ~150 ms.

| frame | draw calls | first time | every later time |
|---|---:|---:|---:|
| beauty pass | ~410 | ~9–13 s | ~44 ms |
| + room-shadow pass | ~4,491 | ~30–45 s | ~26–33 ms |

Identical work, ~1,400x different cost. It is **one-time GPU/driver work**, not
per-frame rendering and not JavaScript: 0% of the block is inside any GL call,
and a CPU profile attributes it to the point where three.js first reads a
program back from the driver.

10 of the 11 shadow casters are `PointLight`s, and a PointLight shadow is a
**6-face cubemap** — so the shadow frame builds ~60 shadow renders at once.

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

Cost is linear in the number of room lights that cast, because each one is a
separate cubemap:

| casting | draws/frame | worst block |
|---:|---:|---:|
| 10 (stock) | 4,491 | ~10–13 s |
| 5 | 2,447 | ~6–7 s |
| 2 | 1,410 | ~3–4 s |
| 0 | 649 | ~2–3 s |

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
