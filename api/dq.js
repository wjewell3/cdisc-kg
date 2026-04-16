/**
 * Vercel Serverless Function — /api/dq
 * Proxies POST requests to the OKE server's /api/dq/parse-rule endpoint.
 * Used by RulesManager to parse natural-language rules via GPT-4.1.
 */

const OKE_BASE = (process.env.TRIALS_API_BASE || "").replace(/\/$/, "");

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  if (!OKE_BASE) {
    return res.status(503).json({ error: "DQ endpoint requires TRIALS_API_BASE to be configured" });
  }

  try {
    const upstream = await fetch(`${OKE_BASE}/api/dq/parse-rule`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.body),
      signal: AbortSignal.timeout(25000),
    });
    const body = await upstream.json();
    return res.status(upstream.status).json(body);
  } catch (err) {
    console.error("DQ proxy failed:", err.message);
    return res.status(502).json({ error: "DQ proxy failed", detail: err.message });
  }
}
