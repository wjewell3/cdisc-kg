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
    const d = new Database(DB_PATH); // read-write so we can create indexes
    d.pragma("cache_size = -32000");
    d.pragma("journal_mode = WAL");  // safe for concurrent snapshot writer
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

    // Create performance indexes for geo queries (one-time cost per snapshot refresh)
    // Each index gets its own try-catch so a missing table doesn't block the others.
    const indexes = [
      ["idx_ctr_name",          "CREATE INDEX IF NOT EXISTS idx_ctr_name ON countries(name)"],
      ["idx_ctr_nct",           "CREATE INDEX IF NOT EXISTS idx_ctr_nct ON countries(nct_id)"],
      ["idx_fac_country_city",  "CREATE INDEX IF NOT EXISTS idx_fac_country_city ON facilities(country, city)"],
    ];
    for (const [name, sql] of indexes) {
      const exists = d.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name=?`).get(name);
      if (!exists) {
        try { d.prepare(sql).run(); } catch (e) { /* table may not exist yet */ }
      }
    }

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

      const response = await fetch("https://models.inference.ai.azure.com/chat/completions", {
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

    const response = await fetch("https://models.inference.ai.azure.com/chat/completions", {
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
    const response = await fetch("https://models.inference.ai.azure.com/chat/completions", {
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

// ── KG Context Cards ─────────────────────────────────────────────────────────
// Returns graph-derived facts for any entity: adjacent entities, strategic gaps,
// similar peers — makes the KG feel omnipresent, not a side panel.
app.get("/api/graph/kg-context", async (req, res) => {
  const { type, name } = req.query;
  if (!type || !name) return res.status(400).json({ error: "type and name required" });
  if (!neo4j) return res.status(503).json({ error: "Knowledge graph not available" });

  try {
    const facts = [];

    if (type === "sponsor") {
      // 1. Top conditions this sponsor trials
      const condRecs = await cypher(`
        MATCH (s:Sponsor {name: $name})-[:RUNS]->(t:Trial)-[:TREATS]->(c:Condition)
        RETURN c.name AS condition, COUNT(DISTINCT t) AS trials
        ORDER BY trials DESC LIMIT 5
      `, { name });
      if (condRecs.length) facts.push({
        type: "top_conditions",
        label: "Top therapeutic areas",
        items: condRecs.map(r => ({ name: r.get("condition"), count: nInt(r.get("trials")) })),
      });

      // 2. Strategic gaps (conditions adjacent to portfolio but not pursued)
      const gapRecs = await cypher(`
        MATCH (s:Sponsor {name: $name})-[:RUNS]->(t:Trial)-[:TREATS]->(my:Condition)
        WITH COLLECT(DISTINCT my.name) AS myNames
        UNWIND myNames AS mn
        MATCH (mc:Condition {name: mn})<-[:TREATS]-(t2:Trial)-[:TREATS]->(gap:Condition)
        WHERE NOT gap.name IN myNames
        WITH gap.name AS condition, COUNT(DISTINCT t2) AS strength
        RETURN condition, strength ORDER BY strength DESC LIMIT 5
      `, { name });
      if (gapRecs.length) facts.push({
        type: "strategic_gaps",
        label: "Expansion opportunities",
        description: "Conditions adjacent to portfolio where this sponsor has zero trials",
        items: gapRecs.map(r => ({ name: r.get("condition"), count: nInt(r.get("strength")) })),
      });

      // 3. Competitors (via shared conditions)
      const compRecs = await cypher(`
        MATCH (s:Sponsor {name: $name})-[:RUNS]->(t:Trial)-[:TREATS]->(c:Condition)<-[:TREATS]-(t2:Trial)<-[:RUNS]-(comp:Sponsor)
        WHERE s <> comp
        WITH comp.name AS competitor, COUNT(DISTINCT c) AS shared_conditions, COUNT(DISTINCT t2) AS trials
        RETURN competitor, shared_conditions, trials
        ORDER BY shared_conditions DESC LIMIT 5
      `, { name });
      if (compRecs.length) facts.push({
        type: "competitors",
        label: "Top competitors (shared conditions)",
        items: compRecs.map(r => ({ name: r.get("competitor"), count: nInt(r.get("shared_conditions")), trials: nInt(r.get("trials")) })),
      });

    } else if (type === "condition") {
      // 1. Adjacent conditions (shared interventions)
      const adjRecs = await cypher(`
        MATCH (c1:Condition {name: $name})<-[:TREATS]-(t:Trial)-[:USES]->(i:Intervention)
        WITH i, COUNT(t) AS ct ORDER BY ct DESC LIMIT 100
        MATCH (i)<-[:USES]-(t2:Trial)-[:TREATS]->(c2:Condition)
        WHERE c2.name <> $name
        WITH c2.name AS condition, COUNT(DISTINCT i) AS shared
        RETURN condition, shared ORDER BY shared DESC LIMIT 5
      `, { name });
      if (adjRecs.length) facts.push({
        type: "adjacent_conditions",
        label: "Therapeutically adjacent conditions",
        description: "Share clinical interventions — drug repurposing signals",
        items: adjRecs.map(r => ({ name: r.get("condition"), count: nInt(r.get("shared")) })),
      });

      // 2. Top sponsors in this condition
      const sponsorRecs = await cypher(`
        MATCH (c:Condition {name: $name})<-[:TREATS]-(t:Trial)<-[:RUNS]-(s:Sponsor)
        RETURN s.name AS sponsor, COUNT(DISTINCT t) AS trials
        ORDER BY trials DESC LIMIT 5
      `, { name });
      if (sponsorRecs.length) facts.push({
        type: "top_sponsors",
        label: "Leading sponsors",
        items: sponsorRecs.map(r => ({ name: r.get("sponsor"), count: nInt(r.get("trials")) })),
      });

      // 3. Top interventions
      const intRecs = await cypher(`
        MATCH (c:Condition {name: $name})<-[:TREATS]-(t:Trial)-[:USES]->(i:Intervention)
        RETURN i.name AS intervention, COUNT(DISTINCT t) AS trials
        ORDER BY trials DESC LIMIT 5
      `, { name });
      if (intRecs.length) facts.push({
        type: "top_interventions",
        label: "Top interventions",
        items: intRecs.map(r => ({ name: r.get("intervention"), count: nInt(r.get("trials")) })),
      });

    } else if (type === "intervention") {
      // 1. Conditions treated by this intervention
      const condRecs = await cypher(`
        MATCH (i:Intervention {name: $name})<-[:USES]-(t:Trial)-[:TREATS]->(c:Condition)
        RETURN c.name AS condition, COUNT(DISTINCT t) AS trials
        ORDER BY trials DESC LIMIT 5
      `, { name });
      if (condRecs.length) facts.push({
        type: "conditions_treated",
        label: "Conditions treated",
        items: condRecs.map(r => ({ name: r.get("condition"), count: nInt(r.get("trials")) })),
      });

      // 2. Sponsors using this intervention
      const sponsorRecs = await cypher(`
        MATCH (i:Intervention {name: $name})<-[:USES]-(t:Trial)<-[:RUNS]-(s:Sponsor)
        RETURN s.name AS sponsor, COUNT(DISTINCT t) AS trials
        ORDER BY trials DESC LIMIT 5
      `, { name });
      if (sponsorRecs.length) facts.push({
        type: "top_sponsors",
        label: "Leading sponsors",
        items: sponsorRecs.map(r => ({ name: r.get("sponsor"), count: nInt(r.get("trials")) })),
      });

      // 3. Similar interventions (Jaccard via shared conditions)
      const simRecs = await cypher(`
        MATCH (i1:Intervention {name: $name})<-[:USES]-(t1:Trial)-[:TREATS]->(c:Condition)
        WITH i1, COLLECT(DISTINCT c.name) AS myConditions
        MATCH (c2:Condition)<-[:TREATS]-(t2:Trial)-[:USES]->(i2:Intervention)
        WHERE c2.name IN myConditions AND i2.name <> $name
        WITH i2.name AS intervention, COUNT(DISTINCT c2) AS overlap, SIZE(myConditions) AS mySize
        RETURN intervention, overlap, toFloat(overlap) / mySize AS similarity
        ORDER BY similarity DESC LIMIT 5
      `, { name });
      if (simRecs.length) facts.push({
        type: "similar_interventions",
        label: "Similar interventions (shared conditions)",
        items: simRecs.map(r => ({ name: r.get("intervention"), count: nInt(r.get("overlap")), similarity: Math.round(r.get("similarity") * 100) })),
      });
    }

    res.json({ type, name, facts });
  } catch (e) {
    console.error("[graph/kg-context]", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Similar Entities (Jaccard similarity via shared graph neighbors) ─────────
app.get("/api/graph/similar", async (req, res) => {
  const { type, name, limit = "10" } = req.query;
  if (!type || !name) return res.status(400).json({ error: "type and name required" });
  if (!neo4j) return res.status(503).json({ error: "Knowledge graph not available" });

  try {
    let records;
    if (type === "sponsor") {
      records = await cypher(`
        MATCH (s1:Sponsor {name: $name})-[:RUNS]->(t1:Trial)-[:TREATS]->(c:Condition)
        WITH s1, COLLECT(DISTINCT c.name) AS myConditions
        MATCH (s2:Sponsor)-[:RUNS]->(t2:Trial)-[:TREATS]->(c2:Condition)
        WHERE s2 <> s1 AND c2.name IN myConditions
        WITH s2.name AS peer, COLLECT(DISTINCT c2.name) AS overlap, myConditions
        WITH peer, SIZE(overlap) AS intersection, myConditions
        MATCH (s2:Sponsor {name: peer})-[:RUNS]->(t:Trial)-[:TREATS]->(c3:Condition)
        WITH peer, intersection, myConditions, COLLECT(DISTINCT c3.name) AS peerConditions
        WITH peer, intersection,
             toFloat(intersection) / SIZE(apoc.coll.union(myConditions, peerConditions)) AS jaccard,
             intersection AS shared_conditions
        WHERE jaccard > 0
        RETURN peer, shared_conditions, ROUND(jaccard * 100) AS similarity_pct
        ORDER BY similarity_pct DESC
        LIMIT toInteger($limit)
      `, { name, limit });
    } else if (type === "condition") {
      records = await cypher(`
        MATCH (c1:Condition {name: $name})<-[:TREATS]-(t1:Trial)-[:USES]->(i:Intervention)
        WITH c1, COLLECT(DISTINCT i.name) AS myDrugs
        MATCH (c2:Condition)<-[:TREATS]-(t2:Trial)-[:USES]->(i2:Intervention)
        WHERE c2 <> c1 AND i2.name IN myDrugs
        WITH c2.name AS peer, COUNT(DISTINCT i2) AS shared_drugs, SIZE(myDrugs) AS mySize
        RETURN peer, shared_drugs, ROUND(100.0 * shared_drugs / mySize) AS similarity_pct
        ORDER BY similarity_pct DESC
        LIMIT toInteger($limit)
      `, { name, limit });
    } else {
      return res.status(400).json({ error: "type must be sponsor or condition" });
    }

    res.json(records.map(r => ({
      peer: r.get("peer"),
      shared: nInt(r.get(type === "sponsor" ? "shared_conditions" : "shared_drugs")),
      similarity_pct: nInt(r.get("similarity_pct")),
    })));
  } catch (e) {
    // Fallback: simpler query if APOC not available
    if (e.message.includes("apoc") && type === "sponsor") {
      try {
        const records = await cypher(`
          MATCH (s1:Sponsor {name: $name})-[:RUNS]->(t1:Trial)-[:TREATS]->(c:Condition)
          WITH s1, COLLECT(DISTINCT c.name) AS myConditions
          MATCH (s2:Sponsor)-[:RUNS]->(t2:Trial)-[:TREATS]->(c2:Condition)
          WHERE s2 <> s1 AND c2.name IN myConditions
          WITH s2.name AS peer, COUNT(DISTINCT c2) AS shared_conditions, SIZE(myConditions) AS mySize
          RETURN peer, shared_conditions, ROUND(100.0 * shared_conditions / mySize) AS similarity_pct
          ORDER BY similarity_pct DESC
          LIMIT toInteger($limit)
        `, { name, limit });
        return res.json(records.map(r => ({
          peer: r.get("peer"),
          shared: nInt(r.get("shared_conditions")),
          similarity_pct: nInt(r.get("similarity_pct")),
        })));
      } catch (e2) {
        return res.status(500).json({ error: e2.message });
      }
    }
    console.error("[graph/similar]", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Trials Like This One ────────────────────────────────────────────────────
// Graph-neighbor similar trials: same condition+intervention+phase combo
app.get("/api/graph/trials-like", async (req, res) => {
  const { nct_id, limit = "10" } = req.query;
  if (!nct_id) return res.status(400).json({ error: "nct_id required" });
  if (!neo4j) return res.status(503).json({ error: "Knowledge graph not available" });

  try {
    const records = await cypher(`
      MATCH (t:Trial {nct_id: $nct_id})-[:TREATS]->(c:Condition),
            (t)-[:USES]->(i:Intervention)
      WITH t, COLLECT(DISTINCT c.name) AS myConditions, COLLECT(DISTINCT i.name) AS myInterventions
      MATCH (t2:Trial)-[:TREATS]->(c2:Condition), (t2)-[:USES]->(i2:Intervention)
      WHERE t2 <> t
        AND c2.name IN myConditions
        AND i2.name IN myInterventions
      WITH t2, t,
           COUNT(DISTINCT c2) AS shared_conditions,
           COUNT(DISTINCT i2) AS shared_interventions,
           SIZE(myConditions) AS total_conditions,
           SIZE(myInterventions) AS total_interventions
      WITH t2,
           shared_conditions + shared_interventions AS total_overlap,
           shared_conditions, shared_interventions,
           CASE WHEN t2.phase = t.phase THEN 1 ELSE 0 END AS same_phase
      RETURN t2.nct_id AS nct_id, t2.brief_title AS title, t2.phase AS phase,
             t2.status AS status, t2.enrollment AS enrollment,
             shared_conditions, shared_interventions,
             total_overlap + same_phase AS similarity_score
      ORDER BY similarity_score DESC
      LIMIT toInteger($limit)
    `, { nct_id, limit });

    res.json(records.map(r => ({
      nct_id: r.get("nct_id"),
      title: r.get("title"),
      phase: r.get("phase"),
      status: r.get("status"),
      enrollment: nInt(r.get("enrollment")),
      shared_conditions: nInt(r.get("shared_conditions")),
      shared_interventions: nInt(r.get("shared_interventions")),
      similarity_score: nInt(r.get("similarity_score")),
    })));
  } catch (e) {
    console.error("[graph/trials-like]", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Graph Centrality ────────────────────────────────────────────────────────
// Genuinely graph-native: multi-hop bridge score + 2nd-degree reach.
// Bridge score: conditions that lie on paths between distinct sponsor clusters
// (Sponsor₁ → Trial → Condition → Trial → Sponsor₂ where Sponsor₁ ≠ Sponsor₂).
// This CANNOT be replicated with SQL GROUP BY — it requires 3-hop path reasoning.
app.get("/api/graph/centrality", async (req, res) => {
  const { type = "condition", limit = "20" } = req.query;
  if (!neo4j) return res.status(503).json({ error: "Knowledge graph not available" });

  try {
    let records;
    if (type === "condition") {
      // Bridge score: how many distinct sponsor-pairs does this condition connect?
      // High bridge score = condition sits at intersection of multiple sponsor programs.
      // Secondary: 2nd-degree reach = distinct conditions reachable in 2 hops via shared interventions.
      records = await cypher(`
        MATCH (c:Condition)<-[:TREATS]-(t:Trial)<-[:RUNS]-(s:Sponsor)
        WITH c, COLLECT(DISTINCT s) AS sponsors, COUNT(DISTINCT t) AS trials
        WHERE SIZE(sponsors) >= 3
        WITH c, trials, SIZE(sponsors) AS sponsor_count, sponsors
        // Bridge score: count distinct sponsor pairs connected through this condition
        UNWIND sponsors AS s1
        UNWIND sponsors AS s2
        WITH c, trials, sponsor_count, s1, s2
        WHERE id(s1) < id(s2)
        WITH c.name AS entity, trials, sponsor_count,
             COUNT(*) AS bridge_score
        // 2nd-degree reach: conditions reachable via shared interventions (2-hop)
        MATCH (src:Condition {name: entity})<-[:TREATS]-(t2:Trial)-[:USES]->(i:Intervention)
        WITH entity, trials, sponsor_count, bridge_score,
             COUNT(DISTINCT i) AS unique_interventions
        RETURN entity, trials, sponsor_count, bridge_score, unique_interventions
        ORDER BY bridge_score DESC
        LIMIT toInteger($limit)
      `, { limit });
    } else if (type === "sponsor") {
      // For sponsors: how many distinct condition-pairs does this sponsor bridge?
      // High score = sponsor operates across diverse therapeutic areas.
      records = await cypher(`
        MATCH (s:Sponsor)-[:RUNS]->(t:Trial)-[:TREATS]->(c:Condition)
        WITH s, COLLECT(DISTINCT c) AS conditions, COUNT(DISTINCT t) AS trials
        WHERE SIZE(conditions) >= 3
        WITH s, trials, SIZE(conditions) AS condition_count, conditions
        UNWIND conditions AS c1
        UNWIND conditions AS c2
        WITH s, trials, condition_count, c1, c2
        WHERE id(c1) < id(c2)
        WITH s.name AS entity, trials, condition_count,
             COUNT(*) AS bridge_score
        MATCH (src:Sponsor {name: entity})-[:RUNS]->(t2:Trial)-[:USES]->(i:Intervention)
        WITH entity, trials, condition_count, bridge_score,
             COUNT(DISTINCT i) AS unique_interventions
        RETURN entity, trials, condition_count, bridge_score, unique_interventions
        ORDER BY bridge_score DESC
        LIMIT toInteger($limit)
      `, { limit });
    } else {
      return res.status(400).json({ error: "type must be condition or sponsor" });
    }

    const items = records.map(r => {
      const obj = {
        entity: r.get("entity"),
        trials: nInt(r.get("trials")),
        bridge_score: nInt(r.get("bridge_score")),
        unique_interventions: nInt(r.get("unique_interventions")),
      };
      if (type === "condition") {
        obj.sponsor_count = nInt(r.get("sponsor_count"));
      } else {
        obj.condition_count = nInt(r.get("condition_count"));
      }
      return obj;
    });

    res.json({
      type,
      algorithm: "multi-hop bridge score (3-hop sponsor-condition-sponsor paths)",
      description: type === "condition"
        ? "Conditions that bridge the most distinct sponsor programs — hub positions in the clinical trial network"
        : "Sponsors that bridge the most distinct therapeutic areas — diversified portfolio leaders",
      items,
    });
  } catch (e) {
    console.error("[graph/centrality]", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Graph Communities ────────────────────────────────────────────────────────
// Real overlay-graph community detection via condition-condition edges.
// Step 1: Build condition pairs linked by shared interventions (2-hop path)
// Step 2: Label propagation — each condition adopts the community of its strongest neighbor
// This is genuinely graph-native: the communities emerge from graph structure,
// not from pre-defined categories or GROUP BY.
app.get("/api/graph/communities", async (req, res) => {
  const { min_shared = "3", limit = "60" } = req.query;
  if (!neo4j) return res.status(503).json({ error: "Knowledge graph not available" });

  try {
    // Phase 1: Build overlay graph — intervention-centric approach.
    // For each intervention, collect the conditions it treats (via Trial links).
    // Then expand pairs from that set. This avoids the 4-hop cartesian explosion.
    const records = await cypher(`
      MATCH (c:Condition)<-[:TREATS]-(t:Trial)-[:USES]->(i:Intervention)
      WITH i, COLLECT(DISTINCT c.name) AS conditions, COUNT(DISTINCT t) AS tc
      WHERE tc >= 5 AND SIZE(conditions) >= 2 AND SIZE(conditions) <= 50
      UNWIND conditions AS c1
      UNWIND conditions AS c2
      WITH c1 AS cond1, c2 AS cond2
      WHERE cond1 < cond2
      WITH cond1, cond2, COUNT(*) AS shared_interventions
      WHERE shared_interventions >= toInteger($min_shared)
      RETURN cond1, cond2, shared_interventions
      ORDER BY shared_interventions DESC
      LIMIT 500
    `, { min_shared });

    // Phase 2: Label propagation in JS — each condition starts as its own community,
    // then iteratively adopts the community label of its strongest neighbor.
    const edges = records.map(r => ({
      a: r.get("cond1"), b: r.get("cond2"), weight: nInt(r.get("shared_interventions")),
    }));

    // Build adjacency
    const adj = {};
    for (const e of edges) {
      if (!adj[e.a]) adj[e.a] = [];
      if (!adj[e.b]) adj[e.b] = [];
      adj[e.a].push({ peer: e.b, weight: e.weight });
      adj[e.b].push({ peer: e.a, weight: e.weight });
    }

    // Initialize: each node = its own community
    const community = {};
    const allNodes = Object.keys(adj);
    allNodes.forEach(n => { community[n] = n; });

    // Iterate label propagation (5 rounds)
    for (let round = 0; round < 5; round++) {
      for (const node of allNodes) {
        const votes = {};
        for (const { peer, weight } of adj[node]) {
          const label = community[peer];
          votes[label] = (votes[label] || 0) + weight;
        }
        // Adopt strongest neighbor's community
        let bestLabel = community[node], bestWeight = 0;
        for (const [label, w] of Object.entries(votes)) {
          if (w > bestWeight) { bestLabel = label; bestWeight = w; }
        }
        community[node] = bestLabel;
      }
    }

    // Group into clusters
    const clusters = {};
    for (const [node, label] of Object.entries(community)) {
      if (!clusters[label]) clusters[label] = [];
      clusters[label].push(node);
    }

    // Get trial counts for cluster members
    const trialCounts = {};
    const tcRecords = await cypher(`
      MATCH (c:Condition)<-[:TREATS]-(t:Trial)
      WHERE c.name IN $names
      RETURN c.name AS condition, COUNT(DISTINCT t) AS trials
    `, { names: allNodes });
    for (const r of tcRecords) {
      trialCounts[r.get("condition")] = nInt(r.get("trials"));
    }

    // Format clusters, sorted by size
    const result = Object.entries(clusters)
      .map(([label, members]) => ({
        community_seed: label,
        size: members.length,
        total_trials: members.reduce((s, m) => s + (trialCounts[m] || 0), 0),
        conditions: members
          .map(m => ({ name: m, trials: trialCounts[m] || 0 }))
          .sort((a, b) => b.trials - a.trials),
        // Internal edge density
        internal_edges: edges.filter(e =>
          community[e.a] === label && community[e.b] === label
        ).length,
      }))
      .filter(c => c.size >= 2)
      .sort((a, b) => b.size - a.size)
      .slice(0, parseInt(limit));

    res.json({
      algorithm: "label propagation over condition-condition overlay graph (2-hop via shared interventions)",
      description: "Communities emerge from graph structure — conditions clustered by shared drug pipelines, not predefined categories",
      min_shared_interventions: parseInt(min_shared),
      total_conditions: allNodes.length,
      total_communities: result.length,
      communities: result,
    });
  } catch (e) {
    console.error("[graph/communities]", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Sponsor Completion Rate via KG ──────────────────────────────────────────
// Moves the "sponsor performance" analytics path through the knowledge graph.
// Instead of SQL GROUP BY, this traverses Sponsor → Trial edges and aggregates
// trial.status in Cypher — the KG IS the semantic layer the analytics run on.
// Demonstrates: same insight, graph-native execution path.
app.get("/api/graph/sponsor-completion", async (req, res) => {
  const { condition, phase, min_trials = "20", limit = "25" } = req.query;
  if (!neo4j) return res.status(503).json({ error: "Knowledge graph not available" });

  try {
    // Build dynamic WHERE clause based on optional filters
    let matchClause = "MATCH (s:Sponsor)-[:RUNS]->(t:Trial)";
    let whereClause = "";
    const params = { min_trials, limit };

    if (condition) {
      matchClause += "-[:TREATS]->(c:Condition {name: $condition})";
      params.condition = condition;
    }
    if (phase) {
      whereClause = "WHERE t.phase = $phase";
      params.phase = phase;
    }

    const records = await cypher(`
      ${matchClause}
      ${whereClause}
      WITH s.name AS sponsor,
           COUNT(DISTINCT t) AS total,
           SUM(CASE WHEN t.status = 'COMPLETED' THEN 1 ELSE 0 END) AS completed,
           SUM(CASE WHEN t.status IN ['TERMINATED', 'WITHDRAWN', 'SUSPENDED'] THEN 1 ELSE 0 END) AS failed,
           SUM(CASE WHEN t.status IN ['RECRUITING', 'ACTIVE_NOT_RECRUITING', 'ENROLLING_BY_INVITATION', 'NOT_YET_RECRUITING'] THEN 1 ELSE 0 END) AS active
      WHERE total >= toInteger($min_trials)
      WITH sponsor, total, completed, failed, active,
           ROUND(100.0 * completed / total) AS completion_pct,
           ROUND(100.0 * failed / total) AS failure_pct
      RETURN sponsor, total, completed, failed, active,
             completion_pct, failure_pct
      ORDER BY completion_pct DESC
      LIMIT toInteger($limit)
    `, params);

    const items = records.map(r => ({
      sponsor: r.get("sponsor"),
      total: nInt(r.get("total")),
      completed: nInt(r.get("completed")),
      failed: nInt(r.get("failed")),
      active: nInt(r.get("active")),
      completion_pct: nInt(r.get("completion_pct")),
      failure_pct: nInt(r.get("failure_pct")),
    }));

    res.json({
      source: "knowledge_graph",
      description: "Sponsor completion rates computed via graph traversal (Sponsor → Trial edge aggregation), not SQL GROUP BY",
      filters: { condition: condition || null, phase: phase || null, min_trials: parseInt(min_trials) },
      items,
    });
  } catch (e) {
    console.error("[graph/sponsor-completion]", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Failure Analysis ─────────────────────────────────────────────────────────
// Returns termination rate + clustered why_stopped reasons for a filtered cohort.
// Answers: "What's the real termination rate for Phase 3 oncology trials, and why?"
app.get("/api/failure-analysis", async (req, res) => {
  const { condition = "", phase = "", sponsor = "", intervention = "", min_enrollment = "", max_enrollment = "" } = req.query;

  // ── SQLite path ─────────────────────────────────────────────────────
  if (db) {
  try {
    const { where, params } = buildSqliteWhere({ condition, phase, sponsor, intervention, min_enrollment, max_enrollment });

    // Overall counts
    const counts = db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN s.overall_status = 'COMPLETED'  THEN 1 ELSE 0 END) AS completed,
        SUM(CASE WHEN s.overall_status = 'TERMINATED' THEN 1 ELSE 0 END) AS terminated,
        SUM(CASE WHEN s.overall_status = 'WITHDRAWN'  THEN 1 ELSE 0 END) AS withdrawn,
        SUM(CASE WHEN s.overall_status = 'SUSPENDED'  THEN 1 ELSE 0 END) AS suspended
      FROM studies s ${where}
    `).get(...params);

    const finished = counts.completed + counts.terminated;
    const termination_rate_pct = finished > 0 ? parseFloat(((counts.terminated / finished) * 100).toFixed(1)) : null;

    // Clustered why_stopped reasons (normalized to lowercase, trimmed)
    const stopReasons = db.prepare(`
      SELECT LOWER(TRIM(s.why_stopped)) AS reason, COUNT(*) AS count
      FROM studies s ${where ? where + ' AND' : 'WHERE'} s.why_stopped IS NOT NULL AND s.why_stopped != ''
      GROUP BY LOWER(TRIM(s.why_stopped))
      ORDER BY count DESC
      LIMIT 20
    `).all(...params);

    // Termination rate by top conditions (for cross-dimensional insight)
    const byCondition = db.prepare(`
      SELECT c.name AS condition_name,
        COUNT(DISTINCT s.nct_id) AS total,
        SUM(CASE WHEN s.overall_status = 'TERMINATED' THEN 1 ELSE 0 END) AS terminated,
        SUM(CASE WHEN s.overall_status = 'COMPLETED' THEN 1 ELSE 0 END) AS completed
      FROM studies s
      JOIN conditions c ON c.nct_id = s.nct_id
      ${where}
      GROUP BY c.name
      HAVING total >= 20
      ORDER BY total DESC
      LIMIT 25
    `).all(...params);

    const conditionRates = byCondition.map(r => {
      const fin = r.completed + r.terminated;
      return {
        condition: r.condition_name,
        total: r.total,
        terminated: r.terminated,
        completed: r.completed,
        termination_rate_pct: fin > 0 ? parseFloat(((r.terminated / fin) * 100).toFixed(1)) : null,
      };
    }).sort((a, b) => (b.termination_rate_pct ?? 0) - (a.termination_rate_pct ?? 0));

    // Termination rate by phase
    const byPhase = db.prepare(`
      SELECT COALESCE(s.phase, 'Unknown') AS phase,
        COUNT(*) AS total,
        SUM(CASE WHEN s.overall_status = 'TERMINATED' THEN 1 ELSE 0 END) AS terminated,
        SUM(CASE WHEN s.overall_status = 'COMPLETED' THEN 1 ELSE 0 END) AS completed
      FROM studies s ${where}
      GROUP BY 1
      ORDER BY total DESC
    `).all(...params);

    const phaseRates = byPhase.map(r => {
      const fin = r.completed + r.terminated;
      return {
        phase: r.phase,
        total: r.total,
        terminated: r.terminated,
        termination_rate_pct: fin > 0 ? parseFloat(((r.terminated / fin) * 100).toFixed(1)) : null,
      };
    });

    return res.json({
      counts,
      termination_rate_pct,
      stop_reasons: stopReasons.map(r => ({ reason: r.reason, count: r.count })),
      by_condition: conditionRates,
      by_phase: phaseRates,
    });
  } catch (e) {
    console.error("[failure-analysis] sqlite:", e.message);
    // fall through to PG
  }
  }

  // ── PostgreSQL fallback ────────────────────────────────────────────
  const pool = getPgPool();
  if (!pool) return res.status(503).json({ error: "SQLite snapshot rebuilding and no AACT credentials for live fallback." });
  try {
    const pgClauses = [];
    const pgParams = [];
    let idx = 1;
    if (condition) { pgClauses.push(`EXISTS (SELECT 1 FROM conditions c WHERE c.nct_id = s.nct_id AND c.name ILIKE $${idx})`); pgParams.push(`%${condition}%`); idx++; }
    if (phase) { pgClauses.push(`s.phase = $${idx}`); pgParams.push(phase); idx++; }
    if (sponsor) { pgClauses.push(`EXISTS (SELECT 1 FROM sponsors sp WHERE sp.nct_id = s.nct_id AND sp.lead_or_collaborator = 'lead' AND sp.name ILIKE $${idx})`); pgParams.push(`%${sponsor}%`); idx++; }
    if (intervention) { pgClauses.push(`EXISTS (SELECT 1 FROM interventions i WHERE i.nct_id = s.nct_id AND i.name ILIKE $${idx})`); pgParams.push(`%${intervention}%`); idx++; }
    if (min_enrollment) { pgClauses.push(`s.enrollment >= $${idx}`); pgParams.push(parseInt(min_enrollment)); idx++; }
    if (max_enrollment && parseInt(max_enrollment) < 999999999) { pgClauses.push(`s.enrollment <= $${idx}`); pgParams.push(parseInt(max_enrollment)); idx++; }
    const pgWhere = pgClauses.length ? `WHERE ${pgClauses.join(" AND ")}` : "";

    const { rows: [counts] } = await pool.query(`
      SELECT COUNT(*) AS total,
        SUM(CASE WHEN s.overall_status = 'COMPLETED'  THEN 1 ELSE 0 END) AS completed,
        SUM(CASE WHEN s.overall_status = 'TERMINATED' THEN 1 ELSE 0 END) AS terminated,
        SUM(CASE WHEN s.overall_status = 'WITHDRAWN'  THEN 1 ELSE 0 END) AS withdrawn,
        SUM(CASE WHEN s.overall_status = 'SUSPENDED'  THEN 1 ELSE 0 END) AS suspended
      FROM studies s ${pgWhere}
    `, pgParams);

    const total = parseInt(counts.total);
    const completed = parseInt(counts.completed);
    const terminated = parseInt(counts.terminated);
    const finished = completed + terminated;
    const termination_rate_pct = finished > 0 ? parseFloat(((terminated / finished) * 100).toFixed(1)) : null;

    const { rows: stopReasons } = await pool.query(`
      SELECT LOWER(TRIM(s.why_stopped)) AS reason, COUNT(*)::int AS count
      FROM studies s ${pgWhere ? pgWhere + ' AND' : 'WHERE'} s.why_stopped IS NOT NULL AND s.why_stopped != ''
      GROUP BY LOWER(TRIM(s.why_stopped))
      ORDER BY count DESC
      LIMIT 20
    `, pgParams);

    const { rows: byCondition } = await pool.query(`
      SELECT c.name AS condition_name,
        COUNT(DISTINCT s.nct_id)::int AS total,
        SUM(CASE WHEN s.overall_status = 'TERMINATED' THEN 1 ELSE 0 END)::int AS terminated,
        SUM(CASE WHEN s.overall_status = 'COMPLETED' THEN 1 ELSE 0 END)::int AS completed
      FROM studies s
      JOIN conditions c ON c.nct_id = s.nct_id
      ${pgWhere}
      GROUP BY c.name
      HAVING COUNT(DISTINCT s.nct_id) >= 20
      ORDER BY COUNT(DISTINCT s.nct_id) DESC
      LIMIT 25
    `, pgParams);

    const conditionRates = byCondition.map(r => {
      const fin = r.completed + r.terminated;
      return {
        condition: r.condition_name,
        total: r.total,
        terminated: r.terminated,
        completed: r.completed,
        termination_rate_pct: fin > 0 ? parseFloat(((r.terminated / fin) * 100).toFixed(1)) : null,
      };
    }).sort((a, b) => (b.termination_rate_pct ?? 0) - (a.termination_rate_pct ?? 0));

    const { rows: byPhase } = await pool.query(`
      SELECT COALESCE(s.phase, 'Unknown') AS phase,
        COUNT(*)::int AS total,
        SUM(CASE WHEN s.overall_status = 'TERMINATED' THEN 1 ELSE 0 END)::int AS terminated,
        SUM(CASE WHEN s.overall_status = 'COMPLETED' THEN 1 ELSE 0 END)::int AS completed
      FROM studies s ${pgWhere}
      GROUP BY 1
      ORDER BY COUNT(*) DESC
    `, pgParams);

    const phaseRates = byPhase.map(r => {
      const fin = r.completed + r.terminated;
      return {
        phase: r.phase,
        total: r.total,
        terminated: r.terminated,
        termination_rate_pct: fin > 0 ? parseFloat(((r.terminated / fin) * 100).toFixed(1)) : null,
      };
    });

    return res.json({
      counts: { total, completed, terminated, withdrawn: parseInt(counts.withdrawn), suspended: parseInt(counts.suspended) },
      termination_rate_pct,
      stop_reasons: stopReasons.map(r => ({ reason: r.reason, count: r.count })),
      by_condition: conditionRates,
      by_phase: phaseRates,
      source: "live",
    });
  } catch (e) {
    console.error("[failure-analysis] pg:", e.message);
    return res.status(500).json({ error: "Query failed", detail: e.message });
  }
});

