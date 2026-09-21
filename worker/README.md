# bom-aggregator (Cloudflare Worker)

The AI backend: a scheduled crawler that ingests supplier catalogs into a
Vectorize index, plus a search API (semantic retrieval → cross-encoder rerank →
lexical product-type bias) called by the GitHub Pages frontend in `../site`.

```
GitHub Pages (static)  ──fetch──►  Worker /api/search
                                     ├─ embed query        @cf/baai/bge-small-en-v1.5
                                     ├─ Vectorize query    (dense recall)
                                     ├─ rerank top hits    @cf/baai/bge-reranker-base
                                     └─ lexical bias       (chip vs board precision)
Worker cron (*/30)     ──►  crawl a slice → embed → upsert into Vectorize
```

## One-time setup

Prereqs: a Cloudflare account, Node 18+, and `npm i` here (installs `wrangler`).

```bash
npm install
npx wrangler login

# 1) Vectorize index — 384 dims to match bge-small-en-v1.5
npx wrangler vectorize create bom-products --dimensions=384 --metric=cosine
# metadata indexes so we can filter (optional but recommended)
npx wrangler vectorize create-metadata-index bom-products --property-name=supplier --type=string
npx wrangler vectorize create-metadata-index bom-products --property-name=in_stock --type=string

# 2) KV namespace for the ingestion cursor
npx wrangler kv namespace create CURSOR
#   -> copy the printed id into wrangler.jsonc (kv_namespaces[0].id)
```

Then edit `wrangler.jsonc`:
- `kv_namespaces[0].id` → the id from step 2
- `vars.ALLOWED_ORIGIN` → your Pages origin, e.g. `https://YOURNAME.github.io` (no trailing slash)

## Deploy

```bash
npx wrangler deploy
```

Note the deployed URL (e.g. `https://bom-aggregator.<subdomain>.workers.dev`) and
put it in `../site/index.html` as `API_BASE`.

## Bootstrap the index

The cron fills the index a few pages at a time. To seed it immediately, hit the
manual trigger a bunch (each call ingests one slice and advances the cursor):

```bash
for i in $(seq 1 40); do curl -s "https://bom-aggregator.<subdomain>.workers.dev/api/ingest" | tail -c 200; echo; done
```

Check it locally with `npx wrangler tail` to watch cron logs.

## Important caveats (read before relying on it)

- **Free-tier subrequests (50 per invocation)** are the real limit on crawl
  speed. The catalog is tens of thousands of products, so `MAX_PAGES_PER_RUN`
  is small and the index fills over many cron ticks (hours→days). Raise it and/or
  the cron frequency on a paid plan. For a fast initial bulk load you can instead
  run the Python tool in `../bomscraper` and push vectors yourself.
- **Prices/stock are "as of last crawl"** — they refresh only when the cursor
  re-crawls that page. Fine for browsing; verify on the vendor page before buying.
- **Reranker response shape**: `@cf/baai/bge-reranker-base` returns a `response`
  array; the code reads `{id|index, score}` defensively and falls back to the
  vector score if the shape differs. Confirm against `wrangler tail` and adjust
  `search.ts` if needed.
- **Cost**: embeddings are cheap; the reranker (a cross-encoder over ~40 titles
  per query) is the heavier call. Watch your Workers AI Neuron usage.
- **The `/api/ingest` endpoint is open** for convenience — protect it with a
  token or remove it before going public.

## Local dev

```bash
npx wrangler dev                 # serves the Worker locally
npx wrangler dev --test-scheduled  # then: curl "http://localhost:8787/__scheduled"
```
Vectorize/Workers AI calls run against the real Cloudflare services even in dev.
