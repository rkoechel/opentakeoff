// Headless check for the FLOOR360 private build: load the app, open the
// sample plan, and fail if the page asks any host other than itself.
//
//   node scripts/check-outbound.mjs --origin http://127.0.0.1:8080
//   node scripts/check-outbound.mjs --origin … --allow-microsoft
//   node scripts/check-outbound.mjs --origin … --allow-microsoft --path "/?local=1"
//
// --allow-microsoft accepts the three Microsoft 365 sync hosts
// (strip-private-hosts.mjs ALLOWED_MICROSOFT_HOSTS) and nothing else; any
// other host still fails. CHROME_BIN overrides the Chrome lookup (Linux CI).
//
// Uses system Chrome (headless) and the DevTools protocol. A fresh
// user-data directory is created and removed. Chrome's own update checks are
// reported separately and do not count. Console text is scanned too, so a
// third-party URL that CSP blocks still fails the check.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import process from "node:process";
import { ALLOWED_MICROSOFT_HOSTS } from "./strip-private-hosts.mjs";

const CHROME_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
];

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : "";
}

const origin = (arg("--origin") || "").replace(/\/$/, "");
// --path: the page to open (default "/"); an M365 build lands on /projects,
// so its sample-plan check opens "/?local=1".
const startPath = arg("--path") || "/";
const screenshotPath = arg("--screenshot");
const allowedHosts = process.argv.includes("--allow-microsoft") ? new Set(ALLOWED_MICROSOFT_HOSTS) : new Set();
if (!origin) {
  console.error("usage: node scripts/check-outbound.mjs --origin http://127.0.0.1:PORT [--screenshot file.png]");
  process.exit(2);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function hostOf(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "blob:" || parsed.protocol === "data:" || parsed.protocol === "about:") return "";
    return parsed.hostname;
  } catch {
    return "";
  }
}

function isSelfHost(host) {
  return host === "" || host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
}

function chromeBin() {
  if (process.env.CHROME_BIN && existsSync(process.env.CHROME_BIN)) return process.env.CHROME_BIN;
  return CHROME_CANDIDATES.find((candidate) => existsSync(candidate)) || "";
}

const SAMPLE_LABEL_EXPR = String.raw`(() => {
  const label = (el) => (el.innerText || "").replace(/\s+/g, " ").trim();
  const button = [...document.querySelectorAll("button")].find((el) => /^(just open the sample plan|load sample plan)$/i.test(label(el)));
  return button ? label(button) : "";
})()`;

const SAMPLE_CLICK_EXPR = String.raw`(() => {
  const label = (el) => (el.innerText || "").replace(/\s+/g, " ").trim();
  const button = [...document.querySelectorAll("button")].find((el) => /^(just open the sample plan|load sample plan)$/i.test(label(el)));
  if (!button) return false;
  button.click();
  return true;
})()`;
const requests = [];
const consoleText = [];
let mainFrameId = "";

function isPageRequest(entry) {
  if (entry.url.startsWith(origin)) return true;
  if (entry.documentURL && entry.documentURL.startsWith(origin)) return true;
  if (entry.initiatorUrl && entry.initiatorUrl.startsWith(origin)) return true;
  if (entry.frameId && entry.frameId === mainFrameId) {
    if (entry.initiatorType === "parser" || entry.initiatorType === "script" || entry.initiatorType === "preload") return true;
    if (entry.url.startsWith("blob:") || entry.url.startsWith("data:")) return true;
  }
  return false;
}

