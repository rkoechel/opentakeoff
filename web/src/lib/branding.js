// Branding mode — how a deliverable presents itself. Two modes:
//   • "default"    — OpenTakeoff-branded, exactly as the parent repo ships. This
//                    is the code default (unset ⇒ default), so an upstream clone
//                    is unchanged.
//   • "clearlabel" — a saved trade-name profile brands the document as the firm
//                    presenting it; OpenTakeoff keeps a subtle plain-text credit
//                    ("Measured with OpenTakeoff"), so the parent is still credited.
//
// resolveBranding() is PURE — given the per-project selection + the global
// profiles list it tells every render point (report masthead, marked-set cover,
// the CSV/MD export titles) what to show. Storage is a separate, swappable edge:
// the selection lives in the per-project meta KV, keyed on the project id so it
// degrades to a single global setting in the browser-only build (folderId "").
import { metaGet, metaPut } from "./store.js";
import { activeProfile } from "./identity.js";

export const OT_NAME = "OpenTakeoff";
export const OT_CREDIT = "Measured with OpenTakeoff";
// The line every estimate and bid proposal carries when the watermark is on.
// Clear-label puts the firm's name on the document; it does not draw this by
// itself. The flag defaults off (see watermarkEnabled).
export const OT_WATERMARK = "Prepared with OpenTakeoff · opentakeoff.kentucky-ai.com";

/** "1" or "true" only. Anything else, including unset, is off. */
function flagOn(value) {
  return value === "1" || value === "true";
}

/**
 * Document watermark. Off by default.
 * Web: build-time `VITE_OT_WATERMARK` (vite.config.js inlines it; this fork's
 * envPrefix does not expose VITE_* on its own).
 * MCP and the node tests: `OT_WATERMARK`, or `VITE_OT_WATERMARK` in the process
 * environment. The browser bundle has no `process`, so a shell variable cannot
 * turn a built page on after the fact.
 */
export function watermarkEnabled() {
  let vite;
  try {
    if (typeof import.meta !== "undefined" && import.meta.env != null) {
      vite = import.meta.env.VITE_OT_WATERMARK;
    }
  } catch {
    vite = undefined;
  }
  if (flagOn(vite)) return true;
  // Node (MCP, the test runner). The browser bundle has no process global.
  const proc = globalThis["process"];
  if (proc == null || proc.env == null) return false;
  return flagOn(proc.env.VITE_OT_WATERMARK) || flagOn(proc.env.OT_WATERMARK);
}

/**
 * Closing rows for an estimate workbook tab. Empty when the flag is off, so
 * the sheet contains no "Prepared with OpenTakeoff" footer.
 * `web/src/lib/estimateExport.js` uses this instead of `[[], [OT_WATERMARK]]`.
 * @returns {any[][]}
 */
export function xlsxWatermarkFooter() {
  return watermarkEnabled() ? [[], [OT_WATERMARK]] : [];
}

/**
 * @param {{mode?: string, profileId?: string|null,
 *   profiles?: Array<{id:string,name?:string,address?:string,logo?:string}>}} [sel]
 * @returns {{clear:boolean, company:{name?:string,address?:string,logo?:string}|null,
 *   brandName:string, credit:string|null, coverTitle:string}}
 */
export function resolveBranding(sel) {
  const profiles = sel?.profiles || [];
  // clear-label only takes effect when a real profile resolves — no profiles, a
  // stale id with none left, or mode off all fall back to OpenTakeoff. A stale
  // id with other profiles present rides the first one. activeProfile() is the
  // ONE place that fallback rule lives (shared with the modal chip highlight) so
  // the deliverable and the UI can never disagree on which profile is selected.
  const profile = sel?.mode === "clearlabel"
    ? activeProfile({ profiles, activeId: sel?.profileId })
    : null;
  const clear = Boolean(profile);
  // documents trim. A profile still being typed can hold a trailing space;
  // the masthead, cover, and export title must not.
  const name = clear && typeof profile.name === "string" ? profile.name.trim() : "";
  const address = clear && typeof profile.address === "string" ? profile.address.trim() : "";
  return {
    clear,
    // full identity for the masthead firm block + cover identity column; null in
    // default mode so every `company?.x` guard degrades to the OpenTakeoff path.
    // a blank-after-trim name or address is omitted, same as the saved company.
    company: clear ? { name: name || undefined, address: address || undefined, logo: profile.logo } : null,
    // firm text / "Prepared by" cell / export title tag — the trade name when
    // clear-labelling (a logo-only profile has no name → keep OpenTakeoff)
    brandName: (clear && name) ? name : OT_NAME,
    // subtle parent credit — shown only when clear-labelling (default mode is
    // already OpenTakeoff-branded throughout, so a separate credit is redundant)
    credit: clear ? OT_CREDIT : null,
    // marked-set cover wordmark — carries the OpenTakeoff prefix in default mode
    coverTitle: clear ? "Marked Set" : "OpenTakeoff · Marked Set",
  };
}

// ── per-project persistence (browser-only; the meta KV is IndexedDB) ──────────
// Keyed on the project id so cloud/Drive projects each remember their own
// branding; the anonymous browser-only store threads id "" and lands on one key
// — i.e. a single global setting, which is exactly right there.
const selKey = (projectId) => `branding:${projectId || ""}`;

// Both swallow IndexedDB failures (stale-tab VersionError, private mode, quota)
// and degrade — the same resilience loadCompany/saveCompany apply — so a blocked
// DB can never surface as an unhandled rejection at a fire-and-forget call site.
/** @param {string} [projectId] @returns {Promise<{mode:string, profileId:string|null}>} */
export async function loadBrandingSelection(projectId) {
  try {
    const v = await metaGet(selKey(projectId));
    if (v && typeof v === "object") {
      return { mode: v.mode === "clearlabel" ? "clearlabel" : "default", profileId: v.profileId ?? null };
    }
  } catch {
    /* DB blocked/unavailable — fall through to the default (OpenTakeoff) */
  }
  return { mode: "default", profileId: null };
}

/** @param {string} projectId @param {{mode?:string, profileId?:string|null}} sel @returns {Promise<boolean>} saved ok */
export async function saveBrandingSelection(projectId, sel) {
  try {
    await metaPut(selKey(projectId), {
      mode: sel?.mode === "clearlabel" ? "clearlabel" : "default",
      profileId: sel?.profileId ?? null,
    });
    return true;
  } catch {
    return false; // quota / private mode / stale tab — caller decides what to do
  }
}
