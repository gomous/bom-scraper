"""Relevance ranking for cross-supplier search — classic IR, no ML.

The problem: vendor search endpoints return loose matches, and merging them by
price alone floats cheap dev boards above the bare part you asked for. Two-stage
fix, the standard recall-then-precision pattern:

  1. `vendor_query()` strips *intent* words ("chip", "ic", "bare", "module") that
     signal the KIND of part but aren't literal title terms. We send the cleaned
     term (e.g. "esp32") to each vendor for good recall.
  2. `rank()` re-scores the merged candidates against the ORIGINAL query, using
     product-type intent so "esp32 chip" ranks the bare ESP-WROOM module above an
     "ESP32 Dev Board", "ESP32 Starter Kit", or "Case for ESP32".

Scoring signals (all explainable):
  * term coverage of the content query in the title (the TF-IDF-ish core),
  * exact-phrase and title-start position bonuses,
  * MPN / SKU exact-match bonuses (strong — robu supplies real MPNs),
  * product-type intent: under a "bare component" query, assembly/accessory words
    in the title (board, kit, shield, case, cable…) are penalized and bare-part
    words (module, ic, wroom…) rewarded; under a "board/kit" query the reverse.
Sort is relevance-first, with stock then price as tie-breakers — so price no
longer dominates, it only separates near-equally-relevant hits.
"""

from __future__ import annotations

import re
from typing import Iterable

from .models import Offer

_TOK = re.compile(r"[a-z0-9]+")

# query words that express *what kind* of part is wanted (not literal terms)
_COMPONENT_INTENT = {"chip", "ic", "mcu", "soc", "bare", "raw", "cpu",
                     "processor", "microcontroller", "module"}
_ASSEMBLY_INTENT = {"board", "dev", "development", "kit", "shield", "hat",
                    "breakout", "expansion", "starter", "devkit"}

# title words indicating an assembly / accessory (not the bare part)
_ASSEMBLY_WORDS = {"board", "dev", "development", "kit", "starter", "shield",
                   "hat", "expansion", "breakout", "case", "enclosure", "cover",
                   "cable", "holder", "bracket", "mount", "combo", "bundle",
                   "set", "adapter", "clip", "kits", "boards", "keychain",
                   "sticker", "tester"}
# title words indicating the bare part itself. NB: "module" is deliberately left
# out -- it's too noisy (camera module, relay module ... aren't the chip); the
# real bare-part signals are package names and the WROOM/WROVER module families.
_COMPONENT_WORDS = {"chip", "ic", "mcu", "soc", "wroom", "wrover",
                    "bare", "smd", "dip", "qfp", "soic", "tqfp", "tssop"}


def tokenize(text: str) -> list[str]:
    return _TOK.findall((text or "").lower())


def parse_query(query: str) -> tuple[list[str], dict]:
    """Split a query into content terms + a product-type intent flag."""
    toks = tokenize(query)
    intent = {
        "component": any(t in _COMPONENT_INTENT for t in toks),
        "assembly": any(t in _ASSEMBLY_INTENT for t in toks),
    }
    # content = the literal terms to match on (drop pure-intent words, but keep
    # a term that is ALSO content like "module" only if nothing else remains)
    content = [t for t in toks if t not in _COMPONENT_INTENT
               and t not in _ASSEMBLY_INTENT]
    if not content:                      # query was all intent words
        content = [t for t in toks if t not in {"chip", "ic", "bare", "raw"}]
    return content, intent


def vendor_query(query: str) -> str:
    """The string to actually send to a vendor's own search (recall stage)."""
    content, _ = parse_query(query)
    return " ".join(content) if content else query.strip()


def score(offer: Offer, content: list[str], intent: dict) -> float:
    ttoks = tokenize(offer.title)
    tset = set(ttoks)
    title_norm = " ".join(ttoks)

    if content:
        hits = sum(1 for t in content if t in tset)
        s = hits / len(content)                    # term coverage 0..1
    else:
        s = 0.4

    if content and " ".join(content) in title_norm:
        s += 0.30                                  # exact phrase
    if content and ttoks[:3] and content[0] in ttoks[:3]:
        s += 0.15                                  # matched near the start

    mpn = (offer.mpn or "").lower()
    if content and mpn and any(t == mpn or (len(t) >= 4 and t in mpn) for t in content):
        s += 0.50                                  # MPN hit — strong
    sku = (offer.supplier_sku or "").lower()
    if content and sku and " ".join(content) == sku:
        s += 0.40

    noise = sum(1 for w in ttoks if w in _ASSEMBLY_WORDS)
    comp = sum(1 for w in ttoks if w in _COMPONENT_WORDS)
    if intent["component"] and not intent["assembly"]:
        s -= 0.30 * noise                          # boards/kits/cases pushed down
        s += 0.12 * comp                           # bare module/ic pushed up
        s -= 0.02 * max(0, len(ttoks) - 6)         # bare parts have short titles
    elif intent["assembly"] and not intent["component"]:
        s += 0.12 * min(noise, 2)                  # user wants the board/kit
    return s


def rank(query: str, offers: Iterable[Offer]) -> list[tuple[Offer, float]]:
    """Return offers as (offer, score) sorted relevance-first, stock, then price."""
    content, intent = parse_query(query)
    scored = [(o, score(o, content, intent)) for o in offers]
    stock_rank = {True: 0, None: 1, False: 2}
    scored.sort(key=lambda os: (
        -round(os[1], 2),                          # relevance bucket (0.01 steps)
        stock_rank[os[0].in_stock],                # in-stock first within a bucket
        os[0].price_inr if os[0].price_inr is not None else 1e12,
    ))
    return scored
