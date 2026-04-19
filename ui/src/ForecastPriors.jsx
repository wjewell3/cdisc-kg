import { useState, useEffect, useCallback } from "react";
import "./ForecastPriors.css";

const API_BASE = import.meta.env.VITE_TRIALS_API_BASE || "";

function buildUrl(profile) {
  const base = API_BASE
    ? `${API_BASE}/api/profile-cohort`
    : `/api/analytics?mode=profile-cohort`;
  const url = new URL(base, window.location.origin);
  for (const [k, v] of Object.entries(profile)) {
    if (v) url.searchParams.set(k, v);
  }
  return url.toString();
}

/* ── Range bar visualization ─────────────────────────────────────────── */
function RangeBar({ p10, p25, p50, p75, p90, unit = "", label = "" }) {
  if (p10 == null || p90 == null) return null;
  const min = p10;
  const max = p90;
  const range = max - min || 1;
  const pct = (v) => ((v - min) / range) * 100;

  return (
    <div className="fp-range-bar-wrap">
      {label && <div className="fp-range-label">{label}</div>}
      <div className="fp-range-bar">
        <div className="fp-range-whisker" style={{ left: "0%", width: `${pct(p25)}%` }} />
        <div className="fp-range-iqr" style={{ left: `${pct(p25)}%`, width: `${pct(p75) - pct(p25)}%` }} />
        <div className="fp-range-whisker" style={{ left: `${pct(p75)}%`, width: `${100 - pct(p75)}%` }} />
        <div className="fp-range-median" style={{ left: `${pct(p50)}%` }} />
      </div>
      <div className="fp-range-ticks">
        <span>P10: {fmt(p10)}{unit}</span>
        <span>P25: {fmt(p25)}{unit}</span>
        <span className="fp-tick-median">P50: {fmt(p50)}{unit}</span>
        <span>P75: {fmt(p75)}{unit}</span>
        <span>P90: {fmt(p90)}{unit}</span>
      </div>
    </div>
  );
}

function fmt(v) {
  if (v == null) return "—";
  if (v >= 1000) return (v / 1000).toFixed(1) + "k";
  return Number.isInteger(v) ? v.toString() : v.toFixed(1);
}

/* ── Panel components ────────────────────────────────────────────────── */
function EnrollmentPanel({ data }) {
  if (!data) return <div className="fp-panel fp-panel-empty"><span className="fp-panel-icon">👥</span><div>Insufficient enrollment data</div></div>;
  return (
    <div className="fp-panel">
      <div className="fp-panel-header">
        <span className="fp-panel-icon">👥</span>
        <h4>Enrollment</h4>
        <span className="fp-panel-n">{data.n?.toLocaleString()} trials</span>
      </div>
      <div className="fp-headline">
        <span className="fp-headline-val">{fmt(data.p50)}</span>
        <span className="fp-headline-unit">median participants</span>
      </div>
      <RangeBar {...data} />
      <div className="fp-stat-row">
        <span>Mean: {fmt(data.mean)}</span>
        <span>IQR: {fmt(data.p25)}–{fmt(data.p75)}</span>
      </div>
    </div>
  );
}

function DurationPanel({ data }) {
  if (!data) return <div className="fp-panel fp-panel-empty"><span className="fp-panel-icon">⏱</span><div>Insufficient duration data</div></div>;
  return (
    <div className="fp-panel">
      <div className="fp-panel-header">
        <span className="fp-panel-icon">⏱</span>
        <h4>Duration</h4>
        <span className="fp-panel-n">{data.n?.toLocaleString()} trials</span>
      </div>
      <div className="fp-headline">
        <span className="fp-headline-val">{fmt(data.p50)}</span>
        <span className="fp-headline-unit">median months</span>
      </div>
      <RangeBar {...data} unit="mo" />
      <div className="fp-stat-row">
        <span>Mean: {fmt(data.mean)} mo</span>
        <span>IQR: {fmt(data.p25)}–{fmt(data.p75)} mo</span>
      </div>
    </div>
  );
}

