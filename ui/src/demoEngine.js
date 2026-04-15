/**
 * Semantic query engine that uses the CDISC Knowledge Graph to resolve
 * plain-English clinical questions into precise SDTM filters, then
 * executes them against embedded CDISCPILOT01 trial data.
 */
import staticData from "./graphData.json";
import pilotData from "./pilotData.json";

const DOMAINS_MAP = staticData.domains;

// Build variable lookup: { "AE.AESEV": { name, label, codelist, ... } }
const VAR_META = {};
for (const [domCode, dom] of Object.entries(DOMAINS_MAP)) {
  for (const v of dom.variables) {
    VAR_META[`${domCode}.${v.name}`] = { ...v, domain: domCode };
  }
}

// Build codelist lookup: { "SEV": { name, values: [...] } }
const CODELIST_MAP = {};
for (const dom of Object.values(DOMAINS_MAP)) {
  for (const v of dom.variables) {
    if (v.codelist && !CODELIST_MAP[v.codelist.id]) {
      CODELIST_MAP[v.codelist.id] = v.codelist;
    }
  }
}

// DM lookup by USUBJID for enrichment
const DM_BY_SUBJ = {};
for (const row of pilotData.DM) {
  DM_BY_SUBJ[row.USUBJID] = row;
}

// ── Semantic concept mapping ────────────────────────────────────────────
// Maps natural language concepts to SDTM variables + filter values.
// This is the "KG as semantic layer" — the magic that makes AI not stupid.
const CONCEPT_MAP = [
  // Severity
  {
    patterns: [/severe/i],
    domain: "AE",
    variable: "AESEV",
    values: ["SEVERE"],
    concept: "Severe adverse events",
    kgPath: "AE → AESEV → Severity/Intensity Scale → SEVERE",
  },
  {
    patterns: [/moderate/i],
    domain: "AE",
    variable: "AESEV",
    values: ["MODERATE"],
    concept: "Moderate adverse events",
    kgPath: "AE → AESEV → Severity/Intensity Scale → MODERATE",
  },
  {
    patterns: [/mild/i],
    domain: "AE",
    variable: "AESEV",
    values: ["MILD"],
    concept: "Mild adverse events",
    kgPath: "AE → AESEV → Severity/Intensity Scale → MILD",
  },
  {
    patterns: [/moderate\s+(or|and)\s+severe/i, /moderate.*severe/i],
    domain: "AE",
    variable: "AESEV",
    values: ["MODERATE", "SEVERE"],
    concept: "Moderate or severe adverse events",
    kgPath: "AE → AESEV → Severity/Intensity Scale → MODERATE, SEVERE",
    priority: 10,
  },

  // Seriousness
  {
    patterns: [/serious/i, /\bSAE\b/i],
    domain: "AE",
    variable: "AESER",
    values: ["Y"],
    concept: "Serious adverse events (SAEs)",
    kgPath: "AE → AESER → No Yes Response → Y",
  },

  // Drug relationship
  {
    patterns: [/drug.?related/i, /related\s+to\s+(study\s+)?(drug|treatment|medication)/i, /treatment.?related/i],
    domain: "AE",
    variable: "AEREL",
    values: ["POSSIBLY RELATED", "PROBABLY RELATED", "DEFINITELY RELATED"],
    concept: "Drug-related (possibly, probably, or definitely)",
    kgPath: "AE → AEREL → Causality → POSSIBLY/PROBABLY/DEFINITELY RELATED",
  },
  {
    patterns: [/definitely\s+related/i],
    domain: "AE",
    variable: "AEREL",
    values: ["DEFINITELY RELATED"],
    concept: "Definitely drug-related",
    kgPath: "AE → AEREL → Causality → DEFINITELY RELATED",
  },
  {
    patterns: [/probably\s+related/i],
    domain: "AE",
    variable: "AEREL",
    values: ["PROBABLY RELATED"],
    concept: "Probably drug-related",
    kgPath: "AE → AEREL → Causality → PROBABLY RELATED",
  },

  // Outcome
  {
    patterns: [/fatal/i, /died/i, /death/i],
    domain: "AE",
    variable: "AEOUT",
    values: ["FATAL"],
    concept: "Fatal outcome",
    kgPath: "AE → AEOUT → Outcome of Event → FATAL",
  },
  {
    patterns: [/recover/i, /resolved/i],
    domain: "AE",
    variable: "AEOUT",
    values: ["RECOVERED"],
    concept: "Recovered/Resolved",
    kgPath: "AE → AEOUT → Outcome of Event → RECOVERED",
  },
  {
    patterns: [/ongoing/i, /not\s+resolved/i],
    domain: "AE",
    variable: "AEONGO",
    values: ["Y"],
    concept: "Ongoing (not resolved)",
    kgPath: "AE → AEONGO → No Yes Response → Y",
  },

  // Body system
  {
    patterns: [/cardiac/i, /heart/i],
    domain: "AE",
    variable: "AEBODSYS",
    values: ["Cardiac disorders"],
    concept: "Cardiac body system",
    kgPath: 'AE → AEBODSYS → MedDRA SOC → "Cardiac disorders"',
  },
  {
    patterns: [/nervous\s+system/i, /neuro/i],
    domain: "AE",
    variable: "AEBODSYS",
    values: ["Nervous system disorders"],
    concept: "Nervous system body system",
    kgPath: 'AE → AEBODSYS → MedDRA SOC → "Nervous system disorders"',
  },
  {
    patterns: [/gastrointestinal|GI\b|stomach|digest/i],
    domain: "AE",
    variable: "AEBODSYS",
    values: ["Gastrointestinal disorders"],
    concept: "Gastrointestinal body system",
    kgPath: 'AE → AEBODSYS → MedDRA SOC → "Gastrointestinal disorders"',
  },
  {
    patterns: [/infection/i],
    domain: "AE",
    variable: "AEBODSYS",
    values: ["Infections and infestations"],
    concept: "Infections body system",
    kgPath: 'AE → AEBODSYS → MedDRA SOC → "Infections and infestations"',
  },
  {
    patterns: [/skin|derma/i],
    domain: "AE",
    variable: "AEBODSYS",
    values: ["Skin and subcutaneous tissue disorders"],
    concept: "Skin body system",
    kgPath: 'AE → AEBODSYS → MedDRA SOC → "Skin and subcutaneous tissue disorders"',
  },

  // Treatment arm
  {
    patterns: [/placebo/i],
    domain: "DM",
    variable: "ARM",
    values: ["Placebo"],
    concept: "Placebo arm",
    kgPath: "DM → ARM → Planned Arm → Placebo",
  },
  {
    patterns: [/treatment\s*a\b/i, /\bTRTA\b/i],
    domain: "DM",
    variable: "ARM",
    values: ["Treatment A"],
    concept: "Treatment A arm",
    kgPath: "DM → ARM → Planned Arm → Treatment A",
  },
  {
    patterns: [/treatment\s*b\b/i, /\bTRTB\b/i],
    domain: "DM",
    variable: "ARM",
    values: ["Treatment B"],
    concept: "Treatment B arm",
    kgPath: "DM → ARM → Planned Arm → Treatment B",
  },
  {
    patterns: [/active\s+treatment/i, /treated\s+patients/i],
    domain: "DM",
    variable: "ARM",
    values: ["Treatment A", "Treatment B"],
    concept: "Active treatment (A or B)",
    kgPath: "DM → ARM → Planned Arm → Treatment A, Treatment B",
  },

  // Demographics
  {
    patterns: [/\bmale\b/i, /\bmen\b/i],
    domain: "DM",
    variable: "SEX",
    values: ["M"],
    concept: "Male subjects",
    kgPath: "DM → SEX → Sex → M",
  },
  {
    patterns: [/\bfemale\b/i, /\bwomen\b/i],
    domain: "DM",
    variable: "SEX",
    values: ["F"],
    concept: "Female subjects",
    kgPath: "DM → SEX → Sex → F",
  },
  {
    patterns: [/\b(old|elder|age\s*>\s*50|over\s+50)\b/i],
    domain: "DM",
    variable: "AGE",
    values: [">50"],
    concept: "Elderly (age > 50)",
    kgPath: "DM → AGE → Age → >50",
    filterFn: (row) => row.AGE > 50,
  },
  {
    patterns: [/\b(young|age\s*<\s*25|under\s+25)\b/i],
    domain: "DM",
    variable: "AGE",
    values: ["<25"],
    concept: "Young (age < 25)",
    kgPath: "DM → AGE → Age → <25",
    filterFn: (row) => row.AGE < 25,
  },
];

