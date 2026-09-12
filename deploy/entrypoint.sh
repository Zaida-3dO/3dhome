#!/bin/sh
# ---------------------------------------------------------------------------
# entrypoint.sh - the container-start half of the configuration mechanism.
#
# The stock nginx image runs every executable /docker-entrypoint.d/*.sh in
# lexical order before starting nginx. The Dockerfile installs this file as
# /docker-entrypoint.d/40-home3d-config.sh, so it runs on every container
# start - not on build. That is the whole point: the image contains no
# configuration and no token, and the same image is reusable across
# deployments.
#
# It does two things, both delegated:
#
#   1. deploy/generate-config.sh  - writes config.js from the environment and
#      stamps __VERSION__ into index.html. That script is also runnable by
#      hand for a non-container static deploy; keeping the logic there rather
#      than here is what makes the container optional.
#
#   2. Renders deploy/nginx.conf's frame-ancestors from HOME3D_FRAME_ANCESTORS,
#      because a CSP allow-list of embedder origins is deployment config and
#      cannot be baked into a public image.
#
# POSIX sh. Fails loudly: nginx's entrypoint runs these with `set -e`, so a
# non-zero exit here aborts the start rather than serving a misconfigured app.
# ---------------------------------------------------------------------------

set -eu

WEB_ROOT=${HOME3D_WEB_ROOT:-/usr/share/nginx/html}
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

log() { printf '[home3d-entrypoint] %s\n' "$1" >&2; }

# ---------------------------------------------------------------------------
# 1. config.js + version stamp
#
# generate-config.sh is installed alongside this file in the image. Look for it
# next to us first, then at the in-image copy, so this works whether the two
# are installed together in /docker-entrypoint.d/ or the app tree is present.
# ---------------------------------------------------------------------------
GENERATE=""
for candidate in \
  "$SCRIPT_DIR/generate-config.sh" \
  "/usr/local/bin/home3d-generate-config.sh" \
  "$WEB_ROOT/deploy/generate-config.sh"
do
  if [ -f "$candidate" ]; then
    GENERATE=$candidate
    break
  fi
done

if [ -z "$GENERATE" ]; then
  log "FATAL: generate-config.sh not found. The image is built wrong."
  log "       Looked in: $SCRIPT_DIR, /usr/local/bin, $WEB_ROOT/deploy"
  exit 1
fi

sh "$GENERATE" "$WEB_ROOT"

# ---------------------------------------------------------------------------
# 2. Content-Security-Policy: frame-ancestors
#
# WHY THIS IS RUNTIME AND NOT BAKED IN. The app is designed to be embedded in
# an iframe by other pages (a dashboard tile, a Home Assistant view). Which
# origins may do that is a property of the DEPLOYMENT, and the owner's real
# hostnames must never appear in a public image, so the value comes from
# HOME3D_FRAME_ANCESTORS and is substituted into nginx.conf here.
#
# NOTE ON X-Frame-Options: it is deliberately never set, anywhere. It has no
# allow-list form - only DENY and SAMEORIGIN - so setting it at all would break
# every cross-origin embed. frame-ancestors supersedes it in every browser that
# matters and is the only header that can express "these two origins, nobody
# else". If you find yourself adding X-Frame-Options, you are breaking the
# embeds; add the origin to HOME3D_FRAME_ANCESTORS instead.
#
# The default is 'self' alone: permissive enough that a standalone deployment
# and same-origin embeds work with zero configuration, restrictive enough that
# it is never a wildcard. An operator embedding cross-origin MUST set the var;
# docs/configuration.md says so, and the log line below says so at start-up.
#
# The value is sanitised: a CSP directive is terminated by ; and the whole
# header by a newline, so an unsanitised value could append arbitrary further
# directives or headers. Only characters that legitimately appear in a source
# list survive.
# ---------------------------------------------------------------------------
NGINX_CONF=${HOME3D_NGINX_CONF:-/etc/nginx/conf.d/default.conf}

FRAME_ANCESTORS=${HOME3D_FRAME_ANCESTORS:-"'self'"}

# Strip anything that is not a legal source-list character. Notably removes
# ; " newline and backslash, which are the header-injection vectors.
SAFE_FRAME_ANCESTORS=$(printf '%s' "$FRAME_ANCESTORS" \
  | tr '\n\r\t' '   ' \
  | tr -cd "A-Za-z0-9 :/.*_'-")
SAFE_FRAME_ANCESTORS=$(printf '%s' "$SAFE_FRAME_ANCESTORS" | sed -e 's/^ *//' -e 's/ *$//')
[ -z "$SAFE_FRAME_ANCESTORS" ] && SAFE_FRAME_ANCESTORS="'self'"

if [ "$SAFE_FRAME_ANCESTORS" != "$FRAME_ANCESTORS" ]; then
  log "WARN: HOME3D_FRAME_ANCESTORS contained characters that are not valid in"
  log "      a CSP source list. Using the sanitised value:"
  log "      $SAFE_FRAME_ANCESTORS"
fi

if [ -f "$NGINX_CONF" ]; then
  if grep -q '__FRAME_ANCESTORS__' "$NGINX_CONF" 2>/dev/null; then
    TMP="${NGINX_CONF}.$$"
    sed "s|__FRAME_ANCESTORS__|${SAFE_FRAME_ANCESTORS}|g" "$NGINX_CONF" > "$TMP"
    mv "$TMP" "$NGINX_CONF"
    log "frame-ancestors set to: $SAFE_FRAME_ANCESTORS"
    if [ "$SAFE_FRAME_ANCESTORS" = "'self'" ]; then
      log "  This is the DEFAULT. Cross-origin embedding is blocked. If this app"
      log "  is embedded from another host, set HOME3D_FRAME_ANCESTORS, e.g."
      log "  HOME3D_FRAME_ANCESTORS=\"'self' https://dashboard.example.com\""
    fi
  else
    log "note: no __FRAME_ANCESTORS__ placeholder in $NGINX_CONF"
    log "      (already substituted, or a custom config is mounted)"
  fi
