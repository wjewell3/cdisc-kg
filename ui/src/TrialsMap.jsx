/**
 * TrialsMap — Choropleth world map showing trial density by country.
 * Click a country to drill in: zooms to that country, shows city-level site bubbles,
 * and filters the rest of the dashboard. Click "← World" to zoom back out.
 */
import { useState, useEffect, useCallback, useMemo, memo } from "react";
import { ComposableMap, Geographies, Geography, ZoomableGroup, Marker } from "react-simple-maps";
import { geoCentroid } from "d3-geo";
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

// Reverse: topo name → AACT name
const REVERSE_NAME_MAP = {};
for (const [aact, topo] of Object.entries(NAME_MAP)) REVERSE_NAME_MAP[topo] = aact;

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

// Bubble radius scaled by trial count (for city markers)
function bubbleRadius(count, maxCount) {
  if (!count || !maxCount) return 3;
  return 3 + 12 * Math.sqrt(count / maxCount);
}

const MemoGeo = memo(function MemoGeo({ geo, fill, stroke, strokeWidth, onMouseEnter, onMouseLeave, onClick, style }) {
  return (
    <Geography
      geography={geo}
      fill={fill}
      stroke={stroke}
      strokeWidth={strokeWidth || 0.4}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onClick={onClick}
      style={style || {
        default: { outline: "none" },
        hover: { outline: "none", fill: "#58a6ff", cursor: "pointer" },
        pressed: { outline: "none" },
      }}
    />
  );
});

