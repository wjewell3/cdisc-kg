/**
 * Vercel Serverless Function — /api/graph/*
 * Proxies all graph traversal endpoints to OKE trials-api.
 *
 * GET routes (via query param `path`):
 *   /api/graph?path=stats
 *   /api/graph?path=therapeutic-adjacency&condition=...&limit=...
 *   /api/graph?path=sponsor-overlap&sponsor=...&limit=...
 *   /api/graph?path=strategic-gaps&sponsor=...&limit=...
 *   /api/graph?path=repurposing-path&from=...&to=...
 *   /api/graph?path=condition-landscape&condition=...&limit=...
 *   /api/graph?path=sponsor-network&sponsor=...&limit=...
 *
 * POST route:
 *   /api/graph?path=query  body: { question: "..." }
 */
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const base = process.env.TRIALS_API_BASE;
  if (!base) return res.status(503).json({ error: "TRIALS_API_BASE not configured" });

  const { path, ...rest } = req.query;
  if (!path) return res.status(400).json({ error: "path param required" });

  const url = new URL(`${base}/api/graph/${path}`);

  // POST requests (e.g. /api/graph?path=query) — forward body as JSON
  if (req.method === "POST") {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000);
      const upstream = await fetch(url.toString(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req.body),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      const data = await upstream.json();
      return res.status(upstream.status).json(data);
    } catch (e) {
      if (e.name === "AbortError") return res.status(504).json({ error: "Graph query timed out" });
      return res.status(502).json({ error: "Graph backend unavailable", detail: e.message });
    }
  }

  // GET requests — forward query params
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
