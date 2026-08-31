#!/bin/sh
# ---------------------------------------------------------------------------
# check-no-pii.sh - privacy guard for the PUBLIC 3dHome repo.
#
# This repo is public and must never contain data describing a real home, the
# owner's network, or a Home Assistant credential. This script scans the whole
# working tree and FAILS CLOSED: if it cannot positively establish that
# something is safe, it fails.
#
# Runs on POSIX sh. Verified in Git Bash on Windows and on ubuntu-latest.
# Usage:  sh scripts/check-no-pii.sh
# Exit:   0 = all checks passed, 1 = at least one check failed.
# ---------------------------------------------------------------------------

set -u

REPO_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$REPO_ROOT" || { echo "FATAL: cannot cd to repo root"; exit 1; }

FAILURES=0
CHECK_NO=0
TOTAL_CHECKS=9

# Personal names that must not appear in a public repo. The app was extracted
# from a private one, so migrated files can still carry the owner's name in a
# heading ("Ope's Home"), in the old product's branding ("Haven"), or in a code
# comment recording who asked for a change. Kept as a list so it is obvious
# what is being matched and easy to extend.
OWNER_NAMES="Ope Opes Tomi Haven Zevirdrah Calliope Clayde Patrick"

# Size threshold for demo textures, in bytes (256 KB).
# Photographs of real walls run 800 KB - 1.4 MB; procedural/CC0 demo textures
# are far smaller. The cap therefore doubles as a "this is not a photo" check.
TEXTURE_MAX_BYTES=262144

# Files excluded from CONTENT scanning only, because they legitimately contain
# the very patterns being searched for:
#   - this script itself (it holds every pattern as a literal)
#   - PLAN.md, the migration doc from the private predecessor. It is gitignored
#     and must never be committed; check 7 enforces that separately.
CONTENT_EXCLUDES="scripts/check-no-pii.sh PLAN.md"

pass() { CHECK_NO=$((CHECK_NO + 1)); printf 'PASS  [%d/%d] %s\n' "$CHECK_NO" "$TOTAL_CHECKS" "$1"; }
fail() {
  CHECK_NO=$((CHECK_NO + 1))
  FAILURES=$((FAILURES + 1))
  printf 'FAIL  [%d/%d] %s\n' "$CHECK_NO" "$TOTAL_CHECKS" "$1"
}
detail() { printf '        %s\n' "$1"; }
remedy() { printf '        -> %s\n' "$1"; }

