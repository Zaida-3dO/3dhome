# `houses/demo` — the fictional demo house

This is the house the app ships with. It is **invented** — a seven-room flat that
exists only to make the app runnable and evaluable straight after a clone. It is
not anyone's home, and no part of it is measured from one.

It is deliberately built to exercise the whole engine, so that "does this render"
is a real question with a real answer:

| Feature | Where to see it |
|---|---|
| An **L-shaped room** | `study` — wraps around a chimney breast; its polygon is re-entrant, and the floor slab, click target and bounding box all have to cope |
| **Exterior and interior walls** | 20 cm shell (`exterior: true`, fades when you look in from outside) vs 10 cm partitions |
| A **pillar** | wall 15 — a boxed-in soil stack, which is just a short thick wall |
| **Retired wall ids** | 7 and 13 are permanently retired; `highestIdEverAssigned` is 15 |
| A **cupboard door** | `store_door` — `kind: cupboard`, stopped at 28° by its return wall |
| **Several light channels per room** | `main` + `ambient` in four rooms; downlights, spots, strips and a bulb |
| **Auto-placed lights** | `store` gives a `count` and no positions, so the engine places it |
| **Both rug forms** | `lounge` gives an explicit polygon; `bedroom` gives only an `inset` |
| A **room-clipped wall texture** | wall 10 papers only the `hall` portion of its face |

| File | Purpose |
|---|---|
| `geometry.json` | Rooms, walls, doors and light positions. |
| `rooms.json` | Room id → Home Assistant entity ids. |
| `textures/` | Flat-colour or CC0 textures only. Never a photograph of a real wall. |

## Rules this directory must keep

`scripts/check-no-pii.sh` enforces all three:

1. **Entity ids must be fictional** — prefixed `demo_` (or containing `_demo_`).
   `light.demo_lounge_ceiling` is fine. A realistic-looking id naming a real
   room is not, even as a placeholder - the guard rejects it.
2. **Textures stay small** — under 256 KB. A photograph of a real wall is
   typically 800 KB–1.4 MB, so the size cap doubles as a "this is not a
   photograph" check.
3. **This is the only house directory in the repo.** All others are gitignored
   and mounted privately at deploy time.

## Making your own house

Copy this directory, don't edit it:

```sh
cp -r houses/demo houses/myhouse
```

`houses/myhouse/` is gitignored automatically, so your real floor plan cannot be
committed by accident. Point the app at it with `HOME3D_HOUSE=myhouse`.
