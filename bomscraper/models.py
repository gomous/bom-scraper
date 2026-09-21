"""Normalized data model shared by every supplier adapter.

A supplier exposes *offers*: a specific listing (SKU) at a specific vendor with
a price and stock state. Multiple offers across suppliers may point at the same
physical part; resolving that (by MPN, or fuzzy title match when MPN is absent)
is a separate matching step and deliberately not baked into the offer itself.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from typing import Any, Optional


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


@dataclass
class Offer:
    supplier: str                      # short id, e.g. "roboticsdna"
    title: str                         # listing title as shown by the vendor
    url: str                           # canonical product URL (deep link back)
    supplier_sku: Optional[str] = None # vendor's internal SKU (not the MPN)
    price_inr: Optional[float] = None  # current price incl. GST, in rupees
    regular_price_inr: Optional[float] = None
    in_stock: Optional[bool] = None    # None = unknown
    image: Optional[str] = None
    categories: list[str] = field(default_factory=list)
    mpn: Optional[str] = None          # manufacturer part number, if extractable
    manufacturer: Optional[str] = None
    supplier_product_id: Optional[str] = None  # vendor's internal numeric/opaque id
    fetched_at: str = field(default_factory=_now)

    def key(self) -> str:
        """Stable upsert key: prefer the vendor product id, else the URL."""
        ident = self.supplier_product_id or self.supplier_sku or self.url
        return f"{self.supplier}::{ident}"

    def as_row(self) -> dict[str, Any]:
        d = asdict(self)
        d["categories"] = "|".join(self.categories)
        d["offer_key"] = self.key()
        return d


# --- lightweight MPN extraction ------------------------------------------------
# Vendors rarely put the manufacturer part number in a structured field, but it
# very often appears in the title (e.g. "ESP32-WROOM-32", "LM2596", "ATmega328P").
# This is a best-effort heuristic to seed cross-supplier matching, never trusted
# blindly — the matcher can still fall back to fuzzy title comparison.

_MPN_PATTERNS = [
    r"\bESP32[-\w]*\b", r"\bESP8266[-\w]*\b",
    r"\bATmega\d+[A-Z\-]*\b", r"\bATtiny\d+[A-Z\-]*\b",
    r"\bSTM32[FLHGWU]\w+\b",
    r"\bLM\d{2,4}[A-Z\-]*\b", r"\bNE555\b", r"\bMAX\d{3,4}[A-Z\-]*\b",
    r"\b7[048]\d{2}[A-Z]?\b",              # 74xx / 40xx logic
    r"\bMPU-?6050\b", r"\bBME\d{3}\b", r"\bBMP\d{3}\b",
    r"\bnRF\d{4,5}[-\w]*\b", r"\bCP210\d\b", r"\bCH340[A-Z]?\b",
]
_MPN_RE = re.compile("|".join(_MPN_PATTERNS), re.IGNORECASE)


def guess_mpn(title: str) -> Optional[str]:
    m = _MPN_RE.search(title or "")
    return m.group(0).upper() if m else None
