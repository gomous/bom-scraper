"""robu.in adapter (GraphQL).

robu.in is a Next.js storefront (behind CloudFront/Cloudflare) whose Apollo
client talks to a custom GraphQL API proxied at ``/api/proxy/graphql/`` -- a
path their robots.txt keeps deliberately crawlable. So we call it like an API.

Schema discovery notes (the endpoint blocks deep introspection -- ``__schema
.types`` / ``__type.fields`` throw "Internal server error" -- so the queries
below were recovered from the shipped JS bundle; ``discover_operations()`` is
the tool that finds them):

  * ``visibleMenuCategories(parent, slug, page, limit, sort, search, ...)`` is
    the one product resolver used for both browse and search:
      - browse a category:  parent:true,  slug:"<cat>", search:""   (clean
        single-group pagination -> used by iter_offers)
      - search everything:  parent:false, slug:"",      search:"q"  (flattened
        product hits across facet groups -> used by search)
    Its ``data`` is a LIST of category groups; each group carries ``products``
    and a ``pagination { current_page per_page total last_page }``.
  * Product fields include a real ``mpn`` (often empty, but gold when present
    for cross-supplier matching), ``price`` (regular), ``sale_price``,
    ``moq_price`` (bulk), ``images`` (list), ``in_stock``, ``slug``.
  * Product page URL is ``https://robu.in/product/<slug>/``.

Transport: the GraphQL POST works via plain requests (Cloudflare allows it),
even though a browser-less GET of the HTML pages is sometimes 403'd.
"""

from __future__ import annotations

import re
from typing import Iterator

from ..models import Offer
from .base import PoliteSession, SupplierAdapter

_NEXT_CHUNK_RE = re.compile(r"/_next/static/[^\"']+\.js")
_GQL_OP_RE = re.compile(r"(query|mutation)\s+(\w+)")

_PRODUCT_FIELDS = (
    "id sku name slug price sale_price moq_price images in_stock mpn "
    "categories is_backorder"
)

# search across the whole catalog (parent:false flattens product hits)
_SEARCH_QUERY = (
    "query BomSearch($search:String!,$page:Int,$limit:Int){"
    " visibleMenuCategories(parent:false,slug:\"\",page:$page,limit:$limit,"
    "sort:\"latest\",search:$search){ data { products {" + _PRODUCT_FIELDS +
    "} pagination { total last_page current_page } } } }"
)

# list top-level categories (to drive a full crawl)
_CATEGORY_LIST_QUERY = (
    "query BomCats{ visibleMenuCategories(parent:true,slug:\"\",page:1,"
    "limit:500,sort:\"latest\",search:\"\"){ data { id name slug } } }"
)

# paginate products within one category (single clean group)
_CATEGORY_PRODUCTS_QUERY = (
    "query BomCatProducts($slug:String!,$page:Int,$limit:Int){"
    " visibleMenuCategories(parent:true,slug:$slug,page:$page,limit:$limit,"
    "sort:\"latest\",search:\"\"){ data { products {" + _PRODUCT_FIELDS +
    "} pagination { total last_page current_page } } } }"
)


def _num(v):
    try:
        return float(v) if v not in (None, "", "0") else (0.0 if v == "0" else None)
    except (TypeError, ValueError):
        return None


