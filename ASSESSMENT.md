# OpenTakeoff private team-test assessment

Assessment only for FLOOR360. Nothing was deployed, no cloud resources were created, nothing was pushed to `main`, and no money was spent. The clone succeeded: `https://github.com/rkoechel/opentakeoff` is a public fork of `Kentucky-ai/opentakeoff`. Tip tested: `9624be8` (`chore(deps): bump @modelcontextprotocol/sdk in /mcp (#532)`, 2026-10-10).

Recommendation: host the stock browser app as a static site on Azure App Service behind Easy Auth / Entra, at `takeoff.floor360.com`, the same sign-in pattern as Build. Do not turn on Microsoft 365 sync or Google Drive for the first test. Plans stay in each browser. That is enough for the team to try a real takeoff, and it does not add a database or a paid API.

## 1. Stack and dependencies

The product the team would test is `web/`. It is a client-only React app. There is no database and no required server.

| Piece | What it is | Version pin |
|---|---|---|
| Runtime | Node | `>=24` (`web/.nvmrc` and root `.nvmrc` are `24`). This Mac ran Node `v26.8.1` and npm `11.19.0`. |
| UI | React, react-dom, react-router | React `^18.3.1`, react-router `^7.18.2` |
| Build | Vite, TypeScript | Vite `^6.0.7` (built with `6.4.3`), TypeScript `^5.7.2` |
| Plans | pdfjs-dist, pdf-lib | pdfjs `^4.10.38`, pdf-lib `^1.17.1` |
| Geometry | Turf, JSTS | `@turf/*` `^7.3.5`, `jsts` `^2.12.1` |
| Archives | fflate | `^0.8.3` |
| On-device OCR / voice | onnxruntime-web, `@huggingface/transformers`, ppu-paddle-ocr | onnxruntime-web `1.26.0-dev.20260416-b7804b056c`, transformers `^4.2.0` |
| Optional Microsoft sync | `@azure/msal-browser` | `^5.19.0`, loaded only if that path is configured |
| Persistence | IndexedDB in the browser | no server |

`mcp/` (`opentakeoff-mcp` `0.9.98`, Node `>=20`) is a local stdio process an agent host launches. It is not required for the canvas. `server/` is an optional FastAPI sandbox (Docker base `python:3.12-slim`) for bring-your-own-model experiments. `protocol/` is dev-only checks, not a runtime.

Production today is a Netlify static build of `web/` (`netlify.toml`: base `web`, publish `dist`). A merge to upstream `main` is a deploy to `opentakeoff.kentucky-ai.com`. That pipeline is theirs. A private FLOOR360 host would build `web/dist` and serve the files.

## 2. License

`LICENSE` and `web/package.json` / `mcp/package.json` say **AGPL-3.0-only**. Upstream commit `fde1063` (2026-10-10) relicensed the project from Apache-2.0 to AGPL-3.0-only. This fork is that AGPL tree.

What that means for a private internal site, in plain terms (not legal advice; have counsel read the relicense before you modify and ship):

- FLOOR360 may run it and modify it internally.
- AGPL section 13 is the part that differs from a typical permissive license. If people interact with a **modified** copy over the network, those users must be able to get the corresponding source of the version they are using. For `takeoff.floor360.com` that means the FLOOR360 people who use the site, not a requirement to publish the fork to the world. An unmodified build can point at the upstream source. A modified build needs the team to be able to download that modified source (a private repo they can already reach is the usual way).
- Do not copy OpenTakeoff modules into the Bids app. Bids is proprietary. Importing this code, or vendoring it into the Bids server, can pull that combined work under AGPL. Consuming an exported CSV or JSON from a separate site does not do that. Keep them as two programs.

## 3. Does it build and run locally?

Yes. The canvas builds, the preview serves, and pdf.js reads the bundled sample finish plan.

Commands, from a fresh clone, on this Mac:

```sh
git clone --depth 1 https://github.com/rkoechel/opentakeoff.git
cd opentakeoff/web
npm ci
VITE_OCR=off npm run build
npx vite preview --host 127.0.0.1 --port 4173
```

