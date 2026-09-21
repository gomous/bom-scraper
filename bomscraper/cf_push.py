"""Bulk-load the Cloudflare Vectorize index from local scrapers.

The Worker's cron fills the index slowly (free-tier 50-subrequest cap). This
does the initial bulk load from your machine instead: it reuses the working
Python adapters, embeds each product via the Workers AI REST API
(@cf/baai/bge-small-en-v1.5, 384-dim) and upserts into Vectorize v2 — the exact
same index and vector/metadata shape the Worker's search reads.

Credentials come from the environment (never hard-coded / committed):
    CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID

Usage:
    python -m bomscraper cf-push --supplier all --limit 400
    python -m bomscraper cf-push --supplier robu
"""

from __future__ import annotations

import json
import os
import time
from typing import Iterable

import requests

from .models import Offer
from .suppliers import build_registry

EMBED_MODEL = "@cf/baai/bge-small-en-v1.5"
_API = "https://api.cloudflare.com/client/v4/accounts"


def _creds() -> tuple[str, str]:
    tok = os.environ.get("CLOUDFLARE_API_TOKEN")
    acc = os.environ.get("CLOUDFLARE_ACCOUNT_ID")
    if not tok or not acc:
        raise SystemExit("set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID in the environment")
    return tok, acc


def _embed_text(o: Offer) -> str:
    cats = ", ".join(o.categories[:6])
    mpn = f" MPN {o.mpn}" if o.mpn else ""
    return f"{o.title}. {cats}{mpn}"[:1000]


def _meta(o: Offer) -> dict:
    return {
        "supplier": o.supplier,
        "title": o.title[:300],
        "url": o.url,
        "price": o.price_inr if o.price_inr is not None else -1,
        "regular_price": o.regular_price_inr if o.regular_price_inr is not None else -1,
        "in_stock": "true" if o.in_stock is True else "false" if o.in_stock is False else "unknown",
        "image": (o.image or "")[:400],
        "mpn": o.mpn or "",
        "sku": o.supplier_sku or "",
        "categories": "|".join(o.categories)[:300],
        "fetched_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }


def _chunks(seq, n):
    for i in range(0, len(seq), n):
        yield seq[i:i + n]


class CFPusher:
    def __init__(self, index: str = "bom-products"):
        self.tok, self.acc = _creds()
        self.index = index
        self.s = requests.Session()
        self.s.headers["Authorization"] = f"Bearer {self.tok}"

    def embed(self, texts: list[str]) -> list[list[float]]:
        url = f"{_API}/{self.acc}/ai/run/{EMBED_MODEL}"
        for attempt in range(4):
            r = self.s.post(url, json={"text": texts}, timeout=90)
            if r.status_code == 200 and r.json().get("success"):
                return r.json()["result"]["data"]
            if r.status_code in (429, 500, 502, 503):
                time.sleep(2 ** attempt)
                continue
            raise RuntimeError(f"embed failed {r.status_code}: {r.text[:200]}")
        raise RuntimeError("embed failed after retries")

    def upsert(self, offers: list[Offer]) -> int:
        if not offers:
            return 0
        # dedup by stable id
        by_id: dict[str, Offer] = {}
        for o in offers:
            if o.title and o.url:
                by_id[o.key()] = o
        items = list(by_id.items())
        total = 0
        for part in _chunks(items, 90):  # embed model handles up to ~100/call
            vectors = self.embed([_embed_text(o) for _, o in part])
            lines = []
            for (vid, o), vec in zip(part, vectors):
                lines.append(json.dumps({"id": vid, "values": vec, "metadata": _meta(o)}))
            body = "\n".join(lines).encode()
            url = f"{_API}/{self.acc}/vectorize/v2/indexes/{self.index}/upsert"
            r = self.s.post(url, data=body,
                            headers={"Content-Type": "application/x-ndjson"}, timeout=90)
            if r.status_code != 200 or not r.json().get("success"):
                raise RuntimeError(f"upsert failed {r.status_code}: {r.text[:200]}")
            total += len(part)
            print(f"    upserted {total}/{len(items)}", flush=True)
        return total


def run(supplier: str, limit: int | None) -> None:
    pusher = CFPusher()
    registry = build_registry()
    targets = list(registry) if supplier == "all" else [supplier]
    grand = 0
    for sid in targets:
        ad = registry[sid]
        print(f"[{sid}] scraping (limit={limit})...", flush=True)
        offers: list[Offer] = []
        try:
            for o in ad.iter_offers(limit=limit):
                offers.append(o)
        except NotImplementedError as e:
            print(f"[{sid}] skipped: {e}")
            continue
        print(f"[{sid}] embedding + upserting {len(offers)} offers...", flush=True)
        grand += pusher.upsert(offers)
    print(f"done. {grand} vectors pushed to Vectorize index '{pusher.index}'.")