// ── Sponsor Performance ──────────────────────────────────────────────────────
// Leaderboard: sponsors ranked by completion rate within a filtered cohort.
// Answers: "Which sponsors have the best completion rates in my therapeutic area?"
app.get("/api/sponsor-performance", async (req, res) => {
  const { condition = "", phase = "", intervention = "", min_enrollment = "", max_enrollment = "", min_trials = "10" } = req.query;
  const minTrials = parseInt(min_trials) || 10;

  // ── SQLite path ─────────────────────────────────────────────────────
  if (db) {
  try {
    const { where, params } = buildSqliteWhere({ condition, phase, intervention, min_enrollment, max_enrollment });

    const rows = db.prepare(`
      SELECT sp.name AS sponsor,
        COUNT(DISTINCT s.nct_id) AS total,
        SUM(CASE WHEN s.overall_status = 'COMPLETED'  THEN 1 ELSE 0 END) AS completed,
        SUM(CASE WHEN s.overall_status = 'TERMINATED' THEN 1 ELSE 0 END) AS terminated,
        ROUND(AVG(CASE WHEN s.enrollment_type = 'ACTUAL' THEN CAST(s.enrollment AS REAL) END), 0) AS avg_enrollment
      FROM studies s
      JOIN sponsors sp ON sp.nct_id = s.nct_id AND sp.lead_or_collaborator = 'lead'
      ${where}
      GROUP BY sp.name
      HAVING total >= ?
      ORDER BY total DESC
    `).all(...params, minTrials);

    const sponsors = rows.map(r => {
      const fin = r.completed + r.terminated;
      return {
        sponsor: r.sponsor,
        total: r.total,
        completed: r.completed,
        terminated: r.terminated,
        completion_rate_pct: fin > 0 ? parseFloat(((r.completed / fin) * 100).toFixed(1)) : null,
        avg_enrollment: r.avg_enrollment ? Math.round(r.avg_enrollment) : null,
      };
    }).sort((a, b) => (b.completion_rate_pct ?? 0) - (a.completion_rate_pct ?? 0));

    return res.json({ sponsors, min_trials: minTrials });
  } catch (e) {
    console.error("[sponsor-performance] sqlite:", e.message);
    // fall through to PG
  }
  }

  // ── PostgreSQL fallback ────────────────────────────────────────────
  const pool = getPgPool();
  if (!pool) return res.status(503).json({ error: "SQLite snapshot rebuilding and no AACT credentials for live fallback." });
  try {
    const pgClauses = [];
    const pgParams = [];
    let idx = 1;
    if (condition) { pgClauses.push(`EXISTS (SELECT 1 FROM conditions c WHERE c.nct_id = s.nct_id AND c.name ILIKE $${idx})`); pgParams.push(`%${condition}%`); idx++; }
    if (phase) { pgClauses.push(`s.phase = $${idx}`); pgParams.push(phase); idx++; }
    if (intervention) { pgClauses.push(`EXISTS (SELECT 1 FROM interventions i WHERE i.nct_id = s.nct_id AND i.name ILIKE $${idx})`); pgParams.push(`%${intervention}%`); idx++; }
    if (min_enrollment) { pgClauses.push(`s.enrollment >= $${idx}`); pgParams.push(parseInt(min_enrollment)); idx++; }
    if (max_enrollment && parseInt(max_enrollment) < 999999999) { pgClauses.push(`s.enrollment <= $${idx}`); pgParams.push(parseInt(max_enrollment)); idx++; }
    const pgWhere = pgClauses.length ? `WHERE ${pgClauses.join(" AND ")}` : "";

    const { rows } = await pool.query(`
      SELECT sp.name AS sponsor,
        COUNT(DISTINCT s.nct_id)::int AS total,
        SUM(CASE WHEN s.overall_status = 'COMPLETED' THEN 1 ELSE 0 END)::int AS completed,
        SUM(CASE WHEN s.overall_status = 'TERMINATED' THEN 1 ELSE 0 END)::int AS terminated,
        ROUND(AVG(CASE WHEN s.enrollment_type = 'ACTUAL' THEN s.enrollment::numeric END), 0) AS avg_enrollment
      FROM studies s
      JOIN sponsors sp ON sp.nct_id = s.nct_id AND sp.lead_or_collaborator = 'lead'
      ${pgWhere}
      GROUP BY sp.name
      HAVING COUNT(DISTINCT s.nct_id) >= $${idx}
      ORDER BY COUNT(DISTINCT s.nct_id) DESC
    `, [...pgParams, minTrials]);

    const sponsors = rows.map(r => {
      const fin = r.completed + r.terminated;
      return {
        sponsor: r.sponsor,
        total: r.total,
        completed: r.completed,
        terminated: r.terminated,
        completion_rate_pct: fin > 0 ? parseFloat(((r.completed / fin) * 100).toFixed(1)) : null,
        avg_enrollment: r.avg_enrollment ? Math.round(parseFloat(r.avg_enrollment)) : null,
      };
    }).sort((a, b) => (b.completion_rate_pct ?? 0) - (a.completion_rate_pct ?? 0));

    return res.json({ sponsors, min_trials: minTrials, source: "live" });
  } catch (e) {
    console.error("[sponsor-performance] pg:", e.message);
    return res.status(500).json({ error: "Query failed", detail: e.message });
  }
});

