
// tweaks-panel.jsx
// Reusable Tweaks shell + form-control helpers.
//
// Owns the host protocol (listens for __activate_edit_mode / __deactivate_edit_mode,
// posts __edit_mode_available / __edit_mode_set_keys / __edit_mode_dismissed) so
// individual prototypes don't re-roll it. Ships a consistent set of controls so you
// don't hand-draw <input type="range">, segmented radios, steppers, etc.
//
// Usage (in an HTML file that loads React + Babel):
//
//   const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
//     "primaryColor": "#D97757",
//     "fontSize": 16,
//     "density": "regular",
//     "dark": false
//   }/*EDITMODE-END*/;
//
//   function App() {
//     const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);
//     return (
//       <div style={{ fontSize: t.fontSize, color: t.primaryColor }}>
//         Hello
//         <TweaksPanel>
//           <TweakSection label="Typography" />
//           <TweakSlider label="Font size" value={t.fontSize} min={10} max={32} unit="px"
//                        onChange={(v) => setTweak('fontSize', v)} />
//           <TweakRadio  label="Density" value={t.density}
//                        options={['compact', 'regular', 'comfy']}
//                        onChange={(v) => setTweak('density', v)} />
//           <TweakSection label="Theme" />
//           <TweakColor  label="Primary" value={t.primaryColor}
//                        onChange={(v) => setTweak('primaryColor', v)} />
//           <TweakToggle label="Dark mode" value={t.dark}
//                        onChange={(v) => setTweak('dark', v)} />
//         </TweaksPanel>
//       </div>
//     );
//   }
//
// ─────────────────────────────────────────────────────────────────────────────

