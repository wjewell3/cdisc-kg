import { useMemo, useState, useEffect, useRef } from "react";

const PALETTE = ["#58a6ff", "#3fb950", "#d29922", "#f85149", "#a371f7", "#39d2c0", "#f778ba", "#8b949e"];

const PHASE_ORDER = ["PHASE1", "PHASE2", "PHASE3", "PHASE4", "EARLY_PHASE1", "N/A", "Unknown"];
const PHASE_DISPLAY = {
  PHASE1: "Phase 1", PHASE2: "Phase 2", PHASE3: "Phase 3", PHASE4: "Phase 4",
  EARLY_PHASE1: "Early Ph1", "N/A": "N/A",
};

function countBy(rows, fn) {
  const counts = {};
  for (const row of rows) {
    const key = fn(row);
    if (!key) continue;
    counts[key] = (counts[key] || 0) + 1;
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1]);
}

const ENROLL_BUCKETS_MAP = {
  "< 100": [0, 99], "100\u2013499": [100, 499], "500\u2013999": [500, 999],
  "1k\u20134.9k": [1000, 4999], "5k\u201319k": [5000, 19999], "\u2265 20k": [20000, Infinity],
};

function filterTrials(trials, activeFilters, excludeField = null) {
  const relevant = activeFilters.filter((f) => f.field !== excludeField);
  if (!relevant.length) return trials;
  const byField = {};
  for (const { field, value } of relevant) {
    if (!byField[field]) byField[field] = new Set();
    byField[field].add(value);
  }
  return trials.filter((t) =>
    Object.entries(byField).every(([field, values]) => {
      if (field === "phase") return values.has(t.phase || "Unknown");
      if (field === "status") return values.has(t.status || "Unknown");
      if (field === "sponsor") return values.has(t.sponsor || "Unknown");
      if (field === "_enroll_range") {
        return [...values].some((v) => {
          const r = ENROLL_BUCKETS_MAP[v];
          return r && t.enrollment != null && t.enrollment >= r[0] && t.enrollment <= r[1];
        });
      }
      return true;
    })
  );
}

function trialsApiBase() {
  return import.meta.env.VITE_TRIALS_API_BASE || "";
}

function completionColor(rate) {
  if (rate == null) return undefined;
  return rate >= 75 ? "#3fb950" : rate >= 50 ? "#d29922" : "#f85149";
}

