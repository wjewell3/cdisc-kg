import { useMemo, useState } from "react";

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

function SvgBarChart({ data, title, field, activeValues, onFilter, maxItems = 8 }) {
  const displayData = data.slice(0, maxItems);
  const maxVal = Math.max(...displayData.map((d) => d[1]), 1);
  const barH = 22;
  const gap = 6;
  const padTop = 30;
  const padLeft = 8;
  const padRight = 8;
  const padBottom = 8;
  const svgH = padTop + displayData.length * (barH + gap) - gap + padBottom;

  return (
    <div className="trials-svg-wrap">
      <svg
        viewBox={`0 0 360 ${svgH}`}
        preserveAspectRatio="xMidYMid meet"
        className="trials-chart-svg"
        aria-label={title}
      >
        <text x={padLeft} y={20} className="tchart-title">{title}</text>
        {displayData.map(([label, count], i) => {
          const y = padTop + i * (barH + gap);
          const maxBarW = 360 - padLeft - padRight - 80;
          const barW = Math.max((count / maxVal) * maxBarW, 3);
          const isActive = activeValues?.has(label);
          const hasAny = activeValues?.size > 0;
          const color = PALETTE[i % PALETTE.length];
          const displayLabel = label.length > 22 ? label.slice(0, 20) + "…" : label;
          return (
            <g
              key={label}
              onClick={() => onFilter(field, label)}
              style={{ cursor: "pointer" }}
              role="button"
              aria-pressed={isActive}
              aria-label={`Filter by ${label}: ${count}`}
            >
              <rect
                x={padLeft}
                y={y}
                width={barW}
                height={barH}
                rx={4}
                fill={color}
                opacity={hasAny && !isActive ? 0.55 : 1}
              />
              {isActive && (
                <rect
                  x={padLeft - 2} y={y - 2}
                  width={barW + 4} height={barH + 4}
                  rx={5} fill="none" stroke={color} strokeWidth={2}
                />
              )}
              <text x={padLeft + barW + 6} y={y + barH / 2 + 4} className="tchart-count">{count}</text>
              <text
                x={padLeft + barW + 6 + (String(count).length * 7) + 4}
                y={y + barH / 2 + 4}
                className="tchart-label"
                opacity={hasAny && !isActive ? 0.65 : 0.8}
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
              onClick={() => onFilter(field, s.raw)}
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
              onClick={() => onFilter("_enroll_range", b.label)}
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

export default function TrialsCharts({ trials, aggData, activeFilters = [], onFilter }) {
  const getActiveVals = (field) => new Set(activeFilters.filter((f) => f.field === field).map((f) => f.value));

  const phaseData = useMemo(() => {
    if (aggData?.phase) {
      return Object.entries(aggData.phase).sort((a, b) => {
        const ai = PHASE_ORDER.indexOf(a[0]); const bi = PHASE_ORDER.indexOf(b[0]);
        return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
      });
    }
    const raw = countBy(filterTrials(trials, activeFilters, "phase"), (t) => t.phase || "Unknown");
    return raw.sort((a, b) => { const ai = PHASE_ORDER.indexOf(a[0]); const bi = PHASE_ORDER.indexOf(b[0]); return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi); });
  }, [trials, activeFilters, aggData]);

  const statusData = useMemo(() => {
    if (aggData?.status) return Object.entries(aggData.status).sort((a, b) => b[1] - a[1]);
    return countBy(filterTrials(trials, activeFilters, "status"), (t) => t.status || "Unknown");
  }, [trials, activeFilters, aggData]);

  const sponsorData = useMemo(() => {
    if (aggData?.sponsor) return aggData.sponsor.slice(0, 8);
    return countBy(filterTrials(trials, activeFilters, "sponsor"), (t) => t.sponsor || "Unknown").slice(0, 8);
  }, [trials, activeFilters, aggData]);

  const totalCount = aggData?.total ?? trials.length;
  const hasEnrollment = aggData?.enrollment
    ? Object.values(aggData.enrollment).some((c) => c > 0)
    : trials.some((t) => t.enrollment != null);

  const hasData = (data) => data.length > 0;

  if (!aggData && trials.length === 0) return null;

  const hasAnyData =
    hasData(phaseData) || hasData(statusData) || hasData(sponsorData) || hasEnrollment;

  if (!hasAnyData) return null;

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
          <SvgBarChart
            data={sponsorData}
            title="Top Sponsors"
            field="sponsor"
            activeValues={getActiveVals("sponsor")}
            onFilter={onFilter}
            maxItems={8}
          />
        )}
      </div>
    </div>
  );
}