class RobuAdapter(SupplierAdapter):
    id = "robu"
    label = "Robu.in"
    base_url = "https://robu.in"
    graphql = "https://robu.in/api/proxy/graphql/"

    def __init__(self, crawl_delay: float = 1.5, per_page: int = 50):
        self.per_page = per_page
        self.session = PoliteSession(crawl_delay=crawl_delay, referer=self.base_url + "/")
        self.session.s.headers.update({
            "Origin": self.base_url,
            "Content-Type": "application/json",
            "Accept": "application/json",
        })

    def gql(self, query: str, variables: dict | None = None) -> dict:
        resp = self.session.post(
            self.graphql,
            json={"query": query, "variables": variables or {}},
            allow_redirects=True,
        )
        if resp.status_code != 200:
            raise RuntimeError(f"robu graphql HTTP {resp.status_code}: {resp.text[:120]}")
        payload = resp.json()
        if payload.get("errors"):
            msgs = [e.get("message") for e in payload["errors"]][:2]
            raise RuntimeError(f"robu graphql errors: {msgs}")
        return payload["data"]

    # --- normalization -------------------------------------------------------
    @staticmethod
    def _groups(data) -> list[dict]:
        """visibleMenuCategories.data is a list of category groups (or, defensively,
        a single dict)."""
        if isinstance(data, list):
            return [g for g in data if isinstance(g, dict)]
        return [data] if isinstance(data, dict) else []

    def _to_offer(self, p: dict) -> Offer:
        price = _num(p.get("price"))
        sale = _num(p.get("sale_price"))
        images = p.get("images") or []
        img = images[0] if isinstance(images, list) and images else (
            images if isinstance(images, str) else None)
        cats = p.get("categories")
        if isinstance(cats, str):
            cats = [cats]
        elif not isinstance(cats, list):
            cats = []
        return Offer(
            supplier=self.id,
            title=(p.get("name") or "").strip(),
            url=f"{self.base_url}/product/{p.get('slug')}/" if p.get("slug") else self.base_url,
            supplier_sku=(p.get("sku") or None),
            price_inr=sale if (sale and (price is None or sale < price)) else price,
            regular_price_inr=price,
            in_stock=p.get("in_stock"),
            image=img,
            categories=[str(c) for c in cats],
            mpn=(p.get("mpn") or None),
            supplier_product_id=str(p.get("id")) if p.get("id") is not None else None,
        )

    # --- public API ----------------------------------------------------------
    def search(self, query: str, limit: int = 10) -> list[Offer]:
        data = self.gql(_SEARCH_QUERY, {"search": query, "page": 1, "limit": limit})
        seen: dict[str, Offer] = {}
        for group in self._groups(data.get("visibleMenuCategories", {}).get("data")):
            for p in (group.get("products") or []):
                o = self._to_offer(p)
                seen.setdefault(o.supplier_product_id or o.url, o)
                if len(seen) >= limit:
                    return list(seen.values())
        return list(seen.values())

    def iter_offers(self, limit: int | None = None) -> Iterator[Offer]:
        """Full crawl: enumerate top-level categories, paginate each."""
        cats = self.gql(_CATEGORY_LIST_QUERY)
        slugs = [g.get("slug") for g in self._groups(
            cats.get("visibleMenuCategories", {}).get("data")) if g.get("slug")]
        yielded = 0
        seen_ids: set[str] = set()
        for slug in slugs:
            page = 1
            while True:
                data = self.gql(_CATEGORY_PRODUCTS_QUERY,
                                {"slug": slug, "page": page, "limit": self.per_page})
                groups = self._groups(data.get("visibleMenuCategories", {}).get("data"))
                if not groups:
                    break
                grp = groups[0]
                products = grp.get("products") or []
                if not products:
                    break
                for p in products:
                    o = self._to_offer(p)
                    ident = o.supplier_product_id or o.url
                    if ident in seen_ids:      # products can repeat across categories
                        continue
                    seen_ids.add(ident)
                    yield o
                    yielded += 1
                    if limit is not None and yielded >= limit:
                        return
                last = (grp.get("pagination") or {}).get("last_page") or page
                if page >= last:
                    break
                page += 1

    def discover_operations(self, max_chunks: int = 60) -> dict[str, list[str]]:
        """Recover GraphQL operations from the storefront JS bundle (how the
        queries above were found). Fetches the homepage + a category route and
        greps their chunks for ``query``/``mutation`` definitions."""
        found: dict[str, list[str]] = {}
        for page in ("/", "/product-category/development-boards/"):
            try:
                html = self.session.s.get(self.base_url + page, timeout=30).text
            except Exception:
                continue
            for path in sorted(set(_NEXT_CHUNK_RE.findall(html)))[:max_chunks]:
                url = self.base_url + path
                try:
                    js = self.session.s.get(url, timeout=30).text
                except Exception:
                    continue
                ops = sorted({f"{k} {n}" for k, n in _GQL_OP_RE.findall(js)})
                if ops:
                    found[url] = ops
        return found
