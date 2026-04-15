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
export async function executeTrialQuery(params, limit = 50) {
  const url = new URL("/api/trials", window.location.origin);
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

/** Preset cross-trial demo queries — all verified to return real AACT data */
export const TRIAL_QUERIES = [
  {
    id: "t1",
    text: "Phase 3 Alzheimer's trials",
    description: "Cross-study CNS pipeline — 500+ studies in the KG",
    tags: ["Phase 3", "CNS", "Alzheimer"],
  },
  {
    id: "t2",
    text: "Recruiting breast cancer immunotherapy trials",
    description: "Active oncology trials with immunotherapy interventions",
    tags: ["Oncology", "Recruiting", "Immunotherapy"],
  },
  {
    id: "t3",
    text: "Completed Phase 3 diabetes trials",
    description: "The metabolic disease evidence base — endpoints + outcomes",
    tags: ["Phase 3", "Completed", "Diabetes"],
  },
  {
    id: "t4",
    text: "Phase 2 lung cancer trials with chemotherapy",
    description: "Early-phase oncology — primary endpoints across studies",
    tags: ["Phase 2", "Oncology", "Chemotherapy"],
  },
  {
    id: "t5",
    text: "Phase 3 heart failure completed trials",
    description: "Cardiovascular evidence base — arms, enrollment, outcomes",
    tags: ["Phase 3", "Cardiovascular", "Completed"],
  },
];
