"""Registry of known Indian electronics suppliers and their adapters.

Platform recon (from robots.txt + live probes, 2026-09):
  robu.in        Next.js + GraphQL proxy at /api/proxy/graphql/  -> RobuAdapter
  roboticsdna.in WooCommerce Store API (~12.6k products)         -> WooCommerceAdapter
  zbotic.in      WooCommerce Store API (Divi theme)              -> WooCommerceAdapter
  robokits.co.in custom PHP store, Crawl-delay 5, anti-bot       -> HTML adapter (TODO)

Adding a WooCommerce supplier is one line here. Confirm a candidate first with:
  curl -A '<browser UA>' 'https://SITE/wp-json/wc/store/products?per_page=1'
"""

from __future__ import annotations

from .adapters import RobuAdapter, WooCommerceAdapter
from .adapters.base import SupplierAdapter


def build_registry() -> dict[str, SupplierAdapter]:
    return {
        # roboticsdna times out on large pages -> keep per_page small.
        "roboticsdna": WooCommerceAdapter(
            "roboticsdna", "RoboticsDNA", "https://roboticsdna.in",
            crawl_delay=1.0, per_page=20),
        "zbotic": WooCommerceAdapter(
            "zbotic", "Zbotic", "https://zbotic.in", crawl_delay=1.0, per_page=100),
        "robu": RobuAdapter(crawl_delay=1.5),
    }


def get(supplier_id: str) -> SupplierAdapter:
    reg = build_registry()
    if supplier_id not in reg:
        raise KeyError(f"unknown supplier {supplier_id!r}; known: {sorted(reg)}")
    return reg[supplier_id]
