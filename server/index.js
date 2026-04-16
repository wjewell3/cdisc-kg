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
  // Faceted stats: each dimension's query EXCLUDES its own filter so bars
  // never collapse when clicked, but counts reflect all other active filters.
  const base = { q, condition, intervention };
  const { where: phaseWhere,  params: phaseParams  } = buildSqliteWhere({ ...base, phase: "",  status,    sponsor,   min_enrollment, max_enrollment });
  const { where: statusWhere, params: statusParams } = buildSqliteWhere({ ...base, phase,      status: "", sponsor,   min_enrollment, max_enrollment });
  const { where: spWhere,     params: spParams     } = buildSqliteWhere({ ...base, phase,      status,    sponsor: "", min_enrollment, max_enrollment });
  const { where: condWhere,   params: condParams   } = buildSqliteWhere({ q, condition: "",   intervention, phase, status, sponsor, min_enrollment, max_enrollment });
  const { where: intWhere,    params: intParams    } = buildSqliteWhere({ q, condition,       intervention: "", phase, status, sponsor, min_enrollment, max_enrollment });
  const { where: enWhere,     params: enParams     } = buildSqliteWhere({ ...base, phase,      status,    sponsor,   min_enrollment: "", max_enrollment: "" });
  const { where: fullWhere,   params: fullParams   } = buildSqliteWhere({ q, condition, intervention, phase, status, sponsor, min_enrollment, max_enrollment });

  const enrollWhere = enWhere ? `${enWhere} AND s.enrollment IS NOT NULL` : "WHERE s.enrollment IS NOT NULL";

  const phaseRows  = db.prepare(`SELECT COALESCE(s.phase, 'Unknown') AS val, COUNT(*) AS count FROM studies s ${phaseWhere} GROUP BY 1 ORDER BY count DESC`).all(...phaseParams);
  const statusRows = db.prepare(`SELECT COALESCE(s.overall_status, 'Unknown') AS val, COUNT(*) AS count FROM studies s ${statusWhere} GROUP BY 1 ORDER BY count DESC`).all(...statusParams);
  const spRows     = db.prepare(`
    SELECT sp.name AS val, COUNT(*) AS count
    FROM studies s
    JOIN sponsors sp ON sp.nct_id = s.nct_id AND sp.lead_or_collaborator = 'lead'
    ${spWhere}
    GROUP BY sp.name ORDER BY count DESC LIMIT 20
  `).all(...spParams);
  const condRows   = db.prepare(`
    SELECT c.name AS val, COUNT(DISTINCT s.nct_id) AS count
    FROM studies s
    JOIN conditions c ON c.nct_id = s.nct_id
    ${condWhere}
    GROUP BY c.name ORDER BY count DESC LIMIT 20
  `).all(...condParams);
  const intRows    = db.prepare(`
    SELECT i.name AS val, COUNT(DISTINCT s.nct_id) AS count
    FROM studies s
    JOIN interventions i ON i.nct_id = s.nct_id
    ${intWhere}
    GROUP BY i.name ORDER BY count DESC LIMIT 20
  `).all(...intParams);
  const enrollRows = db.prepare(`
    SELECT
      CASE
        WHEN s.enrollment < 100 THEN '< 100'
        WHEN s.enrollment < 500 THEN '100\u2013499'
        WHEN s.enrollment < 1000 THEN '500\u2013999'
        WHEN s.enrollment < 5000 THEN '1k\u20134.9k'
        WHEN s.enrollment < 20000 THEN '5k\u201319k'
        ELSE '\u2265 20k'
      END AS val,
      COUNT(*) AS count
    FROM studies s ${enrollWhere}
    GROUP BY 1 ORDER BY MIN(s.enrollment)
  `).all(...enParams);
  const { total } = db.prepare(`SELECT COUNT(*) AS total FROM studies s ${fullWhere}`).get(...fullParams);

  const toObj = (rows) => Object.fromEntries(rows.map((r) => [r.val, r.count]));
  return {
    total: parseInt(total),
    phase: toObj(phaseRows),
    status: toObj(statusRows),
    sponsor: spRows.map((r) => [r.val, r.count]),
    condition: condRows.map((r) => [r.val, r.count]),
    intervention: intRows.map((r) => [r.val, r.count]),
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
app.use(express.json());

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
    sponsor_q = "",
  } = req.query;

  const limit = Math.min(parseInt(rawLimit, 10) || 100, 500);

  try {
    if (mode === "stats") {
      const result = db
        ? sqliteStats({ q, condition, intervention, phase, status, sponsor, min_enrollment, max_enrollment })
        : await pgStats({ q, condition, intervention, phase, status, sponsor });
      return res.json(result);
    }

    if (mode === "sponsors") {
      // Return all sponsors matching current filters + optional sponsor name search.
      // Excludes the sponsor dimension from the WHERE so clicking a sponsor still shows counts.
      if (!db) return res.status(503).json({ error: "SQLite required" });
      const { where, params: wParams } = buildSqliteWhere({
        q, condition, intervention, phase, status, sponsor: "", min_enrollment, max_enrollment,
      });
      const likeClause = sponsor_q ? "AND LOWER(sp.name) LIKE LOWER(?)" : "";
      const likeParams = sponsor_q ? [`%${sponsor_q}%`] : [];
      const rows = db.prepare(`
        SELECT sp.name AS val, COUNT(*) AS count
        FROM studies s
        JOIN sponsors sp ON sp.nct_id = s.nct_id AND sp.lead_or_collaborator = 'lead'
        ${where} ${likeClause}
        GROUP BY sp.name ORDER BY count DESC LIMIT 100
      `).all(...wParams, ...likeParams);
      return res.json({ sponsors: rows });
    }

    if (mode === "conditions") {
      if (!db) return res.status(503).json({ error: "SQLite required" });
      const q_cond = req.query.condition_q || "";
      const { where, params: wParams } = buildSqliteWhere({
        q, condition: "", intervention, phase, status, sponsor, min_enrollment, max_enrollment,
      });
      const likeClause = q_cond ? "AND LOWER(c.name) LIKE LOWER(?)" : "";
      const likeParams = q_cond ? [`%${q_cond}%`] : [];
      const rows = db.prepare(`
        SELECT c.name AS val, COUNT(DISTINCT s.nct_id) AS count
        FROM studies s
        JOIN conditions c ON c.nct_id = s.nct_id
        ${where} ${likeClause}
        GROUP BY c.name ORDER BY count DESC LIMIT 100
      `).all(...wParams, ...likeParams);
      return res.json({ conditions: rows });
    }

    if (mode === "interventions") {
      if (!db) return res.status(503).json({ error: "SQLite required" });
      const q_int = req.query.intervention_q || "";
      const { where, params: wParams } = buildSqliteWhere({
        q, condition, intervention: "", phase, status, sponsor, min_enrollment, max_enrollment,
      });
      const likeClause = q_int ? "AND LOWER(i.name) LIKE LOWER(?)" : "";
      const likeParams = q_int ? [`%${q_int}%`] : [];
      const rows = db.prepare(`
        SELECT i.name AS val, COUNT(DISTINCT s.nct_id) AS count
        FROM studies s
        JOIN interventions i ON i.nct_id = s.nct_id
        ${where} ${likeClause}
        GROUP BY i.name ORDER BY count DESC LIMIT 100
      `).all(...wParams, ...likeParams);
      return res.json({ interventions: rows });
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

// ── Site Intelligence (Knowledge Graph) ───────────────────────────────────────

app.get("/api/site-search", (req, res) => {
  if (!db) return res.status(503).json({ error: "SQLite snapshot required" });
  try { db.prepare("SELECT 1 FROM facilities LIMIT 1").get(); } catch { return res.status(503).json({ error: "Facilities table not yet available — snapshot in progress" }); }
  const { q, country, limit = "20" } = req.query;
  if (!q || q.length < 2) return res.status(400).json({ error: "q required (min 2 chars)" });
  const lim = Math.min(parseInt(limit) || 20, 100);
  const countryClause = country ? "AND f.country = ?" : "";
  const countryParam = country ? [country] : [];
  const rows = db.prepare(`
    SELECT f.name, f.city, f.state, f.country,
           COUNT(DISTINCT f.nct_id) AS trial_count,
           ROUND(AVG(f.latitude), 4) AS latitude,
           ROUND(AVG(f.longitude), 4) AS longitude
    FROM facilities f
    WHERE f.name LIKE ? ${countryClause}
    GROUP BY f.name, f.city, f.state, f.country
    ORDER BY trial_count DESC
    LIMIT ?
  `).all(`%${q}%`, ...countryParam, lim);
  return res.json({ sites: rows });
});

app.get("/api/site-profile", (req, res) => {
  if (!db) return res.status(503).json({ error: "SQLite snapshot required" });
  try { db.prepare("SELECT 1 FROM facilities LIMIT 1").get(); } catch { return res.status(503).json({ error: "Facilities table not yet available — snapshot in progress" }); }
  const { name, city, state, country } = req.query;
  if (!name) return res.status(400).json({ error: "name required" });

  // Build where clause for exact facility match
  const facWhere = ["f.name = ?"];
  const facParams = [name];
  if (city) { facWhere.push("f.city = ?"); facParams.push(city); }
  if (state) { facWhere.push("f.state = ?"); facParams.push(state); }
  if (country) { facWhere.push("f.country = ?"); facParams.push(country); }
  const w = facWhere.join(" AND ");

  // Get all trial IDs for this facility
  const trialIds = db.prepare(`SELECT DISTINCT f.nct_id FROM facilities f WHERE ${w}`).all(...facParams).map(r => r.nct_id);
  if (trialIds.length === 0) return res.status(404).json({ error: "Site not found" });

  const ph = trialIds.map(() => "?").join(",");

  // Phase distribution
  const phases = db.prepare(`SELECT COALESCE(phase, 'Unknown') AS val, COUNT(*) AS count FROM studies WHERE nct_id IN (${ph}) GROUP BY 1 ORDER BY count DESC`).all(...trialIds);

  // Status distribution
  const statuses = db.prepare(`SELECT COALESCE(overall_status, 'Unknown') AS val, COUNT(*) AS count FROM studies WHERE nct_id IN (${ph}) GROUP BY 1 ORDER BY count DESC`).all(...trialIds);

  // Top conditions
  const conditions = db.prepare(`SELECT c.name AS val, COUNT(DISTINCT c.nct_id) AS count FROM conditions c WHERE c.nct_id IN (${ph}) GROUP BY c.name ORDER BY count DESC LIMIT 15`).all(...trialIds);

  // Top interventions
  const interventions = db.prepare(`SELECT i.name AS val, COUNT(DISTINCT i.nct_id) AS count FROM interventions i WHERE i.nct_id IN (${ph}) GROUP BY i.name ORDER BY count DESC LIMIT 15`).all(...trialIds);

  // Top sponsors
  const sponsors = db.prepare(`SELECT sp.name AS val, COUNT(DISTINCT sp.nct_id) AS count FROM sponsors sp WHERE sp.nct_id IN (${ph}) AND sp.lead_or_collaborator = 'lead' GROUP BY sp.name ORDER BY count DESC LIMIT 15`).all(...trialIds);

  // Operational metrics from calculated_values (graceful — tables may not exist yet)
  let ops = { total_trials: trialIds.length, reported_results: null, avg_duration_months: null, avg_months_to_report: null, total_sae_subjects: null };
  let dropouts = [], durations = [], trialCountries = [], loc = null;
  try {
    ops = db.prepare(`
      SELECT
        COUNT(*) AS total_trials,
        SUM(CASE WHEN cv.were_results_reported = 1 THEN 1 ELSE 0 END) AS reported_results,
        ROUND(AVG(cv.actual_duration), 1) AS avg_duration_months,
        ROUND(AVG(cv.months_to_report_results), 1) AS avg_months_to_report,
        SUM(cv.number_of_sae_subjects) AS total_sae_subjects,
        SUM(cv.number_of_nsae_subjects) AS total_nsae_subjects
      FROM calculated_values cv
      WHERE cv.nct_id IN (${ph})
    `).get(...trialIds) || ops;
    dropouts = db.prepare(`SELECT dw.reason, SUM(dw.count) AS total FROM drop_withdrawals dw WHERE dw.nct_id IN (${ph}) AND dw.reason IS NOT NULL GROUP BY dw.reason ORDER BY total DESC LIMIT 10`).all(...trialIds);
    durations = db.prepare(`SELECT CASE WHEN cv.actual_duration < 12 THEN '< 1 yr' WHEN cv.actual_duration < 24 THEN '1–2 yr' WHEN cv.actual_duration < 36 THEN '2–3 yr' WHEN cv.actual_duration < 60 THEN '3–5 yr' ELSE '5+ yr' END AS bucket, COUNT(*) AS count FROM calculated_values cv WHERE cv.nct_id IN (${ph}) AND cv.actual_duration IS NOT NULL GROUP BY 1 ORDER BY MIN(cv.actual_duration)`).all(...trialIds);
    trialCountries = db.prepare(`SELECT ctry.name AS val, COUNT(DISTINCT ctry.nct_id) AS count FROM countries ctry WHERE ctry.nct_id IN (${ph}) AND ctry.removed = 0 GROUP BY ctry.name ORDER BY count DESC LIMIT 10`).all(...trialIds);
    loc = db.prepare(`SELECT city, state, country, latitude, longitude FROM facilities f WHERE ${w} LIMIT 1`).get(...facParams);
  } catch { /* enrichment tables not yet available — snapshot in progress */ }

  // Completion rate (uses studies table — always available)
  const completionStats = db.prepare(`
    SELECT
      COUNT(*) AS finished,
      SUM(CASE WHEN overall_status = 'COMPLETED' THEN 1 ELSE 0 END) AS completed,
      SUM(CASE WHEN overall_status = 'TERMINATED' THEN 1 ELSE 0 END) AS terminated
    FROM studies
    WHERE nct_id IN (${ph}) AND overall_status IN ('COMPLETED', 'TERMINATED')
  `).get(...trialIds);

  // Recent trials (last 10)
  const recentTrials = db.prepare(`
    SELECT s.nct_id, s.brief_title, s.overall_status, s.phase,
           s.enrollment, s.start_date, s.completion_date
    FROM studies s
    WHERE s.nct_id IN (${ph})
    ORDER BY s.start_date DESC NULLS LAST
    LIMIT 10
  `).all(...trialIds);


  const toObj = (rows) => Object.fromEntries(rows.map(r => [r.val, r.count]));
  const completionRate = completionStats.finished > 0
    ? parseFloat(((completionStats.completed / completionStats.finished) * 100).toFixed(1))
    : null;

  return res.json({
    site: { name, city: loc?.city, state: loc?.state, country: loc?.country, latitude: loc?.latitude, longitude: loc?.longitude },
    summary: {
      total_trials: trialIds.length,
      completion_rate_pct: completionRate,
      completed: completionStats.completed,
      terminated: completionStats.terminated,
      results_reported: ops.reported_results,
      avg_duration_months: ops.avg_duration_months,
      avg_months_to_report: ops.avg_months_to_report,
      total_sae_subjects: ops.total_sae_subjects,
    },
    phases: toObj(phases),
    statuses: toObj(statuses),
    conditions: conditions.map(r => [r.val, r.count]),
    interventions: interventions.map(r => [r.val, r.count]),
    sponsors: sponsors.map(r => [r.val, r.count]),
    dropouts: dropouts.map(r => [r.reason, r.total]),
    durations: Object.fromEntries(durations.map(r => [r.bucket, r.count])),
    countries: trialCountries.map(r => [r.val, r.count]),
    recent_trials: recentTrials,
  });
});

// ── Trial Risk Score ──────────────────────────────────────────────────────────

app.get("/api/trial-risk", (req, res) => {
  if (!db) return res.status(503).json({ error: "SQLite snapshot required" });
  try { db.prepare("SELECT 1 FROM calculated_values LIMIT 1").get(); } catch { return res.status(503).json({ error: "Calculated values table not yet available — snapshot in progress" }); }
  const { nct_id } = req.query;
  if (!nct_id || !/^NCT\d{8}$/i.test(nct_id)) return res.status(400).json({ error: "Valid nct_id required" });
  const id = nct_id.toUpperCase();

  const trial = db.prepare(`SELECT * FROM studies WHERE nct_id = ?`).get(id);
  if (!trial) return res.status(404).json({ error: `Trial ${id} not found` });

  const cv = db.prepare(`SELECT * FROM calculated_values WHERE nct_id = ?`).get(id);
  const design = db.prepare(`SELECT * FROM designs WHERE nct_id = ?`).get(id);
  const elig = db.prepare(`SELECT * FROM eligibilities WHERE nct_id = ?`).get(id);

  // Find comparables: same phase, same top condition
  const topCond = db.prepare(`SELECT name FROM conditions WHERE nct_id = ? LIMIT 1`).get(id);
  const condKeyword = topCond?.name?.split(/[;,]/)?.[0]?.trim();

  const phaseClause = trial.phase ? `AND s.phase = ?` : `AND s.phase IS NULL`;
  const phaseParam = trial.phase ? [trial.phase] : [];

  // Get comparable completed/terminated trials
  let compIds = [];
  if (condKeyword) {
    try {
      const fts = db.prepare(`SELECT nct_id FROM studies_fts WHERE studies_fts MATCH ? LIMIT 500`).all(`"${condKeyword.replace(/"/g, '""')}"`);
      compIds = fts.map(r => r.nct_id).filter(x => x !== id);
    } catch {}
  }

  let comparables;
  if (compIds.length > 20) {
    const ph = compIds.map(() => "?").join(",");
    comparables = db.prepare(`
      SELECT s.nct_id, s.overall_status, s.enrollment, cv.actual_duration, cv.number_of_facilities
      FROM studies s LEFT JOIN calculated_values cv ON cv.nct_id = s.nct_id
      WHERE s.overall_status IN ('COMPLETED','TERMINATED') ${phaseClause}
        AND s.nct_id IN (${ph})
    `).all(...phaseParam, ...compIds);
  } else {
    comparables = db.prepare(`
      SELECT s.nct_id, s.overall_status, s.enrollment, cv.actual_duration, cv.number_of_facilities
      FROM studies s LEFT JOIN calculated_values cv ON cv.nct_id = s.nct_id
      WHERE s.overall_status IN ('COMPLETED','TERMINATED') ${phaseClause}
        AND s.nct_id != ?
      ORDER BY RANDOM() LIMIT 200
    `).all(...phaseParam, id);
  }

  // Compute risk factors
  const factors = [];
  let riskScore = 50; // baseline

  // 1. Termination rate
  const termRate = comparables.length > 0
    ? comparables.filter(c => c.overall_status === 'TERMINATED').length / comparables.length
    : 0;
  if (termRate > 0.25) { factors.push({ factor: "High termination rate in comparables", impact: "high", detail: `${(termRate*100).toFixed(0)}% of similar trials terminated` }); riskScore += 15; }
  else if (termRate > 0.15) { factors.push({ factor: "Moderate termination rate", impact: "medium", detail: `${(termRate*100).toFixed(0)}%` }); riskScore += 8; }

  // 2. Enrollment ambition vs comparables
  const compEnrollments = comparables.filter(c => c.enrollment > 0).map(c => c.enrollment).sort((a,b) => a-b);
  const medEnroll = compEnrollments.length > 0 ? compEnrollments[Math.floor(compEnrollments.length/2)] : null;
  if (trial.enrollment && medEnroll && trial.enrollment > medEnroll * 2) {
    factors.push({ factor: "Enrollment target well above comparable median", impact: "high", detail: `Target ${trial.enrollment.toLocaleString()} vs median ${medEnroll.toLocaleString()}` });
    riskScore += 12;
  } else if (trial.enrollment && medEnroll && trial.enrollment > medEnroll * 1.5) {
    factors.push({ factor: "Enrollment target above comparable median", impact: "medium", detail: `Target ${trial.enrollment.toLocaleString()} vs median ${medEnroll.toLocaleString()}` });
    riskScore += 6;
  }

  // 3. Number of facilities (complexity)
  if (cv?.number_of_facilities > 100) {
    factors.push({ factor: "Large multi-site trial", impact: "medium", detail: `${cv.number_of_facilities} sites` });
    riskScore += 8;
  } else if (cv?.number_of_facilities > 50) {
    factors.push({ factor: "Multi-site trial", impact: "low", detail: `${cv.number_of_facilities} sites` });
    riskScore += 4;
  }

  // 4. Design complexity
  if (design) {
    if (design.masking === 'NONE' || design.masking === 'None (Open Label)') {
      factors.push({ factor: "Open-label design", impact: "low", detail: "No blinding — potential bias risk but simpler operations" });
    }
    if (design.allocation === 'NON_RANDOMIZED') {
      factors.push({ factor: "Non-randomized allocation", impact: "medium", detail: "Higher regulatory scrutiny" });
      riskScore += 5;
    }
  }

  // 5. Duration benchmark
  const compDurations = comparables.filter(c => c.actual_duration > 0).map(c => c.actual_duration).sort((a,b) => a-b);
  const medDuration = compDurations.length > 0 ? compDurations[Math.floor(compDurations.length/2)] : null;

  // 6. Eligibility restrictiveness (count criteria lines as proxy)
  if (elig?.criteria) {
    const lines = elig.criteria.split('\n').filter(l => l.trim().length > 5).length;
    if (lines > 30) {
      factors.push({ factor: "Complex eligibility criteria", impact: "high", detail: `${lines} criteria lines — may slow enrollment` });
      riskScore += 10;
    } else if (lines > 20) {
      factors.push({ factor: "Moderate eligibility complexity", impact: "medium", detail: `${lines} criteria lines` });
      riskScore += 5;
    }
  }

  riskScore = Math.min(100, Math.max(0, riskScore));

  return res.json({
    nct_id: id,
    title: trial.brief_title,
    risk_score: riskScore,
    risk_level: riskScore >= 75 ? "high" : riskScore >= 50 ? "medium" : "low",
    factors,
    benchmarks: {
      comparable_count: comparables.length,
      termination_rate_pct: parseFloat((termRate * 100).toFixed(1)),
      median_enrollment: medEnroll,
      median_duration_months: medDuration,
      condition_keyword: condKeyword,
    },
    design: design ? { allocation: design.allocation, masking: design.masking, model: design.intervention_model, purpose: design.primary_purpose } : null,
  });
});

// ── Trial Intelligence ────────────────────────────────────────────────────────

app.get("/api/trial-intelligence", async (req, res) => {
  const { nct_id, min_enrollment, max_enrollment } = req.query;
  if (!nct_id || !/^NCT\d{8}$/.test(nct_id.toUpperCase())) {
    return res.status(400).json({ error: "Valid nct_id required (e.g. NCT01234567)" });
  }
  const id = nct_id.toUpperCase();

  if (!db) {
    return res.status(503).json({ error: "SQLite snapshot required for trial intelligence" });
  }

  // Enrollment bounds for comparables (from DQ rules)
  const enrollMin = min_enrollment ? parseInt(min_enrollment, 10) : null;
  const enrollMax = max_enrollment ? parseInt(max_enrollment, 10) : null;
  const enrollClause = [
    enrollMin !== null ? "AND enrollment >= ?" : "",
    enrollMax !== null ? "AND enrollment <= ?" : "",
  ].filter(Boolean).join(" ");
  const enrollParams = [
    ...(enrollMin !== null ? [enrollMin] : []),
    ...(enrollMax !== null ? [enrollMax] : []),
  ];

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

  // 2a. Fetch operational enrichment from new KG tables (graceful — may not exist yet)
  let cv = null, design = null, elig = null, dropouts = [], trialCountries = [], facilityCount = null;
  try {
    cv = db.prepare(`SELECT * FROM calculated_values WHERE nct_id = ?`).get(id);
    design = db.prepare(`SELECT * FROM designs WHERE nct_id = ?`).get(id);
    elig = db.prepare(`SELECT criteria FROM eligibilities WHERE nct_id = ?`).get(id);
    dropouts = db.prepare(`SELECT reason, SUM(count) AS total FROM drop_withdrawals WHERE nct_id = ? AND reason IS NOT NULL GROUP BY reason ORDER BY total DESC LIMIT 8`).all(id);
    trialCountries = db.prepare(`SELECT name FROM countries WHERE nct_id = ? AND removed = 0`).all(id).map(r => r.name);
    facilityCount = cv?.number_of_facilities || null;
  } catch { /* tables not yet available — snapshot in progress */ }

  // 3. Find condition-similar completed/terminated trials via FTS5 then same-phase filter
  const topKeyword = (trial.conditions_text || trial.brief_title || "")
    .split(/[;,]/)[0]
    .replace(/[^a-zA-Z0-9 ]/g, " ")
    .trim();

  // Build phase clause handling NULL phase
  const phaseClause = trial.phase ? `AND phase = ?` : `AND phase IS NULL`;
  const phaseParam  = trial.phase ? [trial.phase] : [];

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
            ${phaseClause}
            ${enrollClause}
            AND nct_id IN (${ph})
            AND start_date IS NOT NULL AND completion_date IS NOT NULL
          LIMIT 80
        `).all(...phaseParam, ...enrollParams, ...ids);
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
        ${phaseClause}
        ${enrollClause}
        AND nct_id != ?
        AND start_date IS NOT NULL AND completion_date IS NOT NULL
      ORDER BY RANDOM() LIMIT 80
    `).all(...phaseParam, ...enrollParams, id);
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

  // 4. Optional LLM briefing via GitHub Copilot (gpt-4.1)
  let briefing = null;
  const { GITHUB_COPILOT_TOKEN } = process.env;
  if (GITHUB_COPILOT_TOKEN) {
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
${facilityCount ? `- Number of Sites: ${facilityCount}` : ""}
${trialCountries.length ? `- Countries: ${trialCountries.join(", ")}` : ""}
${design ? `- Design: ${design.allocation || "unknown allocation"}, ${design.masking || "unknown masking"}, ${design.intervention_model || ""}, ${design.primary_purpose || ""}` : ""}
${cv?.actual_duration ? `- Actual Duration: ${cv.actual_duration} months` : ""}
${cv?.months_to_report_results ? `- Months to Report Results: ${cv.months_to_report_results}` : ""}
${dropouts.length ? `- Dropout Reasons: ${dropouts.map(d => `${d.reason} (${d.total})`).join(", ")}` : ""}
${elig?.criteria ? `- Eligibility Criteria (excerpt): ${elig.criteria.slice(0, 600)}` : ""}

COMPARABLE TRIAL BENCHMARK (${riskSignals.comparable_count} completed/terminated ${trial.phase || "unknown phase"} trials for ${topKeyword}):
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

      const response = await fetch("https://api.githubcopilot.com/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${GITHUB_COPILOT_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-4.1",
          max_tokens: 700,
          temperature: 0.3,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userMsg },
          ],
        }),
      });
      if (response.ok) {
        const data = await response.json();
        briefing = data.choices?.[0]?.message?.content || null;
      } else {
        console.error("[intelligence] GitHub Copilot API error:", response.status, await response.text());
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
      facility_count: facilityCount,
      countries: trialCountries,
      design: design ? { allocation: design.allocation, masking: design.masking, model: design.intervention_model, purpose: design.primary_purpose } : null,
      actual_duration_months: cv?.actual_duration || null,
      months_to_report_results: cv?.months_to_report_results || null,
    },
    risk_signals: riskSignals,
    dropouts: dropouts.map(d => ({ reason: d.reason, count: d.total })),
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

