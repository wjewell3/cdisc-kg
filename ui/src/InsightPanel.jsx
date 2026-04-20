import { useState, useEffect, useRef } from "react";
import "./InsightPanel.css";

const PALETTE = ["#58a6ff", "#79c0ff", "#d29922", "#ed8936", "#a371f7", "#39d2c0", "#f778ba", "#8b949e"];

function MiniBar({ data, title, palette = PALETTE }) {
  if (!data || !data.length) return null;
  const items = data.slice(0, 8);
  const maxVal = Math.max(...items.map(([, c]) => c));
  return (
    <div className="ip-chart">
      <div className="ip-chart-title">{title}</div>
      {items.map(([label, count], i) => (
        <div key={label} className="ip-bar-row">
          <span className="ip-bar-label" title={label}>
            {label.length > 26 ? label.slice(0, 24) + "…" : label}
          </span>
          <div className="ip-bar-track">
            <div
              className="ip-bar-fill"
              style={{ width: `${Math.max((count / maxVal) * 100, 3)}%`, background: "#39d2c0" }}
            />
          </div>
          <span className="ip-bar-count">{count.toLocaleString()}</span>
        </div>
      ))}
    </div>
  );
}

function KPI({ value, label, color }) {
  return (
    <div className="ip-kpi">
      <div className="ip-kpi-value" style={color ? { color } : {}}>{value ?? "—"}</div>
      <div className="ip-kpi-label">{label}</div>
    </div>
  );
}

function trialsApiBase() {
  return import.meta.env.VITE_TRIALS_API_BASE || "";
}

const TYPE_LABEL = {
  sponsor: "Sponsor",
  condition: "Condition",
  intervention: "Intervention",
  phase: "Phase",
  status: "Status",
  enrollment_range: "Enrollment Range",
};

