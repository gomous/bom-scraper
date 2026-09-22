/**
 * Search API (fetch handler) — hybrid retrieval fused by Reciprocal Rank Fusion.
 *
 * This engine used to be semantic-FIRST (embed -> Vectorize -> rerank) with
 * lexical matching bolted on as hand-tuned score bonuses + a relevance floor +
 * a special-case "live fallback" for exact parts. That blend was fragile: every
 * query class needed a new constant, and exact part numbers (STM32F765VIT6) that
 * were never crawled into the dense index simply could not surface.
 *
 * The rebuild follows what production search engines actually do (Elastic/Vespa
 * hybrid search, Typesense exact-match priority):
 *
 *   1. understand  — LLM splits the query into a semantic phrase + filters
 *   2. retrieve IN PARALLEL from independent retrievers, each returning a ranked
 *      list on its own scale:
 *        - dense    : Vectorize topK on the embedded semantic phrase (NL recall)
 *        - live x N : each vendor's OWN search engine (robu productSearch — the
 *                     typeahead that matches exact MPNs — robu category search,
 *                     and each WooCommerce store's ?search=). These ARE the
 *                     lexical/BM25 + typo + exact-match layer, and they close the
 *                     coverage gap: a bare IC the vendor stocks but we never
 *                     crawled comes straight from its own search.
 *   3. fuse        — RRF (rank-based, k=60). No raw-score weighting, no floors.
 *                    Multi-retriever agreement is rewarded automatically.
 *   4. rerank      — cross-encoder over the fused top-N for precise ordering
 *                    (absolute relevance score, kept raw — never normalized).
 *   5. order       — exact part-number matches pinned first (verbatim MPN/SKU/
 *                    title, hyphen-insensitive), then rerank score, then filters.
 */
import type { Env, Offer, OfferMeta } from "./types";
import { understandQuery, type Understanding } from "./understand";
import { tokenize, vendorQuery } from "./ranking";
import { rrfFuse, type RankedList } from "./fuse";
import { productSearchRobu, searchRobu } from "./scrapers/robu";
import { WOO_SUPPLIERS, searchWoo } from "./scrapers/woocommerce";

/** A retrieval candidate normalized from either the dense index or a live vendor. */
interface Cand {
  key: string; // supplier:normalized-url — stable across index & live for the same product
  supplier: string;
  title: string;
  url: string;
  price: number | null;
  regular_price: number | null;
  in_stock: boolean | null;
  image: string | null;
  mpn: string | null;
  sku: string | null;
  categories: string; // comma-joined, for reranker context + exact-match blob
}

interface ResultRow {
  supplier: string;
  title: string;
  url: string;
  price: number | null;
  regular_price: number | null;
  on_sale: boolean;
  in_stock: boolean | null;
  image: string | null;
  mpn: string | null;
  sku: string | null;
  score: number;
}

function corsHeaders(env: Env): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

/** Open CORS for the keyed agent endpoint: any origin, auth headers allowed. */
function corsHeadersOpen(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-Key",
    "Access-Control-Max-Age": "86400",
  };
}

function json(env: Env, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders(env) },
  });
}

const STOCK_RANK: Record<string, number> = { true: 0, unknown: 1, false: 2 };

export function handleOptions(url: URL, env: Env): Response {
  const headers = url.pathname === "/api/lookup" ? corsHeadersOpen() : corsHeaders(env);
  return new Response(null, { headers });
}

