/**
 * GraphPanel — dedicated Knowledge Graph Explorer tab.
 * Full Cytoscape viz + NL→Cypher console + preset graph queries +
 * KG-native explorations (adjacency, gaps, sponsor network).
 */
import { useState, useCallback } from "react";
import GraphViz from "./GraphViz";
import { KGContextPanel } from "./GraphIntelligence";
import { executeGraphQuery, TRIAL_QUERIES } from "./trialsEngine";
import RulesManager from "./RulesManager";
import { useDataQuality } from "./useDataQuality";
import "./GraphIntelligence.css";
import "./GraphPanel.css";

const GRAPH_PRESETS = TRIAL_QUERIES.filter(q => q.isGraph);

export default function GraphPanel() {
  const [question, setQuestion] = useState("");
  const [graphResult, setGraphResult] = useState(null);
  const [graphQueryId, setGraphQueryId] = useState(null);
  const [displayQueryId, setDisplayQueryId] = useState(null);
  const [inputFocused, setInputFocused] = useState(false);
  const [rulesOpen, setRulesOpen] = useState(false);
  const { rules, addGrouping, removeGrouping, updateGrouping, setEnrollmentBounds, exportRules, importRules, enrollMin, enrollMax } = useDataQuality();

  const runGraphQuery = useCallback(async (text) => {
    setQuestion(text);
    const preset = GRAPH_PRESETS.find(q => q.text === text);
    const presetId = preset?.id ?? null;
    setGraphQueryId(presetId);
    setGraphResult({ loading: true, error: null, cypher: null, columns: [], rows: [], narrative: null });
    try {
      const data = await executeGraphQuery(text);
      setGraphResult({ loading: false, error: null, ...data });
      setDisplayQueryId((data.rows?.length ?? 0) > 0 ? presetId : null);
    } catch (err) {
      setGraphResult({ loading: false, error: err.message, cypher: null, columns: [], rows: [], narrative: null });
      setDisplayQueryId(null);
    }
  }, []);

  const handleSubmit = useCallback((e) => {
    e.preventDefault();
    if (question.trim()) runGraphQuery(question);
  }, [question, runGraphQuery]);

  return (
    <div className="graph-panel-page">
      <div className="graph-panel-header">
        <div className="graph-panel-title-row">
          <span className="graph-panel-icon">⬡</span>
          <div>
            <h1 className="graph-panel-title">Knowledge Graph Explorer</h1>
            <p className="graph-panel-subtitle">
              580k trials · 512k interventions · 129k conditions · 50k sponsors · 225 countries — connected as a graph
            </p>
          </div>
          <div className="graph-panel-header-actions">
            <button className="rules-manager-btn" onClick={() => setRulesOpen(true)}>
              ⚙ Rules{(rules.groupings.length + (enrollMin !== null || enrollMax !== null ? 1 : 0)) > 0 ? ` (${rules.groupings.length + (enrollMin !== null || enrollMax !== null ? 1 : 0)})` : ""}
              {(enrollMin !== null || enrollMax !== null) && <span className="rules-bounds-badge">●</span>}
            </button>
          </div>
        </div>
      </div>

      {/* KG visualisation */}
      <div className="graph-panel-viz">
        <GraphViz
          queryId={displayQueryId}
        />
      </div>

      {/* NL → Cypher query bar */}
      <div className="graph-panel-query-section">
        <form className="graph-panel-form" onSubmit={handleSubmit}>
          <span className="graph-panel-form-icon">⬡</span>
          <input
            className="graph-panel-input"
            type="text"
            value={question}
            onChange={e => setQuestion(e.target.value)}
            onFocus={() => setInputFocused(true)}
            onBlur={() => setTimeout(() => setInputFocused(false), 150)}
            placeholder='Ask the Knowledge Graph — e.g., "What conditions are adjacent to Breast Cancer?"'
          />
          <button type="submit" className="graph-panel-submit" disabled={!question.trim()}>
            Query Graph →
          </button>
        </form>

        {/* Preset graph queries — card dropdown on focus */}
        {inputFocused && (
          <div className="graph-panel-preset-dropdown">
            {GRAPH_PRESETS.map(q => (
              <button
                key={q.id}
                className={`graph-panel-preset-card ${graphQueryId === q.id ? "active" : ""}`}
                onMouseDown={(e) => { e.preventDefault(); runGraphQuery(q.text); }}
              >
                <span className="graph-panel-preset-text">{q.text}</span>
                <span className="graph-panel-preset-desc">{q.description}</span>
                <div className="graph-panel-preset-tags">
                  {q.tags.map(t => (
                    <span key={t} className={`graph-panel-preset-tag ${t === "Graph" ? "graph-panel-preset-tag-graph" : ""}`}>{t}</span>
                  ))}
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Results panel */}
      {graphResult && (
        <div className="graph-panel-results">
          {graphResult.loading ? (
            <div className="graph-panel-loading">
              <div className="loading-spinner" />
              <p>Querying knowledge graph…</p>
            </div>
          ) : graphResult.error ? (
            <div className="graph-panel-error">
              ⚠ {graphResult.error.includes("quota") || graphResult.error.includes("expired") || graphResult.error.includes("forbidden")
                ? "GitHub Copilot API token expired — preset questions still work."
                : graphResult.error}
            </div>
          ) : (
            <>
              {graphResult.narrative && (
                <div className="graph-narrative">
                  <span className="graph-narrative-icon">💡</span>
                  <p>{graphResult.narrative}</p>
                </div>
              )}
              {graphResult.cypher && (
                <details className="graph-cypher-details">
                  <summary className="graph-cypher-summary">Cypher query</summary>
                  <pre className="graph-cypher-code">{graphResult.cypher}</pre>
                </details>
              )}
              {graphResult.rows?.length > 0 ? (
                <div className="graph-table-wrap">
                  <table className="graph-result-table">
                    <thead>
                      <tr>
                        {graphResult.columns.map(col => <th key={col}>{col}</th>)}
                      </tr>
                    </thead>
                    <tbody>
                      {graphResult.rows.map((row, i) => (
                        <tr key={i}>
                          {graphResult.columns.map(col => (
                            <td key={col}>
                              {Array.isArray(row[col])
                                ? row[col].join(", ")
                                : typeof row[col] === "number"
                                  ? row[col].toLocaleString()
                                  : String(row[col] ?? "")}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="graph-empty">No results returned for this query.</div>
              )}
            </>
          )}
        </div>
      )}

      {/* KG-native tools */}
      <div className="graph-panel-tools">
        <KGContextPanel conditions={[]} sponsors={[]} />
      </div>

      {rulesOpen && (
        <RulesManager
          rules={rules}
          addGrouping={addGrouping}
          removeGrouping={removeGrouping}
          updateGrouping={updateGrouping}
          setEnrollmentBounds={setEnrollmentBounds}
          enrollMin={enrollMin}
          enrollMax={enrollMax}
          exportRules={exportRules}
          importRules={importRules}
          onClose={() => setRulesOpen(false)}
        />
      )}
    </div>
  );
}
