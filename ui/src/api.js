const API = import.meta.env.VITE_API_URL || "http://localhost:8000";

export async function fetchStats() {
  const res = await fetch(`${API}/api/stats`);
  return res.json();
}

export async function fetchDomains() {
  const res = await fetch(`${API}/api/domains`);
  return res.json();
}

export async function fetchDomainDetail(code) {
  const res = await fetch(`${API}/api/domains/${encodeURIComponent(code)}`);
  if (!res.ok) throw new Error(`Domain ${code} not found`);
  return res.json();
}

export async function fetchSearch(query) {
  const res = await fetch(`${API}/api/search?q=${encodeURIComponent(query)}`);
  return res.json();
}

export async function fetchGraph(includeValues = false) {
  const res = await fetch(`${API}/api/graph?include_values=${includeValues}`);
  return res.json();
}

export async function fetchNeighborhood(nodeId, depth = 1) {
  const res = await fetch(
    `${API}/api/neighborhood/${encodeURIComponent(nodeId)}?depth=${depth}`
  );
  if (!res.ok) throw new Error(`Node ${nodeId} not found`);
  return res.json();
}

export async function fetchStandardsFlow() {
  const res = await fetch(`${API}/api/standards-flow`);
  return res.json();
}

export async function fetchNLQuery(question) {
  const res = await fetch(
    `${API}/api/query?q=${encodeURIComponent(question)}`
  );
  return res.json();
}

/**
 * Stream an LLM-enhanced query via SSE.
 * onChunk(text) — called for each streamed token
 * onStructured(data) — called when the structured graph result arrives
 * onDone() — called when stream ends
 * onError(msg) — called on error
 */
export async function streamLLMQuery(question, { onChunk, onStructured, onDone, onError } = {}) {
  try {
    const res = await fetch(
      `${API}/api/query/stream?q=${encodeURIComponent(question)}`
    );
    if (!res.ok) {
      onError?.(`HTTP ${res.status}`);
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const payload = line.slice(6).trim();
        if (payload === "[DONE]") { onDone?.(); return; }
        try {
          const evt = JSON.parse(payload);
          if (evt.type === "token") onChunk?.(evt.text);
          else if (evt.type === "result") onStructured?.(evt.data);
          else if (evt.type === "error") onError?.(evt.message);
        } catch {}
      }
    }
    onDone?.();
  } catch (err) {
    onError?.(err.message);
  }
}

