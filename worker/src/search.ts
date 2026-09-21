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
import type { Env, Offer } from "./types";
import { lexicalAdjust, tokenize } from "./ranking";
import { understandQuery, type Understanding } from "./understand";
import { productSearchRobu, searchRobu } from "./scrapers/robu";
import { WOO_SUPPLIERS, searchWoo } from "./scrapers/woocommerce";

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

function offerToRow(o: Offer): ResultRow {
  const p = o.priceInr ?? null;
  const r = o.regularPriceInr ?? null;
  return {
    supplier: o.supplier,
    title: o.title,
    url: o.url,
    price: p,
    regular_price: r,
    on_sale: p != null && r != null && p < r,
    in_stock: o.inStock ?? null,
    image: o.image ?? null,
    mpn: o.mpn ?? null,
    sku: o.supplierSku ?? null,
    score: 0,
  };
}

/**
 * Live fallback: the pre-built Vectorize index only holds what the cron has
 * crawled, so a part that exists at a vendor but isn't indexed (e.g. a bare IC
 * reachable only via robu's productSearch) would read as "no match". When the
 * index comes up empty we fan out to the vendors' OWN search live — robu's real
 * productSearch resolver + each WooCommerce store's ?search= — then rerank the
 * merged hits. Fresh, exact, and it makes part-number lookups work. Results are
 * flagged `live:true` so the UI can show "fetched live".
 */
async function liveFallback(u: Understanding, env: Env): Promise<ResultRow[]> {
  const q = u.raw;
  const tasks: Promise<Offer[]>[] = [
    productSearchRobu(q).catch(() => []),
    searchRobu(q, 8).catch(() => []),
    ...WOO_SUPPLIERS.map((s) => searchWoo(s, q, 8).catch(() => [])),
  ];
  const settled = await Promise.all(tasks);
  const byKey = new Map<string, Offer>();
  for (const list of settled)
    for (const o of list) {
      if (!o.title || !o.url) continue;
      const key = `${o.supplier}:${o.supplierProductId || o.supplierSku || o.url}`;
      if (!byKey.has(key)) byKey.set(key, o);
    }
  const offers = [...byKey.values()];
  if (offers.length === 0) return [];

  // rerank the live hits against the clean semantic phrase
  const rows = offers.map(offerToRow);
  try {
    const out = (await env.AI.run(env.RERANK_MODEL as keyof AiModels, {
      query: u.semantic,
      contexts: offers.map((o) => ({ text: `${o.title}. ${o.categories.join(", ")}` })),
      top_k: offers.length,
    } as any)) as any;
    const rr: any[] = out?.response ?? out?.results ?? [];
    for (const r of rr) {
      const idx = r.id ?? r.index;
      if (typeof idx === "number" && idx >= 0 && idx < rows.length)
        rows[idx].score = (r.score ?? 0) + 0.5 * keywordHits(u, `${offers[idx].title} ${offers[idx].mpn ?? ""}`.toLowerCase());
    }
  } catch {
    // no reranker -> lexical only
    rows.forEach((row, i) => {
      row.score = keywordHits(u, `${offers[i].title} ${offers[i].mpn ?? ""}`.toLowerCase()) + lexicalAdjust(q, offers[i].title, offers[i].mpn);
    });
  }
  rows.sort((a, b) => b.score - a.score);
  return rows;
}

/** How many of the understanding keywords appear in a title/mpn/categories blob. */
function keywordHits(u: Understanding, blob: string): number {
  if (!u.keywords.length) return 0;
  let hits = 0;
  for (const k of u.keywords) if (k && blob.includes(k)) hits++;
  return hits / u.keywords.length; // 0..1
}

/**
 * A "distinctive part token" is an alphanumeric run mixing letters AND digits,
 * long enough to be a real MPN (e.g. stm32f765vit6, atmega328p, lm2596) rather
 * than a plain word. These demand an EXACT presence: a query for stm32f765vit6
 * must not be satisfied by a lukewarm stm32f407 family cousin.
 */
