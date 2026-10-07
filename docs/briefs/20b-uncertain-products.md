# Brief 20b — Ask when the product is unclear

Asked for directly on 2026-10-07, after a suppliers search for "Fundo Cement" was identified as plain Portland cement under an unknown "Fundo" brand, when the operator most likely meant Ciment Fondu (a calcium aluminate cement). The search then spent its Serper credits and Claude calls on the wrong product.

When identification is not sure what the product is, the job asks instead of guessing, and it asks before any search is spent.

## Identify

- The identify answer gains:
  - `confidence`: `certain`, `likely` or `unsure`;
  - `alternatives`: up to 4 distinct products the name could mean, each `{ name, nameAr, description }`, most likely first.
- The prompt says to answer `unsure`, rather than pick one, when:
  - the name could be a misspelling;
  - the brand or model is unknown;
  - the words could mean more than one distinct product.
- When the operator has clarified (below), Claude identifies the clarified product and does not ask again.

## A job that needs the operator

- An `unsure` identification with no clarification:
  - stops planning before `personas`;
  - sets the job to the new status `needs_input`;
  - emits `discovery.job.needs_input` with the alternatives.
- No personas, tasks, Serper calls or further Claude calls happen while it waits.
- `POST /internal/discovery/jobs/:id/clarify` with `{ "product": "Ciment Fondu (calcium aluminate cement)" }` (2–200 characters):
  - accepted only while the job is `needs_input`, else `409 not_waiting`;
  - stores `clarification`;
  - sets the job back to `planning` and plans again from `identify`, with the operator's words as the product to identify;
  - emits `discovery.job.clarified`;
  - returns the job, as `GET` does.
- `GET /internal/discovery/jobs/:id` gives `needsInput: { question, asked, alternatives } | null`, worked out by the engine, and `clarification`.
- `needs_input` joins the status filters.
- Migration `0021_discovery_clarify.sql`: the job status check gains `needs_input`, and the job gains `clarification text null` (at most 200 characters).

## Dashboard

On a job that needs input, the search page shows the question and Claude's alternatives as buttons, plus a box to type the product. Choosing one posts it to `clarify`, and the page carries on showing the job as it plans and runs.

## Tests

- An `unsure` identification:
  - leaves the job `needs_input`, with the alternatives in `needsInput`;
  - creates no personas and no tasks;
  - makes no personas call.
- Clarifying:
  - re-runs `identify` with the clarification in its input, then plans and runs as usual;
  - the second identification is never asked to be unsure again.
- A `likely` identification does not stop.
- Clarifying a job that is not waiting is `409`; a bad body is `400`.
