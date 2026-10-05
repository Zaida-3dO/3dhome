# Furniture control descriptors

Edit mode (phase B) needs each furniture type's parameters as data: which are sliders, how far
they go, which are colours, which are option lists. Until now the ranges lived only in the JSX of
`specs/<Type>Spec.html` (`TweakSlider` / `TweakColor` / `TweakSelect`). This is that data.

## For a builder author

A builder module may export `CONTROLS` (a multi-type module puts it on each `TYPES[key]`):

```js
import { range, color, select, toggle, text, unsupported } from './controls.js';

export const CONTROLS = [
  range('width', 'Width', 120, 360, 1, 'cm'),
  color('upholsteryColor', 'Upholstery (fabric)'),
  select('baseFinish', 'Plinth finish', ['matte', 'satin', 'gloss']),
  toggle('duvet', 'Duvet'),
  unsupported('width', 'Width', 'derived'),
];
```

Copy ranges, steps, options and labels from the type's spec page. `CONTROLS` is descriptive only:
`build()` never reads it, so declaring it cannot change what renders.

Every key must be a key of `DEFAULTS`; a range must satisfy `min <= DEFAULTS[key] <= max` and
`step > 0`; a select must contain its default. `scripts/test-furniture-controls.mjs` enforces
this for every registered type, and builds each range at its min and max.

## For a consumer

`controlsFor(type, DEFAULTS, CONTROLS)` returns the full list: the explicit entries first (their
own order), then a derived fallback for every `DEFAULTS` key they do not cover. `loadBuilder()`
passes `CONTROLS` through on its result.

Kinds: `range` (`min`, `max`, `step`, optional `unit`), `color`, `select` (`options`: values or
`{value, label}`), `toggle`, `text`, `unsupported` (`reason`).

`unsupported` reasons: `array` / `object` / `null` (nested or untyped, **not flattened**: a
kitchen's modules or a cabinet's fronts need their own editor), `derived` (an output of other
params, such as an envelope the builder computes), `coupled` (only meaningful together with
other params), `fixed` (a measured constant the spec page does not expose). A UI should not draw
a control for these.

`mirror: ['depth']` on a range means "also write this value to those keys" (a round table has
one Diameter slider that sets width and depth).

### Which controls a panel draws: `kinds`, `when` and `CONTROL_RULES`

Two optional descriptor fields say when a control means something:

- `kinds: ['wall-planter']`: only for an item whose `params.kind` is one of these (a wall
  planter's "contents" means nothing on a floor plant).
- `when: { led: true }`: only while every named param has that value, or one of a list of
  values (`when: { habit: ['trailing'] }`). The LED colour hides while the LED is off.

`visibleControls(controls, values)` applies both, plus dropping `unsupported`, to the item's
`values` (its `DEFAULTS` merged with its `params`). Edit mode redraws the panel when a param that
another control's `when` names (or `kind`) changes.

A builder whose controls are mostly DERIVED adds a dependency without listing every control by
exporting `CONTROL_RULES` (a multi-type module puts it on `TYPES[key]`): `{ key: { when?, kinds?,
label?, min?, max?, step?, unit? } }`, patched onto that key's control, explicit or derived,
without moving it. `controlsFor(type, DEFAULTS, CONTROLS, CONTROL_RULES)` takes it as its fourth
argument, and `loadBuilder()` passes it (and a builder's plain-object `PRESETS`) through. The
cabinet uses it to turn the derived `gain` (0..2, step 1) into "Brightness lift" (0.5..2, step
0.05). `only(control, { kinds, when })` adds the fields to an entry in a `CONTROLS` table.

### Units

A range with no `unit` whose key names a length (`width`, `depth`, `height`, `*Width`,
`*Height`, `*Diameter`, `*Thickness`, `*Offset`, ... see `isLengthKey`) gets `unit: 'cm'` from
`controlsFor`, so every length row in the panel says cm. Counts, angles, seeds and gains never do.

## The derived fallback

| Default | Derived range |
|---|---|
| positive `d` | `0.5d .. 2d`, rounded OUTWARD to a grid by size (10 from 100, 5 from 10, 1 from 1, else 0.1); the minimum never rounds to 0 or below. A 167.1 cm TV width gives 80..340, not 83.55..334.2 |
| `0` | absolute `0..100` (a count: `0..10`) |
| negative `d` | symmetric `-2|d| .. 2|d|` (0.5x..2x would invert) |
| count-like key (`count`, `n`, `num*`, `*Count`) or integer default | step 1, whole-number bounds |
| angle-like key (`*deg*`, `angle`, `yaw`, `rotation`, `lean`, `tilt`, `recline`) | `-180..180`, step 1, unit `°` |
| other fraction | step `0.1` (`0.5` from 10 up, `0.01` below 1) |
| `#rrggbb` | colour |
| boolean | toggle |
| `finish` / `*Finish` holding a palette name | select of the palette minus glass / mirror / emissive |
| other string | text |
| array / object / `null` | `unsupported` |

The fallback is a guess at a sensible slider, not a spec. A type whose spec page has no slider for a
parameter (the bathroom fittings, the kitchen runs, most of the small items) gets the fallback for
its numbers; `CONTROLS` there names only what a guess cannot know: option lists from the schema,
couplings and derived envelopes. The schema's `minimum` / `maximum` / `integer` bounds are enforced
on every control by the test.

## Not covered

`model` (the `.glb` type), and the spec pages whose objects are not furniture builders: curtains,
doors, windows, rugs and the strip-light playground.
