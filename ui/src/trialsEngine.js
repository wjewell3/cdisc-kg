/**
 * Trials query engine — NL → AACT parameters → live results via Vercel serverless fn.
 *
 * The KG semantic layer maps natural language clinical concepts to AACT query params.
 * This mirrors the DemoPanel's demoEngine.js but operates at cross-trial scale.
 */

// ── NL concept → AACT parameter mapping ────────────────────────────────────
// Same "KG as semantic layer" principle — the knowledge graph knows the schema
const CONCEPT_MAP = [
  // Phases
  { patterns: [/phase\s*[1I]\b/i, /phase\s*one\b/i], param: "phase", value: "PHASE1", label: "Phase 1", kgPath: "Protocol → phase → PHASE1" },
  { patterns: [/phase\s*1\/2\b/i, /phase\s*[12]\/[12]\b/i], param: "phase", value: "PHASE1/PHASE2", label: "Phase 1/2", kgPath: "Protocol → phase → PHASE1/PHASE2" },
  { patterns: [/phase\s*2\b(?!\/)/i, /phase\s*two\b/i], param: "phase", value: "PHASE2", label: "Phase 2", kgPath: "Protocol → phase → PHASE2" },
  { patterns: [/phase\s*2\/3\b/i, /phase\s*[2-3]\/[2-3]\b/i], param: "phase", value: "PHASE2/PHASE3", label: "Phase 2/3", kgPath: "Protocol → phase → PHASE2/PHASE3" },
  { patterns: [/phase\s*3\b(?!\/)/i, /phase\s*three\b/i], param: "phase", value: "PHASE3", label: "Phase 3", kgPath: "Protocol → phase → PHASE3" },
  { patterns: [/phase\s*4\b/i, /phase\s*four\b/i], param: "phase", value: "PHASE4", label: "Phase 4", kgPath: "Protocol → phase → PHASE4" },

  // Status
  { patterns: [/recruit/i, /\bopen\b/i, /enrolling/i], param: "status", value: "RECRUITING", label: "Recruiting", kgPath: "Protocol → overall_status → RECRUITING" },
  { patterns: [/completed?\b/i, /finished/i], param: "status", value: "COMPLETED", label: "Completed", kgPath: "Protocol → overall_status → COMPLETED" },
  { patterns: [/active.*not.*recruit/i, /ongoing/i], param: "status", value: "ACTIVE_NOT_RECRUITING", label: "Active (not recruiting)", kgPath: "Protocol → overall_status → ACTIVE_NOT_RECRUITING" },
  { patterns: [/terminated/i, /stopped\b/i], param: "status", value: "TERMINATED", label: "Terminated", kgPath: "Protocol → overall_status → TERMINATED" },

  // Conditions (map to `condition` param)
  { patterns: [/alzheimer/i, /dementia/i], param: "condition", value: "Alzheimer", label: "Alzheimer's Disease", kgPath: "Condition → MeSH → Alzheimer Disease" },
  { patterns: [/cancer\b/i, /oncolog/i, /tumor/i, /tumour/i, /malignant/i, /neoplasm/i], param: "condition", value: "Cancer", label: "Cancer / Oncology", kgPath: "Condition → MeSH → Neoplasms" },
  { patterns: [/breast\s*cancer/i], param: "condition", value: "Breast Cancer", label: "Breast Cancer", kgPath: "Condition → MeSH → Breast Neoplasms" },
  { patterns: [/lung\s*cancer/i, /nsclc/i, /sclc/i], param: "condition", value: "Lung Cancer", label: "Lung Cancer", kgPath: "Condition → MeSH → Lung Neoplasms" },
  { patterns: [/ov[ae]rian\s*cancer/i], param: "condition", value: "Ovarian Cancer", label: "Ovarian Cancer", kgPath: "Condition → MeSH → Ovarian Neoplasms" },
  { patterns: [/diabetes|diabetic/i], param: "condition", value: "Diabetes", label: "Diabetes", kgPath: "Condition → MeSH → Diabetes Mellitus" },
  { patterns: [/covid|sars.cov/i, /coronavirus/i], param: "condition", value: "COVID", label: "COVID-19", kgPath: "Condition → MeSH → COVID-19" },
  { patterns: [/depression|depressive/i, /mdd\b/i], param: "condition", value: "Depression", label: "Depression / MDD", kgPath: "Condition → MeSH → Depressive Disorder" },
  { patterns: [/schizophreni/i], param: "condition", value: "Schizophrenia", label: "Schizophrenia", kgPath: "Condition → MeSH → Schizophrenia" },
  { patterns: [/heart\s*failure|hf\b/i], param: "condition", value: "Heart Failure", label: "Heart Failure", kgPath: "Condition → MeSH → Heart Failure" },
  { patterns: [/hypertension|high\s*blood\s*pressure/i], param: "condition", value: "Hypertension", label: "Hypertension", kgPath: "Condition → MeSH → Hypertension" },
  { patterns: [/parkinson/i], param: "condition", value: "Parkinson", label: "Parkinson's Disease", kgPath: "Condition → MeSH → Parkinson Disease" },
  { patterns: [/multiple\s*sclerosis|\bms\b/i], param: "condition", value: "Multiple Sclerosis", label: "Multiple Sclerosis", kgPath: "Condition → MeSH → Multiple Sclerosis" },
  { patterns: [/asthma/i], param: "condition", value: "Asthma", label: "Asthma", kgPath: "Condition → MeSH → Asthma" },
  { patterns: [/hiv\b|aids\b/i], param: "condition", value: "HIV", label: "HIV/AIDS", kgPath: "Condition → MeSH → HIV Infections" },
  { patterns: [/rheumatoid\s*arthritis|\bra\b/i], param: "condition", value: "Rheumatoid Arthritis", label: "Rheumatoid Arthritis", kgPath: "Condition → MeSH → Arthritis, Rheumatoid" },

  // Interventions
  { patterns: [/immunotherap/i, /checkpoint/i, /anti.pd/i], param: "intervention", value: "immunotherapy", label: "Immunotherapy", kgPath: "Intervention → intervention_type → Biological" },
  { patterns: [/chemotherap/i, /chemo\b/i], param: "intervention", value: "chemotherapy", label: "Chemotherapy", kgPath: "Intervention → intervention_type → Drug (chemotherapy)" },
  { patterns: [/placebo/i, /sham/i], param: "intervention", value: "placebo", label: "Placebo-controlled", kgPath: "Intervention → name → Placebo" },
  { patterns: [/gene\s*therap/i], param: "intervention", value: "gene therapy", label: "Gene Therapy", kgPath: "Intervention → intervention_type → Genetic" },
  { patterns: [/vaccine|vaccination/i], param: "intervention", value: "vaccine", label: "Vaccine", kgPath: "Intervention → intervention_type → Biological (vaccine)" },
  { patterns: [/device/i, /implant/i, /stent/i], param: "intervention", value: "", label: "Device", kgPath: "Intervention → intervention_type → Device", studyType: "Interventional" },

  // Sponsor patterns
  { patterns: [/pfizer/i], param: "sponsor", value: "Pfizer", label: "Pfizer", kgPath: "Sponsor → lead → Pfizer" },
  { patterns: [/novartis/i], param: "sponsor", value: "Novartis", label: "Novartis", kgPath: "Sponsor → lead → Novartis" },
  { patterns: [/roche|genentech/i], param: "sponsor", value: "Roche", label: "Roche/Genentech", kgPath: "Sponsor → lead → F. Hoffmann-La Roche" },
  { patterns: [/merck\b/i, /\bmsd\b/i], param: "sponsor", value: "Merck", label: "Merck", kgPath: "Sponsor → lead → Merck" },
  { patterns: [/\bnih\b/i, /national\s*institute/i], param: "sponsor", value: "National Institute", label: "NIH", kgPath: "Sponsor → lead → National Institutes of Health" },
  { patterns: [/astrazeneca/i], param: "sponsor", value: "AstraZeneca", label: "AstraZeneca", kgPath: "Sponsor → lead → AstraZeneca" },
  { patterns: [/johnson.*johnson|janssen/i], param: "sponsor", value: "Johnson", label: "J&J / Janssen", kgPath: "Sponsor → lead → Johnson & Johnson" },
  { patterns: [/ppd\b/i, /thermo\s*fisher.*ppd/i], param: "sponsor", value: "PPD", label: "PPD / Thermo Fisher", kgPath: "Sponsor → lead → PPD Inc." },
];

