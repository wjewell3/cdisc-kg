# Clinical Trials Knowledge Graph

A knowledge-graph-powered operational intelligence platform for clinical trials, built on 580k+ studies from [AACT](https://aact.ctti-clinicaltrials.org/) (ClinicalTrials.gov). Live at **[cdisc-kg.vercel.app](https://cdisc-kg.vercel.app)**.

## Vision

Clinical trial data sits in siloed tables — studies, facilities, designs, eligibility, dropouts, countries. This platform encodes **clinical and operational processes** as a knowledge graph and surfaces actionable intelligence from it. The goal is not just search — it's answering questions like:

- "What's the real termination rate for Phase 3 oncology trials, and why do they fail?"
- "Which sponsors have the best completion rates for trials in my therapeutic area?"
- "How does enrollment ambition compare to historical actuals for this design type?"
- "Where are the geographic concentrations and gaps in site activation?"

The KG layer connects every data element — sponsor, condition, intervention, phase, status, enrollment, sites, design, eligibility, dropouts, duration, outcomes — so that slicing on any dimension reveals operational patterns across all others.

## Target Role Alignment

This project demonstrates competencies for a **Data Domain Manager, Trial Data** role (PPD / Thermo Fisher Scientific) — the hands-on owner of a clinical trial data domain who drives trusted, interoperable, AI-ready data for product and analytics use cases.

### Competencies Demonstrated

| Competency | How It's Shown |
|---|---|
| **Domain Strategy & Roadmapping** | 11-table AACT domain with nightly refresh pipeline, prioritized by operational value |
| **Data Modeling & Semantics** | Normalized SQLite schema with FTS5 index, faceted aggregation engine, enrollment bucketing, phase/status normalization via DQ rules |
| **Data Quality & Governance** | Natural-language DQ Rules Manager — grouping rules, enrollment bounds, defect taxonomy. Rules persist and apply to all downstream analytics |
| **Clinical Domain Expertise** | Trial risk scoring benchmarked against condition+phase comparables; dropout analysis; design complexity signals; operational KPIs (completion rate, duration, enrollment ambition) |
| **Data Storytelling & Influence** | Interactive cross-filter charts with reactive stats banner; GPT-4.1 strategic briefings that translate data patterns into plain-English operational narratives |
| **Stakeholder Engagement** | Self-service UI — no SQL required. Click any chart bar to slice the entire dataset; click any trial to get a risk briefing |
| **Data Lineage & Traceability** | End-to-end pipeline from AACT PostgreSQL → K8s CronJob → SQLite snapshot → FTS/aggregation engine → Neo4j knowledge graph → Cytoscape.js visualization → GPT-4.1 briefings. Every query result is traceable back through the chain |
| **Innovation & AI Readiness** | NL→Cypher graph queries, GPT-4.1 strategic briefings, NL→structured DQ rule parser, real-time risk scoring. Platform designed as an AI-ready semantic layer — structured for LLM consumption and agent orchestration |

## Data Lineage

The platform implements full end-to-end data lineage — every insight is traceable from raw source through transformation to consumption:

```
AACT PostgreSQL (ClinicalTrials.gov)     ← Authoritative source
  │
  ▼  K8s CronJob (2AM UTC, nightly)
 SQLite Snapshot (11 tables, 50 GB PVC)   ← Operational store
  │
  ├─▶ FTS5 full-text index               ← Search layer
  ├─▶ Faceted aggregation engine          ← Analytics layer
  ├─▶ DQ rules engine                     ← Governance layer
  │
  ▼  Graph ETL (580k trials)
 Neo4j 5.26 Knowledge Graph               ← Semantic layer
  │  Trial(580k) + Intervention(512k) + Condition(129k)
  │  + Sponsor(50k) + Country(225)
  │
  ├─▶ Cytoscape.js graph visualization    ← Exploration
  ├─▶ NL → Cypher query translation       ← Self-service access
  └─▶ GPT-4.1 strategic briefings         ← AI consumption
```

## Semantic Layer & Metadata Catalog

The **Neo4j knowledge graph** serves as the semantic layer — encoding clinical and operational relationships (trial→sponsor, trial→condition, trial→intervention, trial→country) as first-class graph edges rather than foreign-key joins. This makes the data self-describing: every entity carries its operational context (completion rates, enrollment patterns, risk profiles) and is connected to every related entity.

The **CDISC SDTM IG v3.4 standards graph** provides the regulatory metadata layer — encoding domains, variables, codelists, value-level metadata, and their relationships. The platform surfaces this as:

- **Data Catalog** (Browse tab) — searchable catalog of SDTM domains with variable definitions, core status, codelists, and business descriptions
- **Standards Q&A** — natural-language queries against the standards graph
- **SDTM Training** — interactive tutorial for SDTM domain structure and naming conventions

Together, these layers provide both the operational data semantics (Neo4j trials graph) and the regulatory metadata semantics (CDISC standards graph) that a Data Domain Manager needs to own.

## Data Domain: What's in the KG

### Tables Ingested (SQLite snapshot, refreshed nightly)

| Table | What It Encodes | Rows |
|---|---|---|
| `studies` | Core trial record — ID, title, phase, status, enrollment, dates, DMC flag, stop reason | 580k |
| `conditions` | Disease/condition links per trial | ~1.1M |
| `interventions` | Drug/device/procedure links per trial | ~1.2M |
| `sponsors` | Lead sponsor per trial | ~580k |
| `brief_summaries` | Trial description text (used for FTS) | ~580k |
| `calculated_values` | Derived operational metrics — facility count, actual duration, reporting time, SAE/NSAE subjects, age range, outcome counts, US facility flag | ~580k |
| `facilities` | Site records — name, city, state, country, lat/lng, status | ~3.4M |
| `designs` | Study design — allocation, masking, intervention model, primary purpose | ~580k |
| `drop_withdrawals` | Dropout reasons and counts by period | ~1.5M |
| `countries` | Countries where trial runs | ~900k |
| `eligibilities` | Age range, gender, healthy volunteers, criteria text, age group flags | ~580k |

### Operational Dimensions Currently Surfaced in UI

| Dimension | Where It Appears |
|---|---|
| Phase, Status, Sponsor, Condition, Intervention | Cross-filter charts + stats banner |
| Enrollment size | Histogram chart with bucketed ranges |
| Completion rate | Stats banner (reactive to filters, with delta vs baseline) |
| Active trial % | Stats banner |
| Avg enrollment | Stats banner |
| Trial duration | Trial Intelligence briefing |
| Termination rate | Trial risk scoring (benchmarked) |
| Dropout reasons | Trial Intelligence briefing |
| Design complexity | Trial risk score factor |
| Eligibility complexity | Trial risk score factor |
| Site/facility count | Trial risk score factor |
| Countries | Trial Intelligence briefing |

### Dimensions Ingested but NOT Yet Surfaced — Roadmap

| Dimension | Source | Planned Surface |
|---|---|---|
| **Avg duration by phase/therapeutic area** | `calculated_values.actual_duration` | Operational KPI chart — heatmap or grouped bars |
| **Termination rate by therapeutic area** | `studies.overall_status` + `conditions` | Operational KPI chart — which disease areas have highest failure rates |
| **Enrollment ambition vs actuals** | `studies.enrollment` + `enrollment_type` (anticipated vs actual) | Scatter or comparison chart |
| **Age range / demographics** | `calculated_values.minimum_age_num`, `maximum_age_num` | Chart facet — filter by pediatric/adult/geriatric |
| **SAE subject counts** | `calculated_values.number_of_sae_subjects`, `number_of_nsae_subjects` | Safety signal dimension — high SAE sponsors/conditions |
| **Outcome count** | `calculated_values.number_of_primary/secondary_outcomes_to_measure` | Complexity signal — trials measuring many endpoints |
| **US vs international** | `calculated_values.has_us_facility` | Geographic filter toggle |
| **Single vs multi-site** | `calculated_values.has_single_facility` | Operational complexity filter |
| **Results reporting lag** | `calculated_values.months_to_report_results` | Compliance KPI — which sponsors/phases report fastest |
| **Geographic site density** | `facilities` lat/lng | Map visualization — site concentration by region |
| **Dropout rate by reason** | `drop_withdrawals` aggregated | Operational KPI — which reasons dominate by phase/condition |

### AACT Tables Not Yet Ingested — Future Expansion

| Table | What It Would Add |
|---|---|
| `milestones` | Enrollment velocity — actual participant flow over time |
| `participant_flows` | Detailed cohort progression through trial stages |
| `outcomes` | Endpoint results — efficacy/safety data post-completion |
| `reported_events` | Adverse event details |
| `result_groups` | Arm-level result groupings |
| `baseline_measurements` | Baseline demographics of enrolled participants |
| `design_outcomes` | Primary/secondary outcome definitions |
| `design_groups` | Arm/group definitions and counts |

## Architecture

```
cdisc-kg/
├── ui/                        # React + Vite frontend (Vercel)
│   └── src/
│       ├── App.jsx            # Route/tab orchestration — Trial Intelligence (default), Standards Graph, Data Catalog, Standards Q&A, SDTM Training, Demo
│       ├── TrialsPanel.jsx    # Main search + cross-filter chart UI
│       ├── TrialsCharts.jsx   # SVG bar/donut/histogram charts + StatsBanner
│       ├── GraphViz.jsx       # Cytoscape.js trial-graph visualization (Neo4j → browser)
│       ├── RulesManager.jsx   # DQ rules: grouping normalization, enrollment bounds
│       ├── TreeView.jsx       # SDTM standards data catalog (Browse tab)
│       ├── QueryPanel.jsx     # NL → standards graph Q&A
│       ├── TutorPanel.jsx     # SDTM training module
│       ├── InsightPanel.jsx   # Entity-level operational insight (available, not wired)
│       ├── SiteIntelligence.jsx # Site search + deep profile (available, not wired)
│       └── trialsEngine.js    # API client (fetch wrappers for all modes)
├── api/                       # Vercel serverless functions (HTTPS proxy → OKE)
│   ├── trials.js              # /api/trials → OKE server
│   ├── intelligence.js        # /api/intelligence → trial-intelligence
│   ├── entity-insight.js      # /api/entity-insight → OKE
│   ├── entity-intelligence.js # /api/entity-intelligence → OKE
│   ├── site-search.js         # /api/site-search → OKE (PG fallback)
│   ├── site-profile.js        # /api/site-profile → OKE (PG fallback)
│   ├── trial-risk.js          # /api/trial-risk → OKE
│   ├── graph.js               # /api/graph → Neo4j graph endpoints (GET proxy)
│   ├── graph-query.js         # /api/graph-query → NL→Cypher pipeline (POST)
│   └── dq.js                  # /api/dq/parse-rule → LLM rule parser
├── server/                    # Express API on OKE (ARM64)
│   ├── index.js               # All endpoints (see API section)
│   ├── snapshot.js            # AACT → SQLite snapshot builder (k8s CronJob)
│   └── Dockerfile
├── k8s/                       # Kubernetes manifests
│   ├── deployment.yaml        # trials-api Deployment + Service + LoadBalancer
│   ├── cronjob.yaml           # Nightly AACT → SQLite snapshot (2AM UTC, 5h timeout)
│   ├── secret.yaml            # aact-credentials
│   └── sqlite-debug-pod.yaml  # Read-only debug pod for ad-hoc SQL
└── .github/workflows/
    └── build-server.yml       # ARM64 Docker image build on push to server/**
```

## Server API

Base URL (OKE): `http://129.80.137.184:3001`
Proxied via Vercel: `https://cdisc-kg.vercel.app/api/...`

### Search & Aggregation

| Endpoint | Description |
|---|---|
| `GET /api/trials?mode=search` | Full-text + faceted trial search. Params: `q`, `phase`, `status`, `sponsor`, `condition`, `intervention`, `min_enrollment`, `max_enrollment`, `limit` |
| `GET /api/trials?mode=stats` | Faceted aggregation — phase, status, sponsor top-20, condition top-20, intervention top-20, enrollment buckets. Each dimension excludes its own filter |
| `GET /api/trials?mode=sponsors` | Searchable sponsor list with counts (`sponsor_q` for type-ahead) |
| `GET /api/trials?mode=conditions` | Searchable condition list with counts |
| `GET /api/trials?mode=interventions` | Searchable intervention list with counts |

### Operational Intelligence

| Endpoint | Description |
|---|---|
| `GET /api/trial-intelligence?nct_id=...` | Single-trial deep analysis: comparable benchmarks (termination rate, duration P25/P50/P75, enrollment delta), dropout reasons, countries, design, eligibility + GPT-4.1 risk briefing |
| `GET /api/trial-risk?nct_id=...` | Risk score 0–100 with labeled factors: termination rate, enrollment ambition, site count, design complexity, eligibility complexity |
| `GET /api/entity-insight?type=...&name=...` | Portfolio analytics for any entity (sponsor/condition/intervention/phase/status/enrollment_range): completion rate, avg enrollment, avg duration, reporting time, cross-dimensional breakdowns, top sites |
| `GET /api/entity-intelligence?type=...&name=...` | Entity insight + GPT-4.1 3-paragraph strategic briefing |

### Site Intelligence

| Endpoint | Description |
|---|---|
| `GET /api/site-search?q=...&country=...` | Search facilities by name + country. Returns grouped sites with trial counts and lat/lng |
| `GET /api/site-profile?name=...&country=...` | Deep site dossier: trial portfolio, phases, statuses, conditions, sponsors, completion rate, duration, SAE subjects, dropout reasons, recent trials |

### Data Quality

| Endpoint | Description |
|---|---|
| `POST /api/dq/parse-rule` | Natural-language → structured DQ rule via LLM (grouping rules or enrollment bounds) |

### Knowledge Graph (Neo4j)

| Endpoint | Description |
|---|---|
| `GET /api/graph/stats` | Graph DB stats — node/relationship counts by label |
| `GET /api/graph/sponsor-overlap?sponsor=...` | Sponsors sharing conditions/interventions with the given sponsor |
| `GET /api/graph/strategic-gaps?sponsor=...` | Therapeutic areas where a sponsor has no trials but competitors do |
| `GET /api/graph/condition-landscape?condition=...` | All sponsors and interventions for a condition |
| `GET /api/graph/therapeutic-adjacency?condition=...` | Conditions that share interventions (potential repurposing signals) |
| `GET /api/graph/repurposing-path?from=...&to=...` | Shortest graph path between two conditions or interventions |
| `GET /api/graph/sponsor-network?sponsor=...` | Sponsor relationship network via shared conditions/interventions |
| `GET /api/graph/site-risk?...` | Site-level risk metrics |
| `GET /api/graph/site-expertise?...` | Site expertise by therapeutic area |
| `POST /api/graph-query` | NL → Cypher: takes `{ question }`, generates Cypher via LLM, executes against Neo4j, narrates results |

### System

| Endpoint | Description |
|---|---|
| `GET /health` | Backend type, snapshot timestamp, status |

## Infrastructure

- **OKE**: Single ARM64 node (`VM.Standard.A1.Flex`, 4 OCPU / 24 GB), namespace `cdisc-kg`, LB IP `129.80.137.184`
- **Neo4j 5.26**: Graph database on OKE — 580k Trial + 512k Intervention + 129k Condition + 50k Sponsor + 225 Country nodes. ClusterIP service, Cypher endpoint for graph queries
- **SQLite snapshot**: 11 tables on a 50 GB PVC (`/data/aact.db`), refreshed nightly at 2AM UTC (5h timeout). Server falls back to live AACT PostgreSQL if snapshot missing
- **CI**: `ubuntu-24.04-arm` GitHub Actions runner — native ARM64 build, ~2.5 min. Auto-triggers on push to `server/**`
- **Vercel**: Serverless proxy layer + static UI hosting. Deploy with `vercel --prod` from project root
- **LLM**: GPT-4.1 via GitHub Copilot API (`https://api.githubcopilot.com/chat/completions`)

## Local Development

```bash
# Server (requires /data/aact.db or AACT credentials in env)
cd server && node index.js

# UI (proxies /api/* to localhost:3001 via Vite)
cd ui && npm install && npm run dev
```

Set `VITE_TRIALS_API_BASE=http://localhost:3001` in `ui/.env.local` to hit the local server directly.

## Deploying

```bash
# UI + Vercel proxy functions (from project root, NOT home directory)
cd /path/to/cdisc-kg && vercel --prod

# Server image auto-builds via GHA on push to server/**
# To force restart after image update:
kubectl rollout restart deployment/trials-api -n cdisc-kg

# Apply k8s manifest changes
kubectl apply -f k8s/deployment.yaml
```

## SQLite Debug

```bash
kubectl apply -f k8s/sqlite-debug-pod.yaml
kubectl exec -it sqlite-debug -n cdisc-kg -- sqlite3 /data/aact.db
```

Questions for opus:

would it make sense for the visual insights to update based on kg queries or nah?