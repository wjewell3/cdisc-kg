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

    -- ── Operational / KG tables ──────────────────────────────────────────────

    CREATE TABLE IF NOT EXISTS calculated_values (
      nct_id TEXT PRIMARY KEY,
      number_of_facilities INTEGER,
      actual_duration INTEGER,
      were_results_reported INTEGER,
      months_to_report_results INTEGER,
      has_us_facility INTEGER,
      has_single_facility INTEGER,
      number_of_sae_subjects INTEGER,
      number_of_nsae_subjects INTEGER,
      minimum_age_num REAL,
      maximum_age_num REAL,
      number_of_primary_outcomes_to_measure INTEGER,
      number_of_secondary_outcomes_to_measure INTEGER
    );

    CREATE TABLE IF NOT EXISTS facilities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nct_id TEXT NOT NULL,
      status TEXT,
      name TEXT,
      city TEXT,
      state TEXT,
      country TEXT,
      latitude REAL,
      longitude REAL
    );

    CREATE TABLE IF NOT EXISTS designs (
      nct_id TEXT PRIMARY KEY,
      allocation TEXT,
      intervention_model TEXT,
      observational_model TEXT,
      primary_purpose TEXT,
      time_perspective TEXT,
      masking TEXT
    );

    CREATE TABLE IF NOT EXISTS drop_withdrawals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nct_id TEXT NOT NULL,
      period TEXT,
      reason TEXT,
      count INTEGER
    );

    CREATE TABLE IF NOT EXISTS countries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nct_id TEXT NOT NULL,
      name TEXT,
      removed INTEGER
    );

    CREATE TABLE IF NOT EXISTS eligibilities (
      nct_id TEXT PRIMARY KEY,
      gender TEXT,
      minimum_age TEXT,
      maximum_age TEXT,
      healthy_volunteers TEXT,
      criteria TEXT,
      adult INTEGER,
      child INTEGER,
      older_adult INTEGER
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

  // ── Operational / KG tables ─────────────────────────────────────────────────

  // calculated_values (pre-computed operational metrics)
  const insCalc = db.prepare(`INSERT OR REPLACE INTO calculated_values
    (nct_id, number_of_facilities, actual_duration, were_results_reported,
     months_to_report_results, has_us_facility, has_single_facility,
     number_of_sae_subjects, number_of_nsae_subjects,
     minimum_age_num, maximum_age_num,
     number_of_primary_outcomes_to_measure, number_of_secondary_outcomes_to_measure)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  await ingest("calculated_values",
    `SELECT nct_id, number_of_facilities, actual_duration, were_results_reported,
            months_to_report_results, has_us_facility, has_single_facility,
            number_of_sae_subjects, number_of_nsae_subjects,
            minimum_age_num, maximum_age_num,
            number_of_primary_outcomes_to_measure, number_of_secondary_outcomes_to_measure
     FROM calculated_values ORDER BY nct_id`,
    `SELECT COUNT(*) AS count FROM calculated_values`,
    (rows) => { for (const r of rows) insCalc.run(
      r.nct_id, r.number_of_facilities, r.actual_duration,
      r.were_results_reported ? 1 : 0, r.months_to_report_results,
      r.has_us_facility ? 1 : 0, r.has_single_facility ? 1 : 0,
      r.number_of_sae_subjects, r.number_of_nsae_subjects,
      r.minimum_age_num, r.maximum_age_num,
      r.number_of_primary_outcomes_to_measure, r.number_of_secondary_outcomes_to_measure
    ); }
  );

  // facilities (3.4M — site-level data for site intelligence)
  const insFac = db.prepare(`INSERT INTO facilities (nct_id, status, name, city, state, country, latitude, longitude) VALUES (?,?,?,?,?,?,?,?)`);
  await ingest("facilities",
    `SELECT nct_id, status, name, city, state, country, latitude::float, longitude::float
     FROM facilities WHERE name IS NOT NULL ORDER BY nct_id`,
    `SELECT COUNT(*) AS count FROM facilities WHERE name IS NOT NULL`,
    (rows) => { for (const r of rows) insFac.run(r.nct_id, r.status, r.name, r.city, r.state, r.country, r.latitude, r.longitude); }
  );

  // designs
  const insDes = db.prepare(`INSERT OR REPLACE INTO designs
    (nct_id, allocation, intervention_model, observational_model, primary_purpose, time_perspective, masking)
    VALUES (?,?,?,?,?,?,?)`);
  await ingest("designs",
    `SELECT nct_id, allocation, intervention_model, observational_model, primary_purpose, time_perspective, masking
     FROM designs ORDER BY nct_id`,
    `SELECT COUNT(*) AS count FROM designs`,
    (rows) => { for (const r of rows) insDes.run(r.nct_id, r.allocation, r.intervention_model, r.observational_model, r.primary_purpose, r.time_perspective, r.masking); }
  );

  // drop_withdrawals (only rows with count > 0)
  const insDrop = db.prepare(`INSERT INTO drop_withdrawals (nct_id, period, reason, count) VALUES (?,?,?,?)`);
  await ingest("drop_withdrawals",
    `SELECT nct_id, period, reason, count FROM drop_withdrawals WHERE count > 0 ORDER BY nct_id`,
    `SELECT COUNT(*) AS count FROM drop_withdrawals WHERE count > 0`,
    (rows) => { for (const r of rows) insDrop.run(r.nct_id, r.period, r.reason, parseInt(r.count)); }
  );

  // countries
  const insCountry = db.prepare(`INSERT INTO countries (nct_id, name, removed) VALUES (?,?,?)`);
  await ingest("countries",
    `SELECT nct_id, name, removed FROM countries WHERE name IS NOT NULL ORDER BY nct_id`,
    `SELECT COUNT(*) AS count FROM countries WHERE name IS NOT NULL`,
    (rows) => { for (const r of rows) insCountry.run(r.nct_id, r.name, r.removed ? 1 : 0); }
  );

  // eligibilities
  const insElig = db.prepare(`INSERT OR REPLACE INTO eligibilities
    (nct_id, gender, minimum_age, maximum_age, healthy_volunteers, criteria, adult, child, older_adult)
    VALUES (?,?,?,?,?,?,?,?,?)`);
  await ingest("eligibilities",
    `SELECT nct_id, gender, minimum_age, maximum_age, healthy_volunteers, criteria, adult, child, older_adult
     FROM eligibilities ORDER BY nct_id`,
    `SELECT COUNT(*) AS count FROM eligibilities`,
    (rows) => { for (const r of rows) insElig.run(
      r.nct_id, r.gender, r.minimum_age, r.maximum_age, r.healthy_volunteers,
      r.criteria, r.adult ? 1 : 0, r.child ? 1 : 0, r.older_adult ? 1 : 0
    ); }
  );

  // ── Build secondary indexes ─────────────────────────────────────────────────
  console.log("[snapshot] building indexes…");
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_cond_nct ON conditions(nct_id);
    CREATE INDEX IF NOT EXISTS idx_intv_nct ON interventions(nct_id);
    CREATE INDEX IF NOT EXISTS idx_sponsor_nct ON sponsors(nct_id);
    CREATE INDEX IF NOT EXISTS idx_studies_status ON studies(overall_status);
    CREATE INDEX IF NOT EXISTS idx_studies_phase ON studies(phase);
    CREATE INDEX IF NOT EXISTS idx_fac_nct ON facilities(nct_id);
    CREATE INDEX IF NOT EXISTS idx_fac_name ON facilities(name);
    CREATE INDEX IF NOT EXISTS idx_fac_country ON facilities(country);
    CREATE INDEX IF NOT EXISTS idx_drop_nct ON drop_withdrawals(nct_id);
    CREATE INDEX IF NOT EXISTS idx_countries_nct ON countries(nct_id);
    CREATE INDEX IF NOT EXISTS idx_cv_duration ON calculated_values(actual_duration);
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

  // Atomic swap — remove any stale WAL/SHM files first so SQLite doesn't try
  // to apply them to the new database and cause "disk image is malformed".
  const { renameSync, rmSync } = await import("fs");
  for (const suffix of ["-wal", "-shm"]) {
    try { rmSync(DB_PATH + suffix); } catch { /* ignore if absent */ }
  }
  renameSync(TMP_PATH, DB_PATH);

  console.log(`[snapshot] complete — total time ${elapsed(t0)}`);
  console.log(`[snapshot] database written to ${DB_PATH}`);
}

main().catch((err) => {
  console.error("[snapshot] FAILED:", err.message);
  process.exit(1);
});
