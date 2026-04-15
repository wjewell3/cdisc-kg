/**
 * index.js — Express API server for CDISC-KG trials.
 *
 * Queries a local SQLite snapshot of AACT (built by snapshot.js).
 * Falls back to live AACT PostgreSQL if the snapshot is missing or stale.
 *
 * Env vars:
 *   DB_PATH        Path to SQLite file (default: /data/aact.db)
 *   PORT           Listen port (default: 3001)
 *   CORS_ORIGIN    Allowed origin (default: *)
 *   STALE_HOURS    Hours after which snapshot is considered stale (default: 48)
 *   AACT_USER      PostgreSQL fallback credentials
 *   AACT_PASSWORD
 */

import express from "express";
import cors from "cors";
import Database from "better-sqlite3";
import { existsSync, statSync } from "fs";
import pg from "pg";

const {
  DB_PATH = "/data/aact.db",
  PORT = "3001",
  CORS_ORIGIN = "*",
  STALE_HOURS = "48",
  AACT_USER,
  AACT_PASSWORD,
  AACT_HOST = "aact-db.ctti-clinicaltrials.org",
} = process.env;

// ── SQLite ────────────────────────────────────────────────────────────────────

let db = null;
let snapshotAge = null; // ISO string from _meta

function openDb() {
  if (!existsSync(DB_PATH)) return null;
  try {
    const d = new Database(DB_PATH, { readonly: true });
    d.pragma("cache_size = -32000");
    const meta = d.prepare("SELECT value FROM _meta WHERE key = 'snapshot_time'").get();
    snapshotAge = meta?.value || null;
    const ageHours = snapshotAge
      ? (Date.now() - new Date(snapshotAge).getTime()) / 3_600_000
      : Infinity;
    if (ageHours > parseFloat(STALE_HOURS)) {
      console.warn(`[server] SQLite snapshot is ${ageHours.toFixed(1)}h old — falling back to live AACT`);
      d.close();
      return null;
    }
    console.log(`[server] Using SQLite snapshot from ${snapshotAge}`);
    return d;
  } catch (e) {
    console.error("[server] Failed to open SQLite:", e.message);
    return null;
  }
}

db = openDb();

// Re-check for a fresh snapshot every 10 minutes (CronJob may have written one)
setInterval(() => {
  if (!db) {
    const fresh = openDb();
    if (fresh) { db = fresh; console.log("[server] Loaded fresh SQLite snapshot"); }
  } else {
    // Check if the file on disk is newer than what we have open
    try {
      const stat = statSync(DB_PATH);
      const diskMtime = stat.mtimeMs;
      const ourMtime = snapshotAge ? new Date(snapshotAge).getTime() : 0;
      if (diskMtime > ourMtime + 60_000) {
        const fresh = openDb();
        if (fresh) { db.close(); db = fresh; console.log("[server] Reloaded updated SQLite snapshot"); }
      }
    } catch {}
  }
}, 600_000);

// ── PostgreSQL fallback ────────────────────────────────────────────────────────

let pgPool = null;
function getPgPool() {
  if (pgPool) return pgPool;
  if (!AACT_USER || !AACT_PASSWORD) return null;
  pgPool = new pg.Pool({
    host: AACT_HOST, port: 5432, database: "aact",
    user: AACT_USER.trim(), password: AACT_PASSWORD.trim(),
    ssl: { rejectUnauthorized: false },
    max: 3, idleTimeoutMillis: 10000, connectionTimeoutMillis: 8000,
  });
  return pgPool;
}

// ── WHERE clause builder (shared SQLite + PG) ─────────────────────────────────

/**
 * Build WHERE clauses compatible with SQLite positional params ($1 → ?).
 * Returns { where: string, params: any[] } for SQLite.
 */
