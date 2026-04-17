import { useState, useMemo } from "react";
import "./SiteIntelligence.css";

const PALETTE = ["#58a6ff", "#3fb950", "#d29922", "#f85149", "#a371f7", "#39d2c0", "#f778ba", "#8b949e"];

function MiniBar({ data, title, maxItems = 8, palette = PALETTE }) {
  const items = data.slice(0, maxItems);
  if (!items.length) return null;
  const maxVal = Math.max(...items.map(([, c]) => c));
  return (
    <div className="si-chart">
      <div className="si-chart-title">{title}</div>
      {items.map(([label, count], i) => (
        <div key={label} className="si-bar-row">
          <span className="si-bar-label" title={label}>{label}</span>
          <div className="si-bar-track">
            <div className="si-bar-fill" style={{ width: `${(count / maxVal) * 100}%`, background: palette[i % palette.length] }} />
          </div>
          <span className="si-bar-count">{count.toLocaleString()}</span>
        </div>
      ))}
    </div>
  );
}

function trialsApiBase() {
  return import.meta.env.VITE_TRIALS_API_BASE || "";
}

export default function SiteIntelligence({ onSelectTrial }) {
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState(null);
  const [searching, setSearching] = useState(false);
  const [profile, setProfile] = useState(null);
  const [profileLoading, setProfileLoading] = useState(false);
  const [profileError, setProfileError] = useState(null);

  const searchSites = async () => {
    if (!query.trim() || searching) return;
    setSearching(true);
    setSearchResults(null);
    try {
      const base = trialsApiBase();
      const url = base ? `${base}/api/site-search?q=${encodeURIComponent(query)}` : `/api/site?mode=search&q=${encodeURIComponent(query)}`;
      const res = await fetch(url);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setSearchResults(data.sites || []);
    } catch (e) {
      setSearchResults({ error: e.message });
    } finally {
      setSearching(false);
    }
  };

  const loadProfile = async (site) => {
    setProfileLoading(true);
    setProfileError(null);
    setProfile(null);
    try {
      const base = trialsApiBase();
      const params = new URLSearchParams({ name: site.name });
      if (site.city) params.set("city", site.city);
      if (site.state) params.set("state", site.state);
      if (site.country) params.set("country", site.country);
      const url = base ? `${base}/api/site-profile?${params}` : `/api/site?mode=profile&${params}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
      const data = await res.json();
      setProfile(data);
    } catch (e) {
      setProfileError(e.message);
    } finally {
      setProfileLoading(false);
    }
  };

  const completionColor = useMemo(() => {
    if (!profile?.summary?.completion_rate_pct) return "#8b949e";
    const r = profile.summary.completion_rate_pct;
    return r >= 75 ? "#3fb950" : r >= 50 ? "#d29922" : "#f85149";
  }, [profile]);

  return (
    <div className="si-container">
      {/* Search */}
      <div className="si-search-section">
        <h3 className="si-section-title">Site Intelligence</h3>
        <p className="si-hint">Search for clinical trial sites by name. Explore their trial portfolio, performance metrics, and operational patterns.</p>
        <div className="si-search-row">
          <input
            className="si-search-input"
            placeholder="e.g. Duke University, Mayo Clinic, Memorial Sloan..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && searchSites()}
          />
          <button className="si-search-btn" onClick={searchSites} disabled={searching || !query.trim()}>
            {searching ? "…" : "Search"}
          </button>
        </div>

        {searchResults && (
          <div className="si-results-list">
            {searchResults.error ? (
              <p className="si-empty si-snapshot-msg">⏳ {searchResults.error}</p>
            ) : searchResults.length === 0 ? (
              <p className="si-empty">No sites found.</p>
            ) : (
              searchResults.map((s, i) => (
                <button key={i} className="si-result-row" onClick={() => loadProfile(s)}>
                  <div className="si-result-name">{s.name}</div>
                  <div className="si-result-meta">
                    {[s.city, s.state, s.country].filter(Boolean).join(", ")} · {s.trial_count.toLocaleString()} trials
                  </div>
                </button>
              ))
            )}
          </div>
        )}
      </div>

      {/* Profile */}
      {profileLoading && <div className="si-loading">Loading site profile…</div>}
      {profileError && <div className="si-error">⚠ {profileError}</div>}

      {profile && (
        <div className="si-profile">
          <div className="si-profile-header">
            <h2 className="si-site-name">{profile.site.name}</h2>
            <p className="si-site-location">
              {[profile.site.city, profile.site.state, profile.site.country].filter(Boolean).join(", ")}
            </p>
          </div>

          {/* KPI Cards */}
          <div className="si-kpis">
            <div className="si-kpi">
              <div className="si-kpi-value">{profile.summary.total_trials.toLocaleString()}</div>
              <div className="si-kpi-label">Total Trials</div>
            </div>
            <div className="si-kpi">
              <div className="si-kpi-value" style={{ color: completionColor }}>
                {profile.summary.completion_rate_pct !== null ? `${profile.summary.completion_rate_pct}%` : "—"}
              </div>
              <div className="si-kpi-label">Completion Rate</div>
            </div>
            <div className="si-kpi">
              <div className="si-kpi-value">{profile.summary.avg_duration_months ?? "—"}</div>
              <div className="si-kpi-label">Avg Duration (mo)</div>
            </div>
            <div className="si-kpi">
              <div className="si-kpi-value">{profile.summary.results_reported ?? "—"}</div>
              <div className="si-kpi-label">Results Reported</div>
            </div>
            {profile.summary.avg_months_to_report && (
              <div className="si-kpi">
                <div className="si-kpi-value">{profile.summary.avg_months_to_report}</div>
                <div className="si-kpi-label">Avg Mo to Report</div>
              </div>
            )}
            {profile.summary.total_sae_subjects > 0 && (
              <div className="si-kpi">
                <div className="si-kpi-value">{profile.summary.total_sae_subjects.toLocaleString()}</div>
                <div className="si-kpi-label">SAE Subjects</div>
              </div>
            )}
          </div>

          {/* Charts grid */}
          <div className="si-charts-grid">
            <MiniBar data={Object.entries(profile.phases)} title="Phase Distribution" maxItems={8} />
            <MiniBar data={Object.entries(profile.statuses)} title="Status Distribution" maxItems={8} />
            <MiniBar data={profile.conditions} title="Top Conditions" maxItems={8} />
            <MiniBar data={profile.interventions} title="Top Interventions" maxItems={8} />
            <MiniBar data={profile.sponsors} title="Top Sponsors" maxItems={8} />
            {profile.dropouts?.length > 0 && (
              <MiniBar data={profile.dropouts} title="Dropout Reasons" maxItems={8} />
            )}
            <MiniBar data={Object.entries(profile.durations)} title="Trial Duration Distribution" maxItems={6} />
            {profile.countries?.length > 0 && (
              <MiniBar data={profile.countries} title="Trial Countries" maxItems={8} />
            )}
          </div>

          {/* Recent trials */}
          {profile.recent_trials?.length > 0 && (
            <div className="si-recent">
              <div className="si-chart-title">Recent Trials</div>
              <div className="si-recent-list">
                {profile.recent_trials.map((t) => (
                  <button
                    key={t.nct_id}
                    className="si-trial-row"
                    onClick={() => onSelectTrial?.(t.nct_id)}
                  >
                    <span className="si-trial-id">{t.nct_id}</span>
                    <span className="si-trial-title">{t.brief_title}</span>
                    <span className={`si-trial-status si-status-${(t.overall_status || "").toLowerCase()}`}>
                      {t.overall_status}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
