# Brief 24 — Search every country as well as Saudi Arabia

Asked for on 2026-10-07: "I don't want any discrimination between countries; results in any country should be good."

Until now only Saudi Arabia and the UAE had a `discovery.country` row (migrations 0018 and 0019). With a row, a country is searched in Arabic and English, with its name added to web searches and its main cities added to Maps searches. Every other country fell back to English only, with no country name and no cities. The prompts also said "Saudi Arabia and the Gulf", and persona terms could only be English or Arabic, because the search guessed a term's language from its alphabet.

## What changes

**1. Country settings are made once, for any country.** A new plan stage, `countries`, runs between `identify` and `personas`:
- For each of the job's countries without a `discovery.country` row, it asks Claude (`country` task) for:
  - the languages companies there use on their websites and Maps listings (ISO 639-1, at most 3; English is always added);
  - the country's name in each language, added to web searches;
  - its other names;
  - its main business cities (at most 12), each named in each language.
  - the IANA time zone of its main business city.
- The answer is saved as an ordinary `discovery.country` region row named "Search <country> (made by Claude)", in the same shape as the SA row.
- Every later search in that country reuses the row, and makes no Claude call.
- SA and AE keep their seeded rows.
- A rule's region must be in `regions`. A new country is added there in Claude's time zone, or UTC when the runtime does not know that zone.
- Rules are the platform's, so the row is written with the owning role through a new `rules.saveRegionValue`. A transaction advisory lock makes two jobs racing for the same new country write one row.
- Without the bridge the stage is skipped, and the country searches with the defaults as before.

**2. Persona terms carry their language.**
- The personas prompt is given the job's countries and the union of their languages. It returns each web term and Maps keyword as `{ term, lang }`, about 3 web terms and 2 Maps keywords per language (at most 12 and 8).
- Terms in a language none of the job's countries uses are dropped.
- `discovery_personas` gains `term_langs jsonb` (term → language) in migration `0024_discovery_term_langs.sql`. `search_terms` and `places_terms` stay plain text arrays, so the operator API and dashboard do not change.
- The search sends each term with its stored language as Serper's `hl`, and pairs it with the country name and city names in that language (falling back to English). Rows from before 0024 have no `term_langs`, and keep the old guess from the alphabet.

**3. The prompts name no region.**
- "Saudi Arabia and the Gulf" is gone from every prompt.
- Personas get the countries; triage and extract already get the country being searched.

**4. Only real country codes.**
- `countries` on the portal and operator routes must be codes `libphonenumber-js` knows (`isSupportedCountry`), so `XX` is a `400`.
- The default when none is sent stays `["SA"]`.

**5. The operator can see and correct the settings.**
- `GET /internal/discovery/countries` lists every `discovery.country` row: the code, the English name, the rule's name, the settings and when the row was created.
- `POST /internal/discovery/countries/:code` with `{ settings }` replaces the row, or creates it. The settings are validated, and the row is renamed "Search <country> (set by operator)".
- The dashboard's Discovery view gains a **Countries** page listing them, with a JSON editor per country.

## Not in this brief

- **Pool-fill matching** in `rank` still matches the product's English and Arabic aliases.
- **CR numbers** are still read for Saudi pages only. They are an identifier, never shown to portals.

## Done when

1. A job for `EG` with the bridge on asks Claude for Egypt's settings once and saves a region row made by Claude. A second `EG` job asks nothing.
2. A job for `TR` searches Turkish terms with `hl: tr`, the country name and Turkish city names. A term in a language Turkey does not use is dropped.
3. An `SA` job makes the same Claude calls and Serper queries as before.
4. No prompt names Saudi Arabia or the Gulf.
5. `XX` is refused with `400` on the portal and operator routes.
6. The operator lists the countries, corrects one, and the next job searches with the correction.
