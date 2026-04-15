#!/usr/bin/env node
/**
 * snapshot.js — Pull the 5 AACT tables we need from PostgreSQL and write
 * them into a local SQLite database at /data/aact.db.
 *
 * Run manually:  node snapshot.js
 * Or via CronJob: scheduled nightly in k8s/cronjob.yaml
 *
 * Required env vars (same as the Vercel API):
 *   AACT_USER, AACT_PASSWORD
 * Optional:
 *   AACT_HOST   (default: aact-db.ctti-clinicaltrials.org)
 *   AACT_PORT   (default: 5432)
 *   DB_PATH     (default: /data/aact.db)
 */

import pg from "pg";
import Database from "better-sqlite3";
import { mkdirSync } from "fs";
import { dirname } from "path";

const {
  AACT_HOST = "aact-db.ctti-clinicaltrials.org",
  AACT_PORT = "5432",
  AACT_USER,
  AACT_PASSWORD,
  DB_PATH = "/data/aact.db",
} = process.env;

if (!AACT_USER || !AACT_PASSWORD) {
  console.error("AACT_USER and AACT_PASSWORD env vars are required");
  process.exit(1);
}

const BATCH = 5000; // rows per SELECT ... LIMIT/OFFSET batch

// ── helpers ──────────────────────────────────────────────────────────────────

function elapsed(start) {
  return ((Date.now() - start) / 1000).toFixed(1) + "s";
}

