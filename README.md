# Clinical Trials Explorer

A fast, interactive explorer for all 580k+ studies in [AACT](https://aact.ctti-clinicaltrials.org/) (ClinicalTrials.gov), hosted at **[cdisc-kg.vercel.app](https://cdisc-kg.vercel.app)**.

The main goal is to make it easy to slice and understand the trial landscape for a given disease area or intervention — without needing to know SQL or use the clunky CT.gov UI. The primary entry point is the `/trials` route.

## What it does

- **Browse & search** 580k+ trials by free text, condition, intervention, phase, status, sponsor, or enrollment size
- **Cross-filter charts** — click Phase 1, Recruiting, or a sponsor bar to filter all results; bars never disappear (faceted stats)
- **Sponsor search** — search all sponsors matching your current filters, not just the top 10
- **Trial Intelligence** — click any trial to get an AI-generated briefing: comparable trials, risk signals, and a plain-English summary via GPT-4.1

## Architecture

```
cdisc-kg/
├── ui/                        # React + Vite frontend (Vercel)
│   └── src/
│       ├── TrialsPanel.jsx    # /trials route — main search + chart UI
│       ├── TrialsCharts.jsx   # Cross-filter bar/donut/histogram charts
│       └── trialsEngine.js   # API client (fetch wrappers)
├── api/                       # Vercel serverless functions (HTTPS proxy layer)
│   ├── trials.js              # /api/trials → proxies to OKE server
│   └── intelligence.js        # /api/intelligence → proxies to OKE server
├── server/                    # Express API on OKE (ARM64)
│   ├── index.js               # /api/trials, /api/trial-intelligence, /health
│   ├── snapshot.js            # SQLite snapshot builder (runs as k8s CronJob)
│   └── Dockerfile
├── k8s/                       # Kubernetes manifests
│   ├── deployment.yaml        # trials-api Deployment + Service + LoadBalancer
│   ├── cronjob.yaml           # Nightly AACT → SQLite snapshot refresh
│   ├── namespace.yaml
│   ├── secret.yaml            # aact-credentials (AACT_USER, AACT_PASSWORD, GITHUB_COPILOT_TOKEN)
│   └── sqlite-debug-pod.yaml  # Read-only debug pod for ad-hoc SQL
└── .github/workflows/
    └── build-server.yml       # Builds + pushes server Docker image on push
```

## `/trials` route

The core feature. A full-page search UI backed by a 580k-study SQLite snapshot of AACT.

**Search params** (all combinable):

| Param | Description |
|---|---|
| `q` | Free-text (FTS5 — matches title, conditions, interventions, summary) |
| `condition` | Condition/disease filter (partial match) |
| `intervention` | Intervention name filter (partial match) |
| `phase` | `PHASE1`, `PHASE2`, `PHASE3`, `PHASE4`, `EARLY_PHASE1` |
| `status` | `RECRUITING`, `COMPLETED`, `ACTIVE_NOT_RECRUITING`, etc. |
| `sponsor` | Lead sponsor name (partial match, multi-select) |
| `min_enrollment` / `max_enrollment` | Enrollment size range |

**Chart cross-filtering:** Clicking a bar in Phase, Status, Sponsor, or Enrollment charts re-queries the server with that filter active. Stats use *faceted queries* — each dimension's counts exclude its own filter, so bars always show the full distribution even when one is active.

**Sponsor chart:** Shows top 10 sponsors by default with an "other sponsors" bar representing the remainder. The search box queries all sponsors across the full filtered dataset (server-side, not just top 10).

**Trial Intelligence:** Clicking a trial fetches comparable trials (via FTS5), computes risk signals (early stopping, missing DMC, enrollment gaps), and sends them to GPT-4.1 for a plain-English briefing.

## Server API

Base URL (OKE): `http://129.80.137.184`  
Proxied via Vercel at: `https://cdisc-kg.vercel.app/api/trials`

### `GET /api/trials`

| Mode | Params | Returns |
|---|---|---|
| `mode=search` (default) | any combination above + `limit` | `{ total, returned, results[] }` |
| `mode=stats` | same filters | `{ total, phase{}, status{}, sponsor[][], enrollment{} }` — faceted |
| `mode=sponsors` | same filters + `sponsor_q` | `{ sponsors: [{val, count}] }` — up to 100 results |

### `GET /api/trial-intelligence?nct_id=NCT...`

Returns comparable trials, risk signals, and a GPT-4.1 briefing for a given trial.

### `GET /health`

Returns `{ ok, backend: "sqlite"|"postgres", snapshot_time }`.

## Infrastructure

- **OKE**: Single ARM64 node (`VM.Standard.A1.Flex`, 4 OCPU / 24 GB), namespace `cdisc-kg`
- **SQLite snapshot**: 580k studies on a 50 GB PVC (`/data/aact.db`), refreshed nightly by a CronJob. Server falls back to live AACT PostgreSQL if the snapshot is stale or missing.
- **CI**: `ubuntu-24.04-arm` GitHub Actions runner — native ARM64 build, ~2.5 min (no QEMU)
- **Vercel**: Serverless proxy layer; keeps the browser on HTTPS to avoid mixed-content issues with the OKE HTTP endpoint

## Debugging the SQLite snapshot

A read-only debug pod mounts the same PVC so you can run ad-hoc SQL:

```bash
# Start the pod (already deployed; recreate if needed)
kubectl apply -f k8s/sqlite-debug-pod.yaml
kubectl wait pod/sqlite-debug -n cdisc-kg --for=condition=Ready

# Open a SQLite shell
kubectl exec -it sqlite-debug -n cdisc-kg -- sqlite3 /data/aact.db

# Useful commands inside sqlite3
.tables
.headers on
.mode column
.schema studies
SELECT overall_status, COUNT(*) FROM studies GROUP BY 1 ORDER BY 2 DESC LIMIT 10;
SELECT sp.name, COUNT(*) FROM sponsors sp WHERE sp.lead_or_collaborator='lead' GROUP BY sp.name ORDER BY 2 DESC LIMIT 20;

# Clean up when done
kubectl delete pod sqlite-debug -n cdisc-kg
```

## Local development

```bash
# Server (requires /data/aact.db or AACT credentials in env)
cd server && node index.js

# UI (proxies /api/* to localhost:3001 via Vite)
cd ui && npm install && npm run dev
```

Set `VITE_TRIALS_API_BASE=http://localhost:3001` in `ui/.env.local` to hit the local server directly.

## Deploying

```bash
# UI + Vercel functions
vercel --prod

# Server image (auto-built by GHA on push to main; to rebuild manually)
cd server && docker build -t ghcr.io/wjewell3/cdisc-kg-server:latest . && docker push ...

# Apply k8s changes
kubectl apply -f k8s/deployment.yaml
kubectl rollout restart deployment/trials-api -n cdisc-kg
```
