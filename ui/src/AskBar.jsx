/**
 * AskBar — unified smart intake. Sends question to /api/ask, renders
 * response cards (briefing, kpi, bar_chart, leaderboard, kg_adjacency, etc.)
 * and auto-applies extracted filters to the parent TrialsPanel.
 */
import { useState, useCallback, useEffect } from "react";
import "./AskBar.css";

const EXAMPLE_QUESTIONS = [
  { key: "failure", text: "Why do Phase 3 oncology trials fail?", icon: "⚠" },
  { key: "sponsors", text: "Which sponsors lead in Alzheimer trials?", icon: "🏆" },
  { key: "enrollment", text: "How does enrollment ambition compare to actuals?", icon: "📊" },
  { key: "geo", text: "Where does Pfizer run most trials?", icon: "🌍" },
  { key: "kg", text: "What conditions are adjacent to Breast Cancer?", icon: "⬡" },
  { key: "gaps", text: "What therapeutic gaps does Novartis have?", icon: "🔍" },
];

function trialsApiBase() {
  return import.meta.env.VITE_TRIALS_API_BASE || "";
}

// ── Card renderers ────────────────────────────────────────────

function BriefingCard({ card }) {
  return (
    <div className="ask-card ask-card-briefing">
      <span className="ask-card-icon">💡</span>
      <p>{card.text}</p>
    </div>
  );
}

function KpiCard({ card }) {
  return (
    <div className={`ask-card ask-card-kpi ask-kpi-${card.color || "neutral"}`}>
      <div className="ask-kpi-value">{card.value}</div>
      <div className="ask-kpi-label">{card.label}</div>
    </div>
  );
}

function BarChartCard({ card }) {
  if (!card.data?.length) return null;
  // Determine value key — data may be { name, value } or { reason, count } or { condition, termination_rate_pct }
  const items = card.data.slice(0, 8).map(d => {
    const label = d.name || d.reason || d.condition || d.phase || d.region || d.country || d.allocation || Object.values(d)[0];
    const value = d.value ?? d.count ?? d.termination_rate_pct ?? d.trial_count ?? d.active_count ?? Object.values(d)[1] ?? 0;
    return { label: String(label), value: Number(value) || 0 };
  });
  const max = Math.max(...items.map(d => d.value), 1);
  return (
    <div className="ask-card ask-card-chart">
      <div className="ask-chart-title">{card.title}</div>
      {items.map((d, i) => (
        <div key={i} className="ask-bar-row">
          <span className="ask-bar-label">{d.label.length > 24 ? d.label.slice(0, 22) + "…" : d.label}</span>
          <div className="ask-bar-track">
            <div className="ask-bar-fill" style={{ width: `${Math.max((d.value / max) * 100, 3)}%` }} />
          </div>
          <span className="ask-bar-val">{typeof d.value === "number" && d.value % 1 !== 0 ? d.value.toFixed(1) : d.value.toLocaleString()}</span>
        </div>
      ))}
    </div>
  );
}

function LeaderboardCard({ card }) {
  if (!card.data?.length) return null;
  return (
    <div className="ask-card ask-card-chart">
      <div className="ask-chart-title">{card.title}</div>
      {card.data.slice(0, 10).map((d, i) => (
        <div key={i} className="ask-bar-row">
          <span className="ask-bar-rank">{i + 1}</span>
          <span className="ask-bar-label">{d.sponsor || d.name}</span>
          <span className="ask-bar-val">{d.completion_rate_pct ?? d.rate ?? "—"}%</span>
          <span className="ask-bar-sub">{d.total?.toLocaleString()} trials</span>
        </div>
      ))}
    </div>
  );
}

function KgCard({ card }) {
  if (!card.data?.length) return null;
  return (
    <div className="ask-card ask-card-kg">
      <div className="ask-chart-title">
        <span className="ask-kg-badge">🔵 Knowledge Graph</span>
        {card.title}
      </div>
      {card.data.slice(0, 10).map((d, i) => (
        <div key={i} className="ask-bar-row">
          <span className="ask-bar-label">{d.condition || d.gap_condition || d.sponsor || Object.values(d)[0]}</span>
          <span className="ask-bar-val">
            {d.shared_interventions?.toLocaleString() || d.trial_count?.toLocaleString() || d.trials?.toLocaleString() || d.competitor_count?.toLocaleString() || ""}
          </span>
        </div>
      ))}
    </div>
  );
}

