// Microsoft 365 sync configuration (#315) — build-time, self-hoster-owned.
// The feature is DARK unless the build names an Entra app registration and a
// document-library drive; an unconfigured build renders no 365 UI at all.
// See SELF_HOSTING.md ("Microsoft 365 annotation sync") for the app
// registration walkthrough and how to find the drive id.
//
//   VITE_MSAL_CLIENT_ID   Entra application (client) id — SPA platform,
//                         redirect URI = the app's own origin
//   VITE_MSAL_TENANT      tenant id or domain; defaults to "organizations"
//                         (any work/school account)
//   VITE_GRAPH_DRIVE_ID   the document library's Graph drive id
//   VITE_GRAPH_FOLDER_ID  driveItem id of the project folder (default: "root")
//   VITE_GRAPH_SCOPES     the ONE delegated Graph scope to request (default:
//                         Files.ReadWrite.All upstream; the FLOOR360 private
//                         build defaults to Sites.Selected)
//
// Tiny and dependency-free on purpose: PlanNavigator imports this statically
// to decide whether to render the entry point; MSAL itself loads dynamically
// only when the user opts in. The FLOOR360 private build blanks the env
// even when a caller passes one in.

import { floor360PrivateBuild, lockSyncConfig } from "../privateBuild.js";

export function m365Config(env = import.meta.env) {
  const src = floor360PrivateBuild() ? lockSyncConfig(env, true) : env;
  const clientId = src?.VITE_MSAL_CLIENT_ID || "";
  const driveId = src?.VITE_GRAPH_DRIVE_ID || "";
  if (!clientId || !driveId) return null;
  return {
    clientId,
    tenant: src?.VITE_MSAL_TENANT || "organizations",
    driveId,
    folderId: src?.VITE_GRAPH_FOLDER_ID || "root",
    scopes: [src?.VITE_GRAPH_SCOPES || "Files.ReadWrite.All"],
  };
}

export const m365SyncConfigured = (env) => m365Config(env) != null;

// Stable sync-meta scope per (drive, folder): the same library keeps its
// bookkeeping across sessions; pointing the build at a different library
// starts a clean seed/merge instead of inheriting the old one's revs.
export const m365Scope = (cfg) => `m365-${cfg.driveId}-${cfg.folderId}`;

// Opt-in is per-browser and persisted (meta key) — configuration alone never
// changes anyone's store.
export const M365_ENABLED_KEY = "m365:enabled";
