// Private build: no Request Premium upsell (Ryan, Oct 19 2026).
// showPremiumUpsell(privateBuild) is false in the FLOOR360 private build, and
// TakeoffCanvas then passes no onPremium to the workspace header, so the
// Request Premium button is not rendered. Upstream builds keep it.
import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { showPremiumUpsell } from "../src/lib/privateBuild.js";
import { registerHooks } from "node:module";

// WorkspaceChrome imports its stylesheet; Node cannot load .css, so stub it.
registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith(".css")) return { format: "module", source: "", shortCircuit: true };
    return nextLoad(url, context);
  },
});
const { WorkspaceChrome } = await import("../src/components/WorkspaceChrome.jsx");

const header = (onPremium: any) => renderToStaticMarkup(React.createElement(WorkspaceChrome as any, { title: "Job", onPremium }));
const premiumHandler = (privateBuild: boolean) => (showPremiumUpsell(privateBuild) ? () => {} : undefined);

test("private build hides the premium upsell; other builds keep it", () => {
  assert.equal(showPremiumUpsell(true), false);
  assert.equal(showPremiumUpsell(false), true);
  assert.equal(showPremiumUpsell(), true);
});

test("private build header renders no Request Premium button", () => {
  const out = header(premiumHandler(true));
  assert.doesNotMatch(out, /Request Premium/);
  assert.doesNotMatch(out, /data-premium-trigger/);
  assert.match(out, /Classic layout/);
});

test("non-private header still renders the Request Premium button", () => {
  assert.match(header(premiumHandler(false)), /Request Premium/);
});

test("premium handler returns undefined", () => {
  assert.strictEqual(premiumHandler(true), undefined);
});

test("premium handler returns a function for non-private build", () => {
  const result = premiumHandler(false);
  assert.ok(result instanceof Function);
  result();
});
