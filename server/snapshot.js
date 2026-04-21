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
    connectionTimeoutMillis: 60000,
    statement_timeout: 600000, // 10 min for large tables
  });

  // Retry initial connection (AACT PG has intermittent availability)
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      await pool.query("SELECT 1");
      console.log(`[snapshot] connected to AACT in ${elapsed(t0)} (attempt ${attempt})`);
      break;
    } catch (e) {
      console.warn(`[snapshot] PG connect attempt ${attempt}/5 failed: ${e.message}`);
      if (attempt === 5) throw e;
      await new Promise(r => setTimeout(r, attempt * 10000)); // 10s, 20s, 30s, 40s backoff
    }
  }

  // Incremental mode: open the existing db in-place if it exists (fill gaps).
  // Only create from scratch if no db exists.
  const { existsSync } = await import("fs");
  const incremental = existsSync(DB_PATH);
  if (incremental) {
    console.log("[snapshot] existing db found — opening for incremental fill");
  } else {
    console.log("[snapshot] no existing db — building from scratch");
  }

  const db = new Database(DB_PATH);

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

    -- ── Lifecycle tables (Plan / Monitor / Close) ────────────────────────────

    CREATE TABLE IF NOT EXISTS milestones (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nct_id TEXT NOT NULL,
      result_group_id TEXT,
      ctgov_group_code TEXT,
      title TEXT,
      period TEXT,
      count INTEGER
    );

    CREATE TABLE IF NOT EXISTS reported_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nct_id TEXT NOT NULL,
      result_group_id TEXT,
      ctgov_group_code TEXT,
      event_type TEXT,
      default_assessment TEXT,
      organ_system TEXT,
      adverse_event_term TEXT,
      subjects_affected INTEGER,
      subjects_at_risk INTEGER
    );

    CREATE TABLE IF NOT EXISTS outcomes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nct_id TEXT NOT NULL,
      outcome_type TEXT,
      title TEXT,
      description TEXT,
      time_frame TEXT,
      population TEXT,
      units TEXT,
      param_type TEXT
    );

    CREATE TABLE IF NOT EXISTS outcome_analyses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nct_id TEXT NOT NULL,
      outcome_id INTEGER,
      non_inferiority_type TEXT,
      p_value TEXT,
      p_value_modifier TEXT,
      method TEXT,
      param_type TEXT,
      param_value TEXT,
      ci_percent REAL,
      ci_lower_limit TEXT,
      ci_upper_limit TEXT
    );

    CREATE TABLE IF NOT EXISTS result_groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nct_id TEXT NOT NULL,
      ctgov_group_code TEXT,
      result_type TEXT,
      title TEXT,
      description TEXT
    );

    CREATE TABLE IF NOT EXISTS baseline_measurements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nct_id TEXT NOT NULL,
      result_group_id TEXT,
      ctgov_group_code TEXT,
      title TEXT,
      units TEXT,
      param_type TEXT,
      param_value_num REAL,
      category TEXT,
      classification TEXT
    );

    CREATE TABLE IF NOT EXISTS design_outcomes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nct_id TEXT NOT NULL,
      outcome_type TEXT,
      measure TEXT,
      time_frame TEXT,
      description TEXT
    );

    CREATE TABLE IF NOT EXISTS design_groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nct_id TEXT NOT NULL,
      group_type TEXT,
      title TEXT,
      description TEXT
    );

    CREATE TABLE IF NOT EXISTS pending_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nct_id TEXT NOT NULL,
      event TEXT,
      event_date_type TEXT,
      event_date TEXT
    );

    -- Metadata
    CREATE TABLE IF NOT EXISTS _meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  // ── Ingest tables ───────────────────────────────────────────────────────────

  /** Check if a SQLite table exists and has rows */
  function tableHasData(tableName) {
    try {
      const row = db.prepare(`SELECT 1 FROM ${tableName} LIMIT 1`).get();
      return !!row;
    } catch { return false; }
  }

  async function ingest(label, sql, countSql, insertFn) {
    // Skip tables that already have data (incremental mode)
    if (tableHasData(label)) {
      console.log(`[snapshot] ${label} already populated — skipping`);
      return 0;
    }
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
      r.nct_id, r.gender, r.minimum_age, r.maximum_age,
      r.healthy_volunteers == null ? null : String(r.healthy_volunteers),
      r.criteria == null ? null : String(r.criteria),
      r.adult ? 1 : 0, r.child ? 1 : 0, r.older_adult ? 1 : 0
    ); }
  );

  // ── Lifecycle tables ────────────────────────────────────────────────────────

  // milestones (participant flow through stages)
  const insMile = db.prepare(`INSERT INTO milestones (nct_id, result_group_id, ctgov_group_code, title, period, count) VALUES (?,?,?,?,?,?)`);
  await ingest("milestones",
    `SELECT nct_id, result_group_id::text, ctgov_group_code, title, period, count FROM milestones WHERE count > 0 ORDER BY nct_id`,
    `SELECT COUNT(*) AS count FROM milestones WHERE count > 0`,
    (rows) => { for (const r of rows) insMile.run(r.nct_id, r.result_group_id, r.ctgov_group_code, r.title, r.period, parseInt(r.count)); }
  );

  // reported_events (adverse events — 6.5M rows, filter to subjects_affected > 0)
  const insEvt = db.prepare(`INSERT INTO reported_events (nct_id, result_group_id, ctgov_group_code, event_type, default_assessment, organ_system, adverse_event_term, subjects_affected, subjects_at_risk) VALUES (?,?,?,?,?,?,?,?,?)`);
  await ingest("reported_events",
    `SELECT nct_id, result_group_id::text, ctgov_group_code, event_type, default_assessment, organ_system, adverse_event_term, subjects_affected, subjects_at_risk FROM reported_events WHERE subjects_affected > 0 ORDER BY nct_id`,
    `SELECT COUNT(*) AS count FROM reported_events WHERE subjects_affected > 0`,
    (rows) => { for (const r of rows) insEvt.run(r.nct_id, r.result_group_id, r.ctgov_group_code, r.event_type, r.default_assessment, r.organ_system, r.adverse_event_term, parseInt(r.subjects_affected || 0), parseInt(r.subjects_at_risk || 0)); }
  );

  // outcomes (descriptions of measured endpoints)
  const insOut = db.prepare(`INSERT INTO outcomes (nct_id, outcome_type, title, description, time_frame, population, units, param_type) VALUES (?,?,?,?,?,?,?,?)`);
  await ingest("outcomes",
    `SELECT nct_id, outcome_type, title, description, time_frame, population, units, param_type FROM outcomes ORDER BY nct_id`,
    `SELECT COUNT(*) AS count FROM outcomes`,
    (rows) => { for (const r of rows) insOut.run(r.nct_id, r.outcome_type, r.title, r.description, r.time_frame, r.population, r.units, r.param_type); }
  );

  // outcome_analyses (statistical results)
  const insOA = db.prepare(`INSERT INTO outcome_analyses (nct_id, outcome_id, non_inferiority_type, p_value, p_value_modifier, method, param_type, param_value, ci_percent, ci_lower_limit, ci_upper_limit) VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  await ingest("outcome_analyses",
    `SELECT nct_id, outcome_id, non_inferiority_type, p_value, p_value_modifier, method, param_type, param_value, ci_percent, ci_lower_limit, ci_upper_limit FROM outcome_analyses ORDER BY nct_id`,
    `SELECT COUNT(*) AS count FROM outcome_analyses`,
    (rows) => { for (const r of rows) insOA.run(r.nct_id, r.outcome_id, r.non_inferiority_type, r.p_value, r.p_value_modifier, r.method, r.param_type, r.param_value, r.ci_percent ? parseFloat(r.ci_percent) : null, r.ci_lower_limit, r.ci_upper_limit); }
  );

  // result_groups (arm-level groupings for interpreting outcomes/events)
  const insRG = db.prepare(`INSERT INTO result_groups (nct_id, ctgov_group_code, result_type, title, description) VALUES (?,?,?,?,?)`);
  await ingest("result_groups",
    `SELECT nct_id, ctgov_group_code, result_type, title, description FROM result_groups ORDER BY nct_id`,
    `SELECT COUNT(*) AS count FROM result_groups`,
    (rows) => { for (const r of rows) insRG.run(r.nct_id, r.ctgov_group_code, r.result_type, r.title, r.description); }
  );

  // baseline_measurements (demographics per arm)
  const insBM = db.prepare(`INSERT INTO baseline_measurements (nct_id, result_group_id, ctgov_group_code, title, units, param_type, param_value_num, category, classification) VALUES (?,?,?,?,?,?,?,?,?)`);
  await ingest("baseline_measurements",
    `SELECT nct_id, result_group_id::text, ctgov_group_code, title, units, param_type, param_value_num, category, classification FROM baseline_measurements ORDER BY nct_id`,
    `SELECT COUNT(*) AS count FROM baseline_measurements`,
    (rows) => { for (const r of rows) insBM.run(r.nct_id, r.result_group_id, r.ctgov_group_code, r.title, r.units, r.param_type, r.param_value_num ? parseFloat(r.param_value_num) : null, r.category, r.classification); }
  );

  // design_outcomes (planned endpoints)
  const insDO = db.prepare(`INSERT INTO design_outcomes (nct_id, outcome_type, measure, time_frame, description) VALUES (?,?,?,?,?)`);
  await ingest("design_outcomes",
    `SELECT nct_id, outcome_type, measure, time_frame, description FROM design_outcomes ORDER BY nct_id`,
    `SELECT COUNT(*) AS count FROM design_outcomes`,
    (rows) => { for (const r of rows) insDO.run(r.nct_id, r.outcome_type, r.measure, r.time_frame, r.description); }
  );

  // design_groups (arm structure)
  const insDG = db.prepare(`INSERT INTO design_groups (nct_id, group_type, title, description) VALUES (?,?,?,?)`);
  await ingest("design_groups",
    `SELECT nct_id, group_type, title, description FROM design_groups ORDER BY nct_id`,
    `SELECT COUNT(*) AS count FROM design_groups`,
    (rows) => { for (const r of rows) insDG.run(r.nct_id, r.group_type, r.title, r.description); }
  );

  // pending_results (QC submission events)
  const insPR = db.prepare(`INSERT INTO pending_results (nct_id, event, event_date_type, event_date) VALUES (?,?,?,?)`);
  await ingest("pending_results",
    `SELECT nct_id, event, event_date_type, event_date::text FROM pending_results ORDER BY nct_id`,
    `SELECT COUNT(*) AS count FROM pending_results`,
    (rows) => { for (const r of rows) insPR.run(r.nct_id, r.event, r.event_date_type, r.event_date); }
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
    CREATE INDEX IF NOT EXISTS idx_mile_nct ON milestones(nct_id);
    CREATE INDEX IF NOT EXISTS idx_revt_nct ON reported_events(nct_id);
    CREATE INDEX IF NOT EXISTS idx_revt_type ON reported_events(event_type);
    CREATE INDEX IF NOT EXISTS idx_out_nct ON outcomes(nct_id);
    CREATE INDEX IF NOT EXISTS idx_oa_nct ON outcome_analyses(nct_id);
    CREATE INDEX IF NOT EXISTS idx_rg_nct ON result_groups(nct_id);
    CREATE INDEX IF NOT EXISTS idx_bm_nct ON baseline_measurements(nct_id);
    CREATE INDEX IF NOT EXISTS idx_do_nct ON design_outcomes(nct_id);
    CREATE INDEX IF NOT EXISTS idx_dg_nct ON design_groups(nct_id);
    CREATE INDEX IF NOT EXISTS idx_pr_nct ON pending_results(nct_id);
  `);

  // ── Populate FTS ────────────────────────────────────────────────────────────
  if (tableHasData("studies_fts")) {
    console.log("[snapshot] FTS index already populated — skipping");
  } else {
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
  }

  // ── Write metadata ──────────────────────────────────────────────────────────
  const metaIns = db.prepare(`INSERT OR REPLACE INTO _meta (key, value) VALUES (?, ?)`);
  metaIns.run("snapshot_time", new Date().toISOString());
  metaIns.run("aact_host", AACT_HOST);

  db.close();
  await pool.end();

  console.log(`[snapshot] complete — total time ${elapsed(t0)}`);
  console.log(`[snapshot] database written to ${DB_PATH}`);
}

main().catch((err) => {
  console.error("[snapshot] FAILED:", err.message);
  process.exit(1);
});
