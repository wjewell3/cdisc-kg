export default async function handler(req, res) {
  const base = process.env.TRIALS_API_BASE;
  if (!base) return res.status(503).json({ error: "TRIALS_API_BASE not configured" });

  const { type, name } = req.query;
  if (!type || !name) return res.status(400).json({ error: "type and name required" });

  const url = `${base}/api/entity-insight?type=${encodeURIComponent(type)}&name=${encodeURIComponent(name)}`;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    const upstream = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    const data = await upstream.json();
    res.status(upstream.status).json(data);
  } catch (e) {
    res.status(502).json({ error: "Upstream unavailable", detail: e.message });
  }
}
