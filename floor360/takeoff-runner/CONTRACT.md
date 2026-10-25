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

Bids picks the job folder, not the runner: new folders go under the bid's salesperson (`Unassigned` when blank; Ryan, 2026-10-18), while a bid that already has a folder keeps it (Bids stores the folder id). Older jobs sit directly under `OpenTakeoff Projects`; the web project list shows both, grouped by salesperson.

| Output | Save to (job folder = `OpenTakeoff Projects/<salesperson>/<set>`) |
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
  "runnerVersion": "0.1.0+<sha>", "engine": { "name": "opentakeoff-mcp", "version": "0.9.99" },
  "checklistItems": ["scales", "schedule_mapping", "areas_rooms", "seams_transitions", "waste_quantities", "shop_drawings", "submittal_docs", "rfis", "wall_tile_elevations"],
  "checklist": {},
  "counts": { "sheets": 12, "rooms": 31, "conditions": 7, "rfisDrafted": 0 },
  "findings": [ { "kind": "no_scale", "sheet": "A-101.pdf#3", "message": "…" } ]
}
```

- `status` is `"draft"` from the runner. PR D owns the other values (for example `"approved"`, with who and when). The runner never writes anything but `"draft"`.
- `checklistItems` is the Phase 1 §8 list. `wall_tile_elevations` appears only when the schedule has a wall-tile row. `checklist` is always `{}` from the runner. PR D records `{ "<item>": { "by": "<Easy Auth email>", "at": "<ISO time>" } }` there.
- Machine work stays pencil whatever the marker says: every shape is `origin.actor: "agent"`, `origin.reviewed: false`, every scale is `scale_confirmed: false`, and the only approval marks are the agent's AGENT diamonds. The runner can't create a human approval, and this key doesn't either.

**How the browser keeps it (PR D).** The key survives every save. `hydrate` in `TakeoffCanvas.jsx` keeps the loaded object as is (`readAutoTakeoff` in `web/src/lib/aiDraft.js`), and `buildTakeoffDocument` (`web/src/lib/takeoffDocument.js`) writes it back: `floor360AutoTakeoff` is in `TAKEOFF_DOCUMENT_KEYS` and in the [protocol inventory](../../protocol/INVENTORY.md). A value that isn't an object with a string `status` is dropped. Keys the browser doesn't read (`counts`, `findings`, `engine`, `jobId`, …) ride through unchanged.

- The **AI draft, not verified** banner and checklist show only when `status` is `"draft"` and this site's `FLOOR360_AI_DRAFTS` route is on. With the route off, the key is still carried and nothing new shows.
- The checklist is the eight items above, plus `wall_tile_elevations` when `checklistItems` lists it or a condition in the project is wall tile. The eight always show, and ids the browser has no label for are ignored. Each check writes `checklist.<item> = {by, at}`; unchecking deletes it and locks Approve again.
- **Approve AI takeoff** unlocks only when every item is checked. It sets `status: "approved"`, `approvedBy` and `approvedAt`. After that save lands, the browser tells Bids (`POST /api/bids/drafts/:runId/approved`, using `runId`) and stamps `bidsNotifiedAt`.
- Approving changes no shape's `origin.reviewed`, no `scale_confirmed` and no approval seal.
- RFI drafts are ordinary `rfis[]` records, which the browser already loads, saves and shows in the RFI panel.
- `.opentakeoff/floor360-run.json` is Bids' record. The browser doesn't read it.

### Finish TBD rooms (Ryan 2026-10-18)

A room the AI outlines but cannot match to a floor finish (no room-finish schedule row, no room on a Bids finish row, no finish tag printed inside it) is drawn, not dropped:

- It goes under the condition `FINISH-TBD` (name "Finish TBD", color `#8a8f98`), labeled `Finish TBD · <room>`, inside the run's AI draft proposal, so it is un-accepted and goes through normal AI draft review.
- The condition and each of its shapes carry `"finishStatus": "tbd"` in `annotations.json`.
- No TBD quantity is priced: the takeoff report JSON moves the row to `finish_tbd` and takes it out of `totals`, the CSV leaves it out, `counts.rooms` excludes it and `counts.tbdRooms` counts it. The browser leaves `finishStatus: "tbd"` rows out of the grand total.
- One `no_room_finish_match` finding (RFI "Room finishes needed") reads "N rooms drawn as Finish TBD; assign finishes." The estimator assigns a finish by changing the shape's condition before accepting.
- A sheet with a TBD room stays visible.
- `counts.roomsBySheet` gives, per plan sheet, `{ detected, withFinish, tbd }`

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
| `multiple_scales` | Several scale notes on one sheet; the title-block scale is applied to the main plan, check rooms in enlarged plans or details. |
| `scale_mismatch` | The scale applied does not match the scale note in the title block. |
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
| `low_confidence_rooms` | Rooms that did not trace cleanly; review those first. No room gets an AI check mark. |
| `scales_unconfirmed` | Every scale was set by the AI from the drawings; none is confirmed until checked in Scale review. |
| `run_summary` | One end-of-run line: sheets read, scaled, unscaled, hidden, rooms drawn, rooms to review, RFIs drafted. |
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

