// FLOOR360 private locks. The Node runner does not load vite.config.js, so
// floor360PrivateBuild() is false here and the existing gate / M365 tests
// still drive their own fixtures. lockSyncConfig(..., true) is the build's
// fail-safe, exercised directly.
import { test } from "node:test";
import assert from "node:assert/strict";
import { floor360PrivateBuild, lockSyncConfig, lockedEndpoint, PRIVATE_LOCKED_ENV_KEYS } from "../src/lib/privateBuild.js";
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

test("lockSyncConfig blanks sync, contribute, one-click, and AI, and forces OCR off", () => {
  const full: Record<string, string> = { VITE_OCR: "on", UNRELATED: "keep" };
  for (const key of PRIVATE_LOCKED_ENV_KEYS) full[key] = "present";
  const locked = lockSyncConfig(full, true);
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
