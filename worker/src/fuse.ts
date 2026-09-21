/**
 * Reciprocal Rank Fusion (RRF) — the standard way to merge several ranked
 * result lists that score on incomparable scales (dense cosine vs. a vendor's
 * BM25 vs. our lexical adjust). Instead of trying to weight raw scores against
 * each other, RRF uses only ordinal RANK:
 *
 *     rrf(d) = Σ_lists  1 / (k + rank_list(d))        rank starts at 1
 *
 * A document that several retrievers independently rank highly wins, and no
 * single system's inflated score can dominate. k (default 60) damps the tail:
 * a larger k lets lower-ranked items contribute more. This is exactly what
 * Elasticsearch/Vespa/OpenSearch use for hybrid search, and it replaces the
 * fragile "semantic + 0.5·kw + 0.4·lexical + floors" blend this engine used to
 * carry — that blend was the reason ranking needed a new patch per query.
 *
 * See: https://www.elastic.co/docs/reference/elasticsearch/rest-apis/reciprocal-rank-fusion
 */

export interface RankedList<T> {
  /** ordered best-first; each item must map to a stable dedup key */
  items: T[];
  key: (item: T) => string;
  /** optional label for debugging which retriever surfaced a doc */
  name?: string;
}

export interface Fused<T> {
  key: string;
  item: T; // the first-seen representative for this key
  score: number; // summed RRF contribution
  ranks: Record<string, number>; // name -> 1-based rank in that list
}

/**
 * Fuse ranked lists by RRF. When the same key appears in several lists we keep
 * the FIRST representative item seen (lists are passed best-source-first, but
 * the caller should merge field data separately if freshness matters). The RRF
 * score sums every list the key appears in, so multi-source agreement is
 * rewarded automatically.
 */
export function rrfFuse<T>(lists: RankedList<T>[], k = 60): Fused<T>[] {
  const byKey = new Map<string, Fused<T>>();
  for (const list of lists) {
    const name = list.name ?? "list";
    for (let i = 0; i < list.items.length; i++) {
      const item = list.items[i];
      const key = list.key(item);
      if (!key) continue;
      const rank = i + 1; // 1-based
      const contrib = 1 / (k + rank);
      const existing = byKey.get(key);
      if (existing) {
        existing.score += contrib;
        existing.ranks[name] = rank;
      } else {
        byKey.set(key, { key, item, score: contrib, ranks: { [name]: rank } });
      }
    }
  }
  return [...byKey.values()].sort((a, b) => b.score - a.score);
}
