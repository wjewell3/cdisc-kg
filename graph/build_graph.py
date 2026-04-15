"""
CDISC Knowledge Graph Builder

Constructs a NetworkX graph from SDTM standards metadata.
Node types: Standard, Class, Domain, Variable, Codelist, CodelistValue
Edge types: belongs_to, has_variable, uses_codelist, has_value, subject_link,
            clinical_link, temporal_link, standard_flow
"""

import json
import networkx as nx
from pathlib import Path


def load_standards(path: str | None = None) -> dict:
    if path is None:
        path = Path(__file__).parent.parent / "data" / "sdtm_standards.json"
    with open(path) as f:
        return json.load(f)


def build_graph(standards: dict | None = None) -> nx.DiGraph:
    if standards is None:
        standards = load_standards()

    G = nx.DiGraph()

    # --- Standard node ---
    std = standards["standard"]
    std_id = f"standard:{std['name']}"
    G.add_node(std_id, **{
        "type": "Standard",
        "name": std["name"],
        "version": std["version"],
        "description": std["description"],
        "organization": std["organization"],
    })

    # --- CDASH / ADaM standards (from standard_flow) ---
    for flow in standards.get("standard_flow", []):
        for s in [flow["from"], flow["to"]]:
            sid = f"standard:{s}"
            if sid not in G:
                G.add_node(sid, type="Standard", name=s)

    for flow in standards.get("standard_flow", []):
        G.add_edge(
            f"standard:{flow['from']}",
            f"standard:{flow['to']}",
            relationship=flow["relationship"],
            description=flow["description"],
        )

    # --- Class nodes ---
    for cls in standards["classes"]:
        cls_id = f"class:{cls['id']}"
        G.add_node(cls_id, **{
            "type": "Class",
            "name": cls["name"],
            "description": cls["description"],
        })
        G.add_edge(cls_id, std_id, relationship="part_of")

    # --- Codelist nodes + values ---
    for cl in standards["codelists"]:
        cl_id = f"codelist:{cl['id']}"
        G.add_node(cl_id, **{
            "type": "Codelist",
            "name": cl["name"],
            "codelist_id": cl["id"],
        })
        for val in cl["values"]:
            val_id = f"codelistvalue:{cl['id']}:{val}"
            G.add_node(val_id, **{
                "type": "CodelistValue",
                "name": val,
                "codelist": cl["id"],
            })
            G.add_edge(cl_id, val_id, relationship="has_value")

    # --- Domain nodes + variables ---
    for domain in standards["domains"]:
        domain_id = f"domain:{domain['id']}"
        G.add_node(domain_id, **{
            "type": "Domain",
            "name": domain["name"],
            "domain_code": domain["id"],
            "description": domain["description"],
            "structure": domain["structure"],
        })

        # Domain → Class
        cls_id = f"class:{domain['class']}"
        G.add_edge(domain_id, cls_id, relationship="belongs_to")

        # Domain → Standard
        G.add_edge(domain_id, std_id, relationship="defined_in")

        for var in domain["variables"]:
            var_id = f"variable:{domain['id']}.{var['name']}"
            G.add_node(var_id, **{
                "type": "Variable",
                "name": var["name"],
                "label": var["label"],
                "data_type": var["type"],
                "core": var["core"],
                "role": var["role"],
                "domain": domain["id"],
                "description": var["description"],
            })

            # Domain → Variable
            G.add_edge(domain_id, var_id, relationship="has_variable")

            # Variable → Codelist
            if var.get("codelist"):
                cl_id = f"codelist:{var['codelist']}"
                if cl_id in G:
                    G.add_edge(var_id, cl_id, relationship="uses_codelist")

    # --- Cross-domain relationships ---
    for rel in standards.get("cross_domain_relationships", []):
        from_id = f"domain:{rel['from_domain']}"
        to_id = f"domain:{rel['to_domain']}"
        if from_id in G and to_id in G:
            G.add_edge(from_id, to_id, **{
                "relationship": rel["relationship"],
                "via_variable": rel.get("via_variable"),
                "description": rel["description"],
            })

    return G


def get_graph_stats(G: nx.DiGraph) -> dict:
    node_types: dict[str, int] = {}
    for _, data in G.nodes(data=True):
        t = data.get("type", "Unknown")
        node_types[t] = node_types.get(t, 0) + 1

    edge_types: dict[str, int] = {}
    for _, _, data in G.edges(data=True):
        r = data.get("relationship", "unknown")
        edge_types[r] = edge_types.get(r, 0) + 1

    return {
        "total_nodes": G.number_of_nodes(),
        "total_edges": G.number_of_edges(),
        "node_types": node_types,
        "edge_types": edge_types,
    }


