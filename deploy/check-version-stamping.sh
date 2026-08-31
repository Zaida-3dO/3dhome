#!/bin/sh
# ---------------------------------------------------------------------------
# check-version-stamping.sh - fail if a version number has been hardcoded
# where the build placeholder belongs.
#
# WHY THIS EXISTS, AND WHY IT IS A SCRIPT AND NOT A RULE IN A DOC.
#
# The predecessor of this repo kept its version in three places across two HTML
# files and synchronised them by discipline - a comment in the markup saying
# "keep these in sync" and a habit of grepping before saving. That failed three
# separate times, and not subtly:
#
#   home3d.html  home3d-scene.js?v=0.1.106     index.html  ...?v=0.1.105
#   home3d.html  ha-client.js?v=0.1.059        index.html  ...?v=0.1.061
#   the visible badge said 0.1.104, matching neither file
#
# Note the second row drifted the OPPOSITE way to the first, which is what
# rules out "someone forgot to bump one file" as the story - the two files were
# edited independently, in both directions, over months. The user-visible
# consequence was two pages on one origin serving different cached builds of
# the same script, i.e. "it works on the 3D page but not in the sidebar" - a
# bug that is close to undiagnosable from the symptom.
#
# The fix was to delete the discipline: index.html now carries __VERSION__ and
# deploy/generate-config.sh stamps ONE value into every occurrence at container
# start. The badge and all six ?v= strings are then identical by construction.
#
# This script is what stops that fix from being quietly undone. A hardcoded
# version is not a style violation here; it is the reintroduction of the exact
# failure mode. So it is enforced by a program in CI, on every PR, rather than
# by a comment asking a human to remember.
#
# POSIX sh, no dependencies beyond grep and sed. Runnable by hand:
#     sh deploy/check-version-stamping.sh
# Exit 0 = clean, 1 = a violation was found.
# ---------------------------------------------------------------------------

set -u

# Resolve the repo root from this script's location, so it works from anywhere.
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT=${1:-$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)}

cd "$ROOT" || { echo "FATAL: cannot cd to $ROOT" >&2; exit 1; }

# Built at runtime so this script's own source cannot be rewritten by the very
# sed in generate-config.sh that substitutes the placeholder.
PLACEHOLDER='__'"VERSION"'__'

fail=0
note() { printf '%s\n' "$1"; }

note "=== 3dHome version-stamping guard ==="
note "repo: $ROOT"
note ""

# ---------------------------------------------------------------------------
# [1] No hardcoded version on a ?v= cache-buster in any served HTML.
#
# This is THE check - it is the precise thing that drifted. Every ?v= in a
# served page must be the placeholder, never a literal number.
# ---------------------------------------------------------------------------
hits=$(grep -rn '?v=[0-9]' --include='*.html' . 2>/dev/null \
  | grep -v '^\./vendor/' || true)

if [ -n "$hits" ]; then
  note "FAIL  [1/3] a hardcoded version appears on a ?v= cache-buster"
  note ""
  printf '%s\n' "$hits" | sed 's/^/        /'
  note ""
  note "        Every ?v= in served HTML must read ?v=${PLACEHOLDER} and be"
  note "        substituted at deploy time by deploy/generate-config.sh."
  note "        Hardcoding one is what caused the predecessor's drift: two"
  note "        pages served different cached builds of the same script."
  note ""
  fail=1
else
  note "PASS  [1/3] no hardcoded version on any ?v= cache-buster"
fi

# ---------------------------------------------------------------------------
# [2] No hardcoded version in a visible version badge.
#
# The badge drifted from the ?v= strings independently (it read 0.1.104 while
# neither script tag did), so it needs its own check. Matches a v-prefixed
# dotted number sitting in element text, e.g. >v1.2.3< or >v0.1.104</span>.
# ---------------------------------------------------------------------------
hits=$(grep -rnE '>[[:space:]]*v[0-9]+\.[0-9]+(\.[0-9]+)?[[:space:]]*<' \
  --include='*.html' . 2>/dev/null | grep -v '^\./vendor/' || true)

if [ -n "$hits" ]; then
  note "FAIL  [2/3] a hardcoded version appears in a visible badge"
  note ""
  printf '%s\n' "$hits" | sed 's/^/        /'
  note ""
  note "        The badge must read v${PLACEHOLDER} so it is stamped from the"
  note "        same APP_VERSION as the ?v= strings. A badge maintained by"
  note "        hand is what made the predecessor's badge disagree with BOTH"
  note "        of its own script tags."
  note ""
  fail=1
else
  note "PASS  [2/3] no hardcoded version in a visible badge"
fi

# ---------------------------------------------------------------------------
# [3] index.html still carries the placeholder at all.
#
# Checks [1] and [2] are satisfied vacuously if someone deletes the version
# machinery outright - no hardcoded version, because no version. This asserts
# the mechanism is still present and wired, so the guard cannot be silenced by
# removing the thing it guards.
#
# It counts, rather than merely finding one: the badge plus every script tag
# must be a placeholder, and a file that has lost most of them is a file that
# is being un-stamped one line at a time.
# ---------------------------------------------------------------------------
if [ ! -f index.html ]; then
  note "FAIL  [3/3] index.html is missing"
  fail=1
else
  # grep -c prints 0 AND exits non-zero when there are no matches, so the
  # obvious `grep -c ... || echo 0` appends a SECOND zero and yields a
  # two-line value. That is not an integer, it breaks the -lt test below, and
  # the check then falls through to a PASS - i.e. the one case this check
  # exists to catch would be the one case it missed. Count occurrences with
  # grep -o | wc -l instead, which returns a single number either way.
  count=$(grep -o "$PLACEHOLDER" index.html 2>/dev/null | wc -l | tr -d ' ')
  [ -z "$count" ] && count=0
  # The badge (1) plus the script tags. Six script tags today; require the
  # badge plus at least four so adding or removing one module is not a
  # false positive, while deleting the scheme still trips.
  if [ "$count" -lt 5 ]; then
    note "FAIL  [3/3] index.html has only $count ${PLACEHOLDER} placeholder(s)"
    note ""
    note "        Expected the visible badge plus one per cache-busted script"
    note "        tag. Too few means the stamping scheme is being removed - if"
    note "        that is genuinely intended, update this guard in the same"
    note "        commit and say why in the message."
    note ""
    fail=1
  else
    note "PASS  [3/3] index.html carries $count ${PLACEHOLDER} placeholder(s)"
  fi
fi

note ""
note "--- summary ---"
if [ "$fail" -eq 0 ]; then
  note "RESULT: PASS"
  note "One version, stamped from APP_VERSION at deploy time. No drift possible."
  exit 0
else
  note "RESULT: FAIL"
  note ""
  note "Fix by using the ${PLACEHOLDER} placeholder instead of a literal"
  note "version, and letting deploy/generate-config.sh substitute it. See"
  note "docs/deployment.md and the header of this script for the history."
  exit 1
fi
