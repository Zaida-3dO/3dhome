# CI & Release

Two workflows live in `.github/workflows/`. Both are intentionally small: this is a
**static, no-build** app (plain HTML/CSS/JS plus a vendored three.js), served by
`nginx:alpine`. There is no bundler, no `node_modules` in the image, and no test
framework yet. Please keep it that way unless there is a concrete reason not to.

---

## Merge policy — read this before touching branch protection

> **A branch being behind `main` MUST NOT block a merge.**
> Only a genuine textual conflict blocks.

This is a deliberate decision by the repo owner, not an oversight. Concretely:

- **Do NOT** enable *"Require branches to be up to date before merging"* (GitHub's
  "strict" mode) on the `main` protection rule.
- **Do NOT** add a workflow job that compares the PR head against `main` and fails
  when it is behind (no `git merge-base --is-ancestor` gate, no "please rebase" bot).
- A PR that is 40 commits behind `main` and still merges cleanly is **fine** and
  should merge without a rebase.

The reasoning: strict mode serialises every merge — each merge invalidates every
other open PR's status and forces a rebase-and-rerun round trip. For a repo this
size that cost buys almost nothing, because the checks below are near-stateless.
If a semantic (non-textual) conflict ever does slip through, the fix is to catch it
in CI on `main`, not to tax every PR in advance.

If you are a future contributor about to "helpfully" turn strict mode on: don't.
Raise it as an issue first.

---

## `ci.yml`

Runs on every `push` to `main` and every `pull_request` against `main`.

### The paths-filter + gate-job pattern

Some jobs are irrelevant to most PRs — linting workflows when no workflow changed,
building the Docker image when no Docker file changed. Running them anyway wastes
minutes; skipping them naively breaks **required status checks**, because a skipped
job never reports success and a required check that never arrives blocks the merge
forever.

The pattern that solves both:

1. A `changes` job runs `dorny/paths-filter` once and outputs a boolean per path group.
2. The real job (e.g. `actionlint`) is `if:`-gated on that boolean, so it skips cheaply.
3. A **gate job** (e.g. `actionlint-gate`) runs `if: always()` and is the job you mark
   as required. It passes when the path did not change, and fails when the path *did*
   change and the real job did not succeed.

So the required check is always reported, and an unchanged path is never punished.
**Mark the `*-gate` jobs as required, never the underlying job.**

### Jobs

| Job | Gated on | What it does |
|---|---|---|
| `changes` | — | Computes the `workflows` and `docker` path booleans. |
| `actionlint` | `.github/workflows/**` | `raven-actions/actionlint@v2` — lints workflow syntax, expressions, and (via bundled shellcheck) the `run:` script bodies. |
| `actionlint-gate` | always | **Required check** for the above. |
| `pii-guard` | always | Runs `scripts/check-no-pii.sh`. |
| `js-syntax` | always | `node --check` on every `.js` in `src/` and `scripts/`; `JSON.parse` on every `.json` in `houses/` and the repo root. |
| `house-profiles` | always | Validates each `houses/*/geometry.json` against `houses/schema.json` with ajv. |
| `docker-dry-run` | Docker-relevant paths | Builds the image with `push: false`. |
| `docker-dry-run-gate` | always | **Required check** for the above. |

### Notes on individual jobs

**`pii-guard` fails loudly when its script is missing.** This repo is public, and a
guard that can be switched off by deleting a file is not a guard. If
`scripts/check-no-pii.sh` is absent the job fails with an explicit error rather than
silently passing. Do not "fix" a red build by removing the script.

**`js-syntax` is a parse gate, not a linter.** With no bundler and no test suite,
`node --check` is what stands between a typo and a blank page in production. It
deliberately skips `vendor/` — that is third-party code we do not edit, and three.js
is large enough to dominate the job's runtime for no benefit. Node 24 parses ESM in
`.js` files transparently, so `import`/`export` at the top level is fine.

**`house-profiles` skips gracefully only while the schema is genuinely absent.**
`houses/schema.json` landed as part of a later milestone. Until it exists the job
prints a clear message and exits 0. Once it exists, a profile that fails validation
is a **hard failure** — the skip is for the missing-schema case only, never for a
bad profile.

---

## `release.yml`

Manual only: **Actions → Release → Run workflow**.

- **`version` input is optional.** Supply a value (e.g. `v1.2.0`) and it is used
  verbatim. **Leave it blank and the minor version auto-increments** from the newest
  existing tag: `v0.3.0` → `v0.4.0`. With no tags at all, the first release is `v0.1.0`.
- The tag is created and pushed by `github-actions[bot]`.
- The Docker image is built and pushed to GHCR as **both** `:latest` and `:<version>`,
  with `APP_VERSION=<tag>` passed as a build arg (the container entrypoint stamps that
  into the version badge and every `?v=` cache-buster — see `PLAN.md` §5.2).
- A GitHub Release is cut with `--generate-notes`.
- `concurrency: group: release, cancel-in-progress: false` — two releases never
  interleave, and a running one is never cancelled half-way through a tag push.

### Why the tag sort is `-version:refname`

`git tag --sort=-version:refname` sorts **numerically**, not lexically. This matters:
under a plain lexical sort `v0.9.0` sorts *after* `v0.10.0`, so the tenth release
would bump back to `v0.10.0` forever. The version sort gets `v0.10.0 > v0.9.0` right.

### The GHCR image name is lowercased

GHCR rejects uppercase characters in a repository path, and the GitHub owner
(`Zaida-3dO`) contains them. The `publish` job folds `github.repository_owner` to
lowercase before building the image reference, giving `ghcr.io/zaida-3do/3dhome`.

### `workflow_dispatch` input handling

The `version` input is passed to the shell through `env:` rather than interpolated
into the script body. On a public repo a `${{ }}` expression pasted directly into a
`run:` block is a script-injection vector; the `env:` form is not. Keep it that way.
