/**
 * Vercel Serverless Function — /api/trial-intelligence
 * Proxies to the OKE server's /api/trial-intelligence endpoint.
 * Requires TRIALS_API_BASE env var (server-side only, not VITE_).
 */

const OKE_BASE = (process.env.TRIALS_API_BASE || "").replace(/\/$/, "");

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  if (!OKE_BASE) {
    return res.status(503).json({ error: "Trial Intelligence requires TRIALS_API_BASE to be configured" });
  }

  const url = new URL(`${OKE_BASE}/api/trial-intelligence`);
  const { nct_id } = req.query;
  if (nct_id) url.searchParams.set("nct_id", nct_id);

  try {
    const upstream = await fetch(url.toString(), { signal: AbortSignal.timeout(25000) });
    const body = await upstream.json();
    return res.status(upstream.status).json(body);
  } catch (err) {
    console.error("OKE trial-intelligence proxy failed:", err.message);
    return res.status(502).json({ error: "Intelligence proxy failed", detail: err.message });
  }
}