function buildSqliteWhere({ q = "", condition = "", intervention = "", phase = "", status = "", sponsor = "", min_enrollment = "", max_enrollment = "" }) {
  const where = [];
  const params = [];

  if (q) {
    where.push(`s.nct_id IN (SELECT nct_id FROM studies_fts WHERE studies_fts MATCH ?)`);
    // FTS5 MATCH — wrap with quotes to handle special chars, search as prefix
    params.push(`"${q.replace(/"/g, '""')}"`);
  }

  if (condition) {
    const vals = condition.split(",").map((c) => c.trim()).filter(Boolean);
    const sub = vals.map(() => `EXISTS (SELECT 1 FROM conditions c WHERE c.nct_id = s.nct_id AND c.name LIKE ?)`).join(" OR ");
    where.push(`(${sub})`);
    for (const v of vals) params.push(`%${v}%`);
  }

  if (intervention) {
    const vals = intervention.split(",").map((v) => v.trim()).filter(Boolean);
    const sub = vals.map(() => `EXISTS (SELECT 1 FROM interventions i WHERE i.nct_id = s.nct_id AND i.name LIKE ?)`).join(" OR ");
    where.push(`(${sub})`);
    for (const v of vals) params.push(`%${v}%`);
  }

  if (phase) {
    const phases = phase.split(",").map((p) => p.trim().toUpperCase().replace(/ /g, "")).filter(Boolean);
    where.push(`s.phase IN (${phases.map(() => "?").join(",")})`);
    params.push(...phases);
  }

  if (status) {
    const statuses = status.split(",").map((s) => s.trim()).filter(Boolean);
    where.push(`s.overall_status IN (${statuses.map(() => "?").join(",")})`);
    params.push(...statuses);
  }

  if (sponsor) {
    const vals = sponsor.split(",").map((s) => s.trim()).filter(Boolean);
    const sub = vals.map(() => `EXISTS (SELECT 1 FROM sponsors sp WHERE sp.nct_id = s.nct_id AND sp.lead_or_collaborator = 'lead' AND sp.name LIKE ?)`).join(" OR ");
    where.push(`(${sub})`);
    for (const v of vals) params.push(`%${v}%`);
  }

  if (min_enrollment !== "") {
    where.push(`s.enrollment >= ?`);
    params.push(parseInt(min_enrollment));
  }
  if (max_enrollment !== "" && parseInt(max_enrollment) < 999999999) {
    where.push(`s.enrollment <= ?`);
    params.push(parseInt(max_enrollment));
  }

  return { where: where.length ? `WHERE ${where.join(" AND ")}` : "", params };
}

// ── SQLite query functions ─────────────────────────────────────────────────────

function sqliteSearch({ q, condition, intervention, phase, status, sponsor, limit, min_enrollment, max_enrollment }) {
  const { where, params } = buildSqliteWhere({ q, condition, intervention, phase, status, sponsor, min_enrollment, max_enrollment });

  const sql = `
    SELECT
      s.nct_id, s.brief_title, s.overall_status, s.phase, s.study_type,
      s.enrollment, s.enrollment_type, s.start_date, s.completion_date,
      s.has_dmc, s.why_stopped,
      (SELECT group_concat(c.name, '; ') FROM (SELECT DISTINCT name FROM conditions WHERE nct_id = s.nct_id LIMIT 5) c) AS conditions,
      (SELECT group_concat(i.intervention_type || ': ' || i.name, '; ') FROM (SELECT DISTINCT intervention_type, name FROM interventions WHERE nct_id = s.nct_id LIMIT 5) i) AS interventions,
      (SELECT sp.name FROM sponsors sp WHERE sp.nct_id = s.nct_id AND sp.lead_or_collaborator = 'lead' LIMIT 1) AS sponsor,
      NULL AS primary_outcome,
      NULL AS arm_count
    FROM studies s
    ${where}
    ORDER BY s.status_order ASC, s.enrollment DESC NULLS LAST
    LIMIT ?
  `;

  const countSql = `SELECT COUNT(*) AS total FROM studies s ${where}`;

  const rows = db.prepare(sql).all(...params, limit);
  const { total } = db.prepare(countSql).get(...params);
  return { total: parseInt(total), returned: rows.length, limit, results: rows.map(normalizeRow) };
}

