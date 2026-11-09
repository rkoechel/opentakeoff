// User-facing web source and assets must not show upstream branding.
// The web CI job runs this file with the rest of test/*.test.ts.
//
// Allowlist — internal, not a user-visible product name. The scanner deletes
// these exact snippets before it looks for leaks. Do not add a sentence a
// person can read.
// - Package names and imports (`opentakeoff`, `opentakeoff-mcp`, `opentakeoff-web`).
//   The search is case-sensitive for "OpenTakeoff", so these lowercase ids pass.
// - Protocol and MCP ids (`opentakeoff.takeoff_canvas.v1`, `opentakeoff.report.v1`,
//   and the other `opentakeoff.*` schema ids). Same lowercase exception.
// - MCP registry id `io.github.Kentucky-ai/opentakeoff` (the `name` field in
//   web/public/.well-known/mcp.json). It is not the phrase "Kentucky AI" and
//   it is not a kentucky-ai.com URL.
// - Env vars (`OT_WATERMARK`, `VITE_OT_WATERMARK`, `OPENTAKEOFF_*`).
// - SharePoint folder name "OpenTakeoff Projects".
// - DXF stamp "OpenTakeoff DXF export" (web/src/lib/dxf.ts). mcp/src/safewrite.ts
//   matches that prefix and must keep matching it.
// - Watermark strings in web/src/lib/branding.js (#30, default off):
//   OT_NAME, OT_CREDIT, OT_WATERMARK (including opentakeoff.kentucky-ai.com),
//   and the cover title "OpenTakeoff · Marked Set" when the flag is on.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = fileURLToPath(new URL("..", import.meta.url));
const TEXT_EXT = new Set([".html", ".txt", ".json", ".css", ".js", ".jsx", ".ts", ".tsx", ".svg", ".mjs", ".md"]);

