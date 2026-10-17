// FLOOR360 private build. The Vite config defines __OT_FLOOR360_PRIVATE__
// and blanks every VITE_* contribute / one-click / AI / Google value so a
// secret or feature flag set in the build shell is not inlined. These
// helpers are the second lock: they still refuse when a caller passes an
// env object or a localStorage override. Under the Node test runner the
// define is absent, typeof is "undefined", and the locks stay open so the
// existing gate and M365 tests keep their own fixtures.
//
// Microsoft 365 sync is the ONE sync path the private build may turn on, and
// only against FLOOR360's own tenant and SharePoint: the four M365 values are
// validated (GUID client id, the pinned FLOOR360 tenant, a Graph drive id, a
// driveItem id) and a single bad value blanks all of them, so a typo or a
// foreign tenant fails closed to "no 365 UI" rather than half-configured.

export const FLOOR360_TENANT_ID = "9febc8e3-0f0b-47cd-89b2-18542bb53d21";
export const FLOOR360_SHAREPOINT_HOST = "floor360com.sharepoint.com";

/** The M365 sync keys the private build may carry, validated below. */
export const M365_SYNC_ENV_KEYS = [
  "VITE_MSAL_CLIENT_ID",
  "VITE_MSAL_TENANT",
  "VITE_GRAPH_DRIVE_ID",
  "VITE_GRAPH_FOLDER_ID",
  "VITE_GRAPH_SCOPES",
];

/** Delegated Graph scopes the sync may request. Sites.Selected is the
 *  FLOOR360 default (one site, granted per app); Files.ReadWrite.All is the
 *  upstream scope, kept only as the documented fallback. */
export const M365_ALLOWED_SCOPES = ["Sites.Selected", "Files.ReadWrite.All"];

export const PRIVATE_LOCKED_ENV_KEYS = [
  "VITE_ONE_CLICK",
  "VITE_GOOGLE_CLIENT_ID",
  "VITE_GOOGLE_HD",
  "VITE_DRIVE_ROOT_FOLDER_ID",
  "VITE_CLOUD_SYNC",
  "VITE_CONTRIBUTE_ENDPOINT",
  "VITE_AI_ENDPOINT",
  "VITE_AI_KEY",
  "VITE_AI_MODEL",
  "VITE_AI_PROVIDER",
];

export function floor360PrivateBuild() {
  return typeof __OT_FLOOR360_PRIVATE__ !== "undefined" && __OT_FLOOR360_PRIVATE__ === true;
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Graph drive ids for SharePoint libraries are "b!" + url-safe base64.
const DRIVE_ID = /^b![A-Za-z0-9_-]{20,200}$/;
// SharePoint driveItem ids are 34 upper-case base32 chars; "root" is allowed.
const ITEM_ID = /^(root|[A-Z0-9]{20,64})$/;

/**
 * Validate the M365 values for the private build.
 * @param {Record<string, string | undefined> | null | undefined} env
 * @returns {{ values: Record<string, string>, errors: string[], configured: boolean }}
 *   values is all-blank unless every value passed; errors lists what failed.
 */
export function floor360M365Env(env) {
  const blank = Object.fromEntries(M365_SYNC_ENV_KEYS.map((k) => [k, ""]));
  const src = env && typeof env === "object" ? env : {};
  const get = (k) => String(src[k] ?? "").trim();
  const clientId = get("VITE_MSAL_CLIENT_ID");
  const driveId = get("VITE_GRAPH_DRIVE_ID");
  const tenant = get("VITE_MSAL_TENANT");
  const folderId = get("VITE_GRAPH_FOLDER_ID");
  const scopes = get("VITE_GRAPH_SCOPES");
  if (!clientId && !driveId && !tenant && !folderId && !scopes) return { values: blank, errors: [], configured: false };
  const errors = [];
  if (!GUID.test(clientId)) errors.push("VITE_MSAL_CLIENT_ID must be the Entra application (client) id GUID");
  if (tenant && tenant.toLowerCase() !== FLOOR360_TENANT_ID) errors.push(`VITE_MSAL_TENANT must be the FLOOR360 tenant ${FLOOR360_TENANT_ID}`);
  if (!DRIVE_ID.test(driveId)) errors.push("VITE_GRAPH_DRIVE_ID must be a SharePoint document-library drive id (b!…)");
  if (folderId && !ITEM_ID.test(folderId)) errors.push("VITE_GRAPH_FOLDER_ID must be a driveItem id or root");
  const scopeList = scopes ? scopes.split(/[\s,]+/).filter(Boolean) : ["Sites.Selected"];
  for (const s of scopeList) if (!M365_ALLOWED_SCOPES.includes(s)) errors.push(`VITE_GRAPH_SCOPES may only name ${M365_ALLOWED_SCOPES.join(" or ")} (got ${s})`);
  if (scopeList.length !== 1) errors.push("VITE_GRAPH_SCOPES must name exactly one scope");
  if (errors.length) return { values: blank, errors, configured: false };
  return {
    values: {
      VITE_MSAL_CLIENT_ID: clientId.toLowerCase(),
      VITE_MSAL_TENANT: FLOOR360_TENANT_ID,
      VITE_GRAPH_DRIVE_ID: driveId,
      VITE_GRAPH_FOLDER_ID: folderId || "root",
      VITE_GRAPH_SCOPES: scopeList[0],
    },
    errors: [],
    configured: true,
  };
}

/** Copy `env` with contribute / one-click / AI / Google keys cleared, OCR
 *  forced off, and the M365 keys kept only if they validate for FLOOR360. */
export function lockSyncConfig(env, locked = floor360PrivateBuild()) {
  if (!locked || env == null || typeof env !== "object") return env;
  const out = { ...env, VITE_OCR: "off", ...floor360M365Env(env).values };
  for (const key of PRIVATE_LOCKED_ENV_KEYS) out[key] = "";
  return out;
}

/** Contribute's storage override and build-time endpoint are both ignored when locked. */
export function lockedEndpoint(privateBuild, storageValue, envValue) {
  if (privateBuild) return "";
  if (storageValue) return storageValue;
  return envValue || "";
}
