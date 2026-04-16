/**
 * Vercel Serverless Function — /api/graph (GET only)
 * Proxies graph traversal GET endpoints to OKE trials-api.
 * NL→Cypher queries are handled by /api/graph-query (POST).
 *
 * Routes (via query param `path`):
 *   /api/graph?path=stats
 *   /api/graph?path=therapeutic-adjacency&condition=...&limit=...
 *   /api/graph?path=sponsor-overlap&sponsor=...&limit=...
 *   /api/graph?path=strategic-gaps&sponsor=...&limit=...
 *   /api/graph?path=repurposing-path&from=...&to=...
 *   /api/graph?path=condition-landscape&condition=...&limit=...
 *   /api/graph?path=sponsor-network&sponsor=...&limit=...
 */
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const base = process.env.TRIALS_API_BASE;
  if (!base) return res.status(503).json({ error: "TRIALS_API_BASE not configured" });

  const { path, ...rest } = req.query;
  if (!path) return res.status(400).json({ error: "path param required" });

  const url = new URL(`${base}/api/graph/${path}`);
  for (const [k, v] of Object.entries(rest)) {
    url.searchParams.set(k, v);
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    const upstream = await fetch(url.toString(), { signal: controller.signal });
    clearTimeout(timeout);
    const data = await upstream.json();
    res.status(upstream.status).json(data);
  } catch (e) {
    if (e.name === "AbortError") {
      return res.status(504).json({ error: "Graph query timed out" });
    }
    res.status(502).json({ error: "Graph backend unavailable", detail: e.message });
  }
}
