/**
 * Vercel Serverless Function — /api/analytics
 * Unified proxy for operational KPI endpoints on OKE.
 *
 * mode=failure-analysis     → /api/failure-analysis
 * mode=sponsor-performance  → /api/sponsor-performance
 * mode=enrollment-benchmark → /api/enrollment-benchmark
 * mode=geographic           → /api/geographic-intelligence
 */
const OKE_BASE = (process.env.TRIALS_API_BASE || "").replace(/\/$/, "");

const MODE_MAP = {
  "failure-analysis": "/api/failure-analysis",
  "sponsor-performance": "/api/sponsor-performance",
  "enrollment-benchmark": "/api/enrollment-benchmark",
  "geographic": "/api/geographic-intelligence",
};

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (!OKE_BASE) return res.status(503).json({ error: "TRIALS_API_BASE not configured" });

  const { mode, ...rest } = req.query;
  const path = MODE_MAP[mode];
  if (!path) return res.status(400).json({ error: `Unknown mode: ${mode}. Valid: ${Object.keys(MODE_MAP).join(", ")}` });

  try {
    const url = new URL(`${OKE_BASE}${path}`);
    for (const [k, v] of Object.entries(rest)) {
      url.searchParams.set(k, v);
    }
    const timeout = mode === "geographic" ? 30000 : 15000;
    const upstream = await fetch(url.toString(), { signal: AbortSignal.timeout(timeout) });
    const body = await upstream.json();
    return res.status(upstream.status).json(body);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
