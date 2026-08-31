# Contributing to 3dHome

Thanks for taking a look. Three things matter more than anything else here.

## 1. It stays buildless

3dHome is plain HTML, CSS and JavaScript, served as static files. There is no
bundler, no transpiler, no `package.json`, and no `node_modules`. Open a file,
edit it, reload the page.

Please do not introduce a build step. It is a deliberate constraint, not an
oversight: it keeps the app forkable by someone who wants to change the colour
of a wall without first installing a toolchain, and it means what you read in
the repo is exactly what runs in the browser.

Practical consequences:

- Third-party libraries are **vendored** into `vendor/` as files, not installed.
- Use browser-native JavaScript. No JSX or TypeScript in `src/`. (The pages under
  `specs/` are the one exception — they transpile JSX in the browser at runtime.)
- Node is used in CI only, as a syntax checker and schema validator.

## 2. Never commit a real house

This repo is public. A floor plan with room names and Home Assistant entity ids
describes where somebody lives and what is installed in it.

- `houses/demo/` is **fictional** and is the only house directory in the repo.
- Every other `houses/*/` is gitignored. Keep yours there and it is safe.
- Entity ids in `houses/demo/rooms.json` must be invented — a `demo_` prefix,
  e.g. `light.demo_lounge_ceiling`.
- Never commit `config.js` or `config.json`; both hold your Home Assistant token.
- No photographs of a real home, and no screenshots of a real house model.

**Run the guard before you push:**

```sh
sh scripts/check-no-pii.sh
```

It scans the working tree for house data, private network addresses, personal
hostnames and credential-shaped strings, and it fails closed — if it cannot
establish that something is safe, it fails. The same script runs on every pull
request and is a required check. If it flags something, it will tell you the
file, the line and what to do about it.

If you think it flagged you wrongly, say so in the pull request rather than
loosening the check. A guard people route around is worse than no guard.

## 3. Commits and pull requests

Conventional-ish commit subjects, lowercase, imperative, with a scope when one
is obvious:

```
feat(scene): render door swing arcs
fix(ha-client): reconnect after a dropped websocket
docs(readme): explain the token exposure
chore(vendor): update three.js to r150
```

For a pull request:

- Keep it focused; one concern per PR.
- Say what you changed and why. If it is visual, attach a screenshot **of the
  demo house**, never of a real one.
- Make sure CI is green: the PII guard, `node --check` on JavaScript, and JSON
  schema validation of any house profile.
- If you changed how a house profile is shaped, update `houses/schema.json` and
  `docs/house-profile.md` in the same PR.

## Reporting a security issue

Please do not open a public issue for a vulnerability. See the
[Security](README.md#security) section of the README for how the app handles the
Home Assistant token, and report anything sensitive privately to the maintainer.