function sqliteStats({ q, condition, intervention, phase, status, sponsor, min_enrollment, max_enrollment }) {
  const { where, params } = buildSqliteWhere({ q, condition, intervention, phase, status, sponsor, min_enrollment, max_enrollment });
  const enrollWhere = where ? `${where} AND s.enrollment IS NOT NULL` : "WHERE s.enrollment IS NOT NULL";
  const enrollParams = [...params]; // same params, no extras needed

  const phaseRows = db.prepare(`SELECT COALESCE(s.phase, 'Unknown') AS val, COUNT(*) AS count FROM studies s ${where} GROUP BY 1 ORDER BY count DESC`).all(...params);
  const statusRows = db.prepare(`SELECT COALESCE(s.overall_status, 'Unknown') AS val, COUNT(*) AS count FROM studies s ${where} GROUP BY 1 ORDER BY count DESC`).all(...params);
  const sponsorRows = db.prepare(`
    SELECT sp.name AS val, COUNT(*) AS count
    FROM studies s
    JOIN sponsors sp ON sp.nct_id = s.nct_id AND sp.lead_or_collaborator = 'lead'
    ${where}
    GROUP BY sp.name ORDER BY count DESC LIMIT 20
  `).all(...params);
  const enrollRows = db.prepare(`
    SELECT
      CASE
        WHEN s.enrollment < 100 THEN '< 100'
        WHEN s.enrollment < 500 THEN '100–499'
        WHEN s.enrollment < 1000 THEN '500–999'
        WHEN s.enrollment < 5000 THEN '1k–4.9k'
        WHEN s.enrollment < 20000 THEN '5k–19k'
        ELSE '≥ 20k'
      END AS val,
      COUNT(*) AS count
    FROM studies s ${enrollWhere}
    GROUP BY 1 ORDER BY MIN(s.enrollment)
  `).all(...enrollParams);
  const { total } = db.prepare(`SELECT COUNT(*) AS total FROM studies s ${where}`).get(...params);

  const toObj = (rows) => Object.fromEntries(rows.map((r) => [r.val, r.count]));
  return {
    total: parseInt(total),
    phase: toObj(phaseRows),
    status: toObj(statusRows),
    sponsor: sponsorRows.map((r) => [r.val, r.count]),
    enrollment: toObj(enrollRows),
  };
}

// ── PostgreSQL fallback functions (same logic as original Vercel api/trials.js) ──

function buildPgWhere({ q = "", condition = "", intervention = "", phase = "", status = "", sponsor = "" }) {
  const params = []; const where = []; let p = 1;
  if (q) { where.push(`(s.brief_title ILIKE $${p} OR EXISTS (SELECT 1 FROM conditions c WHERE c.nct_id = s.nct_id AND c.name ILIKE $${p}) OR EXISTS (SELECT 1 FROM interventions i WHERE i.nct_id = s.nct_id AND i.name ILIKE $${p}) OR EXISTS (SELECT 1 FROM brief_summaries bs WHERE bs.nct_id = s.nct_id AND bs.description ILIKE $${p}))`); params.push(`%${q}%`); p++; }
  if (condition) { const vals = condition.split(",").map((c) => c.trim()).filter(Boolean); const clauses = vals.map((c) => { params.push(`%${c}%`); return `EXISTS (SELECT 1 FROM conditions c WHERE c.nct_id = s.nct_id AND c.name ILIKE $${p++})`; }); where.push(`(${clauses.join(" OR ")})`); }
  if (intervention) { const vals = intervention.split(",").map((v) => v.trim()).filter(Boolean); const clauses = vals.map((iv) => { params.push(`%${iv}%`); return `EXISTS (SELECT 1 FROM interventions i WHERE i.nct_id = s.nct_id AND i.name ILIKE $${p++})`; }); where.push(`(${clauses.join(" OR ")})`); }
  if (phase) { const phases = phase.split(",").map((ph) => ph.trim().toUpperCase().replace(/ /g, "")).filter(Boolean); if (phases.length === 1) { where.push(`s.phase = $${p}`); params.push(phases[0]); p++; } else { const phs = phases.map(() => `$${p++}`).join(","); where.push(`s.phase IN (${phs})`); params.push(...phases); } }
  if (status) { const statuses = status.split(",").map((s) => s.trim()).filter(Boolean); if (statuses.length === 1) { where.push(`s.overall_status ILIKE $${p}`); params.push(statuses[0]); p++; } else { const phs = statuses.map(() => `$${p++}`).join(","); where.push(`s.overall_status IN (${phs})`); params.push(...statuses); } }
  if (sponsor) { const vals = sponsor.split(",").map((s) => s.trim()).filter(Boolean); const clauses = vals.map((sp) => { params.push(`%${sp}%`); return `EXISTS (SELECT 1 FROM sponsors sp WHERE sp.nct_id = s.nct_id AND sp.lead_or_collaborator = 'lead' AND sp.name ILIKE $${p++})`; }); where.push(`(${clauses.join(" OR ")})`); }
  return { whereClause: where.length ? `WHERE ${where.join(" AND ")}` : "", params, nextP: p };
}

