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
import neo4jDriver from "neo4j-driver";

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
    if (/^NCT\d{8}$/i.test(q.trim())) {
      // Direct NCT ID lookup — FTS5 UNINDEXED column can't be MATCHed
      where.push(`s.nct_id = ?`);
      params.push(q.trim().toUpperCase());
    } else {
      where.push(`s.nct_id IN (SELECT nct_id FROM studies_fts WHERE studies_fts MATCH ?)`);
      // FTS5 MATCH — wrap with quotes to handle special chars, search as prefix
      params.push(`"${q.replace(/"/g, '""')}"`);
    }
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

app.get("/api/site-search", async (req, res) => {
  const { q, country, limit = "20" } = req.query;
  if (!q || q.length < 2) return res.status(400).json({ error: "q required (min 2 chars)" });
  const lim = Math.min(parseInt(limit) || 20, 100);

  // Try SQLite first (facilities table only exists after operational snapshot)
  if (db) {
    try {
      db.prepare("SELECT 1 FROM facilities LIMIT 1").get();
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
      return res.json({ sites: rows, source: "sqlite" });
    } catch { /* fall through to live PG */ }
  }

  // Fallback: query live AACT PostgreSQL
  const pool = getPgPool();
  if (!pool) return res.status(503).json({ error: "Facilities not yet available — snapshot in progress. AACT credentials required for live fallback." });
  try {
    const countryClause = country ? "AND f.country = $3" : "";
    const pgParams = country ? [`%${q}%`, lim, country] : [`%${q}%`, lim];
    const { rows } = await pool.query(`
      SELECT f.name, f.city, f.state, f.country,
             COUNT(DISTINCT f.nct_id) AS trial_count,
             ROUND(AVG(f.latitude)::numeric, 4) AS latitude,
             ROUND(AVG(f.longitude)::numeric, 4) AS longitude
      FROM facilities f
      WHERE f.name ILIKE $1 ${countryClause}
      GROUP BY f.name, f.city, f.state, f.country
      ORDER BY trial_count DESC
      LIMIT $2
    `, pgParams);
    return res.json({ sites: rows.map(r => ({ ...r, trial_count: parseInt(r.trial_count) })), source: "live" });
  } catch (e) {
    return res.status(502).json({ error: "Site search failed", detail: e.message });
  }
});

