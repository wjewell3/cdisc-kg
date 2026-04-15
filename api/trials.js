/**
 * Vercel Serverless Function — /api/trials
 * Queries AACT (ClinicalTrials.gov PostgreSQL replica) live.
 *
 * Query params:
 *   q        - free-text search term (condition, intervention, keyword)
 *   phase    - filter by phase: "Phase 1", "Phase 2", "Phase 3", "Phase 4"
 *   status   - filter by overall_status: "COMPLETED", "RECRUITING" etc.
 *   sponsor  - partial match on lead sponsor name
 *   limit    - max results (default 50, max 200)
 *   mode     - "search" (default) | "stats" (aggregate counts)
 */

import { Pool } from "pg";

// Connection pool (reused between warm invocations)
const pool = new Pool({
  host: "aact-db.ctti-clinicaltrials.org",
  port: 5432,
  database: "aact",
  user: (process.env.AACT_USER || "").trim(),
  password: (process.env.AACT_PASSWORD || "").trim(),
  ssl: { rejectUnauthorized: false },
  max: 3,
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 8000,
});

export default async function handler(req, res) {
  // CORS — allow the Vercel frontend origin
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const {
    q = "",
    phase = "",
    status = "",
    sponsor = "",
    limit: rawLimit = "50",
    mode = "search",
    condition = "",
    intervention = "",
  } = req.query;

  const limit = Math.min(parseInt(rawLimit, 10) || 100, 500);

  try {
    if (mode === "stats") {
      return res.status(200).json(await getStats(q, condition, intervention, phase, status, sponsor));
    }

    const results = await searchTrials({ q, condition, intervention, phase, status, sponsor, limit });
    return res.status(200).json(results);
  } catch (err) {
    console.error("AACT query error:", err.message);
    return res.status(500).json({ error: "Database query failed", detail: err.message });
  }
}

