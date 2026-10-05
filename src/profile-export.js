/**
 * profile-export.js -- a draft as the two files to apply to the server.
 *
 * Each document is written in the layout of the SERVED file
 * (src/json-layout.js), so the export of an unedited draft is byte-identical
 * to what is served, and an edit shows up in a diff as only the lines it
 * changed. Takes the served text and the draft's two documents -- never the
 * page config -- and refuses a token-shaped value (src/profile-draft.js).
 * Pure; the download itself is src/edit-mode.js. Tested in
 * scripts/test-profile-draft.mjs.
 */

import { serializePreserving } from './json-layout.js';
import { assertNoSecrets } from './profile-draft.js';

/**
 * @param served  { geometryText, roomsText } -- the served files' text (layout source)
 * @param draft   { geometry, rooms }        -- the documents to write
 * @returns { geometry: string, rooms: string|null }
 */
export function exportProfile(served, draft) {
  const s = served || {};
  assertNoSecrets(draft.geometry, draft.rooms || null);
  return {
    geometry: serializePreserving(s.geometryText, draft.geometry),
    rooms: draft.rooms ? serializePreserving(s.roomsText, draft.rooms) : (s.roomsText != null ? s.roomsText : null),
  };
}
