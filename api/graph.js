/**
 * Vercel Serverless Function — /api/graph/*
 * Proxies all graph traversal endpoints to OKE trials-api.
 *
 * Routes (via query param `path`):
 *   /api/graph?path=stats
 *   /api/graph?path=therapeutic-adjacency&condition=...&limit=...
 *   /api/graph?path=sponsor-overlap&sponsor=...&limit=...
 *   /api/graph?path=site-risk&nct_id=...
 *   /api/graph?path=site-expertise&site=...&limit=...
 *   /api/graph?path=sponsor-network&sponsor=...&limit=...
 */
export default async function handler(req, res) {
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