async function searchTrials({ q, condition, intervention, phase, status, sponsor, limit }) {
  const params = [];
  const where = [];
  let p = 1;

  // Full-text search across conditions + brief title
  if (q) {
    where.push(`(
      s.brief_title ILIKE $${p}
      OR s.official_title ILIKE $${p}
      OR EXISTS (
        SELECT 1 FROM conditions c WHERE c.nct_id = s.nct_id AND c.name ILIKE $${p}
      )
      OR EXISTS (
        SELECT 1 FROM interventions i WHERE i.nct_id = s.nct_id AND i.name ILIKE $${p}
      )
      OR EXISTS (
        SELECT 1 FROM brief_summaries bs WHERE bs.nct_id = s.nct_id AND bs.description ILIKE $${p}
      )
    )`);
    params.push(`%${q}%`);
    p++;
  }

  if (condition) {
    const conditions = condition.split(",").map((c) => c.trim()).filter(Boolean);
    const clauses = conditions.map((c) => {
      params.push(`%${c}%`);
      return `EXISTS (SELECT 1 FROM conditions c WHERE c.nct_id = s.nct_id AND c.name ILIKE $${p++})`;
    });
    where.push(`(${clauses.join(" OR ")})`);
  }

  if (intervention) {
    const interventions = intervention.split(",").map((i) => i.trim()).filter(Boolean);
    const clauses = interventions.map((iv) => {
      params.push(`%${iv}%`);
      return `EXISTS (SELECT 1 FROM interventions i WHERE i.nct_id = s.nct_id AND i.name ILIKE $${p++})`;
    });
    where.push(`(${clauses.join(" OR ")})`);
  }

  if (phase) {
    // AACT stores phase as PHASE3, PHASE1/PHASE2 etc.
    const phases = phase.split(",").map((ph) => ph.trim().toUpperCase().replace(/ /g, "")).filter(Boolean);
    if (phases.length === 1) {
      where.push(`s.phase = $${p}`);
      params.push(phases[0]);
      p++;
    } else {
      const placeholders = phases.map(() => `$${p++}`).join(", ");
      where.push(`s.phase IN (${placeholders})`);
      params.push(...phases);
    }
  }

  if (status) {
    const statuses = status.split(",").map((s) => s.trim()).filter(Boolean);
    if (statuses.length === 1) {
      where.push(`s.overall_status ILIKE $${p}`);
      params.push(statuses[0]);
      p++;
    } else {
      const placeholders = statuses.map(() => `$${p++}`).join(", ");
      where.push(`s.overall_status IN (${placeholders})`);
      params.push(...statuses);
    }
  }

  if (sponsor) {
    const sponsors = sponsor.split(",").map((s) => s.trim()).filter(Boolean);
    const clauses = sponsors.map((sp) => {
      params.push(`%${sp}%`);
      return `EXISTS (SELECT 1 FROM sponsors sp WHERE sp.nct_id = s.nct_id AND sp.lead_or_collaborator = 'lead' AND sp.name ILIKE $${p++})`;
    });
    where.push(`(${clauses.join(" OR ")})`);
  }

  const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

  const sql = `
    SELECT
      s.nct_id,
      s.brief_title,
      s.overall_status,
      s.phase,
      s.study_type,
      s.enrollment,
      s.enrollment_type,
      s.start_date,
      s.completion_date,
      s.primary_completion_date,
      s.has_dmc,
      s.why_stopped,
      -- Aggregated conditions (up to 5)
      (
        SELECT string_agg(name, '; ' ORDER BY name)
        FROM (SELECT DISTINCT name FROM conditions WHERE nct_id = s.nct_id LIMIT 5) cond
      ) AS conditions,
      -- Aggregated interventions (up to 5)
      (
        SELECT string_agg(CONCAT(intervention_type, ': ', name), '; ' ORDER BY name)
        FROM (SELECT DISTINCT intervention_type, name FROM interventions WHERE nct_id = s.nct_id LIMIT 5) intv
      ) AS interventions,
      -- Lead sponsor
      (
        SELECT name FROM sponsors WHERE nct_id = s.nct_id AND lead_or_collaborator = 'lead' LIMIT 1
      ) AS sponsor,
      -- Primary outcome
      (
        SELECT measure FROM design_outcomes
        WHERE nct_id = s.nct_id AND outcome_type = 'primary'
        ORDER BY id LIMIT 1
      ) AS primary_outcome,
      -- Arms count
      (SELECT COUNT(*) FROM design_groups WHERE nct_id = s.nct_id) AS arm_count
    FROM studies s
    ${whereClause}
    ORDER BY
      CASE s.overall_status
        WHEN 'RECRUITING' THEN 0
        WHEN 'ACTIVE_NOT_RECRUITING' THEN 1
        WHEN 'COMPLETED' THEN 2
        ELSE 3
      END,
      s.enrollment DESC NULLS LAST
    LIMIT $${p}
  `;
  params.push(limit);

  const countSql = `SELECT COUNT(*) AS total FROM studies s ${whereClause}`;
  const [{ rows }, { rows: countRows }] = await Promise.all([
    pool.query(sql, params),
    pool.query(countSql, params.slice(0, -1)),
  ]);
  const totalCount = parseInt(countRows[0]?.total || rows.length, 10);
  return {
    total: totalCount,
    returned: rows.length,
    limit,
    results: rows.map(normalizeRow),
  };
}

async function getStats(q, condition, intervention, phase, status, sponsor) {
  // Phase distribution
  const phaseQuery = `
    SELECT phase, COUNT(*) as count
    FROM studies
    WHERE overall_status NOT IN ('WITHDRAWN', 'TERMINATED')
    ${q ? `AND (brief_title ILIKE $1 OR EXISTS (SELECT 1 FROM conditions c WHERE c.nct_id = studies.nct_id AND c.name ILIKE $1))` : ""}
    GROUP BY phase
    ORDER BY count DESC
    LIMIT 10
  `;
  const statusQuery = `
    SELECT overall_status, COUNT(*) as count
    FROM studies
    ${q ? `WHERE brief_title ILIKE $1 OR EXISTS (SELECT 1 FROM conditions c WHERE c.nct_id = studies.nct_id AND c.name ILIKE $1)` : ""}
    GROUP BY overall_status
    ORDER BY count DESC
    LIMIT 10
  `;

  const params = q ? [`%${q}%`] : [];
  const [phaseRes, statusRes] = await Promise.all([
    pool.query(phaseQuery, params),
    pool.query(statusQuery, params),
  ]);

  return {
    phases: phaseRes.rows,
    statuses: statusRes.rows,
  };
}

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
