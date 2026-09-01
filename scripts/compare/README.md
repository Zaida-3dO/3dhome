# Comparing two builds of the renderer

Three scripts that answer one question: **is this app drawing the same scene as
another build of it?**

They exist because a WebGL canvas is hard to review by eye. Two renders can look
alike at a glance and differ in ways that matter — a wall papered on the wrong
face, a rug at the wrong scale, 158 missing meshes hidden behind a wall you are
not currently looking at. And they can differ *visibly* for reasons that mean
nothing, because the sky's clouds are placed with `Math.random()`. So the
comparison is done twice, in two different currencies:

| script | compares | catches |
|---|---|---|
| `probe.mjs` | captures both builds | — (produces the inputs for the other two) |
| `pixel-diff.mjs` | rendered pixels, per camera | anything visible from that angle |
| `scene-diff.mjs` | the three.js scene graph | everything a screenshot cannot show |

The scene diff is the more useful of the two. Pixels tell you *that* two builds
differ; the graph tells you *what* differs — mesh counts by geometry and
material, every light's intensity/position/shadow settings, every texture's
wrap mode, repeat, offset and colour space, the renderer's tone mapping and
output colour space, and the sky.

## Running it

Both builds must already be served. Nothing here starts a server.

```sh
export H3D_CHROME=/path/to/chrome        # required: playwright-core ships no browser
export H3D_REFERENCE=http://localhost:8212/home3d.html   # the build to match
export H3D_SUBJECT=http://localhost:8211/index.html      # this repo, served

node scripts/compare/probe.mjs           # capture both, all 10 camera presets
node scripts/compare/pixel-diff.mjs      # per-camera difference percentages
node scripts/compare/scene-diff.mjs      # structured scene-graph comparison
```

`playwright-core` must be resolvable — run from a directory that has it
installed, or set `NODE_PATH`. It is not vendored here: this is a diagnostic
tool, not part of the app, and the app itself has no build step or dependencies.

Useful environment variables:

- `H3D_TAG` — names the output subdirectory, so runs can be compared against
  each other (`H3D_TAG=before`, then `H3D_TAG=after`).
- `H3D_OUT` — where captures go (default `./.compare-out`).
- `H3D_CAMS` — comma-separated preset subset (default: all ten).
- `H3D_SETTLE` — milliseconds to wait before capturing (default 7000).
- `H3D_TOL` — per-channel tolerance for "this pixel differs" (default 8).

## Two things the harness does deliberately

**It waits 7 seconds before every screenshot.** This app renders on demand and
loads textures asynchronously. A screenshot taken on `load` shows an empty or
half-built scene, and a previous session filed a bug against exactly that
artefact. If you shorten the settle, verify against a known-good run first.

**It parks the clouds before capturing.** Cloud sprites are positioned with
`Math.random()` at construction and then drift on `requestAnimationFrame`, so
they never match — not between two builds, and not between two runs of the same
build. Left alone they dominate the pixel diff of every view containing sky.
The harness places them deterministically in both builds immediately before the
screenshot. This normalises a known-random element rather than hiding a real
difference: cloud *count* and material are still compared, by the scene diff.

## Reading the scene diff

`scene-diff.mjs` reports `MATCH`/`DIFFER` per property and finishes with a
bucket table — objects grouped by geometry type plus material signature. A row
reading

```
Mesh|BoxGeometry|MeshStandardMaterial|#c9a06a|0.55|0|false|1|0   109     0   DIFFER
```

says the reference build draws 109 tan boxes that the subject build does not.
That is a concrete, greppable lead: search the reference source for `c9a06a`.

Some differences are expected and harmless. Dev overlays that are built but kept
`visible = false` (a grid, a debug layer) show up as bucket differences while
being invisible in every screenshot — check `visible` on the group before
chasing one.