// ── Data Quality — rule parsing via LLM ─────────────────────────────────────

app.post("/api/dq/parse-rule", async (req, res) => {
  const { text } = req.body || {};
  if (!text || typeof text !== "string") return res.status(400).json({ error: "text required" });

  const { GITHUB_COPILOT_TOKEN } = process.env;
  if (!GITHUB_COPILOT_TOKEN) return res.status(503).json({ error: "GITHUB_COPILOT_TOKEN not configured" });

  try {
    const systemPrompt = `You are a data quality rule parser for clinical trials data. Given a natural language description, extract a structured rule and respond with ONLY valid JSON — no markdown fences, no extra text.

For grouping rules (merging synonymous values into one canonical label):
{"ruleType":"grouping","field":"intervention|condition|sponsor|status|phase","canonical":"<canonical label>","rawValues":["<raw1>","<raw2>",...]}

For enrollment range bounds:
{"ruleType":"bounds","min":<integer or null>,"max":<integer or null>}`;

    const response = await fetch("https://api.githubcopilot.com/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${GITHUB_COPILOT_TOKEN}`,
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
    });
    if (!response.ok) throw new Error(`LLM API error ${response.status}`);
    const llmData = await response.json();
    const raw = (llmData.choices?.[0]?.message?.content || "").trim()
      .replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
    const parsed = JSON.parse(raw);
    return res.json(parsed);
  } catch (e) {
    console.error("[dq] parse-rule failed:", e.message);
    return res.status(500).json({ error: "Failed to parse rule", detail: e.message });
  }
});

app.listen(parseInt(PORT), () => {
  console.log(`[server] listening on :${PORT} — backend: ${db ? `sqlite (${snapshotAge})` : "postgres fallback"}`);
});
