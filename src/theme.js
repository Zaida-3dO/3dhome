/**
 * Colour theme: Auto (follow the system), Dark or Light, chosen in Settings.
 *
 * The choice is stored in localStorage under THEME_KEY; Auto is the default and
 * is what a missing, unreadable or unknown value means. The RESOLVED theme is
 * written to <html data-theme="dark|light"> and the CSS keys off that; the
 * choice itself is on data-theme-pref. index.html runs the same resolution in
 * an inline <head> script before first paint (so a Light choice never flashes
 * dark); scripts/test-theme.mjs runs that inline script against this module
 * to keep the two in step.
 *
 * color-scheme: dark for Dark; `only light` for Light. `only` is what stops
 * Chrome's auto dark theme (Android) and Samsung Internet's dark web pages from
 * re-darkening a page the user asked to be light. The <meta name="color-scheme">
 * is kept in step for the same reason.
 */

export const THEME_KEY = 'home3d.theme';
export const THEME_PREFS = Object.freeze(['auto', 'dark', 'light']);
export const DEFAULT_PREF = 'auto';
export const DARK_QUERY = '(prefers-color-scheme: dark)';

/** Normalises anything to a known preference. */
export function normalisePref(v) {
  return THEME_PREFS.includes(v) ? v : DEFAULT_PREF;
}

/** The stored preference; storage that throws (private mode, blocked) reads as Auto. */
export function readPref(storage) {
  try { return normalisePref(storage && storage.getItem(THEME_KEY)); } catch (e) { return DEFAULT_PREF; }
}

/** Stores a preference. Auto is stored by removing the key. Returns false if storage refused. */
export function writePref(storage, pref) {
  const p = normalisePref(pref);
  try {
    if (p === DEFAULT_PREF) storage.removeItem(THEME_KEY); else storage.setItem(THEME_KEY, p);
    return true;
  } catch (e) { return false; }
}

/** 'dark' | 'light' for a preference, given whether the system currently prefers dark. */
export function resolveTheme(pref, systemDark) {
  const p = normalisePref(pref);
  if (p === 'auto') return systemDark === false ? 'light' : 'dark';
  return p;
}

/** Whether the system prefers dark; no matchMedia (or it throws) means dark, the app's native look. */
export function systemPrefersDark(win) {
  try { return !(win && typeof win.matchMedia === 'function') || win.matchMedia(DARK_QUERY).matches; } catch (e) { return true; }
}

/** Writes the resolved theme onto the document. Returns the resolved theme. */
export function applyTheme(doc, pref, systemDark) {
  const theme = resolveTheme(pref, systemDark);
  const root = doc.documentElement;
  root.setAttribute('data-theme', theme);
  root.setAttribute('data-theme-pref', normalisePref(pref));
  root.style.colorScheme = theme === 'light' ? 'only light' : 'dark';
  const meta = doc.querySelector && doc.querySelector('meta[name="color-scheme"]');
  if (meta) meta.setAttribute('content', theme === 'light' ? 'only light' : 'dark');
  return theme;
}

/**
 * Follows the system setting live: calls onChange(systemDark) whenever
 * prefers-color-scheme flips. Returns an unsubscribe function. Handles the
 * older addListener API (Safari < 14).
 */
export function watchSystemTheme(win, onChange) {
  let mq;
  try { mq = win.matchMedia(DARK_QUERY); } catch (e) { return () => {}; }
  if (!mq) return () => {};
  const fn = e => onChange(!!e.matches);
  if (typeof mq.addEventListener === 'function') { mq.addEventListener('change', fn); return () => mq.removeEventListener('change', fn); }
  if (typeof mq.addListener === 'function') { mq.addListener(fn); return () => mq.removeListener(fn); }
  return () => {};
}

/**
 * The theme controller index.html uses: applies the stored choice, follows
 * the system while the choice is Auto, and set() changes and stores it.
 */
export function createThemeController(win, doc, storage, onApplied) {
  let pref = readPref(storage);
  const apply = () => { const t = applyTheme(doc, pref, systemPrefersDark(win)); if (onApplied) onApplied(t, pref); return t; };
  apply();
  const stop = watchSystemTheme(win, () => { if (pref === 'auto') apply(); });
  return {
    get pref() { return pref; },
    get theme() { return resolveTheme(pref, systemPrefersDark(win)); },
    set(p) { pref = normalisePref(p); writePref(storage, pref); return apply(); },
    dispose: stop
  };
}
