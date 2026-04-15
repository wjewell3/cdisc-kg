"""
CDISC Knowledge Graph Natural Language Query Engine

Translates natural language questions about CDISC/SDTM standards
into graph traversals and returns structured answers, optionally
enhanced with an LLM (GitHub Copilot via LiteLLM).
"""

import os
import re
import json
from pathlib import Path
from graph.build_graph import (
    build_graph,
    get_domain_detail,
    get_graph_stats,
    load_standards,
    search_graph,
)

# ── LiteLLM setup ──────────────────────────────────────────────────────────

def _setup_copilot_token():
    """Write env-var token to the path litellm expects, if not already present."""
    token = os.environ.get("GITHUB_COPILOT_TOKEN", "")
    if not token:
        return
    config_dir = Path.home() / ".config" / "litellm" / "github_copilot"
    token_file = config_dir / "access-token"
    if not token_file.exists():
        config_dir.mkdir(parents=True, exist_ok=True)
        token_file.write_text(token)

_setup_copilot_token()

LLM_MODEL = os.environ.get("LLM_MODEL", "github_copilot/gpt-4.1")
LLM_AVAILABLE = False

try:
    import litellm
    litellm.suppress_debug_info = True
    LLM_AVAILABLE = True
except ImportError:
    pass

SYSTEM_PROMPT = """You are an expert in CDISC SDTM (Study Data Tabulation Model) standards used in clinical trials.
Answer questions clearly and accurately using the provided knowledge graph context.
- Use correct CDISC terminology (e.g. "Required" not "mandatory", "Controlled Terminology" not "enum")
- Be concise but complete — a paragraph or less for most questions
- If variables are involved, mention their domain and core status when relevant
- Do NOT invent variables or domains not present in the context
"""

def _build_llm_context(result: dict) -> str:
    """Serialize the structured graph result into prompt context."""
    rtype = result.get("type")
    data = result.get("data")
    context_lines = [f"Type: {rtype}", f"Answer summary: {result.get('answer', '')[:200]}"]

    if data is None:
        return "\n".join(context_lines)

    if rtype == "variable_list" and isinstance(data, list):
        context_lines.append(f"Variables ({len(data)}):")
        for v in data[:30]:
            context_lines.append(
                f"  - {v['name']} ({v.get('label','')}) | Core: {v.get('core','')} | Role: {v.get('role','')}"
            )

    elif rtype == "codelist_detail" and isinstance(data, dict):
        context_lines.append(f"Codelist: {data.get('codelist')}")
        context_lines.append(f"Values: {', '.join(data.get('values', []))}")

    elif rtype == "domain_detail":
        d = data
        context_lines.append(f"Domain: {d.get('domain_code')} — {d.get('name')}")
        context_lines.append(f"Class: {d.get('class')}, Structure: {d.get('structure')}")
        vars_summary = [f"{v['name']} (Core:{v['core']})" for v in (d.get("variables") or [])[:20]]
        context_lines.append(f"Variables: {', '.join(vars_summary)}")

    elif rtype == "variable_detail" and isinstance(data, list):
        for v in data:
            context_lines.append(
                f"  {v['name']}: {v.get('description','')} | Domain: {v.get('domain')} | Core: {v.get('core')} | Role: {v.get('role')}"
            )

    elif rtype == "relationship" and isinstance(data, list):
        for r in data:
            context_lines.append(
                f"  {r.get('relationship')}: via {r.get('via_variable','N/A')} — {r.get('description','')}"
            )

    elif rtype == "domain_list" and isinstance(data, list):
        for d in data:
            context_lines.append(f"  {d.get('code')}: {d.get('name')} — {d.get('description','')[:80]}")

    elif rtype == "stats" and isinstance(data, dict):
        context_lines.append(f"Node types: {json.dumps(data.get('node_types', {}))}")

    elif rtype == "flow" and isinstance(data, list):
        for f in data:
            context_lines.append(f"  {f.get('from')} → {f.get('to')}: {f.get('description','')}")

    elif rtype == "search_results" and isinstance(data, list):
        for r in data[:10]:
            context_lines.append(f"  [{r.get('type')}] {r.get('name')}: {r.get('label','')}")

    return "\n".join(context_lines)


async def llm_stream(question: str, context: str):
    """Async generator that yields text tokens from the LLM."""
    if not LLM_AVAILABLE:
        yield "(LLM not available — install litellm)"
        return

    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": f"Question: {question}\n\nKnowledge Graph Context:\n{context}"},
    ]
    try:
        response = await litellm.acompletion(
            model=LLM_MODEL,
            messages=messages,
            stream=True,
            max_tokens=512,
            temperature=0.2,
        )
        async for chunk in response:
            token = chunk.choices[0].delta.content
            if token:
                yield token
    except Exception as e:
        yield f"\n\n*(LLM error: {e})*"