// ── Enrollment Benchmark ─────────────────────────────────────────────────────
// Compares anticipated vs actual enrollment by design type.
// Answers: "How does enrollment ambition compare to historical actuals for this design type?"
app.get("/api/enrollment-benchmark", async (req, res) => {
  const { condition = "", phase = "", sponsor = "", intervention = "", allocation = "", masking = "", intervention_model = "" } = req.query;

  // Try SQLite first (designs table may be missing in older snapshots)
  const hasDesigns = db?.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='designs'").get();
  if (db && hasDesigns) {
  try {
    const { where, params } = buildSqliteWhere({ condition, phase, sponsor, intervention });

    // Build extra design-level WHERE clauses
    const designClauses = [];
    const designParams = [];
    if (allocation) { designClauses.push(`d.allocation = ?`); designParams.push(allocation); }
    if (masking) { designClauses.push(`d.masking = ?`); designParams.push(masking); }
    if (intervention_model) { designClauses.push(`d.intervention_model = ?`); designParams.push(intervention_model); }
    const designWhere = designClauses.length ? `AND ${designClauses.join(' AND ')}` : '';

    // Anticipated vs Actual enrollment summary
    const enrollSummary = db.prepare(`
      SELECT
        s.enrollment_type,
        COUNT(*) AS trial_count,
        ROUND(AVG(CAST(s.enrollment AS REAL)), 0) AS avg_enrollment,
        MIN(s.enrollment) AS min_enrollment,
        MAX(s.enrollment) AS max_enrollment
      FROM studies s
      LEFT JOIN designs d ON d.nct_id = s.nct_id
      ${where ? where + ' AND' : 'WHERE'} s.enrollment IS NOT NULL AND s.enrollment > 0
      ${designWhere}
      GROUP BY s.enrollment_type
    `).all(...params, ...designParams);

    // Enrollment by design characteristics
    const byAllocation = db.prepare(`
      SELECT COALESCE(d.allocation, 'Unknown') AS design_val,
        s.enrollment_type,
        COUNT(*) AS trial_count,
        ROUND(AVG(CAST(s.enrollment AS REAL)), 0) AS avg_enrollment
      FROM studies s
      JOIN designs d ON d.nct_id = s.nct_id
      ${where ? where + ' AND' : 'WHERE'} s.enrollment IS NOT NULL AND s.enrollment > 0
      ${designWhere}
      GROUP BY d.allocation, s.enrollment_type
      ORDER BY trial_count DESC
    `).all(...params, ...designParams);

    const byMasking = db.prepare(`
      SELECT COALESCE(d.masking, 'Unknown') AS design_val,
        s.enrollment_type,
        COUNT(*) AS trial_count,
        ROUND(AVG(CAST(s.enrollment AS REAL)), 0) AS avg_enrollment
      FROM studies s
      JOIN designs d ON d.nct_id = s.nct_id
      ${where ? where + ' AND' : 'WHERE'} s.enrollment IS NOT NULL AND s.enrollment > 0
      ${designWhere}
      GROUP BY d.masking, s.enrollment_type
      ORDER BY trial_count DESC
    `).all(...params, ...designParams);

    // Available design options (for UI dropdowns, scoped to current filters)
    const allocations = db.prepare(`
      SELECT DISTINCT d.allocation AS val FROM designs d
      JOIN studies s ON s.nct_id = d.nct_id
      ${where}
      ${designWhere}
      ORDER BY val
    `).all(...params, ...designParams).map(r => r.val).filter(Boolean);

    const maskings = db.prepare(`
      SELECT DISTINCT d.masking AS val FROM designs d
      JOIN studies s ON s.nct_id = d.nct_id
      ${where}
      ${designWhere}
      ORDER BY val
    `).all(...params, ...designParams).map(r => r.val).filter(Boolean);

    const models = db.prepare(`
      SELECT DISTINCT d.intervention_model AS val FROM designs d
      JOIN studies s ON s.nct_id = d.nct_id
      ${where}
      ${designWhere}
      ORDER BY val
    `).all(...params, ...designParams).map(r => r.val).filter(Boolean);

    res.json({
      summary: enrollSummary.map(r => ({
        enrollment_type: r.enrollment_type || 'Unknown',
        trial_count: r.trial_count,
        avg_enrollment: r.avg_enrollment ? Math.round(r.avg_enrollment) : null,
        min_enrollment: r.min_enrollment,
        max_enrollment: r.max_enrollment,
      })),
      by_allocation: byAllocation.map(r => ({
        design: r.design_val,
        enrollment_type: r.enrollment_type || 'Unknown',
        trial_count: r.trial_count,
        avg_enrollment: r.avg_enrollment ? Math.round(r.avg_enrollment) : null,
      })),
      by_masking: byMasking.map(r => ({
        design: r.design_val,
        enrollment_type: r.enrollment_type || 'Unknown',
        trial_count: r.trial_count,
        avg_enrollment: r.avg_enrollment ? Math.round(r.avg_enrollment) : null,
      })),
      design_options: { allocations, maskings, models },
    });
  } catch (e) {
    console.error("[enrollment-benchmark] sqlite:", e.message);
    // fall through to PG
  }
  }

  // ── PostgreSQL fallback for enrollment-benchmark ───────────────────────
  const pool = getPgPool();
  if (!pool) return res.status(503).json({ error: "Snapshot missing 'designs' table and no AACT credentials for live fallback. Awaiting nightly refresh." });
  try {
    // Build PG WHERE
    const pgClauses = ["s.enrollment IS NOT NULL", "s.enrollment > 0"];
    const pgParams = [];
    let idx = 1;
    if (condition) { pgClauses.push(`EXISTS (SELECT 1 FROM conditions c WHERE c.nct_id = s.nct_id AND c.name ILIKE $${idx})`); pgParams.push(`%${condition}%`); idx++; }
    if (phase) { pgClauses.push(`s.phase = $${idx}`); pgParams.push(phase); idx++; }
    if (sponsor) { pgClauses.push(`EXISTS (SELECT 1 FROM sponsors sp WHERE sp.nct_id = s.nct_id AND sp.lead_or_collaborator = 'lead' AND sp.name ILIKE $${idx})`); pgParams.push(`%${sponsor}%`); idx++; }
    if (intervention) { pgClauses.push(`EXISTS (SELECT 1 FROM interventions i WHERE i.nct_id = s.nct_id AND i.name ILIKE $${idx})`); pgParams.push(`%${intervention}%`); idx++; }
    const designIdx = idx;
    if (allocation) { pgClauses.push(`d.allocation = $${idx}`); pgParams.push(allocation); idx++; }
    if (masking) { pgClauses.push(`d.masking = $${idx}`); pgParams.push(masking); idx++; }
    if (intervention_model) { pgClauses.push(`d.intervention_model = $${idx}`); pgParams.push(intervention_model); idx++; }
    const pgWhere = pgClauses.length ? `WHERE ${pgClauses.join(" AND ")}` : "";

    const { rows: enrollSummary } = await pool.query(`
      SELECT s.enrollment_type, COUNT(*) AS trial_count,
             ROUND(AVG(s.enrollment::numeric), 0) AS avg_enrollment,
             MIN(s.enrollment) AS min_enrollment, MAX(s.enrollment) AS max_enrollment
      FROM studies s LEFT JOIN designs d ON d.nct_id = s.nct_id
      ${pgWhere}
      GROUP BY s.enrollment_type
    `, pgParams);

    const { rows: byAllocation } = await pool.query(`
      SELECT COALESCE(d.allocation, 'Unknown') AS design_val, s.enrollment_type,
             COUNT(*) AS trial_count, ROUND(AVG(s.enrollment::numeric), 0) AS avg_enrollment
      FROM studies s JOIN designs d ON d.nct_id = s.nct_id
      ${pgWhere}
      GROUP BY d.allocation, s.enrollment_type ORDER BY trial_count DESC
    `, pgParams);

    const { rows: byMasking } = await pool.query(`
      SELECT COALESCE(d.masking, 'Unknown') AS design_val, s.enrollment_type,
             COUNT(*) AS trial_count, ROUND(AVG(s.enrollment::numeric), 0) AS avg_enrollment
      FROM studies s JOIN designs d ON d.nct_id = s.nct_id
      ${pgWhere}
      GROUP BY d.masking, s.enrollment_type ORDER BY trial_count DESC
    `, pgParams);

    const { rows: rawAllocations } = await pool.query(`SELECT DISTINCT d.allocation AS val FROM designs d JOIN studies s ON s.nct_id = d.nct_id ${pgWhere} ORDER BY val`, pgParams);
    const { rows: rawMaskings } = await pool.query(`SELECT DISTINCT d.masking AS val FROM designs d JOIN studies s ON s.nct_id = d.nct_id ${pgWhere} ORDER BY val`, pgParams);
    const { rows: rawModels } = await pool.query(`SELECT DISTINCT d.intervention_model AS val FROM designs d JOIN studies s ON s.nct_id = d.nct_id ${pgWhere} ORDER BY val`, pgParams);

    return res.json({
      summary: enrollSummary.map(r => ({ enrollment_type: r.enrollment_type || 'Unknown', trial_count: parseInt(r.trial_count), avg_enrollment: r.avg_enrollment ? Math.round(parseFloat(r.avg_enrollment)) : null, min_enrollment: parseInt(r.min_enrollment), max_enrollment: parseInt(r.max_enrollment) })),
      by_allocation: byAllocation.map(r => ({ design: r.design_val, enrollment_type: r.enrollment_type || 'Unknown', trial_count: parseInt(r.trial_count), avg_enrollment: r.avg_enrollment ? Math.round(parseFloat(r.avg_enrollment)) : null })),
      by_masking: byMasking.map(r => ({ design: r.design_val, enrollment_type: r.enrollment_type || 'Unknown', trial_count: parseInt(r.trial_count), avg_enrollment: r.avg_enrollment ? Math.round(parseFloat(r.avg_enrollment)) : null })),
      design_options: { allocations: rawAllocations.map(r => r.val).filter(Boolean), maskings: rawMaskings.map(r => r.val).filter(Boolean), models: rawModels.map(r => r.val).filter(Boolean) },
      source: "live",
    });
  } catch (e) {
    console.error("[enrollment-benchmark] pg:", e.message);
    return res.status(500).json({ error: "Query failed", detail: e.message });
  }
});

