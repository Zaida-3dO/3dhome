#!/bin/sh
# ---------------------------------------------------------------------------
# generate-config.sh - write config.js (and stamp __VERSION__) from the
# environment. Dual-purpose, and deliberately so:
#
#   1. As a CONTAINER ENTRYPOINT. The Dockerfile installs this script into
#      /docker-entrypoint.d/ (as 40-home3d-config.sh), which the stock nginx
#      image sources at start-up, before nginx itself launches.
#
#   2. STANDALONE, by hand, for a plain static deploy with no container:
#         HOME3D_HA_URL=https://ha.example.com \
#         HOME3D_HA_TOKEN=... \
#         sh deploy/generate-config.sh /var/www/home3d
#      The container is a convenience, never a requirement.
#
# POSIX sh. No bashisms, no build step, no dependencies beyond sh, sed and tr.
#
# Contract: writes $ROOT/config.js defining window.HOME3D_CONFIG, and replaces
# every __VERSION__ placeholder in $ROOT/index.html with $APP_VERSION.
#
# The app boots FINE without this script ever running - src/config-loader.js
# falls through to config.json and then to the committed config.example.json.
# This only supplies the deployment tier.
# ---------------------------------------------------------------------------

set -u

# Where the served files live. Argument 1 wins, then HOME3D_WEB_ROOT, then the
# nginx image's default. Making this an argument is what lets the same script
# serve a bare /var/www or a NAS share.
ROOT=${1:-${HOME3D_WEB_ROOT:-/usr/share/nginx/html}}

log() { printf '[home3d-config] %s\n' "$1" >&2; }

if [ ! -d "$ROOT" ]; then
  log "FATAL: web root '$ROOT' does not exist."
  log "       Pass it as the first argument, or set HOME3D_WEB_ROOT."
  exit 1
fi

# ---------------------------------------------------------------------------
# Defaults
# ---------------------------------------------------------------------------
: "${HOME3D_HOUSE:=demo}"
: "${HOME3D_WS_RECONNECT_MS:=5000}"
: "${HOME3D_POLL_INTERVAL_MS:=5000}"
: "${HOME3D_HA_URL:=}"
: "${HOME3D_HA_FALLBACK_URL:=}"
: "${HOME3D_HA_TOKEN:=}"
: "${APP_VERSION:=}"

# ---------------------------------------------------------------------------
# json_string <value>  - emit a JSON/JS string literal, correctly escaped.
#
# WHY THIS EXISTS. The obvious implementation is "${HOME3D_HA_TOKEN}" dropped
# straight into a heredoc. That is an injection hole: a token, or more
# plausibly a URL typed with a stray quote, containing a double quote or a
# backslash or a newline terminates the string literal early and the remainder
# is parsed as JavaScript. config.js is served to every browser that can reach
# the page, so "the operator typed something odd" becomes "the operator ships
# arbitrary JS to every visitor".
#
# So every value goes through here. Escaping is applied in this order - and the
# order matters, backslash MUST be first or it would double-escape the
# backslashes the later rules introduce:
#
#   backslash    -> \\
#   double quote -> \"
#   tab          -> \t     (a literal tab in a JS string is legal but invisible)
#   newline      -> \n     via sed's N / $!ba slurp-the-whole-input idiom
#
# Control characters below 0x20 other than tab and newline are dropped outright
# by tr: they have no business in a URL or a token, they are invisible in any
# log, and emitting them raw produces invalid JSON. Dropping is safer than
# passing through - a mangled token fails auth loudly, whereas an unescaped
# control character can break the parse silently.
#
# printf '%s' rather than echo, because echo mangles values beginning with -n
# and interprets backslashes on some shells.
# ---------------------------------------------------------------------------
json_string() {
  # An empty value must still produce a valid empty literal. `printf '%s' ""`
  # emits no bytes at all, so the sed pipeline below - which adds a leading
  # quote to the FIRST line and a trailing quote to the LAST - has no lines
  # to act on and emits nothing. That yields `url: ,` in the output: a syntax
  # error that takes the whole config file, and therefore the app, down. An
  # empty URL/token/fallback is the NORMAL zero-config case, so this is the
  # path most deployments take. Handle it before the pipeline.
  if [ -z "$1" ]; then
    printf '""'
    return 0
  fi

  # Order matters: backslash MUST be first, or it would double-escape the
  # backslashes the later rules introduce. The / rule escapes forward slashes
  # so the sequence </script> can never appear literally in the output -
  # config.js is an external file today, but a value that cannot terminate a
  # script block stays safe if it is ever inlined into HTML. \/ is a valid
  # JS/JSON escape for /, so this changes nothing about the parsed value.
  printf '%s' "$1" \
    | tr -d '\000-\010\013\014\016-\037\177' \
    | sed -e 's/\\/\\\\/g' \
          -e 's/"/\\"/g' \
          -e 's|/|\\/|g' \
          -e ':a' -e 'N' -e '$!ba' -e 's/\n/\\n/g' \
          -e 's/\t/\\t/g' \
    | sed -e '1s/^/"/' -e '$s/$/"/'
}

