# 3dHome

A browser-based 3D model of your home that lights up when your lights do.

3dHome renders a floor plan as an interactive 3D scene and — optionally — connects
to [Home Assistant](https://www.home-assistant.io/) over WebSocket, so every lamp
in the model reflects the real state of the lamp in the room: on or off, its
brightness, its colour. Turn a light on from your phone and the model changes as
you watch.

It is a **static site**. No build step, no bundler, no `npm install`, no
`node_modules` — plain HTML, CSS and JavaScript served by any web server. The
only moving part is a small entrypoint script that writes your configuration
into `config.js` when the container starts.

<!-- TODO: screenshot -->
<p align="center">
  <em>Screenshot coming soon — the demo house, rendered.</em>
</p>

---

## Quick start

### With Docker

```sh
docker run --rm -p 8080:80 ghcr.io/zaida-3do/3dhome:latest
```

Open <http://localhost:8080>. You get the fictional demo house with Home
Assistant disabled — enough to look around and decide whether you want it.

To connect it to your own Home Assistant:

```sh
docker run --rm -p 8080:80 \
  -e HOME3D_HA_URL="https://homeassistant.example.com" \
  -e HOME3D_HA_TOKEN="<your long-lived access token>" \
  ghcr.io/zaida-3do/3dhome:latest
```

Read the [Security](#security) section before you do this. The token is served
to the browser.

### Without Docker

There is nothing to build, so any static file server works:

```sh
git clone https://github.com/Zaida-3dO/3dHome.git
cd 3dHome
python -m http.server 8080
```

Open <http://localhost:8080>. Home Assistant is off (there is no `config.js`),
and the demo house renders as a static model.

To point that at Home Assistant, copy the example config and edit it:

```sh
cp config.example.json config.json
```

`config.json` is gitignored, because it will hold your token.

---

## Configuration

Configuration resolves in this order, highest priority first:

1. **URL parameter** — `?haUrl=https://...` overrides the HA URL. Used by
   embedders (an iframe passing its own origin).
2. **`window.HOME3D_CONFIG`** — set by `config.js`, which the container
   entrypoint generates from the environment variables below.
3. **`config.json`** — a file you write yourself, for non-container deployments.
4. **`config.example.json`** — the committed demo default, so a bare clone runs.

### Environment variables

Read by `deploy/entrypoint.sh` at container start.

| Variable | Purpose | Default |
|---|---|---|
| `HOME3D_HA_URL` | Home Assistant base URL, e.g. `https://homeassistant.example.com`. | *unset — HA disabled* |
| `HOME3D_HA_FALLBACK_URL` | Second URL to race against the first. Useful when HA is reachable at one address on the LAN and another over VPN. | *unset* |
| `HOME3D_HA_TOKEN` | A Home Assistant **long-lived access token**. See [Security](#security). | *unset — HA disabled* |
| `HOME3D_HA_ENABLED` | Force the HA integration on or off. | `true` when URL **and** token are both set, otherwise `false` |
| `HOME3D_HOUSE` | Which house profile to load from `houses/`. | `demo` |
| `HOME3D_WS_RECONNECT_MS` | Delay before reconnecting a dropped WebSocket, in ms. | `5000` |
| `HOME3D_POLL_INTERVAL_MS` | Polling interval when the WebSocket is unavailable, in ms. | `5000` |
| `APP_VERSION` | Stamped into the page and onto every `?v=` cache-busting query. | *unset* |

---

## Security

**Read this before exposing 3dHome to anything.**

> ### The Home Assistant token is served to the browser.
>
> 3dHome is a static app with no backend. It talks to Home Assistant directly
> from the page, which means your long-lived access token is delivered to every
> browser that loads it — in `config.js`, in plain text. **Anyone who can load
> the page can read the token and use it against your Home Assistant with the
> full privileges of the user who created it.**

This is not a subtle flaw to be patched later; it is a consequence of the
architecture. A static page with no server has nowhere to hide a secret. Deploy
accordingly:

**Only deploy 3dHome behind something that authenticates users:**

- a VPN or [Tailscale](https://tailscale.com/) / WireGuard network,
- an authenticating reverse proxy (Authelia, oauth2-proxy, Cloudflare Access),
- or a listener bound to your LAN only.

**Never put it on the public internet**, and never on a URL you would share.

### Reducing the blast radius

If you run it anyway — and plenty of people reasonably will, on a home network —
these measurably limit the damage:

- **Use a dedicated Home Assistant user.** Create a separate account for 3dHome
  and generate the token as that user, rather than using your admin account. A
  leaked token is then bounded by that user's permissions. 3dHome only needs to
  read light states and (if you want the controls) call `light.turn_on` /
  `light.turn_off`.
- **Rotate the token.** Home Assistant long-lived tokens do not expire on their
  own. Revoke and reissue periodically in *Profile → Security → Long-lived
  access tokens*, and immediately if the deployment was ever reachable more
  widely than you intended.
- **Prefer `?haUrl=` when embedding.** An embedder on the same origin as Home
  Assistant can pass its own origin, keeping traffic local.
- **Keep `config.js` and `config.json` out of git.** Both are gitignored. Do not
  override that.

### Your house is data too

The floor plan, room names and entity ids describe where you live and what is
installed in it. This repo therefore ships a **fictional** house in
`houses/demo/`, and every other `houses/*/` directory is gitignored. Keep your
real house in a private overlay mounted at deploy time:

```sh
docker run --rm -p 8080:80 \
  -v /srv/myhouse:/usr/share/nginx/html/houses/myhouse:ro \
  -e HOME3D_HOUSE=myhouse \
  ghcr.io/zaida-3do/3dhome:latest
```

`scripts/check-no-pii.sh` enforces this in CI. Run it before you push.

---

## Modelling your own house

The demo house exists so the app is usable immediately. Replacing it with your
own is real work — you are describing a building — but it is all data, no code.

```sh
cp -r houses/demo houses/myhouse
```

`houses/myhouse/` is gitignored the moment it exists, so your floor plan cannot
be committed by accident.

1. **`geometry.json`** — rooms, walls, doors, and light positions. This is the
   substantial part. Measurements are in centimetres; a
   [Sweet Home 3D](https://www.sweethome3d.com/) export is a good starting point.
2. **`rooms.json`** — maps each room id to its Home Assistant entity ids, so the
   model knows which lamp is which.
3. **`textures/`** — optional wall textures. Keep them small.

Then point the app at it:

```sh
HOME3D_HOUSE=myhouse
```

The full field-by-field reference is in [`docs/house-profile.md`](docs/house-profile.md),
and [`houses/schema.json`](houses/schema.json) validates both files in CI.

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). In short: keep it buildless, run
`scripts/check-no-pii.sh` before pushing, and never commit a real house.

## License

[MIT](LICENSE) © 2026 Zaida-3dO.

Vendored third-party libraries in `vendor/` keep their own licences —
[three.js](https://threejs.org/) (MIT), and React and Babel (both MIT) for the
spec pages.
