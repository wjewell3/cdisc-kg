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
        <h4>Enrollment Distribution</h4>
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

function AmbitionPanel({ data }) {
  if (!data) return <div className="fp-panel fp-panel-empty"><span className="fp-panel-icon">🎯</span><div>No ambition vs actual data</div></div>;
  const { anticipated, actual, gap_pct } = data;
  const gapColor = gap_pct > 0 ? "#f6ad55" : "#48bb78";
  const gapLabel = gap_pct > 0
    ? `${gap_pct}% over-ambitious` : gap_pct < 0
    ? `${Math.abs(gap_pct)}% under target` : "On target";
  return (
    <div className="fp-panel">
      <div className="fp-panel-header">
        <span className="fp-panel-icon">🎯</span>
        <h4>Enrollment Ambition vs Actual</h4>
      </div>
      <div className="fp-headline-row">
        <div className="fp-headline">
          <span className="fp-headline-val" style={{ fontSize: "1.2rem" }}>{fmt(anticipated?.avg)}</span>
          <span className="fp-headline-unit">avg anticipated</span>
        </div>
        <div className="fp-headline">
          <span className="fp-headline-val" style={{ fontSize: "1.2rem" }}>{fmt(actual?.avg)}</span>
          <span className="fp-headline-unit">avg actual</span>
        </div>
      </div>
      <div className="fp-ambition-gap" style={{ color: gapColor }}>
        <span className="fp-ambition-gap-val">{gapLabel}</span>
      </div>
      <div className="fp-stat-row">
        <span>Anticipated: {anticipated?.count?.toLocaleString()} trials</span>
        <span>Actual: {actual?.count?.toLocaleString()} trials</span>
      </div>
      {data.by_allocation?.length > 0 && (
        <div className="fp-ambition-bars">
          <div className="fp-reasons-title">By allocation design</div>
          {data.by_allocation.map((d, i) => (
            <div key={i} className="fp-ambition-row">
              <span className="fp-reason-text">{d.design}</span>
              <span className="fp-ambition-pair">
                <span className="fp-amb-ant" title="Anticipated">{fmt(d.anticipated)}</span>
                <span className="fp-amb-arrow">→</span>
                <span className="fp-amb-act" title="Actual">{fmt(d.actual)}</span>
              </span>
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

function MilestonePanel({ data }) {
  if (!data) return <div className="fp-panel fp-panel-empty"><span className="fp-panel-icon">📅</span><div>No milestone data available</div></div>;
  const coverage = data.total_trials > 0
    ? ((data.trials_with_milestones / data.total_trials) * 100).toFixed(0) : 0;
  return (
    <div className="fp-panel fp-panel-wide">
      <div className="fp-panel-header">
        <span className="fp-panel-icon">📅</span>
        <h4>Milestone Funnel</h4>
        <span className="fp-panel-n">{coverage}% have milestone data</span>
      </div>
      {data.funnel?.length > 0 ? (
        <div className="fp-funnel">
          {data.funnel.slice(0, 8).map((m, i) => {
            const maxP = data.funnel[0]?.total_participants || 1;
            const pct = Math.max((m.total_participants / maxP) * 100, 5);
            return (
              <div key={i} className="fp-funnel-row">
                <span className="fp-funnel-label">{m.title?.length > 35 ? m.title.slice(0, 33) + "…" : m.title}</span>
                <div className="fp-funnel-track">
                  <div className="fp-funnel-fill" style={{ width: `${pct}%` }} />
                </div>
                <span className="fp-funnel-val">{m.total_participants?.toLocaleString()} <span className="fp-funnel-trials">({m.trials} trials)</span></span>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="fp-stat-row" style={{ color: "#4a5568" }}>No funnel data for this cohort</div>
      )}
      {data.drop_reasons?.length > 0 && (
        <div className="fp-reasons" style={{ marginTop: 12 }}>
          <div className="fp-reasons-title">Top withdrawal reasons</div>
          {data.drop_reasons.slice(0, 5).map((r, i) => (
            <div key={i} className="fp-reason-row">
              <span className="fp-reason-text">{r.reason?.length > 50 ? r.reason.slice(0, 48) + "…" : r.reason}</span>
              <span className="fp-reason-count">{r.total?.toLocaleString()}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── Main component (used as hook) ───────────────────────────────────── */
export default function ForecastPriors({ profile }) {
  const [data, setData] = useState(null);
  const [benchmarkData, setBenchmarkData] = useState(null);
  const [milestoneData, setMilestoneData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const fetchCohort = useCallback(async () => {
    if (!profile || (!profile.condition && !profile.phase && !profile.intervention_type)) {
      setData(null);
      setBenchmarkData(null);
      setMilestoneData(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      // Fetch all three in parallel
      const cohortUrl = buildUrl(profile);

      const benchBase = API_BASE
        ? `${API_BASE}/api/enrollment-benchmark`
        : `/api/analytics?mode=enrollment-benchmark`;
      const benchUrl = new URL(benchBase, window.location.origin);
      if (profile.condition) benchUrl.searchParams.set("condition", profile.condition);
      if (profile.phase) benchUrl.searchParams.set("phase", profile.phase);
      if (profile.allocation) benchUrl.searchParams.set("allocation", profile.allocation);
      if (profile.masking) benchUrl.searchParams.set("masking", profile.masking);
      if (profile.intervention_model) benchUrl.searchParams.set("intervention_model", profile.intervention_model);

      const msBase = API_BASE
        ? `${API_BASE}/api/milestone-funnel`
        : `/api/analytics?mode=milestone-funnel`;
      const msUrl = new URL(msBase, window.location.origin);
      if (profile.condition) msUrl.searchParams.set("condition", profile.condition);
      if (profile.phase) msUrl.searchParams.set("phase", profile.phase);

      const [cohortRes, benchRes, msRes] = await Promise.all([
        fetch(cohortUrl),
        fetch(benchUrl.toString()),
        fetch(msUrl.toString()),
      ]);

      if (!cohortRes.ok) {
        const e = await cohortRes.json().catch(() => ({}));
        throw new Error(e.error || `HTTP ${cohortRes.status}`);
      }
      const d = await cohortRes.json();
      setData(d);

      // Process benchmark
      if (benchRes.ok) {
        const bd = await benchRes.json();
        const anticipated = bd.summary?.find(s => s.enrollment_type === "ESTIMATED");
        const actual = bd.summary?.find(s => s.enrollment_type === "ACTUAL");
        const gapPct = anticipated?.avg_enrollment && actual?.avg_enrollment
          ? parseFloat((((anticipated.avg_enrollment - actual.avg_enrollment) / actual.avg_enrollment) * 100).toFixed(0))
          : 0;
        const byAlloc = [];
        if (bd.by_allocation) {
          const grouped = {};
          for (const r of bd.by_allocation) {
            if (!grouped[r.design]) grouped[r.design] = {};
            grouped[r.design][r.enrollment_type] = r.avg_enrollment;
          }
          for (const [design, vals] of Object.entries(grouped)) {
            if (vals.ESTIMATED || vals.ACTUAL) {
              byAlloc.push({ design, anticipated: vals.ESTIMATED || null, actual: vals.ACTUAL || null });
            }
          }
        }
        setBenchmarkData({
          anticipated: anticipated ? { avg: anticipated.avg_enrollment, count: anticipated.trial_count } : null,
          actual: actual ? { avg: actual.avg_enrollment, count: actual.trial_count } : null,
          gap_pct: gapPct,
          by_allocation: byAlloc,
        });
      } else {
        setBenchmarkData(null);
      }

      // Process milestones
      if (msRes.ok) {
        const md = await msRes.json();
        setMilestoneData(md);
      } else {
        setMilestoneData(null);
      }
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

  return { data, benchmarkData, milestoneData, loading, error, fetchCohort };
}

/* ── Display component ───────────────────────────────────────────────── */
export function ForecastPriorsDisplay({ data, benchmarkData, milestoneData, loading, error }) {
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
        <AmbitionPanel data={benchmarkData} />
        <DurationPanel data={data.duration_months} />
        <SitePanel data={data.site_footprint} />
      </div>
      <MilestonePanel data={milestoneData} />
    </div>
  );
}