function partTokens(q: string): string[] {
  return tokenize(q).filter(
    (t) => t.length >= 5 && /[a-z]/.test(t) && /[0-9]/.test(t),
  );
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
  let rrDiag: any = null;
  try {
    const out = (await env.AI.run(env.RERANK_MODEL as keyof AiModels, {
      query: u.semantic,
      contexts,
      top_k: contexts.length,
    } as any)) as any;
    const rows: any[] = out?.response ?? out?.results ?? [];
    if (debug) rrDiag = { topKeys: Object.keys(out || {}), nrows: rows.length, sample: rows[0] };
    for (const row of rows) {
      const idx = row.id ?? row.index;
      if (typeof idx === "number" && idx >= 0 && idx < rr.length) rr[idx] = row.score ?? 0;
    }
  } catch (e) {
    if (debug) rrDiag = { error: String(e) };
    // reranker unavailable -> fall back to vector score
  }

  // The reranker score is an ABSOLUTE relevance signal (a true match ~0.99, an
  // unrelated item ~0.001), so keep it raw — do NOT min-max normalize, which
  // would rescale the best of a garbage batch up to 1.0 and make "no stocked
  // match" look identical to a perfect hit. When the reranker failed for every
  // candidate we fall back to the cosine vector score, which lives on a higher,
  // fuzzier band, so the relevance floor is chosen per-mode.
  const reranked = rr.some((v) => Number.isFinite(v));
  const RERANK_FLOOR = 0.02; // below this the reranker considers it unrelated
  const VECTOR_FLOOR = 0.4; // cosine fallback: unrelated items still score ~0.3
  const floor = reranked ? RERANK_FLOOR : VECTOR_FLOOR;

  // 6) score + relevance gate. A row survives if the semantic signal clears the
  // floor OR an exact must-have keyword (part number / topology) is present —
  // the hybrid rescue that lets a lexical exact-match through even when the
  // embedding is lukewarm.
  const scored = cands.map((c, i) => {
    const md = c.meta;
    const price = Number(md.price);
    const reg = Number(md.regular_price);
    const inStock = md.in_stock === "true" ? true : md.in_stock === "false" ? false : null;
    const blob = `${String(md.title || "")} ${String(md.mpn || "")} ${String(md.categories || "")}`.toLowerCase();

    const semantic = Number.isFinite(rr[i]) ? rr[i] : c.vscore;
    const kw = keywordHits(u, blob); // 0..1 fraction of must-have tokens present
    let score = semantic;
    score += 0.5 * kw;
    score += 0.4 * lexicalAdjust(q, String(md.title || ""), md.mpn);
    if (u.type && blob.includes(u.type)) score += 0.15;
    if (u.interface && blob.includes(u.interface)) score += 0.1;

    const relevant = semantic >= floor || kw > 0;
    const row: ResultRow = {
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
    return { row, relevant };
  });

  const rows: ResultRow[] = scored.filter((s) => s.relevant).map((s) => s.row);
  let approximate = false; // true when we fall back to index family-cousins

  // Exact part-number guard: if the query names a distinctive MPN token and NO
  // indexed row actually contains it, whatever cleared the floor is only a
  // family cousin (stm32f765vit6 → stm32f407). Force the live fallback so the
  // exact part can surface, rather than confidently returning the wrong chip.
  const wantTokens = partTokens(q);
  const haveExact =
    wantTokens.length === 0 ||
    scored.some((s) => {
      const blob = `${s.row.title} ${s.row.mpn ?? ""} ${s.row.sku ?? ""}`.toLowerCase();
      return wantTokens.every((t) => blob.includes(t));
    });

  if (rows.length === 0 || !haveExact) {
    // Nothing in the pre-built index cleared the relevance floor (or only a
    // family cousin did). Try the vendors' own live search before giving up —
    // this is what makes exact part numbers (bare ICs robu carries but we
    // haven't crawled) resolve.
    const live = inStockOnly
      ? (await liveFallback(u, env)).filter((r) => r.in_stock === true)
      : await liveFallback(u, env);
    // Prefer an exact live hit for the part token when we have one.
    const liveExact =
      wantTokens.length === 0
        ? live
        : live.filter((r) => {
            const blob = `${r.title} ${r.mpn ?? ""} ${r.sku ?? ""}`.toLowerCase();
            return wantTokens.every((t) => blob.includes(t));
          });
    const chosen = liveExact.length > 0 ? liveExact : live;
    if (chosen.length > 0) {
      return json(env, {
        query: q,
        understanding: debug ? u : undefined,
        count: chosen.length,
        offers: chosen.slice(0, top),
        live: true,
        _diag: debug ? { reranked, floor, rrDiag, path: "live-fallback" } : undefined,
      });
    }
    // No live hit. If the index had family-cousin rows, show them (labelled);
    // otherwise it's a genuine no-match.
    if (rows.length === 0) {
      return json(env, {
        query: q,
        understanding: debug ? u : undefined,
        count: 0,
        offers: [],
        message: "No match found across the indexed or live supplier catalogs.",
        _diag: debug ? { reranked, floor, rrDiag } : undefined,
      });
    }
    // fall through: return the index rows below, flagged as approximate
    approximate = wantTokens.length > 0;
  }

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
    approximate: approximate || undefined,
    message: approximate
      ? "No exact part match; showing closest available parts."
      : undefined,
    _diag: debug ? { reranked, floor, rrDiag } : undefined,
  });
}
