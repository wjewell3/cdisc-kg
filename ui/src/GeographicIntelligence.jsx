/**
 * GeographicIntelligence.jsx — Where are the geographic concentrations & gaps?
 *
 * Standalone tab answering Q4: site activation geography.
 * Uses /api/geographic-intelligence (or /api/analytics?mode=geographic via Vercel).
 */
import { useState, useEffect, useCallback, useMemo } from "react";
import "./GeographicIntelligence.css";

const PALETTE = ["#58a6ff","#3fb950","#d29922","#f85149","#a371f7","#39d2c0","#f778ba","#8b949e","#79c0ff","#56d364"];

function trialsApiBase() {
  return import.meta.env.VITE_TRIALS_API_BASE || "";
}

function RegionBar({ regions }) {
  if (!regions?.length) return null;
  const max = Math.max(...regions.map(r => r.trial_count), 1);
  return (
    <div className="geo-region-chart">
      <div className="geo-chart-title">Trial Distribution by Region</div>
      {regions.map((r, i) => (
        <div key={r.region} className="geo-bar-row">
          <span className="geo-bar-label">{r.region}</span>
          <div className="geo-bar-track">
            <div className="geo-bar-fill" style={{ width: `${Math.max((r.trial_count / max) * 100, 3)}%`, background: PALETTE[i % PALETTE.length] }} />
          </div>
          <span className="geo-bar-count">{r.trial_count.toLocaleString()}</span>
          <span className="geo-bar-active">({r.active_count?.toLocaleString() || 0} active)</span>
        </div>
      ))}
    </div>
  );
}

function CountryTable({ countries }) {
  const [showAll, setShowAll] = useState(false);
  const display = showAll ? countries : countries.slice(0, 20);
  if (!countries?.length) return null;
  return (
    <div className="geo-country-table">
      <div className="geo-chart-title">Trial Counts by Country ({countries.length} total)</div>
      <table>
        <thead>
          <tr><th>#</th><th>Country</th><th>Trials</th><th>Share</th></tr>
        </thead>
        <tbody>
          {display.map((c, i) => {
            const total = countries.reduce((s, x) => s + x.trial_count, 0);
            return (
              <tr key={c.country}>
                <td className="geo-rank">{i + 1}</td>
                <td>{c.country}</td>
                <td>{c.trial_count.toLocaleString()}</td>
                <td className="geo-pct">{total ? ((c.trial_count / total) * 100).toFixed(1) + "%" : "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {countries.length > 20 && (
        <button className="geo-show-more" onClick={() => setShowAll(!showAll)}>
          {showAll ? "Show top 20" : `Show all ${countries.length} countries`}
        </button>
      )}
    </div>
  );
}

function TopSites({ sites }) {
  if (!sites?.length) return null;
  return (
    <div className="geo-sites-panel">
      <div className="geo-chart-title">Top Sites by Trial Volume</div>
      <div className="geo-sites-list">
        {sites.map((s, i) => (
          <div key={i} className="geo-site-card">
            <div className="geo-site-rank">#{i + 1}</div>
            <div className="geo-site-info">
              <div className="geo-site-name">{s.site_name}</div>
              <div className="geo-site-loc">
                {[s.city, s.state, s.country].filter(Boolean).join(", ")}
              </div>
            </div>
            <div className="geo-site-count">{s.trial_count.toLocaleString()} trials</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function USIntlSplit({ data }) {
  if (!data) return null;
  const usTrials = data.us_trials || 0;
  const intlTrials = data.intl_trials || 0;
  const total = data.total_trials || (usTrials + intlTrials) || 1;
  const usPct = ((usTrials / total) * 100).toFixed(1);
  const intlPct = ((intlTrials / total) * 100).toFixed(1);
  return (
    <div className="geo-us-intl">
      <div className="geo-chart-title">US vs International</div>
      <div className="geo-split-bar">
        <div className="geo-split-us" style={{ width: `${usPct}%` }}>
          <span>US {usPct}%</span>
        </div>
        <div className="geo-split-intl" style={{ width: `${intlPct}%` }}>
          <span>Int'l {intlPct}%</span>
        </div>
      </div>
      <div className="geo-split-counts">
        <span>🇺🇸 {usTrials.toLocaleString()} trials</span>
        <span>🌍 {intlTrials.toLocaleString()} trials</span>
      </div>
    </div>
  );
}

export default function GeographicIntelligence({ filterParams = {} }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

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

  return (
    <div className="geo-panel geo-panel-embedded">
      {loading ? (
        <div className="geo-loading">
          <div className="geo-spinner" />
          <p>Analyzing geographic distribution…</p>
        </div>
      ) : error ? (
        <div className="geo-error">⚠ {error}</div>
      ) : data ? (
        <div className="geo-body">
          {/* KPI cards */}
          <div className="geo-kpis">
            <div className="geo-kpi">
              <div className="geo-kpi-value">{data.total_countries}</div>
              <div className="geo-kpi-label">Countries</div>
            </div>
            <div className="geo-kpi">
              <div className="geo-kpi-value">{data.us_international?.total_trials?.toLocaleString() || "—"}</div>
              <div className="geo-kpi-label">Total Trials</div>
            </div>
            <div className="geo-kpi">
              <div className="geo-kpi-value">{data.by_region?.length || 0}</div>
              <div className="geo-kpi-label">Regions</div>
            </div>
            <div className="geo-kpi">
              <div className="geo-kpi-value">{data.top_sites?.length || 0}</div>
              <div className="geo-kpi-label">Top Sites</div>
            </div>
          </div>

          <USIntlSplit data={data.us_international} />

          <div className="geo-grid">
            <RegionBar regions={data.by_region} />
            <CountryTable countries={data.by_country} />
          </div>

          <TopSites sites={data.top_sites} />
        </div>
      ) : null}
    </div>
  );
}