def create_query_engine(G, standards):
    """Create a query engine closure over the graph and standards."""

    domain_codes = set()
    domain_names = {}
    for nid, data in G.nodes(data=True):
        if data.get("type") == "Domain":
            code = data["domain_code"]
            domain_codes.add(code)
            domain_names[data["name"].lower()] = code

    variable_names = set()
    for nid, data in G.nodes(data=True):
        if data.get("type") == "Variable":
            variable_names.add(data["name"])

    class_names = {}
    for nid, data in G.nodes(data=True):
        if data.get("type") == "Class":
            class_names[data["name"].lower()] = nid

    def _find_domain_ref(text):
        """Extract domain code from text."""
        upper = text.upper()
        for code in domain_codes:
            if code in upper.split() or f" {code} " in f" {upper} " or upper.endswith(f" {code}"):
                return code
        for name, code in domain_names.items():
            if name in text.lower():
                return code
        return None

    def _find_variable_ref(text):
        """Extract variable name from text."""
        upper = text.upper()
        for var in variable_names:
            if var in upper.split() or f" {var} " in f" {upper} " or upper.endswith(f" {var}"):
                return var
        return None

    def _find_class_ref(text):
        """Extract class reference from text."""
        lower = text.lower()
        for name, nid in class_names.items():
            if name in lower:
                return nid, name
        return None, None

    def query(question):
        """Process a natural language question and return a structured answer."""
        q = question.strip()
        ql = q.lower()

        # --- Pattern: required/expected/permissible variables in domain ---
        core_match = re.search(
            r"(required|expected|permissible|req|exp|perm|mandatory)\b.*\b(variables?|fields?|columns?)",
            ql,
        )
        if not core_match:
            core_match = re.search(
                r"(variables?|fields?|columns?)\b.*(required|expected|permissible|req|exp|perm|mandatory)",
                ql,
            )

        domain_ref = _find_domain_ref(q)

        if core_match and domain_ref:
            core_type = core_match.group(1) if core_match.group(1) not in ("variables", "variable", "fields", "field", "columns", "column") else core_match.group(2)
            core_map = {
                "required": "Req", "req": "Req", "mandatory": "Req",
                "expected": "Exp", "exp": "Exp",
                "permissible": "Perm", "perm": "Perm",
            }
            core_val = core_map.get(core_type.lower(), "Req")

            detail = get_domain_detail(G, domain_ref)
            if detail:
                filtered = [v for v in detail["variables"] if v["core"] == core_val]
                return {
                    "type": "variable_list",
                    "question": q,
                    "answer": f"The {domain_ref} domain has {len(filtered)} {core_val.lower()}uired variables:" if core_val == "Req" else f"The {domain_ref} domain has {len(filtered)} {core_type} variables:",
                    "data": filtered,
                    "domain": domain_ref,
                    "context": f"Domain: {detail['name']} ({detail['domain_code']})",
                }

        # --- Pattern: all variables in a domain ---
        if domain_ref and re.search(r"(variables?|fields?|columns?|what.*contain)", ql):
            detail = get_domain_detail(G, domain_ref)
            if detail:
                return {
                    "type": "variable_list",
                    "question": q,
                    "answer": f"The {domain_ref} ({detail['name']}) domain has {len(detail['variables'])} variables:",
                    "data": detail["variables"],
                    "domain": domain_ref,
                    "context": f"Structure: {detail['structure']}",
                }

        # --- Pattern: what codelist does X use ---
        var_ref = _find_variable_ref(q)
        if var_ref and re.search(r"codelist|controlled.?term|terminology|values?", ql):
            for nid, data in G.nodes(data=True):
                if data.get("type") == "Variable" and data["name"] == var_ref:
                    for _, target, edata in G.edges(nid, data=True):
                        if edata.get("relationship") == "uses_codelist":
                            cl_node = G.nodes[target]
                            values = []
                            for _, val_target, val_data in G.edges(target, data=True):
                                if val_data.get("relationship") == "has_value":
                                    values.append(G.nodes[val_target]["name"])
                            return {
                                "type": "codelist_detail",
                                "question": q,
                                "answer": f"{var_ref} uses the codelist '{cl_node['name']}' with {len(values)} values:",
                                "data": {"codelist": cl_node["name"], "values": sorted(values)},
                                "variable": var_ref,
                                "source_node": nid,
                            }
                    return {
                        "type": "text",
                        "question": q,
                        "answer": f"{var_ref} does not use a controlled terminology codelist.",
                        "variable": var_ref,
                    }

        # --- Pattern: what is <variable>? ---
        if var_ref and re.search(r"what is|describe|explain|definition|tell me about", ql):
            results = []
            for nid, data in G.nodes(data=True):
                if data.get("type") == "Variable" and data["name"] == var_ref:
                    results.append({
                        "name": data["name"],
                        "label": data["label"],
                        "domain": data["domain"],
                        "type": data["data_type"],
                        "core": data["core"],
                        "role": data["role"],
                        "description": data["description"],
                    })
            if results:
                r = results[0]
                domains_with_var = [x["domain"] for x in results]
                return {
                    "type": "variable_detail",
                    "question": q,
                    "answer": f"{r['name']} ({r['label']}): {r['description']}",
                    "data": results,
                    "context": f"Found in domains: {', '.join(domains_with_var)}. Type: {r['type']}, Core: {r['core']}, Role: {r['role']}",
                }

        # --- Pattern: how are domains related ---
        if re.search(r"(relat|connect|link|between)", ql):
            d1 = _find_domain_ref(q)
            # Try to find a second domain
            remaining = q
            if d1:
                remaining = re.sub(re.escape(d1), "", q, flags=re.IGNORECASE)
            d2 = _find_domain_ref(remaining)

            if d1 and d2:
                detail1 = get_domain_detail(G, d1)
                if detail1:
                    rels = [r for r in detail1["related_domains"] if r["domain"] == d2]
                    if rels:
                        return {
                            "type": "relationship",
                            "question": q,
                            "answer": f"{d1} and {d2} are connected via {len(rels)} relationship(s):",
                            "data": rels,
                            "domains": [d1, d2],
                        }
                    # Check shared variables
                    detail2 = get_domain_detail(G, d2)
                    if detail2:
                        vars1 = {v["name"] for v in detail1["variables"]}
                        vars2 = {v["name"] for v in detail2["variables"]}
                        shared = vars1 & vars2
                        if shared:
                            return {
                                "type": "shared_variables",
                                "question": q,
                                "answer": f"{d1} and {d2} share {len(shared)} common variables:",
                                "data": sorted(shared),
                                "domains": [d1, d2],
                            }

        # --- Pattern: domains in a class ---
        cls_id, cls_name = _find_class_ref(q)
        if cls_id and re.search(r"domain|list|show|what", ql):
            domains_in_class = []
            for nid, data in G.nodes(data=True):
                if data.get("type") == "Domain":
                    for _, target, edata in G.edges(nid, data=True):
                        if edata.get("relationship") == "belongs_to" and target == cls_id:
                            domains_in_class.append({
                                "code": data["domain_code"],
                                "name": data["name"],
                                "description": data["description"],
                            })
            if domains_in_class:
                return {
                    "type": "domain_list",
                    "question": q,
                    "answer": f"The {cls_name.title()} class has {len(domains_in_class)} domain(s):",
                    "data": domains_in_class,
                }

        # --- Pattern: what domains are there ---
        if re.search(r"(what|list|show|all).*(domains?)", ql) or re.search(r"domains?.*(what|list|show|all)", ql):
            all_domains = []
            for nid, data in G.nodes(data=True):
                if data.get("type") == "Domain":
                    all_domains.append({
                        "code": data["domain_code"],
                        "name": data["name"],
                        "description": data["description"],
                    })
            return {
                "type": "domain_list",
                "question": q,
                "answer": f"There are {len(all_domains)} SDTM domains in this knowledge graph:",
                "data": sorted(all_domains, key=lambda d: d["code"]),
            }

        # --- Pattern: stats/overview ---
        if re.search(r"(stats|statistics|overview|summary|how many|how big|size)", ql):
            stats = get_graph_stats(G)
            return {
                "type": "stats",
                "question": q,
                "answer": f"The CDISC Knowledge Graph contains {stats['total_nodes']} nodes and {stats['total_edges']} edges.",
                "data": stats,
            }

        # --- Pattern: standard flow ---
        if re.search(r"(flow|pipeline|cdash|adam|process|standard.*to)", ql):
            flows = standards.get("standard_flow", [])
            return {
                "type": "flow",
                "question": q,
                "answer": "CDISC data flows through these standards:",
                "data": flows,
            }

        # --- Pattern: what is <domain>? ---
        if domain_ref and re.search(r"(what is|describe|explain|tell me about|purpose|about)", ql):
            detail = get_domain_detail(G, domain_ref)
            if detail:
                return {
                    "type": "domain_detail",
                    "question": q,
                    "answer": f"{detail['name']} ({detail['domain_code']}): {detail['description']}",
                    "data": detail,
                    "context": f"Class: {detail['class']}, Structure: {detail['structure']}, Variables: {len(detail['variables'])}",
                }

        # --- Fallback: search ---
        results = search_graph(G, q)
        if results:
            return {
                "type": "search_results",
                "question": q,
                "answer": f"Found {len(results)} results for '{q}':",
                "data": results[:10],
            }

        return {
            "type": "no_results",
            "question": q,
            "answer": "I couldn't find a specific answer. Try asking about SDTM domains (DM, AE, CM, LB, VS, EX), variables, codelists, or domain relationships.",
            "data": None,
            "suggestions": [
                "What variables are required in the AE domain?",
                "What codelist does AESEV use?",
                "How are DM and AE related?",
                "What domains are in the Findings class?",
                "What is USUBJID?",
            ],
        }

    return query


def create_llm_streaming_engine(G, standards):
    """Returns an async generator that streams graph result then LLM tokens."""
    query_fn = create_query_engine(G, standards)

    async def query_stream(question: str):
        # 1. Run graph query to get structured result (fast, synchronous)
        structured = query_fn(question)

        # 2. Emit the structured result as the first SSE event
        yield {"type": "result", "data": structured}

        # 3. Build context for the LLM from the structured result
        context = _build_llm_context(structured)

        # 4. Stream LLM response tokens
        async for token in llm_stream(question, context):
            yield {"type": "token", "text": token}

        yield {"type": "done"}

    return query_stream
