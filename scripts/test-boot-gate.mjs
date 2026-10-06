/**
 * The cold-start overlay stays up until the house is VISUALLY COMPLETE
 * (2026-10-06) -- not merely until the house's own shaders compile.
 *
 *   1. src/boot-gate.js, behaviourally: it completes only after every wait
 *      has settled AND a frame has then been drawn; a rejected wait counts as
 *      settled; the timeout completes it anyway and names what was pending;
 *      it is single-shot; cancel() silences it.
 *   2. src/home3d-scene.js wires it: the house, the boot furniture build and
 *      the boot images are its waits, the timeout starts at onReady, the
 *      render loop reports drawn frames, dispose() cancels it.
 *   3. index.html dismisses the overlay on onFurnished, NOT onReady.
 *
 * No framework, no install: `node scripts/test-boot-gate.mjs`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { createBootGate } = await import(pathToFileURL(path.join(root, 'src/boot-gate.js')).href);

let passes = 0;
let failures = 0;
function check(name, ok, detail) {
  if (ok) { passes++; console.log('  ok   ' + name); }
  else { failures++; console.error('  FAIL ' + name + (detail !== undefined ? '\n       ' + detail : '')); }
}
const flush = () => new Promise(r => setTimeout(r, 0));
function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
// Fake timers: the test fires them by hand.
function fakeTimers() {
  const timers = new Map();
  let id = 0;
  return {
    setTimer: (fn, ms) => { timers.set(++id, { fn, ms }); return id; },
    clearTimer: t => { timers.delete(t); },
    fireAll: () => { const fns = [...timers.values()]; timers.clear(); fns.forEach(t => t.fn()); },
    timers
  };
}
function makeGate(extra) {
  const calls = [];
  let frameRequests = 0;
  const t = fakeTimers();
  const gate = createBootGate(Object.assign({
    onDone: info => calls.push(info),
    requestFrame: () => { frameRequests++; },
    setTimer: t.setTimer, clearTimer: t.clearTimer
  }, extra || {}));
  return { gate, calls, t, frames: () => frameRequests };
}

// ── 1. the gate itself ──────────────────────────────────────────────────────
{
  const { gate, calls, frames } = makeGate();
  const house = deferred(), furn = deferred();
  gate.wait('house', house.promise);
  gate.wait('furniture', furn.promise);
  gate.seal();
  gate.frameRendered();               // a frame of the bare house
  await flush();
  check('not done while waits are open, even after a frame', calls.length === 0);
  house.resolve();
  await flush();
  gate.frameRendered();
  check('not done with the furniture still pending', calls.length === 0);
  check('...and no frame requested yet', frames() === 0, frames());
  furn.resolve();
  await flush();
  check('every wait settled -> a frame is requested', frames() === 1, frames());
  check('...but not done until that frame is drawn', calls.length === 0);
  gate.frameRendered();
  check('done on the first frame drawn after everything settled', calls.length === 1);
  check('...not timed out, nothing pending', calls[0] && calls[0].timedOut === false && calls[0].pending.length === 0,
    JSON.stringify(calls[0]));
  gate.frameRendered();
  check('single-shot: later frames do not call onDone again', calls.length === 1);
}
{
  const { gate, calls } = makeGate();
  const furn = deferred();
  gate.wait('furniture', furn.promise);
  gate.seal();
  furn.reject(new Error('boom'));
  await flush();
  gate.frameRendered();
  check('a REJECTED wait counts as settled (a failure must not hold the overlay)', calls.length === 1);
}
{
  const { gate, calls } = makeGate();
  const d = deferred();
  gate.wait('furniture', d.promise);
  d.resolve();
  await flush();
  gate.frameRendered();
  check('not done before seal(), even with every wait settled', calls.length === 0);
  gate.seal();
  gate.frameRendered();
  check('done once sealed and a frame drawn', calls.length === 1);
}
{
  const { gate, calls } = makeGate();
  gate.seal();
  gate.wait('late', new Promise(() => {}));
  gate.frameRendered();
  check('a wait added after seal() is ignored', calls.length === 1);
}
{
  const { gate, calls, t } = makeGate();
  gate.wait('house', Promise.resolve());
  gate.wait('furniture', new Promise(() => {}));   // never settles
  gate.seal();
  gate.startTimeout(15000);
  await flush();
  gate.frameRendered();
  check('a hung wait holds the gate...', calls.length === 0);
  check('...with the fallback armed at the given ms', [...t.timers.values()].some(x => x.ms === 15000));
  t.fireAll();
  check('...until the timeout completes it anyway', calls.length === 1);
  check('...flagged timedOut and naming what was pending',
    calls[0] && calls[0].timedOut === true && calls[0].pending.join() === 'furniture', JSON.stringify(calls[0]));
}
{
  const { gate, calls, t } = makeGate();
  gate.wait('house', Promise.resolve());
  gate.seal();
  gate.startTimeout(15000);
  await flush();
  gate.frameRendered();
  check('completing normally clears the fallback timer', calls.length === 1 && t.timers.size === 0, t.timers.size);
  t.fireAll();
  check('...so it never fires a second onDone', calls.length === 1);
}
{
  const { gate, calls, t } = makeGate();
  gate.startTimeout(100);
  gate.startTimeout(200);
  check('startTimeout arms once', t.timers.size === 1);
  gate.cancel();
  check('cancel() clears the timer', t.timers.size === 0);
  gate.seal();
  gate.frameRendered();
  t.fireAll();
  check('cancel() means onDone is never called', calls.length === 0);
}
{
  const { gate } = makeGate({ onDone: () => { throw new Error('caller bug'); } });
  gate.seal();
  let threw = false;
  try { gate.frameRendered(); } catch (e) { threw = true; }
  check('a throwing onDone does not propagate into the render loop', !threw);
}

// ── 2. the scene wires it ───────────────────────────────────────────────────
{
  const src = fs.readFileSync(path.join(root, 'src/home3d-scene.js'), 'utf8').replace(/\r\n/g, '\n');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  check('scene imports createBootGate', /import \{ createBootGate \} from '\.\/boot-gate\.js';/.test(code));
  const fr = code.match(/function fireReady\(\) \{([\s\S]*?)\n    \}\n/);
  check('fireReady found', !!fr);
  check('fireReady resolves the gate\'s house wait', !!fr && /houseReadyResolve\(\);/.test(fr[1]));
  check('fireReady starts the boot-complete timeout (from onReady, not create)',
    !!fr && /bootGate\.startTimeout\(BOOT_COMPLETE_FALLBACK_MS\);/.test(fr[1]));
  check('the boot-complete timeout is 15 s', /const BOOT_COMPLETE_FALLBACK_MS = 15000;/.test(code));
  check('the house is a wait', /bootGate\.wait\('house', new Promise\(r => \{ houseReadyResolve = r; \}\)\);/.test(code));
  // The furniture and image waits come AFTER the boot build starts, then seal.
  const start = code.indexOf('if (furnitureVisible) startFurniture();');
  const furnWait = code.indexOf("bootGate.wait('furniture', furnitureAttached);");
  const imgWait = code.indexOf("bootGate.wait('images', Promise.all(textureLoads));");
  const seal = code.indexOf('bootGate.seal();');
  check('the boot furniture build is a wait, registered after it starts', start >= 0 && furnWait > start);
  check('the boot images are a wait', imgWait > start);
  check('the gate is sealed after both', seal > furnWait && seal > imgWait);
  check('sealed exactly once', (code.match(/bootGate\.seal\(\)/g) || []).length === 1);
  // Every buildScene texture load is tracked.
  check('no untracked TextureLoader().load / wallTexLoader.load left in the scene',
    !/TextureLoader\(\)\.load\(/.test(code) && !/wallTexLoader\.load\(/.test(code));
  check('three tracked loads (wallpaper, overlay, rug)', (code.match(/loadTracked\(/g) || []).length === 4,
    (code.match(/loadTracked\(/g) || []).length);
  const lt = code.match(/function loadTracked\([^)]*\) \{([\s\S]*?)\n    \}\n/);
  check('loadTracked settles in a finally on load AND on error',
    !!lt && (lt[1].match(/finally \{ settle\(\); \}/g) || []).length === 2, lt && lt[1]);
  // The loop reports frames AFTER drawing.
  const render = code.indexOf('ren.render(scene, cam);');
  const fRend = code.indexOf('bootGate.frameRendered();');
  const rMs = code.indexOf('const renderMs = performance.now() - renderT0;', render);
  check('the render loop reports a drawn frame right after ren.render() and its timing',
    render >= 0 && rMs > render && fRend > rMs && fRend - render < 200, fRend - render);
  const dStart = code.search(/\n      dispose\(\) \{/);
  const dispose = dStart >= 0 ? code.slice(dStart, code.indexOf('\n      }\n', dStart)) : '';
  check('dispose() cancels the gate', /bootGate\.cancel\(\);/.test(dispose));
  check('onDone calls onFurnished', /onDone: info => \{[\s\S]{0,600}?onFurnished\(info\)/.test(code));
  check('the boot build reports progress', /onProgress: typeof onFurnishProgress === 'function'/.test(code));
}

// ── 3. the page dismisses on onFurnished ────────────────────────────────────
{
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8').replace(/\r\n/g, '\n');
  const create = html.indexOf('Home3DScene.create(container, {');
  const end = html.indexOf('\n      });\n', create);
  const opts = create >= 0 && end > create ? html.slice(create, end) : '';
  check('Home3DScene.create options found', opts.length > 0);
  const onReady = opts.match(/onReady: \(\) => \{([\s\S]*?)\n        \},/);
  check('onReady handler found', !!onReady);
  check('onReady does NOT dismiss the overlay', !!onReady && !/dismiss\(\)/.test(onReady[1]), onReady && onReady[1]);
  const onFurnished = opts.match(/onFurnished: \(\) => \{([\s\S]*?)\n        \},/);
  check('onFurnished dismisses the overlay', !!onFurnished && /window\.__home3dLoading\.dismiss\(\);/.test(onFurnished[1]));
  check('onFurnished reveals the preview tile', !!onFurnished && /if \(isPreview\) container\.style\.opacity = '1';/.test(onFurnished[1]));
  check('the preview canvas starts hidden', /if \(isPreview\) \{\n\s*container\.style\.opacity = '0';/.test(html));
  check('dismiss() is called from exactly one create option', (opts.match(/dismiss\(\)/g) || []).length === 1);
  check('progress shows "Furnishing… n/N"', /'Furnishing… ' \+ done \+ '\/' \+ total/.test(opts));
}

if (failures) {
  console.error(failures + ' failed, ' + passes + ' passed');
  process.exit(1);
}
console.log('ok -- ' + passes + ' passed, 0 failed');
