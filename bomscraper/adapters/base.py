"""Base class + shared HTTP session for supplier adapters.

Politeness is a first-class concern here: several Indian suppliers explicitly
fight crawlers (robokits' robots.txt documents a crawl trap that "drove load
12-24"). Every adapter therefore goes through one throttled, retrying session
with a real browser User-Agent and a per-supplier crawl delay.
"""

from __future__ import annotations

import time
from abc import ABC, abstractmethod
from typing import Iterator

import requests

from ..models import Offer

_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)


class PoliteSession:
    """A requests.Session that spaces out calls and retries transient errors."""

    def __init__(self, crawl_delay: float = 1.0, referer: str | None = None):
        self.crawl_delay = crawl_delay
        self._last = 0.0
        self.s = requests.Session()
        self.s.headers.update({"User-Agent": _UA, "Accept": "application/json"})
        if referer:
            self.s.headers["Referer"] = referer

    def _throttle(self) -> None:
        wait = self.crawl_delay - (time.monotonic() - self._last)
        if wait > 0:
            time.sleep(wait)
        self._last = time.monotonic()

    def request(self, method: str, url: str, *, retries: int = 4, **kw) -> requests.Response:
        kw.setdefault("timeout", 30)
        for attempt in range(retries):
            self._throttle()
            resp = self.s.request(method, url, **kw)
            if resp.status_code in (429, 500, 502, 503, 504):
                # honour Retry-After when present, else exponential backoff
                delay = float(resp.headers.get("Retry-After", 2 ** attempt))
                time.sleep(min(delay, 30))
                continue
            return resp
        return resp  # return last response even if still failing

    def get(self, url: str, **kw) -> requests.Response:
        return self.request("GET", url, **kw)

    def post(self, url: str, **kw) -> requests.Response:
        return self.request("POST", url, **kw)


class SupplierAdapter(ABC):
    """One adapter per supplier (or per platform, parameterized by base URL)."""

    #: short stable id used as the `supplier` field on every Offer
    id: str = "base"
    #: human label
    label: str = "Base"

    @abstractmethod
    def iter_offers(self, limit: int | None = None) -> Iterator[Offer]:
        """Yield normalized offers, newest/most-relevant first where possible."""
        raise NotImplementedError

    def search(self, query: str, limit: int = 10) -> list[Offer]:
        """Live per-part lookup at this vendor. Adapters that can't do a server
        -side search return [] (the caller can fall back to the local index)."""
        return []
