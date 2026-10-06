/**
 * Previous / next room navigation -- the pure rules.
 *
 * `nextRoom` / `prevRoom` walk the house's room order (home.roomIds, the same
 * order as the Controls list) with wraparound. `roomNavKeyAction` decides what
 * a keydown means: cycle, or leave it alone (so the camera-flight cancel, the
 * edit-mode nudge, a slider or a dialog keep their keys).
 */

/** The room after `id` (wraps). Unknown / null `id`: the first room. Empty list: null. */
export function nextRoom(ids, id) {
  if (!ids || !ids.length) return null;
  const i = ids.indexOf(id);
  return ids[(i + 1) % ids.length];
}

/** The room before `id` (wraps). Unknown / null `id`: the last room. Empty list: null. */
export function prevRoom(ids, id) {
  if (!ids || !ids.length) return null;
  const i = ids.indexOf(id);
  return i < 0 ? ids[ids.length - 1] : ids[(i - 1 + ids.length) % ids.length];
}

/** True for an element that owns the arrow keys (text field, select, slider, textarea, editable). */
export function ownsArrowKeys(t) {
  if (!t) return false;
  const tag = String(t.tagName || '').toUpperCase();
  return tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || !!t.isContentEditable
    || (typeof t.getAttribute === 'function' && ['slider', 'textbox', 'combobox', 'listbox', 'spinbutton'].includes(t.getAttribute('role')));
}

/**
 * What a keydown means for room navigation.
 * @param ctx  { key, target, shiftKey/ctrlKey/altKey/metaKey, selectedRoom, panelView,
 *               editActive, editItemSelected, dialogOpen }
 * @returns 'next' | 'prev' | null
 *
 * Rules: only ArrowRight (next) / ArrowLeft (prev), unmodified; a room must be
 * selected in the room panel (Controls / Settings: nothing happens); a focused
 * input / select / slider / textarea keeps its arrows; an open dialog or card
 * keeps them; in edit mode an item being selected means arrows nudge it.
 */
export function roomNavKeyAction(ctx) {
  const dir = ctx.key === 'ArrowRight' ? 'next' : ctx.key === 'ArrowLeft' ? 'prev' : null;
  if (!dir) return null;
  if (ctx.shiftKey || ctx.ctrlKey || ctx.altKey || ctx.metaKey) return null;
  if (!ctx.selectedRoom) return null;
  if (ownsArrowKeys(ctx.target)) return null;
  if (ctx.dialogOpen) return null;
  if (ctx.editActive && ctx.editItemSelected) return null;
  return dir;
}
