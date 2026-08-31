#!/bin/sh
# Install this repo's tracked git hooks into .git/hooks/.
#
# The deploy hook (deploy/post-commit) mirrors the app into Home Assistant's
# www/ so the HA dashboard's 3D iframe stays current. It previously existed
# ONLY as an untracked file inside one checkout's .git/hooks/ — tracked here
# now so it survives a lost disk and can be installed anywhere.
#
# Usage:
#   deploy/install-hooks.sh          # install (refuses to clobber a different
#                                    # existing hook unless --force)
#   deploy/install-hooks.sh --force  # overwrite whatever is there
#
# Only hosts that actually serve HA need this — on any other machine the hook
# detects no known deploy layout and exits silently, so installing it is safe
# but pointless.
set -e

FORCE=0
[ "$1" = "--force" ] && FORCE=1

REPO=$(git rev-parse --show-toplevel 2>/dev/null) || {
  echo "error: not inside a git repository." >&2
  exit 1
}

SRC="$REPO/deploy/post-commit"
# Honour core.hooksPath if it is set; otherwise the default .git/hooks.
HOOKS=$(git config --get core.hooksPath || true)
if [ -n "$HOOKS" ]; then
  case "$HOOKS" in
    /*) : ;;
    *) HOOKS="$REPO/$HOOKS" ;;
  esac
else
  HOOKS="$(git rev-parse --git-dir)/hooks"
fi
DST="$HOOKS/post-commit"

[ -f "$SRC" ] || { echo "error: $SRC not found." >&2; exit 1; }

mkdir -p "$HOOKS"

if [ -e "$DST" ] && [ "$FORCE" -eq 0 ]; then
  if cmp -s "$SRC" "$DST"; then
    echo "post-commit already installed and identical - nothing to do."
    exit 0
  fi
  echo "error: $DST exists and differs from deploy/post-commit." >&2
  echo "       Inspect it, then re-run with --force to overwrite." >&2
  exit 1
fi

cp "$SRC" "$DST"
chmod +x "$DST"
echo "installed: $DST"
echo
echo "Verify a deploy by MTIME, not by the commit log - landing commits via git"
echo "plumbing (update-ref, fast-import, a received push) does NOT fire"
echo "post-commit, so the mirror can silently stay stale:"
echo "  stat -c '%y %n' <deploy-dir>/index.html"
