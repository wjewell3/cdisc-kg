/**
 * canonical.js — Canonical-groupings catalog.
 *
 * - Loads /data/canonical-groupings.json (user-edited, PVC) if present,
 *   else falls back to bundled ./canonical-groupings.json (repo seed).
 * - Exports canonicalize(field, value) and mergeByCanonical(field, rows, keyField, countField).
 * - Supports hot-reload via reload() and write-through via save(nextCatalog).
 * - Supports LLM-driven rebuild for a single field via rebuildField(field, distinctValues, token).
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED_PATH = join(__dirname, "canonical-groupings.json");
const USER_PATH = process.env.CANONICAL_PATH || "/data/canonical-groupings.json";

let catalog = { _meta: { version: 1, source: "empty" } };
// Fast lookup: field → Map(lower(rawValue) → canonical)
let lookup = new Map();

function buildLookup(cat) {
  const m = new Map();
  for (const field of Object.keys(cat)) {
    if (field.startsWith("_")) continue;
    const fieldMap = new Map();
    const groups = cat[field] || [];
    for (const g of groups) {
      const canonical = g.canonical;
      for (const rv of (g.rawValues || [])) {
        fieldMap.set(String(rv).toLowerCase().trim(), canonical);
      }
      // canonical also maps to itself so repeated passes are idempotent
      fieldMap.set(String(canonical).toLowerCase().trim(), canonical);
    }
    m.set(field, fieldMap);
  }
  return m;
}

export function reload() {
  try {
    if (existsSync(USER_PATH)) {
      catalog = JSON.parse(readFileSync(USER_PATH, "utf8"));
      console.log(`[canonical] Loaded user catalog from ${USER_PATH}`);
    } else if (existsSync(SEED_PATH)) {
      catalog = JSON.parse(readFileSync(SEED_PATH, "utf8"));
      console.log(`[canonical] Loaded seed catalog from ${SEED_PATH}`);
    } else {
      catalog = { _meta: { version: 1, source: "empty" } };
      console.warn("[canonical] No catalog found; using empty");
    }
    lookup = buildLookup(catalog);
  } catch (e) {
    console.error("[canonical] Failed to load catalog:", e.message);
    catalog = { _meta: { version: 1, source: "error", error: e.message } };
    lookup = new Map();
  }
}

reload();

export function getCatalog() { return catalog; }

export function save(nextCatalog) {
  // Validate shape
  if (!nextCatalog || typeof nextCatalog !== "object") throw new Error("catalog must be object");
  nextCatalog._meta = {
    ...(nextCatalog._meta || {}),
    version: 1,
    updated: new Date().toISOString(),
    source: nextCatalog._meta?.source || "user",
  };
  try {
    const dir = dirname(USER_PATH);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(USER_PATH, JSON.stringify(nextCatalog, null, 2), "utf8");
  } catch (e) {
    console.error("[canonical] Failed to persist catalog:", e.message);
    throw e;
  }
  catalog = nextCatalog;
  lookup = buildLookup(catalog);
  return catalog;
}

export function canonicalize(field, value) {
  if (value == null) return value;
  const s = String(value).trim();
  if (!s) {
    // Treat empty as a raw value so seed rules can claim it
    const m = lookup.get(field);
    if (m && m.has("")) return m.get("");
    return s;
  }
  const m = lookup.get(field);
  if (!m) return s;
  return m.get(s.toLowerCase()) || s;
}

/**
 * Given an array of rows, merge rows that share the same canonical key.
 * Numeric count fields are summed. Non-numeric conflicting fields are preserved
 * from the largest-count row (stable tiebreak on first).
 *
 * @param {string} field
 * @param {Array<object>} rows
 * @param {string} keyField          row field whose value is the raw category label
 * @param {Array<string>} countFields columns to sum on merge (default: ['count','total','terminated','completed','reported','affected','at_risk'])
 */
export function mergeByCanonical(field, rows, keyField, countFields = ["count", "total", "terminated", "completed", "reported", "affected", "at_risk"]) {
  if (!Array.isArray(rows) || !rows.length) return rows;
  const grouped = new Map();
  const order = [];
  for (const r of rows) {
    const raw = r[keyField];
    const canonical = canonicalize(field, raw);
    if (!grouped.has(canonical)) {
      grouped.set(canonical, { ...r, [keyField]: canonical });
      order.push(canonical);
    } else {
      const cur = grouped.get(canonical);
      for (const cf of countFields) {
        if (typeof r[cf] === "number") cur[cf] = (cur[cf] || 0) + r[cf];
      }
    }
  }
  return order.map(k => grouped.get(k));
}

/**
 * Use LLM to cluster raw values into canonical groups.
 * @param {string} field
 * @param {Array<[string, number]>} distinctValues [label, count] sorted desc
 * @param {string} token GITHUB_COPILOT_TOKEN
 * @returns {Array<{canonical:string, rawValues:string[], note?:string}>}
 */
export async function rebuildField(field, distinctValues, token) {
  const values = distinctValues.slice(0, 300);
  const valueList = values.map(([v, c]) => `- "${v}" (n=${c})`).join("\n");
  const systemPrompt = `You are a clinical-trial data steward. Cluster raw categorical values into canonical groups that merge obvious synonyms, case variants, typos, and near-synonyms with the same operational meaning. Keep distinct meanings separate. Prefer a small number of clear, broad categories (5-15 is ideal).

Respond with ONLY valid JSON — no markdown, no commentary. Schema:
{"groups":[{"canonical":"<Title Case label>","rawValues":["<raw1>","<raw2>",...],"note":"<short rationale>"}]}

Rules:
- Include every rawValue from the input exactly once across groups (don't drop any).
- rawValues must match the input strings exactly (preserve case/spelling so downstream lookup works).
- Prefer broad operational categories over hyper-specific ones.
- For the "phase" field, map "Unknown", "NA", "N/A", and empty to a single "Not Applicable" group.
- For "stop_reason": group all accrual/enrollment/recruitment shortfalls into one "Accrual issues" bucket; group funding/financial together; group business/sponsor/strategic decisions together.
- For "withdrawal_reason": group all disease-progression variants together; group subject-initiated withdrawals together; group AE/SAE/toxicity together.
`;
  const userPrompt = `Field: ${field}\n\nRaw values (top ${values.length} by frequency):\n${valueList}`;

  const res = await fetch("https://models.inference.ai.azure.com/chat/completions", {
    method: "POST",
    headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4.1",
      max_tokens: 4000,
      temperature: 0,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`LLM API ${res.status}: ${errText.slice(0, 200)}`);
  }
  const data = await res.json();
  const raw = (data.choices?.[0]?.message?.content || "").trim()
    .replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
  const parsed = JSON.parse(raw);
  if (!parsed.groups || !Array.isArray(parsed.groups)) throw new Error("LLM returned no groups");
  return parsed.groups;
}
