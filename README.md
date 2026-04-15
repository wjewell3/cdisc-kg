# CDISC Knowledge Graph Explorer

An interactive knowledge graph for CDISC SDTM IG v3.4 standards, built as a portfolio piece for clinical data management roles.

## What it does

- **Visualizes** SDTM domains, variables, codelists, and cross-domain relationships as an interactive force-directed graph
- **Explores** domain structures: click any domain to see all its variables, codelists, and relationships
- **Searches** the graph by variable name, label, or description
- **Queries** in natural language: "What variables are required in the AE domain?" returns a structured answer from the graph

## Architecture

```
cdisc-kg/
├── data/
│   └── sdtm_standards.json     # SDTM IG v3.4 metadata (6 domains, 133 vars, 24 codelists)
├── graph/
│   └── build_graph.py          # NetworkX graph engine
├── api/
│   └── server.py               # FastAPI REST API
├── rag/
│   └── query_engine.py         # Natural language query engine
├── ui/                         # React + react-force-graph-2d frontend
│   └── src/
│       ├── App.jsx              # Main graph explorer
│       ├── QueryPanel.jsx       # NL query interface
│       └── api.js               # API client
└── start.sh                    # Start both services
```

## Graph model

| Node type      | Count | Description                              |
|----------------|-------|------------------------------------------|
| Standard       | 4     | CDASH, SDTM, ADaM, TLF                  |
| Class          | 5     | Interventions, Events, Findings, etc.    |
| Domain         | 6     | DM, AE, CM, EX, LB, VS                  |
| Variable       | 133   | All domain variables with full metadata  |
| Codelist       | 24    | Controlled terminology codelists         |
| CodelistValue  | 225   | Individual controlled terms              |

**Relationships:** `has_variable`, `uses_codelist`, `belongs_to`, `defined_in`, `subject_link`, `clinical_link`, `temporal_link`, `standard_flow`, and more.

## Start

```bash
./start.sh
```

- **UI**: http://localhost:5173
- **API**: http://localhost:8000
- **API docs**: http://localhost:8000/docs

## API endpoints

| Endpoint                     | Description                            |
|------------------------------|----------------------------------------|
| `GET /api/stats`             | Graph statistics                       |
| `GET /api/domains`           | List all domains                       |
| `GET /api/domains/{code}`    | Full domain detail                     |
| `GET /api/search?q=`         | Text search across all nodes           |
| `GET /api/graph`             | Full graph for visualization           |
| `GET /api/neighborhood/{id}` | Node neighborhood (depth 1-3)          |
| `GET /api/query?q=`          | Natural language query                 |
| `GET /api/standards-flow`    | CDASH → SDTM → ADaM → TLF flow        |

## Example NL queries

- `What variables are required in the AE domain?`
- `What codelist does AESEV use?`
- `How are DM and AE related?`
- `What domains are in the Findings class?`
- `What is USUBJID?`
- `Show all SDTM domains`
- `What is the CDISC data flow?`

## Setup from scratch

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install networkx fastapi uvicorn

cd ui
npm install
```