export default function TrialsMap({ filterParams = {}, onCountryFilter, onCountryClear }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [tooltip, setTooltip] = useState(null);
  const [collapsed, setCollapsed] = useState(true);

  // Drill-in state
  const [drilledCountry, setDrilledCountry] = useState(null); // { name, aactName, center, zoom }
  const [geoFeatures, setGeoFeatures] = useState(null); // cached geo features for centroid calc

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
      if (NAME_MAP[c.country]) m[NAME_MAP[c.country]] = c.trial_count;
    }
    return m;
  }, [data]);

  // City data for drill-in view
  const cityData = data?.by_city || [];
  const maxCityCount = cityData.length ? Math.max(...cityData.map(c => c.trial_count)) : 0;

  // Handle country click — drill in
  const handleCountryClick = useCallback((geo) => {
    const topoName = geo.properties.name;
    const aactName = REVERSE_NAME_MAP[topoName] || topoName;
    const center = geoCentroid(geo);

    // Choose zoom level based on country size
    let zoom = 4;
    const largeCountries = ["United States of America", "Russia", "China", "Canada", "Brazil", "Australia"];
    const mediumCountries = ["India", "Argentina", "Mexico", "Indonesia", "Saudi Arabia"];
    if (largeCountries.includes(topoName)) zoom = 3;
    else if (mediumCountries.includes(topoName)) zoom = 3.5;

    setDrilledCountry({ name: topoName, aactName, center, zoom });
    setTooltip(null);

    if (onCountryFilter) onCountryFilter(aactName);
  }, [onCountryFilter]);

  // Zoom out to world view
  const zoomOut = useCallback(() => {
    setDrilledCountry(null);
    setTooltip(null);
    if (onCountryClear) onCountryClear();
  }, [onCountryClear]);

  if (collapsed) {
    return (
      <div className="trials-map-collapsed" onClick={() => setCollapsed(false)}>
        <span className="trials-map-toggle">🌍 Show Geography Map</span>
      </div>
    );
  }

  const isDrilled = !!drilledCountry;

  return (
    <div className="trials-map-container">
      <div className="trials-map-header">
        {isDrilled ? (
          <>
            <button className="trials-map-back" onClick={zoomOut} title="Back to world view">← World</button>
            <span className="trials-map-title">{drilledCountry.aactName}</span>
          </>
        ) : (
          <span className="trials-map-title">🌍 Trial Geography</span>
        )}
        {data && (
          <span className="trials-map-stats">
            {isDrilled && cityData.length ? `${cityData.length} cities · ` : ""}
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
            projectionConfig={{
              rotate: isDrilled ? [-drilledCountry.center[0], 0, 0] : [-10, 0, 0],
              center: isDrilled ? [0, drilledCountry.center[1]] : [0, 0],
              scale: isDrilled ? 140 * drilledCountry.zoom : 140,
            }}
            width={800}
            height={isDrilled ? 320 : 260}
            style={{ width: "100%", height: "auto", background: "#0d1117" }}
          >
            <Geographies geography={GEO_URL}>
              {({ geographies }) =>
                geographies.map(geo => {
                  const name = geo.properties.name;
                  const count = countryMap[name] || 0;
                  const isTarget = isDrilled && name === drilledCountry.name;
                  return (
                    <MemoGeo
                      key={geo.rsmKey}
                      geo={geo}
                      fill={isTarget ? "#58a6ff" : isDrilled ? (count ? "#21262d" : "#161b22") : countryColor(count)}
                      stroke={isTarget ? "#79c0ff" : "#30363d"}
                      strokeWidth={isTarget ? 1.2 : 0.4}
                      onMouseEnter={() => setTooltip({ name, count })}
                      onMouseLeave={() => setTooltip(null)}
                      onClick={() => {
                        if (isDrilled && !isTarget) {
                          // Click a different country while drilled — switch drill
                          handleCountryClick(geo);
                        } else if (!isDrilled) {
                          handleCountryClick(geo);
                        }
                      }}
                      style={isTarget ? {
                        default: { outline: "none" },
                        hover: { outline: "none", fill: "#58a6ff", cursor: "default" },
                        pressed: { outline: "none" },
                      } : {
                        default: { outline: "none" },
                        hover: { outline: "none", fill: "#58a6ff", cursor: "pointer" },
                        pressed: { outline: "none" },
                      }}
                    />
                  );
                })
              }
            </Geographies>

            {/* City bubbles when drilled in */}
            {isDrilled && cityData.map((city, i) => {
              if (!city.lat || !city.lng) return null;
              const r = bubbleRadius(city.trial_count, maxCityCount);
              return (
                <Marker key={`${city.city}-${city.state}-${i}`} coordinates={[Number(city.lng), Number(city.lat)]}>
                  <circle
                    r={r}
                    fill="#39d353"
                    fillOpacity={0.7}
                    stroke="#26a641"
                    strokeWidth={0.5}
                    onMouseEnter={() => setTooltip({ name: `${city.city}${city.state ? `, ${city.state}` : ""}`, count: city.trial_count })}
                    onMouseLeave={() => setTooltip(null)}
                    style={{ cursor: "default" }}
                  />
                </Marker>
              );
            })}
          </ComposableMap>

          {tooltip && (
            <div className="trials-map-tooltip">
              <strong>{tooltip.name}</strong>: {tooltip.count ? tooltip.count.toLocaleString() + " trials" : "No data"}
            </div>
          )}

          {/* Legend — show city legend when drilled, country legend otherwise */}
          {isDrilled && cityData.length > 0 ? (
            <div className="trials-map-legend">
              <div className="trials-map-legend-item">
                <div className="trials-map-legend-swatch" style={{ background: "#39d353", borderRadius: "50%", width: 8, height: 8 }} />
                <span>City bubble = trial count</span>
              </div>
              <div className="trials-map-legend-item">
                <span style={{ color: "#8b949e" }}>
                  Top city: {cityData[0]?.city} ({cityData[0]?.trial_count?.toLocaleString()})
                </span>
              </div>
            </div>
          ) : (
            <div className="trials-map-legend">
              {SCALE.slice(1).map((s, i) => (
                <div key={i} className="trials-map-legend-item">
                  <div className="trials-map-legend-swatch" style={{ background: s.color }} />
                  <span>{s.max === Infinity ? `${fmt(s.min)}+` : `${fmt(s.min)}–${fmt(s.max)}`}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