async function pgSearch({ q, condition, intervention, phase, status, sponsor, limit }) {
  const pool = getPgPool();
  const { whereClause, params, nextP } = buildPgWhere({ q, condition, intervention, phase, status, sponsor });
  const sql = `SELECT s.nct_id, s.brief_title, s.overall_status, s.phase, s.study_type, s.enrollment, s.enrollment_type, s.start_date, s.completion_date, s.has_dmc, s.why_stopped, (SELECT string_agg(name, '; ' ORDER BY name) FROM (SELECT DISTINCT name FROM conditions WHERE nct_id = s.nct_id LIMIT 5) cond) AS conditions, (SELECT string_agg(CONCAT(intervention_type, ': ', name), '; ' ORDER BY name) FROM (SELECT DISTINCT intervention_type, name FROM interventions WHERE nct_id = s.nct_id LIMIT 5) intv) AS interventions, (SELECT name FROM sponsors WHERE nct_id = s.nct_id AND lead_or_collaborator = 'lead' LIMIT 1) AS sponsor, (SELECT measure FROM design_outcomes WHERE nct_id = s.nct_id AND outcome_type = 'primary' ORDER BY id LIMIT 1) AS primary_outcome, (SELECT COUNT(*) FROM design_groups WHERE nct_id = s.nct_id) AS arm_count FROM studies s ${whereClause} ORDER BY CASE s.overall_status WHEN 'RECRUITING' THEN 0 WHEN 'ACTIVE_NOT_RECRUITING' THEN 1 WHEN 'COMPLETED' THEN 2 ELSE 3 END, s.enrollment DESC NULLS LAST LIMIT $${nextP}`;
  params.push(limit);
  const { rows } = await pool.query(sql, params);
  const { rows: countRows } = await pool.query(`SELECT COUNT(*) AS total FROM studies s ${whereClause}`, params.slice(0, -1));
  return { total: parseInt(countRows[0]?.total || rows.length), returned: rows.length, limit, results: rows.map(normalizeRow) };
}

async function pgStats({ q, condition, intervention, phase, status, sponsor }) {
  const pool = getPgPool();
  const { whereClause, params } = buildPgWhere({ q, condition, intervention, phase, status, sponsor });
  const enrollWhere = whereClause ? `${whereClause} AND s.enrollment IS NOT NULL` : "WHERE s.enrollment IS NOT NULL";
  const [phaseRes, statusRes, sponsorRes, enrollRes, countRes] = await Promise.all([
    pool.query(`SELECT COALESCE(s.phase,'Unknown') AS val, COUNT(*)::int AS count FROM studies s ${whereClause} GROUP BY 1 ORDER BY count DESC`, params),
    pool.query(`SELECT COALESCE(s.overall_status,'Unknown') AS val, COUNT(*)::int AS count FROM studies s ${whereClause} GROUP BY 1 ORDER BY count DESC`, params),
    pool.query(`SELECT sp2.name AS val, COUNT(*)::int AS count FROM studies s JOIN sponsors sp2 ON sp2.nct_id=s.nct_id AND sp2.lead_or_collaborator='lead' ${whereClause} GROUP BY sp2.name ORDER BY count DESC LIMIT 20`, params),
    pool.query(`SELECT CASE WHEN s.enrollment<100 THEN '< 100' WHEN s.enrollment<500 THEN '100–499' WHEN s.enrollment<1000 THEN '500–999' WHEN s.enrollment<5000 THEN '1k–4.9k' WHEN s.enrollment<20000 THEN '5k–19k' ELSE '≥ 20k' END AS val, COUNT(*)::int AS count FROM studies s ${enrollWhere} GROUP BY 1 ORDER BY MIN(s.enrollment)`, params),
    pool.query(`SELECT COUNT(*)::int AS total FROM studies s ${whereClause}`, params),
  ]);
  const toObj = (rows) => Object.fromEntries(rows.map((r) => [r.val, r.count]));
  return { total: countRes.rows[0]?.total || 0, phase: toObj(phaseRes.rows), status: toObj(statusRes.rows), sponsor: sponsorRes.rows.map((r) => [r.val, r.count]), enrollment: toObj(enrollRes.rows) };
}

