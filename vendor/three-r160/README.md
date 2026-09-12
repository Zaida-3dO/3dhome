# three.js r160 — ES module build

`three.module.min.js` is the **unmodified** `build/three.module.min.js` from the
published npm package `three@0.160.0`.

    https://registry.npmjs.org/three/-/three-0.160.0.tgz  ->  package/build/three.module.min.js
    sha256  3e690ac7d180b0aadf0891bea39eec643e29e2d3e75c99b18689518665f69ba6
    bytes   670,681 raw / 166,182 gzip -9

**This is not a build step.** The file is copied byte-for-byte from upstream's
published tarball; nothing in this repo minifies, transpiles or generates it.
Using an upstream-published `.min` artefact is a vendoring choice, in the same
way `vendor/three.js` (the r160 *UMD* build) already is.

## Why the directory carries the revision

`vendor/three-r160/` rather than `vendor/three/` so that a version bump changes
the **path**, not just the contents. The importmap value is cache-busted with
`?v=__VERSION__`, but a future r186 splits into `three.module.js` +
`three.core.js` where the second is reached by a *relative* import from inside
the first — a URL this repo cannot stamp without editing vendored code. Putting
the revision in the path makes every file's URL change on a bump, which is what
makes nginx's `immutable` caching (`deploy/nginx.conf`) correct rather than
merely lucky.

## Why the minified ESM build, and why that stops being an option later

r160 is the last revision that ships **both** a UMD build and a *minified* ESM
build. Upstream dropped `three.module.min.js` after r16x: at r186 `build/`
contains only unminified `three.module.js` + `three.core.js`. So this file is
gzip-for-gzip equivalent to the UMD build it replaces (166,182 vs 166,614 B),
which is what lets the module-format migration be verified as a no-op before any
version change is attempted.

## Do not delete `vendor/three.js`

The r160 **UMD** build next door is still loaded by the five `specs/*.html`
pages, which use in-browser Babel and cannot consume ES modules. The two never
load on the same page.
