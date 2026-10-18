# takeoff-runner

The FLOOR360 auto-takeoff worker (Phase 2 §4). It takes a bid's plans and finish schedule from Bids, runs the OpenTakeoff engine on them headless, and hands back an **AI draft**: the project file (`annotations.json`, `sheets.json`), the marked set PDF, the takeoff report, and a list of findings for the estimator. Nothing it writes is approved. An estimator reviews every draft before pricing.

It's off by default. With `RUNNER_ENABLED` unset, every job route answers `503 {"error":"runner disabled"}`, and nothing runs.

- **Engine:** the OpenTakeoff MCP server from this repository (`mcp/`, the same commit as the image), started as a child process over stdio for each job with `OPENTAKEOFF_ONE_CLICK=1`. A child rather than in-process: the flood engine and pdf.js are CPU-bound and synchronous, so in-process they'd block status and cancel requests, and a crash would take the API down with it. As a child, cancel and the 60-minute budget are a kill, and memory comes back when the job ends.
- **Vision:** the existing `takeoff-vision` model on the Spark, used for one narrow job: reading the printed scale note on a **scanned** sheet. That reading is reported to the estimator as a suggestion and never applied. Scale stays a human gate.
- **GPU priority stays with Orduh Up.** The runner asks for no GPU, never runs `docker`, and never starts, stops, or touches any container. When the model is down, it asks the existing waker (`infra/takeoff-vision-waker`), whose memory gate answers `no_memory` while Orduh Up needs the room. There's no paid or cloud fallback of any kind.

[CONTRACT.md](CONTRACT.md) is the field contract for Bids (job API, folder layout, `floor360-run.json`) and for the Draft banner and Approve gate (the `floor360AutoTakeoff` key).

## Settings

| Setting | Default | What it does |
|---|---|---|
| `RUNNER_ENABLED` | unset (off) | `1` turns the job API on. Anything else answers 503 on every job route. |
| `RUNNER_TOKEN` | unset | Bearer token Bids sends. Compared in constant time. Enabled without a token answers 503 `runner not configured`. |
| `RUNNER_HOST` / `RUNNER_PORT` | `127.0.0.1` / `8014` | Listen address. The image sets `0.0.0.0` inside the container. The host publishes `127.0.0.1:8014` only. |
| `RUNNER_DATA_DIR` | `/var/lib/takeoff-runner` | Jobs, uploaded files and outputs. |
| `RUNNER_CONCURRENCY` | `1` | Fixed: one job at a time. Any other value is ignored, with a log line. |
| `RUNNER_JOB_TIMEOUT_MIN` | `60` | Run budget. Time spent waiting for memory doesn't count. |
| `RUNNER_RETENTION_DAYS` | `7` | A job and every file of its own is deleted this long after it finishes (or after it was created, if it never ran). |
| `RUNNER_VERDICT_MIN_CONFIDENCE` | `0.9` | A room gets the agent's AGENT check mark only at or above this trace confidence, assigned from a schedule row and vector-traced. |
| `RUNNER_DPI` | `200` | Default render resolution for the vision crop (a job can ask for 72–300). The engine's vector tracing doesn't depend on it. |
| `VISION_BASE_URL` | `http://127.0.0.1:8010/v1` | takeoff-vision (vLLM, OpenAI-compatible). |
| `VISION_API_KEY_FILE` | unset | File holding the vLLM `--api-key`. Read when used, never logged. |
| `VISION_MODEL` | unset | Unset: the first id `/v1/models` lists. |
| `WAKER_URL` | `http://127.0.0.1:8012` | The takeoff-vision waker. |
| `WAKER_TOKEN_FILE` | unset | File holding the waker's `WAKER_TOKEN`. Unset: no waker calls; the model is tried as it is. |
| `NO_MEMORY_RETRY_MIN` / `NO_MEMORY_MAX_MIN` | `15` / `240` | On `no_memory` the job waits and retries every 15 minutes for up to 4 hours, then fails. |

