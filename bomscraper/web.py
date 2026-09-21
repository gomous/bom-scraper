"""Tiny zero-dependency web UI for cross-supplier product search.

Runs the same live search as the `lookup` CLI command, but in the browser:
type a part, hit search, get merged results from every supplier sorted
cheapest-in-stock-first, each linking back to the vendor.

Stdlib only (http.server + ThreadPoolExecutor) so it runs with no extra install:

    python -m bomscraper serve
"""

from __future__ import annotations

import json
import webbrowser
from concurrent.futures import ThreadPoolExecutor, as_completed
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

from .models import Offer
from .ranking import rank, vendor_query
from .suppliers import build_registry


def _offer_dict(o: Offer) -> dict:
    return {
        "supplier": o.supplier,
        "title": o.title,
        "url": o.url,
        "sku": o.supplier_sku,
        "price": o.price_inr,
        "regular_price": o.regular_price_inr,
        "on_sale": (o.price_inr is not None and o.regular_price_inr is not None
                    and o.price_inr < o.regular_price_inr),
        "in_stock": o.in_stock,
        "image": o.image,
        "mpn": o.mpn,
        "categories": o.categories,
    }


def _stock_rank(o: dict) -> int:
    return {True: 0, None: 1, False: 2}[o["in_stock"]]


def search_all(query: str, in_stock_only: bool = False,
               per_supplier: int = 24) -> dict:
    """Fan out to every supplier in parallel, then re-rank by relevance.

    We send the intent-stripped `vendor_query` for recall (a broad candidate set)
    and rank the merged candidates against the original query for precision.
    """
    registry = build_registry()   # fresh adapters (own HTTP sessions) per request
    vq = vendor_query(query)
    found_offers: list[Offer] = []
    tallies: dict[str, object] = {}

    def one(sid, ad):
        return sid, ad.search(vq, limit=per_supplier)

    with ThreadPoolExecutor(max_workers=len(registry)) as pool:
        futs = [pool.submit(one, sid, ad) for sid, ad in registry.items()]
        for fut in as_completed(futs):
            try:
                sid, found = fut.result()
                tallies[sid] = len(found)
                found_offers.extend(found)
            except Exception as e:  # one supplier failing must not sink the search
                tallies["?"] = f"error: {e}"

    if in_stock_only:
        found_offers = [o for o in found_offers if o.in_stock]

    ranked = rank(query, found_offers)
    offers = []
    for o, sc in ranked:
        d = _offer_dict(o)
        d["score"] = round(sc, 3)
        offers.append(d)
    return {"query": query, "vendor_query": vq, "count": len(offers),
            "tallies": tallies, "offers": offers}


class _Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):   # quiet console
        pass

    def _send(self, code, body, ctype="application/json; charset=utf-8"):
        data = body.encode("utf-8") if isinstance(body, str) else body
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/":
            self._send(200, PAGE, "text/html; charset=utf-8")
            return
        if parsed.path == "/api/search":
            qs = parse_qs(parsed.query)
            q = (qs.get("q") or [""])[0].strip()
            in_stock = (qs.get("in_stock") or ["0"])[0] in ("1", "true", "on")
            if not q:
                self._send(400, json.dumps({"error": "missing q"}))
                return
            try:
                result = search_all(q, in_stock_only=in_stock)
                self._send(200, json.dumps(result))
            except Exception as e:
                self._send(500, json.dumps({"error": str(e)}))
            return
        self._send(404, json.dumps({"error": "not found"}))


def serve(host: str = "127.0.0.1", port: int = 8765, open_browser: bool = True) -> None:
    httpd = ThreadingHTTPServer((host, port), _Handler)
    url = f"http://{host}:{port}/"
    print(f"BOM search UI running at {url}  (Ctrl+C to stop)")
    if open_browser:
        try:
            webbrowser.open(url)
        except Exception:
            pass
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")
        httpd.server_close()


