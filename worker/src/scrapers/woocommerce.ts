/**
 * Generic WooCommerce Store API scraper (roboticsdna, zbotic) — TS port of the
 * Python woocommerce adapter. Reads /wp-json/wc/store/products.
 *
 * Quirks carried over from the Python version:
 *  - prices are integer strings in the currency minor unit (÷ 10^minor_unit),
 *  - some stores (roboticsdna) return an empty 200 body on a timed-out page:
 *    that's transient, not end-of-catalog. Keep per_page small there.
 */
import type { Offer } from "../types";
import { guessMpn, stripHtml, UA } from "./util";

export interface WooSupplier {
  id: string;
  base: string;
  perPage: number;
}

export const WOO_SUPPLIERS: WooSupplier[] = [
  { id: "roboticsdna", base: "https://roboticsdna.in", perPage: 20 },
  { id: "zbotic", base: "https://zbotic.in", perPage: 100 },
];

function price(prices: any, key: string): number | null {
  const raw = prices?.[key];
  if (raw === undefined || raw === null || raw === "") return null;
  const minor = Number(prices?.currency_minor_unit ?? 2);
  const n = Number(raw);
  return Number.isFinite(n) ? n / 10 ** minor : null;
}

function toOffer(sup: WooSupplier, p: any): Offer {
  const title = stripHtml(p.name ?? "");
  const images = Array.isArray(p.images) ? p.images : [];
  return {
    supplier: sup.id,
    title,
    url: p.permalink ?? "",
    supplierSku: p.sku || null,
    priceInr: price(p.prices, "price"),
    regularPriceInr: price(p.prices, "regular_price"),
    inStock: p.is_in_stock ?? null,
    image: images.length ? images[0]?.src ?? null : null,
    categories: (p.categories ?? []).map((c: any) => stripHtml(c.name ?? "")),
    mpn: guessMpn(title),
    supplierProductId: p.id != null ? String(p.id) : null,
  };
}

export interface WooPage {
  offers: Offer[];
  totalPages: number;
  transient: boolean; // empty 200 body -> retry this page, don't stop
}

export async function fetchWooPage(
  sup: WooSupplier,
  page: number,
): Promise<WooPage> {
  const url = new URL(`${sup.base}/wp-json/wc/store/products`);
  url.searchParams.set("per_page", String(sup.perPage));
  url.searchParams.set("page", String(page));
  url.searchParams.set("orderby", "date");
  url.searchParams.set("order", "desc");

  const resp = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/json" },
  });
  const totalPages = Number(resp.headers.get("X-WP-TotalPages") ?? page);
  if (!resp.ok) return { offers: [], totalPages, transient: false };
  const text = await resp.text();
  if (!text.trim()) return { offers: [], totalPages, transient: true };
  let batch: any[];
  try {
    batch = JSON.parse(text);
  } catch {
    return { offers: [], totalPages, transient: false };
  }
  return { offers: batch.map((p) => toOffer(sup, p)), totalPages, transient: false };
}

/** Live keyword search against one WooCommerce store's Store API (?search=). */
export async function searchWoo(sup: WooSupplier, query: string, limit = 10): Promise<Offer[]> {
  const url = new URL(`${sup.base}/wp-json/wc/store/products`);
  url.searchParams.set("search", query);
  url.searchParams.set("per_page", String(Math.min(limit, 20)));
  const resp = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
  if (!resp.ok) return [];
  const text = await resp.text();
  if (!text.trim()) return [];
  try {
    return (JSON.parse(text) as any[]).map((p) => toOffer(sup, p));
  } catch {
    return [];
  }
}
