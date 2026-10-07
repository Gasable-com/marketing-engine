# Brief 17b — Discovery in the dashboard (early)

Asked for directly on 2026-10-06, ahead of step 21: an operator wants to start a discovery search from the dashboard, by typing a product or pasting a row copied from the portal's product table, and to watch the job and read its ranked results there. It is tested on the staging dashboard.

This brings forward the read side and the new-search form of step 21. Reviewing results (approve, reject, merge, block a domain) stays in step 21.

## Engine

- `readRow(text)` in `src/modules/discovery/rows.ts`: from a pasted table row (tab-, pipe- or comma-separated; optionally with its header line above it) pick the product name and the category. With a header, by column name in English or Arabic; without one, the longest cell that reads as a name (not an id, price, date, URL, email or status word), and the next such cell as the category.
- `POST /internal/discovery/read-row` `{ row }` → `200 { product, category, cells, header, productIndex, categoryIndex }`, or `400 no_product` when no cell reads as a name. The operator sees what was picked and can change it before running.
- No migration. The job is created with the existing `POST /internal/discovery/jobs`.

## Dashboard

- A **Discovery** view: jobs (tenant and status filters), a **New search** form (tenant, pasted row or product, category, countries, result limit), and a job page with its tasks and ranked results (reasons, profile, identifiers), refreshed while the job runs.
- The dashboard renders; the engine decides (rule 9). Reading the row, validating and ranking all happen in the engine.

## Done when

- A row pasted into the form fills product and category from the engine's reading, the job runs on staging and its page shows its tasks and results.
- Engine and dashboard tests cover reading rows and rendering the views.