app.get("/api/site-profile", async (req, res) => {
  const { name, city, state, country } = req.query;
  if (!name) return res.status(400).json({ error: "name required" });

  // ── SQLite path ────────────────────────────────────────────────────────────
  if (db) {
    try {
      db.prepare("SELECT 1 FROM facilities LIMIT 1").get(); // throws if table missing

      const facWhere = ["f.name = ?"];
      const facParams = [name];
      if (city) { facWhere.push("f.city = ?"); facParams.push(city); }
      if (state) { facWhere.push("f.state = ?"); facParams.push(state); }
      if (country) { facWhere.push("f.country = ?"); facParams.push(country); }
      const w = facWhere.join(" AND ");

      const trialIds = db.prepare(`SELECT DISTINCT f.nct_id FROM facilities f WHERE ${w}`).all(...facParams).map(r => r.nct_id);
      if (trialIds.length === 0) return res.status(404).json({ error: "Site not found" });
      const ph = trialIds.map(() => "?").join(",");

      const phases      = db.prepare(`SELECT COALESCE(phase, 'Unknown') AS val, COUNT(*) AS count FROM studies WHERE nct_id IN (${ph}) GROUP BY 1 ORDER BY count DESC`).all(...trialIds);
      const statuses    = db.prepare(`SELECT COALESCE(overall_status, 'Unknown') AS val, COUNT(*) AS count FROM studies WHERE nct_id IN (${ph}) GROUP BY 1 ORDER BY count DESC`).all(...trialIds);
      const conditions  = db.prepare(`SELECT c.name AS val, COUNT(DISTINCT c.nct_id) AS count FROM conditions c WHERE c.nct_id IN (${ph}) GROUP BY c.name ORDER BY count DESC LIMIT 15`).all(...trialIds);
      const interventions = db.prepare(`SELECT i.name AS val, COUNT(DISTINCT i.nct_id) AS count FROM interventions i WHERE i.nct_id IN (${ph}) GROUP BY i.name ORDER BY count DESC LIMIT 15`).all(...trialIds);
      const sponsors    = db.prepare(`SELECT sp.name AS val, COUNT(DISTINCT sp.nct_id) AS count FROM sponsors sp WHERE sp.nct_id IN (${ph}) AND sp.lead_or_collaborator = 'lead' GROUP BY sp.name ORDER BY count DESC LIMIT 15`).all(...trialIds);

      let ops = { total_trials: trialIds.length, reported_results: null, avg_duration_months: null, avg_months_to_report: null, total_sae_subjects: null };
      let dropouts = [], durations = [], trialCountries = [], loc = null;
      try {
        ops = db.prepare(`SELECT COUNT(*) AS total_trials, SUM(CASE WHEN cv.were_results_reported = 1 THEN 1 ELSE 0 END) AS reported_results, ROUND(AVG(cv.actual_duration), 1) AS avg_duration_months, ROUND(AVG(cv.months_to_report_results), 1) AS avg_months_to_report, SUM(cv.number_of_sae_subjects) AS total_sae_subjects FROM calculated_values cv WHERE cv.nct_id IN (${ph})`).get(...trialIds) || ops;
        dropouts = db.prepare(`SELECT dw.reason, SUM(dw.count) AS total FROM drop_withdrawals dw WHERE dw.nct_id IN (${ph}) AND dw.reason IS NOT NULL GROUP BY dw.reason ORDER BY total DESC LIMIT 10`).all(...trialIds);
        durations = db.prepare(`SELECT CASE WHEN cv.actual_duration < 12 THEN '< 1 yr' WHEN cv.actual_duration < 24 THEN '1\u20132 yr' WHEN cv.actual_duration < 36 THEN '2\u20133 yr' WHEN cv.actual_duration < 60 THEN '3\u20135 yr' ELSE '5+ yr' END AS bucket, COUNT(*) AS count FROM calculated_values cv WHERE cv.nct_id IN (${ph}) AND cv.actual_duration IS NOT NULL GROUP BY 1 ORDER BY MIN(cv.actual_duration)`).all(...trialIds);
        trialCountries = db.prepare(`SELECT ctry.name AS val, COUNT(DISTINCT ctry.nct_id) AS count FROM countries ctry WHERE ctry.nct_id IN (${ph}) AND ctry.removed = 0 GROUP BY ctry.name ORDER BY count DESC LIMIT 10`).all(...trialIds);
        loc = db.prepare(`SELECT city, state, country, latitude, longitude FROM facilities f WHERE ${w} LIMIT 1`).get(...facParams);
      } catch { /* enrichment tables not yet available */ }

      const cs = db.prepare(`SELECT COUNT(*) AS finished, SUM(CASE WHEN overall_status = 'COMPLETED' THEN 1 ELSE 0 END) AS completed, SUM(CASE WHEN overall_status = 'TERMINATED' THEN 1 ELSE 0 END) AS terminated FROM studies WHERE nct_id IN (${ph}) AND overall_status IN ('COMPLETED','TERMINATED')`).get(...trialIds);
      const recentTrials = db.prepare(`SELECT s.nct_id, s.brief_title, s.overall_status, s.phase, s.enrollment, s.start_date, s.completion_date FROM studies s WHERE s.nct_id IN (${ph}) ORDER BY s.start_date DESC LIMIT 10`).all(...trialIds);

      const toObj = (rows) => Object.fromEntries(rows.map(r => [r.val, r.count]));
      const completionRate = cs.finished > 0 ? parseFloat(((cs.completed / cs.finished) * 100).toFixed(1)) : null;

      return res.json({
        site: { name, city: loc?.city, state: loc?.state, country: loc?.country, latitude: loc?.latitude, longitude: loc?.longitude },
        summary: { total_trials: trialIds.length, completion_rate_pct: completionRate, completed: cs.completed, terminated: cs.terminated, results_reported: ops.reported_results, avg_duration_months: ops.avg_duration_months, avg_months_to_report: ops.avg_months_to_report, total_sae_subjects: ops.total_sae_subjects },
        phases: toObj(phases), statuses: toObj(statuses),
        conditions: conditions.map(r => [r.val, r.count]),
        interventions: interventions.map(r => [r.val, r.count]),
        sponsors: sponsors.map(r => [r.val, r.count]),
        dropouts: dropouts.map(r => [r.reason, r.total]),
        durations: Object.fromEntries(durations.map(r => [r.bucket, r.count])),
        countries: trialCountries.map(r => [r.val, r.count]),
        recent_trials: recentTrials,
        source: "sqlite",
      });
    } catch { /* facilities table not yet available — fall through to PG */ }
  }

  // ── PostgreSQL fallback ────────────────────────────────────────────────────
  const pool = getPgPool();
  if (!pool) return res.status(503).json({ error: "Site profiles require the operational snapshot (facilities table). Snapshot is in progress." });
  try {
    const clauses = ["f.name = $1"];
    const pgParams = [name];
    if (city)    { clauses.push(`f.city = $${pgParams.push(city)}`); }
    if (state)   { clauses.push(`f.state = $${pgParams.push(state)}`); }
    if (country) { clauses.push(`f.country = $${pgParams.push(country)}`); }
    const w = clauses.join(" AND ");

    const { rows: facRows } = await pool.query(`SELECT DISTINCT nct_id FROM facilities f WHERE ${w}`, pgParams);
    if (facRows.length === 0) return res.status(404).json({ error: "Site not found" });
    const trialIds = facRows.map(r => r.nct_id);
    const idList = trialIds.map((_, i) => `$${i + 1}`).join(",");

    const [phases, statuses, conditions, interventions, sponsors, cs, recentTrials, locRow, ops, dropouts, trialCountries] = await Promise.all([
      pool.query(`SELECT COALESCE(phase, 'Unknown') AS val, COUNT(*) AS count FROM studies WHERE nct_id IN (${idList}) GROUP BY 1 ORDER BY count DESC`, trialIds),
      pool.query(`SELECT COALESCE(overall_status, 'Unknown') AS val, COUNT(*) AS count FROM studies WHERE nct_id IN (${idList}) GROUP BY 1 ORDER BY count DESC`, trialIds),
      pool.query(`SELECT c.name AS val, COUNT(DISTINCT c.nct_id) AS count FROM conditions c WHERE c.nct_id IN (${idList}) GROUP BY c.name ORDER BY count DESC LIMIT 15`, trialIds),
      pool.query(`SELECT i.name AS val, COUNT(DISTINCT i.nct_id) AS count FROM interventions i WHERE i.nct_id IN (${idList}) GROUP BY i.name ORDER BY count DESC LIMIT 15`, trialIds),
      pool.query(`SELECT s.name AS val, COUNT(DISTINCT s.nct_id) AS count FROM sponsors s WHERE s.nct_id IN (${idList}) AND s.lead_or_collaborator = 'lead' GROUP BY s.name ORDER BY count DESC LIMIT 15`, trialIds),
      pool.query(`SELECT COUNT(*) AS finished, SUM(CASE WHEN overall_status = 'COMPLETED' THEN 1 ELSE 0 END) AS completed, SUM(CASE WHEN overall_status = 'TERMINATED' THEN 1 ELSE 0 END) AS terminated FROM studies WHERE nct_id IN (${idList}) AND overall_status IN ('COMPLETED','TERMINATED')`, trialIds),
      pool.query(`SELECT nct_id, brief_title, overall_status, phase, enrollment, start_date::text, completion_date::text FROM studies WHERE nct_id IN (${idList}) ORDER BY start_date DESC NULLS LAST LIMIT 10`, trialIds),
      pool.query(`SELECT city, state, country, latitude::float, longitude::float FROM facilities f WHERE ${w} LIMIT 1`, pgParams),
      pool.query(`SELECT COUNT(*) AS total_trials, SUM(CASE WHEN were_results_reported THEN 1 ELSE 0 END) AS reported_results, ROUND(AVG(actual_duration)::numeric, 1) AS avg_duration_months, ROUND(AVG(months_to_report_results)::numeric, 1) AS avg_months_to_report FROM calculated_values WHERE nct_id IN (${idList})`, trialIds).catch(() => ({ rows: [{}] })),
      pool.query(`SELECT reason, SUM(count) AS total FROM drop_withdrawals WHERE nct_id IN (${idList}) AND reason IS NOT NULL GROUP BY reason ORDER BY total DESC LIMIT 10`, trialIds).catch(() => ({ rows: [] })),
      pool.query(`SELECT name AS val, COUNT(DISTINCT nct_id) AS count FROM countries WHERE nct_id IN (${idList}) AND removed = false GROUP BY name ORDER BY count DESC LIMIT 10`, trialIds).catch(() => ({ rows: [] })),
    ]);

    const loc = locRow.rows[0] || {};
    const opsRow = ops.rows[0] || {};
    const csRow = cs.rows[0];
    const finished = parseInt(csRow.finished) || 0;
    const completed = parseInt(csRow.completed) || 0;
    const terminated = parseInt(csRow.terminated) || 0;
    const completionRate = finished > 0 ? parseFloat(((completed / finished) * 100).toFixed(1)) : null;
    const toObj = (rows) => Object.fromEntries(rows.map(r => [r.val, parseInt(r.count)]));

    return res.json({
      site: { name, city: loc.city, state: loc.state, country: loc.country, latitude: loc.latitude, longitude: loc.longitude },
      summary: { total_trials: trialIds.length, completion_rate_pct: completionRate, completed, terminated, results_reported: opsRow.reported_results ? parseInt(opsRow.reported_results) : null, avg_duration_months: opsRow.avg_duration_months ? parseFloat(opsRow.avg_duration_months) : null, avg_months_to_report: opsRow.avg_months_to_report ? parseFloat(opsRow.avg_months_to_report) : null, total_sae_subjects: null },
      phases: toObj(phases.rows), statuses: toObj(statuses.rows),
      conditions: conditions.rows.map(r => [r.val, parseInt(r.count)]),
      interventions: interventions.rows.map(r => [r.val, parseInt(r.count)]),
      sponsors: sponsors.rows.map(r => [r.val, parseInt(r.count)]),
      dropouts: dropouts.rows.map(r => [r.reason, parseInt(r.total)]),
      durations: {},
      countries: trialCountries.rows.map(r => [r.val, parseInt(r.count)]),
      recent_trials: recentTrials.rows,
      source: "live",
    });
  } catch (e) {
    console.error("[site-profile] PG fallback failed:", e.message);
    return res.status(502).json({ error: "Site profile failed", detail: e.message });
  }
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

// ── Entity Insight ────────────────────────────────────────────────────────────

function queryEntityInsight(type, name) {
  let sq, params;
  if (type === "sponsor") {
    sq = `SELECT nct_id FROM sponsors WHERE name = ? AND lead_or_collaborator = 'lead'`;
    params = [name];
  } else if (type === "condition") {
    sq = `SELECT DISTINCT nct_id FROM conditions WHERE name = ?`;
    params = [name];
  } else if (type === "intervention") {
    sq = `SELECT DISTINCT nct_id FROM interventions WHERE name = ?`;
    params = [name];
  } else if (type === "phase") {
    // name is the raw phase value e.g. "PHASE1" or "Unknown"
    sq = name === "Unknown"
      ? `SELECT nct_id FROM studies WHERE phase IS NULL`
      : `SELECT nct_id FROM studies WHERE phase = ?`;
    params = name === "Unknown" ? [] : [name];
  } else if (type === "status") {
    sq = name === "Unknown"
      ? `SELECT nct_id FROM studies WHERE overall_status IS NULL`
      : `SELECT nct_id FROM studies WHERE overall_status = ?`;
    params = name === "Unknown" ? [] : [name];
  } else if (type === "enrollment_range") {
    // name is a bucket label e.g. "< 100", "100–499", etc.
    const BUCKETS = {
      "< 100":      [0,    99],
      "100–499":   [100,   499],
      "500–999":   [500,   999],
      "1k–4.9k":  [1000,  4999],
      "5k–19k":   [5000,  19999],
      "≥ 20k":     [20000, 999999999],
    };
    const range = BUCKETS[name];
    if (!range) return null;
    sq = `SELECT nct_id FROM studies WHERE enrollment >= ? AND enrollment <= ?`;
    params = range;
  } else {
    return null;
  }
  const total = db.prepare(`SELECT COUNT(*) AS n FROM (${sq})`).get(...params)?.n || 0;
  if (total === 0) return { empty: true };

  const cs = db.prepare(`
    SELECT
      SUM(CASE WHEN overall_status = 'COMPLETED'  THEN 1 ELSE 0 END) AS completed,
      SUM(CASE WHEN overall_status = 'TERMINATED' THEN 1 ELSE 0 END) AS terminated,
      ROUND(AVG(CASE WHEN enrollment_type = 'ACTUAL' THEN CAST(enrollment AS REAL) END), 0) AS avg_enrollment
    FROM studies WHERE nct_id IN (${sq})
  `).get(...params);

  const phases    = db.prepare(`SELECT COALESCE(phase, 'Unknown') AS val, COUNT(*) AS count FROM studies WHERE nct_id IN (${sq}) GROUP BY 1 ORDER BY count DESC`).all(...params);
  const statuses  = db.prepare(`SELECT COALESCE(overall_status, 'Unknown') AS val, COUNT(*) AS count FROM studies WHERE nct_id IN (${sq}) GROUP BY 1 ORDER BY count DESC`).all(...params);

  let topConditions = [], topSponsors = [], topInterventions = [];
  if (type === "sponsor") {
    topConditions    = db.prepare(`SELECT c.name AS val, COUNT(DISTINCT c.nct_id) AS count FROM conditions c    WHERE c.nct_id IN (${sq}) GROUP BY c.name ORDER BY count DESC LIMIT 10`).all(...params);
    topInterventions = db.prepare(`SELECT i.name AS val, COUNT(DISTINCT i.nct_id) AS count FROM interventions i WHERE i.nct_id IN (${sq}) GROUP BY i.name ORDER BY count DESC LIMIT 10`).all(...params);
  } else if (type === "condition") {
    topSponsors      = db.prepare(`SELECT sp.name AS val, COUNT(DISTINCT sp.nct_id) AS count FROM sponsors sp WHERE sp.nct_id IN (${sq}) AND sp.lead_or_collaborator = 'lead' GROUP BY sp.name ORDER BY count DESC LIMIT 10`).all(...params);
    topInterventions = db.prepare(`SELECT i.name AS val, COUNT(DISTINCT i.nct_id) AS count FROM interventions i WHERE i.nct_id IN (${sq}) GROUP BY i.name ORDER BY count DESC LIMIT 10`).all(...params);
  } else if (type === "phase" || type === "status" || type === "enrollment_range") {
    // Cross-dimensional: show top of all three entity types
    topConditions    = db.prepare(`SELECT c.name AS val, COUNT(DISTINCT c.nct_id) AS count FROM conditions c    WHERE c.nct_id IN (${sq}) GROUP BY c.name ORDER BY count DESC LIMIT 10`).all(...params);
    topSponsors      = db.prepare(`SELECT sp.name AS val, COUNT(DISTINCT sp.nct_id) AS count FROM sponsors sp WHERE sp.nct_id IN (${sq}) AND sp.lead_or_collaborator = 'lead' GROUP BY sp.name ORDER BY count DESC LIMIT 10`).all(...params);
    topInterventions = db.prepare(`SELECT i.name AS val, COUNT(DISTINCT i.nct_id) AS count FROM interventions i WHERE i.nct_id IN (${sq}) GROUP BY i.name ORDER BY count DESC LIMIT 10`).all(...params);
  } else {
    topConditions = db.prepare(`SELECT c.name AS val, COUNT(DISTINCT c.nct_id) AS count FROM conditions c    WHERE c.nct_id IN (${sq}) GROUP BY c.name ORDER BY count DESC LIMIT 10`).all(...params);
    topSponsors   = db.prepare(`SELECT sp.name AS val, COUNT(DISTINCT sp.nct_id) AS count FROM sponsors sp WHERE sp.nct_id IN (${sq}) AND sp.lead_or_collaborator = 'lead' GROUP BY sp.name ORDER BY count DESC LIMIT 10`).all(...params);
  }

  let avgDuration = null, avgMonthsToReport = null, topSites = [];
  try {
    const cv = db.prepare(`SELECT ROUND(AVG(actual_duration), 1) AS d, ROUND(AVG(months_to_report_results), 1) AS m FROM calculated_values WHERE nct_id IN (${sq})`).get(...params);
    avgDuration = cv?.d; avgMonthsToReport = cv?.m;
    topSites = db.prepare(`SELECT f.name AS val, COUNT(DISTINCT f.nct_id) AS count FROM facilities f WHERE f.nct_id IN (${sq}) GROUP BY f.name ORDER BY count DESC LIMIT 8`).all(...params);
  } catch { /* tables not yet available */ }

  const fin = cs.completed + cs.terminated;
  return {
    entity: { type, name },
    summary: {
      total_trials: total,
      completion_rate_pct: fin > 0 ? parseFloat(((cs.completed / fin) * 100).toFixed(1)) : null,
      completed: cs.completed,
      terminated: cs.terminated,
      avg_enrollment: cs.avg_enrollment,
      avg_duration_months: avgDuration,
      avg_months_to_report: avgMonthsToReport,
    },
    phases:        Object.fromEntries(phases.map(r => [r.val, r.count])),
    statuses:      Object.fromEntries(statuses.map(r => [r.val, r.count])),
    conditions:    topConditions.map(r => [r.val, r.count]),
    sponsors:      topSponsors.map(r => [r.val, r.count]),
    interventions: topInterventions.map(r => [r.val, r.count]),
    sites:         topSites.map(r => [r.val, r.count]),
  };
}

app.get("/api/entity-insight", (req, res) => {
  if (!db) return res.status(503).json({ error: "SQLite snapshot required" });
  const { type, name } = req.query;
  if (!["sponsor", "condition", "intervention", "phase", "status", "enrollment_range"].includes(type) || !name) {
    return res.status(400).json({ error: "valid type (sponsor|condition|intervention|phase|status|enrollment_range) and name required" });
  }
  try {
    const result = queryEntityInsight(type, name);
    if (!result) return res.status(400).json({ error: "Invalid entity type or enrollment range" });
    if (result.empty) return res.status(404).json({ error: `No trials found for ${type}: ${name}` });
    return res.json(result);
  } catch (e) {
    console.error("[entity-insight]", e.message);
    return res.status(500).json({ error: "Query failed", detail: e.message });
  }
});

app.get("/api/entity-intelligence", async (req, res) => {
  const { type, name } = req.query;
  if (!["sponsor", "condition", "intervention", "phase", "status", "enrollment_range"].includes(type) || !name) {
    return res.status(400).json({ error: "valid type and name required" });
  }
  if (!db) return res.status(503).json({ error: "SQLite snapshot required" });
  const GITHUB_COPILOT_TOKEN = process.env.GITHUB_COPILOT_TOKEN;
  if (!GITHUB_COPILOT_TOKEN) return res.status(503).json({ error: "LLM not configured" });

  let insight;
  try {
    insight = queryEntityInsight(type, name);
    if (!insight || insight.empty) return res.status(404).json({ error: `No data for ${type}: ${name}` });
  } catch (e) {
    return res.status(500).json({ error: "Data fetch failed" });
  }

  const { summary, phases, conditions, sponsors, interventions, sites } = insight;
  const topPhases = Object.entries(phases).sort((a,b) => b[1]-a[1]).slice(0,5).map(([k,v]) => `${k}: ${v}`).join(", ");
  const topConds  = conditions.slice(0,5).map(([n]) => n).join(", ");
  const topSpons  = sponsors.slice(0,5).map(([n]) => n).join(", ");
  const topInts   = interventions.slice(0,5).map(([n]) => n).join(", ");
  const topSiteList = sites.slice(0,5).map(([n]) => n).join(", ");

  const systemPrompt = `You are a senior clinical trial operations analyst. Provide strategic, data-driven insights in plain paragraphs. Be specific and actionable. No markdown headers or bullet lists.`;
  const userMsg = `Analyze the following AACT clinical trial portfolio for the ${type} "${name}":

Total trials: ${summary.total_trials.toLocaleString()}
Completion rate: ${summary.completion_rate_pct !== null ? summary.completion_rate_pct + "%" : "unknown"} (${summary.completed} completed, ${summary.terminated} terminated)
Avg actual enrollment: ${summary.avg_enrollment ? Math.round(summary.avg_enrollment).toLocaleString() : "unknown"}
${summary.avg_duration_months ? `Avg trial duration: ${summary.avg_duration_months} months` : ""}
${summary.avg_months_to_report ? `Avg months to report results: ${summary.avg_months_to_report}` : ""}
Phase distribution: ${topPhases || "unknown"}
${topConds  ? `Top conditions studied: ${topConds}`  : ""}
${topSpons  ? `Top sponsors involved: ${topSpons}`   : ""}
${topInts   ? `Top interventions: ${topInts}`         : ""}
${topSiteList ? `Top sites: ${topSiteList}` : ""}

Write 3 paragraphs: (1) portfolio overview and key characteristics, (2) operational performance patterns and what they indicate, (3) strategic insights or risks a clinical operations manager should know.`;

  try {
    const response = await fetch("https://api.githubcopilot.com/chat/completions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${GITHUB_COPILOT_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4.1", max_tokens: 600, temperature: 0.35,
        messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userMsg }],
      }),
    });
    if (!response.ok) throw new Error(`LLM API ${response.status}`);
    const llmData = await response.json();
    const briefing = llmData.choices?.[0]?.message?.content || null;
    return res.json({ briefing });
  } catch (e) {
    console.error("[entity-intelligence] LLM error:", e.message);
    return res.status(500).json({ error: "LLM call failed", detail: e.message });
  }
});

