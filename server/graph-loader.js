/**
 * graph-loader.js — Load the SQLite AACT snapshot into Neo4j as a property graph.
 *
 * Graph Model:
 *   Nodes: Trial, Sponsor, Condition, Intervention, Site, Country
 *   Edges: RUNS (Sponsor→Trial), TREATS (Trial→Condition), USES (Trial→Intervention),
 *          AT (Trial→Site), IN_COUNTRY (Site→Country), CONDUCTED_IN (Trial→Country)
 *
 * Run: NEO4J_URI=bolt://neo4j:7687 node graph-loader.js
 */
import Database from "better-sqlite3";
import neo4j from "neo4j-driver";
import pg from "pg";

const DB_PATH = process.env.DB_PATH || "/data/aact.db";
const NEO4J_URI = process.env.NEO4J_URI || "bolt://neo4j:7687";
const NEO4J_USER = process.env.NEO4J_USER || "neo4j";
const NEO4J_PASS = process.env.NEO4J_PASS || "trials-kg-2026";
const AACT_USER = process.env.AACT_USER;
const AACT_PASSWORD = process.env.AACT_PASSWORD;
const AACT_HOST = process.env.AACT_HOST || "aact-db.ctti-clinicaltrials.org";

const db = new Database(DB_PATH, { readonly: true });

let pgPool = null;
function getPg() {
  if (pgPool) return pgPool;
  if (!AACT_USER || !AACT_PASSWORD) return null;
  pgPool = new pg.Pool({
    host: AACT_HOST, port: 5432, database: "aact",
    user: AACT_USER.trim(), password: AACT_PASSWORD.trim(),
    ssl: { rejectUnauthorized: false },
    max: 3, idleTimeoutMillis: 30000, connectionTimeoutMillis: 15000,
  });
  return pgPool;
}

async function pgAll(sql) {
  const pool = getPg();
  if (!pool) throw new Error("No PG credentials — set AACT_USER and AACT_PASSWORD");
  log(`  (querying AACT PostgreSQL: ${sql.slice(0, 80).replace(/\s+/g, ' ')}...)`);
  const { rows } = await pool.query(sql);
  return rows;
}

async function pgStream(sql, batchSize = 50000) {
  // Fetch large PG resultsets in batches to avoid memory spikes
  const pool = getPg();
  if (!pool) throw new Error("No PG credentials — set AACT_USER and AACT_PASSWORD");
  const rows = [];
  let offset = 0;
  while (true) {
    const { rows: batch } = await pool.query(`${sql} LIMIT ${batchSize} OFFSET ${offset}`);
    rows.push(...batch);
    if (batch.length < batchSize) break;
    offset += batchSize;
    log(`  ... fetched ${rows.length} rows from PG`);
  }
  return rows;
}
const driver = neo4j.driver(NEO4J_URI, neo4j.auth.basic(NEO4J_USER, NEO4J_PASS));

function log(msg) { console.log(`[graph-loader] ${new Date().toISOString()} ${msg}`); }

async function run(cypher, params = {}) {
  const session = driver.session();
  try { return await session.run(cypher, params); }
  finally { await session.close(); }
}

async function runBatch(cypher, rows, batchSize = 5000) {
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const session = driver.session();
    try { await session.run(cypher, { batch }); }
    finally { await session.close(); }
    if ((i + batchSize) % 50000 === 0 || i + batchSize >= rows.length) {
      log(`  ... ${Math.min(i + batchSize, rows.length)}/${rows.length}`);
    }
  }
}

