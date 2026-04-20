/**
 * MonitorRisk.jsx — During-trial risk monitoring panels.
 *
 * Two views:
 * 1. Safety Signals — adverse event analysis (SAE rates, organ systems, top events)
 * 2. Participant Flow — milestone funnel + dropout reasons
 *
 * Reacts to chart filters (condition, phase, sponsor, intervention).
 */
import { useState, useEffect } from "react";

function trialsApiBase() {
  return import.meta.env.VITE_TRIALS_API_BASE || "";
}

// ── Mini bar (reused) ─────────────────────────────────────────────────────
function MiniBar({ data, title, maxItems = 10, valueLabel = "", highlightFn }) {
  const items = data.slice(0, maxItems);
  if (!items.length) return null;
  const maxVal = Math.max(...items.map(d => d.value), 1);
  return (
    <div className="okpi-chart">
      <div className="okpi-chart-title">{title}</div>
      {items.map((d) => (
        <div key={d.label} className="okpi-bar-row">
          <span className="okpi-bar-label" title={d.label}>
            {d.label.length > 32 ? d.label.slice(0, 30) + "…" : d.label}
          </span>
          <div className="okpi-bar-track">
            <div
              className="okpi-bar-fill"
              style={{
                width: `${Math.max((d.value / maxVal) * 100, 3)}%`,
                background: highlightFn ? highlightFn(d) : "#39d2c0",
              }}
            />
          </div>
          <span className="okpi-bar-count">
            {typeof d.value === "number" && d.value % 1 !== 0 ? d.value.toFixed(1) : d.value.toLocaleString()}
            {valueLabel}
          </span>
        </div>
      ))}
    </div>
  );
}

// ── Safety Signals View ─────────────────────────────────────────────────
function SafetySignals({ filterParams }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    setLoading(true); setError(null);
    const base = trialsApiBase();
    const url = new URL(base ? `${base}/api/safety-signals` : `/api/analytics`, window.location.origin);
    if (!base) url.searchParams.set("mode", "safety-signals");
    for (const [k, v] of Object.entries(filterParams)) { if (v) url.searchParams.set(k, v); }
    fetch(url.toString())
      .then(r => r.json().then(d => ({ ok: r.ok, d })))
      .then(({ ok, d }) => { if (!ok) throw new Error(d.error || "Failed"); setData(d); })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [filterParams]);

  if (loading) return <div className="okpi-loading">Analyzing safety signals…</div>;
  if (error) return <div className="okpi-error">⚠ {error}</div>;
  if (!data) return null;

  const saeRate = data.total_at_risk > 0
    ? ((data.total_affected / data.total_at_risk) * 100).toFixed(1) : null;

  return (
    <div className="okpi-view">
      <div className="okpi-kpis">
        <div className="okpi-kpi">
          <div className="okpi-kpi-value">{data.trials_with_events.toLocaleString()}</div>
          <div className="okpi-kpi-label">Trials with AEs</div>
        </div>
        <div className="okpi-kpi">
          <div className="okpi-kpi-value" style={{ color: "#ed8936" }}>
            {data.total_affected?.toLocaleString() || "—"}
          </div>
          <div className="okpi-kpi-label">Subjects Affected</div>
        </div>
        {saeRate && (
          <div className="okpi-kpi">
            <div className="okpi-kpi-value" style={{ color: parseFloat(saeRate) > 10 ? "#ed8936" : "#d29922" }}>
              {saeRate}%
            </div>
            <div className="okpi-kpi-label">Overall AE Rate</div>
          </div>
        )}
      </div>

      <div className="okpi-charts-grid">
        {/* Event type breakdown */}
        {data.by_type?.length > 0 && (
          <MiniBar
            data={data.by_type.map(r => ({ label: r.event_type || "Unknown", value: r.affected }))}
            title="Adverse Events by Type"
            highlightFn={d => d.label === "serious" ? "#ed8936" : "#d29922"}
          />
        )}

        {/* Organ systems */}
        {data.by_organ_system?.length > 0 && (
          <MiniBar
            data={data.by_organ_system.map(r => ({ label: r.organ_system, value: r.affected }))}
            title="Top Organ Systems Affected"
            maxItems={12}
          />
        )}

        {/* Top SAEs */}
        {data.top_serious_events?.length > 0 && (
          <MiniBar
            data={data.top_serious_events.map(r => ({ label: r.term, value: r.affected }))}
            title="Top Serious Adverse Events"
            maxItems={15}
            highlightFn={() => "#ed8936"}
          />
        )}

        {/* SAE rate by condition */}
        {data.sae_by_condition?.length > 0 && (
          <MiniBar
            data={data.sae_by_condition.map(r => ({
              label: `${r.condition} (n=${r.trials})`,
              value: r.sae_rate_pct ?? 0,
            }))}
            title="SAE Rate by Condition"
            valueLabel="%"
            highlightFn={d => d.value > 15 ? "#ed8936" : d.value > 5 ? "#d29922" : "#39d2c0"}
          />
        )}
      </div>
    </div>
  );
}

