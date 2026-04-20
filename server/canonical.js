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
  const m = lookup.get(field);
  if (value == null || value === "") {
    // null / undefined / empty → look for "" or "unknown" in catalog
    if (m) {
      if (m.has("")) return m.get("");
      if (m.has("unknown")) return m.get("unknown");
    }
    return value;
  }
  const s = String(value).trim();
  if (!s) {
    if (m && m.has("")) return m.get("");
    return s;
  }
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
 * Use LLM to classify UNMAPPED raw values into existing canonical groups.
 * Existing groups are preserved. Only new/long-tail values are sent to the LLM
 * for classification into the existing buckets (or a new bucket if truly novel).
 *
 * @param {string} field
 * @param {Array<[string, number]>} distinctValues [label, count] sorted desc
 * @param {string} token GITHUB_COPILOT_TOKEN
 * @param {Array<{canonical:string, rawValues:string[], note?:string}>} existingGroups current groups for this field
 * @returns {Array<{canonical:string, rawValues:string[], note?:string}>} updated groups (existing + new assignments)
 */
export async function rebuildField(field, distinctValues, token, existingGroups = []) {
  // Build set of already-mapped raw values (lowercase for comparison)
  const alreadyMapped = new Set();
  for (const g of existingGroups) {
    alreadyMapped.add(String(g.canonical).toLowerCase().trim());
    for (const rv of (g.rawValues || [])) {
      alreadyMapped.add(String(rv).toLowerCase().trim());
    }
  }

  // Filter to unmapped values only
  const unmapped = distinctValues
    .filter(([v]) => !alreadyMapped.has(String(v).toLowerCase().trim()))
    .slice(0, 300);

  if (unmapped.length === 0) {
    // Everything is already mapped — return existing groups as-is
    return existingGroups;
  }

  const existingBuckets = existingGroups.map(g => g.canonical);
  const bucketList = existingBuckets.map(b => `- "${b}"`).join("\n");
  const valueList = unmapped.map(([v, c]) => `- "${v}" (n=${c})`).join("\n");

  const systemPrompt = `You are a clinical-trial data steward. You are given a set of EXISTING canonical group names and a list of NEW unmapped raw values. Classify each unmapped value into the most appropriate existing group. Only create a new group if a value truly does not fit any existing group.

Respond with ONLY valid JSON — no markdown, no commentary. Schema:
{"assignments":[{"canonical":"<existing or new group name>","rawValues":["<raw1>","<raw2>",...],"note":"<short rationale>"}]}

Rules:
- Every rawValue from the input must appear exactly once (don't drop any).
- rawValues must match the input strings exactly (preserve case/spelling).
- STRONGLY prefer assigning to an existing group over creating a new one.
- If you must create a new group, use Title Case for the canonical name.
- For ambiguous values, prefer the broadest applicable existing group.
`;
  const userPrompt = `Field: ${field}\n\nExisting canonical groups:\n${bucketList}\n\nNew unmapped values to classify (${unmapped.length}):\n${valueList}`;

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
  const assignments = parsed.assignments || parsed.groups; // support both formats
  if (!assignments || !Array.isArray(assignments)) throw new Error("LLM returned no assignments");

  // Merge assignments back into existing groups
  const merged = existingGroups.map(g => ({
    ...g,
    rawValues: [...(g.rawValues || [])],
  }));
  const byCanonical = new Map();
  for (const g of merged) byCanonical.set(g.canonical.toLowerCase().trim(), g);

  for (const a of assignments) {
    const key = String(a.canonical).toLowerCase().trim();
    if (byCanonical.has(key)) {
      // Append new raw values to existing group
      const existing = byCanonical.get(key);
      for (const rv of (a.rawValues || [])) {
        if (!existing.rawValues.some(e => String(e).toLowerCase() === String(rv).toLowerCase())) {
          existing.rawValues.push(rv);
        }
      }
    } else {
      // Truly new group — add it
      const newGroup = { canonical: a.canonical, rawValues: a.rawValues || [], note: a.note || "AI-generated" };
      merged.push(newGroup);
      byCanonical.set(key, newGroup);
    }
  }

  return merged;
}
