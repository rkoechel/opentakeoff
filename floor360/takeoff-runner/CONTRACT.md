# takeoff-runner contract

What the runner hands to **Bids** (PR C drives the job API; PR E saves the folder and sends the alert) and to **OpenTakeoff** (PR D: the Draft banner, the verification checklist and the Approve gate). Field names here are the runner's output today. Anything not listed is not promised.

## Job statuses

| Runner `status` | Bids status | Meaning |
|---|---|---|
| `queued` | `queued` | Waiting for its files, or for its turn (one job at a time). |
| `starting` | `starting` | The engine is starting, or the vision model is being woken. |
| `running` | `running` | `progress.text` says "page N of M". |
| `no_memory` | `no_memory` | The waker reports no memory. The runner retries every 15 minutes, up to 4 hours. |
| `done` | `saving` → `draft_ready` | Outputs are ready to pull. Bids saves them, then marks `draft_ready`. |
| `failed` | `failed` | `reason` is one plain sentence, safe to show on the bid as is. |
| `cancelled` | — | Cancelled through `POST /jobs/:id/cancel`. |

Failure reasons the runner writes: a file over 250 MB (named), over 600 MB in total, more than 80 sheets, an encrypted or non-PDF file (named), `The AI server is out of memory right now. Ask Ryan to free memory on the DGX.` after 4 hours, the 60-minute run budget, and an engine crash. Network failures between Bids and the runner, and SharePoint failures, are Bids' to word.

## Outputs and where they go

`GET /jobs/:id` lists `outputs: [{name, size, sha256, contentType}]`. `<set>` is `<project name> - <bid number>` with the characters SharePoint rejects removed, and the whole name kept to 120 characters or fewer. The bid number is never trimmed.

| Output | Save to (job folder = `OpenTakeoff Projects/<set>`) |
|---|---|
| each uploaded PDF (Bids already has them) | `<job folder>/<name>`, **byte-identical and under exactly the name in the manifest**. The name is the sheet key: shapes reference `"<name>"` and `"<name>#<page>"`. |
| `annotations.json` | `<job folder>/.opentakeoff/annotations.json` |
| `sheets.json` | `<job folder>/.opentakeoff/sheets.json`, **after filling in the ids** (below) |
| `floor360-run.json` | `<job folder>/.opentakeoff/floor360-run.json`, after adding Bids' own fields |
| `<set> - marked set.pdf` | `<job folder>/<set> - marked set.pdf` (the takeoff PDF) |
| `<set> - takeoff report.json`, `<set> - takeoff report.csv` | `<job folder>/`. The XLSX is the browser's: Report, then XLSX. The runner has no headless XLSX writer. |
| `findings.json` | Optional. The same findings are in `GET /jobs/:id` and inside `annotations.json`. |

A file the run couldn't produce is missing from `outputs` (for example, the marked set when the engine refused it). That miss is also a `step_failed` finding.

Re-runs (Phase 2 §5) are Bids' naming: `annotations.rev-<n>.json` and `<set> - marked set rev <n>.pdf`. A reviewed `annotations.json` is never overwritten. The runner always names its outputs as above.

### `sheets.json`

```json
{ "files": [ { "id": null, "name": "A101 Floor Plan.pdf", "role": "plans", "sha256": "…" } ] }
```

The browser (`web/src/lib/cloudStore.js`) lists sheets by `name` and downloads each PDF by `id`, the SharePoint driveItem id, which exists only after Bids uploads the file. **Bids replaces every `id` with the uploaded item's id** before saving. With `id: null` the project opens and lists its sheets, but can't download them. `role` and `sha256` are extra; the browser keeps them and ignores them. Order is load order.

## `annotations.json`: the draft marker

The file is the engine's own `opentakeoff.takeoff_canvas.v1` payload (`export_takeoff`), unchanged except:

- `project_name` is `<project name> - <bid number>` (a headless session leaves it empty);
- `nts_sheets` lists sheets the run found marked NOT TO SCALE (the browser's Scale review shows them as NTS);
- one additive top-level key, `floor360AutoTakeoff`, appended last:

```json
"floor360AutoTakeoff": {
  "status": "draft",
  "runId": "…", "bidId": "…", "bidNumber": "F360-26-0170", "projectName": "Perfumania Wauwatosa",
  "jobId": "…", "generatedAt": "2026-10-17T19:30:00.000Z",
  "runnerVersion": "0.1.0+<sha>", "engine": { "name": "opentakeoff-mcp", "version": "0.9.98" },
  "checklistItems": ["scales", "schedule_mapping", "areas_rooms", "seams_transitions", "waste_quantities", "shop_drawings", "submittal_docs", "rfis", "wall_tile_elevations"],
  "checklist": {},
  "counts": { "sheets": 12, "rooms": 31, "conditions": 7, "rfisDrafted": 0 },
  "findings": [ { "kind": "no_scale", "sheet": "A-101.pdf#3", "message": "…" } ]
}
```

- `status` is `"draft"` from the runner. PR D owns the other values (for example `"approved"`, with who and when). The runner never writes anything but `"draft"`.
- `checklistItems` is the Phase 1 §8 list. `wall_tile_elevations` appears only when the schedule has a wall-tile row. `checklist` is always `{}` from the runner. PR D records `{ "<item>": { "by": "<Easy Auth name>", "at": "<ISO time>" } }` there.
- Machine work stays pencil whatever the marker says: every shape is `origin.actor: "agent"`, `origin.reviewed: false`, every scale is `scale_confirmed: false`, and the only approval marks are the agent's AGENT diamonds. The runner can't create a human approval, and this key doesn't either.

**Known gap for PR D.** Today's browser keeps the key on load and drops it on the first save. `hydrate` in `TakeoffCanvas.jsx` reads only the fields it knows, and `buildTakeoffDocument` (`web/src/lib/takeoffDocument.js`) writes only `TAKEOFF_DOCUMENT_KEYS`. So the marker survives until an estimator edits the project, and then it's gone. PR D must either carry `floor360AutoTakeoff` through `hydrate` and `buildTakeoffDocument` (and add it to `TAKEOFF_DOCUMENT_KEYS` and the protocol inventory), or treat `.opentakeoff/floor360-run.json` as the durable record and the in-file key as a hint. The runner doesn't change the browser.

## `floor360-run.json`

```json
{
  "schema": "floor360.auto_takeoff_run.v1",
  "runId": "…", "bidId": "…", "bidNumber": "…", "projectName": "…", "jobId": "…",
  "status": "draft", "generatedAt": "…", "runnerVersion": "…", "engineVersion": "…",
  "inputsHash": "<sha256 of the sorted file sha256s, newline-joined>",
  "files": [ { "name": "…", "role": "plans", "size": 123, "sha256": "…" } ],
  "counts": { "sheets": 0, "rooms": 0, "conditions": 0, "rfisDrafted": 0 }
}
```

Bids adds `docSetHash` (its own hash: file content hashes plus the finish-schedule import id), the SharePoint folder id and URL, and its claim fields, then saves the file. A folder whose `floor360-run.json` carries this `bidId` is "ours" (Phase 2 §5).

## Findings

`{kind, message, sheet?, tag?, at?, rect?, detail?, rfi?}`. `message` is a plain sentence for the estimator. `sheet` is a sheet key. `at` and `rect` are image px (PDF points × 2, origin at the top left), the engine's coordinate space. Findings are deduplicated by `(kind, sheet, tag)`.

| `kind` | When |
|---|---|
| `no_scale` | No readable scale note. A scan may carry the AI's reading of the note as a suggestion; it's never applied. |
| `nts_sheet` | The sheet says NOT TO SCALE. |
| `multiple_scales` | Several scale notes on one sheet; left unscaled. |
| `schedule_row_not_drawn` | A Bids schedule row's tag appears on no plan sheet. |
| `tag_not_measured` | The tag is on a plan, but no room was measured under it. |
| `room_no_schedule_row` | A detected room has no schedule row. |
| `room_no_floor_finish` | The room's row states no floor finish, or can't be resolved for another stated reason. |
| `conflicting_finishes` | A room's cell names two finishes, a room is under two rows, or one tag is described two ways. |
| `unreadable_schedule` | The schedule file is a scan the engine can't read. |
| `wall_tile_no_elevation` | A wall-tile row with no usable elevation measurement. |
| `no_room_finish_schedule` | No readable room-finish schedule, and no Bids rows naming rooms. |
| `base_gross_perimeter` | Base derived as full perimeter; openings not deducted. |
| `base_multiple_types` | Several base types; base left for the estimator. |
| `transitions_withheld` | Finish changes across a wall that need a threshold at a doorway. |
| `low_confidence_rooms` | Rooms that didn't get the AGENT check mark. |
| `vision_unavailable` | The vision model was unavailable; scans keep their scale question. |
| `step_failed` | An engine step refused; `tag` names it. |

## RFI drafts (PR F)

These finding kinds become pending RFI drafts in the project's register: `no_scale` and `nts_sheet` (one scale question per sheet), `schedule_row_not_drawn`, `room_no_schedule_row`, `conflicting_finishes`, `unreadable_schedule` and `wall_tile_no_elevation`.

- They're written by the engine's `create_rfi`, so they land in `annotations.json` `rfis[]` with the panel's own numbering (`RFI-001`, …), `status: "open"`, `sheet_id`, and `origin: {actor: "agent", reviewed: false}`.
- A finding with `at` or `rect` also gets a `cloud` markup whose `rfi_id` links it to the draft.
- There's one draft per (kind, sheet, tag), and every finding it answers carries its number in `rfi`.
- A finding with no sheet in the set goes on the schedule sheet (else the first sheet) without a cloud.
- `counts.rfisDrafted` is the number drafted, and the marked set prints them in its RFI schedule.
- The runner never sends an RFI and has no way to. The estimator accepts each one in the RFI panel, and a person exports or emails it. `detail`, when present on a finding, is the text quoted into the RFI question.