/** Stream a full table in BATCH-sized LIMIT/OFFSET pages */
async function* streamTable(pool, sql, countSql) {
  if (countSql) {
    const { rows } = await pool.query(countSql);
    const total = parseInt(rows[0].count);
    console.log(`  (${total.toLocaleString()} rows total)`);
  }
  let offset = 0;
  while (true) {
    const { rows } = await pool.query(`${sql} LIMIT ${BATCH} OFFSET ${offset}`);
    if (rows.length === 0) break;
    yield rows;
    offset += rows.length;
    if (rows.length < BATCH) break;
  }
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  const t0 = Date.now();
  console.log(`[snapshot] starting — target: ${DB_PATH}`);

  // Ensure output directory exists
  mkdirSync(dirname(DB_PATH), { recursive: true });

  // Connect to AACT
  const pool = new pg.Pool({
    host: AACT_HOST,
    port: parseInt(AACT_PORT),
    database: "aact",
    user: AACT_USER.trim(),
    password: AACT_PASSWORD.trim(),
    ssl: { rejectUnauthorized: false },
    max: 4,
    connectionTimeoutMillis: 30000,
    statement_timeout: 600000, // 10 min for large tables
  });
  // quick connectivity check
  await pool.query("SELECT 1");
  console.log(`[snapshot] connected to AACT in ${elapsed(t0)}`);

  // Write to a temp file, then rename — so the running server sees an atomic swap
  const TMP_PATH = DB_PATH + ".tmp";
  const db = new Database(TMP_PATH);

  // WAL mode + big cache for fast bulk inserts
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("cache_size = -64000"); // 64 MB

  // ── Schema ─────────────────────────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS studies (
      nct_id TEXT PRIMARY KEY,
      brief_title TEXT,
      overall_status TEXT,
      phase TEXT,
      study_type TEXT,
      enrollment INTEGER,
      enrollment_type TEXT,
      start_date TEXT,
      completion_date TEXT,
      primary_completion_date TEXT,
      has_dmc INTEGER,
      why_stopped TEXT,
      status_order INTEGER GENERATED ALWAYS AS (
        CASE overall_status
          WHEN 'RECRUITING' THEN 0
          WHEN 'ACTIVE_NOT_RECRUITING' THEN 1
          WHEN 'COMPLETED' THEN 2
          ELSE 3
        END
      ) VIRTUAL
    );

    CREATE TABLE IF NOT EXISTS conditions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nct_id TEXT NOT NULL,
      name TEXT
    );

    CREATE TABLE IF NOT EXISTS interventions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nct_id TEXT NOT NULL,
      intervention_type TEXT,
      name TEXT
    );

    CREATE TABLE IF NOT EXISTS sponsors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nct_id TEXT NOT NULL,
      name TEXT,
      lead_or_collaborator TEXT
    );

    CREATE TABLE IF NOT EXISTS brief_summaries (
      nct_id TEXT PRIMARY KEY,
      description TEXT
    );

    -- Search index table (FTS5 for keyword search)
    CREATE VIRTUAL TABLE IF NOT EXISTS studies_fts USING fts5(
      nct_id UNINDEXED,
      brief_title,
      conditions_text,
      interventions_text,
      summary_text
    );

    -- Metadata
    CREATE TABLE IF NOT EXISTS _meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  // ── Ingest tables ───────────────────────────────────────────────────────────

  async function ingest(label, sql, countSql, insertFn) {
    const t = Date.now();
    console.log(`[snapshot] ingesting ${label}…`);
    let total = 0;
    const insertMany = db.transaction(insertFn);
    for await (const batch of streamTable(pool, sql, countSql)) {
      insertMany(batch);
      total += batch.length;
      process.stdout.write(`\r  ${total.toLocaleString()} rows`);
    }
    console.log(`\r  ${total.toLocaleString()} rows — done in ${elapsed(t)}`);
    return total;
  }

  // studies
  const insStudy = db.prepare(`
    INSERT OR REPLACE INTO studies
      (nct_id, brief_title, overall_status, phase, study_type,
       enrollment, enrollment_type, start_date, completion_date,
       primary_completion_date, has_dmc, why_stopped)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  await ingest("studies",
    `SELECT nct_id, brief_title, overall_status, phase, study_type,
            enrollment, enrollment_type, start_date::text, completion_date::text,
            primary_completion_date::text, has_dmc, why_stopped
     FROM studies ORDER BY nct_id`,
    `SELECT COUNT(*) AS count FROM studies`,
    (rows) => { for (const r of rows) insStudy.run(r.nct_id, r.brief_title, r.overall_status, r.phase, r.study_type, r.enrollment ? parseInt(r.enrollment) : null, r.enrollment_type, r.start_date, r.completion_date, r.primary_completion_date, r.has_dmc ? 1 : 0, r.why_stopped); }
  );

  // conditions (keep distinct)
  const insCond = db.prepare(`INSERT INTO conditions (nct_id, name) VALUES (?,?)`);
  await ingest("conditions",
    `SELECT DISTINCT nct_id, name FROM conditions WHERE name IS NOT NULL ORDER BY nct_id`,
    `SELECT COUNT(*) AS count FROM (SELECT DISTINCT nct_id, name FROM conditions WHERE name IS NOT NULL) t`,
    (rows) => { for (const r of rows) insCond.run(r.nct_id, r.name); }
  );

  // interventions
  const insIntv = db.prepare(`INSERT INTO interventions (nct_id, intervention_type, name) VALUES (?,?,?)`);
  await ingest("interventions",
    `SELECT DISTINCT nct_id, intervention_type, name FROM interventions WHERE name IS NOT NULL ORDER BY nct_id`,
    `SELECT COUNT(*) AS count FROM (SELECT DISTINCT nct_id, name FROM interventions WHERE name IS NOT NULL) t`,
    (rows) => { for (const r of rows) insIntv.run(r.nct_id, r.intervention_type, r.name); }
  );

  // sponsors (lead only)
  const insSponsor = db.prepare(`INSERT INTO sponsors (nct_id, name, lead_or_collaborator) VALUES (?,?,?)`);
  await ingest("sponsors",
    `SELECT nct_id, name, lead_or_collaborator FROM sponsors
     WHERE lead_or_collaborator = 'lead' AND name IS NOT NULL ORDER BY nct_id`,
    `SELECT COUNT(*) AS count FROM sponsors WHERE lead_or_collaborator = 'lead' AND name IS NOT NULL`,
    (rows) => { for (const r of rows) insSponsor.run(r.nct_id, r.name, r.lead_or_collaborator); }
  );

  // brief_summaries
  const insSummary = db.prepare(`INSERT OR REPLACE INTO brief_summaries (nct_id, description) VALUES (?,?)`);
  await ingest("brief_summaries",
    `SELECT nct_id, description FROM brief_summaries WHERE description IS NOT NULL ORDER BY nct_id`,
    `SELECT COUNT(*) AS count FROM brief_summaries WHERE description IS NOT NULL`,
    (rows) => { for (const r of rows) insSummary.run(r.nct_id, r.description); }
  );

  // ── Build secondary indexes ─────────────────────────────────────────────────
  console.log("[snapshot] building indexes…");
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_cond_nct ON conditions(nct_id);
    CREATE INDEX IF NOT EXISTS idx_intv_nct ON interventions(nct_id);
    CREATE INDEX IF NOT EXISTS idx_sponsor_nct ON sponsors(nct_id);
    CREATE INDEX IF NOT EXISTS idx_studies_status ON studies(overall_status);
    CREATE INDEX IF NOT EXISTS idx_studies_phase ON studies(phase);
  `);

  // ── Populate FTS ────────────────────────────────────────────────────────────
  console.log("[snapshot] building FTS index…");
  db.exec(`
    INSERT INTO studies_fts (nct_id, brief_title, conditions_text, interventions_text, summary_text)
    SELECT
      s.nct_id,
      COALESCE(s.brief_title, ''),
      COALESCE((SELECT group_concat(name, ' ') FROM conditions WHERE nct_id = s.nct_id), ''),
      COALESCE((SELECT group_concat(name, ' ') FROM interventions WHERE nct_id = s.nct_id), ''),
      COALESCE(bs.description, '')
    FROM studies s
    LEFT JOIN brief_summaries bs ON bs.nct_id = s.nct_id;
  `);

  // ── Write metadata ──────────────────────────────────────────────────────────
  const metaIns = db.prepare(`INSERT OR REPLACE INTO _meta (key, value) VALUES (?, ?)`);
  metaIns.run("snapshot_time", new Date().toISOString());
  metaIns.run("aact_host", AACT_HOST);

  db.close();
  await pool.end();

  // Atomic swap
  const { renameSync } = await import("fs");
  renameSync(TMP_PATH, DB_PATH);

  console.log(`[snapshot] complete — total time ${elapsed(t0)}`);
  console.log(`[snapshot] database written to ${DB_PATH}`);
}

main().catch((err) => {
  console.error("[snapshot] FAILED:", err.message);
  process.exit(1);
});
