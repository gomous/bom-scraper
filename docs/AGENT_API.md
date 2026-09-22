# Agent Search API — `/api/lookup`

A key-gated component search endpoint for AI agents (Claude and other tools).
It runs the **same RRF hybrid search engine** as the public site (`/api/search`)
but returns a clean, LLM-friendly component shape and requires an API key.

- **Base URL:** `https://bom-aggregator.gomous-bom.workers.dev`
- **Endpoint:** `GET /api/lookup`
- **Auth:** required (fails closed — if the server has no key configured, the
  endpoint is unusable, never wide open).
- **Currency:** all prices are INR.

## Authentication

Pass the API key any one of three ways (checked in this order):

| Method | Header / param |
| --- | --- |
| Bearer token | `Authorization: Bearer <key>` |
| Custom header | `X-API-Key: <key>` |
| Query param | `?key=<key>` |

A missing or wrong key returns `401`:

```json
{ "error": "unauthorized", "hint": "pass the key via 'Authorization: Bearer <key>', 'X-API-Key: <key>', or '?key=<key>'" }
```

## Request

| Param | Type | Default | Notes |
| --- | --- | --- | --- |
| `q` | string | — | **required.** Free text: a part number (`STM32F765VIT6`), an MPN, or a description (`5v buck converter`, `wifi bluetooth microcontroller`). |
| `in_stock` | `1`/`true`/`on` | off | Only return in-stock offers. |
| `top` | int (1–50) | 24 | Max results. |

## Response

```json
{
  "query": "STM32F765VIT6",
  "currency": "INR",
  "count": 1,
  "live": true,
  "approximate": null,
  "note": null,
  "components": [
    {
      "title": "STM32F765VIT6-STMICROELECTRONICS-ARM MCU ... 100 Pins",
      "supplier": "robu",
      "mpn": null,
      "sku": "R151772",
      "price_inr": 833,
      "regular_price_inr": 833,
      "on_sale": false,
      "in_stock": true,
      "url": "https://robu.in/product/stm32f765vit6-.../",
      "image": "https://robu-prod-media.s3.ap-south-1.amazonaws.com/.../2849925.jpg"
    }
  ]
}
```

Field notes:

- `in_stock` is `true` / `false` / `null` (unknown).
- `live: true` — at least one result came straight from a vendor's own search
  (not the crawled index), i.e. fetched at query time.
- `approximate: true` + `note` — the query named a distinctive part number but no
  exact match exists anywhere, so the closest available parts are shown instead.
  When an exact part match is found, only exact hits are returned.
- `price_inr` / `regular_price_inr` are `null` when unknown; `on_sale` is true
  when `price_inr < regular_price_inr`.

## Examples

```bash
BASE="https://bom-aggregator.gomous-bom.workers.dev"

# Bearer
curl -H "Authorization: Bearer $KEY" "$BASE/api/lookup?q=STM32F765VIT6"

# X-API-Key header
curl -H "X-API-Key: $KEY" "$BASE/api/lookup?q=esp32&in_stock=1&top=5"

# Query param (handy for quick tests)
curl "$BASE/api/lookup?q=mpu6050&key=$KEY"
```

## Suppliers

`robu` (robu.in) · `zbotic` (zbotic.in) · `roboticsdna` (roboticsdna.in).
Coverage is the crawled dense index **plus** each vendor's live search, so a bare
IC the vendor stocks but was never crawled still surfaces.

## Notes for agents

- The endpoint is idempotent and read-only — safe to call freely.
- Exact part numbers are pinned first (verbatim MPN/SKU/title, hyphen-insensitive).
- Prices and stock reflect the moment of the call for `live` rows and the last
  crawl otherwise; treat them as indicative, and link the user to `url` to buy.
