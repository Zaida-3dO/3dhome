# Demo models

`test-armchair.glb` is the demo and test file for the `model` furniture type
(`src/furniture/model.js`). It is a blocky armchair made of boxes, generated
by `scripts/make-test-model.mjs`. Regenerate it with:

    node scripts/make-test-model.mjs

`scripts/test-model.mjs` fails if the committed file differs from what the
script writes.

It deliberately carries every shape the type handles:
- a `full` root node with a vertex-coloured part (the frame) and a textured
  part (the seat cushion, a 16 px checker PNG);
- a `low` root node, vertex-coloured only;
- a translated child node, so baking node transforms is exercised.

**Licence: CC0 1.0.** The model, its texture and the script that generates
them were authored for this repository and are dedicated to the public
domain under the Creative Commons CC0 1.0 Universal dedication
(https://creativecommons.org/publicdomain/zero/1.0/).