else
  log "note: $NGINX_CONF not found; skipped frame-ancestors substitution"
fi

# ---------------------------------------------------------------------------
# 3. CORS allow-list (Access-Control-Allow-Origin)
#
# WHY THIS EXISTS SEPARATELY FROM frame-ancestors. Being allowed to EMBED this
# app and being allowed to FETCH its data are two different permissions, and
# an embedded tile needs BOTH. frame-ancestors alone gets the iframe on screen
# and then the scene's fetch() of houses/<id>/geometry.json is blocked by CORS,
# so the tile renders blank - a failure that looks like a broken 3D scene
# rather than a missing header. Same reasoning as frame-ancestors for why it
# is runtime config: these are the owner's real hostnames.
#
# WHY NOT JUST `*`. See the long comment on the map in nginx.conf. Short
# version: the deployment serves a private house profile, and `null` is even
# worse than `*` because every sandboxed iframe and file:// page sends it.
#
# INPUT is a space-separated list of origins, exactly like HOME3D_FRAME_ANCESTORS:
#
#   HOME3D_CORS_ORIGINS="https://dash.example.com http://dash.example.lan:9317"
#
# OUTPUT is the body of an nginx `map`, one `"origin" "origin";` entry per
# allow-listed origin, substituted for __CORS_ORIGINS__. Echoing the matched
# origin back is required: Access-Control-Allow-Origin accepts one origin or
# `*`, never a list.
#
# An ORIGIN IS scheme://host[:port] WITH NO TRAILING SLASH, and a non-default
# port is part of it - http://host:9317 and http://host are different origins,
# and neither matches http://host:9317/. The match here is exact string
# equality against the browser's Origin header, so a stray slash fails
# SILENTLY: the fetch is simply refused, with no server-side error anywhere.
# Trailing slashes are therefore stripped below rather than left to bite.
#
# Default is empty: no map entries, no origin ever matches, no CORS header is
# ever emitted, and the app behaves exactly as it did before this feature.
# ---------------------------------------------------------------------------
CORS_ORIGINS=${HOME3D_CORS_ORIGINS:-}

# Same sanitising as the CSP value, and for the same reason: this string is
# interpolated into a config file, so " ; { } and newlines are injection
# vectors. Note ' is NOT permitted here (unlike the CSP source list, where
# 'self' is meaningful) because a CORS origin is always a bare scheme://host.
SAFE_CORS_ORIGINS=$(printf '%s' "$CORS_ORIGINS" \
  | tr '\n\r\t' '   ' \
  | tr -cd 'A-Za-z0-9 :/._-')
SAFE_CORS_ORIGINS=$(printf '%s' "$SAFE_CORS_ORIGINS" | sed -e 's/^ *//' -e 's/ *$//')

if [ "$SAFE_CORS_ORIGINS" != "$CORS_ORIGINS" ]; then
  log "WARN: HOME3D_CORS_ORIGINS contained characters that are not valid in an"
  log "      origin. Using the sanitised value:"
  log "      $SAFE_CORS_ORIGINS"
fi

# Build the map body. Each origin becomes an exact-match entry that echoes
# itself back. Written as one line per entry with the same indentation the
# surrounding map block uses.
CORS_MAP_BODY=""
CORS_COUNT=0
for origin in $SAFE_CORS_ORIGINS; do
  # Strip any trailing slash(es): "https://x.com/" is a URL, not an origin,
  # and would never match the Origin header the browser actually sends.
  trimmed=$(printf '%s' "$origin" | sed -e 's|/*$||')
  [ -z "$trimmed" ] && continue
  if [ "$trimmed" != "$origin" ]; then
    log "note: trailing slash stripped from CORS origin: $origin -> $trimmed"
  fi
  CORS_MAP_BODY="${CORS_MAP_BODY}    \"${trimmed}\" \"${trimmed}\";
"
  CORS_COUNT=$((CORS_COUNT + 1))
done

if [ -f "$NGINX_CONF" ]; then
  if grep -q '__CORS_ORIGINS__' "$NGINX_CONF" 2>/dev/null; then
    TMP="${NGINX_CONF}.cors.$$"
    # awk rather than sed: the replacement is MULTI-LINE, and a multi-line
    # sed replacement is a portability minefield. awk prints the block
    # verbatim, so no escaping of / or & is needed either.
    awk -v body="$CORS_MAP_BODY" '
      /__CORS_ORIGINS__/ { printf "%s", body; next }
      { print }
    ' "$NGINX_CONF" > "$TMP"
    mv "$TMP" "$NGINX_CONF"
    if [ "$CORS_COUNT" -eq 0 ]; then
      log "CORS allow-list is EMPTY: no Access-Control-Allow-Origin will be sent."
      log "  Cross-origin fetches of the house JSON will be blocked by the"
      log "  browser. If this app is embedded from another host, set"
      log "  HOME3D_CORS_ORIGINS, e.g."
      log "  HOME3D_CORS_ORIGINS=\"https://dashboard.example.com\""
    else
      log "CORS allow-list ($CORS_COUNT origin(s)): $SAFE_CORS_ORIGINS"
    fi
  else
    log "note: no __CORS_ORIGINS__ placeholder in $NGINX_CONF"
    log "      (already substituted, or a custom config is mounted)"
  fi
fi

log "ready"
exit 0