// ── Neo4j Knowledge Graph connection ──────────────────────────────────────
const NEO4J_URI = process.env.NEO4J_URI || "bolt://neo4j:7687";
const NEO4J_USER = process.env.NEO4J_USER || "neo4j";
const NEO4J_PASS = process.env.NEO4J_PASS || "trials-kg-2026";

let neo4j = null;
try {
  neo4j = neo4jDriver.driver(NEO4J_URI, neo4jDriver.auth.basic(NEO4J_USER, NEO4J_PASS));
  // Test connectivity (non-blocking)
  neo4j.getServerInfo().then(() => {
    console.log("[server] Neo4j connected at", NEO4J_URI);
  }).catch(e => {
    console.warn("[server] Neo4j not available:", e.message);
    neo4j = null;
  });
} catch (e) {
  console.warn("[server] Neo4j driver init failed:", e.message);
}

async function cypher(query, params = {}) {
  if (!neo4j) throw new Error("Knowledge graph not available");
  const session = neo4j.session({ defaultAccessMode: neo4jDriver.session.READ });
  try {
    const result = await session.run(query, params);
    return result.records;
  } finally {
    await session.close();
  }
}

function nInt(v) {
  if (v == null) return null;
  return typeof v.toNumber === "function" ? v.toNumber() : Number(v);
}

