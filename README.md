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
| Termination rate | Trial risk scoring (benchmarked) + Failure Analysis KPI (by condition/phase) |
| Termination rate by therapeutic area | Operational KPIs → Failure Analysis tab (stop reasons, breakdowns by condition + phase) |
| Sponsor completion rates | Operational KPIs → Sponsor Performance tab (completion rate leaderboard) |
| Enrollment ambition vs actuals | Operational KPIs → Enrollment Benchmark tab (by allocation, masking, intervention model) |
| Dropout reasons | Trial Intelligence briefing |
| Design complexity | Trial risk score factor |
| Eligibility complexity | Trial risk score factor |
| Site/facility count | Trial risk score factor |
| Countries | Trial Intelligence briefing |
| Site portfolio & profile | Site Intelligence tab (search + deep site dossier) |
| Entity insight (any dimension) | InsightPanel (double-click chart bar → portfolio analytics + GPT-4.1 briefing) |

### Dimensions Ingested but NOT Yet Surfaced — Roadmap

| Dimension | Source | Planned Surface |
|---|---|---|
| **Avg duration by phase/therapeutic area** | `calculated_values.actual_duration` | Operational KPI chart — heatmap or grouped bars |
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
│       ├── App.jsx            # Route/tab orchestration — Trial Intelligence (default), Standards Graph (+ embedded Q&A), Data Catalog, SDTM Training, Geography
│       ├── TrialsPanel.jsx    # Main search + Question Launcher + cross-filter charts + KPI panels + KG Q&A + entity insight + graph→filter bridge
│       ├── TrialsCharts.jsx   # SVG bar/donut/histogram charts + StatsBanner (double-click bar → entity insight)
│       ├── OperationalKPIs.jsx # 3-tab panel: Failure Analysis, Sponsor Performance, Enrollment Benchmark
│       ├── GraphViz.jsx       # Cytoscape.js trial-graph visualization (Neo4j → browser)
│       ├── RulesManager.jsx   # DQ rules: grouping normalization, enrollment bounds
│       ├── TreeView.jsx       # SDTM standards data catalog (Browse tab)
│       ├── QueryPanel.jsx     # NL → standards graph Q&A (embedded in Standards Graph sidebar)
│       ├── TutorPanel.jsx     # SDTM training module
│       ├── InsightPanel.jsx   # Entity-level operational insight (wired to TrialsPanel via chart double-click)
│       ├── GeographicIntelligence.jsx # Country/region/site concentration & gaps (top-level tab)
│       └── trialsEngine.js    # API client (fetch wrappers for all modes)
├── api/                       # Vercel serverless functions (HTTPS proxy → OKE, 10 functions for Hobby plan)
│   ├── trials.js              # /api/trials → OKE server
│   ├── intelligence.js        # /api/intelligence → trial-intelligence
│   ├── analytics.js           # /api/analytics?mode=failure-analysis|sponsor-performance|enrollment-benchmark → OKE
│   ├── entity.js              # /api/entity?mode=insight|intelligence → OKE entity endpoints
│   ├── site.js                # /api/site?mode=search|profile → OKE site endpoints
│   ├── trial-risk.js          # /api/trial-risk → OKE
│   ├── graph.js               # /api/graph → Neo4j graph endpoints (GET proxy)
│   ├── graph-query.js         # /api/graph-query → NL→Cypher pipeline (POST)
│   ├── query.js               # /api/query → OKE query proxy
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
| `GET /api/failure-analysis?condition=&phase=&sponsor=&intervention=&min_enrollment=&max_enrollment=` | Termination rate, stop reasons, breakdowns by condition and phase for the filtered cohort |
| `GET /api/sponsor-performance?condition=&phase=&min_trials=` | Sponsor completion-rate leaderboard sorted by % completed, filtered by therapeutic area |
| `GET /api/enrollment-benchmark?condition=&phase=&allocation=&masking=&intervention_model=` | Enrollment ambition vs actuals by design type; summary stats + breakdowns by allocation/masking |
| `GET /api/geographic-intelligence?condition=&phase=&sponsor=&intervention=` | Country/region trial distribution, US vs international split, top sites by volume, regional gap analysis |

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