# json_int <value> <fallback> - emit a bare integer, or the fallback when the
# value is not a plain non-negative integer. An unquoted non-number would be a
# syntax error in the generated file, so this never trusts its input.
json_int() {
  case "$1" in
    ''|*[!0-9]*) log "WARN: '$1' is not a non-negative integer; using $2"; printf '%s' "$2" ;;
    *)           printf '%s' "$1" ;;
  esac
}

# ---------------------------------------------------------------------------
# Decide whether Home Assistant is on.
#
# The rule, and it is the important one: HA defaults to enabled ONLY when both
# the URL and the token are non-empty. A half-configured deployment - someone
# set the URL and forgot the token - disables HA cleanly and renders a static
# house, rather than booting into a permanent red status dot and a stream of
# failing auth attempts against a real HA instance.
#
# An explicit HOME3D_HA_ENABLED overrides that inference in either direction,
# with one exception: it cannot force true without a URL and a token, because
# that configuration cannot work and pretending otherwise only relocates the
# failure into the browser, where it is harder to diagnose.
# ---------------------------------------------------------------------------
if [ -n "$HOME3D_HA_URL" ] && [ -n "$HOME3D_HA_TOKEN" ]; then
  INFERRED=true
else
  INFERRED=false
fi

case "${HOME3D_HA_ENABLED:-}" in
  '')
    ENABLED=$INFERRED
    ;;
  true|TRUE|True|1|yes|on)
    if [ "$INFERRED" = true ]; then
      ENABLED=true
    else
      ENABLED=false
      log "WARN: HOME3D_HA_ENABLED is set true but HOME3D_HA_URL and/or"
      log "      HOME3D_HA_TOKEN is empty. Home Assistant stays DISABLED."
    fi
    ;;
  false|FALSE|False|0|no|off)
    ENABLED=false
    ;;
  *)
    ENABLED=$INFERRED
    log "WARN: HOME3D_HA_ENABLED='${HOME3D_HA_ENABLED}' is not a recognised"
    log "      boolean. Falling back to the inferred value: $ENABLED"
    ;;
esac

WS_RECONNECT=$(json_int "$HOME3D_WS_RECONNECT_MS" 5000)
POLL_INTERVAL=$(json_int "$HOME3D_POLL_INTERVAL_MS" 5000)

VERSION=$APP_VERSION
[ -z "$VERSION" ] && VERSION=dev

# ---------------------------------------------------------------------------
# Write config.js
#
# Written to a temp file and moved into place, so a client fetching config.js
# at the moment of a restart never reads a half-written file.
#
# The heredoc delimiter below is deliberately UNquoted: by this point the
# J_* variables hold finished, fully-escaped JS literals including their own
# surrounding quotes, so they are what should be expanded. No raw operator
# input reaches the heredoc.
# ---------------------------------------------------------------------------
J_URL=$(json_string "$HOME3D_HA_URL")
J_FALLBACK=$(json_string "$HOME3D_HA_FALLBACK_URL")
J_TOKEN=$(json_string "$HOME3D_HA_TOKEN")
J_HOUSE=$(json_string "$HOME3D_HOUSE")
J_VERSION=$(json_string "$VERSION")