function SvgBarChart({ data, title, field, activeValues, onFilter, maxItems = 8, total = null }) {
  const displayData = data.slice(0, maxItems);

  // Append an "(other sponsors)" bar when total is provided and not all are shown
  const shownSum = displayData.reduce((s, [, c]) => s + c, 0);
  const othersCount = total !== null ? total - shownSum : null;
  const rows = othersCount !== null && othersCount > 0
    ? [...displayData, ["(other sponsors)", othersCount]]
    : displayData;

  const maxVal = Math.max(...rows.map((d) => d[1]), 1);
  const barH = 22;
  const gap = 6;
  const padTop = 30;
  const padLeft = 8;
  const padRight = 8;
  const padBottom = 8;
  const svgH = padTop + rows.length * (barH + gap) - gap + padBottom;

  return (
    <div className="trials-svg-wrap">
      <svg
        viewBox={`0 0 360 ${svgH}`}
        preserveAspectRatio="xMidYMid meet"
        className="trials-chart-svg"
        aria-label={title}
      >
        <text x={padLeft} y={20} className="tchart-title">{title}</text>
        {rows.map(([label, count], i) => {
          const isOthers = label === "(other sponsors)";
          const y = padTop + i * (barH + gap);
          const maxBarW = 360 - padLeft - padRight - 80;
          const barW = Math.max((count / maxVal) * maxBarW, 3);
          const isActive = activeValues?.has(label);
          const hasAny = activeValues?.size > 0;
          const color = isOthers ? "#444c56" : PALETTE[i % PALETTE.length];
          const displayLabel = label.length > 22 ? label.slice(0, 20) + "…" : label;
          return (
            <g
              key={label}
              onClick={() => {
                if (!isOthers) {
                  onFilter(field, label);
                }
              }}
              style={{ cursor: isOthers ? "default" : "pointer" }}
              role={isOthers ? undefined : "button"}
              aria-pressed={isActive}
              aria-label={isOthers ? label : `Filter by ${label}: ${count}`}
            >
              <rect
                x={padLeft}
                y={y}
                width={barW}
                height={barH}
                rx={4}
                fill={color}
                opacity={isOthers ? 0.5 : (hasAny && !isActive ? 0.55 : 1)}
              />
              {isActive && (
                <rect
                  x={padLeft - 2} y={y - 2}
                  width={barW + 4} height={barH + 4}
                  rx={5} fill="none" stroke={color} strokeWidth={2}
                />
              )}
              <text x={padLeft + barW + 6} y={y + barH / 2 + 4} className="tchart-count" opacity={isOthers ? 0.6 : 1}>{count}</text>
              <text
                x={padLeft + barW + 6 + (String(count).length * 7) + 4}
                y={y + barH / 2 + 4}
                className="tchart-label"
                opacity={isOthers ? 0.5 : (hasAny && !isActive ? 0.65 : 0.8)}
              >
                {displayLabel}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function SvgDonutChart({ data, title, field, displayMap, activeValues, onFilter }) {
  const displayData = data.slice(0, 8);
  const total = displayData.reduce((s, d) => s + d[1], 0);
  const cx = 90, cy = 90, outerR = 62, innerR = 38;
  let startAngle = -Math.PI / 2;
  const slices = displayData.map((d, i) => {
    const angle = (d[1] / total) * Math.PI * 2;
    const s = { raw: d[0], label: (displayMap && displayMap[d[0]]) || d[0], count: d[1], start: startAngle, end: startAngle + angle, color: PALETTE[i % PALETTE.length] };
    startAngle += angle;
    return s;
  });

  return (
    <div className="trials-svg-wrap">
      <svg
        viewBox="0 0 320 220"
        preserveAspectRatio="xMidYMid meet"
        className="trials-chart-svg"
        aria-label={title}
      >
        <text x={160} y={16} className="tchart-title" textAnchor="middle">{title}</text>

        {slices.map((s) => {
          const isActive = activeValues?.has(s.raw);
          const hasAny = activeValues?.size > 0;
          const midAngle = (s.start + s.end) / 2;
          const pullOut = isActive ? 6 : 0;
          const dx = Math.cos(midAngle) * pullOut;
          const dy = Math.sin(midAngle) * pullOut;
          const bx = cx + dx, by = cy + 20 + dy;
          const outerLargeArc = s.end - s.start > Math.PI ? 1 : 0;
          const ox1 = bx + outerR * Math.cos(s.start), oy1 = by + outerR * Math.sin(s.start);
          const ox2 = bx + outerR * Math.cos(s.end), oy2 = by + outerR * Math.sin(s.end);
          const ix1 = bx + innerR * Math.cos(s.end), iy1 = by + innerR * Math.sin(s.end);
          const ix2 = bx + innerR * Math.cos(s.start), iy2 = by + innerR * Math.sin(s.start);
          const d = `M ${ox1} ${oy1} A ${outerR} ${outerR} 0 ${outerLargeArc} 1 ${ox2} ${oy2} L ${ix1} ${iy1} A ${innerR} ${innerR} 0 ${outerLargeArc} 0 ${ix2} ${iy2} Z`;

          return (
            <path
              key={s.raw}
              d={d}
              fill={s.color}
              opacity={hasAny && !isActive ? 0.3 : 1}
              style={{ cursor: "pointer" }}
              onClick={() => onFilter(field, s.raw)}
              role="button"
              aria-pressed={isActive}
              aria-label={`Filter by ${s.label}: ${s.count}`}
            />
          );
        })}

        <text x={cx} y={cy + 20} className="tdonut-total" textAnchor="middle" dominantBaseline="middle">{total}</text>

        {slices.map((s, i) => {
          const row = Math.floor(i / 2);
          const col = i % 2;
          const lx = 192 + col * 64;
          const ly = 28 + row * 18;
          const isActive = activeValues?.has(s.raw);
          const hasAny = activeValues?.size > 0;
          const lbl = s.label.length > 10 ? s.label.slice(0, 9) + "…" : s.label;
          return (
            <g
              key={s.raw}
              onClick={() => { onFilter(field, s.raw); }}
              style={{ cursor: "pointer" }}
            >
              <rect x={lx} y={ly} width={10} height={10} rx={2} fill={s.color} opacity={hasAny && !isActive ? 0.55 : 1} />
              <text x={lx + 13} y={ly + 9} className="tlegend-text" opacity={hasAny && !isActive ? 0.65 : 1}>
                {lbl} ({s.count})
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function EnrollmentHistogram({ trials, bucketCounts, activeEnrollRanges, onFilter }) {
  const [hoveredIdx, setHoveredIdx] = useState(null);
  const BUCKETS = [
    { label: "< 100", min: 0, max: 99 },
    { label: "100\u2013499", min: 100, max: 499 },
    { label: "500\u2013999", min: 500, max: 999 },
    { label: "1k\u20134.9k", min: 1000, max: 4999 },
    { label: "5k\u201319k", min: 5000, max: 19999 },
    { label: "\u2265 20k", min: 20000, max: Infinity },
  ];

  const data = BUCKETS.map((b) => ({
    ...b,
    count: bucketCounts
      ? (bucketCounts[b.label] || 0)
      : (trials || []).filter((t) => t.enrollment != null && t.enrollment >= b.min && t.enrollment <= b.max).length,
  })).filter((b) => b.count > 0);

  const total = data.reduce((s, d) => s + d.count, 0);
  const maxVal = Math.max(...data.map((d) => d.count), 1);
  const barH = 22, gap = 6, padTop = 30, padLeft = 8, padRight = 8, padBottom = 8;
  const svgH = padTop + data.length * (barH + gap) - gap + padBottom;

  return (
    <div className="trials-svg-wrap">
      <svg viewBox={`0 0 360 ${svgH}`} preserveAspectRatio="xMidYMid meet" className="trials-chart-svg" aria-label="Enrollment Size Distribution">
        <text x={padLeft} y={20} className="tchart-title">Enrollment Distribution</text>
        {data.map((b, i) => {
          const y = padTop + i * (barH + gap);
          const maxBarW = 220;
          const barW = Math.max((b.count / maxVal) * maxBarW, 3);
          const isActive = activeEnrollRanges?.has(b.label);
          const hasAny = activeEnrollRanges?.size > 0;
          const color = PALETTE[i % PALETTE.length];
          const pct = total > 0 ? ((b.count / total) * 100).toFixed(1) : "0.0";
          return (
            <g
              key={b.label}
              onClick={() => { onFilter("_enroll_range", b.label); }}
              onMouseEnter={() => setHoveredIdx(i)}
              onMouseLeave={() => setHoveredIdx(null)}
              style={{ cursor: "pointer" }}
            >
              <title>{`${b.label}: ${b.count.toLocaleString()} trials (${pct}%)`}</title>
              <rect x={padLeft} y={y} width={barW} height={barH} rx={4} fill={color} opacity={hasAny && !isActive ? 0.55 : 1} />
              {isActive && <rect x={padLeft - 2} y={y - 2} width={barW + 4} height={barH + 4} rx={5} fill="none" stroke={color} strokeWidth={2} />}
              <text x={padLeft + barW + 6} y={y + barH / 2 + 4} className="tchart-count">{b.count}</text>
              <text x={padLeft + barW + 6 + (String(b.count).length * 7) + 4} y={y + barH / 2 + 4} className="tchart-label" opacity={hasAny && !isActive ? 0.65 : 0.8}>{b.label}</text>
            </g>
          );
        })}
        {hoveredIdx !== null && (() => {
          const b = data[hoveredIdx];
          const pct = total > 0 ? ((b.count / total) * 100).toFixed(1) : "0.0";
          const y = padTop + hoveredIdx * (barH + gap);
          const ttText = `${b.count.toLocaleString()}\u00a0(${pct}%)`;
          const ttW = ttText.length * 6.5 + 12;
          const ttY = y - 22;
          const finalY = ttY >= 4 ? ttY : y + barH + 4;
          return (
            <g style={{ pointerEvents: "none" }}>
              <rect x={padLeft} y={finalY} width={ttW} height={18} rx={3} fill="#1c2128" stroke="#388bfd" strokeWidth={1} opacity={0.95} />
              <text x={padLeft + 6} y={finalY + 12} fontSize={10} fill="#e6edf3">{ttText}</text>
            </g>
          );
        })()}        
      </svg>
    </div>
  );
}

const ENROLL_BUCKET_MID = {
  "< 100": 50, "100\u2013499": 300, "500\u2013999": 750,
  "1k\u20134.9k": 3000, "5k\u201319k": 12000, "\u2265 20k": 30000,
};

const ACTIVE_STATUSES = new Set(["RECRUITING", "ACTIVE_NOT_RECRUITING", "ENROLLING_BY_INVITATION", "NOT_YET_RECRUITING"]);

function computeStats(agg) {
  if (!agg) return null;
  const total = agg.total || 0;
  if (total === 0) return null;
  const status = agg.status || {};
  const completed = status.COMPLETED || 0;
  let active = 0;
  for (const [k, v] of Object.entries(status)) { if (ACTIVE_STATUSES.has(k)) active += v; }
  const completion_pct = +(completed / total * 100).toFixed(1);
  const active_pct = +(active / total * 100).toFixed(1);
  let enrollSum = 0, enrollCount = 0;
  for (const [label, count] of Object.entries(agg.enrollment || {})) {
    const mid = ENROLL_BUCKET_MID[label];
    if (mid && count) { enrollSum += mid * count; enrollCount += count; }
  }
  const avg_enrollment = enrollCount > 0 ? Math.round(enrollSum / enrollCount) : null;
  return { total, completion_pct, active_pct, avg_enrollment };
}

function StatsBanner({ stats, baseline, hasFilters }) {
  if (!stats) return null;
  function signal(val, base, higherBetter = true) {
    if (val == null || base == null || !hasFilters) return "sb-neutral";
    const diff = val - base;
    if (Math.abs(diff) < 1) return "sb-neutral";
    return (higherBetter ? diff > 0 : diff < 0) ? "sb-better" : "sb-worse";
  }
  const bStats = baseline || stats;
  return (
    <div className="stats-banner">
      <div className={`sb-stat ${signal(stats.completion_pct, bStats.completion_pct)}`}>
        <span className="sb-value">{stats.completion_pct ?? "\u2014"}%</span>
        <span className="sb-label">completed</span>
        {hasFilters && baseline && Math.abs(stats.completion_pct - baseline.completion_pct) >= 1 && (
          <span className="sb-delta">{stats.completion_pct > baseline.completion_pct ? "\u25b2" : "\u25bc"}{Math.abs(+(stats.completion_pct - baseline.completion_pct).toFixed(1))}pp</span>
        )}
      </div>
      <div className="sb-divider" />
      <div className={`sb-stat ${signal(stats.active_pct, bStats.active_pct)}`}>
        <span className="sb-value">{stats.active_pct ?? "\u2014"}%</span>
        <span className="sb-label">active</span>
        {hasFilters && baseline && Math.abs(stats.active_pct - baseline.active_pct) >= 1 && (
          <span className="sb-delta">{stats.active_pct > baseline.active_pct ? "\u25b2" : "\u25bc"}{Math.abs(+(stats.active_pct - baseline.active_pct).toFixed(1))}pp</span>
        )}
      </div>
      <div className="sb-divider" />
      <div className="sb-stat sb-neutral">
        <span className="sb-value">{stats.avg_enrollment != null ? stats.avg_enrollment.toLocaleString() : "\u2014"}</span>
        <span className="sb-label">avg enrolled</span>
      </div>
      <div className="sb-divider" />
      <div className="sb-stat sb-neutral">
        <span className="sb-value">{stats.total.toLocaleString()}</span>
        <span className="sb-label">trials</span>
      </div>
    </div>
  );
}

export { computeStats };

export default function TrialsCharts({ trials, aggData, baseAggData, activeFilters = [], onFilter, stats, baselineStats, hasFilteredStats, fetchSponsors, fetchConditions, fetchInterventions, normalizeAggData }) {
  const getActiveVals = (field) => new Set(activeFilters.filter((f) => f.field === field).map((f) => f.value));

  // Sponsor search state — async, queries all sponsors on the server
  const [sponsorSearch, setSponsorSearch] = useState("");
  const [sponsorSearchData, setSponsorSearchData] = useState(null); // null = use default aggData
  const [sponsorSearchLoading, setSponsorSearchLoading] = useState(false);
  const sponsorSearchRef = useRef(null);

  // Condition search state
  const [conditionSearch, setConditionSearch] = useState("");
  const [conditionSearchData, setConditionSearchData] = useState(null);
  const [conditionSearchLoading, setConditionSearchLoading] = useState(false);
  const conditionSearchRef = useRef(null);

  // Intervention search state
  const [interventionSearch, setInterventionSearch] = useState("");
  const [interventionSearchData, setInterventionSearchData] = useState(null);
  const [interventionSearchLoading, setInterventionSearchLoading] = useState(false);
  const interventionSearchRef = useRef(null);

  // Generic async search hook factory
  function useAsyncSearch(search, setData, setLoading, searchRef, fetchFn) {
    useEffect(() => {
      if (!search.trim()) { setData(null); return; }
      setLoading(true);
      const thisSearch = search;
      const tid = setTimeout(() => {
        fetchFn(thisSearch).then((results) => {
          if (searchRef.current === thisSearch) { setData(results); setLoading(false); }
        }).catch(() => setLoading(false));
      }, 250);
      searchRef.current = search;
      return () => clearTimeout(tid);
    }, [search]); // eslint-disable-line
  }

  useAsyncSearch(sponsorSearch, setSponsorSearchData, setSponsorSearchLoading, sponsorSearchRef, fetchSponsors || (() => Promise.resolve([])));
  useAsyncSearch(conditionSearch, setConditionSearchData, setConditionSearchLoading, conditionSearchRef, fetchConditions || (() => Promise.resolve([])));
  useAsyncSearch(interventionSearch, setInterventionSearchData, setInterventionSearchLoading, interventionSearchRef, fetchInterventions || (() => Promise.resolve([])));

  // Reset search results when filters change so top-N are shown again
  useEffect(() => {
    setSponsorSearch(""); setSponsorSearchData(null);
    setConditionSearch(""); setConditionSearchData(null);
    setInterventionSearch(""); setInterventionSearchData(null);
  }, [activeFilters, aggData]);

  const phaseData = useMemo(() => {
    let raw;
    if (aggData?.phase) {
      raw = Object.entries(aggData.phase);
    } else {
      raw = countBy(filterTrials(trials, activeFilters, "phase"), (t) => t.phase || "Unknown");
    }
    const normalized = normalizeAggData ? normalizeAggData("phase", raw) : raw;
    return normalized.sort((a, b) => {
      const ai = PHASE_ORDER.indexOf(a[0]); const bi = PHASE_ORDER.indexOf(b[0]);
      return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    });
  }, [trials, activeFilters, aggData, normalizeAggData]);

  const statusData = useMemo(() => {
    const raw = aggData?.status
      ? Object.entries(aggData.status)
      : countBy(filterTrials(trials, activeFilters, "status"), (t) => t.status || "Unknown");
    const normalized = normalizeAggData ? normalizeAggData("status", raw) : raw;
    return normalized.sort((a, b) => b[1] - a[1]);
  }, [trials, activeFilters, aggData, normalizeAggData]);

  const sponsorData = useMemo(() => {
    const raw = sponsorSearchData !== null ? sponsorSearchData
      : (aggData?.sponsor || countBy(filterTrials(trials, activeFilters, "sponsor"), (t) => t.sponsor || "Unknown"));
    return normalizeAggData ? normalizeAggData("sponsor", raw) : raw;
  }, [trials, activeFilters, aggData, sponsorSearchData, normalizeAggData]);

  const conditionData = useMemo(() => {
    const raw = conditionSearchData !== null ? conditionSearchData : (aggData?.condition || []);
    return normalizeAggData ? normalizeAggData("condition", raw) : raw;
  }, [aggData, conditionSearchData, normalizeAggData]);

  const interventionData = useMemo(() => {
    const raw = interventionSearchData !== null ? interventionSearchData : (aggData?.intervention || []);
    return normalizeAggData ? normalizeAggData("intervention", raw) : raw;
  }, [aggData, interventionSearchData, normalizeAggData]);

  const totalCount = aggData?.total ?? trials.length;
  const hasEnrollment = aggData?.enrollment
    ? Object.values(aggData.enrollment).some((c) => c > 0)
    : trials.some((t) => t.enrollment != null);

  const hasData = (data) => data.length > 0;

  if (!aggData && trials.length === 0) return null;

  const hasAnyData =
    hasData(phaseData) || hasData(statusData) || hasData(sponsorData) || hasData(conditionData) || hasData(interventionData) || hasEnrollment;

  if (!hasAnyData) return null;

  const currentStats = stats || computeStats(aggData);
  const bStats = baselineStats || computeStats(baseAggData);

  return (
    <div className="trials-charts-section">
      <div className="trials-charts-header">
        <div className="section-icon">📊</div>
        <h3>Cross-Trial Analytics</h3>
        <span className="tchart-count-badge">{totalCount.toLocaleString()} trial{totalCount !== 1 ? "s" : ""}</span>
        {activeFilters.length > 0 && (
          <button className="tchart-clear-btn" onClick={() => onFilter(null, null)}>
            Clear all ×
          </button>
        )}
      </div>
      <StatsBanner stats={currentStats} baseline={bStats} hasFilters={hasFilteredStats ?? activeFilters.length > 0} />
      <div className="trials-charts-grid">
        {hasData(phaseData) && (
          phaseData.length > 3 ? (
            <SvgBarChart
              data={[...phaseData].sort((a, b) => b[1] - a[1])}
              title="Phase Distribution"
              field="phase"
              displayMap={PHASE_DISPLAY}
              activeValues={getActiveVals("phase")}
              onFilter={onFilter}
            />
          ) : (
            <SvgDonutChart
              data={phaseData}
              title="Phase Distribution"
              field="phase"
              displayMap={PHASE_DISPLAY}
              activeValues={getActiveVals("phase")}
              onFilter={onFilter}
            />
          )
        )}
        {hasData(statusData) && (
          <SvgBarChart
            data={statusData}
            title="Recruitment Status"
            field="status"
            activeValues={getActiveVals("status")}
            onFilter={onFilter}
          />
        )}
        {hasEnrollment && (
          <EnrollmentHistogram
            trials={aggData ? null : filterTrials(trials, activeFilters, "_enroll_range")}
            bucketCounts={aggData?.enrollment}
            activeEnrollRanges={getActiveVals("_enroll_range")}
            onFilter={onFilter}
          />
        )}
        {hasData(sponsorData) && (
          <div className="trials-svg-wrap-outer">
            <input
              className="sponsor-search-input"
              type="text"
              placeholder="Search all sponsors…"
              value={sponsorSearch}
              onChange={(e) => setSponsorSearch(e.target.value)}
            />
            {sponsorSearchLoading && <div className="sponsor-search-loading">Searching…</div>}
            <SvgBarChart
              data={sponsorData}
              title="Top Sponsors"
              field="sponsor"
              activeValues={getActiveVals("sponsor")}
              onFilter={onFilter}
              total={sponsorSearch ? null : totalCount}
            />
          </div>
        )}
        {hasData(conditionData) && (
          <div className="trials-svg-wrap-outer">
            <input
              className="sponsor-search-input"
              type="text"
              placeholder="Search all conditions…"
              value={conditionSearch}
              onChange={(e) => setConditionSearch(e.target.value)}
            />
            {conditionSearchLoading && <div className="sponsor-search-loading">Searching…</div>}
            <SvgBarChart
              data={conditionData}
              title="Top Conditions"
              field="condition"
              activeValues={getActiveVals("condition")}
              onFilter={onFilter}
              total={conditionSearch ? null : totalCount}
            />
          </div>
        )}
        {hasData(interventionData) && (
          <div className="trials-svg-wrap-outer">
            <input
              className="sponsor-search-input"
              type="text"
              placeholder="Search all interventions…"
              value={interventionSearch}
              onChange={(e) => setInterventionSearch(e.target.value)}
            />
            {interventionSearchLoading && <div className="sponsor-search-loading">Searching…</div>}
            <SvgBarChart
              data={interventionData}
              title="Top Interventions"
              field="intervention"
              activeValues={getActiveVals("intervention")}
              onFilter={onFilter}
              total={interventionSearch ? null : totalCount}
            />
          </div>
        )}
      </div>
    </div>
  );
}