job description:

Data Domain Manager, Trial Data
Thermo Fisher Scientific
Thermo Fisher Scientific

This job is no longer accepting applications

See open jobs at Thermo Fisher Scientific.
See open jobs similar to "Data Domain Manager, Trial Data" North Carolina Biotechnology Center.

North Carolina, USA

USD 130k-180k / year

Posted on Mar 22, 2026
Work Schedule

Standard (Mon-Fri)
Environmental Conditions

Office
Job Description

At Thermo Fisher’s PPD clinical research business, we’re using digital innovation, data science, and AI to reimagine how life-changing therapies reach patients. Our teams combine deep scientific expertise with advanced analytics, automation, and digital platforms to make research smarter, faster, and more connected.


At PPD we know that innovation happens when diverse minds meet. Our Digital Science, Data, and AI professionals collaborate closely with scientists, clinicians, and operational experts to solve real-world challenges in clinical research. Alongside our partnership with Open AI, you can be part of the collaboration that will help to improve the speed and success of drug development, enabling customers to get medicines to patients faster and more cost effectively.


You’ll join a culture that values experimentation, learning, and collaboration — where your ideas can help shape how we deliver life-saving solutions and improve global health outcomes. Whether you’re a data engineer, product manager, software developer, or AI scientist, you’ll find opportunities here to apply your skills to work that truly matters — improving global health outcomes.


Position Summary
The Data Domain Manager, Trial Data (known internally as an Associate Director, IT) is the hands-on owner for their assigned data domain, driving the day-to-day plan, backlog, and delivery under the direction of the Domain Lead. This role goes deep on sources, flows, lineage, quality rules, and semantic layers to make trusted, interoperable, AI-ready data available for product and analytics use cases.

Reporting to the Trial Data Domain Lead in the CRG Digital Data Capabilities organization, the Data Domain Manager works daily with the Data Solutions Architect while partnering closely with Data Platforms, Data Governance, Digital Products, CRG IT/data owners, and external partners to land designs, resolve data issues fast, and evidence value.

Key Responsibilities
Domain Roadmap Input and Execution

Partner with the Trial Data Domain lead to develop the vision and roadmap for your data domain, aligned with CRG Digital product roadmaps and key strategic initiatives. Drive execution against these prioritized roadmaps to ensure trusted, high-quality data is available at the right time. Proactively plan for future innovations and drive exploration of new capabilities, including potential external commercialization of new internal data products and capabilities. Develop and report on metrics and KPIs for assessing data consumption.

Data Source and Flow Stewardship
Based on the strategic roadmap within assigned domain, define data needs and determine internal data availability. Document source systems, tables, interfaces, and lineage; profile data; define and maintain transformation logic and semantic layers. Maintain the domain in the catalog (business definitions, ownership, lineage, policies, sample queries). Partner with internal stakeholders, Legal, and other teams as needed to address barriers to data access. Contribute to assessments of external partners to address data gaps, and to partnership scoping, business case alignment, negotiations, internal management and external alliance management for external data partners.

Delivery Coordination
Coordinate the technical execution of data delivery within your assigned domain, ensuring that data is available for consumption within CRG Digital’s data platform. Ensure that product/business requirements are translated into technical requirements and that data is appropriately mapped and modeled, applying product management techniques to data models (roadmap, backlog, etc.). Support technical implementation of licensed data products, where relevant, and navigate internal bureaucracy for data contracts, IT access, audits, etc. Coordinate support and usage guidance for integrations of external data products into clinical or analytical services.

