/** A normalized product offer from one supplier (mirrors the Python Offer). */
export interface Offer {
  supplier: string;
  title: string;
  url: string;
  supplierSku?: string | null;
  priceInr?: number | null;
  regularPriceInr?: number | null;
  inStock?: boolean | null;
  image?: string | null;
  categories: string[];
  mpn?: string | null;
  supplierProductId?: string | null;
}

/** Stable Vectorize id for an offer. */
export function offerId(o: Offer): string {
  const ident = o.supplierProductId || o.supplierSku || o.url;
  return `${o.supplier}:${ident}`;
}

/** Metadata stored alongside the vector (kept small — no descriptions). */
export interface OfferMeta extends Record<string, string | number | boolean> {
  supplier: string;
  title: string;
  url: string;
  price: number;          // -1 when unknown (Vectorize metadata can't hold null)
  regular_price: number;  // -1 when unknown
  in_stock: string;       // "true" | "false" | "unknown" (string for filtering)
  image: string;
  mpn: string;
  sku: string;
  categories: string;
  fetched_at: string;
}

/** The environment bindings declared in wrangler.jsonc. */
export interface Env {
  AI: Ai;
  VECTORIZE: VectorizeIndex;
  CURSOR: KVNamespace;
  ALLOWED_ORIGIN: string;
  MAX_PAGES_PER_RUN: string;
  EMBED_MODEL: string;
  RERANK_MODEL: string;
  QUERY_MODEL: string;
  INGEST_TOKEN?: string;
}
