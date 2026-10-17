import { readFileSync, writeFileSync, copyFileSync, readdirSync, statSync } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { PRIVATE_LOCKED_ENV_KEYS } from "./src/lib/privateBuild.js";
import { STRIPPED_HOSTS, stripPrivateHosts } from "./scripts/strip-private-hosts.mjs";

// The one source of truth for the app version — package.json — inlined as
// __APP_VERSION__ so contributions can carry generator_version without a
// runtime fetch. Guarded with `typeof` at the use site so the Node test
// runner (no Vite, no define) sees plain undefined instead of a crash.
const webDir = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = path.resolve(webDir, "..");
const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

const SOURCE_REPO = "https://github.com/rkoechel/opentakeoff";
const BANNED_HOSTS = [
  "fonts.googleapis.com",
  "fonts.gstatic.com",
  "cloudflareinsights.com",
  ...STRIPPED_HOSTS,
];

function sourceCommit() {
  const fromEnv = (process.env.OT_SOURCE_COMMIT || "").trim();
  if (/^[0-9a-f]{7,40}$/i.test(fromEnv)) return fromEnv.toLowerCase();
  try {
    const sha = execSync("git rev-parse HEAD", {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return /^[0-9a-f]{40}$/i.test(sha) ? sha.toLowerCase() : "";
  } catch {
    return "";
  }
}

const sha = sourceCommit();
const sourceHref = sha ? `${SOURCE_REPO}/commit/${sha}` : SOURCE_REPO;

const define = {
  __APP_VERSION__: JSON.stringify(pkg.version),
  __OT_FLOOR360_PRIVATE__: "true",
  __OT_SOURCE_COMMIT__: JSON.stringify(sha),
  "import.meta.env.VITE_OCR": JSON.stringify("off"),
};
for (const key of PRIVATE_LOCKED_ENV_KEYS) {
  define[`import.meta.env.${key}`] = JSON.stringify("");
}

const TEXT_FILE = /\.(html|js|mjs|css|svg|txt|xml|json)$/i;

function walkDist(dir, visit) {
  for (const name of readdirSync(dir)) {
    const abs = path.join(dir, name);
    if (statSync(abs).isDirectory()) {
      walkDist(abs, visit);
      continue;
    }
    if (!TEXT_FILE.test(name)) continue;
    visit(abs);
  }
}

// OpenTakeoff is a client-only static app: the takeoff canvas runs entirely in
// the browser (pdf.js + canvas + the geometry libs), persists to IndexedDB /
// localStorage, and builds to a static `dist/` you can host anywhere (GitHub
// Pages, Vercel, Netlify, an S3 bucket).
//
// This branch is the FLOOR360 private build. envPrefix hides every VITE_*
// value from the client bundle, and `define` blanks the sync / contribute /
// one-click / AI keys and forces VITE_OCR off, so a shell that has those
// variables set cannot turn the features on or inline a key. Runtime checks
// in src/lib/privateBuild.js are the second lock.
//
// The `/ai` proxy is OPTIONAL — it only matters if you run the bring-your-own-
// model AI sandbox in `../server` (see server/README.md). Without it, the app
// works fully; the AI hooks just stay dormant. The private CSP only allows
// connect-src 'self', so a remote AI endpoint is blocked in the browser.
export default defineConfig({
  plugins: [
    react(),
    {
      name: "floor360-source-link",
      transformIndexHtml(html) {
        return html.replaceAll("__OT_SOURCE_HREF__", sourceHref);
      },
    },
    {
      name: "floor360-strip-hosts",
      apply: "build",
      generateBundle(_options, bundle) {
        for (const item of Object.values(bundle)) {
          if (item.type === "chunk") item.code = stripPrivateHosts(item.code);
          else if (item.type === "asset" && typeof item.source === "string") item.source = stripPrivateHosts(item.source);
        }
      },
    },
    {
      name: "floor360-dist",
      apply: "build",
      closeBundle() {
        const dist = path.join(webDir, "dist");
        copyFileSync(path.join(webDir, "scripts", "floor360-static.mjs"), path.join(dist, "floor360-static.mjs"));
        copyFileSync(path.join(repoRoot, "LICENSE"), path.join(dist, "LICENSE"));
        copyFileSync(path.join(repoRoot, "NOTICE"), path.join(dist, "NOTICE"));
        // Public files are copied as-is. Strip again so a page that still
        // names a banned host cannot ship.
        walkDist(dist, (abs) => {
          const text = readFileSync(abs, "utf8");
          const next = stripPrivateHosts(text);
          if (next !== text) writeFileSync(abs, next);
        });
        const hits = [];
        walkDist(dist, (abs) => {
          const text = readFileSync(abs, "utf8");
          for (const host of BANNED_HOSTS) {
            if (text.includes(host)) hits.push(`${path.relative(dist, abs)} contains ${host}`);
          }
        });
        if (hits.length) {
          throw new Error("FLOOR360 private build still names a third-party host:\n" + hits.join("\n"));
        }
      },
    },
  ],
  define,
  // Nothing in the app uses this prefix, so no VITE_* value from the
  // environment or a .env file is copied into the client bundle.
  envPrefix: "VITE_FLOOR360_PRIVATE_ALLOW_",
  // On-device OCR (#469): ppu-paddle-ocr imports the bare `onnxruntime-web`,
  // which would bundle ORT's default (jsep) build and ship a second ~24 MB
  // wasm. Point it at the webgpu entry voice already uses, so both share the
  // one asyncify runtime. A regex, not a string key: a string also matches
  // `onnxruntime-web/…` prefixes and would break voice's own subpath imports.
  resolve: {
    alias: [{ find: /^onnxruntime-web$/, replacement: "onnxruntime-web/webgpu" }],
  },
  // The STT worker (stt.worker.ts, RFC #59) lazy-imports its engine adapter,
  // which needs code-splitting inside the worker bundle — only the ES format
  // supports that (Vite's default iife errors on split worker builds).
  worker: { format: "es" },
  server: {
    port: 5173,
    proxy: {
      // The sandbox's /ai routes are key-locked (server/README.md). Export the
      // same OT_SANDBOX_API_KEY in the shell running `npm run dev` and the
      // proxy stamps the header on — the browser never handles the secret.
      "/ai": {
        target: "http://localhost:8000",
        headers: process.env.OT_SANDBOX_API_KEY
          ? { "X-API-Key": process.env.OT_SANDBOX_API_KEY }
          : {},
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