def get_domain_detail(G: nx.DiGraph, domain_code: str) -> dict | None:
    domain_id = f"domain:{domain_code}"
    if domain_id not in G:
        return None

    node = G.nodes[domain_id]
    variables = []
    for _, target, data in G.edges(domain_id, data=True):
        if data.get("relationship") == "has_variable":
            var_data = G.nodes[target]
            codelist_info = None
            for _, cl_target, cl_data in G.edges(target, data=True):
                if cl_data.get("relationship") == "uses_codelist":
                    cl_node = G.nodes[cl_target]
                    values = []
                    for _, val_target, val_data in G.edges(cl_target, data=True):
                        if val_data.get("relationship") == "has_value":
                            values.append(G.nodes[val_target]["name"])
                    codelist_info = {
                        "id": cl_node.get("codelist_id"),
                        "name": cl_node["name"],
                        "values": sorted(values),
                    }
                    break
            variables.append({
                "name": var_data["name"],
                "label": var_data["label"],
                "type": var_data["data_type"],
                "core": var_data["core"],
                "role": var_data["role"],
                "description": var_data["description"],
                "codelist": codelist_info,
            })

    # Linked domains
    related = []
    for _, target, data in G.edges(domain_id, data=True):
        if data.get("relationship") in ("subject_link", "clinical_link", "temporal_link"):
            related.append({
                "domain": G.nodes[target].get("domain_code", target),
                "relationship": data["relationship"],
                "via_variable": data.get("via_variable"),
                "description": data.get("description"),
            })
    # Incoming links
    for source, _, data in G.in_edges(domain_id, data=True):
        if data.get("relationship") in ("subject_link", "clinical_link", "temporal_link"):
            related.append({
                "domain": G.nodes[source].get("domain_code", source),
                "relationship": data["relationship"],
                "direction": "incoming",
                "via_variable": data.get("via_variable"),
                "description": data.get("description"),
            })

    cls_name = None
    for _, target, data in G.edges(domain_id, data=True):
        if data.get("relationship") == "belongs_to":
            cls_name = G.nodes[target]["name"]
            break

    return {
        "domain_code": domain_code,
        "name": node["name"],
        "description": node["description"],
        "structure": node["structure"],
        "class": cls_name,
        "variables": sorted(variables, key=lambda v: v["name"]),
        "related_domains": related,
    }


def search_graph(G: nx.DiGraph, query: str) -> list[dict]:
    query_lower = query.lower()
    results = []
    for node_id, data in G.nodes(data=True):
        score = 0
        name = data.get("name", "")
        label = data.get("label", "")
        desc = data.get("description", "")

        if query_lower == name.lower():
            score = 100
        elif query_lower in name.lower():
            score = 80
        elif query_lower in label.lower():
            score = 60
        elif query_lower in desc.lower():
            score = 40

        if score > 0:
            results.append({
                "id": node_id,
                "type": data.get("type"),
                "name": name,
                "label": label,
                "description": desc,
                "score": score,
            })

    results.sort(key=lambda x: x["score"], reverse=True)
    return results[:20]


def get_node_neighborhood(G: nx.DiGraph, node_id: str, depth: int = 1) -> dict:
    """Get a node and its neighbors up to a given depth for visualization."""
    if node_id not in G:
        return {"nodes": [], "edges": []}

    visited = set()
    frontier = {node_id}
    nodes = []
    edges = []

    for _ in range(depth + 1):
        next_frontier = set()
        for nid in frontier:
            if nid in visited:
                continue
            visited.add(nid)
            data = G.nodes[nid]
            nodes.append({"id": nid, **data})

            for _, target, edata in G.edges(nid, data=True):
                edges.append({"source": nid, "target": target, **edata})
                if target not in visited:
                    next_frontier.add(target)

            for source, _, edata in G.in_edges(nid, data=True):
                edges.append({"source": source, "target": nid, **edata})
                if source not in visited:
                    next_frontier.add(source)

        frontier = next_frontier

    # Deduplicate edges
    seen_edges = set()
    unique_edges = []
    for e in edges:
        key = (e["source"], e["target"], e.get("relationship"))
        if key not in seen_edges:
            seen_edges.add(key)
            unique_edges.append(e)

    return {"nodes": nodes, "edges": unique_edges}


def get_full_graph_for_viz(G: nx.DiGraph, exclude_values: bool = True) -> dict:
    """Export the full graph for visualization, optionally excluding codelist values to reduce noise."""
    nodes = []
    edges = []
    for nid, data in G.nodes(data=True):
        if exclude_values and data.get("type") == "CodelistValue":
            continue
        nodes.append({"id": nid, **data})

    for source, target, data in G.edges(data=True):
        if exclude_values:
            if G.nodes.get(source, {}).get("type") == "CodelistValue":
                continue
            if G.nodes.get(target, {}).get("type") == "CodelistValue":
                continue
        edges.append({"source": source, "target": target, **data})

    return {"nodes": nodes, "edges": edges}


if __name__ == "__main__":
    G = build_graph()
    stats = get_graph_stats(G)
    print(f"Graph built: {stats['total_nodes']} nodes, {stats['total_edges']} edges")
    print(f"Node types: {stats['node_types']}")
    print(f"Edge types: {stats['edge_types']}")