Results:

- `npm ci` added 280 packages. npm reported 5 moderate vulnerabilities (see section 8). It warned that install scripts for esbuild, onnxruntime-node, and protobufjs were not covered by npm's allow-scripts list. The esbuild binary for darwin-arm64 was still present, and the build ran.
- `VITE_OCR=off npm run build` finished in 4.31s. Vite `6.4.3` transformed 836 modules and wrote `web/dist`. `VITE_OCR=off` was set so this smoke build does not stage the on-device OCR models (about 36 MB from Hugging Face). The app then reports OCR as off. The rest of the canvas does not need those models.
- Preview at `http://127.0.0.1:4173/` returned **200**. Title: `OpenTakeoff — free, AI-native takeoff for construction & flooring`. The page has `#root` and the built bundle `/assets/index-BPvG_qiz.js`.
- `http://127.0.0.1:4173/demo/sample-finish-plan.pdf` returned **200**, `1176246` bytes, PDF 1.7. That file is `web/public/demo/sample-finish-plan.pdf` (St. Cloud VA floor finish plan, two sheets).
- pdf.js (`pdfjs-dist/legacy/build/pdf.mjs`) opened that file: **2 pages**, **1110** text items on page 1. The first text is the field-finish note ("FIELD FINISH VENTS, GRILLES, ACCESS PANELS...").
- `node --import tsx --test --test-timeout=60000 test/pictures.test.ts`: **33 passed, 0 failed**, 6.9s. That file measures the demo sheets, including "demo sheets: no picture" and the render-scale pass.

The optional Python sandbox did **not** start. This Mac's `python3` is 3.9.6. `pip install -r server/requirements.txt` into a temp venv succeeded, then `uvicorn app:app` crashed on `type | None` syntax, which needs Python 3.10+. The project's own `server/Dockerfile` uses `python:3.12-slim`. That sandbox is not part of the canvas and was not required for the smoke test. No paid model key was used.

One-Click Area is off unless the build sets `VITE_ONE_CLICK=1`. A team test measures rooms with the Area tool. That matches upstream's current default.

## 4. Services and secrets

Default build, which is the one to test first: **no database, no file storage, no paid API, no AI key.**

| Need | Required? | Notes |
|---|---|---|
| Database | No | Workspace lives in IndexedDB on that browser. |
| File storage | No | A dropped PDF is parsed in the tab. Nothing is uploaded. |
| Paid AI / LLM | No | There is no OpenAI or similar key. Optional `/ai/*` calls a server you run, with a key you invent (`OT_SANDBOX_API_KEY`). Unset, those routes are locked (401). |
| Google | No | `VITE_GOOGLE_CLIENT_ID`, `VITE_GOOGLE_HD`, `VITE_PRICING_FILE_ID`, `VITE_DRIVE_ROOT_FOLDER_ID` are optional and public (they are inlined into the bundle). Leave them blank. |
| Microsoft Graph | No | `VITE_MSAL_CLIENT_ID` plus `VITE_GRAPH_DRIVE_ID` turn on experimental annotation sync. Leave them blank. |
| OCR / voice models | No for a first test | Build-time download from Hugging Face (OCR about 36.3 MB raw; voice about 44 MB), then served from your own host. The browser downloads them only after the person agrees. `VITE_OCR=off` skips OCR. |
| Contribute endpoint | No | `VITE_CONTRIBUTE_ENDPOINT` empty means the Contribute button sends nothing. |

Rough per-use cost of the default app: **$0 in API fees.** Cost is hosting only (section 6). Hugging Face downloads at build time are free. On-device OCR and voice, if you later enable them, run in the browser.

Each person's takeoff stays on that machine until they export. Two estimators do not see each other's work. That is the right privacy default for a test. Sharing numbers is an export (CSV, JSON, XLSX, marked-set PDF), not a live multiuser document.

## 5. Auth today

