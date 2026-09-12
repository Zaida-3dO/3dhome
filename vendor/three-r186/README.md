# three.js r186 — ES module build

Both files are **unmodified** copies from the published npm package
`three@0.186.0`:

    https://registry.npmjs.org/three/-/three-0.186.0.tgz
      package/build/three.module.js    662,772 B raw / 130,745 B gzip -9
      package/build/three.core.js    1,458,113 B raw / 286,358 B gzip -9

**This is not a build step.** Nothing in this repo minifies, transpiles or
generates these; they are copied byte-for-byte from upstream's tarball.

## Why there are two files, and why only one is in the import map

`three.module.js` opens with `import { ... } from './three.core.js'` — a
**relative** specifier. So the two must sit in the same directory, and the
import map only ever names the bare specifier `three`; `three.core.js` resolves
relative to its importer's URL and is outside the map's reach.

That is also why the **revision is in the directory name**. The `?v=__VERSION__`
cache-bust can ride on the import map's value, but nothing can stamp a query
onto the relative import inside a vendored third-party file. Putting `r186` in
the path means a version bump changes *both* files' URLs, which is what makes
`immutable` caching in `deploy/nginx.conf` correct rather than merely lucky.

## Why these are unminified, and why that is accepted

Upstream **stopped publishing a minified ESM build**. r160 shipped
`three.module.min.js`; at r186 `build/` contains only `three.cjs`,
`three.core.js`, `three.module.js`, `three.tsl.js`, `three.webgpu.js` and
`three.webgpu.nodes.js`. There is no minified ES module to take.

The cost is **+250,489 B gzipped** against the r160 UMD build this replaced
(417,103 B vs 166,614 B). That is accepted on the parent project's measured
ground truth: every resource fetch here completes in under 50 ms and the real
cold-start bottleneck is GPU shader compilation at 9–45 s. A quarter-megabyte
against a sub-50 ms fetch budget is noise against a 9–45 s wall.

**Do not "fix" this by adding a minifier.** That would be a build step, which is
the exact property this app is organised around — see the Dockerfile's header.

## Caution when verifying these files

`https://cdn.jsdelivr.net/npm/three@0.186.0/build/three.module.min.js` returns
**HTTP 200** with a `Minified by jsDelivr` banner. jsDelivr synthesises that
file on the fly; it is **not** a published artefact. Use `tar -tzf` on the npm
tarball as the authority, not a CDN 200.

## Do not delete `vendor/three.js`

The r160 **UMD** build next door is still loaded by the five `specs/*.html`
pages, which use in-browser Babel and cannot consume ES modules. The two never
load on the same page. Migrating those pages is a separate job.

## What changed from r160 that touches this app

- **r163 removed WebGL 1 support.** The `WebGLRenderer` constructor now asks for
  `'webgl2'` and nothing else, and **throws from inside the constructor** when it
  cannot get one — see the guard around `new THREE.WebGLRenderer` in
  `src/home3d-scene.js`.
- **r181 improved PBR energy conservation**, so rough `MeshStandardMaterial`
  surfaces render slightly brighter. Upstream's stated intent, not a bug.
- **r152 removed `sRGBEncoding`.** The two dead fallback branches that referenced
  it were deleted with this bump.