# is_excluded <path> - true if the path is exempt from content scanning.
is_excluded() {
  _p=${1#./}
  for _e in $CONTENT_EXCLUDES; do
    [ "$_p" = "$_e" ] && return 0
  done
  return 1
}

# scan_files - emit every regular file eligible for content scanning.
# .git holds packed history (this repo starts from a fresh history by design)
# and node_modules is not source, so both are pruned.
scan_files() {
  find . \
    \( -name .git -o -name node_modules \) -prune -o \
    -type f -print 2>/dev/null | while IFS= read -r f; do
      is_excluded "$f" || printf '%s\n' "$f"
    done
}

# grep_tree <extended-regex> - print "file:line:text" for every match across
# the scannable tree. Binary files are searched too (-a): -I would skip them
# entirely, which would not fail closed.
#
# One recursive grep rather than one grep per file: the per-file loop spawned a
# process per file per check, which is slow enough to matter in CI on Windows.
# --exclude-dir prunes the same directories scan_files does, and the content
# exemptions are applied by filtering the results.
grep_tree() {
  _pattern=$1
  shift
  # vendor/ is third-party (three.js, react, babel) and several MB of minified
  # JS. Scanning it for house data is pointless and slow, so it is pruned by
  # default. Pass -v to include it: the credential check DOES scan it, because
  # a pasted token in a vendored file would be a real leak.
  _vendor_prune="--exclude-dir=vendor"
  [ "${1:-}" = "-v" ] && _vendor_prune=""
  # shellcheck disable=SC2086
  grep -r -n -E -a \
    --exclude-dir=.git --exclude-dir=node_modules $_vendor_prune \
    -- "$_pattern" . 2>/dev/null \
  | sed 's|^\./||' \
  | while IFS= read -r hit; do
      _f=${hit%%:*}
      is_excluded "$_f" || printf '%s\n' "$hit"
    done
}

printf '=== 3dHome privacy guard ===\n'
printf 'repo: %s\n\n' "$REPO_ROOT"

FILE_COUNT=$(scan_files | grep -c '' 2>/dev/null || true)
[ -z "$FILE_COUNT" ] && FILE_COUNT=0

# ---------------------------------------------------------------------------
# Check 1 - only houses/demo/ may exist under houses/
# ---------------------------------------------------------------------------
STRAY_HOUSES=$(find houses -mindepth 1 -maxdepth 1 -type d 2>/dev/null \
  | sed 's|^houses/||' | grep -v '^demo$' || true)
if [ -n "$STRAY_HOUSES" ]; then
  fail "houses/ contains only the demo house"
  printf '%s\n' "$STRAY_HOUSES" | while IFS= read -r h; do
    [ -n "$h" ] && detail "houses/$h/ is a non-demo house directory"
  done
  remedy "A real house must live in a PRIVATE overlay mounted at deploy time,"
  remedy "not in this repo. Move it out and set HOME3D_HOUSE to the mount point."
else
  pass "houses/ contains only the demo house"
fi

# ---------------------------------------------------------------------------
# Check 2 - Home Assistant entity ids
#
# No entity id anywhere except houses/demo/rooms.json, and every id there must
# be fictional: the object id must start with `demo_` or contain `_demo_`.
#
# What counts as an entity id, precisely. The risk being guarded against is a
# real entity id shipped as DATA - a string the app would actually send to Home
# Assistant. So an id is flagged when it appears as a quoted string value
# ("light.foo") or a bare code token, which is how real data and real code
# carry one. A mention inside prose or inside a JSON "description" is not a
# device inventory and is not flagged; those files are matched by ENTITY_RE
# but filtered below. Being narrow here is deliberate: this guard is a required
# CI gate for the whole repo, and a false positive on documentation trains
# people to weaken it, which is worse than the narrow rule.
# ---------------------------------------------------------------------------
ENTITY_RE='"(light|switch|sensor|binary_sensor|cover)\.[a-z0-9_]+"'

# is_fictional_id <object_id> - true if an id is obviously invented.
#
#   demo_* / *_demo_*   the demo house's own convention (required in
#                       houses/demo/rooms.json, which is real config the app
#                       loads, so the bar there is highest)
#   example_* / my_* / your_* / foo_* / bar_*
#                       conventional placeholder prefixes, allowed in docs
#
# A doc must be able to show the file format, so docs may also use a plain
# generic id built only from common room/fixture words (light.kitchen_ceiling).
# That is handled by GENERIC_RE below, and applies to documentation ONLY.
is_fictional_id() {
  case "$1" in
    demo_*|*_demo_*|example_*|my_*|your_*|foo_*|bar_*) return 0 ;;
    *) return 1 ;;
  esac
}

# Generic documentation ids: every underscore-separated word must come from a
# closed vocabulary of ordinary room and fixture nouns. `kitchen_ceiling` is
# generic; `opes_bedroom_galaxy` is not, because the words are not in the list.
GENERIC_WORD='(kitchen|living|room|lounge|bedroom|bathroom|hall|hallway|landing|office|study|studio|garage|porch|attic|basement|utility|laundry|dining|nursery|closet|pantry|stairs|corridor|balcony|garden|main|ceiling|lamp|light|lights|strip|cove|ambient|accent|spot|spots|wall|floor|desk|bed|side|table|front|back|left|right|upper|lower|top|bottom|inner|outer|north|south|east|west|one|two|1|2)'

ENTITY_HITS=$(grep_tree "$ENTITY_RE" || true)

# Documentation about the format is not a device inventory. Drop hits sitting
# inside a JSON schema "description"/"$comment"/"title" string, where the id is
# prose explaining the field rather than a value the app would ever send.
ENTITY_HITS=$(printf '%s\n' "$ENTITY_HITS" \
  | grep -v -E '"(description|\$comment|title|_comment)"[[:space:]]*:' \
  | grep -v '^$' || true)

