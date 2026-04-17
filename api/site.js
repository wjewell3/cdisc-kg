/**
 * Vercel Serverless Function — /api/site
 * Unified proxy for site search and site profile.
 * ?mode=search  → /api/site-search  (15s timeout)
 * ?mode=profile → /api/site-profile (30s timeout)
 */
const OKE_BASE = (process.env.TRIALS_API_BASE || "").replace(/\/$/, "");

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!OKE_BASE) return res.status(503).json({ error: "TRIALS_API_BASE not configured" });

  const { mode, ...rest } = req.query;
  if (!mode || !["search", "profile"].includes(mode)) {
    return res.status(400).json({ error: "mode must be 'search' or 'profile'" });
  }

  const timeout = mode === "profile" ? 30000 : 15000;
  const url = new URL(`${OKE_BASE}/api/site-${mode}`);
  for (const [k, v] of Object.entries(rest)) url.searchParams.set(k, v);

  try {
    const upstream = await fetch(url.toString(), { signal: AbortSignal.timeout(timeout) });
    const body = await upstream.json();
    return res.status(upstream.status).json(body);
  } catch (err) {
    return res.status(502).json({ error: `Site ${mode} proxy failed`, detail: err.message });
  }
}
