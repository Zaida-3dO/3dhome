# 3D Home

A browser-based 3D model of your home that reflects **live Home Assistant state** — walk around your floor plan and see which lights are actually on.

No build step. It is plain HTML, CSS and JavaScript with a vendored copy of three.js: clone it, serve the directory, and it runs. Your house is **data**, not code — described in a JSON profile you can edit by hand.

![screenshot placeholder](docs/screenshot.png)

---

## Quick start

### Try it with the demo house

```bash
git clone https://github.com/Zaida-3dO/3dhome.git
cd 3dhome
python -m http.server 8080
```

Open <http://localhost:8080>. You get a fictional demo house with Home Assistant disabled. No configuration, no account, no container required.

### Run it with Docker

```bash
docker run -p 8080:80 ghcr.io/zaida-3do/3dhome:latest
```

With Home Assistant wired up:

```bash
docker run -p 8080:80 \
  -e HOME3D_HA_URL="https://your-ha-host.example.com" \
  -e HOME3D_HA_TOKEN="your-long-lived-access-token" \
  ghcr.io/zaida-3do/3dhome:latest
```

---

## ⚠️ Security — read this before you deploy it

**This app puts your Home Assistant long-lived access token in the browser.** The token is served to every client that can load the page, so anyone who can reach it can read the token and use it against your Home Assistant with full user privileges.

Deploy it **only** behind something that controls who can reach it:

- a VPN or a mesh network such as Tailscale or NetBird
- an authenticating reverse proxy
- a listener bound to your LAN only

**Do not expose it to the public internet.**

Two things worth doing even so:

- **Create a dedicated Home Assistant user** for this app and give it the narrowest role that works, so a leaked token is bounded rather than total.
- **Rotate the token** if the page has ever been reachable somewhere you did not intend.

This is a property of any browser app talking directly to Home Assistant, not a defect specific to this one — but it is your decision to make with the facts in hand rather than after the fact.

---

## Configuration

Everything is supplied at runtime. Nothing about your house or your network is committed to this repository.

| Variable | What it does | Default |
|---|---|---|
| `HOME3D_HA_URL` | Home Assistant base URL | *(unset — HA disabled)* |
| `HOME3D_HA_FALLBACK_URL` | Second URL to try if the first is unreachable | *(unset)* |
| `HOME3D_HA_TOKEN` | Long-lived access token — see the security note above | *(unset — HA disabled)* |
| `HOME3D_HA_ENABLED` | Force HA on or off | `true` when URL **and** token are both set |
| `HOME3D_HOUSE` | Which house profile to load | `demo` |
| `HOME3D_WS_RECONNECT_MS` | WebSocket reconnect delay | `5000` |
| `HOME3D_POLL_INTERVAL_MS` | State poll interval | `5000` |
| `APP_VERSION` | Stamped into the page and its cache-busting | `dev` |

Configuration resolves through a precedence chain, highest first:

1. **`?haUrl=` URL parameter** — for an embedder that knows its own Home Assistant origin
2. **`window.HOME3D_CONFIG`** — written by the container entrypoint from the variables above
3. **`config.json`** — a file you mount or drop in beside the app (gitignored)
4. **`config.example.json`** — the committed demo default

The bottom of that chain always works, which is why a bare clone runs with no setup.

See [`docs/configuration.md`](docs/configuration.md) for the full detail and [`.env.example`](.env.example) for a template.

---

## Modelling your own house

The demo house exists so the app is usable immediately. Replacing it with your own is real work — you are describing a floor plan — but it is all data:

```bash
cp -r houses/demo houses/myhouse
# edit houses/myhouse/geometry.json   — rooms, walls, doors, lights
# edit houses/myhouse/rooms.json      — room id → Home Assistant entity ids
python scripts/validate-house.py houses/myhouse
HOME3D_HOUSE=myhouse python -m http.server 8080
```

- **`geometry.json`** describes shapes: room polygons, walls, doors with their hinge side and swing direction, light positions, materials, and the coordinate transform from whatever tool you drew it in.
- **`rooms.json`** maps each room to its Home Assistant entities. It is kept separate from the geometry on purpose: a floor plan is shareable, a list of the devices in your home is not.

[`docs/house-profile.md`](docs/house-profile.md) documents every field, the units, how to derive the transform from a Sweet Home 3D export, and a worked minimal example.

**Your own house profile is gitignored by default.** Only `houses/demo/` is tracked. That is deliberate — see below.

---

## Privacy

A model of your home is personal data. A floor plan with room names, and a list of every light in it, says a lot about where and how you live.

This repository is built so that publishing the code never publishes a home:

- Only `houses/demo/` — a fictional house — is committed. Every other profile is gitignored.
- `config.js`, `config.json` and any secrets file are gitignored.
- [`scripts/check-no-pii.sh`](scripts/check-no-pii.sh) enforces the boundary in CI and fails closed: real-looking entity ids, private network addresses, oversized textures and stray house profiles all fail the build.

Run it yourself before you push:

```bash
./scripts/check-no-pii.sh
```

If you fork this to model your own house, keep your profile in a private repository or an untracked directory and mount it at deploy time.

---

## Embedding

The viewer supports embedded modes driven entirely by URL parameters, so it can be dropped into a dashboard as an iframe:

- `?preview=true` — a non-interactive, slowly rotating thumbnail with all chrome hidden
- `?embed=1` — fully interactive with light controls, chrome hidden
- `?haUrl=<origin>` — tells the embedded copy which Home Assistant to talk to

There are more — camera presets, shadow quality, frame-rate caps and several debug overlays. All of them are documented in [`docs/url-parameters.md`](docs/url-parameters.md).

---

## Development

There is no build. Edit a file, reload the page.

```bash
python -m http.server 8080     # serve it
./scripts/check-no-pii.sh      # privacy guard — run before pushing
python scripts/validate-house.py houses/demo
node --check src/home3d-scene.js
```

See [`CONTRIBUTING.md`](CONTRIBUTING.md) and [`docs/ci.md`](docs/ci.md).

---

## Licence

[MIT](LICENSE).

three.js, React and Babel are vendored under `vendor/` under their own licences. They are vendored rather than loaded from a CDN so the app works on a network with no internet access.