// ── Graph endpoints ──────────────────────────────────────────────────────

/**
 * GET /api/graph/sponsor-overlap?sponsor=Pfizer&limit=20
 * Find sponsors that share the most trial sites with the given sponsor.
 * Returns: [{ sponsor, shared_sites, their_trials }]
 * Graph-native: O(n²) self-join on 3.4M facility rows in SQL.
 */
app.get("/api/graph/sponsor-overlap", async (req, res) => {
  const { sponsor, limit = "20" } = req.query;
  if (!sponsor) return res.status(400).json({ error: "sponsor required" });
  try {
    const records = await cypher(`
      MATCH (s1:Sponsor {name: $sponsor})-[:RUNS]->(t1:Trial)-[:AT]->(site:Site)<-[:AT]-(t2:Trial)<-[:RUNS]-(s2:Sponsor)
      WHERE s1 <> s2
      WITH s2, COUNT(DISTINCT site) AS shared_sites, COUNT(DISTINCT t2) AS their_trials
      RETURN s2.name AS sponsor, shared_sites, their_trials
      ORDER BY shared_sites DESC
      LIMIT toInteger($limit)
    `, { sponsor, limit });
    res.json(records.map(r => ({
      sponsor: r.get("sponsor"),
      shared_sites: nInt(r.get("shared_sites")),
      their_trials: nInt(r.get("their_trials")),
    })));
  } catch (e) {
    console.error("[graph/sponsor-overlap]", e.message);
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/graph/strategic-gaps?sponsor=Pfizer&limit=15
 * Missing-edge detection: conditions therapeutically adjacent to the sponsor's portfolio
 * that the sponsor does NOT work in. These are expansion opportunities.
 *
 * Graph-native: finds what's NOT connected through a 3-hop pattern with anti-join.
 * SQL equivalent would require a 4-way self-join with NOT EXISTS anti-join.
 *
 * Pattern: Sponsor -RUNS-> Trial -TREATS-> MyCondition <-TREATS- OtherTrial -TREATS-> GapCondition
 *          where GapCondition is NOT in the sponsor's existing portfolio.
 */
app.get("/api/graph/strategic-gaps", async (req, res) => {
  const { sponsor, limit = "15" } = req.query;
  if (!sponsor) return res.status(400).json({ error: "sponsor required" });
  try {
    const records = await cypher(`
      MATCH (s:Sponsor {name: $sponsor})-[:RUNS]->(t:Trial)-[:TREATS]->(my:Condition)
      WITH s, COLLECT(DISTINCT my.name) AS myNames
      UNWIND myNames AS mn
      MATCH (mc:Condition {name: mn})<-[:TREATS]-(t2:Trial)-[:TREATS]->(gap:Condition)
      WHERE NOT gap.name IN myNames
      WITH gap, COUNT(DISTINCT t2) AS adjacency_strength,
           COLLECT(DISTINCT mn)[..3] AS via_conditions
      RETURN gap.name AS condition, adjacency_strength, via_conditions
      ORDER BY adjacency_strength DESC
      LIMIT toInteger($limit)
    `, { sponsor, limit });
    res.json(records.map(r => ({
      condition: r.get("condition"),
      adjacency_strength: nInt(r.get("adjacency_strength")),
      via_conditions: r.get("via_conditions"),
    })));
  } catch (e) {
    console.error("[graph/strategic-gaps]", e.message);
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/graph/repurposing-path?from=Alzheimer+Disease&to=Breast+Cancer
 * Shortest path between two conditions through the trial-intervention network.
 *
 * Graph-native: shortestPath traversal — literally impossible in SQL.
 * Traverses only TREATS and USES edges to find the drug-trial chain connecting two conditions.
 *
 * Returns: { hops, path: [{ label, name }], edges: [edgeType] }
 */
app.get("/api/graph/repurposing-path", async (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: "from and to conditions required" });
  try {
    const records = await cypher(`
      MATCH (c1:Condition {name: $from}), (c2:Condition {name: $to})
      MATCH path = shortestPath((c1)-[:TREATS|USES*..10]-(c2))
      RETURN [n IN nodes(path) | {label: labels(n)[0], name: COALESCE(n.name, n.nct_id, n.key)}] AS path_nodes,
             [r IN relationships(path) | type(r)] AS path_edges,
             length(path) AS hops
    `, { from, to });
    if (records.length === 0) {
      return res.json({ hops: -1, path: [], edges: [], message: "No path found between these conditions" });
    }
    const r = records[0];
    res.json({
      hops: nInt(r.get("hops")),
      path: r.get("path_nodes"),
      edges: r.get("path_edges"),
    });
  } catch (e) {
    console.error("[graph/repurposing-path]", e.message);
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/graph/condition-landscape?condition=Breast+Cancer&limit=15
 * Extended competitive landscape: sponsors most active in conditions
 * therapeutically adjacent to the given condition.
 *
 * Graph-native: 3-hop traversal through the condition adjacency network.
 * Maps your competitive neighborhood through the drug similarity network.
 *
 * Pattern: Condition <-TREATS- Trial -USES-> Intervention <-USES- Trial -TREATS-> AdjCondition <-TREATS- Trial <-RUNS- Sponsor
 */
app.get("/api/graph/condition-landscape", async (req, res) => {
  const { condition, limit = "15" } = req.query;
  if (!condition) return res.status(400).json({ error: "condition required" });
  try {
    // First: find adjacent conditions
    const adjRecords = await cypher(`
      MATCH (c:Condition {name: $condition})<-[:TREATS]-(t1:Trial)-[:USES]->(i:Intervention)<-[:USES]-(t2:Trial)-[:TREATS]->(adj:Condition)
      WHERE c <> adj
      WITH adj, COUNT(DISTINCT i) AS shared_drugs
      RETURN adj.name AS condition, shared_drugs
      ORDER BY shared_drugs DESC
      LIMIT 30
    `, { condition });

    const adjNames = adjRecords.map(r => r.get("condition"));

    // Then: sponsors most active in those adjacent conditions
    const sponsorRecords = await cypher(`
      UNWIND $adjNames AS adjName
      MATCH (sp:Sponsor)-[:RUNS]->(t:Trial)-[:TREATS]->(adj:Condition {name: adjName})
      WITH sp.name AS sponsor, COUNT(DISTINCT adj) AS adjacent_conditions, COUNT(DISTINCT t) AS trials
      WHERE adjacent_conditions >= 2
      RETURN sponsor, adjacent_conditions, trials
      ORDER BY adjacent_conditions DESC, trials DESC
      LIMIT toInteger($limit)
    `, { adjNames, limit });

    res.json({
      condition,
      adjacent_conditions: adjRecords.map(r => ({
        condition: r.get("condition"),
        shared_drugs: nInt(r.get("shared_drugs")),
      })),
      landscape_sponsors: sponsorRecords.map(r => ({
        sponsor: r.get("sponsor"),
        adjacent_conditions: nInt(r.get("adjacent_conditions")),
        trials: nInt(r.get("trials")),
      })),
    });
  } catch (e) {
    console.error("[graph/condition-landscape]", e.message);
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/graph/therapeutic-adjacency?condition=Breast+Cancer&limit=15
 * Find conditions that share the most interventions with the given condition.
 * Returns: [{ condition, shared_interventions, example_drugs[] }]
 */
app.get("/api/graph/therapeutic-adjacency", async (req, res) => {
  const { condition, limit = "15" } = req.query;
  if (!condition) return res.status(400).json({ error: "condition required" });
  try {
    const records = await cypher(`
      MATCH (c1:Condition {name: $condition})<-[:TREATS]-(t1:Trial)-[:USES]->(i:Intervention)<-[:USES]-(t2:Trial)-[:TREATS]->(c2:Condition)
      WHERE c1 <> c2
      WITH c2, COUNT(DISTINCT i) AS shared_interventions,
           COLLECT(DISTINCT i.name)[0..3] AS example_drugs
      RETURN c2.name AS condition, shared_interventions, example_drugs
      ORDER BY shared_interventions DESC
      LIMIT toInteger($limit)
    `, { condition, limit });
    res.json(records.map(r => ({
      condition: r.get("condition"),
      shared_interventions: nInt(r.get("shared_interventions")),
      example_drugs: r.get("example_drugs"),
    })));
  } catch (e) {
    console.error("[graph/therapeutic-adjacency]", e.message);
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/graph/site-risk?nct_id=NCT12345678
 * For a trial's sites, find termination rates at those sites from other trials.
 * Returns: [{ site, country, terminated, total, termination_rate }]
 */
app.get("/api/graph/site-risk", async (req, res) => {
  const { nct_id } = req.query;
  if (!nct_id) return res.status(400).json({ error: "nct_id required" });
  try {
    const records = await cypher(`
      MATCH (t:Trial {nct_id: $nct_id})-[:AT]->(site:Site)<-[:AT]-(other:Trial)
      WHERE other.nct_id <> $nct_id
      WITH site,
           COUNT(other) AS total,
           SUM(CASE WHEN other.status = 'TERMINATED' THEN 1 ELSE 0 END) AS terminated,
           SUM(CASE WHEN other.status = 'COMPLETED' THEN 1 ELSE 0 END) AS completed
      WHERE total >= 5
      RETURN site.name AS site, site.country AS country,
             terminated, completed, total,
             ROUND(100.0 * terminated / total, 1) AS termination_rate
      ORDER BY termination_rate DESC
      LIMIT 25
    `, { nct_id });
    res.json(records.map(r => ({
      site: r.get("site"),
      country: r.get("country"),
      terminated: nInt(r.get("terminated")),
      completed: nInt(r.get("completed")),
      total: nInt(r.get("total")),
      termination_rate: nInt(r.get("termination_rate")),
    })));
  } catch (e) {
    console.error("[graph/site-risk]", e.message);
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/graph/site-expertise?site=Mayo+Clinic&limit=20
 * Full capability profile for a site: conditions, phases, sponsors, completion rates.
 */
app.get("/api/graph/site-expertise", async (req, res) => {
  const { site, limit = "20" } = req.query;
  if (!site) return res.status(400).json({ error: "site required" });
  try {
    // Conditions at this site with completion rate
    const condRecords = await cypher(`
      MATCH (s:Site)-[:IN_COUNTRY]->(country:Country)
      WHERE s.name CONTAINS $site
      WITH COLLECT(DISTINCT s) AS sites, COLLECT(DISTINCT country.name)[0] AS top_country
      UNWIND sites AS s
      MATCH (t:Trial)-[:AT]->(s)
      MATCH (t)-[:TREATS]->(c:Condition)
      WITH c.name AS condition,
           COUNT(DISTINCT t) AS trials,
           SUM(CASE WHEN t.status = 'COMPLETED' THEN 1 ELSE 0 END) AS completed,
           SUM(CASE WHEN t.status = 'TERMINATED' THEN 1 ELSE 0 END) AS terminated,
           top_country
      RETURN condition, trials, completed, terminated,
             CASE WHEN completed + terminated > 0
               THEN ROUND(100.0 * completed / (completed + terminated), 1)
               ELSE null END AS completion_rate,
             top_country
      ORDER BY trials DESC
      LIMIT toInteger($limit)
    `, { site, limit });

    // Sponsor network at this site
    const sponsorRecords = await cypher(`
      MATCH (s:Site) WHERE s.name CONTAINS $site
      MATCH (t:Trial)-[:AT]->(s)
      MATCH (sp:Sponsor)-[:RUNS]->(t)
      RETURN sp.name AS sponsor, COUNT(DISTINCT t) AS trials
      ORDER BY trials DESC LIMIT 10
    `, { site });

    res.json({
      conditions: condRecords.map(r => ({
        condition: r.get("condition"),
        trials: nInt(r.get("trials")),
        completed: nInt(r.get("completed")),
        terminated: nInt(r.get("terminated")),
        completion_rate: nInt(r.get("completion_rate")),
      })),
      sponsors: sponsorRecords.map(r => ({
        sponsor: r.get("sponsor"),
        trials: nInt(r.get("trials")),
      })),
      country: condRecords.length > 0 ? condRecords[0].get("top_country") : null,
    });
  } catch (e) {
    console.error("[graph/site-expertise]", e.message);
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/graph/sponsor-network?sponsor=Pfizer&limit=10
 * Find the sponsor's preferred site network and which competitors use the same sites.
 * 2-hop traversal: Sponsor → Trial → Site → Trial → Competitor Sponsor
 */
app.get("/api/graph/sponsor-network", async (req, res) => {
  const { sponsor, limit = "10" } = req.query;
  if (!sponsor) return res.status(400).json({ error: "sponsor required" });
  try {
    // Top sites for this sponsor
    const siteRecords = await cypher(`
      MATCH (sp:Sponsor {name: $sponsor})-[:RUNS]->(t:Trial)-[:AT]->(s:Site)
      WITH s, COUNT(DISTINCT t) AS trials,
           SUM(CASE WHEN t.status = 'COMPLETED' THEN 1 ELSE 0 END) AS completed
      RETURN s.name AS site, s.country AS country, trials, completed
      ORDER BY trials DESC LIMIT toInteger($limit)
    `, { sponsor, limit });

    // Competitors at those sites
    const compRecords = await cypher(`
      MATCH (sp:Sponsor {name: $sponsor})-[:RUNS]->(t:Trial)-[:AT]->(s:Site)<-[:AT]-(t2:Trial)<-[:RUNS]-(comp:Sponsor)
      WHERE sp <> comp
      WITH comp, COUNT(DISTINCT s) AS shared_sites, COUNT(DISTINCT t2) AS comp_trials
      RETURN comp.name AS competitor, shared_sites, comp_trials
      ORDER BY shared_sites DESC LIMIT 10
    `, { sponsor });

    // Conditions this sponsor focuses on
    const condRecords = await cypher(`
      MATCH (sp:Sponsor {name: $sponsor})-[:RUNS]->(t:Trial)-[:TREATS]->(c:Condition)
      RETURN c.name AS condition, COUNT(DISTINCT t) AS trials
      ORDER BY trials DESC LIMIT 10
    `, { sponsor });

    // Total trial count
    const countRecord = await cypher(`
      MATCH (sp:Sponsor {name: $sponsor})-[:RUNS]->(t:Trial)
      RETURN COUNT(t) AS total
    `, { sponsor });

    // Top interventions
    const intRecords = await cypher(`
      MATCH (sp:Sponsor {name: $sponsor})-[:RUNS]->(t:Trial)-[:USES]->(i:Intervention)
      RETURN i.name AS intervention, COUNT(DISTINCT t) AS trials
      ORDER BY trials DESC LIMIT 10
    `, { sponsor });

    res.json({
      trial_count: nInt(countRecord[0]?.get("total") ?? 0),
      top_sites: siteRecords.map(r => ({
        site: r.get("site"), country: r.get("country"),
        trials: nInt(r.get("trials")), completed: nInt(r.get("completed")),
      })),
      competitors: compRecords.map(r => ({
        competitor: r.get("competitor"),
        shared_sites: nInt(r.get("shared_sites")),
        competitor_trials: nInt(r.get("comp_trials")),
      })),
      conditions: condRecords.map(r => ({
        condition: r.get("condition"),
        trials: nInt(r.get("trials")),
      })),
      interventions: intRecords.map(r => ({
        intervention: r.get("intervention"),
        trials: nInt(r.get("trials")),
      })),
    });
  } catch (e) {
    console.error("[graph/sponsor-network]", e.message);
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/graph/stats
 * Return graph node/edge counts.
 */
app.get("/api/graph/stats", async (req, res) => {
  try {
    const nodeRecords = await cypher(`MATCH (n) RETURN labels(n)[0] AS label, COUNT(n) AS count ORDER BY count DESC`);
    const edgeRecords = await cypher(`MATCH ()-[r]->() RETURN type(r) AS type, COUNT(r) AS count ORDER BY count DESC`);
    res.json({
      nodes: Object.fromEntries(nodeRecords.map(r => [r.get("label"), nInt(r.get("count"))])),
      edges: Object.fromEntries(edgeRecords.map(r => [r.get("type"), nInt(r.get("count"))])),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /api/graph/execute
 * Execute a pre-validated Cypher query against Neo4j.
 * LLM generation + narration happens on Vercel (where GitHub Copilot API is reachable).
 * This endpoint only handles Cypher execution — no LLM calls.
 *
 * Body: { cypher: "MATCH (s:Sponsor)..." }
 * Returns: { columns, rows, total }
 */
app.post("/api/graph/execute", express.json(), async (req, res) => {
  const { cypher: queryCypher } = req.body || {};
  if (!queryCypher || typeof queryCypher !== "string" || queryCypher.trim().length < 5) {
    return res.status(400).json({ error: "cypher required" });
  }
  if (!neo4j) return res.status(503).json({ error: "Knowledge graph not available" });

  // Safety: reject any write operations
  const writeOps = /\b(CREATE|MERGE|SET|DELETE|DETACH|REMOVE|DROP|CALL\s*\{)\b/i;
  if (writeOps.test(queryCypher)) {
    return res.status(403).json({ error: "Write operations are not allowed" });
  }

  // Ensure LIMIT exists
  const safeCypher = /LIMIT\b/i.test(queryCypher) ? queryCypher : queryCypher + "\nLIMIT 25";

  try {
    const records = await cypher(safeCypher);
    const columns = records.length > 0 ? records[0].keys : [];
    const rows = records.map(r => {
      const obj = {};
      for (const k of columns) {
        const v = r.get(k);
        obj[k] = v != null && typeof v === "object" && typeof v.toNumber === "function" ? v.toNumber() : v;
      }
      return obj;
    });
    res.json({ columns, rows, total: rows.length });
  } catch (e) {
    console.error("[graph/execute] Cypher failed:", e.message);
    res.status(422).json({ error: e.message, cypher: safeCypher });
  }
});

app.listen(parseInt(PORT), () => {
  console.log(`[server] listening on :${PORT} — backend: ${db ? `sqlite (${snapshotAge})` : "postgres fallback"}`);
});
