# `houses/demo` — the fictional demo house

This is the house the app ships with. It is **invented** — a small four-room flat
that exists only to make the app runnable and evaluable straight after a clone.
It is not anyone's home.

| File | Purpose |
|---|---|
| `geometry.json` | Rooms, walls, doors and light positions. *(added in the house-profile phase)* |
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
