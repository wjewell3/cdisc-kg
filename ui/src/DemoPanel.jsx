import { useState, useCallback } from "react";
import {
  resolveQuery,
  executeQuery,
  buildLineage,
  DEMO_QUERIES,
} from "./demoEngine";
import InsightCharts from "./InsightCharts";
import "./DemoPanel.css";

const STEPS = ["question", "resolution", "results"];
const STEP_LABELS = { question: "Ask", resolution: "KG Resolution", results: "Results" };

export default function DemoPanel() {
  const [query, setQuery] = useState("");
  const [step, setStep] = useState("question"); // question | resolution | results
  const [resolutions, setResolutions] = useState([]);
  const [primaryDomain, setPrimaryDomain] = useState("AE");
  const [queryResult, setQueryResult] = useState(null);
  const [selectedRow, setSelectedRow] = useState(null);
  const [lineage, setLineage] = useState(null);
  const [animatingStep, setAnimatingStep] = useState(null);
  const [activeFilters, setActiveFilters] = useState([]); // [{ field, value }, ...]
  // Pre-load full dataset so charts are visible before any NL query
  const [baseResult] = useState(() => executeQuery([], "AE"));

  const runQuery = useCallback((text) => {
    setQuery(text);
    setSelectedRow(null);
    setLineage(null);

    // Step 1: Resolve
    const resolved = resolveQuery(text);
    setResolutions(resolved.resolutions);
    setPrimaryDomain(resolved.primaryDomain);
    setAnimatingStep("resolution");
    setStep("resolution");

    // Step 2: Execute after brief pause for visual effect
    setTimeout(() => {
      const result = executeQuery(resolved.resolutions, resolved.primaryDomain);
      setQueryResult(result);
      setAnimatingStep("results");
      setStep("results");
      setTimeout(() => setAnimatingStep(null), 400);
    }, 800);
  }, []);

  const handlePreset = useCallback((q) => { runQuery(q.text); }, [runQuery]);

  const handleSubmit = useCallback((e) => {
    e.preventDefault();
    if (query.trim()) runQuery(query);
  }, [query, runQuery]);

  const showLineage = useCallback((row) => {
    setSelectedRow(row);
    setLineage(buildLineage(row, resolutions));
  }, [resolutions]);

  const reset = useCallback(() => {
    setStep("question");
    setQuery("");
    setResolutions([]);
    setQueryResult(null);
    setSelectedRow(null);
    setLineage(null);
    setAnimatingStep(null);
    setActiveFilters([]);
  }, []);

  // Derive filtered rows: AND across fields, OR within same field
  const filteredRows = useCallback((rows) => {
    if (activeFilters.length === 0) return rows;
    const byField = {};
    for (const { field, value } of activeFilters) {
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
        if (field === "_SEX_LABEL") return values.has((row._dm?.SEX || row.SEX) === "F" ? "Female" : (row._dm?.SEX || row.SEX) === "M" ? "Male" : (row._dm?.SEX || row.SEX));
        if (field === "_SITE") return values.has(row._dm?.SITE || row.SITE);
        return true;
      })
    );
  }, [activeFilters]);

  const removeResolution = useCallback((idx) => {
    const next = resolutions.filter((_, i) => i !== idx);
    setResolutions(next);
    if (next.length === 0) {
      setQueryResult(null);
      setStep("question");
    } else {
      const result = executeQuery(next, primaryDomain);
      setQueryResult(result);
    }
  }, [resolutions, primaryDomain]);

  const handleChartFilter = useCallback((field, value) => {
    setSelectedRow(null);
    setLineage(null);
    if (field === null || value === null) {
      setActiveFilters([]);
    } else {
      setActiveFilters((prev) => {
        const exists = prev.some((f) => f.field === field && f.value === value);
        return exists
          ? prev.filter((f) => !(f.field === field && f.value === value))
          : [...prev, { field, value }];
      });
    }
  }, []);

  return (
    <div className="demo-panel">
      {/* Header bar */}
      <div className="demo-header">
        <div className="demo-header-left">
          <div className="demo-logo">🔬</div>
          <div>
            <h1 className="demo-title">SDTM Pipeline Demo</h1>
            <p className="demo-subtitle">End-to-end clinical data pipeline — raw data → KG resolution → SDTM output</p>
          </div>
        </div>
        <div className="demo-badge-row">
          <span className="demo-badge-sdtm">SDTM IG v3.4</span>
          <span className="demo-badge-kg">KG Semantic Layer</span>
        </div>
      </div>

      {/* Pipeline progress bar */}
      <div className="demo-pipeline">
        {STEPS.map((s, i) => (
          <div key={s} className={`pipeline-step ${step === s ? "active" : ""} ${STEPS.indexOf(step) > i ? "done" : ""} ${animatingStep === s ? "animating" : ""}`}>
            <div className="pipeline-dot">{STEPS.indexOf(step) > i ? "✓" : i + 1}</div>
            <span className="pipeline-label">{STEP_LABELS[s]}</span>
            {i < STEPS.length - 1 && <div className="pipeline-line" />}
          </div>
        ))}
      </div>

      <div className="demo-content">
        {/* Question section — always visible */}
        <div className={`demo-section question-section ${step !== "question" ? "compact" : ""}`}>
          <div className="section-header">
            <div className="section-icon">💬</div>
            <h2>Ask a Clinical Question</h2>
            {step !== "question" && (
              <button className="reset-btn" onClick={reset}>New Query</button>
            )}
          </div>

          {step === "question" ? (
            <>
              <p className="section-desc">
                Ask a plain-English question about the CDISCPILOT01 trial data.
                The Knowledge Graph resolves your intent into precise SDTM filters.
              </p>
              <form onSubmit={handleSubmit} className="query-form">
                <input
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="e.g., Show me all patients with severe drug-related adverse events"
                  className="query-input"
                />
                <button type="submit" className="query-submit" disabled={!query.trim()}>
                  Ask →
                </button>
              </form>
              <div className="preset-queries">
                <h3>Try these demo queries:</h3>
                <div className="preset-grid">
                  {DEMO_QUERIES.map((q) => (
                    <button
                      key={q.id}
                      className="preset-card"
                      onClick={() => handlePreset(q)}
                    >
                      <span className="preset-text">"{q.text}"</span>
                      <span className="preset-desc">{q.description}</span>
                      <div className="preset-tags">
                        {q.tags.map((t) => (
                          <span key={t} className="preset-tag">{t}</span>
                        ))}
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            </>
          ) : (
            <div className="compact-query">
              <span className="compact-q">"{query}"</span>
            </div>
          )}
        </div>

        {/* KG resolution + chart-filter pill bar */}
        {((step === "resolution" || step === "results") && resolutions.length > 0) || activeFilters.length > 0 ? (
          <div className="demo-kg-bar slide-in">
            {resolutions.length > 0 && <span className="demo-kg-bar-label">🔗 KG →</span>}
            {resolutions.map((r, i) => (
              <span key={i} className="demo-kg-pill" title={r.kgPath}>
                <span className="demo-kg-pill-domain">{r.domain}</span>
                <code>{r.variable}</code>
                <span className="demo-kg-pill-eq">=</span>
                {r.values.map((v, j) => (
                  <span key={j} className="demo-kg-pill-val">{v}</span>
                ))}
                <button className="demo-kg-pill-remove" onClick={() => removeResolution(i)} aria-label="Remove filter">×</button>
              </span>
            ))}
            {activeFilters.length > 0 && resolutions.length === 0 && <span className="demo-kg-bar-label">🔍 Chart filters →</span>}
            {activeFilters.map((f, i) => (
              <span key={i} className="demo-kg-pill demo-kg-pill-filter">
                {f.field.replace(/^_/, "").replace(/_LABEL$/, "")} = {f.value}
                <button className="demo-kg-pill-remove" onClick={() => setActiveFilters((prev) => prev.filter((_, j) => j !== i))}>×</button>
              </span>
            ))}
          </div>
        ) : null}

        {/* Charts + table — visible from the start; hidden once results step shows them in-context */}
        {step !== "results" && (() => {
          const displayResult = queryResult || baseResult;
          const rows = filteredRows(displayResult.results);
          return (
            <div className={`demo-section charts-section ${step === "question" ? "browse-mode" : ""} ${animatingStep === "results" ? "slide-in" : ""}`}>
              {step === "question" && (
                <div className="section-header">
                  <div className="section-icon">📊</div>
                  <h2>Browse & Filter</h2>
                  <span className="result-count">{displayResult.totalMatches} rows · click a chart to filter</span>
                </div>
              )}
              <InsightCharts
                results={displayResult.results}
                primaryDomain={displayResult.primaryDomain}
                activeFilters={activeFilters}
                onFilter={handleChartFilter}
              />
              <div className="results-table-section">
                <div className="results-table-header">
                  <span className="filter-hint">
                    {activeFilters.length > 0
                      ? `Showing ${rows.length} of ${displayResult.totalMatches} rows (filtered)`
                      : `${Math.min(50, displayResult.totalMatches)} of ${displayResult.totalMatches} rows`}
                  </span>
                </div>
                <div className="results-table-wrap">
                  <table className="results-table">
                    <thead>
                      <tr>
                        <th>Subject</th>
                        <th>Site</th>
                        <th>Arm</th>
                        <th>AE Term</th>
                        <th>Severity</th>
                        <th>Serious</th>
                        <th>Relationship</th>
                        <th>Outcome</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.slice(0, 50).map((row, i) => (
                        <tr key={i} className="result-row" onClick={() => showLineage(row)}>
                          <td className="subj-id">{row.USUBJID}</td>
                          <td>{row._dm?.SITE || row.SITE || ""}</td>
                          <td>
                            <span className={`arm-badge arm-${(row._dm?.ARMCD || row.ARMCD || "").toLowerCase()}`}>
                              {row._dm?.ARM || row.ARM || ""}
                            </span>
                          </td>
                          <td className="ae-term">{row.AEDECOD}</td>
                          <td><span className={`sev-badge sev-${(row.AESEV || "").toLowerCase()}`}>{row.AESEV}</span></td>
                          <td>{row.AESER === "Y" ? "Yes" : "No"}</td>
                          <td className="rel-cell">{row.AEREL}</td>
                          <td>{row.AEOUT}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {rows.length > 50 && <div className="results-truncated">Showing 50 of {rows.length} results</div>}
                </div>
              </div>
            </div>
          );
        })()}

        {/* Results section */}
        {step === "results" && queryResult && (
          <div className={`demo-section results-section ${animatingStep === "results" ? "slide-in" : ""}`}>
            <div className="section-header">
              <div className="section-icon">📊</div>
              <h2>Query Results</h2>
              <span className="result-count">
                {queryResult.totalMatches} row{queryResult.totalMatches !== 1 ? "s" : ""} from {queryResult.primaryDomain} domain
              </span>
            </div>

            {queryResult.totalMatches === 0 ? (
              <div className="no-results">No matching records found. Try a different query.</div>
            ) : (
              <div className="results-layout">
                {/* Insight charts — interactive */}
                <InsightCharts
                  results={queryResult.results}
                  primaryDomain={queryResult.primaryDomain}
                  activeFilters={activeFilters}
                  onFilter={handleChartFilter}
                />

                {/* Results table — filtered by chart click */}
                <div className="results-table-section">
                  <div className="results-table-header">
                    <span className="filter-hint">
                      {activeFilters.length > 0
                        ? `Showing ${filteredRows(queryResult.results).length} of ${queryResult.totalMatches} rows (filtered)`
                        : `${Math.min(50, queryResult.totalMatches)} of ${queryResult.totalMatches} rows${queryResult.totalMatches > 50 ? " · click a chart to filter" : ""}`
                      }
                    </span>
                  </div>
                  <div className={`results-table-wrap ${selectedRow ? "with-lineage" : ""}`}>
                    <table className="results-table">
                      <thead>
                        <tr>
                          <th>Subject</th>
                          <th>Site</th>
                          <th>Arm</th>
                          {queryResult.primaryDomain === "AE" && (
                            <>
                              <th>AE Term</th>
                              <th>Severity</th>
                              <th>Serious</th>
                              <th>Relationship</th>
                              <th>Outcome</th>
                            </>
                          )}
                        </tr>
                      </thead>
                      <tbody>
                        {filteredRows(queryResult.results).slice(0, 50).map((row, i) => (
                          <tr
                            key={i}
                            className={`result-row ${selectedRow === row ? "selected" : ""}`}
                            onClick={() => showLineage(row)}
                          >
                            <td className="subj-id">{row.USUBJID}</td>
                            <td>{row._dm?.SITE || row.SITE || ""}</td>
                            <td>
                              <span className={`arm-badge arm-${(row._dm?.ARMCD || row.ARMCD || "").toLowerCase()}`}>
                                {row._dm?.ARM || row.ARM || ""}
                              </span>
                            </td>
                            {queryResult.primaryDomain === "AE" && (
                              <>
                                <td className="ae-term">{row.AEDECOD}</td>
                                <td>
                                  <span className={`sev-badge sev-${(row.AESEV || "").toLowerCase()}`}>
                                    {row.AESEV}
                                  </span>
                                </td>
                                <td>{row.AESER === "Y" ? "Yes" : "No"}</td>
                                <td className="rel-cell">{row.AEREL}</td>
                                <td>{row.AEOUT}</td>
                              </>
                            )}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {filteredRows(queryResult.results).length > 50 && (
                      <div className="results-truncated">
                        Showing 50 of {filteredRows(queryResult.results).length} results
                      </div>
                    )}
                  </div>
                </div>

                {/* Lineage panel */}
                {selectedRow && lineage && (
                  <div className="lineage-panel">
                    <div className="lineage-header">
                      <h3>Data Lineage</h3>
                      <button className="close-lineage" onClick={() => { setSelectedRow(null); setLineage(null); }}>×</button>
                    </div>
                    <p className="lineage-desc">
                      Click any result row to trace where each data point came from.
                    </p>
                    <div className="lineage-chain">
                      {lineage.map((item, i) => (
                        <div key={i} className={`lineage-item ${item.isMatch ? "match" : ""}`}>
                          <div className="lineage-layer">
                            <span className="lineage-layer-name">{item.layer}</span>
                            <span className="lineage-source">{item.source}</span>
                          </div>
                          <div className="lineage-field">
                            <code>{item.field}</code>
                            <span className="lineage-value">{item.value}</span>
                          </div>
                          <div className="lineage-explanation">{item.description}</div>
                          {i < lineage.length - 1 && <div className="lineage-connector">↓</div>}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Footer attribution */}
      <div className="demo-footer">
        <span>Data: CDISCPILOT01 (RhoInc open-source) · Semantic Layer: CDISC Knowledge Graph · SDTM IG v3.4</span>
      </div>
    </div>
  );
}
