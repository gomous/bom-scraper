"""Generic WooCommerce Store API adapter.

Most Indian electronics resellers on WordPress expose the (public, read-only)
WooCommerce Store API at ``/wp-json/wc/store/products``. It returns clean,
paginated JSON with price, stock, images and categories — no HTML scraping.

Proven working against roboticsdna.in (~12.6k products) and zbotic.in. Any
other WooCommerce store is just a new base_url in the supplier registry.

Notes:
  * Prices come as integer strings in the currency's *minor units*
    (``currency_minor_unit``), e.g. "15930" with minor_unit 2 == ₹159.30.
  * ``sku`` is the vendor's internal SKU (e.g. "RDNA-C739.1"), NOT the
    manufacturer part number. We keep it as supplier_sku and separately guess
    the MPN from the title.
  * Total pages are advertised in the ``X-WP-TotalPages`` response header.
"""

from __future__ import annotations

import html
import re
from typing import Iterator

from ..models import Offer, guess_mpn
from .base import PoliteSession, SupplierAdapter

_TAG_RE = re.compile(r"<[^>]+>")


def _clean(text: str) -> str:
    return html.unescape(_TAG_RE.sub("", text or "")).strip()


def _price(prices: dict, key: str) -> float | None:
    raw = prices.get(key)
    if raw in (None, ""):
        return None
    try:
        minor = int(prices.get("currency_minor_unit", 2))
        return int(raw) / (10 ** minor)
    except (ValueError, TypeError):
        return None


class WooCommerceAdapter(SupplierAdapter):
    def __init__(self, id: str, label: str, base_url: str,
                 crawl_delay: float = 1.0, per_page: int = 24):
        self.id = id
        self.label = label
        self.base_url = base_url.rstrip("/")
        self.per_page = per_page
        self.session = PoliteSession(crawl_delay=crawl_delay, referer=self.base_url + "/")

    @property
    def _endpoint(self) -> str:
        return f"{self.base_url}/wp-json/wc/store/products"

    # sentinel: page timed out server-side (empty 200 body) but isn't end-of-data
    _TRANSIENT = object()

    def _fetch_page(self, params: dict, empty_retries: int = 3):
        """Return (batch, total_pages).

        batch is:
          * a list (possibly ``[]`` = genuine end of catalog),
          * ``_TRANSIENT`` if the body stayed empty after retries (a per-page
            server timeout; roboticsdna does this - skip the page, keep going),
          * ``None`` on a hard HTTP/parse failure.
        """
        import time
        total_pages = params.get("page", 1)
        for _ in range(empty_retries + 1):
            resp = self.session.get(self._endpoint, params=params)
            if resp.status_code != 200:
                return None, 0
            total_pages = int(resp.headers.get("X-WP-TotalPages", total_pages))
            if resp.text.strip():
                try:
                    return resp.json(), total_pages
                except ValueError:
                    return None, total_pages
            time.sleep(1.5)  # empty body = transient timeout, retry same page
        return self._TRANSIENT, total_pages

    def iter_offers(self, limit: int | None = None,
                    max_consecutive_skips: int = 10) -> Iterator[Offer]:
        page = 1
        yielded = 0
        total_pages: int | None = None   # trust only counts from successful pages
        skips = 0
        while True:
            batch, tp = self._fetch_page(
                {"per_page": self.per_page, "page": page,
                 "orderby": "date", "order": "desc"})
            if batch is None:             # hard failure -> stop
                break
            if batch is self._TRANSIENT:  # page timed out; skip it, keep going
                # a timed-out page often omits X-WP-TotalPages, so `tp` is
                # unreliable here -- fall back to the count from the last good page
                skips += 1
                if skips > max_consecutive_skips:
                    break
                if total_pages is not None and page >= total_pages:
                    break
                page += 1
                continue
            if not batch:                 # genuine empty list -> end of catalog
                break
            skips = 0
            total_pages = tp
            for p in batch:
                yield self._to_offer(p)
                yielded += 1
                if limit is not None and yielded >= limit:
                    return
            if page >= total_pages:
                break
            page += 1

    def search(self, query: str, limit: int = 10) -> list[Offer]:
        """Live per-part lookup via the Store API's ``search`` param.

        This is the BOM use case: resolve a part name to concrete offers at this
        vendor without indexing the whole catalog.
        """
        batch, _ = self._fetch_page({"per_page": min(limit, 100), "search": query})
        if not isinstance(batch, list):
            return []
        return [self._to_offer(p) for p in batch][:limit]

    def _to_offer(self, p: dict) -> Offer:
        prices = p.get("prices", {}) or {}
        title = _clean(p.get("name", ""))
        images = p.get("images") or []
        return Offer(
            supplier=self.id,
            title=title,
            url=p.get("permalink", ""),
            supplier_sku=(p.get("sku") or None),
            price_inr=_price(prices, "price"),
            regular_price_inr=_price(prices, "regular_price"),
            in_stock=p.get("is_in_stock"),
            image=(images[0].get("src") if images else None),
            categories=[_clean(c.get("name", "")) for c in (p.get("categories") or [])],
            mpn=guess_mpn(title),
            supplier_product_id=str(p.get("id")) if p.get("id") is not None else None,
        )
