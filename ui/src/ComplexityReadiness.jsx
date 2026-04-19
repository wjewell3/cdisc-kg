import { useState, useEffect } from "react";
import "./ForecastPriors.css";

function trialsApiBase() {
  return import.meta.env.VITE_TRIALS_API_BASE || "";
}

function CorrelationChart({ data, title, xLabel, yLabel }) {
  if (!data?.length) return null;
  const maxMonths = Math.max(...data.map(d => d.avg_months || 0), 1);
  return (
    <div className="cr-chart">
      <div className="cr-chart-title">{title}</div>
      <div className="cr-chart-subtitle">{xLabel} → {yLabel}</div>
      {data.map((d, i) => (
        <div key={i} className="cr-bar-row">
          <span className="cr-bar-label">{d.bucket}</span>
          <div className="cr-bar-track">
            <div
              className="cr-bar-fill"
              style={{ width: `${Math.max((d.avg_months / maxMonths) * 100, 5)}%` }}
            />
          </div>
          <span className="cr-bar-val">
            {d.avg_months?.toFixed(1)} mo
            <span className="cr-bar-trials">({d.trials?.toLocaleString()})</span>
          </span>
        </div>
      ))}
    </div>
  );
}

export default function ComplexityReadiness({ filterParams }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!filterParams?.condition && !filterParams?.phase) return;
    setLoading(true);
    setError(null);
    const base = trialsApiBase();
    const url = new URL(
      base ? `${base}/api/complexity-readiness` : `/api/analytics`,
      window.location.origin
    );
    if (!base) url.searchParams.set("mode", "complexity-readiness");
    for (const [k, v] of Object.entries(filterParams)) {
      if (v) url.searchParams.set(k, v);
    }
    fetch(url.toString())
      .then(r => r.json().then(d => ({ ok: r.ok, d })))
      .then(({ ok, d }) => {
        if (!ok) throw new Error(d.error || "Failed");
        setData(d);
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [filterParams]);

  if (loading) return <div className="fp-loading"><div className="fp-spinner" /><span>Analyzing complexity → readiness…</span></div>;
  if (error) return <div className="fp-error">⚠ {error}</div>;
  if (!data) return null;

  const hasData = data.by_arms?.length > 0 || data.by_outcomes?.length > 0;
  if (!hasData) {
    return (
      <div className="cr-container">
        <div className="cr-header">
          <span className="cr-icon">📊</span>
          <h4>Complexity → Readiness Correlation</h4>
        </div>
        <div className="fp-stat-row" style={{ color: "#4a5568", padding: "16px 0" }}>
          Insufficient completed trials with reporting data for this cohort.
        </div>
      </div>
    );
  }

  return (
    <div className="cr-container">
      <div className="cr-header">
        <span className="cr-icon">📊</span>
        <div>
          <h4>Complexity → Readiness Correlation</h4>
          <p className="cr-desc">Do more complex trials take longer to report results? Avg months from completion to results posting, grouped by complexity.</p>
        </div>
      </div>
      <div className="cr-grid">
        <CorrelationChart
          data={data.by_arms}
          title="Arm Count → Reporting Time"
          xLabel="Arms per trial"
          yLabel="Avg months to report"
        />
        <CorrelationChart
          data={data.by_outcomes}
          title="Outcome Count → Reporting Time"
          xLabel="Planned outcomes"
          yLabel="Avg months to report"
        />
        {data.by_masking?.length > 0 && (
          <CorrelationChart
            data={data.by_masking}
            title="Masking Level → Reporting Time"
            xLabel="Blinding level"
            yLabel="Avg months to report"
          />
        )}
      </div>
    </div>
  );
}