# Classify every individual id, per file class:
#
#   houses/demo/rooms.json  real config the app loads -> must be demo_*
#   docs/** and *.md        documentation -> fictional prefix OR generic words
#   everything else         no entity ids at all; they are runtime config
#
ENTITY_BAD=$(printf '%s\n' "$ENTITY_HITS" | while IFS= read -r line; do
  [ -z "$line" ] && continue
  _file=${line%%:*}
  _loc=$(printf '%s' "$line" | cut -d: -f1-2)
  printf '%s' "$line" | grep -o -E "$ENTITY_RE" | tr -d '"' | while IFS= read -r id; do
    _obj=${id#*.}
    case "$_file" in
      houses/demo/rooms.json)
        is_fictional_id "$_obj" || \
          printf '%s  (%s)  <- demo config must use a demo_ prefix\n' "$_loc" "$id"
        ;;
      docs/*|*.md)
        if ! is_fictional_id "$_obj"; then
          if ! printf '%s' "$_obj" | grep -q -E "^${GENERIC_WORD}(_${GENERIC_WORD})*$"; then
            printf '%s  (%s)  <- not a generic or placeholder id\n' "$_loc" "$id"
          fi
        fi
        ;;
      *)
        printf '%s  (%s)  <- entity ids do not belong in this file\n' "$_loc" "$id"
        ;;
    esac
  done
done)

if [ -n "$ENTITY_BAD" ]; then
  fail "Home Assistant entity ids are demo-only"
  printf '%s\n' "$ENTITY_BAD" | while IFS= read -r h; do
    [ -n "$h" ] && detail "$h"
  done
  remedy "A real entity id names a real device in a real home. Keep them out of"
  remedy "the repo entirely: they belong in runtime config (rooms.json for a"
  remedy "private house, mounted at deploy time)."
  remedy "In houses/demo/rooms.json use an invented id: light.demo_lounge_ceiling."
  remedy "In docs, use a placeholder (light.example_ceiling) or a plainly generic"
  remedy "id (light.kitchen_ceiling)."
else
  pass "Home Assistant entity ids are demo-only"
fi

# ---------------------------------------------------------------------------
# Check 3 - network identifiers: tailnet name, *.ts.net, RFC1918, personal domain
# ---------------------------------------------------------------------------
# RFC1918: 192.168.0.0/16, 10.0.0.0/8, 172.16.0.0/12 (172.16 - 172.31).
#
# Matched as a COMPLETE dotted quad, with `\<` / `\>` word boundaries so the
# match cannot start or end in the middle of a longer number. Without that, a
# leading `(^|[^0-9.])` group consumes a character and lets the regex re-anchor
# mid-string, which made `v1.10.3` match the 10/8 branch and `172.15.1.1` match
# via its trailing `.1.1`. Both are false positives, and a privacy guard that
# cries wolf on version strings is one people start bypassing.
RFC1918_RE='\<(192\.168\.[0-9]{1,3}\.[0-9]{1,3}|10\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}|172\.(1[6-9]|2[0-9]|3[01])\.[0-9]{1,3}\.[0-9]{1,3})\>'
NET_RE="forest-wage|[A-Za-z0-9_-]+\.ts\.net|${RFC1918_RE}|[A-Za-z0-9_.-]*3dojoda\.com"
NET_HITS=$(grep_tree "$NET_RE" || true)
NET_HITS=$(printf '%s\n' "$NET_HITS" | grep -v '^$' || true)
if [ -n "$NET_HITS" ]; then
  fail "no private network identifiers (tailnet, *.ts.net, RFC1918, personal domain)"
  printf '%s\n' "$NET_HITS" | while IFS= read -r h; do
    [ -n "$h" ] && detail "$h"
  done
  remedy "Hostnames and LAN addresses are deployment config, not repo content."
  remedy "Use an env var (HOME3D_HA_URL / HOME3D_HA_FALLBACK_URL) and, in docs,"
  remedy "a placeholder such as https://homeassistant.example.com."
else
  pass "no private network identifiers (tailnet, *.ts.net, RFC1918, personal domain)"
fi

# ---------------------------------------------------------------------------
# Check 4 - demo textures are small (i.e. not photographs of a real home)
# ---------------------------------------------------------------------------
BIG_TEX=""
if [ -d houses/demo/textures ]; then
  BIG_TEX=$(find houses/demo/textures -type f \
      \( -iname '*.png' -o -iname '*.jpg' -o -iname '*.jpeg' \) 2>/dev/null \
    | while IFS= read -r img; do
        sz=$(wc -c < "$img" 2>/dev/null | tr -d ' \t\r')
        [ -z "$sz" ] && sz=0
        if [ "$sz" -gt "$TEXTURE_MAX_BYTES" ]; then
          printf '%s (%s bytes, limit %s)\n' "${img#./}" "$sz" "$TEXTURE_MAX_BYTES"
        fi
      done)
fi
if [ -n "$BIG_TEX" ]; then
  fail "demo textures are under 256 KB"
  printf '%s\n' "$BIG_TEX" | while IFS= read -r t; do
    [ -n "$t" ] && detail "$t"
  done
  remedy "A texture this large is almost certainly a photograph of a real wall."
  remedy "Replace it with a flat colour or a small procedural/CC0 tile, and keep"
  remedy "the photograph in the private house overlay."
else
  pass "demo textures are under 256 KB"
fi

# ---------------------------------------------------------------------------
# Check 5 - no renders-of-a-real-home directories present
# ---------------------------------------------------------------------------
ARTEFACT_DIRS=$(find . -name .git -prune -o \
  -type d \( -name .playwright-mcp -o -name screenshots \) -print 2>/dev/null || true)
ARTEFACT_DIRS=$(printf '%s\n' "$ARTEFACT_DIRS" | grep -v '^$' || true)
if [ -n "$ARTEFACT_DIRS" ]; then
  fail "no screenshot / Playwright artefact directories"
  printf '%s\n' "$ARTEFACT_DIRS" | while IFS= read -r d; do
    [ -n "$d" ] && detail "${d#./}/ exists"
  done
  remedy "These hold renders of a real interior. Delete them from the working"
  remedy "tree; they are gitignored, so they will not be committed either way."
else
  pass "no screenshot / Playwright artefact directories"
fi

# ---------------------------------------------------------------------------
# Check 6 - no long-lived-token-shaped strings (JWTs begin `eyJ`)
# ---------------------------------------------------------------------------
# An HA long-lived access token is a JWT: base64url of {"alg"... -> `eyJ`.
# Require a plausible run of JWT characters so ordinary prose containing "eyJ"
# is not the trigger, but stay loose enough to catch a truncated paste.
JWT_RE='eyJ[A-Za-z0-9_-]{10,}'
# -v: scan vendor/ too. A token pasted into a vendored file is still a leak.
JWT_HITS=$(grep_tree "$JWT_RE" -v || true)
JWT_HITS=$(printf '%s\n' "$JWT_HITS" | grep -v '^$' || true)
if [ -n "$JWT_HITS" ]; then
  fail "no credential-shaped strings (JWT / long-lived access token)"
  printf '%s\n' "$JWT_HITS" | while IFS= read -r h; do
    # Print only file:line - never echo a real token into a CI log.
    [ -n "$h" ] && detail "$(printf '%s' "$h" | cut -d: -f1-2)  (eyJ... token-shaped string, redacted)"
  done
  remedy "The Home Assistant token must never be in the repo. Supply it at"
  remedy "runtime via HOME3D_HA_TOKEN. If this token was ever real, ROTATE IT NOW."
else
  pass "no credential-shaped strings (JWT / long-lived access token)"
fi

# ---------------------------------------------------------------------------
# Check 7 - PLAN.md (private planning doc) is not committed
#
# PLAN.md is exempt from content scanning because it documents the migration
# using real entity ids and addresses. That exemption is only safe while the
# file is untracked, so verify it. Fails closed if git is unavailable.
# ---------------------------------------------------------------------------
if command -v git >/dev/null 2>&1 && git rev-parse --git-dir >/dev/null 2>&1; then
  if git ls-files --error-unmatch PLAN.md >/dev/null 2>&1; then
    fail "PLAN.md is not tracked by git"
    detail "PLAN.md is tracked, but it is exempt from content scanning."
    remedy "PLAN.md is a planning doc from the private predecessor repo and"
    remedy "contains real entity ids and LAN addresses. Run:"
    remedy "  git rm --cached PLAN.md    (it is already in .gitignore)"
  else
    pass "PLAN.md is not tracked by git"
  fi
else
  fail "PLAN.md is not tracked by git"
  detail "git is unavailable, or this is not a git repository."
  remedy "This check cannot be evaluated, so it fails closed. Run it from a git"
  remedy "checkout with git on PATH."
fi

# ---------------------------------------------------------------------------
# Check 8 - the owner's name and the private predecessor's branding
#
# This app was extracted from a private dashboard. Migrated files can still
# carry a personal heading ("Ope's Home"), the old product name ("Haven"), or a
# comment recording who requested a change ("confirmed by Ope"). None of that
# belongs in a public repo: it ties the published floor plan to a named person,
# which is precisely the linkage the demo-house split exists to prevent.
#
# Matched case-sensitively on a word boundary, so ordinary words are unaffected
# (`open`, `operation`, `scope` do not contain a standalone `Ope`).
# ---------------------------------------------------------------------------
NAME_ALT=$(printf '%s' "$OWNER_NAMES" | tr ' ' '|')
NAME_RE="\\<(${NAME_ALT})('s)?\\>"
NAME_HITS=$(grep_tree "$NAME_RE" || true)
NAME_HITS=$(printf '%s\n' "$NAME_HITS" | grep -v '^$' || true)
if [ -n "$NAME_HITS" ]; then
  fail "no owner names or private-predecessor branding"
  # Summarise per file: 141 raw hits across 14 files is unreadable in a CI log.
  printf '%s\n' "$NAME_HITS" | cut -d: -f1 | sort | uniq -c | sort -rn \
    | while IFS= read -r row; do
        _n=$(printf '%s' "$row" | awk '{print $1}')
        _f=$(printf '%s' "$row" | awk '{$1=""; sub(/^ /,""); print}')
        detail "$_f  ($_n occurrence(s))"
      done
  detail ""
  detail "first few:"
  printf '%s\n' "$NAME_HITS" | head -5 | while IFS= read -r h; do
    detail "  $(printf '%s' "$h" | cut -c1-140)"
  done
  remedy "Replace personal names with neutral wording before publishing:"
  remedy "  \"Ope's Home\"        -> \"My Home\", or read it from the house profile"
  remedy "  \"Haven\" branding    -> \"3dHome\""
  remedy "  \"confirmed by Ope\"  -> drop the attribution, keep the fact"
  remedy "Run: grep -rnE \"\\<(Ope|Tomi|Haven)\\>\" --exclude-dir=vendor ."
else
  pass "no owner names or private-predecessor branding"
fi

# ---------------------------------------------------------------------------
# Check 9 - spec pages must not cite a real interior
#
# specs/ holds design-reference pages for FIXTURES (a door, a window, a
# curtain). That is safe to publish. What is not safe is a spec page that
# reconstructs a ROOM of a real dwelling - the room's measured dimensions, the
# building's wall schedule, or a fixture layout copied from a photograph of a
# real interior. That describes where somebody lives just as precisely as a
# floor plan does, and check 1 does not see it because it is prose and geometry
# in an HTML file rather than a house directory.
#
# Detecting "these numbers are real" is not possible, and a check that guessed
# would produce false positives - which teaches people to route around the
# guard, the one outcome worse than no check. So this matches only the
# PROVENANCE TRAIL a reconstruction leaves behind, which is unambiguous:
#
#   - a reference to a photograph of a real interior or exterior
#     ("reference photo", "Street View", "bathroom 3.jpg", "the actual house")
#   - a citation of a private dictated brief (the .ope-*.md files the spec
#     pages were built from in the predecessor repo)
#   - an asset path on the owner's private share (W:\assets\...)
#
# Each is a positive statement, written by the author, that the page was
# derived from a real building. None of them has an innocent meaning in a
# public fixture reference, so a hit is a genuine finding, not a guess.
# ---------------------------------------------------------------------------
SPEC_PROV_RE='[Rr]eference photo|[Ss]treet ?View|[Tt]he actual house|[Oo]f the real house|\.ope-[a-z0-9-]*\.md|[Ww]:\\assets'
SPEC_HITS=""
if [ -d specs ]; then
  SPEC_HITS=$(grep -r -n -E -a --exclude-dir=.git -- "$SPEC_PROV_RE" specs 2>/dev/null | sed 's|^\./||' || true)
fi
SPEC_HITS=$(printf '%s\n' "$SPEC_HITS" | grep -v '^$' || true)
if [ -n "$SPEC_HITS" ]; then
  fail "spec pages do not cite a real interior"
  printf '%s\n' "$SPEC_HITS" | while IFS= read -r h; do
    [ -n "$h" ] && detail "$(printf '%s' "$h" | cut -c1-160)"
  done
  remedy "A spec page is a FIXTURE reference (a door, a window, a curtain), not a"
  remedy "record of a real room. Remove the citation and make the dimensions"
  remedy "illustrative defaults, or move the page into the private house overlay."
else
  pass "spec pages do not cite a real interior"
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
printf '\n--- summary ---\n'
printf 'files scanned: %s\n' "$FILE_COUNT"
if [ "$FAILURES" -eq 0 ]; then
  printf 'RESULT: PASS (%d/%d checks)\n' "$TOTAL_CHECKS" "$TOTAL_CHECKS"
  printf 'No real-house data, network identifiers or credentials found.\n'
  exit 0
else
  printf 'RESULT: FAIL (%d of %d checks failed)\n' "$FAILURES" "$TOTAL_CHECKS"
  printf 'This repo is PUBLIC. Fix every item above before pushing.\n'
  exit 1
fi