// ── shared ────────────────────────────────────────────────────────────────────

function normalizeRow(row) {
  return {
    nct_id: row.nct_id,
    title: row.brief_title,
    status: row.overall_status,
    phase: row.phase,
    study_type: row.study_type,
    enrollment: row.enrollment ? parseInt(row.enrollment) : null,
    enrollment_type: row.enrollment_type,
    start_date: row.start_date,
    completion_date: row.completion_date,
    sponsor: row.sponsor,
    conditions: row.conditions,
    interventions: row.interventions,
    primary_outcome: row.primary_outcome,
    arm_count: row.arm_count ? parseInt(row.arm_count) : null,
    has_dmc: row.has_dmc,
    why_stopped: row.why_stopped,
  };
}

// ── Express app ───────────────────────────────────────────────────────────────

const app = express();
app.use(cors({ origin: CORS_ORIGIN }));

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    backend: db ? "sqlite" : "postgres",
    snapshot_time: snapshotAge,
  });
});

app.get("/api/trials", async (req, res) => {
  const {
    q = "", phase = "", status = "", sponsor = "",
    limit: rawLimit = "50", mode = "search",
    condition = "", intervention = "",
    min_enrollment = "", max_enrollment = "",
  } = req.query;

  const limit = Math.min(parseInt(rawLimit, 10) || 100, 500);

  try {
    if (mode === "stats") {
      const result = db
        ? sqliteStats({ q, condition, intervention, phase, status, sponsor, min_enrollment, max_enrollment })
        : await pgStats({ q, condition, intervention, phase, status, sponsor });
      return res.json(result);
    }

    const result = db
      ? sqliteSearch({ q, condition, intervention, phase, status, sponsor, limit, min_enrollment, max_enrollment })
      : await pgSearch({ q, condition, intervention, phase, status, sponsor, limit });
    return res.json(result);
  } catch (err) {
    console.error("[server] query error:", err.message);
    return res.status(500).json({ error: "Query failed", detail: err.message });
  }
});

// ── Trial Intelligence ────────────────────────────────────────────────────────

