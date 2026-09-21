"""SQLite-backed offer store with full-text search.

Keeps a normalized index of supplier offers (price + stock + deep link back to
the vendor), refreshable per supplier. This is a price/availability index that
links out to each supplier — not a rehost of their catalog.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import Iterable

from .models import Offer

_SCHEMA = """
CREATE TABLE IF NOT EXISTS offers (
    offer_key           TEXT PRIMARY KEY,
    supplier            TEXT NOT NULL,
    title               TEXT NOT NULL,
    url                 TEXT NOT NULL,
    supplier_sku        TEXT,
    price_inr           REAL,
    regular_price_inr   REAL,
    in_stock            INTEGER,
    image               TEXT,
    categories          TEXT,
    mpn                 TEXT,
    manufacturer        TEXT,
    supplier_product_id TEXT,
    fetched_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_offers_supplier ON offers(supplier);
CREATE INDEX IF NOT EXISTS idx_offers_mpn      ON offers(mpn);

CREATE VIRTUAL TABLE IF NOT EXISTS offers_fts USING fts5(
    title, categories, supplier_sku, mpn,
    content='offers', content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS offers_ai AFTER INSERT ON offers BEGIN
    INSERT INTO offers_fts(rowid, title, categories, supplier_sku, mpn)
    VALUES (new.rowid, new.title, new.categories, new.supplier_sku, new.mpn);
END;
CREATE TRIGGER IF NOT EXISTS offers_ad AFTER DELETE ON offers BEGIN
    INSERT INTO offers_fts(offers_fts, rowid, title, categories, supplier_sku, mpn)
    VALUES ('delete', old.rowid, old.title, old.categories, old.supplier_sku, old.mpn);
END;
CREATE TRIGGER IF NOT EXISTS offers_au AFTER UPDATE ON offers BEGIN
    INSERT INTO offers_fts(offers_fts, rowid, title, categories, supplier_sku, mpn)
    VALUES ('delete', old.rowid, old.title, old.categories, old.supplier_sku, old.mpn);
    INSERT INTO offers_fts(rowid, title, categories, supplier_sku, mpn)
    VALUES (new.rowid, new.title, new.categories, new.supplier_sku, new.mpn);
END;
"""

_COLS = [
    "offer_key", "supplier", "title", "url", "supplier_sku", "price_inr",
    "regular_price_inr", "in_stock", "image", "categories", "mpn",
    "manufacturer", "supplier_product_id", "fetched_at",
]


class OfferStore:
    def __init__(self, path: str | Path = "bom.db"):
        self.path = str(path)
        self.conn = sqlite3.connect(self.path)
        self.conn.row_factory = sqlite3.Row
        self.conn.executescript(_SCHEMA)
        self.conn.commit()

    def upsert_many(self, offers: Iterable[Offer]) -> int:
        rows = []
        for o in offers:
            r = o.as_row()
            r["in_stock"] = None if r["in_stock"] is None else int(bool(r["in_stock"]))
            rows.append(tuple(r[c] for c in _COLS))
        placeholders = ",".join("?" * len(_COLS))
        updates = ",".join(f"{c}=excluded.{c}" for c in _COLS if c != "offer_key")
        sql = (f"INSERT INTO offers ({','.join(_COLS)}) VALUES ({placeholders}) "
               f"ON CONFLICT(offer_key) DO UPDATE SET {updates}")
        cur = self.conn.executemany(sql, rows)
        self.conn.commit()
        return cur.rowcount if cur.rowcount != -1 else len(rows)

    def search(self, terms: str, in_stock_only: bool = False, limit: int = 25) -> list[sqlite3.Row]:
        # FTS5 MATCH; quote loosely so multi-word queries behave as AND-of-terms
        match = " ".join(f'"{t}"' for t in terms.split())
        where = "offers_fts MATCH ?"
        args: list = [match]
        if in_stock_only:
            where += " AND o.in_stock = 1"
        sql = (
            "SELECT o.*, bm25(offers_fts) AS rank FROM offers_fts "
            "JOIN offers o ON o.rowid = offers_fts.rowid "
            f"WHERE {where} ORDER BY rank LIMIT ?"
        )
        args.append(limit)
        return self.conn.execute(sql, args).fetchall()

    def counts(self) -> dict[str, int]:
        rows = self.conn.execute(
            "SELECT supplier, COUNT(*) n FROM offers GROUP BY supplier ORDER BY n DESC"
        ).fetchall()
        return {r["supplier"]: r["n"] for r in rows}

    def close(self) -> None:
        self.conn.close()
