/**
 * PlanComplexity.jsx — Pre-trial design complexity and feasibility profile.
 *
 * Shows: avg arms, planned outcomes, design distribution, group types, duration percentiles.
 * Reacts to chart filters.
 */
import { useState, useEffect } from "react";

function trialsApiBase() {
  return import.meta.env.VITE_TRIALS_API_BASE || "";
}

export default function PlanComplexity({ filterParams }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    setLoading(true); setError(null);
    const base = trialsApiBase();
    const url = new URL(base ? `${base}/api/trial-complexity` : `/api/analytics`, window.location.origin);
    if (!base) url.searchParams.set("mode", "trial-complexity");
    for (const [k, v] of Object.entries(filterParams)) { if (v) url.searchParams.set(k, v); }
    fetch(url.toString())
      .then(r => r.json().then(d => ({ ok: r.ok, d })))
      .then(({ ok, d }) => { if (!ok) throw new Error(d.error || "Failed"); setData(d); })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [filterParams]);

  if (loading) return <div className="okpi-loading">Analyzing trial complexity…</div>;
  if (error) return <div className="okpi-error">⚠ {error}</div>;
  if (!data) return null;

  const dur = data.duration;

  return (
    <div className="okpi-container">
      {/* ── KPI cards ── */}
      <div className="okpi-kpis" style={{ marginBottom: 16 }}>
        <div className="okpi-kpi">
          <div className="okpi-kpi-value">{data.avg_arms ?? "—"}</div>
          <div className="okpi-kpi-label">Avg Arms per Trial</div>
          <div className="okpi-kpi-sub">Max: {data.max_arms ?? "—"}</div>
        </div>
        <div className="okpi-kpi">
          <div className="okpi-kpi-value">{data.avg_planned_outcomes ?? "—"}</div>
          <div className="okpi-kpi-label">Avg Planned Outcomes</div>
          <div className="okpi-kpi-sub">
            Primary: {data.avg_primary_outcomes ?? "—"} · Secondary: {data.avg_secondary_outcomes ?? "—"}
          </div>
        </div>
        {dur?.p50_months && (
          <div className="okpi-kpi">
            <div className="okpi-kpi-value">{dur.p50_months} mo</div>
            <div className="okpi-kpi-label">Median Duration</div>
            <div className="okpi-kpi-sub">P25–P75: {dur.p25_months}–{dur.p75_months} mo</div>
          </div>
        )}
      </div>

      <div className="okpi-charts-grid">
        {/* Group types */}
        {data.group_types?.length > 0 && (
          <div className="okpi-chart">
            <div className="okpi-chart-title">Arm Types Across Trials</div>
            {data.group_types.map((gt) => {
              const maxGT = Math.max(...data.group_types.map(g => g.trials));
              return (
                <div key={gt.group_type} className="okpi-bar-row">
                  <span className="okpi-bar-label">{gt.group_type || "Unknown"}</span>
                  <div className="okpi-bar-track">
                    <div className="okpi-bar-fill" style={{
                      width: `${Math.max((gt.trials / maxGT) * 100, 3)}%`,
                      background: gt.group_type === "Experimental" ? "#39d2c0"
                        : gt.group_type === "Placebo Comparator" ? "#d29922"
                        : gt.group_type === "Active Comparator" ? "#58a6ff"
                        : "#a371f7",
                    }} />
                  </div>
                  <span className="okpi-bar-count">{gt.trials.toLocaleString()}</span>
                </div>
              );
            })}
          </div>
        )}

        {/* Design distribution */}
        {data.design_distribution?.length > 0 && (
          <div className="okpi-chart">
            <div className="okpi-chart-title">Most Common Trial Designs</div>
            {data.design_distribution.map((d, i) => {
              const maxD = data.design_distribution[0].count;
              const label = [d.allocation, d.masking, d.intervention_model].filter(Boolean).join(" · ");
              return (
                <div key={i} className="okpi-bar-row">
                  <span className="okpi-bar-label" title={label}>
                    {label.length > 36 ? label.slice(0, 34) + "…" : label || "Not specified"}
                  </span>
                  <div className="okpi-bar-track">
                    <div className="okpi-bar-fill" style={{
                      width: `${Math.max((d.count / maxD) * 100, 3)}%`,
                      background: "#58a6ff",
                    }} />
                  </div>
                  <span className="okpi-bar-count">{d.count.toLocaleString()}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