## Shop drawings

`POST /jobs/:id/shop-drawings` queues a shop-drawings run on the same one-at-a-time queue as a takeoff. `/health`, bearer auth, cancel, and `GET /jobs/:id` are unchanged. The runner plots a PDF. It does not email it, post it, or notify anyone.

Create the job with `POST /jobs` first. A shop-drawings-only job may send `files: []` with `options.shopDrawings: true` (no plan PDF). If the manifest lists PDFs, they must be uploaded before this call, the same rule as `POST /jobs/:id/start`. Page size then comes from the PDF (image px = PDF points × 2, the takeoff render scale) and the page is drawn dimmed under the rooms. A takeoff that already finished can be sent here again; its earlier outputs stay, and the shop-drawings files replace only their own names.

A body that isn't the shape below is `400` with one sentence, and the job is not queued. A body that is valid but the sheets are NTS, unconfirmed, unsized, or only detected becomes a **failed job** (`reason` is the sentence). No PDF is written.

### Input

```json
{
  "annotations": { "schema": "opentakeoff.takeoff_canvas.v1", "sheets": [], "conditions": [], "shapes": [] },
  "products": [
    { "finishTag": "CPT-1", "rollWidthFt": 12, "nap": "ew", "material": "carpet", "product": "Broadloom" },
    { "finishTag": "LVT-1", "tileWidthIn": 7, "tileHeightIn": 48, "pattern": "ashlar", "product": "LVT plank" }
  ],
  "overrides": { "rooms": { "<shape id or room label>": { "nap": "ns", "startEdge": 0 } } },
  "bid": { "projectName": "", "bidNumber": "", "address": "", "date": "2026-10-25", "drawnBy": "", "checkedBy": "", "rev": "0" },
  "approval": null,
  "sheetFrames": { "<sheet id>": { "widthPx": 2000, "heightPx": 1000 } },
  "base": { "tag": "B-1", "description": "rubber 4\"" },
  "transitions": [ { "between": ["CPT-1", "LVT-1"], "type": "T-1 reducer" } ]
}
```

`annotations` is required and is a reviewed `opentakeoff.takeoff_canvas.v1` document (sheets, shapes, conditions). Only `floor_area` shapes are drawn. A sheet entry may carry `width_px` and `height_px` when no PDF and no `sheetFrames` entry is available.

`products` is optional. Per finish tag: `rollWidthFt`, `rollLengthFt`, `tileWidthIn`, `tileHeightIn`, `pattern`, `nap` (`ew` / `east-west` or `ns` / `north-south`), `material`, `category`, `product`, and the roll allowances `seamAllowanceIn`, `wallOverageIn`, `doorwayOverageIn`. Omitted nap means east-west. Omitted tile size or pattern is reported; it is not invented.

