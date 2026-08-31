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

log "ready"
exit 0