/**
 * Resolve a natural language query into semantic concepts using KG metadata.
 * Returns { resolutions: [...], filters: {...}, domain: "AE"|"DM" }
 */
export function resolveQuery(queryText) {
  const resolutions = [];
  const matched = new Set();

  // Sort by priority (higher first) to match composite patterns first
  const sorted = [...CONCEPT_MAP].sort((a, b) => (b.priority || 0) - (a.priority || 0));

  for (const concept of sorted) {
    // Skip if we already matched this variable with higher priority
    const key = `${concept.domain}.${concept.variable}:${concept.values.join(",")}`;
    if (matched.has(key)) continue;

    for (const pat of concept.patterns) {
      if (pat.test(queryText)) {
        resolutions.push({
          concept: concept.concept,
          domain: concept.domain,
          variable: concept.variable,
          variableLabel: VAR_META[`${concept.domain}.${concept.variable}`]?.label || concept.variable,
          values: concept.values,
          kgPath: concept.kgPath,
          filterFn: concept.filterFn || null,
        });
        matched.add(key);
        // Also mark the base variable so lower-priority matches don't duplicate
        matched.add(`${concept.domain}.${concept.variable}`);
        break;
      }
    }
  }

  // Determine primary domain
  const domainCounts = {};
  for (const r of resolutions) {
    domainCounts[r.domain] = (domainCounts[r.domain] || 0) + 1;
  }
  const primaryDomain = Object.entries(domainCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || "AE";

  return { resolutions, primaryDomain };
}

/**
 * Execute the resolved filters against the embedded CDISCPILOT01 data.
 * Returns { results: [...], totalMatches: number, querySteps: [...] }
 */
export function executeQuery(resolutions, primaryDomain) {
  const aeData = pilotData.AE;
  const dmData = pilotData.DM;

  // Separate filters by domain
  const aeFilters = resolutions.filter((r) => r.domain === "AE");
  const dmFilters = resolutions.filter((r) => r.domain === "DM");

  // Get DM-qualified subjects
  let qualifiedSubjects = null;
  if (dmFilters.length > 0) {
    qualifiedSubjects = new Set(
      dmData
        .filter((row) => {
          return dmFilters.every((f) => {
            if (f.filterFn) return f.filterFn(row);
            return f.values.some((v) => String(row[f.variable]) === v);
          });
        })
        .map((r) => r.USUBJID)
    );
  }

  // Filter AE data
  let results;
  if (primaryDomain === "AE" || aeFilters.length > 0) {
    results = aeData.filter((row) => {
      // DM qualification
      if (qualifiedSubjects && !qualifiedSubjects.has(row.USUBJID)) return false;
      // AE filters
      return aeFilters.every((f) => {
        if (f.filterFn) return f.filterFn(row);
        return f.values.some((v) => {
          const rowVal = String(row[f.variable] || "");
          return rowVal === v || rowVal.includes(v);
        });
      });
    });

    // Enrich with DM data
    results = results.map((r) => ({
      ...r,
      _dm: DM_BY_SUBJ[r.USUBJID] || {},
    }));
  } else {
    // DM-only query
    results = (qualifiedSubjects
      ? dmData.filter((r) => qualifiedSubjects.has(r.USUBJID))
      : dmData
    ).map((r) => ({ ...r, _dm: r }));
  }

  // Build query steps narrative
  const querySteps = [];
  for (const r of resolutions) {
    querySteps.push({
      step: "KG Lookup",
      description: `"${r.concept}" → ${r.variable} = ${r.values.join(" | ")}`,
      kgPath: r.kgPath,
      variable: r.variable,
      variableLabel: r.variableLabel,
      values: r.values,
    });
  }
  querySteps.push({
    step: "Execute",
    description: `Filter ${primaryDomain} domain → ${results.length} rows matched`,
  });

  return { results, totalMatches: results.length, querySteps, primaryDomain };
}

/**
 * Build lineage for a single result row — traces each field back to its source.
 */
export function buildLineage(row, resolutions) {
  const lineage = [];
  const dm = row._dm || DM_BY_SUBJ[row.USUBJID] || {};

  // Subject identity
  lineage.push({
    layer: "Subject",
    field: "USUBJID",
    value: row.USUBJID,
    source: "DM domain",
    description: `Subject ${row.USUBJID} from ${dm.SITE || "unknown site"}`,
  });

  // Demographics context
  if (dm.AGE) {
    lineage.push({
      layer: "Demographics",
      field: "AGE / SEX / RACE",
      value: `${dm.AGE}y ${dm.SEX} ${dm.RACE}`,
      source: "DM domain",
      description: `${dm.AGE} year old ${dm.SEX === "F" ? "female" : "male"}, ${dm.RACE}`,
    });
  }
  if (dm.ARM) {
    lineage.push({
      layer: "Treatment",
      field: "ARM",
      value: dm.ARM,
      source: "DM domain",
      description: `Randomized to ${dm.ARM} (${dm.ARMCD})`,
    });
  }

  // AE-specific fields
  if (row.AEDECOD) {
    lineage.push({
      layer: "Event",
      field: "AETERM / AEDECOD",
      value: row.AEDECOD,
      source: "AE domain (CRF)",
      description: `Reported: "${row.AETERM}" → Coded: "${row.AEDECOD}"`,
    });
    lineage.push({
      layer: "Classification",
      field: "AEBODSYS",
      value: row.AEBODSYS,
      source: "MedDRA coding",
      description: `Body system: ${row.AEBODSYS}`,
    });
  }

  // Matched filter fields
  for (const r of resolutions) {
    if (r.domain === "AE" && row[r.variable] !== undefined) {
      lineage.push({
        layer: "Filter Match",
        field: r.variable,
        value: String(row[r.variable]),
        source: `KG codelist → ${r.variableLabel}`,
        description: `${r.variableLabel}: ${row[r.variable]} (matched "${r.concept}")`,
        isMatch: true,
      });
    }
  }

  // Timing
  if (row.AESTDT) {
    lineage.push({
      layer: "Timing",
      field: "AESTDT → AEENDT",
      value: `${row.AESTDT} → ${row.AEENDT || "ongoing"}`,
      source: "AE domain",
      description: `Study day ${row.AESTDY} to ${row.AEENDY || "ongoing"} (${row.AEENDY && row.AESTDY ? row.AEENDY - row.AESTDY + 1 : "?"} days)`,
    });
  }

  // Outcome
  if (row.AEOUT) {
    lineage.push({
      layer: "Outcome",
      field: "AEOUT",
      value: row.AEOUT,
      source: "AE domain",
      description: `Outcome: ${row.AEOUT}`,
    });
  }

  return lineage;
}

/** Preset demo queries — the "money shots" */
export const DEMO_QUERIES = [
  {
    id: "q1",
    text: "Show me all patients with moderate or severe drug-related adverse events",
    description: "The classic: severity + causality across the AE domain",
    tags: ["AE", "Severity", "Causality"],
  },
  {
    id: "q2",
    text: "Which patients had serious adverse events?",
    description: "SAE identification — critical for safety reporting",
    tags: ["AE", "Seriousness"],
  },
  {
    id: "q3",
    text: "Show cardiac adverse events in the active treatment group",
    description: "Body system + treatment arm — cross-domain KG resolution",
    tags: ["AE", "Body System", "DM"],
  },
  {
    id: "q4",
    text: "Find severe adverse events in female patients over 50",
    description: "Age + sex + severity — demographics meets safety",
    tags: ["AE", "DM", "Severity"],
  },
  {
    id: "q5",
    text: "Show ongoing drug-related adverse events in the placebo group",
    description: "Outcome + causality + arm — triple KG resolution",
    tags: ["AE", "Causality", "DM"],
  },
];
