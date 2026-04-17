/**
 * Vercel Serverless Function — /api/query
 *
 * Handles natural-language CDISC/SDTM queries.
 * Loads the SDTM graph data (bundled statically), builds context, and
 * calls the GitHub Copilot API (GPT-4.1) with streaming SSE back to the client.
 *
 * GET /api/query?q=<question>
 * Returns: SSE stream — data: {type:"token",text:"..."} | data: {type:"result",data:{...}} | data: [DONE]
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load once at module level (cached across warm invocations)
let _graphData = null;
function getGraphData() {
  if (_graphData) return _graphData;
  const p = path.join(__dirname, "../ui/src/graphData.json");
  _graphData = JSON.parse(fs.readFileSync(p, "utf8"));
  return _graphData;
}

function buildSDTMContext(graphData) {
  const { domains, standards_flow, stats } = graphData;
  const lines = [
    "SDTM Implementation Guide v3.4 — Structured Domain Reference",
    `Graph: ${stats?.node_count ?? "?"} nodes, ${stats?.edge_count ?? "?"} edges`,
    "",
  ];

  for (const [code, domain] of Object.entries(domains)) {
    lines.push(`## Domain: ${code} — ${domain.name}`);
    lines.push(`Class: ${domain.class} | Structure: ${domain.structure}`);
    lines.push(`Description: ${domain.description}`);
    if (domain.related_domains?.length) {
      lines.push(`Related: ${domain.related_domains.join(", ")}`);
    }
    lines.push("Variables (Name | Core | Type | Label | Codelist):");
    for (const v of domain.variables) {
      const cl = v.codelist
        ? ` | CL:${v.codelist.name}[${(v.codelist.values || []).slice(0, 6).join(",")}${(v.codelist.values || []).length > 6 ? "…" : ""}]`
        : "";
      lines.push(`  ${v.name} | ${v.core} | ${v.type} | ${v.label}${cl}`);
      if (v.description) lines.push(`    desc: ${v.description}`);
    }
    lines.push("");
  }

  if (standards_flow?.length) {
    lines.push("## CDISC Data Standards Flow");
    for (const f of standards_flow) {
      lines.push(`  ${f.from} → ${f.to}: ${f.description}`);
    }
  }

  return lines.join("\n");
}

const SYSTEM_PROMPT_TEMPLATE = (sdtmContext) => `\
You are a CDISC SDTM expert assistant. Answer questions about SDTM domains, variables, codelists, and standards.

${sdtmContext}

When answering:
- Be concise and precise.
- After your plain-text answer, append a JSON block (wrapped in \`\`\`json ... \`\`\`) for structured rendering.
- The JSON must have this shape:
  {
    "type": "<one of: variable_list | codelist_detail | domain_list | variable_detail | relationship | shared_variables | stats | flow | no_results>",
    "answer": "<1-3 sentence plain-text summary>",
    "context": "<optional additional context>",
    "data": <array or object relevant to the type, or null>
  }
- variable_list data: [{ name, label, type, core, domain }]
- codelist_detail data: { codelist: "<name>", values: ["..."] }
- domain_list data: [{ code, name }]
- variable_detail data: [{ name, domain, core, type, label, description }]
- relationship data: [{ relationship, via_variable, description }]
- shared_variables data: ["VAR1", "VAR2", ...]
- stats data: { node_types: { Standard: N, Domain: N, Variable: N, Codelist: N } }
- flow data: [{ from, to, description }]
- no_results data: null (include suggestions array at top level)
If the question cannot be answered from the SDTM data provided, set type to "no_results" and explain what's not covered.`;

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });

  const q = (req.query?.q || "").trim().slice(0, 600);
  if (q.length < 3) return res.status(400).json({ error: "q required (min 3 chars)" });

  const token = process.env.GITHUB_COPILOT_TOKEN;
  if (!token) {
    return res.status(503).json({ error: "GITHUB_COPILOT_TOKEN not configured" });
  }

  // Start SSE
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  const done = () => { res.write("data: [DONE]\n\n"); res.end(); };

  try {
    const graphData = getGraphData();
    const sdtmContext = buildSDTMContext(graphData);
    const systemPrompt = SYSTEM_PROMPT_TEMPLATE(sdtmContext);

    const llmRes = await fetch("https://models.inference.ai.azure.com/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4.1",
        max_tokens: 1200,
        temperature: 0.1,
        stream: true,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: q },
        ],
      }),
      signal: AbortSignal.timeout(45000),
    });

    if (!llmRes.ok) {
      const errText = await llmRes.text();
      send({ type: "error", message: `LLM error ${llmRes.status}: ${errText.slice(0, 200)}` });
      return done();
    }

    const reader = llmRes.body.getReader();
    const decoder = new TextDecoder();
    let fullText = "";
    let sseBuffer = "";

    while (true) {
      const { done: streamDone, value } = await reader.read();
      if (streamDone) break;
      sseBuffer += decoder.decode(value, { stream: true });
      const lines = sseBuffer.split("\n");
      sseBuffer = lines.pop();

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const payload = line.slice(6).trim();
        if (payload === "[DONE]") break;
        try {
          const chunk = JSON.parse(payload);
          const text = chunk.choices?.[0]?.delta?.content || "";
          if (text) {
            fullText += text;
            send({ type: "token", text });
          }
        } catch {}
      }
    }

    // Extract JSON block from the full response
    const jsonMatch = fullText.match(/```json\s*([\s\S]*?)```/);
    if (jsonMatch) {
      try {
        const structured = JSON.parse(jsonMatch[1].trim());
        send({ type: "result", data: structured });
      } catch {}
    }

    done();
  } catch (err) {
    send({ type: "error", message: err.message || "Unknown error" });
    done();
  }
}
