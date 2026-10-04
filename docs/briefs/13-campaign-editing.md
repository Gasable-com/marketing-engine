# Brief 13 — Campaign editing

Read `CLAUDE.md` and `docs/ARCHITECTURE.md` first. Today a campaign is editable only as a draft, so fixing a typo in tomorrow's campaign means cancel and rebuild. This brief adds the three things mature tools have, and nothing else: take a campaign that has not started back to draft, edit a campaign between runs, and duplicate any campaign.

The rule behind brief 11 stays: nothing about a run changes while it is sending. A run in progress is still pause-or-cancel only.

## Part A — unschedule
`POST /v1/campaigns/:id/unschedule`: `scheduled` or `paused` → `draft`, only while the campaign has no runs at all.
- `next_run_at` is cleared and the waiting `campaign.run` job is cancelled in the same transaction. This is not optional: run jobs are singleton-keyed on `campaign:<id>:<runNo>`, so a stale waiting job would swallow the next schedule's job and fire at the old time.
- A campaign with any run → `409 already_started` (pause it and edit instead, or duplicate it). Any other state → `409 invalid_state`.
- Emits `campaign.unscheduled` (payload: `from`).

## Part B — edit between runs
`PATCH /v1/campaigns/:id` accepts a campaign that is `draft`, or `paused` with no run `expanding` or `sending`. Anything else → `409 not_editable`.
- Every create check still applies, except that `scheduledAt` must be in the future only when the patch sets it: a recurring campaign's `scheduledAt` is usually long past.
- For a paused campaign, `next_run_at` is recomputed from the edited fields with the runs so far, and any waiting `campaign.run` job is cancelled. `resume` then queues the next run at the new time, or finishes the campaign if the edit leaves no future run.
- Emits `campaign.edited` (payload: `changes: { field: { from, to } }`, only the fields that changed, and `appliesFromRun`, the run number the edit first affects). An edit that changes nothing emits nothing. This is how a report says "runs 1–3 used version A, run 4 on used B"; the event log is the record, no version table.

## Part C — duplicate
`POST /v1/campaigns/:id/duplicate`, optional body `{ name }`: a new `draft` copied from a campaign in any status.
- Copies audience, template, channel, purpose, variables, recurrence, timezone and throttle. `name` defaults to `<name> (copy)`. `scheduledAt` is copied only if it is still in the future.
- Goes through `createCampaign`, so every create check runs (a template deleted since → `400 template_not_found`). `201` with the new campaign.
- Emits `campaign.created` with `duplicatedFrom` in the payload.

## Tests, CI (`test/campaign-editing.test.ts`)
1. Unschedule a scheduled one-shot → `draft`, no waiting `campaign.run` job; edit its body and reschedule for a new time → exactly one waiting job, at the new time; `campaign.unscheduled` emitted.
2. Unschedule a campaign with a run → `409 already_started`; a draft → `409 invalid_state`.
3. Recurring campaign, run 1 done, pause, change template and throttle → `200`, `campaign.edited` with both changes and `appliesFromRun: 2`, the waiting run-2 job cancelled; resume → one run-2 job at the recomputed time; run 2 sends with the new template.
4. Paused with a run still `sending` → `409 not_editable`; `scheduled`, `running`, `done` → `409 not_editable`.
5. A paused recurring campaign whose `scheduledAt` has passed edits fine when the patch does not set it; setting a past one → `400 scheduled_at_past`.
6. Editing `maxRuns` down to the runs already done → `next_run_at` null; resume → `done`.
7. Duplicate a cancelled campaign → new draft with the same fields, `(copy)` name, `scheduledAt` null when the original's passed; the original is untouched; `duplicatedFrom` on the event. A custom `name` is used.
8. Tenant B can neither unschedule, edit nor duplicate A's campaign (404).

## Done when
CI passes; `docs/API.md` covers unschedule, the editable states, duplicate and the two events; row 13 in the roadmap in `docs/ARCHITECTURE.md`.

## Do not
- Allow any edit to a run that is `expanding` or `sending`.
- Add a campaign version table. The event log records edits.
- Touch the dashboard: it is read-only for campaigns, and clients change campaigns through `/v1`.
- Snapshot templates per run. Templates are still read by name at send time, so editing a template reaches campaigns that use it; that is a separate brief.
