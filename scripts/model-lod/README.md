# model-lod

Turns a heavy GLB into a small two-LOD GLB for the `model` furniture type
(`src/furniture/model.js`, `docs/house-profile.md` "Furniture: model").

An **offline tool**. It is not served and not run in CI. It has its own pinned
dependencies, so a run is reproducible:

    cd scripts/model-lod
    npm ci
    node model-lod.mjs <in.glb> <out.glb> [options]

| Option | Default | What it does |
|---|---|---|
| `--drop-node <name>` | — | Drops a node, and its mesh, before anything else. Repeatable or comma-separated. Use it for parts nobody sees (an under-seat mechanism, a hidden box). |
| `--target <n>` | 2500 | The full-LOD triangle budget. |
| `--low <n>` | 800 | The low-LOD triangle budget. |
| `--bake vcol\|atlas512` | `vcol` | `vcol` samples every base-colour texture at every source vertex into `COLOR_0`, then drops the UVs and textures. The result joins the renderer's merged palette bucket at 0 extra draws. `atlas512` shrinks up to four textures to 256 px, packs them into one 512 px atlas and remaps the UVs; that costs a draw and GPU memory, and is kept for comparison. |
| `--gain <k>` | 1 | Multiplies the baked colours (to undo lighting baked dark into the source maps). |
| `--color-weight <w>` | 0.5 | How hard the simplifier protects colour edges. |

**What it does, in order:**
1. Bakes every node transform in.
2. Drops the named nodes.
3. Bakes colour (`vcol`) or packs the atlas (`atlas512`).
4. Merges the primitives and welds shared vertices.
5. Simplifies with meshoptimizer's attribute-aware simplifier, falling back to its sloppy simplifier if the budget is not met.
6. Writes two root nodes, `full` and `low`.

It prints the triangle, vertex and byte counts, plus the sha256 of its input and output. Record those next to the file you place.

It supports JPEG base-colour textures only (`jpeg-js`, pure JS: no native
image library to install).
