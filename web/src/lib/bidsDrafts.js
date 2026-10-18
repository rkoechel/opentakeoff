// The browser side of /api/bids/drafts (scripts/floor360-bids-drafts.mjs).
// The route is the only thing that knows whether AI drafts are on: a 404 (or
// a host without the route) reads as off, and the app shows nothing new.

export const BIDS_DRAFTS_URL = "/api/bids/drafts";
const CT_ZONE = "America/Chicago";

async function readJson(res) {
  try { return await res.json(); } catch { return null; }
}

/** {enabled:false} when the route is off; else {enabled:true, user, drafts, error}. */
export async function loadAiDrafts(fetchImpl = globalThis.fetch) {
  let res;
  try {
    res = await fetchImpl(BIDS_DRAFTS_URL, { headers: { Accept: "application/json" }, credentials: "same-origin" });
  } catch {
    return { enabled: false };
  }
  if (res.status === 404) return { enabled: false };
  const body = await readJson(res);
  if (!body || body.enabled !== true) return { enabled: false };
  return {
    enabled: true,
    user: body.user && typeof body.user.email === "string" ? body.user : null,
    drafts: Array.isArray(body.drafts) ? body.drafts : [],
    error: res.ok ? "" : String(body.error || `AI drafts couldn't load (HTTP ${res.status}).`),
  };
}

async function post(runId, action, fetchImpl) {
  let res;
  try {
    res = await fetchImpl(`${BIDS_DRAFTS_URL}/${encodeURIComponent(runId)}/${action}`, {
      method: "POST", credentials: "same-origin",
      headers: { Accept: "application/json", "Content-Type": "application/json" }, body: "{}",
    });
  } catch {
    return { status: 0, body: { error: "Couldn't reach this site. Check the connection and try again." } };
  }
  return { status: res.status, body: (await readJson(res)) || {} };
}

/** {ok, claimedByEmail, claimedAt, claimedByName?} on a win; {taken, ...} when
 *  someone else got there first (409); {error} otherwise. */
export async function claimDraft(runId, fetchImpl = globalThis.fetch) {
  const { status, body } = await post(runId, "claim", fetchImpl);
  const claim = { claimedByEmail: String(body.claimedByEmail || ""), claimedAt: String(body.claimedAt || ""), ...(body.claimedByName ? { claimedByName: String(body.claimedByName) } : {}) };
  if (status === 200) return { ok: true, ...claim };
  if (status === 409) return { taken: true, ...claim };
  return { error: String(body.error || `Claim failed (HTTP ${status}).`) };
}

/** {ok} once Bids has the approval; {error} otherwise (the approval itself stands). */
export async function notifyApproved(runId, fetchImpl = globalThis.fetch) {
  const { status, body } = await post(runId, "approved", fetchImpl);
  if (status === 200) return { ok: true };
  return { error: String(body.error || `Bids wasn't told (HTTP ${status}).`) };
}

const ctDay = (d) => d.toLocaleDateString("en-US", { timeZone: CT_ZONE, year: "numeric", month: "2-digit", day: "2-digit" });

/** "7:12 PM CT" today (Central), else "Oct 16, 7:12 PM CT". "" for a bad time. */
export function formatCt(iso, now = new Date()) {
  const d = iso ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) return "";
  const time = d.toLocaleTimeString("en-US", { timeZone: CT_ZONE, hour: "numeric", minute: "2-digit" });
  if (ctDay(d) === ctDay(now)) return `${time} CT`;
  const ctYear = (x) => x.toLocaleDateString("en-US", { timeZone: CT_ZONE, year: "numeric" });
  const date = d.toLocaleDateString("en-US", { timeZone: CT_ZONE, month: "short", day: "numeric", ...(ctYear(d) !== ctYear(now) ? { year: "numeric" } : {}) });
  return `${date}, ${time} CT`;
}

/** "Rob" from "Rob Palermo", else the email. */
export function claimerName(claim) {
  const name = String(claim?.claimedByName || "").trim();
  return name ? name.split(/\s+/)[0] : String(claim?.claimedByEmail || "someone");
}

/** "Rob claimed this at 7:12 PM CT" / "You claimed this at …". */
export function claimText(claim, me, now = new Date()) {
  if (!claim?.claimedByEmail) return "";
  const mine = me && String(me).toLowerCase() === String(claim.claimedByEmail).toLowerCase();
  const when = formatCt(claim.claimedAt, now);
  return `${mine ? "You" : claimerName(claim)} claimed this${when ? ` at ${when}` : ""}`;
}
