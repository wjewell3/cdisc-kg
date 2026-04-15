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
function buildSqliteWhere({ q = "", condition = "", intervention = "", phase = "", status = "", sponsor = "" }) {
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

  return { where: where.length ? `WHERE ${where.join(" AND ")}` : "", params };
}

// ── SQLite query functions ─────────────────────────────────────────────────────

function sqliteSearch({ q, condition, intervention, phase, status, sponsor, limit }) {
  const { where, params } = buildSqliteWhere({ q, condition, intervention, phase, status, sponsor });

  const sql = `
    SELECT
      s.nct_id, s.brief_title, s.overall_status, s.phase, s.study_type,
      s.enrollment, s.enrollment_type, s.start_date, s.completion_date,
      s.has_dmc, s.why_stopped,
      (SELECT group_concat(DISTINCT c.name, '; ') FROM (SELECT DISTINCT name FROM conditions WHERE nct_id = s.nct_id LIMIT 5) c) AS conditions,
      (SELECT group_concat(DISTINCT i.intervention_type || ': ' || i.name, '; ') FROM (SELECT DISTINCT intervention_type, name FROM interventions WHERE nct_id = s.nct_id LIMIT 5) i) AS interventions,
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

function sqliteStats({ q, condition, intervention, phase, status, sponsor }) {
  const { where, params } = buildSqliteWhere({ q, condition, intervention, phase, status, sponsor });
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
  } = req.query;

  const limit = Math.min(parseInt(rawLimit, 10) || 100, 500);

  try {
    if (mode === "stats") {
      const result = db
        ? sqliteStats({ q, condition, intervention, phase, status, sponsor })
        : await pgStats({ q, condition, intervention, phase, status, sponsor });
      return res.json(result);
    }

    const result = db
      ? sqliteSearch({ q, condition, intervention, phase, status, sponsor, limit })
      : await pgSearch({ q, condition, intervention, phase, status, sponsor, limit });
    return res.json(result);
  } catch (err) {
    console.error("[server] query error:", err.message);
    return res.status(500).json({ error: "Query failed", detail: err.message });
  }
});

app.listen(parseInt(PORT), () => {
  console.log(`[server] listening on :${PORT} — backend: ${db ? `sqlite (${snapshotAge})` : "postgres fallback"}`);
});
