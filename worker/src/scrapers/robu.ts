/**
 * robu.in scraper (custom GraphQL) — TS port of the Python RobuAdapter.
 *
 * One resolver, visibleMenuCategories, serves both modes:
 *   crawl:  parent:true,  slug:"<cat>"  -> clean single-group pagination
 *   search: parent:false, slug:"",      -> flattened product hits
 * `.data` is a LIST of category groups; each group has products + pagination.
 * Product fields include a real `mpn`. Product URL = /product/<slug>/.
 *
 * (Cloudflare's fetch presents a normal client, so the TLS-fingerprint 403 that
 * blocked python-requests on the HTML pages does not apply here.)
 */
import type { Offer } from "../types";
import { UA } from "./util";

const BASE = "https://robu.in";
const GQL = "https://robu.in/api/proxy/graphql/";

const PRODUCT_FIELDS =
  "id sku name slug price sale_price moq_price images in_stock mpn categories is_backorder";

const CATEGORY_LIST_QUERY =
  'query BomCats{ visibleMenuCategories(parent:true,slug:"",page:1,limit:500,sort:"latest",search:""){ data { id name slug } } }';

const CATEGORY_PRODUCTS_QUERY =
  "query BomCatProducts($slug:String!,$page:Int,$limit:Int){ visibleMenuCategories(parent:true,slug:$slug,page:$page,limit:$limit,sort:\"latest\",search:\"\"){ data { products {" +
  PRODUCT_FIELDS +
  "} pagination { total last_page current_page } } } }";

const SEARCH_QUERY =
  "query BomSearch($search:String!,$page:Int,$limit:Int){ visibleMenuCategories(parent:false,slug:\"\",page:$page,limit:$limit,sort:\"latest\",search:$search){ data { products {" +
  PRODUCT_FIELDS +
  "} } } }";

async function gql(query: string, variables: Record<string, unknown>): Promise<any> {
  const resp = await fetch(GQL, {
    method: "POST",
    headers: {
      "User-Agent": UA,
      "Content-Type": "application/json",
      Accept: "application/json",
      Origin: BASE,
      Referer: BASE + "/",
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!resp.ok) throw new Error(`robu graphql HTTP ${resp.status}`);
  const payload = (await resp.json()) as any;
  if (payload.errors) {
    throw new Error(`robu graphql errors: ${JSON.stringify(payload.errors.slice(0, 2))}`);
  }
  return payload.data;
}

function groups(data: any): any[] {
  if (Array.isArray(data)) return data.filter((g) => g && typeof g === "object");
  return data && typeof data === "object" ? [data] : [];
}

function num(v: any): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function toOffer(p: any): Offer {
  const priceV = num(p.price);
  const sale = num(p.sale_price);
  let img: string | null = null;
  if (Array.isArray(p.images) && p.images.length) img = p.images[0];
  else if (typeof p.images === "string") img = p.images;
  let cats: string[] = [];
  if (Array.isArray(p.categories)) cats = p.categories.map((c: any) => String(c));
  else if (typeof p.categories === "string") cats = [p.categories];
  return {
    supplier: "robu",
    title: (p.name ?? "").trim(),
    url: p.slug ? `${BASE}/product/${p.slug}/` : BASE,
    supplierSku: p.sku || null,
    priceInr: sale && (priceV === null || sale < priceV) ? sale : priceV,
    regularPriceInr: priceV,
    inStock: p.in_stock ?? null,
    image: img,
    categories: cats,
    mpn: p.mpn || null,
    supplierProductId: p.id != null ? String(p.id) : null,
  };
}

export async function robuCategorySlugs(): Promise<string[]> {
  const data = await gql(CATEGORY_LIST_QUERY, {});
  return groups(data?.visibleMenuCategories?.data)
    .map((g) => g.slug)
    .filter((s): s is string => !!s);
}

export interface RobuPage {
  offers: Offer[];
  lastPage: number;
}

export async function fetchRobuCategoryPage(
  slug: string,
  page: number,
  limit = 50,
): Promise<RobuPage> {
  const data = await gql(CATEGORY_PRODUCTS_QUERY, { slug, page, limit });
  const grp = groups(data?.visibleMenuCategories?.data)[0];
  const products = (grp?.products ?? []) as any[];
  const lastPage = Number(grp?.pagination?.last_page ?? page);
  return { offers: products.map(toOffer), lastPage };
}

export async function searchRobu(query: string, limit = 12): Promise<Offer[]> {
  const data = await gql(SEARCH_QUERY, { search: query, page: 1, limit });
  const seen = new Map<string, Offer>();
  for (const grp of groups(data?.visibleMenuCategories?.data)) {
    for (const p of grp.products ?? []) {
      const o = toOffer(p);
      const key = o.supplierProductId || o.url;
      if (!seen.has(key)) seen.set(key, o);
      if (seen.size >= limit) return [...seen.values()];
    }
  }
  return [...seen.values()];
}

/**
 * robu's REAL product search resolver (typeahead). Unlike visibleMenuCategories
 * (a fuzzy menu filter that misses bare ICs), `productSearch` matches exact part
 * numbers — it's how the site's own search box finds e.g. STM32F765VIT6. It is
 * capped (~8 results, no pagination) and exposes fewer fields (no images/
 * categories), so it's a LIVE EXACT-LOOKUP tool, not a crawl source.
 */
const PRODUCT_SEARCH_QUERY =
  "query BomPS($search:String!){ productSearch(search:$search){ data { products {" +
  "id sku name slug price sale_price moq_price in_stock is_backorder } } } }";

export async function productSearchRobu(query: string): Promise<Offer[]> {
  const data = await gql(PRODUCT_SEARCH_QUERY, { search: query });
  const products = (data?.productSearch?.data?.products ?? []) as any[];
  const seen = new Map<string, Offer>();
  for (const p of products) {
    const o = toOffer(p); // images/categories absent -> null/[]; fine
    const key = o.supplierProductId || o.url;
    if (!seen.has(key)) seen.set(key, o);
  }
  return [...seen.values()];
}
