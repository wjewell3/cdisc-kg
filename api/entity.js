/**
 * Vercel Serverless Function — /api/entity
 * Unified proxy for entity insight and entity intelligence.
 * ?mode=insight     → /api/entity-insight    (20s timeout)
 * ?mode=intelligence → /api/entity-intelligence (60s timeout)
 */
const OKE_BASE = (process.env.TRIALS_API_BASE || "").replace(/\/$/, "");

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!OKE_BASE) return res.status(503).json({ error: "TRIALS_API_BASE not configured" });

  const { mode, ...rest } = req.query;
  if (!mode || !["insight", "intelligence"].includes(mode)) {
    return res.status(400).json({ error: "mode must be 'insight' or 'intelligence'" });
  }

  const timeout = mode === "intelligence" ? 60000 : 20000;
  const url = new URL(`${OKE_BASE}/api/entity-${mode}`);
  for (const [k, v] of Object.entries(rest)) url.searchParams.set(k, v);

  try {
    const upstream = await fetch(url.toString(), { signal: AbortSignal.timeout(timeout) });
    const body = await upstream.json();
    return res.status(upstream.status).json(body);
  } catch (err) {
    return res.status(502).json({ error: `Entity ${mode} proxy failed`, detail: err.message });
  }
}