Fixed limits: 80 sheets and 600 MB a job, 250 MB a file, 64 MB an upload chunk, one job at a time, and one vision request in flight (so one of takeoff-vision's two seats always stays free for estimators).

## Job API

All routes except `/health` need `Authorization: Bearer $RUNNER_TOKEN`.

| Route | Does |
|---|---|
| `GET /health` | `200 {"ok":true}`. No auth, no details. |
| `POST /jobs` | Manifest: `{runId, bidId, bidNumber, projectName, files:[{fileId, name, size, sha256, role}], scheduleRows?, options?:{includeElevations, dpi}}`. `role` is `plans`, `schedule`, `elevations` or `addendum`. 201 with the job. Over the size limits, the job is created already `failed` with the reason. |
| `PUT /jobs/:id/files/:fileId` | One chunk, `Content-Range: bytes start-end/total`, ≤ 64 MB. 202 while chunks are missing; 200 when the file is whole and its sha256 matches; 422 on a mismatch (the bytes are dropped; send the file again). |
| `POST /jobs/:id/start` | Queues the job. 409 until every file is uploaded. |
| `GET /jobs/:id` | Status `queued`, `starting`, `running`, `no_memory`, `done`, `failed` or `cancelled`; `progress.text` ("Finding rooms: page 3 of 12"); `findings`; `counts` (`sheets`, `rooms`, `conditions`, `rfisDrafted`); `outputs` (name, size, sha256). |
| `GET /jobs/:id/outputs/:name` | One output file (URL-encode the name). `X-Content-Sha256` carries its hash. |
| `POST /jobs/:id/cancel` | Cancels a queued or running job. |

## What a run does

1. Checks every file is a PDF and none is encrypted. An encrypted file fails the job and names the file.
2. Loads plans, addenda, the schedule, and elevations (only with `includeElevations`) as one set. More than 80 sheets fails the job.
3. Reads the sheet index and finds the room-finish and finish schedules. A schedule that's a scan the engine can't read becomes a finding; Bids' `scheduleRows` stand in.
4. Applies each plan sheet's printed scale when there's exactly one note. These scales are unconfirmed until a person confirms them in Scale review. Sheets marked NOT TO SCALE, sheets with several scale notes, and sheets with none are left unscaled and become findings.
5. Detects rooms on the scaled plan sheets and commits each under the floor finish its own room-finish schedule row states. When the PDF has no room-finish schedule, it uses Bids' rows that name rooms. A room with no row, or with two finishes, is reported and never measured under a guess.
6. Derives base (gross perimeter, with a finding that door openings weren't deducted) when the schedule has exactly one base type, and transitions where two finishes butt together.
7. Puts the agent's AGENT check mark (pencil, never the estimator's APPROVED seal) on rooms that traced cleanly.
8. Drafts RFIs for the questions the drawings left open (below).
9. Writes the project file marked as a draft, the marked set, the report (JSON and CSV), `floor360-run.json`, and `findings.json`.

### RFI drafts

Six kinds of finding become RFI drafts in the project's RFI register:

- no scale, or NOT TO SCALE
- a schedule row never drawn
- a room with no schedule row
- conflicting finishes
- an unreadable scanned schedule
- wall tile with no usable elevation

Each draft goes through the engine's `create_rfi`, so it's **pending**, raised by the agent (`origin.actor: "agent"`, `reviewed: false`). It sits on the sheet it concerns, with a revision cloud linked to it when the finding knows the spot. There's one RFI per (kind, sheet, tag). The drafts print in the marked set's RFI schedule, `counts.rfisDrafted` counts them, and each finding carries its RFI number in `rfi`.

**Nothing is sent.** An estimator accepts each draft in the register; a person exports or emails it. Drafting follows `RUNNER_ENABLED` like everything else here.

Wall tile is never measured by guess. Each wall-tile row becomes a finding for the estimator.

## Install on the Spark (Deployment, after Ryan OKs port 8014)

Nothing here is installed yet. **None of these steps touches the existing containers or services, or ports 8000–8003, 8010 (takeoff-vision) or 8012 (the waker).** The runner only calls 8010 and 8012 as a client, and only once Ryan turns it on.

1. **Check the facts first.**
   - Port free: `ss -ltn | grep -c ':8014 '` prints `0`. If 8014 is taken, use **8016** everywhere below (and check it the same way).
   - What takeoff-vision and the waker listen on: `ss -ltn | grep -E ':(8010|8012) '`. This decides the networking choice in step 5.
   - Docker is there: `docker version --format '{{.Server.Version}}'`.
2. **Build the image** from a checkout of the merged commit:
   ```bash
   docker build -f floor360/takeoff-runner/Dockerfile \
     --build-arg RUNNER_BUILD_SHA=$(git rev-parse HEAD) \
     -t takeoff-runner:$(git rev-parse --short HEAD) .
   ```
3. **Create the data directory and secret files** for a dedicated uid (10014, no host account):
   ```bash
   sudo install -d -m 0700 -o 10014 -g 10014 /var/lib/takeoff-runner
   sudo install -d -m 0755 /etc/takeoff-runner
   # the same vLLM key takeoff-vision already uses, and the waker's WAKER_TOKEN
   sudo install -m 0400 -o 10014 -g 10014 /dev/null /etc/takeoff-runner/takeoff-vision.key
   sudo install -m 0400 -o 10014 -g 10014 /dev/null /etc/takeoff-runner/takeoff-waker.token
   sudoedit /etc/takeoff-runner/takeoff-vision.key /etc/takeoff-runner/takeoff-waker.token
   ```
4. **Write the env file** (mode 600). Generate `RUNNER_TOKEN` on the Spark and never paste it into chat. Keep `RUNNER_ENABLED=0` until Ryan says to turn it on.
   ```bash
   sudo install -m 0600 -o root -g root floor360/takeoff-runner/takeoff-runner.env.example /etc/takeoff-runner.env
   sudoedit /etc/takeoff-runner.env   # RUNNER_TOKEN=$(openssl rand -hex 32); VISION_BASE_URL / WAKER_URL per step 5
   ```
5. **Start it.** Networking, from step 1:
   - takeoff-vision and the waker listen on `0.0.0.0`: set `VISION_BASE_URL=http://host.docker.internal:8010/v1` and `WAKER_URL=http://host.docker.internal:8012`.
   - They listen on the tailnet address: set `http://100.72.198.58:8010/v1` and `http://100.72.198.58:8012`.
   - Either way, run:
   ```bash
   docker run -d --name takeoff-runner \
     --restart unless-stopped \
     -p 127.0.0.1:8014:8014 \
     --cpus 6 --memory 12g --memory-swap 12g --pids-limit 512 \
     --user 10014:10014 --security-opt no-new-privileges --cap-drop ALL \
     --env-file /etc/takeoff-runner.env \
     --add-host=host.docker.internal:host-gateway \
     -v /var/lib/takeoff-runner:/var/lib/takeoff-runner \
     -v /etc/takeoff-runner/takeoff-vision.key:/run/secrets/takeoff-vision.key:ro \
     -v /etc/takeoff-runner/takeoff-waker.token:/run/secrets/takeoff-waker.token:ro \
     takeoff-runner:<short sha>
   ```
   - They listen on `127.0.0.1` only (the waker's default): a bridged container can't reach them. Use the host network instead: in the env file set `RUNNER_HOST=127.0.0.1` and keep `VISION_BASE_URL` / `WAKER_URL` at `127.0.0.1`, then run the same line with `--network host` in place of `-p 127.0.0.1:8014:8014` and `--add-host=...`. The API then binds the host's loopback only.

   There's deliberately no `--gpus`. [compose.example.yml](compose.example.yml) is the same thing as a Compose file.
6. **Smoke it** on the Spark:
   ```bash
   curl -s http://127.0.0.1:8014/health                                        # {"ok":true}
   curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:8014/jobs  # 503 while RUNNER_ENABLED=0
   docker inspect --format '{{.State.Health.Status}}' takeoff-runner          # healthy
   ```
7. **Add one cloudflared ingress rule** in the existing tunnel's `config.yml`, above the catch-all. It's an addition only; don't edit or remove any existing rule:
   ```yaml
     - hostname: takeoff-runner.floor360.com
       service: http://127.0.0.1:8014
   ```
   - For a dashboard-managed tunnel, add the public hostname `takeoff-runner.floor360.com` with service `http://127.0.0.1:8014`.
   - Put `takeoff-runner.floor360.com` behind the existing Cloudflare Access app (or a new app with the same service-token policy) so Bids' `SPARK_CF_ACCESS_CLIENT_ID` / `SPARK_CF_ACCESS_CLIENT_SECRET` work and nothing else does. `/health` behind Access is fine; Bids sends the token on every call.
   - Restart cloudflared, or let the dashboard push the change.
   - From outside: `curl -s -H "CF-Access-Client-Id: $ID" -H "CF-Access-Client-Secret: $SECRET" https://takeoff-runner.floor360.com/health` prints `{"ok":true}`; without the headers, Access refuses.
8. **Turn on (Ryan's call, later):** set `RUNNER_ENABLED=1`, then `docker rm -f takeoff-runner` and rerun the step 5 line. Bids gets `AUTO_TAKEOFF_RUNNER_URL=https://takeoff-runner.floor360.com` and `AUTO_TAKEOFF_RUNNER_TOKEN` (PR C).

**Rollback:** `docker rm -f takeoff-runner`, then remove the ingress rule (and the public hostname / DNS record if one was added) and restart cloudflared. Optionally `docker image rm takeoff-runner:<sha>`, and remove `/var/lib/takeoff-runner`, `/etc/takeoff-runner.env` and `/etc/takeoff-runner/`. No other container, service or port was changed, so there's nothing else to undo.

## Tests

From this directory, with `npm ci` run in `web/`, `mcp/` and here:

```bash
npm run typecheck && npm run lint && npm test
```

Every external service is a fake: the vision model, the waker and the clock. One test runs the real engine (the MCP server as a child) on `demo/sample-finish-plan.pdf` through the HTTP API on a loopback port, and opens its outputs with the web app's own loader. `web/test/takeoffRunner.test.ts` checks the deploy artifacts (no GPU, no docker calls, no secrets in the examples) inside the web suite.
