// Per-pixel diff of the paired camera screenshots a probe run produced.
// Decodes PNGs in a headless page (no image deps in this repo) and reports,
// per camera, the share of pixels that differ beyond a small tolerance.
import { chromium } from 'playwright-core';
import fs from 'fs';
import path from 'path';

// Chromium to drive. playwright-core does not ship a browser, so point this at
// one you already have (a Playwright download, or your system Chrome).
const EXE = process.env.H3D_CHROME;
if (!EXE) {
  console.error('Set H3D_CHROME to a Chromium/Chrome executable. See scripts/compare/README.md.');
  process.exit(2);
}
const OUT = process.env.H3D_OUT || path.join(process.cwd(), '.compare-out');
const TAG = process.env.H3D_TAG || 'run';
const CAMS = (process.env.H3D_CAMS || 'top,front,back,east,west,se,sw,ne,nw,iso').split(',');
const TOL = Number(process.env.H3D_TOL || 8); // per-channel tolerance (0-255)

const dir = path.join(OUT, TAG);
const browser = await chromium.launch({ executablePath: EXE, headless: true });
const page = await browser.newPage();

const rows = [];
for (const cam of CAMS) {
  const fa = path.join(dir, cam + '-reference.png');
  const fb = path.join(dir, cam + '-subject.png');
  if (!fs.existsSync(fa) || !fs.existsSync(fb)) { rows.push({ cam, err: 'missing' }); continue; }
  const a = fs.readFileSync(fa).toString('base64');
  const b = fs.readFileSync(fb).toString('base64');
  const res = await page.evaluate(async ({ a, b, TOL }) => {
    const load = src => new Promise((ok, no) => {
      const i = new Image(); i.onload = () => ok(i); i.onerror = no;
      i.src = 'data:image/png;base64,' + src;
    });
    const [ia, ib] = await Promise.all([load(a), load(b)]);
    const w = Math.min(ia.width, ib.width), h = Math.min(ia.height, ib.height);
    const get = img => {
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const x = c.getContext('2d', { willReadFrequently: true });
      x.drawImage(img, 0, 0);
      return x.getImageData(0, 0, w, h).data;
    };
    const da = get(ia), db = get(ib);
    let diff = 0, sum = 0, maxd = 0;
    for (let i = 0; i < da.length; i += 4) {
      const dr = Math.abs(da[i] - db[i]);
      const dg = Math.abs(da[i + 1] - db[i + 1]);
      const dbl = Math.abs(da[i + 2] - db[i + 2]);
      const m = Math.max(dr, dg, dbl);
      if (m > maxd) maxd = m;
      sum += (dr + dg + dbl) / 3;
      if (m > TOL) diff++;
    }
    const n = (da.length / 4);
    return { w, h, pixels: n, diff, pct: (diff / n) * 100, meanDelta: sum / n, maxDelta: maxd };
  }, { a, b, TOL });
  rows.push({ cam, ...res });
}
await browser.close();

const out = { tag: TAG, tolerance: TOL, rows };
fs.writeFileSync(path.join(dir, 'pixdiff.json'), JSON.stringify(out, null, 1));
console.log('camera   diff%    meanDelta  maxDelta  pixels');
for (const r of rows) {
  if (r.err) { console.log(r.cam.padEnd(8), r.err); continue; }
  console.log(
    r.cam.padEnd(8),
    r.pct.toFixed(2).padStart(6),
    r.meanDelta.toFixed(2).padStart(10),
    String(r.maxDelta).padStart(9),
    String(r.pixels).padStart(8)
  );
}
const avg = rows.filter(r => !r.err).reduce((s, r) => s + r.pct, 0) / rows.filter(r => !r.err).length;
console.log('AVERAGE  ' + avg.toFixed(2) + '%');