// ── Participant Flow View ───────────────────────────────────────────────
function ParticipantFlow({ filterParams }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    setLoading(true); setError(null);
    const base = trialsApiBase();
    const url = new URL(base ? `${base}/api/milestone-funnel` : `/api/analytics`, window.location.origin);
    if (!base) url.searchParams.set("mode", "milestone-funnel");
    for (const [k, v] of Object.entries(filterParams)) { if (v) url.searchParams.set(k, v); }
    fetch(url.toString())
      .then(r => r.json().then(d => ({ ok: r.ok, d })))
      .then(({ ok, d }) => { if (!ok) throw new Error(d.error || "Failed"); setData(d); })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [filterParams]);

  if (loading) return <div className="okpi-loading">Analyzing participant flow…</div>;
  if (error) return <div className="okpi-error">⚠ {error}</div>;
  if (!data) return null;

  const milestoneRate = data.total_trials > 0
    ? ((data.trials_with_milestones / data.total_trials) * 100).toFixed(1) : null;

  return (
    <div className="okpi-view">
      <div className="okpi-kpis">
        <div className="okpi-kpi">
          <div className="okpi-kpi-value">{data.total_trials.toLocaleString()}</div>
          <div className="okpi-kpi-label">Total Trials</div>
        </div>
        <div className="okpi-kpi">
          <div className="okpi-kpi-value" style={{ color: "#58a6ff" }}>
            {data.trials_with_milestones.toLocaleString()}
          </div>
          <div className="okpi-kpi-label">With Milestone Data</div>
        </div>
        {milestoneRate && (
          <div className="okpi-kpi">
            <div className="okpi-kpi-value">{milestoneRate}%</div>
            <div className="okpi-kpi-label">Milestone Coverage</div>
          </div>
        )}
      </div>

      <div className="okpi-charts-grid">
        {/* Milestone funnel */}
        {data.funnel?.length > 0 && (
          <MiniBar
            data={data.funnel.map(r => ({
              label: `${r.title} (${r.trials} trials)`,
              value: r.total_participants,
            }))}
            title="Participant Flow by Stage"
          />
        )}

        {/* Dropout reasons */}
        {data.drop_reasons?.length > 0 && (
          <MiniBar
            data={data.drop_reasons.map(r => ({
              label: `${r.reason} (${r.trials} trials)`,
              value: r.total,
            }))}
            title="Why Participants Withdraw"
            highlightFn={() => "#d29922"}
          />
        )}
      </div>
    </div>
  );
}

// ── Main Monitor Risk Component ─────────────────────────────────────────
const VIEWS = [
  { key: "safety", label: "Safety Signals", icon: "🔴", question: "What adverse events are most common, and which are serious?" },
  { key: "flow", label: "Participant Flow", icon: "🔄", question: "How do participants flow through trial stages, and where do they drop?" },
];

export default function MonitorRisk({ filterParams }) {
  const [activeView, setActiveView] = useState("safety");

  return (
    <div className="okpi-container">
      <div className="okpi-tabs">
        {VIEWS.map(v => (
          <button
            key={v.key}
            className={`okpi-tab ${activeView === v.key ? "okpi-tab-active" : ""}`}
            onClick={() => setActiveView(v.key)}
            title={v.question}
          >
            <span className="okpi-tab-icon">{v.icon}</span>
            <span>{v.label}</span>
          </button>
        ))}
      </div>
      <div className="okpi-question-hint">
        {VIEWS.find(v => v.key === activeView)?.question}
      </div>
      {activeView === "safety" && <SafetySignals filterParams={filterParams} />}
      {activeView === "flow" && <ParticipantFlow filterParams={filterParams} />}
    </div>
  );
}