`overrides.rooms` is optional, keyed by shape id or room label. `startEdge` is the ring edge whose midpoint is the tile start. `startNorm` is `[x, y]` in sheet-normalized coordinates and wins over the edge. `nap` and `base` override the finish.

`bid` fills the title block. Blank project name and bid number fall back to the job manifest. Blank date is the UTC day the run starts.

`approval` is optional. Omit it, or send `null`, and every sheet is DRAFT. `{ "name", "at" }` prints that name in the title block and in an APPROVED FOR INSTALL stamp, and drops the DRAFT watermark. The runner does not decide who may approve. Bids does.

`base` and `transitions` are optional and are used by the seam, pattern, and transitions sheets.

### Scale

The run refuses the whole set, and writes no PDF, if any sheet that has a floor room is marked NTS (`nts_sheets`, or a scale source that says NTS or unconfirmed), has `scale_confirmed: false`, has no `units_per_px`, or its scale is only `detected`. A detected scale is not a confirmed scale. It may be used only after a person sets `scale_confirmed: true`. A printed or entered scale (`calibrated`, `standard`, or a scale note such as `1/8" = 1'-0"`) may be used without that flag. The refusal is `GET /jobs/:id` `reason`. It says `scale not confirmed` and does not include a scale or a dimension. When the scale is confirmed, each plan sheet prints the scale source and a check dimension (longest edge of the largest room, in feet and inches). The plan is plotted to fit the sheet; the note says so.

A room with `origin.confidence` below 0.75, or `origin.low_confidence: true`, is flagged on the sheet and as a `low_confidence_rooms` finding. Missing roll width, tile size, pattern, nap, or base type is a `shop_drawing_note` finding. The run still draws.

### Output

Sheets are 11×17 in (ANSI B), landscape. Numbers: `SD-000` cover and index, `SD-101`… finish plans, `SD-201`… seam/roll plans, `SD-301`… tile/LVT pattern plans, `SD-401`… transitions and base. One sheet of each series per source sheet that has something to draw. A seam sheet is omitted when that finish has no `rollWidthFt`. A pattern sheet is omitted when that finish has no tile size. Transitions and base are drawn anyway: a missing base type reads "Base: type not specified", a doorway reads "TBD – verify", and a butt with no requested type reads "butt — type not specified".

Seam sheets run `rollgoods.js` per room, with that room's nap as the direction (default east-west) and the roll width from the input. Allowances default to a 2 in seam, 3 in wall and 1 in doorway, the same defaults as `defaultRollSetup`. The sheet draws the strips, the seams, a nap arrow, the cut list and the seam length. Pattern sheets start on the center of the longest wall, or the override, and are labeled "Start: verify at doorway center". Only committed butt joints are drawn as transitions. A gap wider than an inch is a doorway and is not given a T-number. The first version draws the whole adjacent run as that doorway. It does not locate the opening along the run.

Every sheet has a FLOOR360 title block: logo, Brandon Text, project, bid number, sheet number `SD-xxx`, sheet x of y, revision, date, drawn, checked, approved. Unapproved sheets carry a DRAFT watermark. Approved sheets name the approver.

| Output | Meaning |
|---|---|
| `<set> - shop drawings DRAFT.pdf` | No approval was sent. `<set>` is the same SharePoint-safe name as the takeoff. |
| `<set> - shop drawings.pdf` | An approval stamp was sent. Still only a file on this job. |
| `<set> - shop drawings.json` | `{ schema: "floor360.shop_drawings.v1", status: "draft" \| "approved", approval, pdf, sheets, warnings, errors, scales, lowConfidenceRooms }`. |

`GET /jobs/:id` is the status. `reason` is the refusal. `findings` lists low-confidence rooms and missing product data. `counts.sheets` is the page count. A file that was not written is absent from `outputs`.

Save the PDF under the job folder `Shop Drawings/` (Bids' layout, not the runner's). Nothing here is field-usable until a person stamps it, and this route never sends it.