const __TWEAKS_STYLE = `
  .twk-panel{position:fixed;right:16px;bottom:16px;z-index:2147483646;width:280px;
    max-height:calc(100vh - 32px);display:flex;flex-direction:column;
    background:rgba(250,249,247,.78);color:#29261b;
    -webkit-backdrop-filter:blur(24px) saturate(160%);backdrop-filter:blur(24px) saturate(160%);
    border:.5px solid rgba(255,255,255,.6);border-radius:14px;
    box-shadow:0 1px 0 rgba(255,255,255,.5) inset,0 12px 40px rgba(0,0,0,.18);
    font:11.5px/1.4 ui-sans-serif,system-ui,-apple-system,sans-serif;overflow:hidden}
  .twk-hd{display:flex;align-items:center;justify-content:space-between;
    padding:10px 8px 10px 14px;cursor:move;user-select:none}
  .twk-hd b{font-size:12px;font-weight:600;letter-spacing:.01em}
  .twk-x{appearance:none;border:0;background:transparent;color:rgba(41,38,27,.55);
    width:22px;height:22px;border-radius:6px;cursor:default;font-size:13px;line-height:1}
  .twk-x:hover{background:rgba(0,0,0,.06);color:#29261b}
  .twk-hd-btns{display:flex;gap:2px}
  /* Phone: dock full-width along the bottom, capped at 45% of the viewport so
     the page above stays usable; the header's collapse button folds it to a
     strip. !important beats the inline right/bottom the drag logic writes. */
  @media (max-width:760px){
    .twk-panel{left:8px !important;right:8px !important;bottom:8px !important;
      width:auto;max-height:45vh}
  }
  .twk-body{padding:2px 14px 14px;display:flex;flex-direction:column;gap:10px;
    overflow-y:auto;overflow-x:hidden;min-height:0;
    scrollbar-width:thin;scrollbar-color:rgba(0,0,0,.15) transparent}
  .twk-body::-webkit-scrollbar{width:8px}
  .twk-body::-webkit-scrollbar-track{background:transparent;margin:2px}
  .twk-body::-webkit-scrollbar-thumb{background:rgba(0,0,0,.15);border-radius:4px;
    border:2px solid transparent;background-clip:content-box}
  .twk-body::-webkit-scrollbar-thumb:hover{background:rgba(0,0,0,.25);
    border:2px solid transparent;background-clip:content-box}
  .twk-row{display:flex;flex-direction:column;gap:5px}
  .twk-row-h{flex-direction:row;align-items:center;justify-content:space-between;gap:10px}
  .twk-lbl{display:flex;justify-content:space-between;align-items:baseline;
    color:rgba(41,38,27,.72)}
  .twk-lbl>span:first-child{font-weight:500}
  .twk-val{color:rgba(41,38,27,.5);font-variant-numeric:tabular-nums}

  .twk-sect{font-size:10px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;
    color:rgba(41,38,27,.45);padding:10px 0 0}
  .twk-sect:first-child{padding-top:0}

  .twk-field{appearance:none;width:100%;height:26px;padding:0 8px;
    border:.5px solid rgba(0,0,0,.1);border-radius:7px;
    background:rgba(255,255,255,.6);color:inherit;font:inherit;outline:none}
  .twk-field:focus{border-color:rgba(0,0,0,.25);background:rgba(255,255,255,.85)}
  select.twk-field{padding-right:22px;
    background-image:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'><path fill='rgba(0,0,0,.5)' d='M0 0h10L5 6z'/></svg>");
    background-repeat:no-repeat;background-position:right 8px center}

  .twk-slider{appearance:none;-webkit-appearance:none;width:100%;height:4px;margin:6px 0;
    border-radius:999px;background:rgba(0,0,0,.12);outline:none}
  .twk-slider::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;
    width:14px;height:14px;border-radius:50%;background:#fff;
    border:.5px solid rgba(0,0,0,.12);box-shadow:0 1px 3px rgba(0,0,0,.2);cursor:default}
  .twk-slider::-moz-range-thumb{width:14px;height:14px;border-radius:50%;
    background:#fff;border:.5px solid rgba(0,0,0,.12);box-shadow:0 1px 3px rgba(0,0,0,.2);cursor:default}

  .twk-seg{position:relative;display:flex;padding:2px;border-radius:8px;
    background:rgba(0,0,0,.06);user-select:none}
  .twk-seg-thumb{position:absolute;top:2px;bottom:2px;border-radius:6px;
    background:rgba(255,255,255,.9);box-shadow:0 1px 2px rgba(0,0,0,.12);
    transition:left .15s cubic-bezier(.3,.7,.4,1),width .15s}
  .twk-seg.dragging .twk-seg-thumb{transition:none}
  .twk-seg button{appearance:none;position:relative;z-index:1;flex:1;border:0;
    background:transparent;color:inherit;font:inherit;font-weight:500;min-height:22px;
    border-radius:6px;cursor:default;padding:4px 6px;line-height:1.2;
    overflow-wrap:anywhere}

  .twk-toggle{position:relative;width:32px;height:18px;border:0;border-radius:999px;
    background:rgba(0,0,0,.15);transition:background .15s;cursor:default;padding:0}
  .twk-toggle[data-on="1"]{background:#34c759}
  .twk-toggle i{position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;
    background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.25);transition:transform .15s}
  .twk-toggle[data-on="1"] i{transform:translateX(14px)}

  .twk-num{display:flex;align-items:center;height:26px;padding:0 0 0 8px;
    border:.5px solid rgba(0,0,0,.1);border-radius:7px;background:rgba(255,255,255,.6)}
  .twk-num-lbl{font-weight:500;color:rgba(41,38,27,.6);cursor:ew-resize;
    user-select:none;padding-right:8px}
  .twk-num input{flex:1;min-width:0;height:100%;border:0;background:transparent;
    font:inherit;font-variant-numeric:tabular-nums;text-align:right;padding:0 8px 0 0;
    outline:none;color:inherit;-moz-appearance:textfield}
  .twk-num input::-webkit-inner-spin-button,.twk-num input::-webkit-outer-spin-button{
    -webkit-appearance:none;margin:0}
  .twk-num-unit{padding-right:8px;color:rgba(41,38,27,.45)}

  .twk-btn{appearance:none;height:26px;padding:0 12px;border:0;border-radius:7px;
    background:rgba(0,0,0,.78);color:#fff;font:inherit;font-weight:500;cursor:default}
  .twk-btn:hover{background:rgba(0,0,0,.88)}
  .twk-btn.secondary{background:rgba(0,0,0,.06);color:inherit}
  .twk-btn.secondary:hover{background:rgba(0,0,0,.1)}

  .twk-swatch{appearance:none;-webkit-appearance:none;width:56px;height:22px;
    border:.5px solid rgba(0,0,0,.1);border-radius:6px;padding:0;cursor:default;
    background:transparent;flex-shrink:0}
  .twk-swatch::-webkit-color-swatch-wrapper{padding:0}
  .twk-swatch::-webkit-color-swatch{border:0;border-radius:5.5px}
  .twk-swatch::-moz-color-swatch{border:0;border-radius:5.5px}
`;