/**
 * Parse NL query into AACT query params using KG semantic mapping.
 * Returns { params, resolutions } where resolution shows the KG path.
 */
export function resolveTrialQuery(text) {
  const params = {};
  const resolutions = [];
  const used = new Set();

  // Sort by specificity — longer/more specific patterns first
  const sorted = [...CONCEPT_MAP].sort((a, b) => {
    const maxLenA = Math.max(...a.patterns.map((p) => p.source.length));
    const maxLenB = Math.max(...b.patterns.map((p) => p.source.length));
    return maxLenB - maxLenA;
  });

  for (const concept of sorted) {
    if (used.has(concept.param)) continue;
    for (const pat of concept.patterns) {
      if (pat.test(text)) {
        params[concept.param] = concept.value;
        resolutions.push({
          label: concept.label,
          param: concept.param,
          value: concept.value,
          kgPath: concept.kgPath,
        });
        used.add(concept.param);
        break;
      }
    }
  }

  // Fall back to free-text search if no specific concepts matched
  if (Object.keys(params).length === 0) {
    params.q = text;
    resolutions.push({
      label: `Free-text: "${text}"`,
      param: "q",
      value: text,
      kgPath: "Full-text search → studies.brief_title + conditions + interventions",
    });
  }

  return { params, resolutions };
}

