# Brief 20b — Did you mean? Confirm the product before searching

Asked for directly on 2026-10-07. A suppliers search for "Fundo Cement" was identified as plain Portland cement under an unknown "Fundo" brand, when the operator most likely meant Ciment Fondu. It then spent its search credits on the wrong product.

The first version of this brief paused the search itself in a `needs_input` status. That was dropped: the search will be used from the supplier portal, and a supplier who submits a search and leaves should never find it waiting on a question. The question moves to before the search exists, when the supplier is still looking at the screen.

## Identify first

`POST /internal/discovery/identify { product, category?, row? }` asks Claude what the product is and stores nothing.
- Claude's answer gains `confidence` (`certain`, `likely` or `unsure`) and up to 4 `alternatives` (`{ name, nameAr, description }`). It is `unsure` for a likely misspelling, an unknown brand or model, or words that fit more than one product.
- The response is `{ identified, didYouMean }`:
  - `didYouMean` is decided by the engine: `{ question, asked, best, alternatives }` when Claude is unsure and has other readings, else `null`;
  - `identified` is `null` without the Claude bridge.

## Then create the search with what was confirmed

`POST /internal/discovery/jobs` gains two optional fields:
- `identified`: the accepted identification from `identify`. Planning starts from it, with `identify` already done, and does not ask again.
- `confirmed: true`: the operator picked an alternative or chose "as typed". Planning identifies `product` and treats it as what the operator means.

A job never waits for the operator. An unsure identification inside planning, for a search created without this step, goes ahead with the most likely reading.

## Migration `0022_discovery_identify_first.sql`

- Undoes 0021 (already applied on staging): a job left `needs_input` is closed as `failed`, the status check drops `needs_input`, and `clarification` goes.
- Adds `product_confirmed boolean`.
- The job detail gives `productConfirmed`.

## Dashboard

Search first asks the engine what the product is ("understanding your product…"):
- When the engine sees no question, the search starts at once with that identification.
- When it asks, the form shows "did you mean": the best reading, the other readings, and "search as typed". One click starts the search.
- If identifying fails, the product is searched as typed.

## Tests

- `identify` returns `didYouMean` only when unsure, never offers the best reading twice, stores nothing, refuses a bad body, and answers `{ identified: null, didYouMean: null }` without the bridge.
- A search created with `identified` skips the `identify` call.
- A search created `confirmed` passes `confirmed: true` to Claude and never stops.
- A search created without the step never waits either.
