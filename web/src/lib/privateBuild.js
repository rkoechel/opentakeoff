// FLOOR360 private build. The Vite config defines __OT_FLOOR360_PRIVATE__
// and blanks every VITE_* sync / contribute / one-click / AI value so a
// secret or feature flag set in the build shell is not inlined. These
// helpers are the second lock: they still refuse when a caller passes an
// env object or a localStorage override. Under the Node test runner the
// define is absent, typeof is "undefined", and the locks stay open so the
// existing gate and M365 tests keep their own fixtures.

export const PRIVATE_LOCKED_ENV_KEYS = [
  "VITE_ONE_CLICK",
  "VITE_GOOGLE_CLIENT_ID",
  "VITE_GOOGLE_HD",
  "VITE_DRIVE_ROOT_FOLDER_ID",
  "VITE_CLOUD_SYNC",
  "VITE_MSAL_CLIENT_ID",
  "VITE_MSAL_TENANT",
  "VITE_GRAPH_DRIVE_ID",
  "VITE_GRAPH_FOLDER_ID",
  "VITE_CONTRIBUTE_ENDPOINT",
  "VITE_AI_ENDPOINT",
  "VITE_AI_KEY",
  "VITE_AI_MODEL",
  "VITE_AI_PROVIDER",
];

export function floor360PrivateBuild() {
  return typeof __OT_FLOOR360_PRIVATE__ !== "undefined" && __OT_FLOOR360_PRIVATE__ === true;
}

/** Copy `env` with sync / contribute / one-click / AI keys cleared and OCR forced off. */
export function lockSyncConfig(env, locked = floor360PrivateBuild()) {
  if (!locked || env == null || typeof env !== "object") return env;
  const out = { ...env, VITE_OCR: "off" };
  for (const key of PRIVATE_LOCKED_ENV_KEYS) out[key] = "";
  return out;
}

/** Contribute's storage override and build-time endpoint are both ignored when locked. */
export function lockedEndpoint(privateBuild, storageValue, envValue) {
  if (privateBuild) return "";
  if (storageValue) return storageValue;
  return envValue || "";
}
