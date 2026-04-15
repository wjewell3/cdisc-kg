import { useState } from "react";
import staticData from "./graphData.json";
import "./TreeView.css";

const DOMAINS_MAP = staticData.domains;
const CORE_ORDER = { Req: 0, Exp: 1, Perm: 2 };

// Build class → [domain codes] from edges
const CLASS_DOMAINS = {};
const CLASS_NAMES = {};
for (const n of staticData.graph.nodes) {
  if (n.type === "Class") CLASS_NAMES[n.id] = n.name;
}
for (const e of staticData.graph.edges) {
  if (e.relationship === "belongs_to") {
    const domCode = e.source.replace("domain:", "");
    const classId = e.target;
    (CLASS_DOMAINS[classId] ||= []).push(domCode);
  }
}

// Ordered classes
const CLASS_ORDER = [
  "class:special_purpose",
  "class:events",
  "class:interventions",
  "class:findings",
  "class:trial_design",
];

const CORE_COLORS = { Req: "#f85149", Exp: "#e3b341", Perm: "#8b949e" };
const CORE_TITLES = {
  Req: "Required — FDA will reject without this",
  Exp: "Expected — should be present, explain if absent",
  Perm: "Permissible — include if collected",
};

function CodelistBadge({ codelist }) {
  const [open, setOpen] = useState(false);
  if (!codelist) return null;
  return (
    <span className="tv-cl-wrap">
      <button
        className="tv-cl-btn"
        onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
        title="Show allowed values"
      >
        {codelist.id} {open ? "▲" : "▼"}
      </button>
      {open && (
        <span className="tv-cl-values">
          {codelist.values.map((v) => (
            <span key={v} className="tv-cl-chip">{v}</span>
          ))}
        </span>
      )}
    </span>
  );
}

function VariableRow({ v, isLast }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`tv-var${open ? " tv-var-open" : ""}${isLast ? " tv-last" : ""}`}>
      <div className="tv-var-row" onClick={() => setOpen((o) => !o)}>
        <span className="tv-tree-indent" />
        <span className="tv-toggle-icon">{v.description || v.codelist ? (open ? "▾" : "▸") : " "}</span>
        <code className="tv-var-name">{v.name}</code>
        <span className="tv-var-label">{v.label}</span>
        <span className="tv-type-pill">{v.type}</span>
        <span
          className="tv-core-pill"
          style={{ color: CORE_COLORS[v.core] }}
          title={CORE_TITLES[v.core]}
        >
          {v.core}
        </span>
        {v.codelist && <CodelistBadge codelist={v.codelist} />}
      </div>
      {open && (v.description || v.role) && (
        <div className="tv-var-detail">
          {v.role && <span className="tv-role">Role: {v.role}</span>}
          {v.description && <p className="tv-desc">{v.description}</p>}
        </div>
      )}
    </div>
  );
}

function DomainBlock({ domCode, dom }) {
  const [open, setOpen] = useState(false);
  const sorted = [...dom.variables].sort(
    (a, b) => (CORE_ORDER[a.core] ?? 9) - (CORE_ORDER[b.core] ?? 9)
  );
  const counts = { Req: 0, Exp: 0, Perm: 0 };
  for (const v of dom.variables) if (counts[v.core] !== undefined) counts[v.core]++;

  return (
    <div className={`tv-domain${open ? " tv-domain-open" : ""}`}>
      <div className="tv-domain-row" onClick={() => setOpen((o) => !o)}>
        <span className="tv-toggle">{open ? "▾" : "▸"}</span>
        <strong className="tv-domain-code">{domCode}</strong>
        <span className="tv-domain-name">{dom.name}</span>
        <span className="tv-domain-meta">
          <span title={CORE_TITLES.Req} style={{ color: CORE_COLORS.Req }}>{counts.Req} Req</span>
          {" · "}
          <span title={CORE_TITLES.Exp} style={{ color: CORE_COLORS.Exp }}>{counts.Exp} Exp</span>
          {" · "}
          <span title={CORE_TITLES.Perm} style={{ color: CORE_COLORS.Perm }}>{counts.Perm} Perm</span>
        </span>
      </div>
      {open && (
        <>
          <div className="tv-domain-desc">{dom.description}</div>
          <div className="tv-var-header-row">
            <span className="tv-tree-indent" />
            <span className="tv-vh-name">Variable</span>
            <span className="tv-vh-label">Label</span>
            <span className="tv-vh-type">Type</span>
            <span className="tv-vh-core">Core</span>
          </div>
          <div className="tv-vars">
            {sorted.map((v, i) => (
              <VariableRow key={v.name} v={v} isLast={i === sorted.length - 1} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function ClassBlock({ classId }) {
  const [open, setOpen] = useState(true);
  const domCodes = CLASS_DOMAINS[classId] || [];
  const label = CLASS_NAMES[classId] || classId;
  const totalVars = domCodes.reduce(
    (sum, code) => sum + (DOMAINS_MAP[code]?.variables.length || 0),
    0
  );

  return (
    <div className="tv-class">
      <div className="tv-class-row" onClick={() => setOpen((o) => !o)}>
        <span className="tv-toggle">{open ? "▾" : "▸"}</span>
        <span className="tv-class-name">{label}</span>
        <span className="tv-class-meta">{domCodes.length} domain{domCodes.length !== 1 ? "s" : ""} · {totalVars} variables</span>
      </div>
      {open && domCodes.map((code) => (
        <DomainBlock key={code} domCode={code} dom={DOMAINS_MAP[code]} />
      ))}
    </div>
  );
}

export default function TreeView() {
  return (
    <div className="tv-root">
      <div className="tv-header">
        <div className="tv-title-row">
          <h2>SDTM IG v3.4</h2>
          <div className="tv-legend">
            {Object.entries(CORE_COLORS).map(([k, c]) => (
              <span key={k} className="tv-legend-item" title={CORE_TITLES[k]}>
                <span style={{ color: c, fontWeight: 700 }}>{k}</span>
                <span>{CORE_TITLES[k].split("—")[1]?.trim()}</span>
              </span>
            ))}
          </div>
        </div>
      </div>
      <div className="tv-body">
        <div className="tv-standard-row">
          <span className="tv-std-badge">SDTM</span>
          <span className="tv-std-label">Study Data Tabulation Model</span>
          <span className="tv-std-meta">
            {Object.keys(DOMAINS_MAP).length} domains ·{" "}
            {Object.values(DOMAINS_MAP).reduce((s, d) => s + d.variables.length, 0)} variables ·{" "}
            {CLASS_ORDER.length} classes
          </span>
        </div>
        {CLASS_ORDER.map((cid) =>
          CLASS_DOMAINS[cid] ? <ClassBlock key={cid} classId={cid} /> : null
        )}
      </div>
    </div>
  );
}
