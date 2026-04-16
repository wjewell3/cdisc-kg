/**
 * Vercel Serverless Function — /api/graph-query
 *
 * Orchestrates the NL → Cypher → execute → narrate pipeline.
 * All GitHub Copilot API calls happen here (Vercel IP is trusted).
 * Cypher execution is delegated to OKE via /api/graph/execute.
 *
 * Body: { question: "Which sponsors have the most Phase 3 oncology trials?" }
 * Returns: { cypher, columns, rows, total, narrative }
 */

const GRAPH_SCHEMA_PROMPT = `You have access to a Neo4j knowledge graph of 580k+ clinical trials from ClinicalTrials.gov.

GRAPH SCHEMA:
Node labels and their properties:
  - Trial { nct_id, title, status, phase, study_type, enrollment, enrollment_type, start_date, completion_date, has_dmc, why_stopped, duration_months, facility_count, results_reported, months_to_report, sae_subjects, us_facility, single_facility }
  - Sponsor { name }
  - Condition { name }
  - Intervention { name }
  - Site { key, name, city, state, country }
  - Country { name }

Relationships:
  - (Sponsor)-[:RUNS]->(Trial)
  - (Trial)-[:TREATS]->(Condition)
  - (Trial)-[:USES]->(Intervention)
  - (Trial)-[:AT]->(Site)
  - (Site)-[:IN_COUNTRY]->(Country)
  - (Trial)-[:CONDUCTED_IN]->(Country)

IMPORTANT RULES:
1. Return ONLY the Cypher query — no markdown, no explanation, no backticks.
2. Always use LIMIT (max 50 rows).
3. Prefer COUNT, COLLECT, aggregations over raw node lists.
4. Always alias returned columns with descriptive names using AS.
5. For text matching use toLower() with CONTAINS or STARTS WITH — never regex.
6. Do NOT use CREATE, MERGE, SET, DELETE, DETACH DELETE, REMOVE, DROP, or CALL {}.
7. status values are strings like: "Recruiting", "Completed", "Active, not recruiting", "Terminated", "Withdrawn".
8. phase values: "Phase 1", "Phase 2", "Phase 3", "Phase 4", "Phase 1/Phase 2", "Phase 2/Phase 3", "N/A".
9. For path queries, use shortestPath() with [:TREATS|USES*..8].
10. Site nodes may be sparsely populated — prefer Trial/Sponsor/Condition/Intervention for most queries.`;

const OKE_BASE = (process.env.TRIALS_API_BASE || "").replace(/\/$/, "");

async function callLLM(token, messages, maxTokens = 400, temperature = 0) {
  const response = await fetch("https://api.githubcopilot.com/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4.1",
      max_tokens: maxTokens,
      temperature,
      messages,
    }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub Copilot API ${response.status}: ${text.slice(0, 200)}`);
  }
  const data = await response.json();
  return data.choices?.[0]?.message?.content || "";
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { question } = req.body || {};
  if (!question || typeof question !== "string" || question.trim().length < 5) {
    return res.status(400).json({ error: "question required (min 5 chars)" });
  }

  const token = process.env.GITHUB_COPILOT_TOKEN;
  if (!token) return res.status(503).json({ error: "GITHUB_COPILOT_TOKEN not configured" });
  if (!OKE_BASE) return res.status(503).json({ error: "TRIALS_API_BASE not configured" });

  const sanitized = question.trim().slice(0, 500);

  try {
    // Step 1: Generate Cypher from natural language (Vercel → GitHub Copilot ✓)
    let generatedCypher = await callLLM(token, [
      { role: "system", content: GRAPH_SCHEMA_PROMPT },
      { role: "user", content: sanitized },
    ], 400, 0);

    // Strip markdown fences
    generatedCypher = generatedCypher
      .replace(/^```(?:cypher)?\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();

    if (!generatedCypher || generatedCypher.length < 10) {
      return res.status(422).json({ error: "Could not generate a valid query for that question" });
    }

    // Step 2: Execute Cypher on OKE (Vercel → OKE Neo4j ✓)
    const execResponse = await fetch(`${OKE_BASE}/api/graph/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cypher: generatedCypher }),
      signal: AbortSignal.timeout(20000),
    });

    if (!execResponse.ok) {
      const execErr = await execResponse.json().catch(() => ({}));
      return res.status(execResponse.status).json({
        error: execErr.error || "Cypher execution failed",
        cypher: generatedCypher,
        detail: execErr.detail,
      });
    }

    const { columns, rows, total } = await execResponse.json();

    // Step 3: Generate narrative (Vercel → GitHub Copilot ✓)
    let narrative = null;
    if (rows && rows.length > 0) {
      try {
        const resultPreview = JSON.stringify(rows.slice(0, 15), null, 2);
        narrative = await callLLM(token, [
          { role: "system", content: "You are a clinical trials operations analyst. Summarize query results in 2-3 concise sentences. Focus on the key operational insight. No bullet points." },
          { role: "user", content: `Question: "${sanitized}"\n\nReturned ${total} rows. Top results:\n${resultPreview}` },
        ], 350, 0.3);
      } catch (e) {
        // Narrative is optional — don't fail the whole request
        console.error("[graph-query] narrative failed:", e.message);
      }
    }

    res.json({ cypher: generatedCypher, columns, rows, total, narrative });
  } catch (e) {
    console.error("[graph-query] error:", e.message);
    res.status(500).json({ error: e.message });
  }
}
