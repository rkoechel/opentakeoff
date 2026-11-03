// Graphite and HUD redefine --ink on a dark surface but used to leave `color`
// unset, so report rows that don't name a color inherited the light theme's
// ink (#0d1526) and disappeared. There is no CSS harness here: this parses the
// stylesheets and applies the same cascade a group-row cell sees.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const workspace = readFileSync(new URL("../src/styles/premiumWorkspace.css", import.meta.url), "utf8");
const tokens = readFileSync(new URL("../src/styles/tokens.css", import.meta.url), "utf8");
const printCss = readFileSync(new URL("../src/styles/print.css", import.meta.url), "utf8");

function sliceBlock(css: string, openBrace: number): string {
  let depth = 0;
  for (let i = openBrace; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") {
      depth--;
      if (depth === 0) return css.slice(openBrace + 1, i);
    }
  }
  throw new Error("unbalanced braces");
}

/** CSS with every @media block removed, so only rules that apply in print remain. */
function withoutMedia(css: string): string {
  let out = "";
  let i = 0;
  while (i < css.length) {
    const at = css.slice(i).search(/@media\b/);
    if (at < 0) return out + css.slice(i);
    out += css.slice(i, i + at);
    const brace = css.indexOf("{", i + at);
    sliceBlock(css, brace);
    let depth = 0;
    let j = brace;
    for (; j < css.length; j++) {
      if (css[j] === "{") depth++;
      else if (css[j] === "}") {
        depth--;
        if (depth === 0) { j++; break; }
      }
    }
    i = j;
  }
  return out;
}

function ruleBodies(css: string, selector: string): string[] {
  const bodies: string[] = [];
  let from = 0;
  while (from < css.length) {
    const i = css.indexOf(selector, from);
    if (i < 0) break;
    const prev = i === 0 ? "" : css[i - 1];
    const next = css.slice(i + selector.length).match(/^\s*\{/);
    // skip a selector that is only the tail of a comma-group
    if (next && prev !== "," && !/[\w-]/.test(prev)) {
      const brace = i + selector.length + next[0].length - 1;
      bodies.push(sliceBlock(css, brace));
    }
    from = i + selector.length;
  }
  return bodies;
}

function decls(body: string): Record<string, string> {
  const map: Record<string, string> = {};
  const flat = body.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const part of flat.split(";")) {
    const idx = part.indexOf(":");
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key && !key.startsWith("@")) map[key] = val;
  }
  return map;
}

function rootInk(css: string): string {
  const top = withoutMedia(css);
  const bodies = ruleBodies(top, ":root");
  for (const body of bodies) {
    const ink = decls(body)["--ink"];
    if (ink) return ink.toLowerCase();
  }
  throw new Error("no unscoped :root --ink");
}

function channel(hex: string, i: number): number {
  const n = parseInt(hex.slice(i, i + 2), 16) / 255;
  return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  return 0.2126 * channel(full, 0) + 0.7152 * channel(full, 2) + 0.0722 * channel(full, 4);
}

function contrast(fg: string, bg: string): number {
  const a = luminance(fg);
  const b = luminance(bg);
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

const SCREEN = "@media screen";
const screenAt = workspace.indexOf(SCREEN);
const screenBody = sliceBlock(workspace, workspace.indexOf("{", screenAt));
const sharedSel = ".premium-workspace[data-workspace-look=graphite],.premium-workspace[data-workspace-look=hud]";
const hudSel = ".premium-workspace[data-workspace-look=hud]";
const shared = decls(ruleBodies(screenBody, sharedSel)[0]);
const hudOnly = decls(ruleBodies(screenBody, hudSel)[0]);
const inheritedInk = rootInk(tokens);

// A group row sets background but not color (ReportPanel). With no `color` on
// the look, the cell inherits body's used color, which was resolved against
// :root --ink — not the look's redefined variable.
function textOn(look: Record<string, string>): string {
  return look.color === "var(--ink)" ? look["--ink"] : inheritedInk;
}

const looks = {
  graphite: { ...shared },
  hud: { ...shared, ...hudOnly },
} as const;

test("a report group row is readable under Graphite and HUD", () => {
  for (const [name, look] of Object.entries(looks)) {
    const fg = textOn(look);
    const bg = look["--paper-cream"];
    const ratio = contrast(fg, bg);
    // Missing `color` inherits the light-theme ink, which fails this check.
    assert.ok(ratio >= 4.5, `${name} group row ${fg} on ${bg} is ${ratio.toFixed(2)}:1, need >= 4.5:1`);
    assert.equal(look.color, "var(--ink)", `${name} sets color to its own ink`);
    assert.ok(luminance(look["--ink"]) > 0.5, `${name} --ink ${look["--ink"]} is a light text color`);
    // By sheet and the buy list sit on --paper-bright with the same inherited color
    const table = contrast(fg, look["--paper-bright"]);
    assert.ok(table >= 4.5, `${name} table ${fg} on ${look["--paper-bright"]} is ${table.toFixed(2)}:1, need >= 4.5:1`);
  }
});

test("print keeps dark text on white and ignores the dark looks", () => {
  assert.equal(withoutMedia(workspace).includes(sharedSel), false, "Graphite/HUD rules are screen-only");
  assert.match(printCss, /@media print[\s\S]*background:\s*#fff\s*!important/);
  assert.match(printCss, /\.report-panel\s*\{[^}]*color:\s*var\(--ink\)/);
  assert.equal(withoutMedia(tokens).includes(':root[data-theme="dark"]'), false, "the dark theme override is screen-only");
  const ink = inheritedInk;
  const ratio = contrast(ink, "#ffffff");
  assert.ok(luminance(ink) < 0.2, `print ink ${ink} stays dark`);
  assert.ok(ratio >= 4.5, `print ${ink} on #ffffff is ${ratio.toFixed(2)}:1, need >= 4.5:1`);
  assert.notEqual(ink, looks.graphite["--ink"], "print does not pick up the Graphite ink");
});