// ── useTweaks ───────────────────────────────────────────────────────────────
// Single source of truth for tweak values. setTweak persists via the host
// (__edit_mode_set_keys → host rewrites the EDITMODE block on disk).
function useTweaks(defaults) {
  const [values, setValues] = React.useState(defaults);
  // Accepts either setTweak('key', value) or setTweak({ key: value, ... }) so a
  // useState-style call doesn't write a "[object Object]" key into the persisted
  // JSON block.
  const setTweak = React.useCallback((keyOrEdits, val) => {
    const edits = typeof keyOrEdits === 'object' && keyOrEdits !== null
      ? keyOrEdits : { [keyOrEdits]: val };
    setValues((prev) => ({ ...prev, ...edits }));
    window.parent.postMessage({ type: '__edit_mode_set_keys', edits }, '*');
  }, []);
  return [values, setTweak];
}

// ── TweaksPanel ─────────────────────────────────────────────────────────────
// Floating shell. Registers the protocol listener BEFORE announcing
// availability — if the announce ran first, the host's activate could land
// before our handler exists and the toolbar toggle would silently no-op.
// The close button posts __edit_mode_dismissed so the host's toolbar toggle
// flips off in lockstep; the host echoes __deactivate_edit_mode back which
// is what actually hides the panel.
// Edit mode is a property of the PAGE, not of one panel instance. A spec page
// that switches objects (SpecPage, below) unmounts one object's panel and
// mounts the next one's; the activate message arrived once, at load, so a
// panel that only listened for it would mount closed and stay closed. This
// module-level flag -- kept by a listener installed at load, whether or not
// any panel is mounted -- is what a newly mounted panel starts from.
let __twkEditModeActive = false;
window.addEventListener('message', (e) => {
  const t = e && e.data && e.data.type;
  if (t === '__activate_edit_mode') __twkEditModeActive = true;
  else if (t === '__deactivate_edit_mode') __twkEditModeActive = false;
});