/**
 * Execute a trial query against the live AACT serverless endpoint.
 */

// If VITE_TRIALS_API_BASE is set (e.g. http://your-oke-lb-ip), use the OKE
// Express server; otherwise fall back to Vercel serverless (/api/trials).
const TRIALS_API_BASE = import.meta.env.VITE_TRIALS_API_BASE || "";

function trialsUrl(path = "/api/trials") {
  return TRIALS_API_BASE
    ? `${TRIALS_API_BASE.replace(/\/$/, "")}${path}`
    : new URL("/api/trials", window.location.origin).toString();
}

export async function executeTrialQuery(params, limit = 50) {
  const url = new URL(trialsUrl());
  for (const [k, v] of Object.entries(params)) {
    if (v) url.searchParams.set(k, v);
  }
  url.searchParams.set("limit", String(limit));

  const res = await fetch(url.toString());
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

/**
 * Fetch full-database aggregate counts for charts.
 * Returns { total, phase, status, sponsor, enrollment } where
 * phase/status/enrollment are { key: count } objects and
 * sponsor is [[name, count], ...] (top 20).
 */
export async function executeTrialAgg(params) {
  const url = new URL(trialsUrl());
  url.searchParams.set("mode", "stats");
  for (const [k, v] of Object.entries(params)) {
    if (v) url.searchParams.set(k, v);
  }
  const res = await fetch(url.toString());
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

/**
 * Search all sponsors (not just top N) for the given filter context.
 * Returns [[name, count], ...] sorted by count desc, up to 100 results.
 */
export async function executeSponsorSearch(params, sponsorQ) {
  const url = new URL(trialsUrl());
  url.searchParams.set("mode", "sponsors");
  for (const [k, v] of Object.entries(params)) {
    if (v) url.searchParams.set(k, v);
  }
  if (sponsorQ) url.searchParams.set("sponsor_q", sponsorQ);
  const res = await fetch(url.toString());
  if (!res.ok) return [];
  const data = await res.json();
  return (data.sponsors || []).map(({ val, count }) => [val, count]);
}

export async function executeConditionSearch(params, conditionQ) {
  const url = new URL(trialsUrl());
  url.searchParams.set("mode", "conditions");
  for (const [k, v] of Object.entries(params)) {
    if (v) url.searchParams.set(k, v);
  }
  if (conditionQ) url.searchParams.set("condition_q", conditionQ);
  const res = await fetch(url.toString());
  if (!res.ok) return [];
  const data = await res.json();
  return (data.conditions || []).map(({ val, count }) => [val, count]);
}

export async function executeInterventionSearch(params, interventionQ) {
  const url = new URL(trialsUrl());
  url.searchParams.set("mode", "interventions");
  for (const [k, v] of Object.entries(params)) {
    if (v) url.searchParams.set(k, v);
  }
  if (interventionQ) url.searchParams.set("intervention_q", interventionQ);
  const res = await fetch(url.toString());
  if (!res.ok) return [];
  const data = await res.json();
  return (data.interventions || []).map(({ val, count }) => [val, count]);
}

// ── Graph Query (NL → Cypher via LLM) ─────────────────────────────────────

export async function executeGraphQuery(question) {
  // Preset questions have hardcoded Cypher — bypass LLM so they work even
  // when the GitHub Copilot API token is expired or hit quota.
  const preset = TRIAL_QUERIES.find(q => q.isGraph && q.cypher && q.text === question);

  // LLM calls happen on Vercel (GitHub Copilot API is IP-restricted from OKE).
  const url = new URL("/api/graph-query", window.location.origin).toString();

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // Include preset Cypher in payload to skip LLM generation step on server
    body: JSON.stringify(preset ? { question, cypher: preset.cypher } : { question }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

/**
 * Detect if a question is a graph-native question (should go through NL→Cypher)
 * vs a structured filter query (should go through SQLite search).
 *
 * Heuristic: questions with question marks, "which/what/how/who/why/where" starters,
 * or "compare/between/path/overlap/adjacent/gap/shared/repurpos" keywords → graph.
 */
export function isGraphQuestion(text) {
  const t = text.trim();
  // Contains a question mark → natural language question
  if (t.includes("?")) return true;
  // Starts with interrogative word
  if (/^(which|what|how|who|why|where|find|show|list|compare|are there)\b/i.test(t)) return true;
  // Contains graph-specific keywords
  if (/\b(between|adjacent|overlap|gap|shared|repurpos|path|connect|relationship|competitor|landscape|network|shortest)\b/i.test(t)) return true;
  return false;
}

/** Browsable filter catalog — all available options per param, for the filter picker UI */
export const FILTER_CATALOG = [
  {
    param: "phase", label: "Phase",
    options: [
      { label: "Phase 1", value: "PHASE1" }, { label: "Phase 1/2", value: "PHASE1/PHASE2" },
      { label: "Phase 2", value: "PHASE2" }, { label: "Phase 2/3", value: "PHASE2/PHASE3" },
      { label: "Phase 3", value: "PHASE3" }, { label: "Phase 4", value: "PHASE4" },
    ],
  },
  {
    param: "status", label: "Status",
    options: [
      { label: "Recruiting", value: "RECRUITING" }, { label: "Completed", value: "COMPLETED" },
      { label: "Active", value: "ACTIVE_NOT_RECRUITING" }, { label: "Terminated", value: "TERMINATED" },
      { label: "Not Yet Open", value: "NOT_YET_RECRUITING" }, { label: "Withdrawn", value: "WITHDRAWN" },
    ],
  },
  {
    param: "condition", label: "Condition",
    options: [
      { label: "Alzheimer's", value: "Alzheimer" }, { label: "Breast Cancer", value: "Breast Cancer" },
      { label: "Lung Cancer", value: "Lung Cancer" }, { label: "Ovarian Cancer", value: "Ovarian Cancer" },
      { label: "Diabetes", value: "Diabetes" }, { label: "Heart Failure", value: "Heart Failure" },
      { label: "Hypertension", value: "Hypertension" }, { label: "COVID-19", value: "COVID" },
      { label: "Depression", value: "Depression" }, { label: "Schizophrenia", value: "Schizophrenia" },
      { label: "Parkinson's", value: "Parkinson" }, { label: "Multiple Sclerosis", value: "Multiple Sclerosis" },
      { label: "HIV/AIDS", value: "HIV" }, { label: "Rheumatoid Arthritis", value: "Rheumatoid Arthritis" },
      { label: "Asthma", value: "Asthma" }, { label: "Cancer (general)", value: "Cancer" },
    ],
  },
  {
    param: "intervention", label: "Intervention",
    options: [
      { label: "Immunotherapy", value: "immunotherapy" }, { label: "Chemotherapy", value: "chemotherapy" },
      { label: "Vaccine", value: "vaccine" }, { label: "Gene Therapy", value: "gene therapy" },
      { label: "Placebo", value: "placebo" },
    ],
  },
  {
    param: "sponsor", label: "Sponsor",
    options: [
      { label: "Pfizer", value: "Pfizer" }, { label: "Novartis", value: "Novartis" },
      { label: "Roche", value: "Roche" }, { label: "Merck", value: "Merck" },
      { label: "NIH", value: "National Institute" }, { label: "AstraZeneca", value: "AstraZeneca" },
      { label: "J&J / Janssen", value: "Johnson" }, { label: "PPD / Thermo Fisher", value: "PPD" },
    ],
  },
];

/** Preset cross-trial demo queries — mix of SQL filter + graph-native questions.
 *  Graph presets include hardcoded Cypher so they work even when the LLM is unavailable. */
export const TRIAL_QUERIES = [
  {
    id: "g1",
    text: "What conditions are therapeutically adjacent to Breast Cancer?",
    description: "Graph traversal — conditions that share clinical interventions via the trial-drug network",
    tags: ["Graph", "Adjacency", "Oncology"],
    isGraph: true,
    // Optimized: finds top-100 interventions in BC trials first, then traverses — avoids 8k trial fan-out
    cypher: `MATCH (c1:Condition {name: 'Breast Cancer'})<-[:TREATS]-(t:Trial)-[:USES]->(i:Intervention)
WITH i, COUNT(t) AS bc_count ORDER BY bc_count DESC LIMIT 100
MATCH (i)<-[:USES]-(t2:Trial)-[:TREATS]->(c2:Condition)
WHERE c2.name <> 'Breast Cancer'
WITH c2.name AS condition, COUNT(DISTINCT i) AS shared_interventions
RETURN condition, shared_interventions
ORDER BY shared_interventions DESC
LIMIT 20`,
  },
  {
    id: "g2",
    text: "What are the top expansion opportunities for Pfizer based on their portfolio?",
    description: "Missing-edge detection — conditions adjacent to Pfizer's portfolio where they have zero trials",
    tags: ["Graph", "Strategic Gaps", "Pfizer"],
    isGraph: true,
    cypher: `MATCH (s:Sponsor {name: 'Pfizer'})-[:RUNS]->(t:Trial)-[:TREATS]->(my:Condition)
WITH COLLECT(DISTINCT my.name) AS myNames
UNWIND myNames AS mn
MATCH (mc:Condition {name: mn})<-[:TREATS]-(t2:Trial)-[:TREATS]->(gap:Condition)
WHERE NOT gap.name IN myNames
WITH gap.name AS expansion_target, COUNT(DISTINCT t2) AS adjacency_strength,
     COLLECT(DISTINCT mn)[0..3] AS via_conditions
RETURN expansion_target, adjacency_strength, via_conditions
ORDER BY adjacency_strength DESC
LIMIT 20`,
  },
  {
    id: "g3",
    text: "Which sponsors have the most trials in Phase 3 oncology?",
    description: "Graph aggregation — sponsor trial counts for Phase 3 cancer studies",
    tags: ["Graph", "Sponsors", "Phase 3"],
    isGraph: true,
    cypher: `MATCH (s:Sponsor)-[:RUNS]->(t:Trial)-[:TREATS]->(c:Condition)
WHERE t.phase = 'PHASE3'
AND (toLower(c.name) CONTAINS 'cancer' OR toLower(c.name) CONTAINS 'carcinoma'
     OR toLower(c.name) CONTAINS 'leukemia' OR toLower(c.name) CONTAINS 'lymphoma'
     OR toLower(c.name) CONTAINS 'melanoma' OR toLower(c.name) CONTAINS 'neoplasm')
WITH s.name AS sponsor, COUNT(DISTINCT t) AS trials
RETURN sponsor, trials
ORDER BY trials DESC
LIMIT 25`,
  },
  {
    id: "g4",
    text: "What interventions are shared between Alzheimer Disease and Parkinson Disease?",
    description: "Drug repurposing signal — interventions used in trials for both conditions",
    tags: ["Graph", "Repurposing", "CNS"],
    isGraph: true,
    cypher: `MATCH (t1:Trial)-[:TREATS]->(c1:Condition), (t1)-[:USES]->(iv:Intervention)
WHERE toLower(c1.name) CONTAINS 'alzheimer'
WITH iv, COUNT(DISTINCT t1) AS alzheimer_trials
MATCH (t2:Trial)-[:USES]->(iv), (t2)-[:TREATS]->(c2:Condition)
WHERE toLower(c2.name) CONTAINS 'parkinson'
WITH iv.name AS intervention, alzheimer_trials, COUNT(DISTINCT t2) AS parkinson_trials
RETURN intervention, alzheimer_trials, parkinson_trials
ORDER BY alzheimer_trials + parkinson_trials DESC
LIMIT 20`,
  },
  {
    id: "g5",
    text: "Which conditions have the highest trial termination rates?",
    description: "Operational risk — conditions where trials are most likely to be terminated early",
    tags: ["Graph", "Risk", "Termination"],
    isGraph: true,
    cypher: `MATCH (c:Condition)<-[:TREATS]-(t:Trial)
WITH c.name AS condition,
     count(t) AS total,
     sum(CASE WHEN t.status = 'TERMINATED' THEN 1 ELSE 0 END) AS terminated
WHERE total >= 100
RETURN condition, total, terminated,
       round(100.0 * terminated / total) AS termination_pct
ORDER BY termination_pct DESC
LIMIT 20`,
  },
  {
    id: "g6",
    text: "Which ATC drug classes are used most in oncology trials?",
    description: "Classification traversal — MedDRA therapeutic area → conditions → trials → ATC drug classes",
    tags: ["Graph", "Classification", "ATC", "MedDRA"],
    isGraph: true,
    cypher: `MATCH (ta:TherapeuticArea)<-[:IN_THERAPEUTIC_AREA]-(c:Condition)<-[:TREATS]-(t:Trial)-[:USES]->(i:Intervention)-[:CLASSIFIED_AS]->(dc:DrugClass)
WHERE ta.name CONTAINS 'Neoplasms'
WITH dc.name AS drug_class, COUNT(DISTINCT t) AS trials, COUNT(DISTINCT i) AS interventions,
     COLLECT(DISTINCT c.name)[0..3] AS sample_conditions
RETURN drug_class, trials, interventions, sample_conditions
ORDER BY trials DESC
LIMIT 20`,
  },
  {
    id: "t1",
    text: "Phase 3 Alzheimer's trials",
    description: "Cross-study CNS pipeline — 500+ studies in the KG",
    tags: ["Filter", "Phase 3", "Alzheimer"],
  },
  {
    id: "t2",
    text: "Recruiting breast cancer immunotherapy trials",
    description: "Active oncology trials with immunotherapy interventions",
    tags: ["Filter", "Recruiting", "Oncology"],
  },
];