function KGFactCard({ fact }) {
  return (
    <div className="ip-kg-fact">
      <div className="ip-kg-fact-label">{fact.label}</div>
      {fact.description && <div className="ip-kg-fact-desc">{fact.description}</div>}
      <div className="ip-kg-fact-items">
        {fact.items.map((item, i) => (
          <div key={i} className="ip-kg-fact-row">
            <span className="ip-kg-fact-name" title={item.name}>
              {item.name.length > 30 ? item.name.slice(0, 28) + "…" : item.name}
            </span>
            <span className="ip-kg-fact-val">
              {item.count?.toLocaleString()}
              {item.similarity !== undefined && <span className="ip-kg-sim"> ({item.similarity}%)</span>}
              {item.trials !== undefined && item.count !== item.trials && <span className="ip-kg-sim"> · {item.trials} trials</span>}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function SimilarEntities({ items, type }) {
  if (!items || !items.length) return null;
  const maxSim = Math.max(...items.map(i => i.similarity_pct));
  return (
    <div className="ip-similar">
      <div className="ip-chart-title">Similar {type === "sponsor" ? "Sponsors" : "Conditions"} (graph similarity)</div>
      {items.slice(0, 6).map((item, i) => (
        <div key={i} className="ip-bar-row">
          <span className="ip-bar-label" title={item.peer}>
            {item.peer.length > 26 ? item.peer.slice(0, 24) + "…" : item.peer}
          </span>
          <div className="ip-bar-track">
            <div
              className="ip-bar-fill"
              style={{ width: `${Math.max((item.similarity_pct / maxSim) * 100, 3)}%`, background: "#a371f7" }}
            />
          </div>
          <span className="ip-bar-count">{item.similarity_pct}%</span>
        </div>
      ))}
    </div>
  );
}

export default function InsightPanel({ insightTarget, onClose }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [aiText, setAiText] = useState(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState(null);
  const [kgContext, setKgContext] = useState(null);
  const [similarEntities, setSimilarEntities] = useState(null);
  const panelRef = useRef(null);

  // Auto-load entity insight data when target changes
  useEffect(() => {
    if (!insightTarget) { setData(null); setKgContext(null); setSimilarEntities(null); return; }
    setData(null); setError(null); setAiText(null); setAiError(null); setLoading(true);
    setKgContext(null); setSimilarEntities(null);
    const base = trialsApiBase();
    const url = base
      ? `${base}/api/entity-insight?type=${encodeURIComponent(insightTarget.type)}&name=${encodeURIComponent(insightTarget.name)}`
      : `/api/entity?mode=insight&type=${encodeURIComponent(insightTarget.type)}&name=${encodeURIComponent(insightTarget.name)}`;
    fetch(url)
      .then(r => r.json().then(d => ({ ok: r.ok, d })))
      .then(({ ok, d }) => {
        if (!ok) throw new Error(d.error || "Failed to load insight");
        setData(d); setLoading(false);
      })
      .catch(e => { setError(e.message); setLoading(false); });
  }, [insightTarget?.type, insightTarget?.name]); // eslint-disable-line

  // Fetch KG context + similar entities (graph enrichment)
  useEffect(() => {
    if (!insightTarget) return;
    const { type, name } = insightTarget;
    if (!["sponsor", "condition", "intervention"].includes(type)) return;
    const base = trialsApiBase();

    // KG context
    const kgUrl = base
      ? `${base}/api/graph/kg-context?type=${encodeURIComponent(type)}&name=${encodeURIComponent(name)}`
      : `/api/graph?path=kg-context&type=${encodeURIComponent(type)}&name=${encodeURIComponent(name)}`;
    fetch(kgUrl).then(r => r.ok ? r.json() : null).then(d => {
      if (d?.facts?.length) setKgContext(d.facts);
    }).catch(() => {});

    // Similar entities (sponsor / condition only)
    if (type === "sponsor" || type === "condition") {
      const simUrl = base
        ? `${base}/api/graph/similar?type=${encodeURIComponent(type)}&name=${encodeURIComponent(name)}&limit=6`
        : `/api/graph?path=similar&type=${encodeURIComponent(type)}&name=${encodeURIComponent(name)}&limit=6`;
      fetch(simUrl).then(r => r.ok ? r.json() : null).then(d => {
        if (Array.isArray(d) && d.length) setSimilarEntities(d);
      }).catch(() => {});
    }
  }, [insightTarget?.type, insightTarget?.name]); // eslint-disable-line

  // Close on Escape key
  useEffect(() => {
    const handler = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  const analyzeWithAI = async () => {
    if (aiLoading || !insightTarget) return;
    setAiLoading(true); setAiText(null); setAiError(null);
    try {
      const base = trialsApiBase();
      const url = base
        ? `${base}/api/entity-intelligence?type=${encodeURIComponent(insightTarget.type)}&name=${encodeURIComponent(insightTarget.name)}`
        : `/api/entity?mode=intelligence&type=${encodeURIComponent(insightTarget.type)}&name=${encodeURIComponent(insightTarget.name)}`;
      const r = await fetch(url);
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "Analysis failed");
      setAiText(d.briefing);
    } catch (e) {
      setAiError(e.message);
    } finally {
      setAiLoading(false);
    }
  };

  const completionColor = (rate) => {
    if (rate === null || rate === undefined) return null;
    return rate >= 50 ? "#58a6ff" : "#d29922";
  };

  const isOpen = !!insightTarget;

  return (
    <>
      {/* Backdrop */}
      {isOpen && <div className="ip-backdrop" onClick={onClose} />}

      {/* Panel */}
      <div className={`ip-panel${isOpen ? " ip-open" : ""}`} ref={panelRef} role="complementary" aria-label="Entity Insight Panel">
        {insightTarget && (
          <>
            <div className="ip-header">
              <div>
                <div className="ip-entity-type">{TYPE_LABEL[insightTarget.type] || insightTarget.type}</div>
                <div className="ip-entity-name" title={insightTarget.name}>
                  {insightTarget.name.length > 40 ? insightTarget.name.slice(0, 38) + "…" : insightTarget.name}
                </div>
              </div>
              <button className="ip-close-btn" onClick={onClose} aria-label="Close panel">✕</button>
            </div>

            {loading && (
              <div className="ip-loading">
                <div className="ip-skeleton-kpis">
                  {[1, 2, 3, 4].map(i => <div key={i} className="ip-skeleton ip-skeleton-kpi" />)}
                </div>
                <div className="ip-skeleton ip-skeleton-chart" />
                <div className="ip-skeleton ip-skeleton-chart" />
              </div>
            )}

            {error && <div className="ip-error">⚠ {error}</div>}

            {data && !loading && (
              <div className="ip-body">
                <div className="ip-kpis">
                  <KPI value={data.summary.total_trials?.toLocaleString()} label="Total Trials" />
                  <KPI
                    value={data.summary.completion_rate_pct !== null ? `${data.summary.completion_rate_pct}%` : "—"}
                    label="Completion Rate"
                    color={completionColor(data.summary.completion_rate_pct)}
                  />
                  <KPI
                    value={data.summary.avg_enrollment ? Math.round(data.summary.avg_enrollment).toLocaleString() : "—"}
                    label="Avg Enrollment"
                  />
                  {data.summary.avg_duration_months && (
                    <KPI value={`${data.summary.avg_duration_months}mo`} label="Avg Duration" />
                  )}
                </div>

                <div className="ip-charts">
                  <MiniBar
                    data={Object.entries(data.phases || {}).sort((a, b) => b[1] - a[1])}
                    title="Phase Distribution"
                  />
                  <MiniBar
                    data={Object.entries(data.statuses || {}).sort((a, b) => b[1] - a[1])}
                    title="Status Breakdown"
                  />
                  {data.conditions?.length > 0 && (
                    <MiniBar data={data.conditions} title="Top Conditions" />
                  )}
                  {data.sponsors?.length > 0 && (
                    <MiniBar data={data.sponsors} title="Top Sponsors" />
                  )}
                  {data.interventions?.length > 0 && (
                    <MiniBar data={data.interventions} title="Top Interventions" />
                  )}
                  {data.sites?.length > 0 && (
                    <MiniBar data={data.sites} title="Top Sites" />
                  )}
                </div>

                {/* KG Context Cards — graph-derived intelligence */}
                {kgContext && kgContext.length > 0 && (
                  <div className="ip-kg-section">
                    <div className="ip-kg-header">
                      <span className="ip-kg-badge">KG</span> Knowledge Graph Insights
                    </div>
                    {kgContext.map((fact, i) => <KGFactCard key={i} fact={fact} />)}
                  </div>
                )}

                {/* Similar Entities */}
                {similarEntities && (
                  <SimilarEntities items={similarEntities} type={insightTarget.type} />
                )}

                {/* AI Analysis section */}
                {!aiText && !aiLoading && (
                  <button className="ip-ai-btn" onClick={analyzeWithAI}>
                    ✦ Analyze with AI
                  </button>
                )}

                {aiLoading && (
                  <div className="ip-ai-loading">
                    <div className="ip-ai-spinner" />
                    <span>GPT-4.1 is analyzing {data.summary.total_trials.toLocaleString()} trials…</span>
                  </div>
                )}

                {aiError && <div className="ip-error" style={{ marginTop: "12px" }}>⚠ {aiError}</div>}

                {aiText && (
                  <div className="ip-ai-briefing">
                    <div className="ip-ai-briefing-header">✦ AI Analysis</div>
                    {aiText.split(/\n+/).filter(Boolean).map((p, i) => (
                      <p key={i} className="ip-ai-para">{p}</p>
                    ))}
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}
