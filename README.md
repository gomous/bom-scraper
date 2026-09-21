# bom-scraper

Aggregates product listings (price + stock + deep link) from Indian electronics
suppliers into one normalized, searchable index — the data layer for a BOM
management app for the Indian market.

It stores a **price/availability index that links back to each vendor**, not a
rehost of their catalogs. Every offer keeps its source URL.

## Supplier recon (2026-09)

| Supplier | Platform | Integration | Status |
|---|---|---|---|
| roboticsdna.in | WooCommerce Store API (~12.6k products) | `WooCommerceAdapter` | ✅ working |
| zbotic.in | WooCommerce Store API (Divi theme) | `WooCommerceAdapter` | ✅ working |
| robu.in | Next.js + custom GraphQL proxy (`/api/proxy/graphql/`) | `RobuAdapter` | ✅ working (search + bulk crawl; provides real `mpn`) |
| robokits.co.in | Custom PHP store, `Crawl-delay: 5`, anti-bot | HTML adapter | ⬜ TODO |

The WooCommerce adapter is generic — adding any other WooCommerce store
(Sunrom, Evelta, Quartz, ThinkRobotics, …) is one line in `suppliers.py`.
Confirm a candidate first:

```bash
curl -A 'Mozilla/5.0' 'https://SITE/wp-json/wc/store/products?per_page=1'
```

## Install & run

```bash
pip install -r requirements.txt

python -m bomscraper list-suppliers
python -m bomscraper ingest zbotic --limit 300      # bulk index a supplier
python -m bomscraper ingest all                     # full crawl (respects crawl delays)
python -m bomscraper search esp32 --in-stock        # search the local index (FTS5)
python -m bomscraper lookup esp32 --top 12          # LIVE cross-supplier price compare
python -m bomscraper serve                          # web search UI at http://127.0.0.1:8765
python -m bomscraper discover-robu                  # find robu's GraphQL query in its JS bundle
```

### Search relevance ([ranking.py](bomscraper/ranking.py))
Vendor search endpoints return loose matches, and merging by price alone floats
cheap dev boards above the bare part. The fix is classic IR, two stages:
1. **Recall** — `vendor_query()` strips product-*type* intent words ("chip",
   "ic", "bare", "module") that aren't literal title terms and sends the cleaned
   term (e.g. `esp32`) to each vendor for a broad candidate set.
2. **Precision** — `rank()` re-scores candidates against the original query:
   term coverage + exact-phrase + title-start position + MPN/SKU exact-match
   bonuses, then product-type intent (a "chip" query penalizes board/kit/case/
   cable titles and rewards wroom/ic/package-name titles; a "board" query does
   the reverse). Sort is relevance-first, with stock then price as tie-breakers.

So `esp32 chip` now ranks bare ESP32-WROOM modules above "ESP32 Dev Board" /
"Starter Kit" / "Case for ESP32", and `esp32 dev board` ranks the boards first.
No embeddings/LLM — see "Where AI would help" below.

### Where AI would *not* be needed (and where it would help)
Component search is keyword-precise (part numbers, packages, values), so classic
IR handles the bulk. Semantic/embedding search or an LLM only pays off for:
synonym/intent gaps ("buck converter" ≈ "step-down regulator"), fuzzy/typo
tolerance, and natural-language BOM lines. Those can bolt on later as an optional
re-rank stage; the deterministic ranker stays the fast default.

### Web UI (`serve`)
`python -m bomscraper serve` opens a browser search page (stdlib http.server, no
extra deps). Type a part → it fans the query to all suppliers in parallel and
shows merged results sorted cheapest-in-stock-first, with images, price (sale
highlighted), stock badge, MPN/SKU, and a link back to each vendor. `--port`,
`--host`, `--no-open` available.

`lookup` is the BOM use case: it hits each vendor's search endpoint live and
returns merged results sorted cheapest-in-stock-first, with source links.

## Architecture

```
adapters/base.py         PoliteSession (throttle + retry + browser UA) and the
                         SupplierAdapter interface (iter_offers, search)
adapters/woocommerce.py  generic WooCommerce Store API adapter (roboticsdna, zbotic, …)
adapters/robu.py         robu GraphQL executor + JS-bundle query discovery
models.py                Offer dataclass + best-effort MPN extraction from titles
ranking.py               relevance ranker (query intent + scoring; no ML)
store.py                 SQLite offer store with FTS5 full-text search
suppliers.py             registry mapping supplier id -> adapter
cli.py                   list-suppliers / ingest / search / lookup / discover-robu
```

### Known quirks
- **roboticsdna** intermittently returns an empty `200` body when a page times
  out server-side (and omits `X-WP-TotalPages` on that response). The adapter
  treats an empty body as a transient per-page timeout, skips it, and keeps the
  page count from the last good page — so a bad page no longer aborts the crawl.
  Keep its `per_page` small (20); it can't serve `per_page=100`.
- Vendor `sku` (e.g. `RDNA-C739.1`) is an internal SKU, **not** the manufacturer
  part number. `models.guess_mpn()` scrapes a likely MPN from the title to seed
  cross-supplier matching; treat it as a hint, not ground truth.

### robu GraphQL (how the adapter works)
Deep introspection is firewalled (`__schema.types` / `__type.fields` throw
"Internal server error"), so the queries were recovered from the Apollo client's
JS bundle via `discover-robu`. One resolver, `visibleMenuCategories`, serves both
modes: `parent:false, slug:"", search:"q"` flattens product hits for **search**;
`parent:true, slug:"<cat>"` gives clean per-category pagination for the **crawl**.
robu also exposes a real `mpn` field per product — unlike the WooCommerce sites —
which is the best seed we have for cross-supplier matching.

## Not done yet (the real product work)
1. **robokits** — polite HTML adapter (sitemap → JSON-LD), honour `Crawl-delay: 5`
   and avoid the faceted `sort=` crawl trap their robots.txt flags.
2. **Cross-supplier part matching** — dedup offers to canonical parts by MPN
   (robu supplies it directly; guess it from titles elsewhere), fuzzy fallback.
   This is where the BOM value lives.
3. **BOM resolver** — take a KiCad BOM (CSV/XML) and return sourcing options
   per line: cheapest in-stock across suppliers, total basket cost incl. GST.
4. **Refresh scheduling** — prices/stock move daily; incremental re-crawl.

## Legal / politeness
robots.txt is respected as a signal; several of these sites actively rate-limit
crawlers. Requests are throttled per supplier, retry with backoff, and identify
as a normal browser. Store as an index that links out — don't republish
catalogs wholesale.
