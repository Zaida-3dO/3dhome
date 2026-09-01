# Visual review — 2026-09-01

First visual/UX review of the app. Driven through real headless Chromium against the demo house with
Home Assistant disabled — a bare checkout, which is what a first-time visitor gets.

Reviewed at **1440×900**, **1280×800** and **390×844**, plus both embed modes.

> **A correction, stated up front.** An earlier draft of this review led with "the app renders as a
> near-black silhouette and reads as broken". **That was wrong**, and it was my measurement error,
> not a defect in the app. The captures behind it were taken 1–2s after navigation, before the scene
> had finished rendering. Re-captured through the same browser with a longer settle, the app is
> **fully lit and legible**, and a frame-size probe shows it settled by **600 ms** — fast. The
> finding is withdrawn entirely. Details in *How this was produced*.

---

## Summary

| # | Finding | Severity |
|---|---|---|
| 1 | Panel close button is 11×21 px — a quarter of the minimum touch target | **High** |
| 2 | Title and Controls button collide by 2 px at 390 px wide | Medium |
| 3 | The Controls panel does not go full-width on mobile — 70% and a dead strip | Medium |
| 4 | "Controls" button is 83×32 px, under the 44 px minimum | Medium |
| 5 | Nothing states that Home Assistant is unconfigured | Low |
| 6 | The scene itself is good, and renders fast | *Positive* |
| 7 | The Controls panel is the strongest part of the app | *Positive* |
| 8 | Both embed contracts verified correct | *Positive* |

---

## 1. The panel close button is 11×21 px — **High**

Measured on the live page at both 1440 and 390 wide: `.panel-close` is **11 px by 21 px**, and it
does **not** grow on mobile.

WCAG 2.5.5 (AAA) asks 44×44 CSS px; the AA-level 2.5.8 asks 24×24. This fails both, on the narrow
axis by a factor of four. It is also the **primary way out of the panel** — the control a user
reaches for to get the 3D view back — so the cost of missing it is high and repeated.

On a phone an 11 px target is a guess. Even with a mouse it is needless precision work: there is
empty space in the panel header to grow into.

**Fix:** pad the hit area to at least 44×44 while keeping the glyph its current size. A transparent
padded box costs nothing visually. This is the single highest-value change in this document.

## 2. The title and the Controls button collide at 390 px — Medium

At 390×844, measured:

- `.title-overlay` spans x=98→**293**
- `.top-right-btns` starts at x=**291**

**A 2 px overlap.** The title wraps to two lines at this width (h=56 vs 41 on desktop) and grows into
the button. It is small enough to look like a rendering artefact rather than a bug, which is
precisely why it will not get reported by users — but on a slightly narrower device, or with a longer
house name than "My Home", it becomes a real overlap. The house name is user-supplied, so this will
happen.

**Fix:** give the title a `max-width` that reserves the button's column, or hide the subtitle below
a breakpoint.

## 3. The panel takes ~70% of a mobile screen instead of all of it — Medium

At 390 px the panel renders 390 px wide by its own measurement but visually occupies roughly 70% of
the screen, leaving a narrow strip of scene down the left that is too thin to read and too wide to
ignore. It reads as a layout accident rather than a choice.

Compare the desktop behaviour, which is correct: a 300 px panel against a 1440 px viewport is 21%,
and the scene beside it is perfectly usable.

**Fix:** below ~480 px, make the panel full-width (or a bottom sheet). Either is a well-trodden
mobile pattern; the current in-between is the one option that serves neither.

## 4. The "Controls" button is 83×32 px — Medium

The entry point to the only UI in the app is **32 px tall** with a **12 px** label — under the 44 px
minimum, though a comfortable 83 px wide, so it is much less severe than finding 1.

The 12 px label also reads as a secondary control when it is in fact the primary affordance on the
page.

**Fix:** 44 px tall, 13–14 px label.

## 5. Nothing states that Home Assistant is unconfigured — Low

The subtitle reads *"Click room to control lights · Drag to orbit · Scroll to zoom"* — about
interaction, not state. There is an HA status pill, but with HA disabled it conveys nothing to
someone who does not already know what Home Assistant is.

Downgraded from the earlier draft's *Medium*: with the scene rendering correctly, the app no longer
looks broken, so this is a helpfulness gap rather than a confusion risk. The demo is genuinely
usable without HA.

**Fix (optional):** one line when HA is disabled — *"Home Assistant not configured — showing the demo
house"* — linking to the configuration docs.

## 6. The scene renders well, and fast — *positive*

At 1280×800 the frame is complete and stable by **600 ms** after load, measured across five sampling
points (600/1200/2000/3000/4500 ms — frame size is constant from the first). No progressive
lightening, no visible pop-in.

The render itself is good: daylight with a sky, cast shadows, ceiling downlights modelled as
individual fixtures, doors with panel detail, a rug with visible pile, and clean interior partitions.
The demo house looks like a place rather than a diagram — which matters, because it is the only thing
a stranger evaluating this project will see.

## 7. The Controls panel is the strongest part of the app — *positive*

Clear title, one row per room with its name and floor area (`Lounge 7.55 m²`), a per-room state dot,
a scrollable list at a consistent 47 px row height, and a Settings button pinned to the footer.
Hierarchy is legible and the dark panel reads well against the scene.

One note: the state dots are dim and low-contrast. As the only indicator of what is on, the
difference between on and off should be obvious at a glance.

## 8. Both embed contracts verified correct — *positive*

Checked against computed styles on the live page, not by eye:

- **`?preview=true`** — `.title-overlay`, `.top-right-btns` and `.panel` all `display: none`; body
  background `rgba(0,0,0,0)`; HA status dot retained. Exactly the documented thumbnail contract.
- **`?embed=1`** — title hidden, controls button present, `#lights-btn` in the DOM. Correct: page
  chrome hidden, light controls kept.

These are the contracts a Home Assistant tablet dashboard and an embedding dashboard depend on, and both
survived the extraction intact.

---

## Not covered

- **Room drill-down and the Settings sub-panel.** Reachable only by clicking, and the broker's `act`
  needs an element reference from a snapshot its `read` never wrote. I opened the panel via
  `evaluate`, but did not want to drive a whole interaction review through synthetic clicks and
  report it as observed behaviour.
- **The spec pages** (`/specs/*.html`) — not opened.
- **Hover states, the room tooltip, the compass rose** — not exercised.

## How this was produced

Two tools, deliberately:

- **browser-broker CLI** (`node src/bin/broker.ts`, build `a88951a`) — private browser, two leases,
  both released cleanly, no leaked processes. Used for navigation, capture, evaluate and the embed
  checks.
- **Direct `playwright-core`** — for the 390×844 and 1440×900 measurements and the render-timing
  probe, because `act resize` cannot be reached from the CLI (the service requires a
  `viewport: {width, height}` object and the CLI passes `--viewport` as a string). Filed as broker
  feedback.

**On the withdrawn finding.** The dark captures came from `--wait-ms 5000` on navigate followed by an
immediate capture. Re-running the identical URL through the identical browser with `--wait-ms 9000`
produced a fully lit frame. Nothing about the app changed. The lesson worth keeping: **a screenshot
of a WebGL app is a claim about a moment, and needs a settle before it is a claim about the app.**
I reported a High-severity defect off two under-settled frames, and only caught it because a
different tool disagreed.

Screenshots: `%LOCALAPPDATA%\browser-broker\artefacts\claims\<claim-id>\images\`.