function TweaksPanel({ title = 'Tweaks', children }) {
  const [open, setOpen] = React.useState(__twkEditModeActive);
  // Collapsed = header only. Mostly for a phone, where the docked panel
  // otherwise covers the page (see the max-width:760px rule in the styles).
  const [collapsed, setCollapsed] = React.useState(false);
  const dragRef = React.useRef(null);
  const offsetRef = React.useRef({ x: 16, y: 16 });
  const PAD = 16;

  const clampToViewport = React.useCallback(() => {
    const panel = dragRef.current;
    if (!panel) return;
    const w = panel.offsetWidth, h = panel.offsetHeight;
    const maxRight = Math.max(PAD, window.innerWidth - w - PAD);
    const maxBottom = Math.max(PAD, window.innerHeight - h - PAD);
    offsetRef.current = {
      x: Math.min(maxRight, Math.max(PAD, offsetRef.current.x)),
      y: Math.min(maxBottom, Math.max(PAD, offsetRef.current.y)),
    };
    panel.style.right = offsetRef.current.x + 'px';
    panel.style.bottom = offsetRef.current.y + 'px';
  }, []);

  React.useEffect(() => {
    if (!open) return;
    clampToViewport();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', clampToViewport);
      return () => window.removeEventListener('resize', clampToViewport);
    }
    const ro = new ResizeObserver(clampToViewport);
    ro.observe(document.documentElement);
    return () => ro.disconnect();
  }, [open, clampToViewport]);

  React.useEffect(() => {
    const onMsg = (e) => {
      const t = e?.data?.type;
      if (t === '__activate_edit_mode') setOpen(true);
      else if (t === '__deactivate_edit_mode') setOpen(false);
    };
    window.addEventListener('message', onMsg);
    window.parent.postMessage({ type: '__edit_mode_available' }, '*');
    return () => window.removeEventListener('message', onMsg);
  }, []);

  const dismiss = () => {
    __twkEditModeActive = false;
    setOpen(false);
    window.parent.postMessage({ type: '__edit_mode_dismissed' }, '*');
  };

  const onDragStart = (e) => {
    const panel = dragRef.current;
    if (!panel) return;
    const r = panel.getBoundingClientRect();
    const sx = e.clientX, sy = e.clientY;
    const startRight = window.innerWidth - r.right;
    const startBottom = window.innerHeight - r.bottom;
    const move = (ev) => {
      offsetRef.current = {
        x: startRight - (ev.clientX - sx),
        y: startBottom - (ev.clientY - sy),
      };
      clampToViewport();
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  if (!open) return null;
  return (
    <>
      <style>{__TWEAKS_STYLE}</style>
      <div ref={dragRef} className="twk-panel"
           style={{ right: offsetRef.current.x, bottom: offsetRef.current.y }}>
        <div className="twk-hd" onMouseDown={onDragStart}>
          <b>{title}</b>
          <span className="twk-hd-btns">
          <button className="twk-x" aria-label={collapsed ? 'Expand tweaks' : 'Collapse tweaks'}
                  aria-expanded={!collapsed}
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={() => setCollapsed(c => !c)}>{collapsed ? '\u25B4' : '\u25BE'}</button>
          <button className="twk-x" aria-label="Close tweaks"
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={dismiss}>{'\u2715'}</button>
          </span>
        </div>
        {!collapsed && <div className="twk-body">{children}</div>}
      </div>
    </>
  );
}

// ── Layout helpers ──────────────────────────────────────────────────────────

function TweakSection({ label, children }) {
  return (
    <>
      <div className="twk-sect">{label}</div>
      {children}
    </>
  );
}

function TweakRow({ label, value, children, inline = false }) {
  return (
    <div className={inline ? 'twk-row twk-row-h' : 'twk-row'}>
      <div className="twk-lbl">
        <span>{label}</span>
        {value != null && <span className="twk-val">{value}</span>}
      </div>
      {children}
    </div>
  );
}

// ── Controls ────────────────────────────────────────────────────────────────

function TweakSlider({ label, value, min = 0, max = 100, step = 1, unit = '', onChange }) {
  return (
    <TweakRow label={label} value={`${value}${unit}`}>
      <input type="range" className="twk-slider" min={min} max={max} step={step}
             value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </TweakRow>
  );
}

function TweakToggle({ label, value, onChange }) {
  return (
    <div className="twk-row twk-row-h">
      <div className="twk-lbl"><span>{label}</span></div>
      <button type="button" className="twk-toggle" data-on={value ? '1' : '0'}
              role="switch" aria-checked={!!value}
              onClick={() => onChange(!value)}><i /></button>
    </div>
  );
}

function TweakRadio({ label, value, options, onChange }) {
  const trackRef = React.useRef(null);
  const [dragging, setDragging] = React.useState(false);
  const opts = options.map((o) => (typeof o === 'object' ? o : { value: o, label: o }));
  const idx = Math.max(0, opts.findIndex((o) => o.value === value));
  const n = opts.length;

  // The active value is read by pointer-move handlers attached for the lifetime
  // of a drag — ref it so a stale closure doesn't fire onChange for every move.
  const valueRef = React.useRef(value);
  valueRef.current = value;

  const segAt = (clientX) => {
    const r = trackRef.current.getBoundingClientRect();
    const inner = r.width - 4;
    const i = Math.floor(((clientX - r.left - 2) / inner) * n);
    return opts[Math.max(0, Math.min(n - 1, i))].value;
  };

  const onPointerDown = (e) => {
    setDragging(true);
    const v0 = segAt(e.clientX);
    if (v0 !== valueRef.current) onChange(v0);
    const move = (ev) => {
      if (!trackRef.current) return;
      const v = segAt(ev.clientX);
      if (v !== valueRef.current) onChange(v);
    };
    const up = () => {
      setDragging(false);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <TweakRow label={label}>
      <div ref={trackRef} role="radiogroup" onPointerDown={onPointerDown}
           className={dragging ? 'twk-seg dragging' : 'twk-seg'}>
        <div className="twk-seg-thumb"
             style={{ left: `calc(2px + ${idx} * (100% - 4px) / ${n})`,
                      width: `calc((100% - 4px) / ${n})` }} />
        {opts.map((o) => (
          <button key={o.value} type="button" role="radio" aria-checked={o.value === value}>
            {o.label}
          </button>
        ))}
      </div>
    </TweakRow>
  );
}

function TweakSelect({ label, value, options, onChange }) {
  return (
    <TweakRow label={label}>
      <select className="twk-field" value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => {
          const v = typeof o === 'object' ? o.value : o;
          const l = typeof o === 'object' ? o.label : o;
          return <option key={v} value={v}>{l}</option>;
        })}
      </select>
    </TweakRow>
  );
}

function TweakText({ label, value, placeholder, onChange }) {
  return (
    <TweakRow label={label}>
      <input className="twk-field" type="text" value={value} placeholder={placeholder}
             onChange={(e) => onChange(e.target.value)} />
    </TweakRow>
  );
}

