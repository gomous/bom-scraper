/**
 * Lexical product-type intent bias (ported from the Python ranking.py).
 *
 * Dense (embedding) retrieval + a cross-encoder reranker are great at semantic
 * recall, but they blur product *type* — "esp32 chip", "esp32 dev board" and
 * "esp32 case" all embed close together. This module contributes a small,
 * explainable lexical adjustment that is ADDED to the reranker score so a
 * "chip" query pushes bare modules up and boards/kits/cases down (and a "board"
 * query does the reverse). It is the precision floor under the semantic layer.
 */

const COMPONENT_INTENT = new Set([
  "chip", "ic", "mcu", "soc", "bare", "raw", "cpu", "processor",
  "microcontroller", "module",
]);
const ASSEMBLY_INTENT = new Set([
  "board", "dev", "development", "kit", "shield", "hat", "breakout",
  "expansion", "starter", "devkit",
]);
const ASSEMBLY_WORDS = new Set([
  "board", "dev", "development", "kit", "starter", "shield", "hat",
  "expansion", "breakout", "case", "enclosure", "cover", "cable", "holder",
  "bracket", "mount", "combo", "bundle", "set", "adapter", "clip", "kits",
  "boards", "keychain", "sticker", "tester",
]);
// deliberately excludes "module" (too noisy: camera/relay module aren't the chip)
const COMPONENT_WORDS = new Set([
  "chip", "ic", "mcu", "soc", "wroom", "wrover", "bare", "smd", "dip",
  "qfp", "soic", "tqfp", "tssop",
]);

export function tokenize(text: string): string[] {
  return (text || "").toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

export interface QueryIntent {
  content: string[];
  component: boolean;
  assembly: boolean;
}

export function parseQuery(query: string): QueryIntent {
  const toks = tokenize(query);
  const component = toks.some((t) => COMPONENT_INTENT.has(t));
  const assembly = toks.some((t) => ASSEMBLY_INTENT.has(t));
  let content = toks.filter((t) => !COMPONENT_INTENT.has(t) && !ASSEMBLY_INTENT.has(t));
  if (content.length === 0) {
    content = toks.filter((t) => !["chip", "ic", "bare", "raw"].includes(t));
  }
  return { content, component, assembly };
}

/** The string to send to a vendor's own search (recall stage). */
export function vendorQuery(query: string): string {
  const { content } = parseQuery(query);
  return content.length ? content.join(" ") : query.trim();
}

/**
 * Lexical adjustment in roughly [-1, +1] to add to a semantic score.
 * Rewards exact term/phrase/MPN hits; applies product-type intent bias.
 */
export function lexicalAdjust(query: string, title: string, mpn?: string | null): number {
  const { content, component, assembly } = parseQuery(query);
  const ttoks = tokenize(title);
  const tset = new Set(ttoks);
  const titleNorm = ttoks.join(" ");
  let s = 0;

  if (content.length) {
    const hits = content.filter((t) => tset.has(t)).length;
    s += 0.4 * (hits / content.length); // term coverage
    if (titleNorm.includes(content.join(" "))) s += 0.2; // exact phrase
    if (ttoks.slice(0, 3).includes(content[0])) s += 0.1; // near title start
    const m = (mpn || "").toLowerCase();
    if (m && content.some((t) => t === m || (t.length >= 4 && m.includes(t)))) s += 0.4;
  }

  const noise = ttoks.filter((w) => ASSEMBLY_WORDS.has(w)).length;
  const comp = ttoks.filter((w) => COMPONENT_WORDS.has(w)).length;
  if (component && !assembly) {
    s -= 0.3 * noise;
    s += 0.12 * comp;
    s -= 0.02 * Math.max(0, ttoks.length - 6);
  } else if (assembly && !component) {
    s += 0.12 * Math.min(noise, 2);
  }
  return s;
}
