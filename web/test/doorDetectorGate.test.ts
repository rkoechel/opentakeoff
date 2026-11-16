// The door detector ("Find more doors") downloads its model from
// huggingface.co, which the FLOOR360 CSP does not allow. It is off unless the
// build sets VITE_DOOR_DETECTOR; the linework door reader is not gated.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { doorDetectorEnabled } from "../src/lib/gate.js";

const read = (f: string) => readFileSync(new URL(f, import.meta.url), "utf8");

test("the door detector is off by default", () => {
  assert.equal(doorDetectorEnabled(), false);
});

test("the build turns it on only with VITE_DOOR_DETECTOR=1 or true", () => {
  const cfg = read("../vite.config.js");
  assert.match(cfg, /define\["import\.meta\.env\.VITE_DOOR_DETECTOR"\]/);
  assert.match(cfg, /doorDetectorFlag === "1" \|\| doorDetectorFlag === "true" \? doorDetectorFlag : ""/);
});

test("with the flag off the canvas never probes, downloads or shows Find more doors", () => {
  const src = read("../src/pages/TakeoffCanvas.jsx");
  assert.match(src, /const doorDetectorAllowed = doorDetectorEnabled\(\);/);
  assert.match(src, /useState\(\(\) => \{ if \(!doorDetectorAllowed\) return false;/);
  assert.match(src, /if \(!doorSuiteOn \|\| !doorDetectorAllowed\) return;/, "the WebGPU and cache probe");
  assert.match(src, /if \(!doorDetectorAllowed \|\| !doorSuiteOn \|\| !doorDetectOn/, "the model load and run");
  assert.match(src, /const toggleDoorDetect = \(\) => \{\n\s+if \(!doorDetectorAllowed\) return;/);
  assert.match(src, /const detect = doorDetectorAllowed \? \{/);
  const panel = read("../src/components/DoorsSuitePanel.jsx");
  assert.match(panel, /if \(!detect \|\| detect\.gpu == null\) return null;/, "no detect prop, no switch");
});

test("the CSP still does not allow the model host", () => {
  const headers = read("../public/_headers");
  assert.equal(/huggingface|hf\.co/.test(headers), false);
  assert.match(headers, /connect-src 'self' blob: data: https:\/\/login\.microsoftonline\.com https:\/\/graph\.microsoft\.com https:\/\/floor360com\.sharepoint\.com;/);
});
