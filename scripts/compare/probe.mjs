// Capture harness: load two builds of the app at every camera preset, screenshot
// each, and dump a structured digest of the three.js scene graph.
//
// Written to answer "is this app rendering the same scene as the one it was
// extracted from?" without eyeballing screenshots -- a WebGL canvas differs for
// reasons a person cannot see (a texture's wrap mode, a light's decay), and an
// early screenshot of a WebGL app lies, so every capture waits for a settle.
//
// Pairs with pixel-diff.mjs (per-camera pixel deltas) and scene-diff.mjs
// (structured graph comparison). See README.md.
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
const SETTLE = Number(process.env.H3D_SETTLE || 7000);
const W = 1280, H = 900;

// The two builds to compare. `reference` is whatever you are trying to match
// (for the original extraction this was the predecessor app); `subject` is this
// repo being served. Both must already be running -- this script does not start
// a server, because the settle time below assumes a warm one.
const TARGETS = {
  reference: process.env.H3D_REFERENCE || 'http://localhost:8212/home3d.html',
  subject: process.env.H3D_SUBJECT || 'http://localhost:8211/index.html',
};

function DIGEST() {
  const r = (n, d) => (typeof n === 'number' && isFinite(n)) ? Number(n.toFixed(d === undefined ? 4 : d)) : n;
  const v3 = o => o ? [r(o.x), r(o.y), r(o.z)] : null;
  const hex = c => (c && c.getHexString) ? ('#' + c.getHexString()) : null;

  let scene = null, renderer = null, camera = null;
  const roots = [window.__H3D_API, window.__H3D_DEBUG, window.Home3DScene, window.__home3d, window];
  for (const R of roots) {
    if (!R) continue;
    try {
      if (!scene && R.scene && R.scene.isScene) scene = R.scene;
      if (!renderer && R.renderer && R.renderer.domElement) renderer = R.renderer;
      if (!camera && R.camera && R.camera.isCamera) camera = R.camera;
      if (!camera && typeof R.getCamera === 'function') {
        const c = R.getCamera();
        if (c && c.isCamera) camera = c;
      }
    } catch (e) {}
  }
  // The renderer is not on the public API; recover it from the canvas the
  // scene created (three stashes nothing, so match by the WebGL canvas in the
  // container and read the renderer the wrapper captured).
  if (!renderer && window.__H3D_RENDERER) renderer = window.__H3D_RENDERER;
  if (!scene && window.__H3D_SCENE) scene = window.__H3D_SCENE;
  if (!camera && window.__H3D_CAM) camera = window.__H3D_CAM;
  if (!scene) {
    return { error: 'no scene handle', exposed: Object.keys(window).filter(k => /home3d|h3d|three|scene/i.test(k)).slice(0, 40) };
  }

  const texDigest = t => t ? {
    name: t.name || null,
    src: (t.image && (t.image.currentSrc || t.image.src)) ? String(t.image.currentSrc || t.image.src).split('/').slice(-1)[0] : null,
    wrapS: t.wrapS, wrapT: t.wrapT,
    repeat: [r(t.repeat.x), r(t.repeat.y)],
    offset: [r(t.offset.x), r(t.offset.y)],
    rotation: r(t.rotation),
    center: [r(t.center.x), r(t.center.y)],
    flipY: t.flipY,
    colorSpace: t.colorSpace || t.encoding,
    anisotropy: t.anisotropy,
    minFilter: t.minFilter, magFilter: t.magFilter,
  } : null;

  const matDigest = m => {
    if (!m) return null;
    if (Array.isArray(m)) return m.map(matDigest);
    return {
      type: m.type, name: m.name || null,
      color: hex(m.color), emissive: hex(m.emissive),
      emissiveIntensity: r(m.emissiveIntensity),
      roughness: r(m.roughness), metalness: r(m.metalness),
      opacity: r(m.opacity), transparent: m.transparent,
      side: m.side, flatShading: m.flatShading,
      depthWrite: m.depthWrite, depthTest: m.depthTest,
      alphaTest: r(m.alphaTest),
      map: texDigest(m.map),
      normalMap: !!m.normalMap, roughnessMap: !!m.roughnessMap,
      aoMap: !!m.aoMap, emissiveMap: !!m.emissiveMap,
      envMapIntensity: r(m.envMapIntensity),
      vertexColors: m.vertexColors, toneMapped: m.toneMapped,
      wireframe: m.wireframe,
    };
  };

  const objs = [];
  const byType = {};
  const lights = [];
  scene.traverse(o => {
    byType[o.type] = (byType[o.type] || 0) + 1;
    if (o.isLight) {
      lights.push({
        type: o.type, name: o.name || null,
        color: hex(o.color), intensity: r(o.intensity),
        position: v3(o.position),
        target: (o.target && o.target.position) ? v3(o.target.position) : null,
        distance: r(o.distance), decay: r(o.decay),
        angle: r(o.angle), penumbra: r(o.penumbra),
        groundColor: hex(o.groundColor),
        castShadow: o.castShadow, visible: o.visible,
        shadow: o.shadow ? {
          mapSize: [o.shadow.mapSize.width, o.shadow.mapSize.height],
          bias: r(o.shadow.bias, 6), normalBias: r(o.shadow.normalBias, 6),
          radius: r(o.shadow.radius),
          cam: o.shadow.camera ? {
            near: r(o.shadow.camera.near), far: r(o.shadow.camera.far),
            top: r(o.shadow.camera.top), bottom: r(o.shadow.camera.bottom),
            left: r(o.shadow.camera.left), right: r(o.shadow.camera.right),
            fov: r(o.shadow.camera.fov),
          } : null,
        } : null,
      });
    }
    if (o.isMesh || o.isLine || o.isPoints || o.isSprite) {
      const g = o.geometry;
      let bb = null;
      try {
        g.computeBoundingBox();
        bb = g.boundingBox ? { min: v3(g.boundingBox.min), max: v3(g.boundingBox.max) } : null;
      } catch (e) {}
      objs.push({
        type: o.type, name: o.name || null,
        geo: g ? g.type : null,
        params: (g && g.parameters) ? Object.fromEntries(Object.entries(g.parameters).map(kv => [kv[0], typeof kv[1] === 'number' ? r(kv[1]) : kv[1]])) : null,
        bbox: bb,
        pos: v3(o.position),
        rot: o.rotation ? [r(o.rotation.x), r(o.rotation.y), r(o.rotation.z)] : null,
        scale: v3(o.scale),
        visible: o.visible,
        // EFFECTIVE visibility -- o.visible AND every ancestor's. A dev overlay
        // hides itself by setting its GROUP invisible while each mesh inside
        // stays visible:true, so per-mesh visibility alone cannot tell a hidden
        // overlay from a drawn one, and a scene-graph diff would report dozens
        // of meshes 'missing' that were never on screen in the first place.
        visibleEffective: (function () {
          let n = o;
          while (n) { if (!n.visible) return false; n = n.parent; }
          return true;
        })(),
        castShadow: o.castShadow, receiveShadow: o.receiveShadow,
        renderOrder: o.renderOrder,
        mat: matDigest(o.material),
      });
    }
  });

  const T = (typeof THREE !== 'undefined') ? THREE : null;
  return {
    counts: byType,
    meshTotal: objs.length,
    lights: lights,
    objects: objs,
    scene: {
      background: scene.background
        ? (scene.background.isColor ? hex(scene.background)
          : (scene.background.isTexture ? ('texture:' + (scene.background.name || scene.background.mapping)) : String(scene.background.type)))
        : null,
      environment: scene.environment ? 'texture' : null,
      fog: scene.fog ? {
        type: scene.fog.type, color: hex(scene.fog.color),
        near: r(scene.fog.near), far: r(scene.fog.far), density: r(scene.fog.density, 6),
      } : null,
    },
    renderer: renderer ? {
      toneMapping: renderer.toneMapping,
      toneMappingExposure: r(renderer.toneMappingExposure),
      outputColorSpace: renderer.outputColorSpace || renderer.outputEncoding,
      shadowMapEnabled: renderer.shadowMap ? renderer.shadowMap.enabled : null,
      shadowMapType: renderer.shadowMap ? renderer.shadowMap.type : null,
      pixelRatio: renderer.getPixelRatio ? r(renderer.getPixelRatio()) : null,
      size: (renderer.getSize && T) ? (function (sz) { return [sz.width, sz.height]; })(renderer.getSize(new T.Vector2())) : null,
      clearColor: (renderer.getClearColor && T) ? hex(renderer.getClearColor(new T.Color())) : null,
      clearAlpha: renderer.getClearAlpha ? r(renderer.getClearAlpha()) : null,
    } : null,
    camera: camera ? {
      type: camera.type, fov: r(camera.fov), near: r(camera.near), far: r(camera.far),
      pos: v3(camera.position), zoom: r(camera.zoom),
    } : null,
    three: (T && T.REVISION) ? T.REVISION : null,
  };
}

