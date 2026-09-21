/**
 * Search API (fetch handler). Pipeline:
 *   1. understand   — LLM splits the query into a semantic phrase + filters
 *   2. embed        — embed the clean semantic phrase (not the noisy raw query)
 *   3. dense recall — Vectorize topK
 *   4. hard filter  — price ceiling, in-stock, (best-effort) type/interface
 *   5. rerank       — cross-encoder over "title. categories", score normalized 0..1
 *   6. blend        — semantic + keyword hits + product-type bias + cheap bias
 *
 * The reranker returns unbounded logit-ish scores; step 5 min-max normalizes
 * them across the candidate set so the lexical adjustments (±~0.6) are on a
 * comparable scale and can actually reorder near-ties.
 */
import type { Env } from "./types";
import { lexicalAdjust, tokenize } from "./ranking";
import { understandQuery, type Understanding } from "./understand";

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

function json(env: Env, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders(env) },
  });
}

const STOCK_RANK: Record<string, number> = { true: 0, unknown: 1, false: 2 };

export function handleOptions(env: Env): Response {
  return new Response(null, { headers: corsHeaders(env) });
}

/** How many of the understanding keywords appear in a title/mpn/categories blob. */
function keywordHits(u: Understanding, blob: string): number {
  if (!u.keywords.length) return 0;
  let hits = 0;
  for (const k of u.keywords) if (k && blob.includes(k)) hits++;
  return hits / u.keywords.length; // 0..1
}

export async function handleSearch(url: URL, env: Env): Promise<Response> {
  const q = (url.searchParams.get("q") || "").trim();
  const inStockOnly = ["1", "true", "on"].includes(url.searchParams.get("in_stock") || "0");
  const top = Math.min(50, Math.max(1, parseInt(url.searchParams.get("top") || "24", 10)));
  const debug = url.searchParams.get("debug") === "1";
  if (!q) return json(env, { error: "missing q" }, 400);

  // 1) understand the query (LLM; falls back to raw query on any failure)
  const u = await understandQuery(q, env);

  // 2) embed the clean semantic phrase
  const emb = (await env.AI.run(env.EMBED_MODEL as keyof AiModels, {
    text: [u.semantic],
  } as any)) as unknown as { data: number[][] };
  const qvec = emb.data[0];

  // 3) dense retrieval (pull more than we show; filters may cut the list)
  const res = await env.VECTORIZE.query(qvec, { topK: 50, returnMetadata: "all" });
  let cands = (res.matches || []).map((m) => {
    const md = (m.metadata || {}) as Record<string, any>;
    return { meta: md, vscore: m.score ?? 0 };
  });

  // 4) hard filters
  if (inStockOnly) cands = cands.filter((c) => c.meta.in_stock === "true");
  if (u.price_max != null) {
    cands = cands.filter((c) => {
      const p = Number(c.meta.price);
      return !(p >= 0) || p <= u.price_max!; // keep unknown-price items
    });
  }
  if (cands.length === 0)
    return json(env, { query: q, understanding: debug ? u : undefined, count: 0, offers: [] });

  // 5) cross-encoder rerank over "title. categories" (richer than title alone)
  const contexts = cands.map((c) => {
    const t = String(c.meta.title || "");
    const cats = String(c.meta.categories || "").replace(/\|/g, ", ");
    return { text: cats ? `${t}. ${cats}` : t };
  });
  const rr: number[] = new Array(cands.length).fill(NaN);
  try {
    const out = (await env.AI.run(env.RERANK_MODEL as keyof AiModels, {
      query: u.semantic,
      contexts,
      top_k: contexts.length,
    } as any)) as any;
    const rows: any[] = out?.response ?? out?.results ?? [];
    for (const row of rows) {
      const idx = row.id ?? row.index;
      if (typeof idx === "number" && idx >= 0 && idx < rr.length) rr[idx] = row.score ?? 0;
    }
  } catch {
    // reranker unavailable -> fall back to vector score
  }

  // normalize the semantic score to 0..1 across the candidate set, so the
  // lexical/keyword adjustments below are on a comparable scale.
  const sem = cands.map((c, i) => (Number.isFinite(rr[i]) ? rr[i] : c.vscore));
  const lo = Math.min(...sem);
  const hi = Math.max(...sem);
  const span = hi - lo || 1;
  const semNorm = sem.map((s) => (s - lo) / span);

  // 6) blend
  const rows: ResultRow[] = cands.map((c, i) => {
    const md = c.meta;
    const price = Number(md.price);
    const reg = Number(md.regular_price);
    const inStock = md.in_stock === "true" ? true : md.in_stock === "false" ? false : null;
    const blob = `${String(md.title || "")} ${String(md.mpn || "")} ${String(md.categories || "")}`.toLowerCase();

    let score = semNorm[i]; // 0..1 semantic
    score += 0.5 * keywordHits(u, blob); // must-have tokens (part numbers, topology)
    score += 0.4 * lexicalAdjust(q, String(md.title || ""), md.mpn); // product-type bias
    if (u.type && blob.includes(u.type)) score += 0.15; // category/type match
    if (u.interface && blob.includes(u.interface)) score += 0.1;

    return {
      supplier: md.supplier,
      title: md.title,
      url: md.url,
      price: price >= 0 ? price : null,
      regular_price: reg >= 0 ? reg : null,
      on_sale: price >= 0 && reg >= 0 && price < reg,
      in_stock: inStock,
      image: md.image || null,
      mpn: md.mpn || null,
      sku: md.sku || null,
      score,
    };
  });

  rows.sort((a, b) => {
    const d = Math.round(b.score * 1000) - Math.round(a.score * 1000);
    if (d) return d;
    // tie-breakers: cheap bias (if asked), then stock, then price
    if (u.wants_cheap) {
      const pa = a.price ?? 1e12,
        pb = b.price ?? 1e12;
      if (pa !== pb) return pa - pb;
    }
    const s =
      STOCK_RANK[a.in_stock === true ? "true" : a.in_stock === false ? "false" : "unknown"] -
      STOCK_RANK[b.in_stock === true ? "true" : b.in_stock === false ? "false" : "unknown"];
    if (s) return s;
    return (a.price ?? 1e12) - (b.price ?? 1e12);
  });

  return json(env, {
    query: q,
    understanding: debug ? u : undefined,
    count: rows.length,
    offers: rows.slice(0, top),
  });
}
