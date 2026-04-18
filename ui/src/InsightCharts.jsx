import { useState, useMemo } from "react";

const PALETTE = ["#58a6ff", "#3fb950", "#d29922", "#f85149", "#a371f7", "#39d2c0", "#f778ba", "#8b949e"];

function countBy(rows, field) {
  const counts = {};
  for (const row of rows) {
    const val = String(row[field] || "Unknown");
    counts[val] = (counts[val] || 0) + 1;
  }
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);
}

function SvgBarChart({ data, title, field, activeValues, onFilter }) {
  const [hoveredIdx, setHoveredIdx] = useState(null);
  const total = data.reduce((s, d) => s + d[1], 0);
  const maxVal = Math.max(...data.map((d) => d[1]), 1);
  const barH = 22;
  const gap = 6;
  const padTop = 30;
  const padLeft = 8;
  const padRight = 8;
  const padBottom = 8;
  const svgH = padTop + data.length * (barH + gap) - gap + padBottom;

  return (
    <div className="insight-svg-wrap">
      <svg
        viewBox={`0 0 360 ${svgH}`}
        preserveAspectRatio="xMidYMid meet"
        className="insight-svg"
        aria-label={title}
      >
        <text x={padLeft} y={20} className="chart-title">{title}</text>
        {data.map(([label, count], i) => {
          const y = padTop + i * (barH + gap);
          const maxBarW = 360 - padLeft - padRight - 80;
          const barW = Math.max((count / maxVal) * maxBarW, 3);
          const isActive = activeValues?.has(label);
          const hasAny = activeValues?.size > 0;
          const color = "#39d2c0";
          const displayLabel = label.length > 22 ? label.slice(0, 20) + "…" : label;
          const pct = total > 0 ? ((count / total) * 100).toFixed(1) : "0.0";
          return (
            <g
              key={label}
              className={`chart-bar-group ${isActive ? "chart-active" : ""}`}
              onClick={() => onFilter(field, label)}
              onMouseEnter={() => setHoveredIdx(i)}
              onMouseLeave={() => setHoveredIdx(null)}
              style={{ cursor: "pointer" }}
              role="button"
              aria-pressed={isActive}
              aria-label={`Filter by ${label}: ${count}`}
            >
              <title>{`${label}: ${count.toLocaleString()} (${pct}%)`}</title>
              <rect
                x={padLeft}
                y={y}
                width={barW}
                height={barH}
                rx={4}
                fill={color}
                opacity={hasAny && !isActive ? 0.35 : 1}
              />
              {isActive && (
                <rect
                  x={padLeft - 2}
                  y={y - 2}
                  width={barW + 4}
                  height={barH + 4}
                  rx={5}
                  fill="none"
                  stroke={color}
                  strokeWidth={2}
                />
              )}
              <text
                x={padLeft + barW + 6}
                y={y + barH / 2 + 4}
                className="chart-count"
              >
                {count}
              </text>
              <text
                x={padLeft + barW + 6 + (String(count).length * 7) + 4}
                y={y + barH / 2 + 4}
                className="chart-label"
                opacity={hasAny && !isActive ? 0.45 : 0.8}
              >
                {displayLabel}
              </text>
            </g>
          );
        })}
        {hoveredIdx !== null && (() => {
          const [label, count] = data[hoveredIdx];
          const pct = total > 0 ? ((count / total) * 100).toFixed(1) : "0.0";
          const y = padTop + hoveredIdx * (barH + gap);
          const ttText = `${count.toLocaleString()} (${pct}%)`;
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

function SvgDonutChart({ data, title, field, activeValues, onFilter }) {
  const [hoveredIdx, setHoveredIdx] = useState(null);
  const total = data.reduce((s, d) => s + d[1], 0);
  const cx = 90, cy = 90, outerR = 62, innerR = 38;
  let startAngle = -Math.PI / 2;
  const slices = data.map((d, i) => {
    const angle = (d[1] / total) * Math.PI * 2;
    const s = { label: d[0], count: d[1], start: startAngle, end: startAngle + angle, color: PALETTE[i % PALETTE.length] };
    startAngle += angle;
    return s;
  });

  function describeArc(cx, cy, r, startAngle, endAngle) {
    const x1 = cx + r * Math.cos(startAngle);
    const y1 = cy + r * Math.sin(startAngle);
    const x2 = cx + r * Math.cos(endAngle);
    const y2 = cy + r * Math.sin(endAngle);
    const largeArc = endAngle - startAngle > Math.PI ? 1 : 0;
    return `M ${x1} ${y1} A ${r} ${r} 0 ${largeArc} 1 ${x2} ${y2}`;
  }

  return (
    <div className="insight-svg-wrap">
      <svg
        viewBox="0 0 320 220"
        preserveAspectRatio="xMidYMid meet"
        className="insight-svg"
        aria-label={title}
      >
        <text x={160} y={16} className="chart-title" textAnchor="middle">{title}</text>

        {slices.map((s, i) => {
          const isActive = activeValues?.has(s.label);
          const hasAny = activeValues?.size > 0;
          const midAngle = (s.start + s.end) / 2;
          const pullOut = isActive ? 6 : 0;
          const dx = Math.cos(midAngle) * pullOut;
          const dy = Math.sin(midAngle) * pullOut;

          const outerArc = describeArc(cx + dx, cy + 20 + dy, outerR, s.start, s.end);
          const innerArc = describeArc(cx + dx, cy + 20 + dy, innerR, s.end, s.start);
          const ix1 = cx + dx + innerR * Math.cos(s.end);
          const iy1 = cy + 20 + dy + innerR * Math.sin(s.end);
          const ox1 = cx + dx + outerR * Math.cos(s.end);
          const oy1 = cy + 20 + dy + outerR * Math.sin(s.end);
          const ix2 = cx + dx + innerR * Math.cos(s.start);
          const iy2 = cy + 20 + dy + innerR * Math.sin(s.start);
          const ox2 = cx + dx + outerR * Math.cos(s.start);
          const oy2 = cy + 20 + dy + outerR * Math.sin(s.start);

          const outerLargeArc = s.end - s.start > Math.PI ? 1 : 0;
          const d = `M ${ox2} ${oy2} A ${outerR} ${outerR} 0 ${outerLargeArc} 1 ${ox1} ${oy1} L ${ix1} ${iy1} A ${innerR} ${innerR} 0 ${outerLargeArc} 0 ${ix2} ${iy2} Z`;
          const pct = total > 0 ? ((s.count / total) * 100).toFixed(1) : "0.0";

          return (
            <g
              key={s.label}
              onMouseEnter={() => setHoveredIdx(i)}
              onMouseLeave={() => setHoveredIdx(null)}
              onClick={() => onFilter(field, s.label)}
              style={{ cursor: "pointer" }}
              role="button"
              aria-pressed={isActive}
              aria-label={`Filter by ${s.label}: ${s.count}`}
            >
              <title>{`${s.label}: ${s.count.toLocaleString()} (${pct}%)`}</title>
              <path
                d={d}
                fill={s.color}
                opacity={hasAny && !isActive ? 0.3 : 1}
                className="chart-slice"
              />
            </g>
          );
        })}

        {/* Center: total or hovered slice info */}
        {hoveredIdx !== null ? (
          <g style={{ pointerEvents: "none" }}>
            <text x={cx} y={cy + 20 - 9} textAnchor="middle" fontSize={9} fill="#8b949e">
              {slices[hoveredIdx].label.length > 11 ? slices[hoveredIdx].label.slice(0, 10) + "…" : slices[hoveredIdx].label}
            </text>
            <text x={cx} y={cy + 20 + 6} className="donut-total" textAnchor="middle" dominantBaseline="middle">
              {slices[hoveredIdx].count.toLocaleString()}
            </text>
            <text x={cx} y={cy + 20 + 20} textAnchor="middle" fontSize={9} fill="#8b949e">
              {((slices[hoveredIdx].count / total) * 100).toFixed(1)}%
            </text>
          </g>
        ) : (
          <text x={cx} y={cy + 20} className="donut-total" textAnchor="middle" dominantBaseline="middle">
            {total}
          </text>
        )}

        {/* Legend */}
        {data.map((d, i) => {
          const row = Math.floor(i / 2);
          const col = i % 2;
          const lx = 192 + col * 64;
          const ly = 28 + row * 18;
          const isActive = activeValues?.has(d[0]);
          const hasAny = activeValues?.size > 0;
          const lbl = d[0].length > 11 ? d[0].slice(0, 10) + "…" : d[0];
          return (
            <g
              key={d[0]}
              className={`legend-item ${isActive ? "chart-active" : ""}`}
              onClick={() => onFilter(field, d[0])}
              onMouseEnter={() => setHoveredIdx(i)}
              onMouseLeave={() => setHoveredIdx(null)}
              style={{ cursor: "pointer" }}
            >
              <title>{`${d[0]}: ${d[1].toLocaleString()} (${total > 0 ? ((d[1]/total)*100).toFixed(1) : 0}%)`}</title>
              <rect
                x={lx}
                y={ly}
                width={10}
                height={10}
                rx={2}
                fill={PALETTE[i % PALETTE.length]}
                opacity={hasAny && !isActive ? 0.35 : 1}
              />
              <text
                x={lx + 13}
                y={ly + 9}
                className="legend-text"
                opacity={hasAny && !isActive ? 0.45 : 1}
              >
                {lbl} ({d[1]})
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

export { countBy, PALETTE };

// Cross-filter: returns rows matching all activeFilters EXCEPT the one for excludeField
function filterRows(rows, activeFilters, excludeField = null) {
  const relevant = activeFilters.filter((f) => f.field !== excludeField);
  if (!relevant.length) return rows;
  const byField = {};
  for (const { field, value } of relevant) {
    if (!byField[field]) byField[field] = new Set();
    byField[field].add(value);
  }
  return rows.filter((row) =>
    Object.entries(byField).every(([field, values]) => {
      if (field === "AESEV") return values.has(row.AESEV);
      if (field === "AEBODSYS") return values.has(row.AEBODSYS);
      if (field === "AEREL") return values.has(row.AEREL);
      if (field === "AEOUT") return values.has(row.AEOUT);
      if (field === "AESER_LABEL") return values.has(row.AESER === "Y" ? "Serious" : "Not Serious");
      if (field === "_ARM") return values.has(row._dm?.ARM || row.ARM);
      if (field === "_SEX_LABEL") {
        const sex = row._dm?.SEX || row.SEX;
        return values.has(sex === "F" ? "Female" : sex === "M" ? "Male" : sex);
      }
      if (field === "_SITE") return values.has(row._dm?.SITE || row.SITE);
      return true;
    })
  );
}

export default function InsightCharts({ results, primaryDomain, activeFilters = [], onFilter }) {
  const getActiveValues = (field) => new Set(activeFilters.filter((f) => f.field === field).map((f) => f.value));
  const charts = useMemo(() => {
    if (!results || results.length === 0) return null;

    const out = [];

    if (primaryDomain === "AE") {
      const sevData = countBy(filterRows(results, activeFilters, "AESEV"), "AESEV");
      if (sevData.length > 0) out.push({ type: "donut", data: sevData, title: "Severity Distribution", field: "AESEV" });

      const bodysysData = countBy(filterRows(results, activeFilters, "AEBODSYS"), "AEBODSYS");
      if (bodysysData.length > 0) out.push({ type: "bar", data: bodysysData, title: "Body System (SOC)", field: "AEBODSYS" });

      const relData = countBy(filterRows(results, activeFilters, "AEREL"), "AEREL");
      if (relData.length > 0) out.push({ type: "donut", data: relData, title: "Causality", field: "AEREL" });

      const outData = countBy(filterRows(results, activeFilters, "AEOUT"), "AEOUT");
      if (outData.length > 0) out.push({ type: "bar", data: outData, title: "Outcome", field: "AEOUT" });

      const serData = countBy(filterRows(results, activeFilters, "AESER_LABEL"), "AESER");
      if (serData.length > 0) {
        const mapped = serData.map(([v, c]) => [v === "Y" ? "Serious" : "Not Serious", c]);
        out.push({ type: "donut", data: mapped, title: "Seriousness", field: "AESER_LABEL" });
      }
    }

    const armData = countBy(filterRows(results, activeFilters, "_ARM").map((r) => r._dm || r), "ARM");
    if (armData.length > 0) out.push({ type: "donut", data: armData, title: "Treatment Arm", field: "_ARM" });

    const sexData = countBy(filterRows(results, activeFilters, "_SEX_LABEL").map((r) => r._dm || r), "SEX");
    if (sexData.length > 0) {
      const mapped = sexData.map(([v, c]) => [v === "F" ? "Female" : v === "M" ? "Male" : v, c]);
      out.push({ type: "donut", data: mapped, title: "Sex", field: "_SEX_LABEL" });
    }

    const siteData = countBy(filterRows(results, activeFilters, "_SITE").map((r) => r._dm || r), "SITE");
    if (siteData.length > 1) out.push({ type: "bar", data: siteData, title: "Clinical Site", field: "_SITE" });

    return out;
  }, [results, primaryDomain, activeFilters]);

  if (!charts || charts.length === 0) return null;

  return (
    <div className="insight-charts">
      <div className="insight-header">
        <div className="section-icon">📈</div>
        <h3>Visual Insights</h3>
        <span className="insight-count">{charts.length} charts</span>
        {activeFilters.length > 0 && (
          <button className="filter-reset-btn" onClick={() => onFilter(null, null)}>
            Clear all ×
          </button>
        )}
      </div>
      <div className="insight-grid">
        {charts.map((c, i) =>
          c.type === "bar" ? (
            <SvgBarChart
              key={i}
              data={c.data}
              title={c.title}
              field={c.field}
              activeValues={getActiveValues(c.field)}
              onFilter={onFilter}
            />
          ) : (
            <SvgDonutChart
              key={i}
              data={c.data}
              title={c.title}
              field={c.field}
              activeValues={getActiveValues(c.field)}
              onFilter={onFilter}
            />
          )
        )}
      </div>
    </div>
  );
}
