// FLOOR360 private locks. The Node runner does not load vite.config.js, so
// floor360PrivateBuild() is false here and the existing gate / M365 tests
// still drive their own fixtures. lockSyncConfig(..., true) is the build's
// fail-safe, exercised directly.
import { test } from "node:test";
import assert from "node:assert/strict";
import { floor360PrivateBuild, floor360M365Env, lockSyncConfig, lockedEndpoint, FLOOR360_TENANT_ID, M365_SYNC_ENV_KEYS, PRIVATE_LOCKED_ENV_KEYS } from "../src/lib/privateBuild.js";
import { oneClickDecision } from "../src/lib/gate.js";
import { m365Config } from "../src/lib/msgraph/config.js";
import { sourceHref, sourceLabel } from "../src/lib/sourceLink.js";

test("node is not the private build, so source falls back to the repo", () => {
  assert.equal(floor360PrivateBuild(), false);
  assert.equal(sourceHref(), "https://github.com/rkoechel/opentakeoff");
  assert.equal(sourceLabel(), "Source");
});

test("one-click stays off on a private build even if the runtime gate and VITE_ONE_CLICK are set", () => {
  assert.equal(oneClickDecision({ privateBuild: true, runtime: true, vite: "1" }), false);
  assert.equal(oneClickDecision({ privateBuild: false, runtime: true, vite: "" }), true);
  assert.equal(oneClickDecision({ privateBuild: false, runtime: false, vite: "1" }), true);
  assert.equal(oneClickDecision({ privateBuild: false, runtime: false, vite: "" }), false);
});

test("lockSyncConfig blanks Google sync, contribute, one-click, and AI, forces OCR off, and drops invalid M365 values", () => {
  const full: Record<string, string> = { VITE_OCR: "on", UNRELATED: "keep" };
  for (const key of PRIVATE_LOCKED_ENV_KEYS) full[key] = "present";
  for (const key of M365_SYNC_ENV_KEYS) full[key] = "present";
  const locked = lockSyncConfig(full, true);
  for (const key of M365_SYNC_ENV_KEYS) assert.equal(locked[key], "", key);
  assert.equal(locked.VITE_OCR, "off");
  assert.equal(locked.UNRELATED, "keep");
  for (const key of PRIVATE_LOCKED_ENV_KEYS) assert.equal(locked[key], "", key);
  assert.equal(m365Config(locked), null);
  assert.equal(full.VITE_MSAL_CLIENT_ID, "present", "the caller's object is not mutated");
});

test("an unlocked env object still configures M365", () => {
  const cfg = m365Config({ VITE_MSAL_CLIENT_ID: "app", VITE_GRAPH_DRIVE_ID: "d1" });
  assert.equal(cfg?.clientId, "app");
  assert.equal(cfg?.driveId, "d1");
});

test("contribute ignores storage and the build endpoint when locked", () => {
  assert.equal(lockedEndpoint(true, "https://storage.example/c", "https://build.example/c"), "");
  assert.equal(lockedEndpoint(false, "https://storage.example/c", "https://build.example/c"), "https://storage.example/c");
  assert.equal(lockedEndpoint(false, "", "https://build.example/c"), "https://build.example/c");
  assert.equal(lockedEndpoint(false, "", ""), "");
});

const GOOD = {
  VITE_MSAL_CLIENT_ID: "11111111-2222-3333-4444-555555555555",
  VITE_GRAPH_DRIVE_ID: "b!AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_",
  VITE_GRAPH_FOLDER_ID: "01ABCDEFGHIJKLMNOPQRSTUVWXYZ234567",
};

test("M365 keys are not on the hard-locked list", () => {
  for (const key of M365_SYNC_ENV_KEYS) assert.equal(PRIVATE_LOCKED_ENV_KEYS.includes(key), false, key);
  for (const key of ["VITE_ONE_CLICK", "VITE_GOOGLE_CLIENT_ID", "VITE_CONTRIBUTE_ENDPOINT", "VITE_AI_KEY", "VITE_AI_ENDPOINT"]) {
    assert.equal(PRIVATE_LOCKED_ENV_KEYS.includes(key), true, key);
  }
});

test("unset M365 values leave the 365 UI dark with no error", () => {
  const r = floor360M365Env({});
  assert.equal(r.configured, false);
  assert.deepEqual(r.errors, []);
  assert.equal(m365Config(lockSyncConfig({}, true)), null);
});

test("valid FLOOR360 values configure M365 on a locked build, pinned to the FLOOR360 tenant and Sites.Selected", () => {
  const r = floor360M365Env(GOOD);
  assert.equal(r.configured, true);
  assert.equal(r.values.VITE_MSAL_TENANT, FLOOR360_TENANT_ID);
  assert.equal(r.values.VITE_GRAPH_SCOPES, "Sites.Selected");
  const cfg = m365Config(lockSyncConfig({ ...GOOD, VITE_AI_KEY: "sk-secret", VITE_ONE_CLICK: "1" }, true));
  assert.ok(cfg);
  assert.equal(cfg!.clientId, GOOD.VITE_MSAL_CLIENT_ID);
  assert.equal(cfg!.tenant, FLOOR360_TENANT_ID);
  assert.equal(cfg!.driveId, GOOD.VITE_GRAPH_DRIVE_ID);
  assert.equal(cfg!.folderId, GOOD.VITE_GRAPH_FOLDER_ID);
  assert.deepEqual(cfg!.scopes, ["Sites.Selected"]);
  const locked = lockSyncConfig({ ...GOOD, VITE_AI_KEY: "sk-secret" }, true);
  assert.equal(locked.VITE_AI_KEY, "");
});

test("a foreign tenant, a multi-tenant authority, a bad id, or a broad scope fails closed", () => {
  const cases: Record<string, string>[] = [
    { ...GOOD, VITE_MSAL_TENANT: "organizations" },
    { ...GOOD, VITE_MSAL_TENANT: "common" },
    { ...GOOD, VITE_MSAL_TENANT: "00000000-0000-0000-0000-000000000000" },
    { ...GOOD, VITE_MSAL_CLIENT_ID: "not-a-guid" },
    { ...GOOD, VITE_GRAPH_DRIVE_ID: "1234" },
    { ...GOOD, VITE_GRAPH_FOLDER_ID: "../etc" },
    { ...GOOD, VITE_GRAPH_SCOPES: "Sites.ReadWrite.All" },
    { ...GOOD, VITE_GRAPH_SCOPES: "Sites.Selected Mail.Read" },
  ];
  for (const env of cases) {
    const r = floor360M365Env(env);
    assert.equal(r.configured, false, JSON.stringify(env));
    assert.ok(r.errors.length > 0, JSON.stringify(env));
    assert.equal(m365Config(lockSyncConfig(env, true)), null, JSON.stringify(env));
  }
});

test("the fallback scope Files.ReadWrite.All is accepted when named", () => {
  const r = floor360M365Env({ ...GOOD, VITE_GRAPH_SCOPES: "Files.ReadWrite.All", VITE_MSAL_TENANT: FLOOR360_TENANT_ID.toUpperCase() });
  assert.equal(r.configured, true);
  assert.equal(r.values.VITE_GRAPH_SCOPES, "Files.ReadWrite.All");
});
