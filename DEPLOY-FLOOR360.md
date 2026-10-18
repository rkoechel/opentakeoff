# FLOOR360 private deploy

This branch is the private build of OpenTakeoff for the FLOOR360 team. It is a static browser app. There is no database and no plan storage on the server. Plans stay in the signed-in user's browser.

Do not deploy from these notes until the pull request is reviewed. Nothing here creates an Azure resource.

## What this build changes

- No Cloudflare Web Analytics beacon, and no other third-party analytics script.
- Fonts are files under `web/public/fonts`, loaded by `web/src/styles/fonts.css`. The app does not request `fonts.googleapis.com` or `fonts.gstatic.com`. Each family is SIL Open Font License; the license texts are next to the files.
- Content-Security-Policy allows `connect-src 'self' blob: data:` plus exactly three Microsoft hosts for 365 sync (`https://login.microsoftonline.com`, `https://graph.microsoft.com`, `https://floor360com.sharepoint.com`), and same-origin `script-src` / `worker-src` (plus `wasm-unsafe-eval` for pdf.js, and `blob:` workers). `frame-src` allows only `https://login.microsoftonline.com` (MSAL's hidden silent-renewal iframe). `/redirect.html`, the MSAL redirect bridge, is the only page served with `frame-ancestors 'self'` / `X-Frame-Options: SAMEORIGIN`; every other page stays `DENY`.
- One-Click Area is on: the build defines `VITE_ONE_CLICK=1`. It is in-browser geometry over the plan's vector lines, with no network call and no key. Every proposal still goes through review before Create.
- Google sign-in / Drive, Contribute and bring-your-own AI stay off. Setting `VITE_GOOGLE_*`, `VITE_DRIVE_ROOT_FOLDER_ID`, `VITE_CLOUD_SYNC`, `VITE_CONTRIBUTE_ENDPOINT`, or `VITE_AI_*` in the build environment does not turn them on and does not inline those values. On-device OCR is on (see Build).
- Microsoft 365 sync is the one sync path this build can turn on, and only for the FLOOR360 tenant. It stays dark unless the build shell sets the values in "Microsoft 365 sync" below; they are validated and a bad value fails the build.
- The build deletes leftover host strings (`cdn.jsdelivr.net`, `huggingface.co`, `googleapis.com`, `opentakeoff.kentucky-ai.com`) from the artifact. `graph.microsoft.com` is kept for Microsoft 365 sync. Those calls are already unreachable with the flags above. The build fails if any of them remain in `dist`.
- The canvas footer, the empty-project screen, and the in-app guide each show a Source link to `https://github.com/rkoechel/opentakeoff/commit/<sha>` for the commit that was built. `LICENSE` and `NOTICE` stay in the repo and are copied into the artifact.

## Host

Use a Linux App Service, the same shape as build.floor360.com, with Easy Auth in front. The site root is the unzipped `web/dist` directory.

The startup command is:

```bash
node floor360-static.mjs
```

That file is `web/scripts/floor360-static.mjs`, copied into `dist` by `vite build`. It is plain Node, with no Express and no nginx. It listens on `PORT` (App Service sets this) and `0.0.0.0`, sends the CSP on every response, and serves `.mjs` as `text/javascript`. A missing extensionless path returns `index.html`. A missing file that has an extension returns 404.

`npx serve` is not the startup command. It does not apply this CSP, and it often serves `.mjs` as `application/octet-stream`, which makes the browser refuse the pdf.js worker and Vite's module chunks.

`web/public/staticwebapp.config.json` carries the same CSP, the `.mjs` MIME type, and an SPA fallback for Azure Static Web Apps. App Service does not read that file. `web/public/_headers` is the same policy for a Netlify-style host. Do not add a second CSP in `netlify.toml`; the browser enforces both. A test checks that the three policy strings match.

`blob:` and `data:` are on `connect-src` and `worker-src` includes `blob:` because pdf.js hands the worker a blob URL and can read a document from a blob or data URL. `script-src` includes `'wasm-unsafe-eval'` so pdf.js can compile its JPEG2000 wasm. That keyword does not allow `eval()`. `style-src` includes `'unsafe-inline'` because the canvas sets style from React. No third-party host is on any directive.

## Build

From a checkout of this branch, with Node 24 or newer:

```bash
cd web
npm ci
npm run build:floor360
```

`build:floor360` runs `scripts/stage-ocr-model.mjs` (downloads PaddleOCR PP-OCRv5 mobile det + English rec from pinned Hugging Face commits and checks each against its pinned sha256; about 13 MB, build time only), then `vite build`, then `scripts/check-ocr-dist.mjs`. The build fails if the models are missing, and still fails if any third-party host string is left in `dist`. At run time the browser fetches the models, the dictionary and the ORT wasm from this site only (about 36 MB once per browser, then cached). Plan images never leave the browser. Cache `web/public/models/ocr` between builds to skip the download.

The commit in the Source link is `git rev-parse HEAD` at build time. Set `OT_SOURCE_COMMIT` only when the build is not running inside the git checkout. It must be the full or abbreviated hex commit that is public on `rkoechel/opentakeoff`.

Build after the commit you intend to ship, so the baked SHA matches that commit.

## Artifact

Zip the contents of `web/dist` so `index.html` and `floor360-static.mjs` are at the root of the zip, not nested in a `dist/` folder:

```bash
cd web/dist
zip -r floor360-opentakeoff-dist.zip .
```

The zip also contains `LICENSE`, `NOTICE`, `staticwebapp.config.json`, and `_headers`. `web/dist/` is gitignored. Do not commit the zip.

Unzip it as the App Service site directory and start `node floor360-static.mjs`.

## App Service settings

| Setting | Value |
| --- | --- |
| Stack | Node 24 on Linux |
| Startup command | `node floor360-static.mjs` |
| `PORT` | Leave it. App Service sets it. The server reads `process.env.PORT`. |
| `SCM_DO_BUILD_DURING_DEPLOYMENT` | `false`. Deploy the zip of `dist`. Do not run `npm install` on the server. |
| `VITE_*` | Do not set any on the App Service. They are compile-time only: set the Microsoft 365 values in the build shell (below), never as app settings. |
| HTTPS only | On |
| Plan | The existing Build plan if it has room (no extra cost). Otherwise a new Linux B1. Do not use S1. |

No database, storage account, or API key is required. Easy Auth is the only sign-in. Azure OCR for hard scans adds the settings below.

A remote bring-your-own AI endpoint will not connect: `connect-src` is this origin only, and the AI settings are locked to this site's `/api/ai` proxy (below). On-device measuring does not need it.

## Azure OCR for hard scans (`/api/ocr/read`)

Import from schedule reads a raster box on-device first. When that read finds no table, the status bar offers **Hard scan? Read with Azure**. The browser sends one PNG of the box to this site's `POST /api/ocr/read` (same origin, so the CSP is unchanged). `floor360-ocr-read.mjs` (copied into `dist/`) sends it to Document Intelligence `prebuilt-read` and returns the text lines. The button appears only after `GET /api/ocr/read` reports `enabled: true`.

Resource: `di-floor360-build-prod` (centralus, F0 free tier, shared with Build). The App Service managed identity (principal `291e4922-f17b-4748-99bd-3b676f9c5310`) has **Cognitive Services User** on it, so no key is needed.

| App setting | Value |
| --- | --- |
| `DI_ENDPOINT` | `https://di-floor360-build-prod-e74ef.cognitiveservices.azure.com/` (required; `DOCUMENT_INTELLIGENCE_ENDPOINT` is read as a fallback) |
| `OCR_MONTHLY_PAGE_CAP` | `300` (default). F0 allows 500 free pages a month and Build shares them. Raise to `2000` only after a paid S0 tier is approved. |
| `OCR_USER_DAILY_CAP` | `100` (default), pages a UTC day per signed-in user |
| `OCR_USAGE_FILE` | Leave unset: `/home/data/opentakeoff/ocr-usage.json` (on `/home`, so it survives restarts and deploys) |
| `DI_KEY` | Leave unset. Fallback only when the managed identity is off. Use a Key Vault reference if it is ever needed. |
| `AZURE_CLIENT_ID` | Only when a user-assigned identity is used instead of the system one |

The managed identity token comes from App Service's `IDENTITY_ENDPOINT` / `IDENTITY_HEADER` (set automatically when the identity is on). This is the same managed-identity leg `DefaultAzureCredential` uses, done with `fetch`, because `dist` is deployed without `npm install`.

The route requires the Easy Auth user (`X-MS-CLIENT-PRINCIPAL-NAME`), counts one page for each image before calling Azure (it does not count a request Azure refuses), answers 429 with the cap that stopped it, and runs one Azure read at a time. HTTP 429 from Azure is retried after 1, 2, and 4 seconds. F0 limits are 2 pages and 4 MB a request: the route sends one page and refuses an upload over `OCR_MAX_IMAGE_BYTES` (default 4 MB). The browser lowers the render DPI until the PNG fits. Keys and tokens are never logged or returned.

## Takeoff agent on the DGX (`/api/ai`)

The agent's AI settings are locked to this site's own `/api/ai` (`floor360-ai-proxy.mjs`, copied into `dist/`). The browser holds no key and never calls the DGX. Local browser settings and `VITE_AI_*` are ignored. The proxy posts to `<AI_UPSTREAM_URL>/chat/completions` (vLLM, OpenAI-compatible, tool calling) and adds the credentials server-side.

| App setting | Value |
| --- | --- |
| `AI_UPSTREAM_URL` | `https://takeoff-vision.floor360.com/v1` (default). Not `spark-vision`, which belongs to Orduh Up. |
| `AI_MODEL` | The exact id from `<AI_UPSTREAM_URL>/models` (vLLM's served model name). Every request uses it. Leave it unset while the DGX model is down: the proxy then uses the first id `/models` lists once the model is up, and the app shows "AI starting" until then. |
| `AI_API_KEY` | vLLM `--api-key`, sent as `Authorization: Bearer`. Secret: use a Key Vault reference. |
| `CF_ACCESS_CLIENT_ID` | Cloudflare Access service token id, sent as `CF-Access-Client-Id` |
| `CF_ACCESS_CLIENT_SECRET` | Its secret, sent as `CF-Access-Client-Secret`. Secret: use a Key Vault reference. |
| `AI_MAX_CONCURRENT` | `2` (default). A third request at the same time gets 503 "AI busy". |
| `AI_MAX_TOKENS` | `4096` (default). Caps each request's `max_tokens`. |

Optional: `AI_MAX_BODY_BYTES` (default 20 MB) and `AI_TIMEOUT_MS` (default 120000).

### Start the model on demand (`AI_WAKER_URL`)

The DGX container stops itself after 15 minutes idle. When the model is down (no connection, or HTTP 502/503/504/52x), the proxy can start it through the waker in `infra/takeoff-vision-waker/` (install steps are in its README):

| App setting | Value |
| --- | --- |
| `AI_WAKER_URL` | `https://takeoff-vision.floor360.com/_waker`. Unset: no on-demand start (the app shows "AI starting" as before). |
| `WAKER_TOKEN` | Key Vault reference. The same value as `WAKER_TOKEN` on the Spark. Sent as `Authorization: Bearer` to the waker only, with the `CF-Access-*` headers. |
| `AI_WAKE_TIMEOUT_MS` | Optional, default `180000`: how long the proxy polls the waker's `/status` |
| `AI_WAKE_POLL_MS` | Optional, default `5000` |

- **One wake for the whole site.** The proxy POSTs `/wake` once. Until the waker reports `running`, every AI request gets 503 `{"state":"starting","retryAfter":10}` straight away, with no upstream call and no second wake.
- **Waiting in the browser.** The agent shows "Starting the takeoff AI… (usually ~1–2 min)" and retries every 10 s for up to 4 minutes. The AI settings status updates on its own.
- **Not enough memory.** If the waker reports `no_memory` (less than `MEM_THRESHOLD_GB` free, default 17 GB), the app shows "The AI server is out of memory right now. Ask Ryan to free memory on the DGX." The proxy holds that answer for 60 s before trying again.

The route requires the Easy Auth user. `GET /api/ai/status` reports `ready`, `busy`, `starting`, or `off`, and the AI settings dialog shows it. Upstream 429 is reported as busy. Upstream 502/503/504, Cloudflare 52x, a timeout, or no connection are reported as starting. A Cloudflare Access redirect, 401, or 403 is reported as "refused this site's credentials". Setting values are never logged or returned.

## Auto-takeoff worker on the DGX (`floor360/takeoff-runner`)

The AI takeoff run for new bids (Phase 2) runs on the DGX Spark, not on this App Service. `floor360/takeoff-runner/` is a Docker image with a job API on port 8014 (`127.0.0.1` only, behind the proposed `takeoff-runner.floor360.com` Cloudflare hostname). Bids pushes a bid's plans and finish schedule, polls, and pulls the AI draft: `annotations.json`, `sheets.json`, the marked set and the report, in the job-folder layout below.

- It's off unless the Spark's `/etc/takeoff-runner.env` sets `RUNNER_ENABLED=1` and `RUNNER_TOKEN`. Nothing is installed yet. Install waits for Ryan's OK on port 8014 ([its README](floor360/takeoff-runner/README.md)).
- It's CPU only and never touches a container. It reaches takeoff-vision only through the waker's memory gate, so Orduh Up keeps the GPU.
- This App Service needs no setting for it. The field contract for Bids and for the draft banner is [CONTRACT.md](floor360/takeoff-runner/CONTRACT.md).

## Easy Auth and Entra

Turn on Authentication for the app. Identity provider: Microsoft. Tenant: the FLOOR360 tenant, single tenant. Unauthenticated requests: redirect to the Microsoft login. Token store can stay off; the static app does not read the Easy Auth headers.

Register the app (or use the one Easy Auth creates) with only the sign-in scopes OpenID, profile, and email. Do not add Graph file permissions to the Easy Auth app; Microsoft 365 sync uses its own SPA registration (below).

Redirect URIs to include:

- `https://takeoff.floor360.com/.auth/login/aad/callback`
- `https://<app-name>.azurewebsites.net/.auth/login/aad/callback`

Assign the FLOOR360 users or group who should open the site. Easy Auth has no separate per-user charge on top of the App Service plan. This does not require an Entra ID P1 license.

## Custom domain

Host name: `takeoff.floor360.com`.

Add the custom domain on the App Service, point DNS at the app (CNAME to `<app-name>.azurewebsites.net`, plus the TXT record Azure shows for verification), and bind a managed certificate. Keep HTTPS only on.

After the first deploy, open the site, confirm the footer Source link is the commit you built, and confirm the browser's network panel shows only this host while the sample plan opens.

## Local check

Serve the artifact and watch the page:

```bash
cd web/dist
PORT=8080 node floor360-static.mjs
```

In another shell, from `web/`:

```bash
node scripts/check-outbound.mjs --origin http://127.0.0.1:8080
```

The script exits 0 only when the sample plan was requested and every page-attributed request stayed on `127.0.0.1` / `localhost` (plus `blob:` and `data:`).

## Microsoft 365 sync (SharePoint)

Off unless the build shell sets these. None is a secret (a SPA client id and a drive id are public by design), and they are compile-time, so set them where `npm run build` runs, not as App Service settings.

| Build variable | Value |
| --- | --- |
| `VITE_MSAL_CLIENT_ID` | `44d9ca99-bb5f-41f0-a233-2a09927dc60f` (the **FLOOR360 OpenTakeoff Sync** SPA registration) |
| `VITE_MSAL_TENANT` | Optional. Only `9febc8e3-0f0b-47cd-89b2-18542bb53d21` is accepted (the default) |
| `VITE_GRAPH_DRIVE_ID` | `b!UuoNfT-g1kiqnCJRLr0rxU6IJ66mWy9Ju1S9QFpjkaW57AwOksgUSYam09h7EKeZ` (Estimating site, Documents) |
| `VITE_GRAPH_FOLDER_ID` | `01NF4SHUHQPL6SK4HCAZDIH4FBNHIW7NFJ` (`OpenTakeoff Projects`) |
| `VITE_GRAPH_SCOPES` | Optional. `Sites.Selected` (default) or `Files.ReadWrite.All`. FLOOR360 uses `Sites.Selected`. MSAL adds `openid profile offline_access` itself. |

Estimating site id: `floor360com.sharepoint.com,7d0dea52-a03f-48d6-aa9c-22512ebd2bc5,ae27884e-5ba6-492f-bb54-bd405a6391a5`. `Sites.Selected` needs a **write** grant for the app on that site (`POST /sites/{site-id}/permissions` with `roles: ["write"]` for the client id above). Until the grant exists, reads and writes return HTTP 403. The project list and the canvas show that as "OpenTakeoff doesn't have write access to the Estimating site yet", not as a raw Graph error.

### Projects (one folder per job)

With the values set, `/` opens the project list at `/projects` (`/?local=1` keeps the browser-only canvas). The list shows the job folders under `OpenTakeoff Projects`, newest change first. **New project** creates a folder there. It refuses names that already exist and names SharePoint won't accept. Opening a job goes to `/?job=<folder id>`, which installs the same per-project store a Google Drive project uses:

- Plan PDFs are stored in the job folder itself.
- `annotations.json` and `sheets.json` are stored in `<job>/.opentakeoff/`.

The canvas's **Team projects** menu item returns to the list. PDFs go up with Graph's simple upload, so a single file is limited to 250 MB.

SPA redirect URIs on that registration: `https://takeoff.floor360.com/redirect.html` (and the `*.azurewebsites.net` twin if it is ever opened directly). `redirect.html` is the MSAL v5 redirect bridge, built from `web/redirect.html`.

Local check with the values set:

```bash
node --experimental-websocket scripts/check-outbound.mjs --origin http://127.0.0.1:8080 --allow-microsoft
```

`--allow-microsoft` accepts only the three hosts above. With the M365 values set, `/` redirects to `/projects`, so run the check on `/?local=1` (the sample-plan path makes no Microsoft request until someone signs in).