Stakeholder, Engagement, Enablement & Reporting
Develop and maintain strong relationships with key stakeholders in CRG divisions to ensure alignment and support for data initiatives. Serve as the voice of your domain to Data Domain and Data Capabilities leadership. Explain solutions to non-technical audiences; train users on how to access and use delivered data assets; capture adoption feedback.

Quality, Governance & Compliance
Implement domain-level data quality rules, monitors, and remediation workflows; contribute to defect taxonomy and root cause analysis. Apply mastering and reference-data rules; coordinate with stewards and the Data Governance team on policy alignment and audits.

Required Qualifications:

Bachelor's degree in Life Sciences, Computer Science, Engineering, or equivalent and relevant formal academic / vocational qualification. Masters preferred.
Previous data engineering/analytics/governance experience with hands-on SQL and modeling experience that provides the knowledge, skills, and abilities to perform the job (comparable to 10 years’ experience)
Proven experience mapping complex source systems, building or specifying pipelines/models, and operating DQ/MDM controls.
Demonstrated success partnering within matrix organizations and external partner teams to deliver complex, regulated data deliverables.
Understanding of clinical trial operations (recruitment, start-up, clinical operations, data management, RBM, safety) and associated regulations.
In some cases, an equivalency, consisting of appropriate education, training, and/or directly related experience will be considered sufficient for an individual to meet the requirements of the role.
Digital Domain Manager Competencies:


Domain Strategy & Roadmapping

Contributes to strategic vision and rolling 12-month plan for the domain, aligned to CRG Digital product roadmaps and enterprise priorities; with Data Domain Lead, continually reprioritizes the portfolio based on impact, risk, and readiness.
Data Modeling & Semantics

Translates business needs into technical requirements; partners with Platforms/Engineering to land models, pipelines, and semantic layers in the data platform.
Data Sourcing & External Partnerships

Analyzes and maps internal sources/flows/lineage and appropriate uses; identifies gaps and helps secure external data through business casing, negotiation, and alliance management.
Governance, Quality & MDM Stewardship

Works with domain data stewards to drive data quality, MDM and governance decisions; partners with the Data Governance Lead to operationalize policy.
Metadata, Catalog & Lineage Ownership

Drives cataloging of assets (in conjunction with Data Governance Lead) with business definitions, lineage, and ownership; maintains reference/canonical semantics.
Stakeholder Engagement & Reporting

Aligns data owners, product owners, and delivery teams without direct authority; drives adoption through narratives, education, and enablement. Provides clear status/risks/metrics to the Domain Lead and product teams; supports demos, readouts, etc.
Partner Management

Holds vendors to outcomes; fosters a collaborative, inclusive, continuous-improvement culture.
Clinical Domain Expertise (Contextual Fluency)

Understands clinical trial operations and related processes (e.g., study start-up, data management, RBM, safety) to ensure data strategy meets real-world needs.
Innovation & Future Readiness

Scans internal/external capabilities; sequences pragmatic pilots that advance interoperability, reusability, and AI enablement; evaluates commercialization where relevant.
Data Storytelling & Influence

Contributes to narratives linking data product delivery to business value.
Preferred Qualifications

Experience in a CRO, eClinical data provider, pharmaceutical/biotech company, or digital health/data startup.
Experience in regulated data environments (e.g., clinical/GxP/Part 11/GDPR/HIPAA).
Existing understanding of data landscape within assigned domain.
Experience in making data AI/ML ready.
At Thermo Fisher Scientific, we are committed to fostering a healthy and harmonious workplace for our employees. We understand the importance of creating an environment that allows individuals to excel. Please see below for the required qualifications for this position, which also includes the possibility of equivalent experience:

Able to communicate, receive, and understand information and ideas with diverse groups of people in a comprehensible and reasonable manner.
Able to work upright and stationary for typical working hours.
Ability to use and learn standard office equipment and technology with proficiency.
Able to perform successfully under pressure while prioritizing and handling multiple projects or activities.