/** Collapse to bare alphanumerics so "MPU-6050", "mpu 6050" and "mpu6050" unify. */
function norm(s: string): string {
  return (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** Product-page URL, protocol/query/trailing-slash stripped — the cross-source key. */
function normUrl(u: string): string {
  return (u || "")
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/[?#].*$/, "")
    .replace(/\/+$/, "");
}

function candKey(supplier: string, url: string, sku: string | null): string {
  const u = normUrl(url);
  return `${supplier}:${u || sku || Math.random().toString(36).slice(2)}`;
}

function candFromMeta(md: OfferMeta): Cand {
  const price = Number(md.price);
  const reg = Number(md.regular_price);
  const sku = md.sku ? String(md.sku) : null;
  return {
    key: candKey(String(md.supplier), String(md.url), sku),
    supplier: String(md.supplier),
    title: String(md.title || ""),
    url: String(md.url || ""),
    price: price >= 0 ? price : null,
    regular_price: reg >= 0 ? reg : null,
    in_stock: md.in_stock === "true" ? true : md.in_stock === "false" ? false : null,
    image: md.image ? String(md.image) : null,
    mpn: md.mpn ? String(md.mpn) : null,
    sku,
    categories: String(md.categories || "").replace(/\|/g, ", "),
  };
}

function candFromOffer(o: Offer): Cand {
  const p = o.priceInr ?? null;
  const r = o.regularPriceInr ?? null;
  const sku = o.supplierSku ?? null;
  return {
    key: candKey(o.supplier, o.url, sku),
    supplier: o.supplier,
    title: o.title,
    url: o.url,
    price: p,
    regular_price: r,
    in_stock: o.inStock ?? null,
    image: o.image ?? null,
    mpn: o.mpn ?? null,
    sku,
    categories: o.categories.join(", "),
  };
}

function candToRow(c: Cand, score: number): ResultRow {
  return {
    supplier: c.supplier,
    title: c.title,
    url: c.url,
    price: c.price,
    regular_price: c.regular_price,
    on_sale: c.price != null && c.regular_price != null && c.price < c.regular_price,
    in_stock: c.in_stock,
    image: c.image,
    mpn: c.mpn,
    sku: c.sku,
    score,
  };
}

/**
 * Distinctive part tokens: alphanumeric runs that mix letters AND digits and are
 * long enough to be a real MPN (stm32f765vit6, atmega328p, lm2596, mpu6050) — not
 * a plain word. A query naming one demands a VERBATIM presence: it must be pinned
 * to an item that actually contains it, never satisfied by a family cousin.
 */
function partTokens(q: string): string[] {
  return tokenize(q).filter((t) => t.length >= 4 && /[a-z]/.test(t) && /[0-9]/.test(t));
}

/** Does this candidate contain EVERY distinctive part token, hyphen-insensitively? */
function isExactMatch(c: Cand, wantTokens: string[]): boolean {
  if (wantTokens.length === 0) return false;
  const blob = norm(`${c.title} ${c.mpn ?? ""} ${c.sku ?? ""} ${c.categories}`);
  return wantTokens.every((t) => blob.includes(norm(t)));
}

/** Fire every vendor's own search in parallel; each returns a ranked Offer list. */
async function liveRetrievers(u: Understanding): Promise<{ name: string; offers: Offer[] }[]> {
  const q = u.raw;
  const vq = vendorQuery(q); // strips "chip"/"ic"/"board" intent words for recall
  const jobs: { name: string; p: Promise<Offer[]> }[] = [
    { name: "robu_ps", p: productSearchRobu(q).catch(() => []) },
    { name: "robu_cat", p: searchRobu(vq, 10).catch(() => []) },
    ...WOO_SUPPLIERS.map((s) => ({ name: `woo_${s.id}`, p: searchWoo(s, vq, 10).catch(() => []) })),
  ];
  const settled = await Promise.all(jobs.map((j) => j.p));
  return jobs.map((j, i) => ({ name: j.name, offers: settled[i] }));
}

/** Cross-encoder rerank: returns key -> absolute relevance score for the given cands. */
async function rerank(cands: Cand[], query: string, env: Env): Promise<Map<string, number>> {
  const scores = new Map<string, number>();
  if (cands.length === 0) return scores;
  try {
    const out = (await env.AI.run(env.RERANK_MODEL as keyof AiModels, {
      query,
      contexts: cands.map((c) => ({ text: c.categories ? `${c.title}. ${c.categories}` : c.title })),
      top_k: cands.length,
    } as any)) as any;
    const rows: any[] = out?.response ?? out?.results ?? [];
    for (const row of rows) {
      const idx = row.id ?? row.index;
      if (typeof idx === "number" && idx >= 0 && idx < cands.length)
        scores.set(cands[idx].key, row.score ?? 0);
    }
  } catch {
    // reranker unavailable -> leave empty; caller falls back to RRF order
  }
  return scores;
}

interface SearchOut {
  status: number;
  body: Record<string, unknown>;
}

async function runSearch(url: URL, env: Env): Promise<SearchOut> {
  const q = (url.searchParams.get("q") || "").trim();
  const inStockOnly = ["1", "true", "on"].includes(url.searchParams.get("in_stock") || "0");
  const top = Math.min(50, Math.max(1, parseInt(url.searchParams.get("top") || "24", 10)));
  const debug = url.searchParams.get("debug") === "1";
  if (!q) return { status: 400, body: { error: "missing q" } };

  // 1) understand the query (LLM; falls back to the raw query on any failure)
  const u = await understandQuery(q, env);
  const wantTokens = partTokens(q);

  // 2) retrieve from all retrievers in parallel: dense (index) + live (vendors)
  const embedP = env.AI.run(env.EMBED_MODEL as keyof AiModels, { text: [u.semantic] } as any)
    .then((e: any) => e?.data?.[0] as number[] | undefined)
    .then((vec) => (vec ? env.VECTORIZE.query(vec, { topK: 40, returnMetadata: "all" }) : null))
    .catch(() => null);
  const liveP = liveRetrievers(u).catch(() => [] as { name: string; offers: Offer[] }[]);
  const [vecRes, live] = await Promise.all([embedP, liveP]);

  // normalize into candidates + build one ranked list per retriever
  const lists: RankedList<Cand>[] = [];
  const denseCands: Cand[] = ((vecRes?.matches || []) as any[])
    .map((m) => candFromMeta((m.metadata || {}) as OfferMeta))
    .filter((c) => c.title && c.url);
  if (denseCands.length) lists.push({ name: "vec", items: denseCands, key: (c) => c.key });
  for (const r of live) {
    const cs = r.offers.map(candFromOffer).filter((c) => c.title && c.url);
    if (cs.length) lists.push({ name: r.name, items: cs, key: (c) => c.key });
  }

  if (lists.length === 0)
    return {
      status: 200,
      body: {
        query: q,
        understanding: debug ? u : undefined,
        count: 0,
        offers: [],
        message: "No match found across the indexed or live supplier catalogs.",
      },
    };

  // 3) fuse by RRF. The representative item prefers the dense-index row (passed
  //    first: it carries image + categories that robu's productSearch omits).
  const LIVE_NAMES = new Set(live.map((r) => r.name));
  let fused = rrfFuse(lists, 60);

  // 4) rerank the fused head with the cross-encoder for precise ordering
  const HEAD = 30;
  const head = fused.slice(0, HEAD);
  const rrScores = await rerank(head.map((f) => f.item), u.semantic, env);
  const reranked = rrScores.size > 0;

  // 5) hard filters
  const pass = (c: Cand) => {
    if (inStockOnly && c.in_stock !== true) return false;
    if (u.price_max != null && c.price != null && c.price > u.price_max) return false;
    return true;
  };

  // 6) final ordering. Exact part-number matches are pinned to the top tier
  //    (Typesense-style verbatim priority); within a tier, cross-encoder score
  //    decides, then RRF, then the user's cheap/stock/price preferences.
  const ranked = fused
    .filter((f) => pass(f.item))
    .map((f) => {
      const exact = isExactMatch(f.item, wantTokens) ? 1 : 0;
      const rr = rrScores.get(f.key);
      const liveOnly = !f.ranks.vec && Object.keys(f.ranks).some((n) => LIVE_NAMES.has(n));
      return { f, exact, rr: rr ?? null, liveOnly };
    })
    .sort((a, b) => {
      if (a.exact !== b.exact) return b.exact - a.exact; // exact MPN hits first
      // reranker score is the precision signal when available (raw, unnormalized)
      const ra = a.rr,
        rb = b.rr;
      if (ra != null && rb != null && ra !== rb) return rb - ra;
      if (ra != null && rb == null) return -1;
      if (rb != null && ra == null) return 1;
      const d = b.f.score - a.f.score; // RRF fusion score
      if (Math.abs(d) > 1e-9) return d;
      if (u.wants_cheap) {
        const pa = a.f.item.price ?? 1e12,
          pb = b.f.item.price ?? 1e12;
        if (pa !== pb) return pa - pb;
      }
      const s =
        STOCK_RANK[a.f.item.in_stock === true ? "true" : a.f.item.in_stock === false ? "false" : "unknown"] -
        STOCK_RANK[b.f.item.in_stock === true ? "true" : b.f.item.in_stock === false ? "false" : "unknown"];
      if (s) return s;
      return (a.f.item.price ?? 1e12) - (b.f.item.price ?? 1e12);
    });

  // If the query names a distinctive part token, keep only exact hits when we
  // actually found any — a family cousin (stm32f407 for stm32f765vit6) must not
  // masquerade as the match. If none exist anywhere, fall through to closest.
  let approximate = false;
  let finalRanked = ranked;
  if (wantTokens.length) {
    const exacts = ranked.filter((r) => r.exact === 1);
    if (exacts.length) finalRanked = exacts;
    else approximate = ranked.length > 0;
  }

  if (finalRanked.length === 0)
    return {
      status: 200,
      body: {
        query: q,
        understanding: debug ? u : undefined,
        count: 0,
        offers: [],
        message: "No match found across the indexed or live supplier catalogs.",
        _diag: debug ? { reranked, lists: lists.map((l) => ({ name: l.name, n: l.items.length })) } : undefined,
      },
    };

  const offers = finalRanked.slice(0, top).map((r) => candToRow(r.f.item, r.rr ?? r.f.score));
  const live_flag = finalRanked.slice(0, top).some((r) => r.liveOnly);

  return {
    status: 200,
    body: {
      query: q,
      understanding: debug ? u : undefined,
      count: finalRanked.length,
      offers,
      live: live_flag || undefined,
      approximate: approximate || undefined,
      message: approximate ? "No exact part match; showing closest available parts." : undefined,
      _diag: debug
        ? {
            reranked,
            lists: lists.map((l) => ({ name: l.name, n: l.items.length })),
            fused: fused.length,
            topRanks: finalRanked.slice(0, 5).map((r) => ({ key: r.f.key, exact: r.exact, rr: r.rr, rrf: r.f.score, ranks: r.f.ranks })),
          }
        : undefined,
    },
  };
}

export async function handleSearch(url: URL, env: Env): Promise<Response> {
  const { status, body } = await runSearch(url, env);
  return json(env, body, status);
}

/**
 * Read a bearer/x-api-key/?key credential and compare it to the API_KEY secret.
 * Fails CLOSED: if API_KEY is unset the endpoint is unusable (never wide open).
 */
function checkApiKey(url: URL, req: Request, env: Env): boolean {
  if (!env.API_KEY) return false;
  const auth = req.headers.get("Authorization") || "";
  const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  const provided = bearer || req.headers.get("X-API-Key") || url.searchParams.get("key") || "";
  return provided.length > 0 && provided === env.API_KEY;
}

/** Agent-facing, key-gated search. Returns component details in a clean, LLM-friendly shape. */
export async function handleLookup(url: URL, req: Request, env: Env): Promise<Response> {
  const headers = { "Content-Type": "application/json; charset=utf-8", ...corsHeadersOpen() };
  if (!checkApiKey(url, req, env))
    return new Response(JSON.stringify({ error: "unauthorized", hint: "pass the key via 'Authorization: Bearer <key>', 'X-API-Key: <key>', or '?key=<key>'" }), { status: 401, headers });

  const { status, body } = await runSearch(url, env);
  const offers = (body.offers as ResultRow[] | undefined) ?? [];
  const components = offers.map((o) => ({
    title: o.title,
    supplier: o.supplier,
    mpn: o.mpn,
    sku: o.sku,
    price_inr: o.price,
    regular_price_inr: o.regular_price,
    on_sale: o.on_sale,
    in_stock: o.in_stock, // true / false / null(unknown)
    url: o.url,
    image: o.image,
  }));
  const out = {
    query: body.query,
    currency: "INR",
    count: body.count ?? components.length,
    live: body.live,
    approximate: body.approximate,
    note: body.message,
    components,
  };
  return new Response(JSON.stringify(out), { status, headers });
}