function TerminationPanel({ data }) {
  if (!data) return <div className="fp-panel fp-panel-empty"><span className="fp-panel-icon">🚫</span><div>No termination data</div></div>;
  return (
    <div className="fp-panel">
      <div className="fp-panel-header">
        <span className="fp-panel-icon">🚫</span>
        <h4>Early Termination</h4>
        <span className="fp-panel-n">{data.terminated_count?.toLocaleString()} terminated</span>
      </div>
      <div className="fp-headline">
        <span className={`fp-headline-val${data.rate_pct > 20 ? " fp-val-warn" : ""}`}>{data.rate_pct}%</span>
        <span className="fp-headline-unit">termination rate</span>
      </div>
      {data.top_reasons?.length > 0 && (
        <div className="fp-reasons">
          <div className="fp-reasons-title">Top stop reasons</div>
          {data.top_reasons.slice(0, 5).map((r, i) => (
            <div key={i} className="fp-reason-row">
              <span className="fp-reason-text">{r.reason?.length > 60 ? r.reason.slice(0, 58) + "…" : r.reason}</span>
              <span className="fp-reason-count">{r.count}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function SitePanel({ data }) {
  if (!data) return <div className="fp-panel fp-panel-empty"><span className="fp-panel-icon">🌍</span><div>No site data</div></div>;
  return (
    <div className="fp-panel">
      <div className="fp-panel-header">
        <span className="fp-panel-icon">🌍</span>
        <h4>Site Footprint</h4>
      </div>
      <div className="fp-headline-row">
        <div className="fp-headline">
          <span className="fp-headline-val">{fmt(data.median_sites)}</span>
          <span className="fp-headline-unit">median sites</span>
        </div>
        <div className="fp-headline">
          <span className="fp-headline-val">{data.us_pct}%</span>
          <span className="fp-headline-unit">include US sites</span>
        </div>
      </div>
      {data.p25_sites != null && (
        <div className="fp-stat-row">
          <span>IQR: {fmt(data.p25_sites)}–{fmt(data.p75_sites)} sites</span>
        </div>
      )}
      {data.top_countries?.length > 0 && (
        <div className="fp-countries">
          <div className="fp-reasons-title">Top countries</div>
          {data.top_countries.slice(0, 6).map((c, i) => (
            <div key={i} className="fp-reason-row">
              <span className="fp-reason-text">{c.country}</span>
              <span className="fp-reason-count">{c.trials?.toLocaleString()}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── Main component ──────────────────────────────────────────────────── */
export default function ForecastPriors({ profile }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const fetchCohort = useCallback(async () => {
    if (!profile || (!profile.condition && !profile.phase && !profile.intervention_type)) {
      setData(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(buildUrl(profile));
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || `HTTP ${r.status}`);
      }
      const d = await r.json();
      setData(d);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [profile]);

  // Expose fetchCohort so parent can trigger it
  useEffect(() => {
    if (profile?._trigger) fetchCohort();
  }, [profile?._trigger, fetchCohort]);

  return { data, loading, error, fetchCohort };
}

/* ── Display component ───────────────────────────────────────────────── */
export function ForecastPriorsDisplay({ data, loading, error }) {
  if (loading) {
    return (
      <div className="fp-loading">
        <div className="fp-spinner" />
        <span>Analyzing cohort distributions…</span>
      </div>
    );
  }

  if (error) {
    return <div className="fp-error">⚠ {error}</div>;
  }

  if (!data) {
    return (
      <div className="fp-empty">
        <div className="fp-empty-icon">🎯</div>
        <div className="fp-empty-text">Set a trial profile above and click <strong>Build Cohort</strong> to see historical priors.</div>
        <div className="fp-empty-hint">Try: <em>Breast Cancer</em> + Phase 3 + Drug + Randomized + Double Blind</div>
      </div>
    );
  }

  if (data.cohort_size === 0) {
    return (
      <div className="fp-empty">
        <div className="fp-empty-icon">🔍</div>
        <div className="fp-empty-text">No trials match this profile. Try broadening your criteria.</div>
      </div>
    );
  }

  return (
    <div className="forecast-priors">
      <div className="fp-cohort-badge">
        <span className="fp-cohort-count">{data.cohort_size.toLocaleString()}</span>
        <span>historical trials match your profile</span>
      </div>
      <div className="fp-panels">
        <EnrollmentPanel data={data.enrollment} />
        <DurationPanel data={data.duration_months} />
        <TerminationPanel data={data.termination} />
        <SitePanel data={data.site_footprint} />
      </div>
    </div>
  );
}