TMP="$ROOT/.config.js.$$"
cat > "$TMP" <<EOF
/* Generated by deploy/generate-config.sh - DO NOT EDIT, DO NOT COMMIT.
 * Rewritten from the environment every time the container starts.
 * Served with Cache-Control: no-store; it holds the Home Assistant token. */
window.HOME3D_CONFIG = {
  source: "env",
  version: $J_VERSION,
  enabled: $ENABLED,
  url: $J_URL,
  fallbackUrl: $J_FALLBACK,
  token: $J_TOKEN,
  house: $J_HOUSE,
  wsReconnectMs: $WS_RECONNECT,
  pollIntervalMs: $POLL_INTERVAL
};
EOF

if [ ! -s "$TMP" ]; then
  rm -f "$TMP"
  log "FATAL: failed to write config.js to $ROOT"
  exit 1
fi

mv "$TMP" "$ROOT/config.js"

# This file holds the token. Readable by the web server, writable by nobody
# else. It is regenerated on every start, so nothing is lost by being strict.
chmod 0644 "$ROOT/config.js" 2>/dev/null || true

if [ "$ENABLED" = true ]; then
  log "wrote $ROOT/config.js  (house=$HOME3D_HOUSE, HA enabled, token supplied)"
else
  log "wrote $ROOT/config.js  (house=$HOME3D_HOUSE, HA DISABLED)"
  if [ -n "$HOME3D_HA_URL" ] && [ -z "$HOME3D_HA_TOKEN" ]; then
    log "  reason: HOME3D_HA_URL is set but HOME3D_HA_TOKEN is empty."
  fi
  if [ -z "$HOME3D_HA_URL" ] && [ -n "$HOME3D_HA_TOKEN" ]; then
    log "  reason: HOME3D_HA_TOKEN is set but HOME3D_HA_URL is empty."
  fi
fi

# ---------------------------------------------------------------------------
# Stamp the version.
#
# index.html carries a __VERSION__ placeholder in the visible badge and on
# every ?v= cache-bust query string. Replacing it here is what makes the badge
# and every script tag mathematically identical - the version drift the
# predecessor repo accumulated across three separately hand-maintained numbers
# cannot recur when there is only one source.
#
# APP_VERSION unset falls back to 'dev' (set above), so a bare `docker build`
# with no build-arg still works, and the placeholder is ALWAYS replaced with
# something - a served URL never contains the literal __VERSION__.
#
# The sed delimiter is | because a version string could plausibly contain a /,
# and the value is sanitised first: anything outside [A-Za-z0-9._+-] is
# stripped, so a hostile APP_VERSION cannot inject a sed command or HTML.
# ---------------------------------------------------------------------------
SAFE_VERSION=$(printf '%s' "$VERSION" | tr -cd 'A-Za-z0-9._+-')
[ -z "$SAFE_VERSION" ] && SAFE_VERSION=dev
if [ "$SAFE_VERSION" != "$VERSION" ]; then
  log "WARN: APP_VERSION contained characters unsafe in a URL or in HTML;"
  log "      stamping the sanitised value '$SAFE_VERSION' instead."
fi

if [ -f "$ROOT/index.html" ]; then
  if grep -q '__VERSION__' "$ROOT/index.html" 2>/dev/null; then
    # sed -i is not POSIX and differs between GNU and BSD, so do it the
    # portable way: write beside the file, then move over it.
    STAMP_TMP="$ROOT/.index.html.$$"
    if sed "s|__VERSION__|${SAFE_VERSION}|g" "$ROOT/index.html" > "$STAMP_TMP"; then
      mv "$STAMP_TMP" "$ROOT/index.html"
      log "stamped version '$SAFE_VERSION' into index.html"
    else
      rm -f "$STAMP_TMP"
      log "WARN: could not stamp the version into index.html; left unchanged."
    fi
  else
    # Not an error: a second container start finds the placeholders already
    # replaced by the first. Saying so beats silence.
    log "no __VERSION__ placeholder in index.html (already stamped, or none present)"
  fi
else
  log "note: $ROOT/index.html not found; skipped version stamping"
fi

exit 0
