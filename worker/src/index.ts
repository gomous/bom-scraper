/**
 * Entry point. Two responsibilities:
 *   fetch()     — the search API called by the GitHub Pages frontend.
 *   scheduled() — the cron-driven incremental ingestion into Vectorize.
 */
import type { Env } from "./types";
import { handleSearch, handleLookup, handleOptions } from "./search";
import { runIngest } from "./ingest";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") return handleOptions(url, env);

    if (url.pathname === "/api/search") {
      return handleSearch(url, env);
    }

    // Agent-facing, API-key-gated search (for Claude / other tools). Same engine
    // as /api/search but returns a clean component-details shape and requires the
    // API_KEY secret. See docs/AGENT_API.md.
    if (url.pathname === "/api/lookup") {
      return handleLookup(url, request, env);
    }

    // Manual ingestion trigger — bootstraps the index without waiting for cron.
    // Gated by the INGEST_TOKEN secret (set via `wrangler secret put`). Runs ONE
    // slice and returns stats.
    if (url.pathname === "/api/ingest") {
      const provided = url.searchParams.get("token") || "";
      if (!env.INGEST_TOKEN || provided !== env.INGEST_TOKEN) {
        return new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }
      const stats = await runIngest(env);
      return new Response(JSON.stringify(stats), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.pathname === "/" || url.pathname === "/health") {
      return new Response(
        JSON.stringify({ ok: true, service: "bom-aggregator", endpoints: ["/api/search?q=", "/api/lookup?q= (key)"] }),
        { headers: { "Content-Type": "application/json" } },
      );
    }

    return new Response("Not found", { status: 404 });
  },

  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      runIngest(env).then((s) =>
        console.log(`[ingest] ${s.supplier} pages=${s.pagesFetched} upserted=${s.productsUpserted}`),
      ),
    );
  },
};
