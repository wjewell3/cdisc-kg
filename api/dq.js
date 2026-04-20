/**
 * Vercel Serverless Function — /api/dq/*
 * - POST /api/dq with { text }              → parse NL rule via GPT-4.1 (direct)
 * - GET  /api/dq?action=canonical           → fetch catalog from OKE
 * - POST /api/dq?action=canonical           → save catalog to OKE
 * - POST /api/dq?action=canonical-rebuild   → rebuild catalog via LLM on OKE
 */

const OKE_BASE = process.env.TRIALS_API_BASE || "http://129.80.137.184";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const action = (req.query?.action || "").toString();

  // ── Canonical catalog: proxy to OKE ─────────────────────────────
  if (action === "canonical" || action === "canonical-rebuild") {
    const path = action === "canonical-rebuild" ? "/api/dq/canonical/rebuild" : "/api/dq/canonical";
    const url = `${OKE_BASE}${path}`;
    try {
      const init = { method: req.method, headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(60000) };
      if (req.method === "POST") init.body = JSON.stringify(req.body || {});
      const upstream = await fetch(url, init);
      const data = await upstream.json().catch(() => ({}));
      return res.status(upstream.status).json(data);
    } catch (e) {
      console.error("canonical proxy failed:", e.message);
      return res.status(502).json({ error: "Upstream failed", detail: e.message });
    }
  }

  // ── Default: parse-rule (direct LLM call) ───────────────────────
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { text } = req.body || {};
  if (!text || typeof text !== "string") return res.status(400).json({ error: "text required" });

  const token = process.env.GITHUB_COPILOT_TOKEN;
  if (!token) return res.status(503).json({ error: "GITHUB_COPILOT_TOKEN not configured in Vercel env" });

  const systemPrompt = `You are a data quality rule parser for clinical trials data. Given a natural language description, extract a structured rule and respond with ONLY valid JSON — no markdown fences, no extra text.

For grouping rules (merging synonymous values into one canonical label):
{"ruleType":"grouping","field":"intervention|condition|sponsor|status|phase","canonical":"<canonical label>","rawValues":["<raw1>","<raw2>",...]}

For enrollment range bounds:
{"ruleType":"bounds","min":<integer or null>,"max":<integer or null>}`;

  try {
    const response = await fetch("https://models.inference.ai.azure.com/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4.1",
        max_tokens: 300,
        temperature: 0,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: text },
        ],
      }),
      signal: AbortSignal.timeout(25000),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      console.error("Copilot API error:", response.status, errText.slice(0, 200));
      throw new Error(`LLM API error ${response.status}`);
    }

    const llmData = await response.json();
    const raw = (llmData.choices?.[0]?.message?.content || "").trim()
      .replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
    const parsed = JSON.parse(raw);
    return res.status(200).json(parsed);
  } catch (e) {
    console.error("DQ parse-rule failed:", e.message);
    return res.status(500).json({ error: "Failed to parse rule", detail: e.message });
  }
}
