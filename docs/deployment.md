# Deployment

How to put 3dHome on a host of your own, behind TLS, embedded in whatever
dashboard you already run — and how to do it without breaking the links people
have already bookmarked.

> **Every hostname in this document is a placeholder.** `home3d.example.com`,
> `dashboard.example.com`, `homeassistant.example.com` and paths like
> `/srv/home3d` are stand-ins. Substitute your own as you go. This repo is
> public and deliberately contains no real hostnames, LAN addresses or NAS
> paths — please keep it that way; `scripts/check-no-pii.sh` will fail CI if a
> real one lands.

This document assumes you have already read the [Security](../README.md#security)
section of the README. The short version: the Home Assistant token is served to
the browser, so 3dHome must sit behind something that authenticates users.

---

## 1. Running the container

The image is static nginx. There is no build step, no database and no state on
disk — everything is configuration supplied at container start.

### Minimum

```sh
docker run -d --name home3d -p 8080:80 \
  ghcr.io/zaida-3do/3dhome:latest
```

That serves the fictional demo house with Home Assistant off. Useful as a smoke
test that the image and your port mapping work before any real configuration is
involved.

### A real deployment

```sh
docker run -d --name home3d \
  -p 8080:80 \
  -e HOME3D_HA_URL="https://homeassistant.example.com" \
  -e HOME3D_HA_TOKEN="<long-lived access token>" \
  -e HOME3D_HOUSE=myhouse \
  -e HOME3D_FRAME_ANCESTORS="'self' https://dashboard.example.com https://homeassistant.example.com" \
  -e APP_VERSION=1.4.0 \
  -v /srv/home3d/myhouse:/usr/share/nginx/html/houses/myhouse:ro \
  --restart unless-stopped \
  ghcr.io/zaida-3do/3dhome:latest
```

### Ports

The container listens on **80** and nothing else. It is plain HTTP by design —
TLS terminates at the reverse proxy in front of it (§2), which is also where
authentication belongs. Publish it on whatever host port is free (`8080` above);
if the proxy runs on the same host, prefer binding to loopback
(`-p 127.0.0.1:8080:80`) so the unauthenticated origin is not reachable from the
LAN at all.

`GET /healthz` returns `200 ok` without touching the filesystem, so it is a
valid liveness probe even if the web root is empty. The image also declares its
own `HEALTHCHECK`, so `docker ps` reports health with no extra configuration.

### The environment surface

Every variable, its default, and what it does. All are optional — the container
starts with none of them set.

| Variable | Default | Purpose |
|---|---|---|
| `HOME3D_HA_URL` | *(empty)* | Base URL of your Home Assistant. |
| `HOME3D_HA_FALLBACK_URL` | *(empty)* | Second URL tried when the first is unreachable (e.g. a VPN hostname). Ignored entirely when the embedder passes `?haUrl=`. |
| `HOME3D_HA_TOKEN` | *(empty)* | Long-lived access token. **Served to the browser.** |
| `HOME3D_HA_ENABLED` | *inferred* | Forces HA on or off. Cannot force *on* without both a URL and a token. |
| `HOME3D_HOUSE` | `demo` | Which profile under `houses/` to render. |
| `HOME3D_WS_RECONNECT_MS` | `5000` | Delay before retrying a dropped websocket. |
| `HOME3D_POLL_INTERVAL_MS` | `5000` | REST poll interval when the websocket is unavailable. |
| `HOME3D_FRAME_ANCESTORS` | `'self'` | CSP allow-list of origins permitted to embed the app. See §2. |
| `APP_VERSION` | `dev` | Stamped into the version badge and every `?v=` cache-buster. See §4. |
| `HOME3D_WEB_ROOT` | `/usr/share/nginx/html` | Where the served files live. Rarely changed. |

Home Assistant is enabled **only when both `HOME3D_HA_URL` and
`HOME3D_HA_TOKEN` are non-empty.** A half-configured deployment renders a static
house rather than booting into a permanent red status dot and a stream of
failing auth attempts. This is checked in `deploy/generate-config.sh` and again
in `src/config-loader.js`, so neither can be the single point that gets it wrong.

### Mounting a private house profile read-only

Your floor plan, room names and entity ids describe where you live. They do not
belong in this repo — `houses/` is gitignored apart from the demo, and the PII
guard enforces it.

Keep the real profile outside the image and mount it at run time:

```sh
-v /srv/home3d/myhouse:/usr/share/nginx/html/houses/myhouse:ro \
-e HOME3D_HOUSE=myhouse
```

The `:ro` matters. The app only ever reads a house profile, so a writable mount
grants the web server the ability to modify the one directory holding your
private data — for no benefit. Mount the directory itself, not its parent:
mounting over `houses/` would hide the demo house and the schema.

Validate the profile before deploying it — the validator catches a bad
geometry/rooms cross-reference that otherwise surfaces as a blank canvas:

```sh
python scripts/validate-house.py /srv/home3d/myhouse
```

### Compose

```yaml
services:
  home3d:
    image: ghcr.io/zaida-3do/3dhome:latest
    container_name: home3d
    restart: unless-stopped
    ports:
      - "127.0.0.1:8080:80"
    environment:
      HOME3D_HA_URL: "https://homeassistant.example.com"
      HOME3D_HA_TOKEN: "${HOME3D_HA_TOKEN}"
      HOME3D_HOUSE: "myhouse"
      HOME3D_FRAME_ANCESTORS: "'self' https://dashboard.example.com"
      APP_VERSION: "1.4.0"
    volumes:
      - /srv/home3d/myhouse:/usr/share/nginx/html/houses/myhouse:ro
```

Keep the token in a `.env` beside the compose file (`HOME3D_HA_TOKEN=...`),
never inline. Copy `.env.example` as a starting point.

---

## 2. The reverse-proxy host

3dHome expects to run behind a proxy that terminates TLS and authenticates
users. The container does neither.

### TLS

Issue a certificate for `home3d.example.com` and force HTTPS. Two reasons
beyond the usual:

- The Home Assistant **token travels to the browser** inside `/config.js`. Over
  plain HTTP that is readable by anything on the path.
- The app is embedded by other HTTPS pages. A browser blocks an HTTP iframe
  inside an HTTPS parent as mixed content, so the embed simply will not render.

Proxy `https://home3d.example.com` to `http://<container-host>:8080`.

### `Content-Security-Policy: frame-ancestors`

This is the header that decides who may embed the app, and it is the one piece
of proxy configuration that is not optional if you embed at all.

The container already emits it, built from `HOME3D_FRAME_ANCESTORS`:

```
Content-Security-Policy: frame-ancestors 'self' https://dashboard.example.com https://homeassistant.example.com
```

Set that variable to the origins that legitimately embed the viewer — typically
your dashboard and your Home Assistant. The default is `'self'` alone, which
blocks **all** cross-origin embedding; a cross-origin embed that silently shows
a blank frame is almost always this default still being in place.

If your proxy adds its own CSP, make sure it does not *replace* this one. Two
`frame-ancestors` directives from different layers do not merge generously —
the browser enforces the intersection, so a proxy-level
`frame-ancestors 'self'` overrides your allow-list back to nothing.

### Do **not** set `X-Frame-Options`

`X-Frame-Options` has exactly two useful values: `DENY` and `SAMEORIGIN`. It has
**no allow-list form** — there is no way to express "these two origins". So any
value you set breaks the cross-origin embeds this app exists to support:

- `DENY` — blocks every embed, including your dashboard's.
- `SAMEORIGIN` — blocks every embed from a *different* host, which is both of
  the embedders named above.

`frame-ancestors` supersedes `X-Frame-Options` in every current browser and can
express what you actually mean, so it is the only one this app uses. The
container never sets `X-Frame-Options` anywhere, deliberately — but many proxies
and security-header presets add it for you, and that is the usual cause of an
embed that works when opened directly and shows an empty frame inside the
dashboard.

**If a security audit asks for `X-Frame-Options`:** the correct answer is that
`frame-ancestors` is present and is strictly more expressive. Adding
`X-Frame-Options` to satisfy a checklist will take the embeds down.

---

## 3. Redirects from the old paths

The predecessor deployment served the viewer and its spec pages at different
paths. Bookmarks, and at least one dashboard card's `href`, still point at them.
**Without these redirects those links 404 silently** — the card renders an error
page inside the tile, which reads as "the 3D home is broken" rather than "a link
moved".

Two 301s are needed:

| Old path | New path |
|---|---|
| `/home3d.html` | `/` (the new root) |
| `/assets/3d/html/(.*)` | `/specs/$1` |

301 rather than 302 on purpose: the move is permanent, and a permanent redirect
lets browsers and the dashboard update their own caches instead of round-tripping
through the old URL forever.

### nginx

```nginx
location = /home3d.html {
    return 301 https://home3d.example.com/;
}

location ~ ^/assets/3d/html/(.*)$ {
    return 301 https://home3d.example.com/specs/$1;
}
```

### Caddy

```
redir /home3d.html / 301
redir /assets/3d/html/* /specs/{http.request.uri.path.1} 301
```

### Traefik (dynamic config)

```yaml
http:
  middlewares:
    home3d-legacy:
      redirectRegex:
        regex: "^https://home3d\\.example\\.com/assets/3d/html/(.*)$"
        replacement: "https://home3d.example.com/specs/$1"
        permanent: true
```

Where these go depends on whether the old paths were served by the *same*
hostname as the new deployment. If the viewer previously lived on the dashboard's
host, the redirects belong on **that** host's proxy config, pointing at the new
hostname — not on the 3dHome host, which never sees a request for a URL on
another origin.

---

## 4. Versioning and caching

Set `APP_VERSION` on every deployment — a release tag, a build number, anything
that changes when the files change.

It is stamped at container start into the visible badge and into every `?v=`
cache-busting query string in `index.html`, from a single value. That is what
lets `nginx.conf` cache JS and assets for a year with `immutable`: a new version
produces new URLs, so a long cache can never serve a stale file for a URL whose
contents changed.

Leaving it unset is safe (it falls back to `dev`) but costs you cache-busting:
every deployment reuses the same asset URLs, and returning visitors keep the
year-old cached copies. **If a redeploy appears to change nothing, check
`APP_VERSION` first.**

Do not hardcode a version anywhere in the HTML. The predecessor kept the same
number in three hand-synchronised places and they drifted three separate times —
which produced two pages on one origin serving *different cached builds of the
same script*, i.e. "it works on the 3D page but not in the sidebar".
`deploy/check-version-stamping.sh` runs in CI and fails the build if a literal
version reappears where the placeholder belongs.

---

## 5. Two traps worth recording

Both of these cost real time. Neither is guessable from the symptom.

### A proxy config written straight into its database does not take effect

Several reverse-proxy managers (Nginx Proxy Manager among them) keep hosts in a
SQLite database *and* generate an nginx `.conf` file per host. **nginx serves the
generated files; the database is only the manager's own bookkeeping.** Writing a
host — or a redirect, or a custom header — directly into the database with a SQL
client therefore changes nothing at all: no conf file is regenerated, no reload
happens, and the UI cheerfully displays the row you inserted, which makes it look
as though the configuration is live.

The failure mode is nasty precisely because the UI agrees with you. You end up
debugging DNS and certificates while nginx has never heard of the host.

**Create and edit hosts through the manager's UI or its HTTP API**, both of which
regenerate the conf files and reload nginx. Use the database read-only, for
inspection. After any change, confirm the generated conf actually exists and
mentions your hostname rather than trusting the UI.

### Building on the target host may need `DOCKER_CONFIG`

On some hosts — QNAP's Container Station notably — `docker compose build` fails
in buildkit because the default Docker config directory is missing or not
writable by the user running the build. The error is about buildkit or a missing
builder instance and does not mention configuration, so it reads as a broken
Docker install.

Point `DOCKER_CONFIG` at a directory inside the project:

```sh
mkdir -p .docker
DOCKER_CONFIG="$PWD/.docker" docker compose build --pull
DOCKER_CONFIG="$PWD/.docker" docker compose up -d
```

You usually do not need to build at all — `ghcr.io/zaida-3do/3dhome:latest` is
published, and `docker compose pull` avoids the problem entirely. This applies
only when building from source on the target host.

---

## 6. Verification checklist

Run through this after deploying. Each item has caught a real failure.

**Reachability and redirects**

- [ ] `https://home3d.example.com/` loads and the house renders.
- [ ] `curl -sI https://home3d.example.com/healthz` returns `200`.
- [ ] `curl -sI https://home3d.example.com/home3d.html` returns **`301`**, with
      `Location:` pointing at the new root. Not `404`, not `200`.
- [ ] `curl -sI https://home3d.example.com/assets/3d/html/DoorSpec.html` returns
      **`301`** to `/specs/DoorSpec.html`, and following it returns `200`.
- [ ] The dashboard card's existing `href` still arrives at a working page.

**The embed**

- [ ] The viewer renders inside the dashboard iframe — not a blank frame.
- [ ] The browser console in the **embedding** page shows no CSP violation
      mentioning `frame-ancestors`. A refused embed reports it there, in the
      parent, not in the app's own console.
- [ ] `curl -sI https://home3d.example.com/ | grep -i x-frame-options` returns
      **nothing**. Any value here breaks the embeds (§2).
- [ ] The `Content-Security-Policy` header names every origin that embeds the
      app, and no wildcard.

**Configuration and caching**

- [ ] `curl -sI https://home3d.example.com/config.js` shows `Cache-Control:
      no-store`. Without it a browser can cache a rotated token.
- [ ] `curl -s https://home3d.example.com/config.js` shows the expected
      `house`, and a `token` only if HA is meant to be on.
- [ ] The version badge shows your `APP_VERSION`, not `dev` and not an
      unsubstituted placeholder.
- [ ] View source: every `?v=` carries that same version, and they all match
      the badge — that agreement is the whole point of the stamping.
- [ ] The app's own console logs one `[HomeConfig] configuration source:` line
      naming the expected tier (`generated config.js` for a container deploy).

**Home Assistant, if enabled**

- [ ] The status dot goes green, and lights in the model track real state.
- [ ] A red dot with `auth_failed` means the token is wrong or expired — not a
      networking problem.

**Privacy**

- [ ] `bash scripts/check-no-pii.sh` passes 8/8 in your checkout before pushing.
- [ ] Your real house profile is a read-only mount, and is *not* in git.