function TweakNumber({ label, value, min, max, step = 1, unit = '', onChange }) {
  const clamp = (n) => {
    if (min != null && n < min) return min;
    if (max != null && n > max) return max;
    return n;
  };
  const startRef = React.useRef({ x: 0, val: 0 });
  const onScrubStart = (e) => {
    e.preventDefault();
    startRef.current = { x: e.clientX, val: value };
    const decimals = (String(step).split('.')[1] || '').length;
    const move = (ev) => {
      const dx = ev.clientX - startRef.current.x;
      const raw = startRef.current.val + dx * step;
      const snapped = Math.round(raw / step) * step;
      onChange(clamp(Number(snapped.toFixed(decimals))));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return (
    <div className="twk-num">
      <span className="twk-num-lbl" onPointerDown={onScrubStart}>{label}</span>
      <input type="number" value={value} min={min} max={max} step={step}
             onChange={(e) => onChange(clamp(Number(e.target.value)))} />
      {unit && <span className="twk-num-unit">{unit}</span>}
    </div>
  );
}

function TweakColor({ label, value, onChange }) {
  return (
    <div className="twk-row twk-row-h">
      <div className="twk-lbl"><span>{label}</span></div>
      <input type="color" className="twk-swatch" value={value}
             onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

function TweakButton({ label, onClick, secondary = false }) {
  return (
    <button type="button" className={secondary ? 'twk-btn secondary' : 'twk-btn'}
            onClick={onClick}>{label}</button>
  );
}

// ── Spec picker: ONE way to pick objects, ONE way to pick variants ─────────
//
// Every spec page renders exactly one <SpecPage>. The vocabulary:
//
//   OBJECT   a different thing: a different builder type, a different set of
//            controls, or a different noun (a wardrobe vs a chest of drawers,
//            a bed vs an ottoman).
//   VARIANT  the same object with different values on its own controls (a red
//            chair vs a blue chair) -- a named preset of that object.
//
// Which objects a page holds is declared ONCE, in the page, as JSON:
//
//   <script type="application/json" id="spec-manifest">
//   { "title": "Beds & Sofas", "description": "...",
//     "objects": [ { "id": "bed", "label": "Bed", "types": ["bed"] }, ... ] }
//   </script>
//
// SpecPage reads it for the title and the OBJECT row, and
// scripts/test-spec-pages.mjs reads the same JSON to check every registry type
// has exactly one page. `types` lists the furniture registry types the object
// signs off ([] for a fixture that is not furniture, e.g. a door).
//
// Two ways to use SpecPage:
//
//   Remount mode -- each object is its own component; switching remounts it
//   (fresh 3D view, fresh Tweaks panel):
//     <SpecPage render={{ bed: () => <BedObject/>, ottoman: () => <OttomanObject/> }} />
//
//   Controlled mode -- one component whose state spans the objects:
//     <SpecPage objectId={t.itemType} onObject={id => setTweak('itemType', id)}>
//       ...the page...
//     </SpecPage>
//
//   Single-object page -- neither prop; the children are the object:
//     <SpecPage> ...the page... </SpecPage>
//
// An object with presets renders <SpecVariants> ANYWHERE inside itself; it is
// portalled into the picker bar, under the OBJECT row, so the VARIANT row sits
// in the same place on every page. The active variant is DERIVED from the
// current values (specActiveVariantId), never stored, so moving a slider off
// every preset lights "Custom" rather than leaving a stale preset highlighted.
//
// Layout (identical on every page): h1, description, then a sticky picker bar
// -- OBJECT row (only when there is more than one object), VARIANT row (only
// when the active object has variants). Sliders and colours live in the
// Tweaks panel and belong to the active object only; nothing in the Tweaks
// panel switches objects or variants. At <=760px each row is one line that
// scrolls sideways, with the active chip kept in view.
//
// URLs: ?object=<id>&variant=<id> deep-links a page; the picker keeps both in
// the address bar (history.replaceState) as you switch. An unknown id falls
// back to the default with a console warning. `moved` maps an object id that
// now lives on another page to that page, and redirects there.

/* SPEC-PICKER-CORE-BEGIN -- plain JS, no JSX: scripts/test-spec-pages.mjs
   extracts this block and runs it in Node. */

// Canonical form for comparing values: object keys sorted, and '#RRGGBB'
// colours lower-cased (an <input type=color> reports lower case; a preset
// table may not).
function specCanon(v) {
  if (Array.isArray(v)) return v.map(specCanon);
  if (v && typeof v === 'object') {
    const out = {};
    Object.keys(v).sort().forEach(k => { if (v[k] !== undefined) out[k] = specCanon(v[k]); });
    return out;
  }
  if (typeof v === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(v)) return v.toLowerCase();
  return v;
}
function specSame(a, b) {
  return JSON.stringify(specCanon(a)) === JSON.stringify(specCanon(b));
}

// The ids of the variants the current `values` ARE; [] means "Custom".
// A variant matches when every key in its `params` equals (deeply) the same
// key in `values`. Pass FULLY RESOLVED params (defaults + preset), never a
// bare delta: an empty `{}` would match every state, so it never matches.
// When several match -- one preset's params a subset of another's -- the ones
// with the MOST keys win, so the most specific preset is the one lit. Two
// presets whose values are identical both light: they ARE the same values.
function specActiveVariantIds(variants, values) {
  let best = [], bestKeys = 0;
  (variants || []).forEach(v => {
    const p = v.params || {};
    const keys = Object.keys(p);
    if (!keys.length) return;
    if (!keys.every(k => specSame(p[k], values ? values[k] : undefined))) return;
    if (keys.length > bestKeys) { best = [v.id]; bestKeys = keys.length; }
    else if (keys.length === bestKeys) best.push(v.id);
  });
  return best;
}
// The first of those, or null ("Custom").
function specActiveVariantId(variants, values) {
  const ids = specActiveVariantIds(variants, values);
  return ids.length ? ids[0] : null;
}

// Which object to show, given the manifest's ids, the URL query string, the
// page's default and its `moved` map. Returns { objectId, redirect, warning }.
// `redirect` (a URL) is set when the asked-for object now lives on another
// page; `warning` when the query named an object this page does not have.
function specResolveObject(ids, search, fallbackId, moved) {
  const q = new URLSearchParams(search || '');
  const asked = q.get('object');
  const dflt = ids.indexOf(fallbackId) >= 0 ? fallbackId : ids[0];
  if (!asked) return { objectId: dflt, redirect: null, warning: null };
  if (ids.indexOf(asked) >= 0) return { objectId: asked, redirect: null, warning: null };
  if (moved && Object.prototype.hasOwnProperty.call(moved, asked)) {
    q.set('object', asked);
    return { objectId: dflt, redirect: moved[asked] + '?' + q.toString(), warning: null };
  }
  return { objectId: dflt, redirect: null, warning: 'no object "' + asked + '" on this page; showing "' + dflt + '"' };
}

// `search` with the given keys set (a string value) or removed (null),
// leaving every other parameter exactly as it was. Returns '' or '?...'.
function specSearchWith(search, patch) {
  const q = new URLSearchParams(search || '');
  Object.keys(patch).forEach(k => {
    if (patch[k] === null || patch[k] === undefined) q.delete(k);
    else q.set(k, patch[k]);
  });
  // Other params first, in their order; then object, then variant, whatever
  // order they were set in -- reads as "which thing, which version of it".
  const ordered = new URLSearchParams();
  q.forEach((v, k) => { if (k !== 'object' && k !== 'variant') ordered.append(k, v); });
  if (q.has('object')) ordered.set('object', q.get('object'));
  if (q.has('variant')) ordered.set('variant', q.get('variant'));
  const s = ordered.toString();
  return s ? '?' + s : '';
}

/* SPEC-PICKER-CORE-END */

const __SPEC_PICKER_STYLE = `
  .spec-picker{position:sticky;top:0;z-index:50;background:#f4f1ec;
    margin:0 0 20px;padding:8px 0;border-bottom:1px solid #d8d3c8}
  /* a page with one object and no variants has nothing to pick: no bar */
  .spec-picker:not(:has(.spec-row)){display:none}
  .spec-row{display:flex;align-items:baseline;gap:10px;padding:3px 0}
  .spec-row-label{flex:none;width:64px;font-size:9.5px;font-weight:600;letter-spacing:.08em;
    text-transform:uppercase;opacity:.55}
  .spec-chips{display:flex;flex-wrap:wrap;gap:6px;min-width:0}
  .spec-chip{font:inherit;cursor:pointer;white-space:nowrap;border-radius:14px;
    border:1px solid #d8d3c8;color:#1a1a1a}
  .spec-chip-object{padding:6px 12px;font-size:11px;background:#efeae0}
  .spec-chip-object:hover{background:#e2dccd}
  .spec-chip-object.active{background:#1a1a1c;color:#fff;border-color:#1a1a1c}
  .spec-chip-variant{padding:4px 10px;font-size:10px;background:#fff}
  .spec-chip-variant:hover{background:#f4f1ec}
  .spec-chip-variant.active{background:#6b5d4a;color:#fff;border-color:#6b5d4a}
  .spec-chip-custom{padding:4px 10px;font-size:10px;background:transparent;
    border-style:dashed;cursor:default;opacity:.45}
  .spec-chip-custom.active{opacity:1;border-color:#6b5d4a;color:#6b5d4a;font-weight:600}
  .spec-chip:focus-visible{outline:2px solid #6b5d4a;outline-offset:1px}
  /* One phone layout for every spec page (several pages had none, and laid
     two 180px columns side by side at 390px): cards stack, the 3D view
     shrinks, the page margin tightens. */
  @media (max-width:760px){
    body{padding:12px}
    .grid{grid-template-columns:1fr !important}
    #c3d{height:420px}
    .spec-row{flex-direction:column;align-items:stretch;gap:3px}
    .spec-row-label{width:auto}
    .spec-chips{flex-wrap:nowrap;overflow-x:auto;scrollbar-width:none;
      -webkit-overflow-scrolling:touch;padding-bottom:2px}
    .spec-chips::-webkit-scrollbar{display:none}
  }
`;

function readSpecManifest() {
  const el = document.getElementById('spec-manifest');
  if (!el) throw new Error('spec page has no <script type="application/json" id="spec-manifest">');
  return JSON.parse(el.textContent);
}

// Keep the active chip of a sideways-scrolling row in view (phone layout).
function useSpecKeepActiveInView(ref, activeKey) {
  React.useEffect(() => {
    const row = ref.current;
    if (!row) return;
    const chip = row.querySelector('.active');
    if (!chip) return;
    const l = chip.offsetLeft - row.offsetLeft, r = l + chip.offsetWidth;
    if (l < row.scrollLeft) row.scrollLeft = Math.max(0, l - 12);
    else if (r > row.scrollLeft + row.clientWidth) row.scrollLeft = r - row.clientWidth + 12;
  }, [activeKey]);
}

function SpecChipRow({ kind, label, items, activeId, activeIds, onPick, custom }) {
  const ref = React.useRef(null);
  useSpecKeepActiveInView(ref, activeId);
  const on = id => (activeIds ? activeIds.includes(id) : id === activeId);
  const cls = kind === 'object' ? 'spec-chip spec-chip-object' : 'spec-chip spec-chip-variant';
  return (
    <div className="spec-row" data-spec-row={kind}>
      <span className="spec-row-label">{label}</span>
      <div ref={ref} className="spec-chips" role="radiogroup" aria-label={label}>
        {items.map(it => (
          <button key={it.id} type="button" role="radio" aria-checked={on(it.id)}
            className={cls + (on(it.id) ? ' active' : '')}
            data-spec-object={kind === 'object' ? it.id : undefined}
            data-spec-variant={kind === 'variant' ? it.id : undefined}
            onClick={() => onPick(it.id)}>{it.label}</button>
        ))}
        {custom && (
          <span className={'spec-chip spec-chip-custom' + (activeId == null ? ' active' : '')}
            role="radio" aria-checked={activeId == null} aria-disabled="true"
            data-spec-variant="custom"
            title="Your values match none of the named variants">Custom</span>
        )}
      </div>
    </div>
  );
}

const SpecPageContext = React.createContext(null);

// A variant id asked for in the URL is applied ONCE per page load, by the
// first SpecVariants that mounts after the URL's object has been shown.
let __specUrlVariantPending = new URLSearchParams(window.location.search).get('variant');

function specReplaceSearch(patch) {
  const next = specSearchWith(window.location.search, patch);
  if (next !== window.location.search) {
    window.history.replaceState(window.history.state, '', window.location.pathname + next + window.location.hash);
  }
}

function SpecPage({ render, objectId, onObject, moved, children }) {
  const manifest = React.useMemo(readSpecManifest, []);
  const objects = manifest.objects || [];
  const ids = objects.map(o => o.id);
  const controlled = typeof onObject === 'function';
  const single = !controlled && !render;
  if (single && objects.length !== 1) console.error('[spec] a SpecPage with no render map and no onObject must declare exactly one object');

  // Resolve the URL's ?object= once, on first render.
  const initial = React.useMemo(() => {
    const r = specResolveObject(ids, window.location.search, controlled ? objectId : ids[0], moved);
    if (r.warning) console.warn('[spec] ' + r.warning);
    return r;
  }, []);
  const [ownId, setOwnId] = React.useState(initial.objectId);
  const activeId = controlled ? objectId : ownId;
  // Controlled mode: the page's own state starts at ITS default; bring it to
  // the URL's object before rendering it, so a ?variant= is never applied to
  // the wrong object.
  const [synced, setSynced] = React.useState(!controlled || initial.objectId === objectId);
  React.useLayoutEffect(() => {
    if (initial.redirect) { window.location.replace(initial.redirect); return; }
    if (!synced) { onObject(initial.objectId); setSynced(true); }
  }, []);

  const [slot, setSlot] = React.useState(null);

  React.useEffect(() => {
    document.title = manifest.title + ' — Spec';
  }, []);
  React.useEffect(() => {
    if (!synced) return;
    specReplaceSearch({ object: ids.length > 1 ? activeId : null });
  }, [activeId, synced]);

  const pick = (id) => {
    if (id === activeId) return;
    __specUrlVariantPending = null;
    specReplaceSearch({ variant: null });
    if (controlled) onObject(id); else setOwnId(id);
  };

  if (initial.redirect) return <div className="sub">This object has moved: <a href={initial.redirect}>{initial.redirect}</a></div>;

  let body = null;
  if (synced) {
    if (controlled || single) body = children;
    else {
      const fn = render && render[activeId];
      if (!fn) {
        console.error('[spec] manifest object "' + activeId + '" has no renderer');
        body = <div className="sub">No renderer for "{activeId}".</div>;
      } else body = <React.Fragment key={activeId}>{fn()}</React.Fragment>;
    }
  }

  return (
    <SpecPageContext.Provider value={{ slot, objectId: activeId }}>
      <style>{__SPEC_PICKER_STYLE}</style>
      <h1>{manifest.title}</h1>
      {manifest.description && <div className="sub">{manifest.description}</div>}
      <div className="spec-picker" data-spec-picker="">
        {objects.length > 1 &&
          <SpecChipRow kind="object" label="Object" items={objects} activeId={activeId} onPick={pick} />}
        <div ref={setSlot} data-spec-variant-slot="" />
      </div>
      {body}
    </SpecPageContext.Provider>
  );
}

// variants: [{ id, label, params }], params FULLY RESOLVED (see
// specActiveVariantId). values: the object's current values. onSelect(id):
// apply that variant's values. Renders into the picker bar's VARIANT slot.
function SpecVariants({ variants, values, onSelect }) {
  const ctx = React.useContext(SpecPageContext);
  const activeIds = specActiveVariantIds(variants, values);
  // Two presets can resolve to the very same values. Both match, but the chip
  // you picked is the one that lights (and goes in the URL); with no pick
  // among them, the first does.
  const picked = React.useRef(null);
  const activeId = activeIds.includes(picked.current) ? picked.current : (activeIds.length ? activeIds[0] : null);
  const pick = (id) => { picked.current = id; onSelect(id); };

  React.useEffect(() => {
    const asked = __specUrlVariantPending;
    if (asked == null) return;
    __specUrlVariantPending = null;
    if (variants.some(v => v.id === asked)) { picked.current = asked; if (asked !== activeId) onSelect(asked); }
    else console.warn('[spec] no variant "' + asked + '" for this object');
  }, []);
  React.useEffect(() => {
    if (__specUrlVariantPending != null) return;
    specReplaceSearch({ variant: activeId });
  }, [activeId, ctx && ctx.objectId]);

  const row = <SpecChipRow kind="variant" label="Variant" items={variants} activeId={activeId}
    onPick={pick} custom={true} />;
  if (ctx && ctx.slot) return ReactDOM.createPortal(row, ctx.slot);
  if (ctx) return null; // slot not attached yet: the next render portals it
  return row;          // no SpecPage (should not happen): render in place
}

Object.assign(window, {
  useTweaks, TweaksPanel, TweakSection, TweakRow,
  TweakSlider, TweakToggle, TweakRadio, TweakSelect,
  TweakText, TweakNumber, TweakColor, TweakButton,
  SpecPage, SpecVariants, readSpecManifest,
  specActiveVariantId, specActiveVariantIds, specResolveObject, specSearchWith, specSame,
});
