/**
 * Vercel Serverless Function — /api/site-profile
 * Proxies to OKE's /api/site-profile endpoint.
 */
const OKE_BASE = (process.env.TRIALS_API_BASE || "").replace(/\/$/, "");

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!OKE_BASE) return res.status(503).json({ error: "TRIALS_API_BASE not configured" });

  const url = new URL(`${OKE_BASE}/api/site-profile`);
  for (const [k, v] of Object.entries(req.query)) url.searchParams.set(k, v);

  try {
    const upstream = await fetch(url.toString(), { signal: AbortSignal.timeout(30000) });
    const body = await upstream.json();
    return res.status(upstream.status).json(body);
  } catch (err) {
    return res.status(502).json({ error: "Site profile proxy failed", detail: err.message });
  }
}
