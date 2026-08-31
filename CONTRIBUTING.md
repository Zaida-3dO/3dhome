# Contributing

## No build step — keep it that way

This is plain HTML, CSS and vanilla JavaScript, with dependencies vendored under `vendor/`. There is no bundler, no transpiler, no `node_modules`, no `npm run build`. Clone it, serve the directory, and it runs.

That is a deliberate constraint, not an oversight. It means the app can be dropped onto any static host, debugged in a browser with no source maps, and still work in five years. Please don't introduce a build step, a framework, or a package manager for the app itself. Tooling *around* the app — the validator, the privacy guard, CI — may use Python or Node freely.

Dependencies are vendored rather than loaded from a CDN so the app works on a network with no internet access. Keep it that way too.

## Never commit a real house

A floor plan of someone's home, and the list of every light in it, is personal data. This repository is public.

- Only `houses/demo/` — a fictional house — is tracked. Every other profile is gitignored.
- Keep your own house profile in a private repository or an untracked directory, and mount it at deploy time.
- Don't commit `config.js`, `config.json`, `.env`, or anything holding a Home Assistant token.
- Don't paste real entity ids, private network addresses, or public hostnames into code, comments, docs or commit messages.

**Run the guard before you push:**

```bash
./scripts/check-no-pii.sh
```

It fails closed — if it can't establish that something is safe, it fails. That's the intended behaviour; if it flags you wrongly, fix the check rather than loosening it.

## Before opening a pull request

```bash
./scripts/check-no-pii.sh                      # privacy guard
python scripts/validate-house.py houses/demo   # house profile still valid
node --check src/home3d-scene.js               # and any other .js you touched
python -m http.server 8080                     # load it and check the console
```

CI runs the same checks. Please look at the browser console — this is a graphics app, and a broken scene often still returns HTTP 200.

## Merge policy

**A branch being behind `main` does not block a merge.** Only a genuine textual conflict does. Please don't enable "require branches to be up to date before merging" — rebasing every branch every time `main` moves costs more than it protects here.

## House profiles

If you change `houses/schema.json`, bump `schemaVersion` and say in the pull request how existing profiles should migrate. Someone's hand-authored house should never silently stop loading.

Wall ids are permanent: `highestIdEverAssigned` only ever increases, and retired ids are never reused. Gaps in the sequence are deliberate.

## Commits

Short, imperative subject line with a conventional-ish prefix (`feat:`, `fix:`, `docs:`, `ci:`, `chore:`). Explain *why* in the body when the reason isn't obvious from the diff — the next reader is usually you.
