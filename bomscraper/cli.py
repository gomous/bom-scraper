"""Command-line entry point.

  python -m bomscraper list-suppliers
  python -m bomscraper ingest roboticsdna --limit 300
  python -m bomscraper ingest all
  python -m bomscraper search esp32 --in-stock
  python -m bomscraper discover-robu
"""

from __future__ import annotations

import argparse
import sys

from .store import OfferStore
from .suppliers import build_registry, get


def _fmt_price(v) -> str:
    return f"Rs {v:,.2f}" if v is not None else "-"


def cmd_list(args):
    for sid, ad in build_registry().items():
        print(f"  {sid:14s} {ad.label}")


def cmd_ingest(args):
    store = OfferStore(args.db)
    targets = list(build_registry()) if args.supplier == "all" else [args.supplier]
    for sid in targets:
        ad = get(sid)
        print(f"[{sid}] ingesting (limit={args.limit})...", flush=True)
        n = 0
        try:
            batch = []
            for offer in ad.iter_offers(limit=args.limit):
                batch.append(offer)
                n += 1
                if len(batch) >= 200:
                    store.upsert_many(batch)
                    batch.clear()
                    print(f"[{sid}]   {n} offers...", flush=True)
            if batch:
                store.upsert_many(batch)
        except NotImplementedError as e:
            print(f"[{sid}] skipped: {e}")
            continue
        print(f"[{sid}] done: {n} offers")
    print("counts:", store.counts())
    store.close()


def cmd_search(args):
    store = OfferStore(args.db)
    rows = store.search(" ".join(args.terms), in_stock_only=args.in_stock, limit=args.limit)
    if not rows:
        print("no matches")
        return
    for r in rows:
        stock = {1: "in stock", 0: "OUT", None: "?"}[r["in_stock"]]
        print(f"- {r['title'][:70]}")
        print(f"    {r['supplier']:12s} {_fmt_price(r['price_inr']):>14s}  [{stock}]  {r['url']}")
        if r["mpn"]:
            print(f"    mpn~ {r['mpn']}")
    store.close()


def cmd_lookup(args):
    """Live cross-supplier price comparison for one part -- the BOM use case.

    Sends the intent-stripped query to each vendor for recall, then re-ranks the
    merged candidates by relevance (see ranking.py)."""
    from .ranking import rank, vendor_query
    query = " ".join(args.terms)
    vq = vendor_query(query)
    offers = []
    for sid, ad in build_registry().items():
        try:
            found = ad.search(vq, limit=args.limit)
            offers.extend(found)
            print(f"[{sid}] {len(found)} result(s)", flush=True)
        except Exception as e:
            print(f"[{sid}] search failed: {e}")
    if args.in_stock:
        offers = [o for o in offers if o.in_stock]
    ranked = rank(query, offers)
    print(f"\n== {query}  (vendor query: '{vq}'): {len(ranked)} offer(s) ==")
    for o, sc in ranked[:args.top]:
        stock = "in stock" if o.in_stock else ("OUT" if o.in_stock is False else "?")
        print(f"- [{sc:+.2f}] {o.title[:60]}")
        print(f"    {o.supplier:12s} {_fmt_price(o.price_inr):>14s}  [{stock}]  {o.url}")


def cmd_serve(args):
    from .web import serve
    serve(host=args.host, port=args.port, open_browser=not args.no_open)


def cmd_cf_push(args):
    from .cf_push import run
    run(args.supplier, args.limit)


def cmd_discover_robu(args):
    from .adapters import RobuAdapter
    ops = RobuAdapter().discover_operations()
    if not ops:
        print("no GraphQL operations found in bundle (schema may be persisted-query only)")
        return
    for url, names in ops.items():
        print(url)
        for n in names:
            print("   ", n)


def main(argv=None):
    p = argparse.ArgumentParser(prog="bomscraper")
    p.add_argument("--db", default="bom.db", help="SQLite path (default bom.db)")
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("list-suppliers").set_defaults(func=cmd_list)

    pi = sub.add_parser("ingest")
    pi.add_argument("supplier", help="supplier id or 'all'")
    pi.add_argument("--limit", type=int, default=None)
    pi.set_defaults(func=cmd_ingest)

    ps = sub.add_parser("search")
    ps.add_argument("terms", nargs="+")
    ps.add_argument("--in-stock", action="store_true")
    ps.add_argument("--limit", type=int, default=25)
    ps.set_defaults(func=cmd_search)

    pl = sub.add_parser("lookup", help="live cross-supplier price comparison")
    pl.add_argument("terms", nargs="+")
    pl.add_argument("--in-stock", action="store_true")
    pl.add_argument("--limit", type=int, default=24, help="candidates per supplier (recall)")
    pl.add_argument("--top", type=int, default=15, help="rows to display")
    pl.set_defaults(func=cmd_lookup)

    pw = sub.add_parser("serve", help="launch the web search UI")
    pw.add_argument("--host", default="127.0.0.1")
    pw.add_argument("--port", type=int, default=8765)
    pw.add_argument("--no-open", action="store_true", help="don't auto-open the browser")
    pw.set_defaults(func=cmd_serve)

    pc = sub.add_parser("cf-push", help="bulk-load Cloudflare Vectorize from local scrapers")
    pc.add_argument("--supplier", default="all", help="supplier id or 'all'")
    pc.add_argument("--limit", type=int, default=None, help="max products per supplier")
    pc.set_defaults(func=cmd_cf_push)

    sub.add_parser("discover-robu").set_defaults(func=cmd_discover_robu)

    args = p.parse_args(argv)
    args.func(args)


if __name__ == "__main__":
    sys.exit(main())