async function main() {
  log("Starting graph load");
  const t0 = Date.now();

  // ── Clear existing graph (batch delete to avoid OOM on large graphs) ──
  log("Clearing existing graph...");
  await run(`
    CALL {
      MATCH (n) DETACH DELETE n
    } IN TRANSACTIONS OF 10000 ROWS
  `);

  // ── Constraints & indexes ──
  log("Creating constraints...");
  await run("CREATE CONSTRAINT trial_nct IF NOT EXISTS FOR (t:Trial) REQUIRE t.nct_id IS UNIQUE");
  await run("CREATE CONSTRAINT sponsor_name IF NOT EXISTS FOR (s:Sponsor) REQUIRE s.name IS UNIQUE");
  await run("CREATE CONSTRAINT condition_name IF NOT EXISTS FOR (c:Condition) REQUIRE c.name IS UNIQUE");
  await run("CREATE CONSTRAINT intervention_name IF NOT EXISTS FOR (i:Intervention) REQUIRE i.name IS UNIQUE");
  await run("CREATE CONSTRAINT site_key IF NOT EXISTS FOR (s:Site) REQUIRE s.key IS UNIQUE");
  await run("CREATE CONSTRAINT country_name IF NOT EXISTS FOR (c:Country) REQUIRE c.name IS UNIQUE");

  // ── Check which tables exist ──
  const tableSet = new Set(db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map(r => r.name));
  log(`SQLite tables: ${[...tableSet].join(", ")}`);
  const hasCV = tableSet.has("calculated_values");
  const hasFacilities = tableSet.has("facilities");
  const hasCountries = tableSet.has("countries");
  const hasPg = !!(AACT_USER && AACT_PASSWORD);
  if (!hasCV || !hasFacilities || !hasCountries) {
    log(hasPg ? "  Some tables missing from snapshot — will fall back to live AACT PostgreSQL" : "  WARNING: Some tables missing and no AACT_USER/AACT_PASSWORD set — those sections will be skipped");
  }

  // ── Trial nodes ──
  log("Loading Trial nodes...");
  const trialSql = hasCV
    ? `SELECT s.nct_id, s.brief_title, s.overall_status, s.phase, s.study_type,
             s.enrollment, s.enrollment_type, s.start_date, s.completion_date,
             s.has_dmc, s.why_stopped,
             cv.actual_duration, cv.number_of_facilities, cv.were_results_reported,
             cv.months_to_report_results, cv.number_of_sae_subjects,
             cv.has_us_facility, cv.has_single_facility
       FROM studies s LEFT JOIN calculated_values cv ON cv.nct_id = s.nct_id`
    : `SELECT nct_id, brief_title, overall_status, phase, study_type,
             enrollment, enrollment_type, start_date, completion_date,
             has_dmc, why_stopped,
             NULL AS actual_duration, NULL AS number_of_facilities, NULL AS were_results_reported,
             NULL AS months_to_report_results, NULL AS number_of_sae_subjects,
             NULL AS has_us_facility, NULL AS has_single_facility
       FROM studies`;
  const trials = db.prepare(trialSql).all();
  log(`  ${trials.length} trials from SQLite`);

  await runBatch(`
    UNWIND $batch AS t
    CREATE (n:Trial {
      nct_id: t.nct_id,
      title: t.brief_title,
      status: t.overall_status,
      phase: t.phase,
      study_type: t.study_type,
      enrollment: t.enrollment,
      enrollment_type: t.enrollment_type,
      start_date: t.start_date,
      completion_date: t.completion_date,
      has_dmc: t.has_dmc,
      why_stopped: t.why_stopped,
      duration_months: t.actual_duration,
      facility_count: t.number_of_facilities,
      results_reported: t.were_results_reported,
      months_to_report: t.months_to_report_results,
      sae_subjects: t.number_of_sae_subjects,
      us_facility: t.has_us_facility,
      single_facility: t.has_single_facility
    })
  `, trials);
  log(`  Trial nodes created`);

  // ── Sponsor nodes + RUNS edges ──
  log("Loading Sponsors...");
  const sponsors = db.prepare(`
    SELECT DISTINCT name FROM sponsors WHERE lead_or_collaborator = 'lead' AND name IS NOT NULL
  `).all();
  await runBatch(`
    UNWIND $batch AS s
    MERGE (n:Sponsor {name: s.name})
  `, sponsors);

  const sponsorEdges = db.prepare(`
    SELECT nct_id, name FROM sponsors WHERE lead_or_collaborator = 'lead' AND name IS NOT NULL
  `).all();
  await runBatch(`
    UNWIND $batch AS e
    MATCH (s:Sponsor {name: e.name})
    MATCH (t:Trial {nct_id: e.nct_id})
    CREATE (s)-[:RUNS]->(t)
  `, sponsorEdges);
  log(`  ${sponsors.length} sponsors, ${sponsorEdges.length} RUNS edges`);

  // ── Condition nodes + TREATS edges ──
  log("Loading Conditions...");
  const conditions = db.prepare(`SELECT DISTINCT name FROM conditions WHERE name IS NOT NULL`).all();
  await runBatch(`
    UNWIND $batch AS c
    MERGE (n:Condition {name: c.name})
  `, conditions);

  const condEdges = db.prepare(`SELECT nct_id, name FROM conditions WHERE name IS NOT NULL`).all();
  await runBatch(`
    UNWIND $batch AS e
    MATCH (c:Condition {name: e.name})
    MATCH (t:Trial {nct_id: e.nct_id})
    CREATE (t)-[:TREATS]->(c)
  `, condEdges);
  log(`  ${conditions.length} conditions, ${condEdges.length} TREATS edges`);

  // ── Intervention nodes + USES edges ──
  log("Loading Interventions...");
  const interventions = db.prepare(`SELECT DISTINCT name FROM interventions WHERE name IS NOT NULL`).all();
  await runBatch(`
    UNWIND $batch AS i
    MERGE (n:Intervention {name: i.name})
  `, interventions);

  const intEdges = db.prepare(`SELECT nct_id, name FROM interventions WHERE name IS NOT NULL`).all();
  await runBatch(`
    UNWIND $batch AS e
    MATCH (i:Intervention {name: e.name})
    MATCH (t:Trial {nct_id: e.nct_id})
    CREATE (t)-[:USES]->(i)
  `, intEdges);
  log(`  ${interventions.length} interventions, ${intEdges.length} USES edges`);

  // ── Country nodes + CONDUCTED_IN edges ──
  if (hasCountries || hasPg) {
    log("Loading Countries...");
    const countries = hasCountries
      ? db.prepare(`SELECT DISTINCT name FROM countries WHERE name IS NOT NULL AND removed = false`).all()
      : await pgAll(`SELECT DISTINCT name FROM countries WHERE name IS NOT NULL AND removed = false`);
    await runBatch(`
      UNWIND $batch AS c
      MERGE (n:Country {name: c.name})
    `, countries);

    const countryEdges = hasCountries
      ? db.prepare(`SELECT nct_id, name FROM countries WHERE name IS NOT NULL AND removed = false`).all()
      : await pgStream(`SELECT nct_id, name FROM countries WHERE name IS NOT NULL AND removed = false`);
    await runBatch(`
      UNWIND $batch AS e
      MATCH (c:Country {name: e.name})
      MATCH (t:Trial {nct_id: e.nct_id})
      CREATE (t)-[:CONDUCTED_IN]->(c)
    `, countryEdges);
    log(`  ${countries.length} countries, ${countryEdges.length} CONDUCTED_IN edges`);
  } else { log("Skipping Countries (table missing, no PG fallback)"); }

  // ── Site nodes + AT edges ──
  if (hasFacilities || hasPg) {
    log("Loading Sites (deduplicated by name+city+country)...");
    const sitesSql = `SELECT DISTINCT name, city, state, country,
           name || '||' || COALESCE(city,'') || '||' || COALESCE(country,'') AS key
    FROM facilities WHERE name IS NOT NULL`;
    const sites = hasFacilities
      ? db.prepare(sitesSql).all()
      : await pgStream(sitesSql);
    const facilityCount = hasFacilities
      ? db.prepare('SELECT COUNT(*) AS n FROM facilities').get().n
      : sites.length;
    log(`  ${sites.length} unique sites from ${facilityCount} facility rows`);

    await runBatch(`
      UNWIND $batch AS s
      CREATE (n:Site {
        key: s.key,
        name: s.name,
        city: s.city,
        state: s.state,
        country: s.country
      })
    `, sites, 3000);

    // Link sites to countries
    await run(`
      MATCH (s:Site) WHERE s.country IS NOT NULL
      MATCH (c:Country {name: s.country})
      CREATE (s)-[:IN_COUNTRY]->(c)
    `);

    // AT edges (trial → site)
    const atSql = `SELECT nct_id, name || '||' || COALESCE(city,'') || '||' || COALESCE(country,'') AS site_key
      FROM facilities WHERE name IS NOT NULL`;
    const atEdges = hasFacilities
      ? db.prepare(atSql).all()
      : await pgStream(atSql);
    log(`  Loading ${atEdges.length} AT edges...`);
    await runBatch(`
      UNWIND $batch AS e
      MATCH (t:Trial {nct_id: e.nct_id})
      MATCH (s:Site {key: e.site_key})
      CREATE (t)-[:AT]->(s)
    `, atEdges, 3000);
    log(`  Site nodes and AT edges created`);
  } else { log("Skipping Sites (facilities table missing, no PG fallback)"); }

  // ── Summary ──
  const counts = await run(`
    MATCH (n) RETURN labels(n)[0] AS label, COUNT(n) AS count ORDER BY count DESC
  `);
  const edgeCounts = await run(`
    MATCH ()-[r]->() RETURN type(r) AS type, COUNT(r) AS count ORDER BY count DESC
  `);

  log("=== Graph Summary ===");
  for (const r of counts.records) {
    log(`  ${r.get("label")}: ${r.get("count").toNumber().toLocaleString()} nodes`);
  }
  for (const r of edgeCounts.records) {
    log(`  ${r.get("type")}: ${r.get("count").toNumber().toLocaleString()} edges`);
  }

  const elapsed = ((Date.now() - t0) / 1000 / 60).toFixed(1);
  log(`Graph load complete in ${elapsed} min`);

  await driver.close();
  db.close();
  if (pgPool) await pgPool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