// Relaunched per capture rather than held for the whole run. A long software-
// rendered session intermittently loses the browser process, and when it did
// the entire 20-capture run aborted with nothing written -- a bad trade for a
// script whose only job is to gather evidence. One dead browser should cost
// one capture.
const launchBrowser = () => chromium.launch({
  executablePath: EXE,
  headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--hide-scrollbars'],
});
let browser = await launchBrowser();
const freshBrowser = async () => {
  try { if (browser && browser.isConnected()) await browser.close(); } catch (e) {}
  browser = await launchBrowser();
  return browser;
};

fs.mkdirSync(path.join(OUT, TAG), { recursive: true });
const report = {};

for (const label of Object.keys(TARGETS)) {
  const base = TARGETS[label];
  report[label] = { cams: {}, };
  // newContext can itself throw when the browser died since the last target;
  // guard it the same way the per-camera newPage below is guarded.
  const newCtx = async () => {
    try {
      if (!browser.isConnected()) await freshBrowser();
      return await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
    } catch (e) {
      await freshBrowser();
      return await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
    }
  };
  let ctx = await newCtx();
  for (const cam of CAMS) {
    // A browser lost since the last capture leaves the context dead too; both
    // are rebuilt before the page that would otherwise throw.
    if (!browser.isConnected()) ctx = await newCtx();
    let page;
    try {
      page = await ctx.newPage();
    } catch (e) {
      ctx = await newCtx();
      page = await ctx.newPage();
    }
    // Capture the scene API and the renderer, neither of which the page exposes.
    // Both files build the scene inside an IIFE, so hook the constructors
    // themselves before any page script runs.
    await page.addInitScript(() => {
      const hook = () => {
        if (typeof window.THREE === 'undefined' || window.__H3D_HOOKED) return;
        window.__H3D_HOOKED = true;
        const OrigR = window.THREE.WebGLRenderer;
        window.THREE.WebGLRenderer = function (...a) {
          const r = new OrigR(...a);
          window.__H3D_RENDERER = r;
          return r;
        };
        window.THREE.WebGLRenderer.prototype = OrigR.prototype;
        // Home3DScene is a module-scope const in both files, so it never lands
        // on window and cannot be wrapped. Capture the Scene instead — the app
        // builds exactly one, and every render pass goes through it.
        const OrigS = window.THREE.Scene;
        window.THREE.Scene = function (...a) {
          const s = new OrigS(...a);
          if (!window.__H3D_SCENE) window.__H3D_SCENE = s;
          return s;
        };
        window.THREE.Scene.prototype = OrigS.prototype;
        // The perspective camera likewise: first one built is the orbit camera.
        const OrigC = window.THREE.PerspectiveCamera;
        window.THREE.PerspectiveCamera = function (...a) {
          const c = new OrigC(...a);
          if (!window.__H3D_CAM) window.__H3D_CAM = c;
          return c;
        };
        window.THREE.PerspectiveCamera.prototype = OrigC.prototype;
      };
      const hookScene = () => {
        if (typeof window.Home3DScene === 'undefined' || window.__H3D_SCENE_HOOKED) return;
        window.__H3D_SCENE_HOOKED = true;
        const orig = window.Home3DScene.create;
        window.Home3DScene.create = function (...a) {
          const api = orig.apply(this, a);
          window.__H3D_API = api;
          return api;
        };
      };
      // Poll during load: THREE and Home3DScene arrive on separate <script> tags.
      const iv = setInterval(() => { hook(); hookScene(); }, 1);
      window.addEventListener('load', () => setTimeout(() => clearInterval(iv), 3000));
    });
    const errs = [];
    page.on('console', m => { if (m.type() === 'error') errs.push(m.text().slice(0, 200)); });
    page.on('pageerror', e => errs.push('PAGEERROR: ' + String(e).slice(0, 200)));
    const url = base + '?camera=' + cam;
    try {
      await page.goto(url, { waitUntil: 'load', timeout: 90000 });
      await page.waitForTimeout(SETTLE);
      // Freeze the scene before capturing. The clouds drift on rAF forever, so
      // the page is never idle and the compositor keeps handing the screenshot
      // a moving target — which is what times the capture out under
      // swiftshader, and what would otherwise make the cloud positions differ
      // between the two builds for reasons that are pure timing. setActive
      // (false) halts the render loop without tearing the scene down.
      // Home3DScene is a module-scope const in both builds and never reaches
      // window, so the public setActive() is out of reach; park the clouds by
      // hand on the captured Scene instead, which is the only animated thing in
      // the frame, then let one more frame paint the parked positions.
      // The clouds are placed with Math.random() at construction and then drift
      // on rAF, so they can never match between two builds — or between two
      // runs of the SAME build. Left alone they dominate the pixel diff of every
      // view that shows sky and mask the differences actually being measured.
      // So: park them at deterministic positions, identically in both builds.
      // This normalises a known-random element; it does not paper over a real
      // difference, because cloud COUNT and material are compared separately in
      // the scene-graph digest.
      await page.evaluate(() => {
        const s = window.__H3D_SCENE;
        if (!s) return;
        const clouds = [];
        s.traverse(o => { if (o.isSprite && o.userData && o.userData.driftSpeed !== undefined) clouds.push(o); });
        clouds.sort((a, b) => a.id - b.id);
        clouds.forEach((o, i) => {
          o.userData.driftSpeed = 0;
          const min = o.userData.wrapMinX, max = o.userData.wrapMaxX;
          const n = clouds.length;
          o.position.x = min + ((i + 0.5) / n) * (max - min);
          o.position.y = 24 + (i % 4) * 2;
          // Z likewise comes from Math.random(); fan them across the same span
          // the builds use so both get an identical, reproducible sky.
          o.position.z = min + ((i * 7 % n) / n) * (max - min);
          o.scale.set(20, 10, 1);
        });
        // Both builds render on demand, and a direct scene mutation from
        // outside does not itself request a frame. A synthetic wheel event with
        // zero delta wakes the loop without changing the camera pose.
        const cv = document.querySelector('canvas');
        if (cv) cv.dispatchEvent(new WheelEvent('wheel', { deltaY: 0, bubbles: true }));
      }).catch(() => {});
      await page.waitForTimeout(600);
      // Screenshot with a generous timeout and retries. Under swiftshader the
      // capture competes with the render loop (clouds drift continuously, so
      // the page never goes idle) and a 30s default times out on the heavier
      // three-quarter views. `animations: 'disabled'` only freezes CSS
      // animations, not rAF, so the retry is what actually carries this.
      const shotPath = path.join(OUT, TAG, cam + '-' + label + '.png');
      let shot = false;
      for (let attempt = 0; attempt < 3 && !shot; attempt++) {
        try {
          await page.screenshot({ path: shotPath, timeout: 120000, animations: 'disabled' });
          shot = true;
        } catch (e) {
          errs.push('SHOT' + attempt + ': ' + String(e).slice(0, 120));
          await page.waitForTimeout(2000);
        }
      }
      if (cam === CAMS[0]) report[label].digest = await page.evaluate(DIGEST);
    } catch (e) {
      errs.push('NAV: ' + String(e).slice(0, 200));
    }
    report[label].cams[cam] = { errors: errs.slice(0, 8) };
    try { await page.close(); } catch (e) {}
  }
  try { await ctx.close(); } catch (e) {}
}

fs.writeFileSync(path.join(OUT, TAG, 'digest.json'), JSON.stringify(report, null, 1));
console.log('WROTE ' + path.join(OUT, TAG));
for (const l of Object.keys(report)) {
  const d = report[l].digest;
  if (d && d.error) console.log(l, 'DIGEST-ERROR', d.error, JSON.stringify(d.exposed));
  else console.log(l, 'meshes=' + (d && d.meshTotal), 'lights=' + (d && d.lights.length));
  for (const c of Object.keys(report[l].cams)) {
    const v = report[l].cams[c];
    if (v.errors.length) console.log('   ', l, c, JSON.stringify(v.errors.slice(0, 3)));
  }
}
await browser.close();
