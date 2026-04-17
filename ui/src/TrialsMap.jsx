/**
 * TrialsMap — Choropleth world map showing trial density by country.
 * Reacts to TrialsPanel filterParams. Click a country to add it as a filter.
 */
import { useState, useEffect, useCallback, useMemo, memo } from "react";
import { ComposableMap, Geographies, Geography, ZoomableGroup } from "react-simple-maps";
import "./TrialsMap.css";

const GEO_URL = "https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json";

// ISO 3166 name → topo name mapping for common mismatches
const NAME_MAP = {
  "United States": "United States of America",
  "South Korea": "South Korea",
  "Czechia": "Czech Republic",
  "Turkey (Türkiye)": "Turkey",
  "Russia": "Russia",
  "Hong Kong": "Hong Kong",
};

const SCALE = [
  { min: 0, max: 0, color: "#161b22" },
  { min: 1, max: 50, color: "#0e4429" },
  { min: 51, max: 500, color: "#006d32" },
  { min: 501, max: 2000, color: "#26a641" },
  { min: 2001, max: 10000, color: "#39d353" },
  { min: 10001, max: Infinity, color: "#58a6ff" },
];

function countryColor(count) {
  if (!count) return SCALE[0].color;
  for (const s of SCALE) {
    if (count >= s.min && count <= s.max) return s.color;
  }
  return SCALE[SCALE.length - 1].color;
}

function trialsApiBase() {
  return import.meta.env.VITE_TRIALS_API_BASE || "";
}

function fmt(n) {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
  return String(n);
}

const MemoGeo = memo(function MemoGeo({ geo, fill, stroke, onMouseEnter, onMouseLeave, onClick }) {
  return (
    <Geography
      geography={geo}
      fill={fill}
      stroke={stroke}
      strokeWidth={0.4}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onClick={onClick}
      style={{
        default: { outline: "none" },
        hover: { outline: "none", fill: "#58a6ff", cursor: "pointer" },
        pressed: { outline: "none" },
      }}
    />
  );
});

export default function TrialsMap({ filterParams = {}, onCountryFilter }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [tooltip, setTooltip] = useState(null);
  const [collapsed, setCollapsed] = useState(false);

  const fetchData = useCallback((filters = {}) => {
    setLoading(true);
    setError(null);
    const base = trialsApiBase();
    const url = new URL(base ? `${base}/api/geographic-intelligence` : `/api/analytics`, window.location.origin);
    if (!base) url.searchParams.set("mode", "geographic");
    for (const [k, v] of Object.entries(filters)) {
      if (v) url.searchParams.set(k, v);
    }
    fetch(url.toString())
      .then(r => r.json().then(d => ({ ok: r.ok, d })))
      .then(({ ok, d }) => {
        if (!ok) throw new Error(d.error || "Failed");
        setData(d);
        setLoading(false);
      })
      .catch(e => { setError(e.message); setLoading(false); });
  }, []);

  useEffect(() => { fetchData(filterParams); }, [filterParams, fetchData]);

  // Build lookup: topo name → trial count
  const countryMap = useMemo(() => {
    if (!data?.by_country) return {};
    const m = {};
    for (const c of data.by_country) {
      m[c.country] = c.trial_count;
      // Also map the alternate name
      if (NAME_MAP[c.country]) m[NAME_MAP[c.country]] = c.trial_count;
    }
    return m;
  }, [data]);

  // Reverse lookup: topo name → AACT country name (for filtering)
  const reverseMap = useMemo(() => {
    const rm = {};
    for (const [aact, topo] of Object.entries(NAME_MAP)) {
      rm[topo] = aact;
    }
    return rm;
  }, []);

  if (collapsed) {
    return (
      <div className="trials-map-collapsed" onClick={() => setCollapsed(false)}>
        <span className="trials-map-toggle">🌍 Show Geography Map</span>
      </div>
    );
  }

  return (
    <div className="trials-map-container">
      <div className="trials-map-header">
        <span className="trials-map-title">🌍 Trial Geography</span>
        {data && (
          <span className="trials-map-stats">
            {data.total_countries} countries · {data.us_international?.total_trials?.toLocaleString() || "—"} trials
          </span>
        )}
        <button className="trials-map-collapse" onClick={() => setCollapsed(true)} title="Collapse">−</button>
      </div>

      {loading ? (
        <div className="trials-map-loading">Loading map…</div>
      ) : error ? (
        <div className="trials-map-error">⚠ {error}</div>
      ) : (
        <div className="trials-map-body">
          <ComposableMap
            projectionConfig={{ rotate: [-10, 0, 0], scale: 140 }}
            width={800}
            height={380}
            style={{ width: "100%", height: "auto", background: "#0d1117" }}
          >
            <ZoomableGroup>
              <Geographies geography={GEO_URL}>
                {({ geographies }) =>
                  geographies.map(geo => {
                    const name = geo.properties.name;
                    const count = countryMap[name] || 0;
                    return (
                      <MemoGeo
                        key={geo.rsmKey}
                        geo={geo}
                        fill={countryColor(count)}
                        stroke="#30363d"
                        onMouseEnter={() => setTooltip({ name, count })}
                        onMouseLeave={() => setTooltip(null)}
                        onClick={() => {
                          if (onCountryFilter) {
                            // Map topo name back to AACT name
                            const aactName = reverseMap[name] || name;
                            onCountryFilter(aactName);
                          }
                        }}
                      />
                    );
                  })
                }
              </Geographies>
            </ZoomableGroup>
          </ComposableMap>

          {tooltip && (
            <div className="trials-map-tooltip">
              <strong>{tooltip.name}</strong>: {tooltip.count ? tooltip.count.toLocaleString() + " trials" : "No data"}
            </div>
          )}

          {/* Legend */}
          <div className="trials-map-legend">
            {SCALE.slice(1).map((s, i) => (
              <div key={i} className="trials-map-legend-item">
                <div className="trials-map-legend-swatch" style={{ background: s.color }} />
                <span>{s.max === Infinity ? `${fmt(s.min)}+` : `${fmt(s.min)}–${fmt(s.max)}`}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
