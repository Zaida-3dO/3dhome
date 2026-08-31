# ---------------------------------------------------------------------------
# 3dHome - nginx serving a static, no-build app.
#
# THIS IS NOT A BUILD STEP. There is no bundler, no transpiler, no npm install,
# no node_modules, no generated output. Every file is copied verbatim and
# served as-is; the identical tree works from `python -m http.server`. The
# container exists for exactly two things a static file server cannot do:
#
#   1. turn environment variables into a config.js the browser can read,
#   2. set response headers (frame-ancestors, no-store on config.js).
#
# Single stage on purpose. A multi-stage build would imply something is being
# compiled, and nothing is.
# ---------------------------------------------------------------------------

FROM nginx:alpine

# The version stamped into the visible badge and into every ?v= cache-busting
# query string. Passed at build time by the release workflow (the git tag), and
# overridable at RUN time by the APP_VERSION environment variable, since the
# stamping happens in the entrypoint rather than here. Defaults to "dev" so a
# bare `docker build .` works.
ARG APP_VERSION=dev
ENV APP_VERSION=${APP_VERSION}

# Defaults for the rest of the environment surface, so `docker run` with no -e
# flags produces a working app: the demo house, Home Assistant off.
ENV HOME3D_HOUSE=demo \
    HOME3D_WS_RECONNECT_MS=5000 \
    HOME3D_POLL_INTERVAL_MS=5000 \
    HOME3D_WEB_ROOT=/usr/share/nginx/html \
    HOME3D_FRAME_ANCESTORS="'self'"

# The app itself. .dockerignore keeps .git, .env, config.js, screenshots and
# any non-demo house profile out of the image - important here because this
# copies the whole context.
COPY . /usr/share/nginx/html/

# Server config. The __FRAME_ANCESTORS__ placeholder inside is substituted at
# container start by the entrypoint.
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf

# The two scripts, installed where the nginx image will run them.
#
# The stock nginx entrypoint executes every /docker-entrypoint.d/*.sh in
# lexical order before starting nginx. 40- places this after the image's own
# 10-/20-/30- scripts. Both files are copied: entrypoint.sh looks for
# generate-config.sh next to itself first, which keeps the pair together and
# lets generate-config.sh remain independently runnable by an operator.
COPY deploy/entrypoint.sh        /docker-entrypoint.d/40-home3d-config.sh
COPY deploy/generate-config.sh   /docker-entrypoint.d/generate-config.sh
COPY deploy/generate-config.sh   /usr/local/bin/home3d-generate-config.sh

# Only the .sh files the nginx entrypoint should EXECUTE need +x; the copy in
# /docker-entrypoint.d/ is found by name and sourced through `sh`, so it is
# made non-executable to keep the entrypoint from running it twice as a
# lifecycle script of its own.
RUN chmod +x /docker-entrypoint.d/40-home3d-config.sh \
             /usr/local/bin/home3d-generate-config.sh \
 && chmod -x /docker-entrypoint.d/generate-config.sh \
 && rm -f /usr/share/nginx/html/Dockerfile \
          /usr/share/nginx/html/docker-compose.yml \
          /usr/share/nginx/html/.dockerignore

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1/healthz || exit 1

# Inherited from nginx:alpine: ENTRYPOINT /docker-entrypoint.sh, CMD nginx -g
# 'daemon off;'. Neither is overridden - the /docker-entrypoint.d/ hook above
# is the whole integration point.