function GeoCard({ card }) {
  if (!card.data) return null;
  const d = card.data;
  return (
    <div className="ask-card ask-card-geo">
      <div className="ask-geo-stats">
        {d.total_countries && <span>{d.total_countries} countries</span>}
        {d.us_international?.us_trials != null && <span>US: {d.us_international.us_trials.toLocaleString()}</span>}
        {d.us_international?.intl_trials != null && <span>Int'l: {d.us_international.intl_trials.toLocaleString()}</span>}
      </div>
    </div>
  );
}

function CountryTableCard({ card }) {
  if (!card.data?.length) return null;
  const max = card.data[0]?.trial_count || 1;
  return (
    <div className="ask-card ask-card-chart">
      <div className="ask-chart-title">Top Countries</div>
      {card.data.slice(0, 10).map((d, i) => (
        <div key={i} className="ask-bar-row">
          <span className="ask-bar-label">{d.country}</span>
          <div className="ask-bar-track">
            <div className="ask-bar-fill ask-bar-fill-geo" style={{ width: `${Math.max((d.trial_count / max) * 100, 3)}%` }} />
          </div>
          <span className="ask-bar-val">{d.trial_count.toLocaleString()}</span>
        </div>
      ))}
    </div>
  );
}

function SearchSuggestionCard({ card }) {
  return (
    <div className="ask-card ask-card-suggestion">
      <span>{card.text}</span>
    </div>
  );
}

function ErrorCard({ card }) {
  return (
    <div className="ask-card ask-card-error">
      <span>⚠ {card.text}</span>
    </div>
  );
}

function renderCard(card, i) {
  switch (card.type) {
    case "briefing": return <BriefingCard key={i} card={card} />;
    case "kpi": return <KpiCard key={i} card={card} />;
    case "bar_chart": return <BarChartCard key={i} card={card} />;
    case "leaderboard": return <LeaderboardCard key={i} card={card} />;
    case "kg_adjacency":
    case "kg_gaps":
    case "kg_network":
    case "kg_landscape": return <KgCard key={i} card={card} />;
    case "geo_summary": return <GeoCard key={i} card={card} />;
    case "country_table": return <CountryTableCard key={i} card={card} />;
    case "entity_insight": return <BarChartCard key={i} card={{ title: "Entity Insight", data: [] }} />;
    case "enrollment_summary": return null; // handled by bar charts
    case "search_suggestion": return <SearchSuggestionCard key={i} card={card} />;
    case "error": return <ErrorCard key={i} card={card} />;
    case "filters": return null; // consumed by parent
    case "trial_intelligence": return null; // too complex for inline, handled by parent
    default: return null;
  }
}

// ══════════════════════════════════════════════════════════════════
// Main AskBar component
// ══════════════════════════════════════════════════════════════════

export default function AskBar({ onFiltersExtracted, onOkpiView, onScrollToOkpi }) {
  const [question, setQuestion] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);

  const ask = useCallback(async (text) => {
    setLoading(true);
    setResult(null);
    try {
      const base = trialsApiBase();
      const url = base ? `${base}/api/ask` : `/api/analytics`;
      const body = { question: text };
      const r = await fetch(base ? url : `${url}?mode=ask`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await r.json();
      setResult(data);

      // Auto-apply extracted filters
      const filterCard = data.cards?.find(c => c.type === "filters");
      if (filterCard?.data && onFiltersExtracted) {
        onFiltersExtracted(filterCard.data);
      }

      // Auto-navigate to relevant OKPI tab
      const { intent } = data;
      if (intent === "failure_analysis" && onOkpiView) { onOkpiView("failure"); onScrollToOkpi?.(); }
      else if (intent === "sponsor_performance" && onOkpiView) { onOkpiView("sponsors"); onScrollToOkpi?.(); }
      else if (intent === "enrollment_benchmark" && onOkpiView) { onOkpiView("enrollment"); onScrollToOkpi?.(); }
      else if (intent === "geographic" && onOkpiView) { onOkpiView("geography"); onScrollToOkpi?.(); }
    } catch (e) {
      setResult({ cards: [{ type: "error", text: e.message }] });
    } finally {
      setLoading(false);
    }
  }, [onFiltersExtracted, onOkpiView, onScrollToOkpi]);

  const handleSubmit = useCallback((e) => {
    e.preventDefault();
    if (question.trim()) ask(question.trim());
  }, [question, ask]);

  const displayCards = result?.cards?.filter(c => c.type !== "filters") || [];
  const sourceLabel = result?.source === "kg" ? "Knowledge Graph" : result?.source === "hybrid" ? "Analytics + KG" : result?.source === "analytics" ? "Analytics" : null;

  return (
    <div className="ask-bar-container">
      <form className="ask-bar-form" onSubmit={handleSubmit}>
        <input
          className="ask-bar-input"
          type="text"
          value={question}
          onChange={e => setQuestion(e.target.value)}
          placeholder="Ask anything about clinical trials…"
        />
        <button type="submit" className="ask-bar-submit" disabled={loading || !question.trim()}>
          {loading ? "Thinking…" : "Ask →"}
        </button>
      </form>

      {/* Example chips */}
      {!result && !loading && (
        <div className="ask-bar-examples">
          {EXAMPLE_QUESTIONS.map(eq => (
            <button key={eq.key} className="ask-example-chip" onClick={() => { setQuestion(eq.text); ask(eq.text); }}>
              <span className="ask-example-icon">{eq.icon}</span>
              <span>{eq.text}</span>
            </button>
          ))}
        </div>
      )}

      {/* Loading state */}
      {loading && (
        <div className="ask-bar-loading">
          <div className="loading-spinner" />
          <span>Classifying intent and fetching data…</span>
        </div>
      )}

      {/* Results */}
      {result && !loading && displayCards.length > 0 && (
        <div className="ask-bar-results">
          {sourceLabel && (
            <div className="ask-source-badge">
              <span className={`ask-source-dot ask-source-${result.source}`} />
              {sourceLabel}
              {result.intent && <span className="ask-intent-label"> · {result.intent.replace(/_/g, " ")}</span>}
            </div>
          )}
          <div className="ask-cards-grid">
            {displayCards.map((card, i) => renderCard(card, i))}
          </div>
          <button className="ask-bar-clear" onClick={() => setResult(null)}>Dismiss</button>
        </div>
      )}
    </div>
  );
}
