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

// Stream from PG and write directly to Neo4j in chunks (bounded memory)
async function pgStreamToNeo4j(sql, cypherTemplate, neoBatch = 5000, pgBatch = 50000) {
  const pool = getPg();
  if (!pool) throw new Error("No PG credentials — set AACT_USER and AACT_PASSWORD");
  let offset = 0;
  let total = 0;
  while (true) {
    const { rows } = await pool.query(`${sql} LIMIT ${pgBatch} OFFSET ${offset}`);
    if (rows.length === 0) break;
    for (let i = 0; i < rows.length; i += neoBatch) {
      const batch = rows.slice(i, i + neoBatch);
      const session = driver.session();
      try { await session.run(cypherTemplate, { batch }); }
      finally { await session.close(); }
    }
    total += rows.length;
    log(`  ... streamed ${total} rows to Neo4j`);
    if (rows.length < pgBatch) break;
    offset += pgBatch;
  }
  return total;
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

// Stream SQLite rows directly to Neo4j in chunks (bounded memory for large tables)
async function sqliteStreamToNeo4j(sql, cypherTemplate, neoBatch = 3000, chunkSize = 50000) {
  let total = 0;
  let offset = 0;
  const countSql = `SELECT COUNT(*) AS cnt FROM (${sql})`;
  const totalRows = db.prepare(countSql).get()?.cnt || 0;
  log(`  total rows to stream: ${totalRows.toLocaleString()}`);
  while (true) {
    const chunk = db.prepare(`${sql} LIMIT ${chunkSize} OFFSET ${offset}`).all();
    if (chunk.length === 0) break;
    for (let i = 0; i < chunk.length; i += neoBatch) {
      const batch = chunk.slice(i, i + neoBatch);
      const session = driver.session();
      try { await session.run(cypherTemplate, { batch }); }
      finally { await session.close(); }
    }
    total += chunk.length;
    log(`  ... streamed ${total.toLocaleString()}/${totalRows.toLocaleString()} rows to Neo4j`);
    if (chunk.length < chunkSize) break;
    offset += chunkSize;
  }
  return total;
}

async function main() {
  log("Starting graph load");
  const t0 = Date.now();

  // ── Clear existing graph (client-side loop to avoid full cursor OOM) ──
  log("Clearing existing graph...");
  let cleared = 1;
  while (cleared > 0) {
    const r = await run(`MATCH (n) WITH n LIMIT 25000 DETACH DELETE n RETURN count(*) AS c`);
    cleared = r.records[0]?.get("c")?.toNumber?.() ?? 0;
    if (cleared > 0) log(`  cleared batch of ${cleared}`);
  }

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
    const siteCypher = `
      UNWIND $batch AS s
      CREATE (n:Site {
        key: s.key,
        name: s.name,
        city: s.city,
        state: s.state,
        country: s.country
      })
    `;

    if (hasFacilities) {
      log(`  Streaming site nodes from SQLite (chunked)...`);
      const siteCount = await sqliteStreamToNeo4j(sitesSql, siteCypher, 3000, 50000);
      log(`  ${siteCount.toLocaleString()} unique sites from SQLite`);
    } else {
      const count = await pgStreamToNeo4j(sitesSql, siteCypher, 3000);
      log(`  ${count} unique sites from PG (streamed)`);
    }

    // Link sites to countries
    await run(`
      MATCH (s:Site) WHERE s.country IS NOT NULL
      MATCH (c:Country {name: s.country})
      CREATE (s)-[:IN_COUNTRY]->(c)
    `);

    // AT edges (trial → site)
    const atSql = `SELECT nct_id, name || '||' || COALESCE(city,'') || '||' || COALESCE(country,'') AS site_key
      FROM facilities WHERE name IS NOT NULL`;
    const atCypher = `
      UNWIND $batch AS e
      MATCH (t:Trial {nct_id: e.nct_id})
      MATCH (s:Site {key: e.site_key})
      CREATE (t)-[:AT]->(s)
    `;

    if (hasFacilities) {
      log(`  Streaming AT edges from SQLite (chunked)...`);
      const atCount = await sqliteStreamToNeo4j(atSql, atCypher, 3000, 50000);
      log(`  ${atCount.toLocaleString()} AT edges from SQLite`);
    } else {
      log(`  Loading AT edges from PG (streamed)...`);
      const atCount = await pgStreamToNeo4j(atSql, atCypher, 3000);
      log(`  ${atCount} AT edges from PG`);
    }
    log(`  Site nodes and AT edges created`);
  } else { log("Skipping Sites (facilities table missing, no PG fallback)"); }

  // ── ATC Drug Classification enrichment ──
  log("Enriching Interventions with ATC drug classes...");
  try {
    const { readFileSync } = await import("fs");
    const { dirname, join } = await import("path");
    const { fileURLToPath } = await import("url");
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const atcData = JSON.parse(readFileSync(join(__dirname, "atc-map.json"), "utf8"));
    const drugMap = atcData.drugs;

    // Collect unique classes and sub-classes
    const classSet = new Map(); // class → Set<sub>
    const drugMappings = []; // { drug, atc, className, subClass }
    for (const [drug, info] of Object.entries(drugMap)) {
      if (!info) continue; // skip placebo etc.
      if (!classSet.has(info.class)) classSet.set(info.class, new Set());
      classSet.get(info.class).add(info.sub);
      drugMappings.push({ drug, atc: info.atc, className: info.class, subClass: info.sub });
    }

    // Create DrugClass nodes (therapeutic class + sub-class)
    await run("CREATE CONSTRAINT drug_class_name IF NOT EXISTS FOR (d:DrugClass) REQUIRE d.name IS UNIQUE");
    const classNodes = [];
    for (const [cls, subs] of classSet) {
      classNodes.push({ name: cls, level: "therapeutic_class" });
      for (const sub of subs) {
        classNodes.push({ name: sub, level: "sub_class", parent: cls });
      }
    }
    await runBatch(`
      UNWIND $batch AS c
      MERGE (d:DrugClass {name: c.name})
      SET d.level = c.level
    `, classNodes);

    // Link sub-classes to parent classes
    const subClassLinks = classNodes.filter(c => c.parent);
    if (subClassLinks.length > 0) {
      await runBatch(`
        UNWIND $batch AS c
        MATCH (sub:DrugClass {name: c.name})
        MATCH (parent:DrugClass {name: c.parent})
        MERGE (sub)-[:BELONGS_TO]->(parent)
      `, subClassLinks);
    }

    // Match Intervention nodes to ATC mappings (case-insensitive)
    let matched = 0;
    for (const mapping of drugMappings) {
      const result = await run(`
        MATCH (i:Intervention)
        WHERE toLower(i.name) = $drug OR toLower(i.name) CONTAINS $drug
        WITH i LIMIT 1
        MATCH (d:DrugClass {name: $subClass})
        MERGE (i)-[:CLASSIFIED_AS]->(d)
        RETURN COUNT(*) AS cnt
      `, { drug: mapping.drug, subClass: mapping.subClass });
      matched += result.records[0]?.get("cnt")?.toNumber?.() || 0;
    }
    log(`  ${classNodes.length} DrugClass nodes, ${matched} CLASSIFIED_AS edges`);
  } catch (e) {
    log(`  ATC enrichment failed (non-fatal): ${e.message}`);
  }

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
