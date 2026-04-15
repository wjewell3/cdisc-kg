"""
CDISC Knowledge Graph API

FastAPI backend exposing the SDTM knowledge graph via REST endpoints.
"""

import sys
import json
import os
from pathlib import Path

# Ensure project root is importable
sys.path.insert(0, str(Path(__file__).parent.parent))

from fastapi import FastAPI, Query, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from graph.build_graph import (
    build_graph,
    get_domain_detail,
    get_full_graph_for_viz,
    get_graph_stats,
    get_node_neighborhood,
    load_standards,
    search_graph,
)
from rag.query_engine import create_query_engine, create_llm_streaming_engine

# Allow the deployed frontend URL plus local dev
CORS_ORIGINS = [
    "http://localhost:5173",
    "http://localhost:3000",
    os.environ.get("FRONTEND_URL", ""),
]

app = FastAPI(title="CDISC Knowledge Graph API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[o for o in CORS_ORIGINS if o],
    allow_origin_regex=r"https://.*\.vercel\.app",
    allow_methods=["GET"],
    allow_headers=["*"],
)

# Build graph once at startup
standards = load_standards()
G = build_graph(standards)
nl_query = create_query_engine(G, standards)
nl_stream = create_llm_streaming_engine(G, standards)


@app.get("/api/stats")
def stats():
    return get_graph_stats(G)


@app.get("/api/domains")
def list_domains():
    domains = []
    for nid, data in G.nodes(data=True):
        if data.get("type") == "Domain":
            domains.append({
                "id": data["domain_code"],
                "name": data["name"],
                "description": data["description"],
                "structure": data["structure"],
            })
    return sorted(domains, key=lambda d: d["id"])


@app.get("/api/domains/{domain_code}")
def domain_detail(domain_code: str):
    result = get_domain_detail(G, domain_code.upper())
    if result is None:
        raise HTTPException(status_code=404, detail=f"Domain '{domain_code}' not found")
    return result


@app.get("/api/search")
def search(q: str = Query(..., min_length=1, max_length=200)):
    return search_graph(G, q)


@app.get("/api/graph")
def full_graph(include_values: bool = False):
    return get_full_graph_for_viz(G, exclude_values=not include_values)


@app.get("/api/neighborhood/{node_id:path}")
def neighborhood(node_id: str, depth: int = Query(1, ge=1, le=3)):
    result = get_node_neighborhood(G, node_id, depth)
    if not result["nodes"]:
        raise HTTPException(status_code=404, detail=f"Node '{node_id}' not found")
    return result


@app.get("/api/standards-flow")
def standards_flow():
    return standards.get("standard_flow", [])


@app.get("/api/query")
def natural_language_query(q: str = Query(..., min_length=1, max_length=500)):
    """Structured graph query (no LLM). Fast, synchronous."""
    return nl_query(q)


@app.get("/api/query/stream")
async def natural_language_query_stream(q: str = Query(..., min_length=1, max_length=500)):
    """LLM-enhanced query with SSE streaming.
    Emits: data: {"type":"result","data":{...}}
           data: {"type":"token","text":"..."}  (repeated)
           data: [DONE]
    """
    async def event_stream():
        try:
            async for event in nl_stream(q):
                if event.get("type") == "done":
                    yield "data: [DONE]\n\n"
                else:
                    yield f"data: {json.dumps(event)}\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'type':'error','message':str(e)})}\n\n"
            yield "data: [DONE]\n\n"

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )
