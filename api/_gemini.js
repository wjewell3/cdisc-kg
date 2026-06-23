// Shared Gemini LLM client for the Vercel functions.
// Uses Gemini's OpenAI-compatible endpoint, so request/response shape matches the
// old GitHub Copilot (gpt-4.1) calls. Round-robins GEMINI_API_KEYS (set in Vercel
// env) and rotates to the next key on 429 (per-key daily free-tier RPD), matching
// review-pulse's pattern. The leading underscore keeps Vercel from routing this file.
const GEMINI_KEYS = (process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || "")
  .split(",").map((k) => k.trim()).filter(Boolean);
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
let _keyIdx = 0;

export function hasGemini() { return GEMINI_KEYS.length > 0; }

// Returns the raw fetch Response so streaming callers can read .body and
// non-streaming callers can call .json(). Rotates keys on 429.
export async function geminiFetch({ messages, max_tokens, temperature = 0.1, stream = false, signal }) {
  if (!GEMINI_KEYS.length) throw new Error("GEMINI_API_KEYS not configured");
  let lastErr;
  for (let attempt = 0; attempt < GEMINI_KEYS.length + 3; attempt++) {
    const key = GEMINI_KEYS[_keyIdx++ % GEMINI_KEYS.length];
    const res = await fetch(GEMINI_URL, {
      method: "POST",
      signal,
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: GEMINI_MODEL,
        messages,
        temperature,
        ...(max_tokens ? { max_tokens } : {}),
        ...(stream ? { stream: true } : {}),
      }),
    });
    // 429 = per-key daily quota (rotate key); 503/500 = transient overload (brief backoff + retry).
    if (res.status === 429 || res.status === 503 || res.status === 500) {
      lastErr = new Error(`Gemini ${res.status} — retrying`);
      if (res.status !== 429) await new Promise((r) => setTimeout(r, 800));
      continue;
    }
    return res;
  }
  throw lastErr || new Error("Gemini: all keys exhausted");
}