const LEAKS: { name: string; re: RegExp }[] = [
  { name: "OpenTakeoff", re: /OpenTakeoff/ },
  { name: "header wordmark open/takeoff", re: /open<span>takeoff/i },
  { name: "OPEN TAKEOFF", re: /OPEN TAKEOFF/ },
  { name: "Kentucky AI", re: /Kentucky AI/ },
  { name: "Michael Edlin", re: /Michael Edlin/ },
  { name: "Kentucky AI URL", re: /kentucky-ai\.com/i },
  { name: "marked-set cover star", re: /drawSvgPath\(\s*starPath/ },
];

function stripComments(src: string, ext: string): string {
  if (ext === ".html" || ext === ".svg") return src.replace(/<!--[\s\S]*?-->/g, "");
  if (ext === ".css") return src.replace(/\/\*[\s\S]*?\*\//g, "");
  if (![".js", ".jsx", ".ts", ".tsx", ".mjs"].includes(ext)) return src;
  // Comments are dropped. Strings, regexes, and JSX text stay, so a leak
  // inside any of them still fails. JSX text is not code: an apostrophe in
  // "doesn't" must not open a string and hide the rest of the file.
  const jsx = ext === ".jsx" || ext === ".tsx";
  const regexAfter = /[(,=:[!&|?{;+\-*%~^<>]|^$/;
  type Mode = "code" | "line" | "block" | "sq" | "dq" | "tpl" | "jsx" | "tag" | "closetag";
  const stack: { mode: Mode; depth: number }[] = [{ mode: "code", depth: 0 }];
  const mode = () => stack[stack.length - 1].mode;
  const push = (m: Mode) => stack.push({ mode: m, depth: 0 });
  let out = "";
  let i = 0;
  const prevWord = () => out.replace(/\s+$/, "").match(/[A-Za-z0-9_$]+$/)?.[0] ?? "";
  const jsxKeyword = new Set(["return", "yield", "throw", "case", "await"]);
  const canStartJsx = (next: string) => {
    if (!jsx || !/[A-Za-z/>]/.test(next)) return false;
    const prev = out.replace(/\s+$/, "").slice(-1);
    if (!prev || !/[A-Za-z0-9_$]/.test(prev)) return true;
    return jsxKeyword.has(prevWord());
  };
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    const m = mode();
    if (m === "line") {
      if (c === "\n") { stack.pop(); out += c; }
      i++;
      continue;
    }
    if (m === "block") {
      if (c === "*" && n === "/") { stack.pop(); i += 2; continue; }
      if (c === "\n") out += "\n";
      i++;
      continue;
    }
    if (m === "sq" || m === "dq" || m === "tpl") {
      out += c;
      if (c === "\\") { if (i + 1 < src.length) out += src[i + 1]; i += 2; continue; }
      if (m === "sq" && c === "'") stack.pop();
      else if (m === "dq" && c === '"') stack.pop();
      else if (m === "tpl" && c === "`") stack.pop();
      else if (m === "tpl" && c === "$" && n === "{") { out += "{"; push("code"); i += 2; continue; }
      i++;
      continue;
    }
    if (m === "jsx") {
      if (c === "{" && n === "/" && src[i + 2] === "*") { push("block"); i += 3; continue; }
      if (c === "{") { out += c; push("code"); i++; continue; }
      if (c === "<" && /[A-Za-z/>]/.test(n ?? "")) {
        out += c;
        push(n === "/" ? "closetag" : "tag");
        i++;
        continue;
      }
      out += c;
      i++;
      continue;
    }
    if (m === "tag" || m === "closetag") {
      if (c === "'" ) { out += c; push("sq"); i++; continue; }
      if (c === '"') { out += c; push("dq"); i++; continue; }
      if (c === "{") { out += c; push("code"); i++; continue; }
      if (c === ">") {
        const selfClose = m === "tag" && /\/\s*$/.test(out);
        stack.pop();
        if (m === "tag" && !selfClose) push("jsx");
        out += c;
        i++;
        continue;
      }
      out += c;
      i++;
      continue;
    }
    if (c === "/" && n === "/") { push("line"); i += 2; continue; }
    if (c === "/" && n === "*") { push("block"); i += 2; continue; }
    if (c === "/" && regexAfter.test(out.replace(/\s+$/, "").slice(-1))) {
      const start = i;
      i++;
      let klass = false;
      while (i < src.length) {
        const d = src[i];
        if (d === "\\") { i += 2; continue; }
        if (d === "[") klass = true;
        else if (d === "]") klass = false;
        else if (d === "/" && !klass) { i++; while (i < src.length && /[a-z]/i.test(src[i])) i++; break; }
        else if (d === "\n") break;
        i++;
      }
      out += src.slice(start, i);
      continue;
    }
    if (c === "<" && canStartJsx(n ?? "")) { out += c; push(n === "/" ? "closetag" : "tag"); i++; continue; }
    if (c === "'") push("sq");
    else if (c === '"') push("dq");
    else if (c === "`") push("tpl");
    else if (c === "{") stack[stack.length - 1].depth++;
    else if (c === "}") {
      const frame = stack[stack.length - 1];
      if (frame.depth > 0) frame.depth--;
      else if (stack.length > 1) stack.pop();
    }
    out += c;
    i++;
  }
  return out;
}

/** Drop the commented allowlist above from a scanned file. */
function applyAllowlist(rel: string, text: string): string {
  let t = text.split("OpenTakeoff Projects").join("");
  t = t.split("OpenTakeoff DXF export").join("");
  if (rel.endsWith("src/lib/branding.js")) {
    t = t.split('export const OT_NAME = "OpenTakeoff";').join("");
    t = t.split('export const OT_CREDIT = "Measured with OpenTakeoff";').join("");
    t = t.split('export const OT_WATERMARK = "Prepared with OpenTakeoff · opentakeoff.kentucky-ai.com";').join("");
    t = t.split('"OpenTakeoff · Marked Set"').join("");
  }
  return t;
}

function leaksIn(rel: string, raw: string): string[] {
  const ext = path.extname(rel);
  const text = applyAllowlist(rel, stripComments(raw, ext));
  const found: string[] = [];
  for (const leak of LEAKS) {
    // The cover star is a drawing, so a comment that still contains the call counts.
    const hay = leak.name === "marked-set cover star" ? raw : text;
    if (leak.re.test(hay)) found.push(leak.name);
  }
  return found;
}

function walk(dir: string, out: string[]) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const abs = path.join(dir, name);
    const st = statSync(abs);
    if (st.isDirectory()) walk(abs, out);
    else if (TEXT_EXT.has(path.extname(name))) out.push(abs);
  }
}

test("user-facing web source does not show upstream branding", () => {
  const files = [path.join(webRoot, "index.html")];
  walk(path.join(webRoot, "src"), files);
  walk(path.join(webRoot, "public"), files);
  const hits: string[] = [];
  for (const abs of files) {
    const rel = path.relative(webRoot, abs);
    const found = leaksIn(rel, readFileSync(abs, "utf8"));
    for (const name of found) hits.push(`${rel}: ${name}`);
  }
  assert.deepEqual(hits, []);
});

test("the detector would have caught the leaks this change removed", () => {
  const samples: { rel: string; text: string }[] = [
    { rel: "index.html", text: "<title>OpenTakeoff — free</title>" },
    { rel: "src/components/PlanNavigator.jsx", text: '{"OpenTakeoff, an open project by Kentucky AI"}' },
    { rel: "src/components/PlanNavigator.jsx", text: 'href="https://opentakeoff.kentucky-ai.com"' },
    { rel: "index.html", text: '"url": "https://kentucky-ai.com"' },
    { rel: "public/privacy/index.html", text: "maintained by Michael Edlin / Kentucky AI" },
    { rel: "public/privacy/index.html", text: "mailto:michael@kentucky-ai.com" },
    { rel: "src/lib/markedset.js", text: "pg.drawSvgPath(starPath(0, 0, 11), { x: 52, y: 738, color: cobalt });" },
    { rel: "src/components/WorkspaceChrome.jsx", text: '<strong className="calm-brand">open<span>takeoff</span></strong>' },
    { rel: "public/terms/index.html", text: "OPEN TAKEOFF / LEGAL" },
    { rel: "src/lib/markedset.js", text: 'doc.setProducer("OpenTakeoff");' },
    { rel: "public/llms.txt", text: "# OpenTakeoff\n" },
  ];
  for (const sample of samples) {
    assert.ok(leaksIn(sample.rel, sample.text).length > 0, sample.text);
  }
});

test("the allowlist keeps the internal exceptions and nothing else", () => {
  const kept: { rel: string; text: string }[] = [
    { rel: "src/lib/branding.js", text: 'export const OT_NAME = "OpenTakeoff";\nexport const OT_CREDIT = "Measured with OpenTakeoff";\nexport const OT_WATERMARK = "Prepared with OpenTakeoff · opentakeoff.kentucky-ai.com";\ncoverTitle: "OpenTakeoff · Marked Set",' },
    { rel: "src/lib/dxf.ts", text: 'export const DXF_STAMP = "OpenTakeoff DXF export";' },
    { rel: "src/components/M365Jobs.jsx", text: 'folder in OpenTakeoff Projects, with its plans' },
    { rel: "public/.well-known/mcp.json", text: '"name": "io.github.Kentucky-ai/opentakeoff"' },
    { rel: "src/lib/gate.js", text: "OPENTAKEOFF_ONE_CLICK" },
    { rel: "package.json", text: '"name": "opentakeoff-mcp"' },
  ];
  for (const sample of kept) assert.deepEqual(leaksIn(sample.rel, sample.text), [], sample.text);
  // A new OpenTakeoff string in branding.js, outside the watermark lines, still fails.
  assert.ok(leaksIn("src/lib/branding.js", 'const label = "OpenTakeoff";').includes("OpenTakeoff"));
});