PAGE = r"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>BOM Search — Indian electronics suppliers</title>
<style>
  :root{
    --bg:#0f1115; --panel:#171a21; --panel2:#1e222b; --line:#2a2f3a;
    --txt:#e6e9ef; --muted:#9aa3b2; --accent:#4f8cff; --ok:#2fbf71; --out:#6b7280;
    --sale:#ff5c7a;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--txt);
    font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
  header{position:sticky;top:0;background:linear-gradient(#0f1115,#0f1115ee);
    border-bottom:1px solid var(--line);padding:18px 20px;z-index:5;backdrop-filter:blur(6px)}
  .wrap{max-width:960px;margin:0 auto}
  h1{font-size:18px;margin:0 0 12px;font-weight:650;letter-spacing:.2px}
  h1 span{color:var(--muted);font-weight:400;font-size:13px}
  form{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
  input[type=search]{flex:1;min-width:220px;background:var(--panel2);border:1px solid var(--line);
    color:var(--txt);padding:11px 14px;border-radius:10px;font-size:15px;outline:none}
  input[type=search]:focus{border-color:var(--accent)}
  button{background:var(--accent);color:#fff;border:0;padding:11px 18px;border-radius:10px;
    font-size:15px;font-weight:600;cursor:pointer}
  button:disabled{opacity:.5;cursor:default}
  label.chk{display:flex;gap:6px;align-items:center;color:var(--muted);font-size:13px;user-select:none;cursor:pointer}
  .status{max-width:960px;margin:14px auto 0;color:var(--muted);font-size:13px;padding:0 20px}
  main{max-width:960px;margin:0 auto;padding:8px 20px 60px}
  .card{display:flex;gap:14px;background:var(--panel);border:1px solid var(--line);
    border-radius:12px;padding:12px;margin-top:12px;align-items:center}
  .card img{width:64px;height:64px;object-fit:contain;background:#fff;border-radius:8px;flex:0 0 auto}
  .noimg{width:64px;height:64px;border-radius:8px;background:var(--panel2);flex:0 0 auto}
  .info{flex:1;min-width:0}
  .title{font-weight:600;margin:0 0 4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .meta{display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:12px;color:var(--muted)}
  .chip{padding:2px 8px;border-radius:999px;font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.3px}
  .robu{background:#2b2140;color:#c9a9ff}
  .zbotic{background:#12303a;color:#7fd8ff}
  .roboticsdna{background:#1d2f1f;color:#8fe6a4}
  .badge{padding:2px 8px;border-radius:999px;font-size:11px;font-weight:600}
  .in{background:rgba(47,191,113,.15);color:var(--ok)}
  .no{background:rgba(107,114,128,.2);color:var(--out)}
  .price{text-align:right;flex:0 0 auto;min-width:110px}
  .price .now{font-size:18px;font-weight:700}
  .price .was{font-size:12px;color:var(--muted);text-decoration:line-through}
  .price .sale{color:var(--sale);font-size:11px;font-weight:600}
  a.view{color:var(--accent);text-decoration:none;font-size:12px;white-space:nowrap}
  a.view:hover{text-decoration:underline}
  .empty{color:var(--muted);text-align:center;padding:50px 0}
  .spin{display:inline-block;width:14px;height:14px;border:2px solid var(--muted);
    border-top-color:transparent;border-radius:50%;animation:sp .7s linear infinite;vertical-align:-2px}
  @keyframes sp{to{transform:rotate(360deg)}}
</style>
</head>
<body>
<header><div class="wrap">
  <h1>BOM Search <span>· live prices across robu · zbotic · roboticsdna</span></h1>
  <form id="f">
    <input id="q" type="search" placeholder="Search a part — e.g. ESP32, LM2596, STM32F103, 0.1uF 0805" autofocus>
    <label class="chk"><input id="stock" type="checkbox"> in stock only</label>
    <button id="go" type="submit">Search</button>
  </form>
</div></header>
<div class="status" id="status"></div>
<main id="results"></main>
<script>
const $=s=>document.querySelector(s);
const rupee=v=>v==null?'—':'₹'+Number(v).toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2});
const esc=s=>(s||'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
function stockBadge(s){if(s===true)return '<span class="badge in">in stock</span>';
  if(s===false)return '<span class="badge no">out of stock</span>';return '<span class="badge no">stock ?</span>';}
function card(o){
  const img=o.image?`<img src="${esc(o.image)}" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'noimg'}))">`:'<div class="noimg"></div>';
  const price=o.on_sale
    ? `<div class="now">${rupee(o.price)}</div><div class="was">${rupee(o.regular_price)}</div><div class="sale">SALE</div>`
    : `<div class="now">${rupee(o.price)}</div>`;
  return `<div class="card">${img}
    <div class="info">
      <div class="title" title="${esc(o.title)}">${esc(o.title)}</div>
      <div class="meta">
        <span class="chip ${o.supplier}">${o.supplier}</span>
        ${stockBadge(o.in_stock)}
        ${o.mpn?`<span>MPN ${esc(o.mpn)}</span>`:''}
        ${o.sku?`<span>SKU ${esc(o.sku)}</span>`:''}
        <a class="view" href="${esc(o.url)}" target="_blank" rel="noopener">view at ${o.supplier} ↗</a>
      </div>
    </div>
    <div class="price">${price}</div>
  </div>`;
}
async function run(e){
  if(e)e.preventDefault();
  const q=$('#q').value.trim(); if(!q)return;
  const inStock=$('#stock').checked?'1':'0';
  $('#go').disabled=true;
  $('#status').innerHTML='<span class="spin"></span> searching suppliers…';
  $('#results').innerHTML='';
  try{
    const r=await fetch(`/api/search?q=${encodeURIComponent(q)}&in_stock=${inStock}`);
    const d=await r.json();
    if(d.error){$('#status').textContent='Error: '+d.error;return;}
    const t=Object.entries(d.tallies).map(([k,v])=>`${k}: ${v}`).join('  ·  ');
    $('#status').innerHTML=`${d.count} offer(s) for “${esc(d.query)}”  <span style="opacity:.6">— ${t}</span>`;
    $('#results').innerHTML=d.offers.length?d.offers.map(card).join(''):'<div class="empty">No matches. Try a broader term.</div>';
  }catch(err){$('#status').textContent='Request failed: '+err;}
  finally{$('#go').disabled=false;}
}
$('#f').addEventListener('submit',run);
</script>
</body>
</html>
"""
