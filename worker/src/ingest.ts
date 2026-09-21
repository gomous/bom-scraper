/**
 * Scheduled (cron) ingestion: crawl a small slice of the vendor catalogs each
 * run, embed the products, and upsert them into Vectorize.
 *
 * Why a slice: Workers get a bounded number of subrequests per invocation (50
 * on the free tier). A full catalog is tens of thousands of products, so we
 * keep a cursor in KV and advance a few pages per cron tick — the index fills
 * over successive runs and then re-crawls for freshness. Bump MAX_PAGES_PER_RUN
 * (and/or the cron frequency) on a paid plan to fill faster.
 */
import type { Env, Offer, OfferMeta } from "./types";
import { offerId } from "./types";
import { WOO_SUPPLIERS, fetchWooPage } from "./scrapers/woocommerce";
import { robuCategorySlugs, fetchRobuCategoryPage } from "./scrapers/robu";

const ORDER = ["roboticsdna", "zbotic", "robu"];

interface Cursor {
  supplierIdx: number;
  page: number;
  robuCats: string[];
  robuCatIdx: number;
}

const DEFAULT_CURSOR: Cursor = { supplierIdx: 0, page: 1, robuCats: [], robuCatIdx: 0 };

async function loadCursor(env: Env): Promise<Cursor> {
  const raw = await env.CURSOR.get("ingest");
  return raw ? { ...DEFAULT_CURSOR, ...JSON.parse(raw) } : { ...DEFAULT_CURSOR };
}
async function saveCursor(env: Env, c: Cursor): Promise<void> {
  await env.CURSOR.put("ingest", JSON.stringify(c));
}

function advanceSupplier(c: Cursor): void {
  c.supplierIdx = (c.supplierIdx + 1) % ORDER.length;
  c.page = 1;
  c.robuCatIdx = 0;
}

function embedText(o: Offer): string {
  const cats = o.categories.slice(0, 6).join(", ");
  const mpn = o.mpn ? ` MPN ${o.mpn}` : "";
  return `${o.title}. ${cats}${mpn}`.slice(0, 1000);
}

function toMeta(o: Offer): OfferMeta {
  return {
    supplier: o.supplier,
    title: o.title.slice(0, 300),
    url: o.url,
    price: o.priceInr ?? -1,
    regular_price: o.regularPriceInr ?? -1,
    in_stock: o.inStock === true ? "true" : o.inStock === false ? "false" : "unknown",
    image: (o.image ?? "").slice(0, 400),
    mpn: o.mpn ?? "",
    sku: o.supplierSku ?? "",
    categories: o.categories.join("|").slice(0, 300),
    fetched_at: new Date().toISOString(),
  };
}

function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

async function embedAndUpsert(env: Env, offers: Offer[]): Promise<number> {
  const byId = new Map<string, Offer>();
  for (const o of offers) if (o.title && o.url) byId.set(offerId(o), o);
  const items = [...byId.entries()];
  const vectors: VectorizeVector[] = [];

  for (const part of chunk(items, 50)) {
    const texts = part.map(([, o]) => embedText(o));
    const res = (await env.AI.run(env.EMBED_MODEL as keyof AiModels, {
      text: texts,
    } as any)) as unknown as { data: number[][] };
    part.forEach(([id, o], i) => {
      vectors.push({ id, values: res.data[i], metadata: toMeta(o) as any });
    });
  }
  for (const part of chunk(vectors, 100)) {
    await env.VECTORIZE.upsert(part);
  }
  return vectors.length;
}

export interface IngestStats {
  supplier: string;
  pagesFetched: number;
  productsUpserted: number;
  cursor: Cursor;
}

export async function runIngest(env: Env): Promise<IngestStats> {
  const maxPages = Math.max(1, parseInt(env.MAX_PAGES_PER_RUN || "6", 10));
  const c = await loadCursor(env);
  const collected: Offer[] = [];
  let pages = 0;

  while (pages < maxPages) {
    const supplier = ORDER[c.supplierIdx];
    const woo = WOO_SUPPLIERS.find((s) => s.id === supplier);

    if (woo) {
      const { offers, totalPages, transient } = await fetchWooPage(woo, c.page);
      pages++;
      if (transient) {
        c.page++; // skip a timed-out page rather than stalling
        continue;
      }
      collected.push(...offers);
      if (offers.length === 0 || c.page >= totalPages) advanceSupplier(c);
      else c.page++;
    } else {
      // robu: (re)load category list at the start of a fresh cycle
      if (c.robuCatIdx === 0 && c.page === 1) {
        try {
          c.robuCats = await robuCategorySlugs();
          pages++;
        } catch {
          advanceSupplier(c);
          continue;
        }
      }
      if (c.robuCatIdx >= c.robuCats.length) {
        advanceSupplier(c);
        continue;
      }
      const slug = c.robuCats[c.robuCatIdx];
      const { offers, lastPage } = await fetchRobuCategoryPage(slug, c.page, 50);
      pages++;
      collected.push(...offers);
      if (offers.length === 0 || c.page >= lastPage) {
        c.robuCatIdx++;
        c.page = 1;
        if (c.robuCatIdx >= c.robuCats.length) advanceSupplier(c);
      } else {
        c.page++;
      }
    }
  }

  const upserted = collected.length ? await embedAndUpsert(env, collected) : 0;
  await saveCursor(env, c);
  return {
    supplier: ORDER[c.supplierIdx],
    pagesFetched: pages,
    productsUpserted: upserted,
    cursor: c,
  };
}