function urlsIn(text) {
  return text.match(/https?:\/\/[^\s)'"<>]+/g) || [];
}

async function main() {
  const bin = chromeBin();
  if (!bin) throw new Error("Google Chrome was not found (set CHROME_BIN)");
  const debugPort = await freePort();
  const profile = mkdtempSync(path.join(tmpdir(), "ot-chrome-"));
  const chrome = spawn(bin, [
    "--headless=new",
    ...(process.getuid?.() === 0 ? ["--no-sandbox"] : []),
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-sync",
    "--disable-extensions",
    "--disable-component-update",
    "--disable-domain-reliability",
    "--disable-client-side-phishing-detection",
    "--disable-features=Translate,OptimizationHints,MediaRouter",
    "--remote-allow-origins=*",
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profile}`,
    "--window-size=1280,900",
    "about:blank",
  ], { stdio: "ignore" });

  let ws;
  try {
    let page = null;
    for (let i = 0; i < 50 && !page; i++) {
      await sleep(200);
      try {
        const list = await fetch(`http://127.0.0.1:${debugPort}/json/list`).then((res) => res.json());
        page = list.find((target) => target.type === "page");
      } catch { /* Chrome is still starting */ }
    }
    if (!page?.webSocketDebuggerUrl) throw new Error("Chrome did not open a DevTools page target");

    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", () => reject(new Error("DevTools socket failed")), { once: true });
    });

    let nextId = 0;
    const pending = new Map();
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id && pending.has(message.id)) {
        const { resolve, reject } = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) reject(new Error(JSON.stringify(message.error)));
        else resolve(message.result);
        return;
      }
      const params = message.params || {};
      if (message.method === "Network.requestWillBeSent") {
        requests.push({
          url: params.request?.url || "",
          type: params.type || "",
          frameId: params.frameId || "",
          documentURL: params.documentURL || "",
          initiatorType: params.initiator?.type || "",
          initiatorUrl: params.initiator?.url || "",
        });
      } else if (message.method === "Runtime.consoleAPICalled") {
        consoleText.push((params.args || []).map((item) => item.value ?? item.description ?? "").join(" "));
      } else if (message.method === "Runtime.exceptionThrown") {
        consoleText.push(params.exceptionDetails?.exception?.description || params.exceptionDetails?.text || "exception");
      } else if (message.method === "Log.entryAdded") {
        consoleText.push(params.entry?.text || "");
      }
    });

    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });

    await send("Network.enable");
    await send("Page.enable");
    await send("Runtime.enable");
    await send("Log.enable");
    const navigated = await send("Page.navigate", { url: `${origin}${startPath.startsWith("/") ? startPath : `/${startPath}`}` });
    mainFrameId = navigated.frameId || "";
    for (let i = 0; i < 40; i++) {
      const state = await send("Runtime.evaluate", { expression: "document.readyState", returnByValue: true });
      if (state.result?.value === "complete") break;
      await sleep(250);
    }

    let buttonText = "";
    for (let i = 0; i < 60 && !buttonText; i++) {
      const found = await send("Runtime.evaluate", {
        expression: SAMPLE_LABEL_EXPR,
        returnByValue: true,
      });
      buttonText = found.result?.value || "";
      if (!buttonText) await sleep(500);
    }

    let clicked = false;
    if (buttonText) {
      const click = await send("Runtime.evaluate", {
        expression: SAMPLE_CLICK_EXPR,
        returnByValue: true,
      });
      clicked = click.result?.value === true;
    }

    let samplePdf = false;
    for (let i = 0; i < 40 && !samplePdf; i++) {
      samplePdf = requests.some((entry) => entry.url.includes("sample-finish-plan.pdf"));
      if (!samplePdf) await sleep(500);
    }
    await sleep(3000);

    const timing = await send("Runtime.evaluate", {
      expression: `performance.getEntriesByType("resource").map((entry) => entry.name)`,
      returnByValue: true,
    });
    const resourceUrls = Array.isArray(timing.result?.value) ? timing.result.value : [];

    const links = await send("Runtime.evaluate", {
      expression: `(() => [...document.querySelectorAll("a")].filter((el) => /source/i.test(el.innerText || "") || /github\\.com\\/rkoechel\\/opentakeoff/.test(el.href)).map((el) => ({ text: (el.innerText || "").trim(), href: el.href })))()`,
      returnByValue: true,
    });

    let screenshot = "";
    if (screenshotPath) {
      const shot = await send("Page.captureScreenshot", { format: "png" });
      mkdirSync(path.dirname(screenshotPath), { recursive: true });
      writeFileSync(screenshotPath, Buffer.from(shot.data, "base64"));
      screenshot = screenshotPath;
    }

    const pageRequests = requests.filter(isPageRequest);
    const browserRequests = requests.filter((entry) => !isPageRequest(entry));
    const pageUrls = [...pageRequests.map((entry) => entry.url), ...resourceUrls];
    const pagePaths = [...new Set(pageUrls.map((url) => {
      if (url.startsWith("blob:")) return "blob:";
      if (url.startsWith("data:")) return "data:";
      try { return new URL(url).pathname; } catch { return url; }
    }))].sort();
    const pageHosts = [...new Set(pageUrls.map(hostOf))].sort();
    const nonSelf = pageHosts.filter((host) => !isSelfHost(host) && !allowedHosts.has(host));
    const allowedSeen = pageHosts.filter((host) => allowedHosts.has(host));
    const consoleHosts = [...new Set(consoleText.flatMap(urlsIn).map(hostOf))].filter((host) => host && !isSelfHost(host) && !allowedHosts.has(host)).sort();
    const browserHosts = [...new Set(browserRequests.map((entry) => hostOf(entry.url)).filter((host) => !isSelfHost(host)))].sort();

    const report = {
      origin,
      buttonText,
      clicked,
      samplePdfRequested: samplePdf,
      sourceLinks: links.result?.value || [],
      pageHosts,
      pagePaths,
      nonSelfPageHosts: nonSelf,
      allowedMicrosoftHosts: [...allowedHosts],
      allowedHostsSeen: allowedSeen,
      consoleNonSelfHosts: consoleHosts,
      browserOnlyHosts: browserHosts,
      pageRequestCount: pageUrls.length,
      screenshot,
      pass: clicked && samplePdf && nonSelf.length === 0 && consoleHosts.length === 0,
    };
    console.log(JSON.stringify(report, null, 2));
    if (!report.pass) process.exitCode = 1;
  } finally {
    try { ws?.close(); } catch { /* already closed */ }
    chrome.kill("SIGKILL");
    rmSync(profile, { recursive: true, force: true });
  }
}

const timer = setTimeout(() => {
  console.error("check-outbound timed out");
  process.exit(1);
}, 90000);
main().catch((err) => {
  console.error(err?.message || err);
  process.exitCode = 1;
}).finally(() => clearTimeout(timer));