app.get("/api/trial-intelligence", async (req, res) => {
  const { nct_id } = req.query;
  if (!nct_id || !/^NCT\d{8}$/.test(nct_id.toUpperCase())) {
    return res.status(400).json({ error: "Valid nct_id required (e.g. NCT01234567)" });
  }
  const id = nct_id.toUpperCase();

  if (!db) {
    return res.status(503).json({ error: "SQLite snapshot required for trial intelligence" });
  }

  // 1. Fetch target trial
  const trial = db.prepare(`
    SELECT s.*,
      bs.description,
      (SELECT group_concat(c.name, '; ') FROM conditions c WHERE c.nct_id = s.nct_id) AS conditions_text,
      (SELECT group_concat(i.name, '; ')  FROM interventions i WHERE i.nct_id = s.nct_id) AS interventions_text,
      (SELECT sp.name FROM sponsors sp WHERE sp.nct_id = s.nct_id AND sp.lead_or_collaborator = 'lead' LIMIT 1) AS lead_sponsor
    FROM studies s
    LEFT JOIN brief_summaries bs ON bs.nct_id = s.nct_id
    WHERE s.nct_id = ?
  `).get(id);

  if (!trial) return res.status(404).json({ error: `Trial ${id} not found in snapshot` });

  // 2. Find condition-similar completed/terminated trials via FTS5 then same-phase filter
  const topKeyword = (trial.conditions_text || trial.brief_title || "")
    .split(/[;,]/)[0]
    .replace(/[^a-zA-Z0-9 ]/g, " ")
    .trim();

  let comparables = [];
  if (topKeyword) {
    try {
      const ftsRows = db.prepare(
        `SELECT nct_id FROM studies_fts WHERE studies_fts MATCH ? LIMIT 300`
      ).all(`"${topKeyword.replace(/"/g, '""')}"`);
      const ids = ftsRows.map((r) => r.nct_id).filter((x) => x !== id);
      if (ids.length > 0) {
        const ph = ids.map(() => "?").join(",");
        comparables = db.prepare(`
          SELECT nct_id, brief_title, overall_status, phase, enrollment, enrollment_type,
            start_date, completion_date, why_stopped,
            CAST(julianday(completion_date) - julianday(start_date) AS INTEGER) AS duration_days
          FROM studies
          WHERE overall_status IN ('COMPLETED','TERMINATED')
            AND phase = ?
            AND nct_id IN (${ph})
            AND start_date IS NOT NULL AND completion_date IS NOT NULL
          LIMIT 80
        `).all(trial.phase, ...ids);
      }
    } catch (_) { /* FTS error — fall through */ }
  }

  // Phase-only fallback
  if (comparables.length < 10) {
    comparables = db.prepare(`
      SELECT nct_id, brief_title, overall_status, phase, enrollment, enrollment_type,
        start_date, completion_date, why_stopped,
        CAST(julianday(completion_date) - julianday(start_date) AS INTEGER) AS duration_days
      FROM studies
      WHERE overall_status IN ('COMPLETED','TERMINATED')
        AND phase = ?
        AND nct_id != ?
        AND start_date IS NOT NULL AND completion_date IS NOT NULL
      ORDER BY RANDOM() LIMIT 80
    `).all(trial.phase, id);
  }

  // 3. Compute risk signals
  const completed = comparables.filter((c) => c.overall_status === "COMPLETED");
  const terminated = comparables.filter((c) => c.overall_status === "TERMINATED");
  const termRate = comparables.length > 0
    ? parseFloat(((terminated.length / comparables.length) * 100).toFixed(1))
    : null;

  const durations = comparables.map((c) => c.duration_days).filter((d) => d > 30 && d < 5475);
  durations.sort((a, b) => a - b);
  const medianDuration = durations.length > 0 ? durations[Math.floor(durations.length / 2)] : null;
  const p25Duration = durations.length > 0 ? durations[Math.floor(durations.length * 0.25)] : null;
  const p75Duration = durations.length > 0 ? durations[Math.floor(durations.length * 0.75)] : null;

  const enrollments = comparables.filter((c) => c.enrollment > 0).map((c) => parseInt(c.enrollment));
  enrollments.sort((a, b) => a - b);
  const medianEnroll = enrollments.length > 0 ? enrollments[Math.floor(enrollments.length / 2)] : null;

  const stopReasons = terminated
    .filter((c) => c.why_stopped)
    .map((c) => c.why_stopped)
    .slice(0, 6);

  const riskSignals = {
    comparable_count: comparables.length,
    completed_count: completed.length,
    terminated_count: terminated.length,
    termination_rate_pct: termRate,
    high_termination_risk: termRate !== null && termRate > 20,
    median_duration_days: medianDuration,
    duration_p25_days: p25Duration,
    duration_p75_days: p75Duration,
    median_comparable_enrollment: medianEnroll,
    target_enrollment: trial.enrollment ? parseInt(trial.enrollment) : null,
    enrollment_vs_median: trial.enrollment && medianEnroll
      ? parseFloat(((parseInt(trial.enrollment) / medianEnroll - 1) * 100).toFixed(1))
      : null,
    common_stop_reasons: stopReasons,
  };

  // 4. Optional LLM briefing via Anthropic
  let briefing = null;
  const { ANTHROPIC_API_KEY } = process.env;
  if (ANTHROPIC_API_KEY) {
    try {
      const systemPrompt = `You are a senior clinical trial operations expert advising a CRO sponsor executive.
Respond in concise, plain English — no bullet overload, 3-5 short paragraphs.
Focus on practical operational risk, not academic commentary.`;

      const userMsg = `Analyze this clinical trial and provide an operational risk briefing.

TRIAL:
- NCT ID: ${trial.nct_id}
- Title: ${trial.brief_title}
- Status: ${trial.overall_status}
- Phase: ${trial.phase || "Unknown"}
- Study Type: ${trial.study_type || "Unknown"}
- Target Enrollment: ${trial.enrollment ? trial.enrollment.toLocaleString() : "not specified"}
- Start Date: ${trial.start_date || "unknown"}
- Primary Completion: ${trial.primary_completion_date || "unknown"}
- Lead Sponsor: ${trial.lead_sponsor || "unknown"}
- Conditions: ${trial.conditions_text || "not specified"}
- Interventions: ${trial.interventions_text || "not specified"}
${trial.why_stopped ? `- Why Stopped: ${trial.why_stopped}` : ""}

COMPARABLE TRIAL BENCHMARK (${riskSignals.comparable_count} completed/terminated ${trial.phase} trials for ${topKeyword}):
- Early termination rate: ${termRate !== null ? termRate + "%" : "unknown"} (industry benchmark ~15%)
- Median trial duration: ${medianDuration ? Math.round(medianDuration / 30.4) + " months" : "unknown"}
- Duration range (P25–P75): ${p25Duration && p75Duration ? Math.round(p25Duration / 30.4) + "–" + Math.round(p75Duration / 30.4) + " months" : "unknown"}
- Median enrollment in comparables: ${medianEnroll ? medianEnroll.toLocaleString() : "unknown"}
- Enrollment delta vs. comparable median: ${riskSignals.enrollment_vs_median !== null ? riskSignals.enrollment_vs_median + "%" : "unknown"}
${stopReasons.length > 0 ? `- Common early stop reasons in comparables: ${stopReasons.join("; ")}` : ""}

Write a 3–5 paragraph operational risk briefing covering:
1. Overall risk posture for this trial
2. Timeline risks based on comparable duration benchmarks
3. Enrollment risks vs. comparable performance
4. Key watch-out signals and recommended mitigations`;

      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "claude-haiku-4-5",
          max_tokens: 600,
          system: systemPrompt,
          messages: [{ role: "user", content: userMsg }],
        }),
      });
      if (response.ok) {
        const data = await response.json();
        briefing = data.content?.[0]?.text || null;
      } else {
        console.error("[intelligence] Anthropic API error:", response.status, await response.text());
      }
    } catch (e) {
      console.error("[intelligence] LLM call failed:", e.message);
    }
  }

  return res.json({
    trial: {
      nct_id: trial.nct_id,
      title: trial.brief_title,
      status: trial.overall_status,
      phase: trial.phase,
      study_type: trial.study_type,
      enrollment: trial.enrollment,
      start_date: trial.start_date,
      primary_completion_date: trial.primary_completion_date,
      conditions: trial.conditions_text,
      sponsor: trial.lead_sponsor,
    },
    risk_signals: riskSignals,
    briefing,
    comparable_examples: comparables.slice(0, 5).map((c) => ({
      nct_id: c.nct_id,
      title: c.brief_title,
      status: c.overall_status,
      duration_months: c.duration_days ? Math.round(c.duration_days / 30.4) : null,
      enrollment: c.enrollment,
      why_stopped: c.why_stopped,
    })),
  });
});

app.listen(parseInt(PORT), () => {
  console.log(`[server] listening on :${PORT} — backend: ${db ? `sqlite (${snapshotAge})` : "postgres fallback"}`);
});
