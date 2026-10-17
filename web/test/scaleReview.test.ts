import { test } from "node:test";
import assert from "node:assert/strict";
import { detectScale, detectScaleSourced } from "../src/lib/sheets";
import {
  sheetScaleState, scaleConfidence, shouldAutoApply, scaleSummary, measureScaleWarning,
  sanitizeNtsSheets, pageKeys, batchDetectScales, type Detected,
} from "../src/lib/scaleReview";
import { buildTakeoffDocument } from "../src/lib/takeoffDocument.js";

const VP = { width: 6048, height: 4320, transform: [1, 0, 0, 1, 0, 0] } as never;
const item = (str: string, x: number, y: number) => ({ str, transform: [1, 0, 0, 1, x, y], width: str.length * 12, height: 25 });

test("detectScaleSourced: title-block note vs the page's only note; detectScale keeps its exact shape", () => {
  const tb = { items: [item('1/4" = 1\'-0"', 5000, 4000)] } as never;
  const page = { items: [item('1/8" = 1\'-0"', 600, 300)] } as never;
  assert.equal(detectScaleSourced(tb, VP)?.source, "title-block");
  assert.equal(detectScaleSourced(page, VP)?.source, "page-text");
  assert.deepEqual(Object.keys(detectScale(tb, VP)!).sort(), ["label", "multi", "upp"]);
  assert.equal(detectScaleSourced({ items: [item("NO SCALE HERE", 1, 1)] } as never, VP), null);
});

const det = (over: Partial<Detected> = {}): Detected => ({ upp: 0.01, label: '1/4" = 1\'-0"', multi: false, source: "title-block", ...over });
const base = () => ({ scales: {} as Record<string, number>, scaleUnconfirmed: {} as Record<string, boolean>, detected: {} as Record<string, Detected>, nts: new Set<string>() });

test("sheetScaleState: every state, NTS winning over everything", () => {
  const s = base();
  s.scales.a = 0.01;                                  // person-set
  s.scales.b = 0.01; s.scaleUnconfirmed.b = false;    // auto-applied, unconfirmed
  s.detected.c = det({ multi: true });                // noted but ambiguous
  s.scales.e = 0.01; s.nts.add("e");
  assert.equal(sheetScaleState("a", s), "confirmed");
  assert.equal(sheetScaleState("b", s), "needs-confirm");
  assert.equal(sheetScaleState("c", s), "detected");
  assert.equal(sheetScaleState("d", s), "needs-scale");
  assert.equal(sheetScaleState("e", s), "nts");
});

test("scaleConfidence ranks title block > ambiguous title block > page note > none", () => {
  const v = [det(), det({ multi: true }), det({ source: "page-text" }), null].map((d) => scaleConfidence(d).value);
  assert.deepEqual(v, [0.9, 0.7, 0.6, 0]);
});

test("shouldAutoApply: only unambiguous notes, never over a person's scale or an NTS sheet", () => {
  const s = base();
  assert.equal(shouldAutoApply("x", det(), s), true);
  assert.equal(shouldAutoApply("x", det({ multi: true }), s), false);
  assert.equal(shouldAutoApply("x", null, s), false);
  s.scales.x = 0.02;
  assert.equal(shouldAutoApply("x", det(), s), false);
  s.nts.add("y");
  assert.equal(shouldAutoApply("y", det(), s), false);
});

test("scaleSummary: '12 confirmed / 3 need review' wording and counts", () => {
  const s = base();
  const keys: string[] = [];
  for (let i = 0; i < 12; i++) { keys.push(`c${i}`); s.scales[`c${i}`] = 0.01; }
  keys.push("u"); s.scales.u = 0.01; s.scaleUnconfirmed.u = false;
  keys.push("d"); s.detected.d = det({ multi: true });
  keys.push("n");
  const sum = scaleSummary(keys, s);
  assert.equal(sum.text, "Scales: 12 confirmed / 3 need review");
  assert.equal(sum.needsScale, 1);
  s.nts.add("n");
  assert.equal(scaleSummary(keys, s).text, "Scales: 12 confirmed / 2 need review / 1 NTS");
});

test("measureScaleWarning warns on unconfirmed and NTS, silent otherwise", () => {
  assert.match(measureScaleWarning("needs-confirm", "A-101")!, /UNCONFIRMED/);
  assert.match(measureScaleWarning("nts", "A-101")!, /NTS/);
  assert.equal(measureScaleWarning("confirmed", "A-101"), null);
});

test("nts_sheets: sanitized on read, written only when present (old payloads unchanged)", () => {
  assert.deepEqual(sanitizeNtsSheets(["a", "a", 3, "", "b"]), ["a", "b"]);
  assert.deepEqual(sanitizeNtsSheets(undefined), []);
  assert.equal("nts_sheets" in buildTakeoffDocument({}), false);
  assert.equal("nts_sheets" in buildTakeoffDocument({ nts_sheets: [] }), false);
  assert.deepEqual(buildTakeoffDocument({ nts_sheets: ["p.pdf#2"] }).nts_sheets, ["p.pdf#2"]);
});

test("batchDetectScales: every page of every file, skips done keys, survives a bad page, stops when stale", async () => {
  assert.deepEqual(pageKeys("p.pdf", 3), ["p.pdf", "p.pdf#2", "p.pdf#3"]);
  const pages: Record<string, number> = { "a.pdf": 3, "b.pdf": 1 };
  const seen: string[] = [];
  const res = await batchDetectScales<string>({
    files: ["a.pdf", "b.pdf"],
    numPages: async (f) => pages[f],
    readPage: async (f, p) => { if (f === "a.pdf" && p === 3) throw new Error("bad page"); return `${f}:${p}`; },
    detect: (t) => (t === "a.pdf:1" ? det() : null),
    done: new Set(["a.pdf#2"]),
    onResult: (k) => seen.push(k),
  });
  assert.deepEqual(Object.keys(res), ["a.pdf", "a.pdf#3", "b.pdf"]);
  assert.equal(res["a.pdf"]?.label, '1/4" = 1\'-0"');
  assert.equal(res["a.pdf#3"], null);
  assert.deepEqual(seen, ["a.pdf", "a.pdf#3", "b.pdf"]);
  let calls = 0;
  const stale = await batchDetectScales<string>({
    files: ["a.pdf"], numPages: async () => 5, readPage: async () => "x", detect: () => null,
    isStale: () => ++calls > 2,
  });
  assert.ok(Object.keys(stale).length < 5);
});
