// The MSAL v5 redirect bridge: popups and the silent-renewal iframe must land
// on /redirect.html (which runs broadcastResponseToMainFrame), never on the
// app's own index page.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("redirect bridge page and entry exist and use msal's redirect-bridge", () => {
  const html = readFileSync(new URL("../redirect.html", import.meta.url), "utf8");
  assert.match(html, /<script type="module" src="\/src\/redirect\.js"><\/script>/);
  const js = readFileSync(new URL("../src/redirect.js", import.meta.url), "utf8");
  assert.match(js, /from "@azure\/msal-browser\/redirect-bridge"/);
  assert.match(js, /broadcastResponseToMainFrame\(\)/);
});

test("auth.js points MSAL at the bridge and requests the configured scope", async () => {
  const src = readFileSync(new URL("../src/lib/msgraph/auth.js", import.meta.url), "utf8");
  assert.match(src, /redirectUri: redirectUriFor\(window\.location\.origin\)/);
  assert.match(src, /const SCOPES = cfg\.scopes\?\.length \? cfg\.scopes : DEFAULT_SCOPES;/);
  const { redirectUriFor } = await import("../src/lib/msgraph/auth.js");
  assert.equal(redirectUriFor("https://takeoff.floor360.com"), "https://takeoff.floor360.com/redirect.html");
  assert.equal(redirectUriFor("https://takeoff.floor360.com/"), "https://takeoff.floor360.com/redirect.html");
});