The app's own auth model, with no env vars, is **none**. `/` is an anonymous canvas. There is no account, no session, and no sign-in wall.

Two optional sign-in paths exist, and both stay dark unless the build sets them:

- **Google Workspace.** Browser PKCE / token client. No client secret in the repo. Access is meant to be limited by an Internal OAuth consent screen, not by `VITE_GOOGLE_HD` (that value is only a chooser hint). Used for shared Drive projects and a pricing file.
- **Microsoft Entra (experimental, issue #315).** MSAL popup against the tenant you name. Delegated Graph scope `Files.ReadWrite.All`. Tokens stay in the browser; there is no token relay. Upstream says the sync engine is proven against a mock Graph tenant and has not been proven against a live tenant. `Files.ReadWrite.All` is a wide permission (every file that user can already open). Do not grant that for a first test.

Neither path is a login wall in front of the static files. A private team test should put **our** gate in front: Azure App Service Easy Auth (Entra), same idea as `build.floor360.com`. People who are not in the tenant never receive the JavaScript. After they pass Easy Auth, the app still treats them as anonymous local users. Easy Auth does not create OpenTakeoff accounts.

## 6. Hosting recommendation

Use **Azure App Service (Linux) behind Easy Auth / Entra**, hostname `takeoff.floor360.com`.

Why this and not Cloudflare Access: the team already signs into Build with Entra. A second host on the same identity is one login. Cloudflare Access is a real option and is cheaper at this size, but it is a separate gate in front of a different network. The app is a pile of static files, so either host works technically. The fit with the current setup is Azure.

How lean it can be:

- **Best case, about $0 added.** If Build's existing App Service plan has spare capacity, add a second app (static `web/dist`, no database) on that same plan. Easy Auth is included. You still pay the plan you already pay. This stays inside the ~$150/month Azure budget because it does not add a SKU.
- **New plan, about $13/month.** A dedicated Linux Basic B1 is the smallest always-on plan that supports a custom domain and HTTPS. East US pay-as-you-go retail in 2026 is about $0.017/hour, roughly $12.41 to $13.14 per month (Azure retail figures cited for September 2026; confirm the region you actually use). No database SKU. Easy Auth is $0 on top. Entra ID for the users who already sign into Build is the license you already have; this does not require Entra ID P1.
- **Do not use Standard S1** for this test. It is about $69/month in the same East US figures, and a static canvas does not need slots or autoscale.

Cloudflare alternative, if you later want it:

- Cloudflare Pages (or any static host) at **$0**, plus Cloudflare Access. Access is **$0 for up to 50 users**, then **$7 per user per month** (Cloudflare Zero Trust Free vs pay-as-you-go, 2026). A flooring team under 50 seats would be $0. Custom domain `takeoff.floor360.com` works. You would sign in with whatever IdP you attach (Entra can be that IdP, which narrows the gap). Still a second product to administer.

Either way, read `docs/SELF_HOSTING.md` before you put nginx in front. The build emits `.mjs` chunks. Stock nginx serves those as `application/octet-stream`, and the browser then refuses the module. App Service usually gets this right; a custom proxy must map `.mjs` to `application/javascript`.

Also strip the Cloudflare Web Analytics beacon before a private build (section 8). And leave every `VITE_*` auth variable empty.

## 7. Overlap with Bids

Bids (`rkoechel/floor360-bid-pipeline`) imports a **Measure Square** takeoff only. The Order tab accepts `.fez` / `.fez.zip`, or the bare `_serialized_content.xml` from inside a `.fez`. The parser requires the `FepModel` graph (rooms, products, quantities). Any other XML is rejected as an unsupported takeoff.

OpenTakeoff does not write a `.fez` or a `FepModel` document. Its exports are:

- CSV and XLSX condition reports (net and waste-adjusted floor / wall / border area, linear feet, counts, materials)
- JSON envelope `opentakeoff.report.v1` (`web/src/lib/takeoffConstants.ts`, built in `web/src/lib/totals.js`): project name, sheets with scale source and whether a human confirmed the scale, conditions, per-sheet rows, totals, materials, markups, RFIs
- A marked-set PDF
- A project archive (the app's own sidecar, not a Measure Square file)

Those files will not pass the current Bids takeoff importer. They are a quantity report an estimator could type from, or that a future Bids feature could read on purpose. They are not a drop-in replacement for a Measure Square job, and they do not carry the room graph Bids already knows how to price.

For the team test, treat OpenTakeoff as a separate measuring tool. Do not block the test on a Bids importer. If a later project wants the numbers in Bids, the safe seam is a new importer for `opentakeoff.report.v1` (totals and finish tags only), kept out of the FepModel path, with no OpenTakeoff source linked into Bids.

## 8. Security

`npm audit` in `web/` (production tree included): **5 moderate, 0 high, 0 critical.** All five are one chain:

`sprintf-js` (GHSA-hp3w-g68c-fv3c, denial of service via unbounded precision) → `roarr` → `global-agent` → `onnxruntime-node` → `@huggingface/transformers`.

That chain is the on-device OCR / voice stack, not the PDF ingest path (`pdfjs-dist` / `pdf-lib`). `npm audit fix` was not run. Nothing here is a "don't host it" finding. Re-check the advisory before you enable OCR for the team.

File handling, from `web/src/lib/ingest.js` and `SECURITY.md`:

- PDFs, images, and zip plan sets are unpacked in the browser. A zip becomes PDFs locally. Nothing is posted to a server in the default build.
- Zip caps: depth 8, 2 GiB decompressed, 10,000 entries. Markup images have their own byte and pixel caps. A hostile archive can still freeze the tab; it does not reach a server.
- The MCP server, if someone runs it later, is a stdio subprocess that reads and writes paths the caller names. Do not expose it as a network service.

Outbound calls in a default page load:

- `web/index.html` loads `https://static.cloudflareinsights.com/beacon.min.js` (Cloudflare Web Analytics, no cookies). The token is in the HTML and the comment calls it public. **Remove that script tag for a FLOOR360 build** so a private test does not phone home to Cloudflare's analytics.
- `web/src/styles/tokens.css` imports Google Fonts (`fonts.googleapis.com` / `fonts.gstatic.com`). That leaks a page view to Google. Self-hosting those font files is a small follow-up if you want the private host to be quiet.
- `web/public/_headers` (applied by Netlify, not by `vite preview`) sets a strict script-src, and sets `connect-src *` on purpose so a bring-your-own AI endpoint can be any origin. For a build with no Google sign-in and no AI endpoint, narrow `connect-src` to `'self'` as that file's own comment describes.
- Optional, all off when unset: `googleapis.com` (Drive), `login.microsoftonline.com` / Graph (M365 sync), and whatever URL is in `VITE_CONTRIBUTE_ENDPOINT`. Contribute sends derived geometry only, never the PDF, and only if configured.

No Sentry, PostHog, or similar SDK showed up in `web/src`. Voice dictation is on-device; the privacy test in the repo treats network I/O during dictation as a failure.

## 9. Effort to a private team test

**2 days** for a private test of the stock canvas. That is the path above: static build, beacon removed, Easy Auth, `takeoff.floor360.com`, two people open the sample plan and one real set, work stays in the browser, export a CSV to look at.

| Work | Days | In the first test? |
|---|---|---|
| Private static host + Entra gate + custom domain + beacon removed | 1 to 2 | Yes |
| Confirm `.mjs` content type if a proxy sits in front | included | Yes |
| On-device OCR and voice (stage models, try a scan) | 0.5 | No. Text-layer plans work without it. |
| Experimental M365 annotation sync | 2 to 4, and a tenant admin has to consent `Files.ReadWrite.All` | No. Upstream has not proven it on a live tenant. |
| Bids importer for `opentakeoff.report.v1` | a separate change in Bids, not a host task | No. |

Do not start the M365 or Bids work until someone has used the canvas on a real FLOOR360 plan and still wants it.