// ── Geographic Intelligence ──────────────────────────────────────────────
app.get("/api/geographic-intelligence", async (req, res) => {
  const { condition = "", phase = "", sponsor = "", intervention = "", country = "" } = req.query;

  // Helper: region mapping (shared between SQLite and PG paths)
  const REGION_CASE = `
    CASE
      WHEN ctry.name IN ('United States','Canada') THEN 'North America'
      WHEN ctry.name IN ('United Kingdom','Germany','France','Italy','Spain','Netherlands','Belgium','Switzerland','Austria','Sweden','Denmark','Norway','Finland','Poland','Czech Republic','Ireland') THEN 'Europe'
      WHEN ctry.name IN ('China','Japan','South Korea','India','Taiwan','Australia','Thailand','Malaysia','Singapore','Hong Kong','New Zealand') THEN 'Asia-Pacific'
      WHEN ctry.name IN ('Brazil','Argentina','Mexico','Colombia','Chile','Peru') THEN 'Latin America'
      WHEN ctry.name IN ('Israel','Turkey','Saudi Arabia','Egypt','South Africa','Iran') THEN 'Middle East & Africa'
      ELSE 'Other'
    END`;

  // ── SQLite path ──
  const hasCountries = db?.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='countries'").get();
  const hasFacilities = db?.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='facilities'").get();
  if (db && hasCountries) {
  try {
    const { where, params } = buildSqliteWhere({ condition, phase, sponsor, intervention });

    // Add country filter: use IN subquery (much faster than correlated EXISTS on large tables)
    let countryWhere = where;
    const countryParams = [...params];
    if (country) {
      const countryClause = `s.nct_id IN (SELECT nct_id FROM countries WHERE name = ?)`;
      countryWhere = where ? `${where} AND ${countryClause}` : `WHERE ${countryClause}`;
      countryParams.push(country);
    }

    // ── Fast path: country-only filter with no other filters ──────────────
    // Avoid expensive studies JOINs by querying countries table directly.
    let byCountry, usInternational, countryStatus;
    if (country && !where) {
      byCountry = db.prepare(`
        SELECT c2.name AS country, COUNT(DISTINCT c2.nct_id) AS trial_count
        FROM countries c2
        WHERE c2.nct_id IN (SELECT nct_id FROM countries WHERE name = ?)
        GROUP BY c2.name ORDER BY trial_count DESC
      `).all(country);

      const usCount = db.prepare(
        `SELECT COUNT(DISTINCT nct_id) AS c FROM countries WHERE name = 'United States'`
      ).get();
      const inCountry = db.prepare(
        `SELECT COUNT(DISTINCT nct_id) AS c FROM countries WHERE name = ?`
      ).get(country);
      usInternational = {
        us_trials: usCount?.c || 0,
        intl_trials: Math.max(0, (inCountry?.c || 0) - (usCount?.c || 0)),
        total_trials: inCountry?.c || 0,
      };
      countryStatus = []; // skipped — too expensive without index on status+country
    } else {
      byCountry = db.prepare(`
        SELECT ctry.name AS country, COUNT(DISTINCT ctry.nct_id) AS trial_count
        FROM countries ctry JOIN studies s ON s.nct_id = ctry.nct_id ${countryWhere}
        GROUP BY ctry.name ORDER BY trial_count DESC
      `).all(...countryParams);

      usInternational = db.prepare(`
        SELECT SUM(CASE WHEN ctry.name = 'United States' THEN 1 ELSE 0 END) AS us_trials,
               SUM(CASE WHEN ctry.name <> 'United States' THEN 1 ELSE 0 END) AS intl_trials,
               COUNT(DISTINCT ctry.nct_id) AS total_trials
        FROM countries ctry JOIN studies s ON s.nct_id = ctry.nct_id ${countryWhere}
      `).get(...countryParams);

      countryStatus = db.prepare(`
        SELECT ctry.name AS country, s.overall_status AS status, COUNT(DISTINCT ctry.nct_id) AS count
        FROM countries ctry JOIN studies s ON s.nct_id = ctry.nct_id ${countryWhere}
        GROUP BY ctry.name, s.overall_status ORDER BY count DESC
      `).all(...countryParams);
    }

    const topCountries = byCountry.slice(0, 25).map(c => c.country);
    const statusByCountry = {};
    for (const row of countryStatus) {
      if (!topCountries.includes(row.country)) continue;
      if (!statusByCountry[row.country]) statusByCountry[row.country] = {};
      statusByCountry[row.country][row.status] = row.count;
    }

    let topSites = [];
    let byCityInCountry = [];
    if (hasFacilities) {
      // Fast path when only country filter (no condition/phase/etc.) — skip studies JOIN
      if (country && !where) {
        topSites = db.prepare(`
          SELECT f.name AS site_name, f.city, f.state, f.country, COUNT(DISTINCT f.nct_id) AS trial_count,
                 f.latitude AS lat, f.longitude AS lng
          FROM facilities f
          WHERE f.name IS NOT NULL AND f.name <> '' AND f.country = ?
          GROUP BY f.name, f.city, f.country ORDER BY trial_count DESC LIMIT 30
        `).all(country);

        byCityInCountry = db.prepare(`
          SELECT f.city, f.state, COUNT(DISTINCT f.nct_id) AS trial_count,
                 ROUND(AVG(f.latitude), 4) AS lat, ROUND(AVG(f.longitude), 4) AS lng
          FROM facilities f
          WHERE f.country = ? AND f.city IS NOT NULL AND f.city <> ''
          GROUP BY f.city, f.state ORDER BY trial_count DESC LIMIT 50
        `).all(country);
      } else {
        const siteCountryFilter = country ? ` AND f.country = ?` : "";
        const siteParams = [...(where ? params : []), ...(country ? [country] : [])];
        topSites = db.prepare(`
          SELECT f.name AS site_name, f.city, f.state, f.country, COUNT(DISTINCT f.nct_id) AS trial_count,
                 f.latitude AS lat, f.longitude AS lng
          FROM facilities f JOIN studies s ON s.nct_id = f.nct_id
          ${where ? where + " AND" : "WHERE"} f.name IS NOT NULL AND f.name <> ''${siteCountryFilter}
          GROUP BY f.name, f.city, f.country ORDER BY trial_count DESC LIMIT 30
        `).all(...siteParams);

        if (country) {
          byCityInCountry = db.prepare(`
            SELECT f.city, f.state, COUNT(DISTINCT f.nct_id) AS trial_count,
                   ROUND(AVG(f.latitude), 4) AS lat, ROUND(AVG(f.longitude), 4) AS lng
            FROM facilities f JOIN studies s ON s.nct_id = f.nct_id
            ${where} AND f.country = ? AND f.city IS NOT NULL AND f.city <> ''
            GROUP BY f.city, f.state ORDER BY trial_count DESC LIMIT 50
          `).all(...params, country);
        }
      }
    }

    const regionCounts = (country && !where) ? [] : db.prepare(`
      SELECT ${REGION_CASE} AS region,
        COUNT(DISTINCT ctry.nct_id) AS trial_count,
        SUM(CASE WHEN s.overall_status IN ('RECRUITING','ACTIVE_NOT_RECRUITING','ENROLLING_BY_INVITATION','NOT_YET_RECRUITING') THEN 1 ELSE 0 END) AS active_count
      FROM countries ctry JOIN studies s ON s.nct_id = ctry.nct_id ${countryWhere}
      GROUP BY region ORDER BY trial_count DESC
    `).all(...countryParams);

    return res.json({
      by_country: byCountry.slice(0, 50),
      us_international: usInternational,
      status_by_country: Object.entries(statusByCountry).map(([country, statuses]) => ({ country, ...statuses })),
      top_sites: topSites,
      by_region: regionCounts,
      total_countries: byCountry.length,
      ...(byCityInCountry.length ? { by_city: byCityInCountry } : {}),
      ...(country ? { drilled_country: country } : {}),
    });
  } catch (e) {
    console.error("[geographic-intelligence] sqlite:", e.message);
    // fall through to PG
  }
  }

  // ── PostgreSQL fallback ──
  const pool = getPgPool();
  if (!pool) return res.status(503).json({ error: "Snapshot missing countries/facilities tables and no AACT credentials for live fallback. Awaiting nightly refresh." });
  try {
    const pgClauses = [];
    const pgParams = [];
    let idx = 1;
    if (condition) { pgClauses.push(`EXISTS (SELECT 1 FROM conditions c WHERE c.nct_id = s.nct_id AND c.name ILIKE $${idx})`); pgParams.push(`%${condition}%`); idx++; }
    if (phase) { pgClauses.push(`s.phase = $${idx}`); pgParams.push(phase); idx++; }
    if (sponsor) { pgClauses.push(`EXISTS (SELECT 1 FROM sponsors sp WHERE sp.nct_id = s.nct_id AND sp.lead_or_collaborator = 'lead' AND sp.name ILIKE $${idx})`); pgParams.push(`%${sponsor}%`); idx++; }
    if (intervention) { pgClauses.push(`EXISTS (SELECT 1 FROM interventions i WHERE i.nct_id = s.nct_id AND i.name ILIKE $${idx})`); pgParams.push(`%${intervention}%`); idx++; }
    if (country) { pgClauses.push(`s.nct_id IN (SELECT nct_id FROM countries WHERE name = $${idx})`); pgParams.push(country); idx++; }
    const pgWhere = pgClauses.length ? `WHERE ${pgClauses.join(" AND ")}` : "";
    const siteParams = country ? [...pgParams, country] : pgParams;

    // ── Fast path: country-only filter — skip studies JOIN, run queries in parallel ──
    const countryOnly = country && !condition && !phase && !sponsor && !intervention;

    let byCountry, usIntl, topSites, byCityPg = [], regionCounts = [];
    if (countryOnly) {
      const [r1, r2, r3, rSites, rCities] = await Promise.all([
        pool.query(`
          SELECT c2.name AS country, COUNT(DISTINCT c2.nct_id)::int AS trial_count
          FROM countries c2 WHERE c2.nct_id IN (SELECT nct_id FROM countries WHERE name = $1)
          GROUP BY c2.name ORDER BY trial_count DESC LIMIT 50
        `, [country]),
        pool.query(`SELECT COUNT(DISTINCT nct_id)::int AS c FROM countries WHERE name = $1`, [country]),
        pool.query(`SELECT COUNT(DISTINCT nct_id)::int AS c FROM countries WHERE name = 'United States'`),
        pool.query(`
          SELECT f.name AS site_name, f.city, f.state, f.country, COUNT(DISTINCT f.nct_id)::int AS trial_count,
                 ROUND(AVG(f.latitude)::numeric, 4) AS lat, ROUND(AVG(f.longitude)::numeric, 4) AS lng
          FROM facilities f
          WHERE f.name IS NOT NULL AND f.name <> '' AND f.country = $1
          GROUP BY f.name, f.city, f.state, f.country ORDER BY trial_count DESC LIMIT 30
        `, [country]),
        pool.query(`
          SELECT f.city, f.state, COUNT(DISTINCT f.nct_id)::int AS trial_count,
                 ROUND(AVG(f.latitude)::numeric, 4) AS lat, ROUND(AVG(f.longitude)::numeric, 4) AS lng
          FROM facilities f
          WHERE f.country = $1 AND f.city IS NOT NULL AND f.city <> ''
          GROUP BY f.city, f.state ORDER BY trial_count DESC LIMIT 50
        `, [country]),
      ]);
      byCountry = r1.rows;
      const total = r2.rows[0]?.c || 0;
      const usCount = r3.rows[0]?.c || 0;
      usIntl = { us_trials: usCount, intl_trials: Math.max(0, total - usCount), total_trials: total };
      topSites = rSites.rows;
      byCityPg = rCities.rows;
    } else {
      // Non-country-only: run filtered queries with studies JOIN (sequential is fine, less common path)
      const [r1, r2, rSites] = await Promise.all([
        pool.query(`
          SELECT ctry.name AS country, COUNT(DISTINCT ctry.nct_id)::int AS trial_count
          FROM countries ctry JOIN studies s ON s.nct_id = ctry.nct_id ${pgWhere}
          GROUP BY ctry.name ORDER BY trial_count DESC LIMIT 50
        `, pgParams),
        pool.query(`
          SELECT SUM(CASE WHEN ctry.name = 'United States' THEN 1 ELSE 0 END)::int AS us_trials,
                 SUM(CASE WHEN ctry.name <> 'United States' THEN 1 ELSE 0 END)::int AS intl_trials,
                 COUNT(DISTINCT ctry.nct_id)::int AS total_trials
          FROM countries ctry JOIN studies s ON s.nct_id = ctry.nct_id ${pgWhere}
        `, pgParams),
        pool.query(`
          SELECT f.name AS site_name, f.city, f.state, f.country, COUNT(DISTINCT f.nct_id)::int AS trial_count,
                 ROUND(AVG(f.latitude)::numeric, 4) AS lat, ROUND(AVG(f.longitude)::numeric, 4) AS lng
          FROM facilities f JOIN studies s ON s.nct_id = f.nct_id
          ${pgWhere ? pgWhere + " AND" : "WHERE"} f.name IS NOT NULL AND f.name <> ''${country ? ` AND f.country = $${idx}` : ""}
          GROUP BY f.name, f.city, f.state, f.country ORDER BY trial_count DESC LIMIT 30
        `, siteParams),
      ]);
      byCountry = r1.rows;
      usIntl = r2.rows[0];
      topSites = rSites.rows;

      if (country) {
        const cityIdx = idx;
        byCityPg = (await pool.query(`
          SELECT f.city, f.state, COUNT(DISTINCT f.nct_id)::int AS trial_count,
                 ROUND(AVG(f.latitude)::numeric, 4) AS lat, ROUND(AVG(f.longitude)::numeric, 4) AS lng
          FROM facilities f JOIN studies s ON s.nct_id = f.nct_id
          ${pgWhere} AND f.country = $${cityIdx} AND f.city IS NOT NULL AND f.city <> ''
          GROUP BY f.city, f.state ORDER BY trial_count DESC LIMIT 50
        `, siteParams)).rows;
      }

      regionCounts = (await pool.query(`
        SELECT ${REGION_CASE} AS region,
          COUNT(DISTINCT ctry.nct_id)::int AS trial_count,
          SUM(CASE WHEN s.overall_status IN ('Recruiting','Active, not recruiting','Enrolling by invitation','Not yet recruiting') THEN 1 ELSE 0 END)::int AS active_count
        FROM countries ctry JOIN studies s ON s.nct_id = ctry.nct_id ${pgWhere}
        GROUP BY region ORDER BY trial_count DESC
      `, pgParams)).rows;
    }

    return res.json({
      by_country: byCountry,
      us_international: usIntl,
      status_by_country: [],
      top_sites: topSites,
      by_region: regionCounts,
      total_countries: byCountry.length,
      source: "live",
      ...(byCityPg.length ? { by_city: byCityPg } : {}),
      ...(country ? { drilled_country: country } : {}),
    });
  } catch (e) {
    console.error("[geographic-intelligence] pg:", e.message);
    return res.status(500).json({ error: "Query failed", detail: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// /api/ask — unified smart intake. GPT-4.1 classifies intent → dispatches to
// analytics or KG endpoint(s) → returns unified card-based response.
// ══════════════════════════════════════════════════════════════════════════════

const ASK_ROUTER_PROMPT = `You are an intent-classification router for a clinical trials intelligence platform.
Given a user question, classify it into one of these intents and extract entities.

Intents:
- "failure_analysis" — questions about termination/failure rates, why trials fail, stop reasons
- "sponsor_performance" — sponsor completion rates, leaderboard, best/worst sponsors
- "enrollment_benchmark" — enrollment ambition vs actuals, design types, over/under-enrollment
- "geographic" — country distribution, site geography, where trials run, US vs international
- "entity_insight" — questions about a specific sponsor/condition/intervention/phase portfolio
- "trial_lookup" — questions about a specific NCT ID
- "kg_traversal" — questions about what's connected to what, adjacency, repurposing, gaps, shortest paths, networks
- "general_search" — broad search queries that don't fit above

Respond with ONLY valid JSON (no markdown fences):
{
  "intent": "<intent>",
  "entities": {
    "condition": "<string or null>",
    "phase": "<string or null>",
    "sponsor": "<string or null>",
    "intervention": "<string or null>",
    "country": "<string or null>",
    "nct_id": "<string or null>"
  },
  "kg_sub_intent": "<string or null>"  // for kg_traversal: "adjacency", "gaps", "repurposing", "sponsor_network", "condition_landscape", "overlap"
}

Phase normalization: "Phase 1" -> "PHASE1", "Phase 2" -> "PHASE2", "Phase 3" -> "PHASE3", "Phase 4" -> "PHASE4", "Phase 1/2" -> "PHASE1/PHASE2"

Examples:
- "Why do Phase 3 oncology trials fail?" -> {"intent":"failure_analysis","entities":{"condition":"Cancer","phase":"PHASE3"},"kg_sub_intent":null}
- "What conditions are adjacent to Breast Cancer?" -> {"intent":"kg_traversal","entities":{"condition":"Breast Cancer"},"kg_sub_intent":"adjacency"}
- "Which sponsors lead in Alzheimer trials?" -> {"intent":"sponsor_performance","entities":{"condition":"Alzheimer"},"kg_sub_intent":null}
- "Show me NCT00001234" -> {"intent":"trial_lookup","entities":{"nct_id":"NCT00001234"},"kg_sub_intent":null}
- "Where does Pfizer run trials?" -> {"intent":"geographic","entities":{"sponsor":"Pfizer"},"kg_sub_intent":null}
- "What drugs are used in both Crohn's and Ulcerative Colitis?" -> {"intent":"kg_traversal","entities":{"condition":"Crohn"},"kg_sub_intent":"repurposing"}`;

app.post("/api/ask", async (req, res) => {
  const { question } = req.body || {};
  if (!question || typeof question !== "string") return res.status(400).json({ error: "question required" });

  const GITHUB_COPILOT_TOKEN = process.env.GITHUB_COPILOT_TOKEN;
  if (!GITHUB_COPILOT_TOKEN) {
    // Fallback: treat as general search
    return res.json({
      question,
      intent: "general_search",
      source: "fallback",
      entities: {},
      cards: [{ type: "search_suggestion", text: "LLM not configured — use the search bar to query trials directly." }],
    });
  }

  let classification;
  try {
    const llmResp = await fetch("https://models.inference.ai.azure.com/chat/completions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${GITHUB_COPILOT_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4.1",
        max_tokens: 300,
        temperature: 0,
        messages: [
          { role: "system", content: ASK_ROUTER_PROMPT },
          { role: "user", content: question },
        ],
      }),
    });
    if (!llmResp.ok) throw new Error(`LLM ${llmResp.status}`);
    const llmData = await llmResp.json();
    const raw = (llmData.choices?.[0]?.message?.content || "").trim()
      .replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
    classification = JSON.parse(raw);
  } catch (e) {
    console.error("[ask] classification failed:", e.message);
    return res.json({
      question, intent: "general_search", source: "fallback",
      entities: {},
      cards: [{ type: "error", text: `Intent classification failed: ${e.message}` }],
    });
  }

  const { intent, entities = {}, kg_sub_intent } = classification;
  const cards = [];
  let source = "analytics";

  try {
    // ── Analytics intents ──
    if (intent === "failure_analysis") {
      const params = {};
      if (entities.condition) params.condition = entities.condition;
      if (entities.phase) params.phase = entities.phase;
      if (entities.sponsor) params.sponsor = entities.sponsor;
      if (entities.intervention) params.intervention = entities.intervention;
      // Re-use internal route handler logic by making internal HTTP call
      const qs = new URLSearchParams(params).toString();
      const url = `http://localhost:${PORT}/api/failure-analysis?${qs}`;
      const r = await fetch(url); const data = await r.json();
      if (r.ok) {
        cards.push({ type: "kpi", label: "Termination Rate", value: `${data.termination_rate_pct}%`, color: data.termination_rate_pct > 20 ? "red" : "amber" });
        cards.push({ type: "bar_chart", title: "Stop Reasons", data: (data.stop_reasons || []).slice(0, 8) });
        if (data.by_condition?.length) cards.push({ type: "bar_chart", title: "Termination by Condition", data: data.by_condition.slice(0, 8) });
        if (data.by_phase?.length) cards.push({ type: "bar_chart", title: "Termination by Phase", data: data.by_phase.slice(0, 8) });
      }
    } else if (intent === "sponsor_performance") {
      const params = {};
      if (entities.condition) params.condition = entities.condition;
      if (entities.phase) params.phase = entities.phase;
      const qs = new URLSearchParams(params).toString();
      const url = `http://localhost:${PORT}/api/sponsor-performance?${qs}`;
      const r = await fetch(url); const data = await r.json();
      if (r.ok) {
        cards.push({ type: "leaderboard", title: "Sponsor Completion Rate", data: (data.sponsors || []).slice(0, 10) });
      }
    } else if (intent === "enrollment_benchmark") {
      const params = {};
      if (entities.condition) params.condition = entities.condition;
      if (entities.phase) params.phase = entities.phase;
      const qs = new URLSearchParams(params).toString();
      const url = `http://localhost:${PORT}/api/enrollment-benchmark?${qs}`;
      const r = await fetch(url); const data = await r.json();
      if (r.ok) {
        cards.push({ type: "enrollment_summary", data: data.summary || {} });
        if (data.by_allocation?.length) cards.push({ type: "bar_chart", title: "By Allocation", data: data.by_allocation });
      }
    } else if (intent === "geographic") {
      const params = {};
      if (entities.condition) params.condition = entities.condition;
      if (entities.phase) params.phase = entities.phase;
      if (entities.sponsor) params.sponsor = entities.sponsor;
      if (entities.country) params.country = entities.country;
      const qs = new URLSearchParams(params).toString();
      const url = `http://localhost:${PORT}/api/geographic-intelligence?${qs}`;
      const r = await fetch(url); const data = await r.json();
      if (r.ok) {
        cards.push({ type: "geo_summary", data: { total_countries: data.total_countries, us_international: data.us_international } });
        if (data.by_country?.length) cards.push({ type: "country_table", data: data.by_country.slice(0, 15) });
        if (data.by_region?.length) cards.push({ type: "bar_chart", title: "By Region", data: data.by_region });
      }
    } else if (intent === "entity_insight") {
      // Determine entity type
      let type = "condition", name = "";
      if (entities.sponsor) { type = "sponsor"; name = entities.sponsor; }
      else if (entities.condition) { type = "condition"; name = entities.condition; }
      else if (entities.intervention) { type = "intervention"; name = entities.intervention; }
      if (name && db) {
        try {
          const result = queryEntityInsight(type, name);
          if (result && !result.empty) {
            cards.push({ type: "entity_insight", data: result });
          }
        } catch {}
      }
    } else if (intent === "trial_lookup" && entities.nct_id) {
      const url = `http://localhost:${PORT}/api/trial-intelligence?nct_id=${encodeURIComponent(entities.nct_id)}`;
      const r = await fetch(url); const data = await r.json();
      if (r.ok) cards.push({ type: "trial_intelligence", data });
    }

    // ── KG intents ──
    if (intent === "kg_traversal") {
      source = "kg";
      if (neo4j) {
        const session = neo4j.session({ defaultAccessMode: neo4jDriver.session.READ });
        try {
          if (kg_sub_intent === "adjacency" && entities.condition) {
            const result = await session.run(
              `MATCH (c1:Condition {name: $condition})<-[:TREATS]-(t:Trial)-[:USES]->(i:Intervention)<-[:USES]-(t2:Trial)-[:TREATS]->(c2:Condition)
               WHERE c1 <> c2
               WITH c2.name AS condition, COUNT(DISTINCT i) AS shared_interventions, COLLECT(DISTINCT i.name)[0..3] AS example_drugs
               RETURN condition, shared_interventions, example_drugs
               ORDER BY shared_interventions DESC LIMIT 15`,
              { condition: entities.condition }
            );
            const rows = result.records.map(r => ({
              condition: r.get("condition"),
              shared_interventions: r.get("shared_interventions").toNumber ? r.get("shared_interventions").toNumber() : r.get("shared_interventions"),
              example_drugs: r.get("example_drugs"),
            }));
            cards.push({ type: "kg_adjacency", title: `Conditions adjacent to ${entities.condition}`, data: rows });
          } else if (kg_sub_intent === "gaps" && entities.sponsor) {
            const result = await session.run(
              `MATCH (s:Sponsor {name: $sponsor})-[:RUNS]->(t:Trial)-[:TREATS]->(c:Condition)
               WITH s, COLLECT(DISTINCT c.name) AS myConditions
               MATCH (c2:Condition)<-[:TREATS]-(t2:Trial)<-[:RUNS]-(s2:Sponsor)
               WHERE NOT c2.name IN myConditions AND s2.name <> s.name
               WITH c2.name AS gap_condition, COUNT(DISTINCT s2) AS competitor_count, COUNT(DISTINCT t2) AS trial_count
               RETURN gap_condition, competitor_count, trial_count
               ORDER BY trial_count DESC LIMIT 15`,
              { sponsor: entities.sponsor }
            );
            const rows = result.records.map(r => ({
              gap_condition: r.get("gap_condition"),
              competitor_count: typeof r.get("competitor_count").toNumber === "function" ? r.get("competitor_count").toNumber() : r.get("competitor_count"),
              trial_count: typeof r.get("trial_count").toNumber === "function" ? r.get("trial_count").toNumber() : r.get("trial_count"),
            }));
            cards.push({ type: "kg_gaps", title: `Strategic gaps for ${entities.sponsor}`, data: rows });
          } else if (kg_sub_intent === "sponsor_network" && entities.sponsor) {
            const result = await session.run(
              `MATCH (s:Sponsor {name: $sponsor})-[:RUNS]->(t:Trial)-[:TREATS]->(c:Condition)
               WITH s, c, COUNT(t) AS trials
               RETURN c.name AS condition, trials ORDER BY trials DESC LIMIT 15`,
              { sponsor: entities.sponsor }
            );
            const rows = result.records.map(r => ({
              condition: r.get("condition"),
              trials: typeof r.get("trials").toNumber === "function" ? r.get("trials").toNumber() : r.get("trials"),
            }));
            cards.push({ type: "kg_network", title: `${entities.sponsor}'s therapeutic footprint`, data: rows });
          } else if (kg_sub_intent === "condition_landscape" && entities.condition) {
            const result = await session.run(
              `MATCH (c:Condition {name: $condition})<-[:TREATS]-(t:Trial)<-[:RUNS]-(s:Sponsor)
               WITH s.name AS sponsor, COUNT(t) AS trials
               RETURN sponsor, trials ORDER BY trials DESC LIMIT 15`,
              { condition: entities.condition }
            );
            const rows = result.records.map(r => ({
              sponsor: r.get("sponsor"),
              trials: typeof r.get("trials").toNumber === "function" ? r.get("trials").toNumber() : r.get("trials"),
            }));
            cards.push({ type: "kg_landscape", title: `Sponsors in ${entities.condition}`, data: rows });
          }
        } finally {
          await session.close();
        }
      }
    }

    // ── Generate narrative briefing if we have data ──
    if (cards.length > 0 && GITHUB_COPILOT_TOKEN) {
      try {
        const cardSummary = cards.map(c => {
          if (c.type === "kpi") return `${c.label}: ${c.value}`;
          if (c.type === "bar_chart") return `${c.title}: ${JSON.stringify(c.data?.slice(0, 5))}`;
          if (c.type === "leaderboard") return `${c.title}: ${JSON.stringify(c.data?.slice(0, 5))}`;
          if (c.type === "entity_insight") return `Entity insight: ${JSON.stringify(c.data).slice(0, 500)}`;
          return `${c.type}: ${JSON.stringify(c.data).slice(0, 300)}`;
        }).join("\n");

        const briefResp = await fetch("https://models.inference.ai.azure.com/chat/completions", {
          method: "POST",
          headers: { "Authorization": `Bearer ${GITHUB_COPILOT_TOKEN}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "gpt-4.1",
            max_tokens: 250,
            temperature: 0.3,
            messages: [
              { role: "system", content: "You are a clinical trials analyst. Given the user's question and data results, write a 2-3 sentence plain-English insight summary. Be specific and operational. No hedging." },
              { role: "user", content: `Question: "${question}"\n\nData:\n${cardSummary}` },
            ],
          }),
        });
        if (briefResp.ok) {
          const briefData = await briefResp.json();
          const briefing = briefData.choices?.[0]?.message?.content?.trim();
          if (briefing) cards.unshift({ type: "briefing", text: briefing });
        }
      } catch (e) {
        console.error("[ask] briefing generation failed:", e.message);
      }
    }

    // If no cards from intent dispatch, fall back to general search context
    if (cards.length === 0) {
      cards.push({ type: "search_suggestion", text: "No specific data matched — try using the search bar or charts to explore." });
    }

    // Add filter suggestion card so the UI can auto-apply filters
    const filters = {};
    if (entities.condition) filters.condition = entities.condition;
    if (entities.phase) filters.phase = entities.phase;
    if (entities.sponsor) filters.sponsor = entities.sponsor;
    if (entities.intervention) filters.intervention = entities.intervention;
    if (entities.country) filters.country = entities.country;
    if (Object.keys(filters).length) {
      cards.push({ type: "filters", data: filters });
    }

    return res.json({
      question,
      intent,
      source: intent === "kg_traversal" ? "kg" : cards.some(c => c.type?.startsWith("kg_")) ? "hybrid" : "analytics",
      entities,
      cards,
    });
  } catch (e) {
    console.error("[ask] dispatch failed:", e.message);
    return res.json({
      question, intent, source: "error",
      entities,
      cards: [{ type: "error", text: `Failed to process: ${e.message}` }],
    });
  }
});

app.listen(parseInt(PORT), () => {
  console.log(`[server] listening on :${PORT} — backend: ${db ? `sqlite (${snapshotAge})` : "postgres fallback"}`);
});
