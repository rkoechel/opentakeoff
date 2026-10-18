import { test } from "node:test";
import assert from "node:assert/strict";
import { detectScale } from "../src/lib/sheets";

// identity-scale viewport: item transform [1,0,0,1,x,y] → position (x, y)
const VP = { width: 6048, height: 4320, transform: [1, 0, 0, 1, 0, 0] } as never;
const item = (str: string, x: number, y: number) => ({ str, transform: [1, 0, 0, 1, x, y], width: str.length * 12, height: 25 });

test("#375: a scale note right after a digit-ending run (schedule cell) still detects", () => {
  // The Dublin A-601 item order as pdf.js emits it: schedule cells, the note under
  // the view title, the view-number bubble, the title. Whitespace-stripped
  // concatenation read this as PT-11/8" and the 11/8" guard rejected it.
  const items = [
    item("PT-1", 2072, 470), item("PT-1", 2072, 505),
    item('1/8" = 1\'-0"', 621, 3552), item("1", 519, 3538),
    item("FLOOR PLAN - PHASE I - FINISH PLAN", 614, 3507),
  ];
  const d = detectScale({ items } as never, VP);
  assert.ok(d, "note under the view title must be detected");
  assert.equal(d!.label, '1/8" = 1\'-0"');
  assert.equal(d!.multi, false);
});

test("#375: the 11/8\" and 1-1/2\" boundary guards still hold inside one run", () => {
  assert.equal(detectScale({ items: [item('11/8" = 1\'-0"', 621, 3552)] } as never, VP), null);
  assert.equal(detectScale({ items: [item('1-1/2" = 1\'-0"', 100, 100)] } as never, VP)?.label, '1-1/2" = 1\'-0"');
});

test("#375: a note the exporter split across runs still detects through the fallback", () => {
  const items = [item("SCALE:", 4000, 4000), item('1/4"', 4100, 4000), item("=", 4150, 4000), item("1'-0\"", 4180, 4000)];
  assert.equal(detectScale({ items } as never, VP)?.label, '1/4" = 1\'-0"');
});

const one = (s: string) => detectScale({ items: [item(s, 100, 100)] } as never, VP)?.label ?? null;
const A = (f: string) => `${f}" = 1'-0"`;

test(`fix C: INCH / FOOT / FT words read as inch and foot marks`, () => {
  assert.equal(one(`SCALE: 1/8 INCH = 1 FOOT`), A(`1/8`));
  assert.equal(one(`1/4 INCHES = 1 FT`), A(`1/4`));
  assert.equal(one(`3/16 INCH = 1 FT. 0 INCHES`), A(`3/16`));
});

test(`fix C: =1'0" and =1'-0 variants`, () => {
  assert.equal(one(`1/4" = 1'0"`), A(`1/4`));
  assert.equal(one(`1/2" = 1'-0`), A(`1/2`));
});

test(`fix C: ratio keys for architectural scales, never 1:4, 1:8, 1:12 or 1:16`, () => {
  assert.equal(one(`SCALE 1:48`), A(`1/4`));
  assert.equal(one(`1:96`), A(`1/8`));
  assert.equal(one(`1:192`), A(`1/16`));
  assert.equal(one(`1:128`), A(`3/32`));
  assert.equal(one(`1:64`), A(`3/16`));
  assert.equal(one(`1:32`), A(`3/8`));
  assert.equal(one(`1:24`), A(`1/2`));
  assert.equal(one(`1:16`), null);
  assert.equal(one(`1:12`), null);
  assert.equal(one(`1:8`), null);
  assert.equal(one(`1:4`), null);
  assert.equal(one(`1:25`), `1:25`);
  assert.equal(one(`1:250`), `1:250`);
});

test(`fix C: 1/32", 6" and 1" = 100' scales without breaking 1/16" or 1" = 10'`, () => {
  assert.equal(one(A(`1/32`)), A(`1/32`));
  assert.equal(one(A(`6`)), A(`6`));
  assert.equal(one(A(`1/16`)), A(`1/16`));
  assert.equal(one(`1" = 100'`), `1" = 100'`);
  assert.equal(one(`1" = 10'`), `1" = 10'`);
});
