import { useState, useRef } from "react";
import { streamLLMQuery } from "./api";
import "./QueryPanel.css";

const NODE_COLORS = {
  Standard: "#e74c3c",
  Class: "#e67e22",
  Domain: "#3498db",
  Variable: "#2ecc71",
  Codelist: "#9b59b6",
};

const SUGGESTIONS = [
  "What variables are required in the AE domain?",
  "What codelist does AESEV use?",
  "How are DM and AE related?",
  "What domains are in the Findings class?",
  "What is USUBJID?",
  "Show all SDTM domains",
  "What is the CDISC data flow?",
];

function ResultView({ result }) {
  if (!result) return null;

  const { type, answer, data, context } = result;

  return (
    <div className="nl-result">
      <p className="nl-answer">{answer}</p>
      {context && <p className="nl-context">{context}</p>}

      {type === "variable_list" && data && (
        <table className="nl-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Label</th>
              <th>Type</th>
              <th>Core</th>
            </tr>
          </thead>
          <tbody>
            {data.map((v) => (
              <tr key={v.name}>
                <td>
                  <code>{v.name}</code>
                </td>
                <td>{v.label}</td>
                <td>{v.type}</td>
                <td className={`core-${v.core?.toLowerCase()}`}>{v.core}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {type === "codelist_detail" && data && (
        <div className="nl-codelist">
          <p className="nl-cl-name">{data.codelist}</p>
          <div className="nl-values">
            {data.values.map((v) => (
              <span key={v} className="nl-value-chip">
                {v}
              </span>
            ))}
          </div>
        </div>
      )}

      {type === "domain_list" && data && (
        <table className="nl-table">
          <thead>
            <tr>
              <th>Code</th>
              <th>Name</th>
            </tr>
          </thead>
          <tbody>
            {data.map((d) => (
              <tr key={d.code}>
                <td>
                  <code>{d.code}</code>
                </td>
                <td>{d.name}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {type === "variable_detail" && data && (
        <div className="nl-var-detail">
          {data.map((v) => (
            <div key={v.name + v.domain} className="nl-var-row">
              <div className="nl-var-header">
                <code>{v.name}</code>
                <span className="nl-domain-tag">{v.domain}</span>
                <span className={`core-${v.core?.toLowerCase()}`}>{v.core}</span>
              </div>
              <p>{v.description}</p>
            </div>
          ))}
        </div>
      )}

      {type === "relationship" && data && (
        <ul className="nl-rel-list">
          {data.map((r, i) => (
            <li key={i}>
              <strong>{r.relationship}</strong>
              {r.via_variable && <span> via <code>{r.via_variable}</code></span>}
              {r.description && <p>{r.description}</p>}
            </li>
          ))}
        </ul>
      )}

      {type === "shared_variables" && data && (
        <div className="nl-values">
          {data.map((v) => (
            <span key={v} className="nl-value-chip">
              <code>{v}</code>
            </span>
          ))}
        </div>
      )}

      {type === "stats" && data && (
        <div className="nl-stats">
          <div className="nl-stats-grid">
            {Object.entries(data.node_types).map(([k, v]) => (
              <div key={k} className="nl-stat-item">
                <span
                  className="nl-stat-dot"
                  style={{ background: NODE_COLORS[k] || "#555" }}
                />
                <span>{k}</span>
                <strong>{v}</strong>
              </div>
            ))}
          </div>
        </div>
      )}

      {type === "flow" && data && (
        <div className="nl-flow">
          {data.map((f, i) => (
            <div key={i} className="nl-flow-item">
              <span className="nl-flow-from">{f.from}</span>
              <span className="nl-flow-arrow">→</span>
              <span className="nl-flow-to">{f.to}</span>
              <p className="nl-flow-desc">{f.description}</p>
            </div>
          ))}
        </div>
      )}

      {type === "no_results" && result.suggestions && (
        <div className="nl-suggestions">
          <p className="nl-sugg-label">Try asking:</p>
          {result.suggestions.map((s) => (
            <button key={s} className="nl-sugg-btn">
              {s}
            </button>
          ))}
        </div>
      )}

      {type === "search_results" && data && (
        <ul className="nl-search-list">
          {data.map((r) => (
            <li key={r.id}>
              <span
                className="type-badge"
                style={{ background: NODE_COLORS[r.type] || "#555" }}
              >
                {r.type}
              </span>
              <strong>{r.name}</strong>
              {r.label && <span className="nl-rl">{r.label}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function QueryPanel({ onFocusNode, onBack }) {
  const [input, setInput] = useState("");
  const [llmText, setLlmText] = useState("");
  const [structuredResult, setStructuredResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [history, setHistory] = useState([]);
  const abortRef = useRef(null);

  const handleQuery = async (question) => {
    const q = (question || input).trim();
    if (!q) return;
    setInput(q);
    setLlmText("");
    setStructuredResult(null);
    setLoading(true);
    setHistory((prev) => [{ q, ts: Date.now() }, ...prev.filter(h => h.q !== q).slice(0, 8)]);

    let tokenBuffer = "";
    await streamLLMQuery(q, {
      onChunk: (token) => {
        tokenBuffer += token;
        setLlmText(tokenBuffer);
      },
      onStructured: (data) => setStructuredResult(data),
      onDone: () => setLoading(false),
      onError: (err) => {
        setLlmText((t) => t + `\n\n*(Error: ${err})*`);
        setLoading(false);
      },
    });
  };

  const handleSuggestionClick = (s) => handleQuery(s);

  return (
    <div className="query-panel">
      <div className="query-header">
        {onBack && (
          <button className="query-back-btn" onClick={onBack}>← Back</button>
        )}
        <h2>Ask the Knowledge Graph</h2>
        <span className="query-subtitle">Natural language CDICS/SDTM queries</span>
      </div>

      <div className="query-input-area">
        <textarea
          className="query-input"
          placeholder="What variables are required in the AE domain?"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleQuery();
            }
          }}
          rows={2}
        />
        <button
          className="query-btn"
          onClick={() => handleQuery()}
          disabled={loading}
        >
          {loading ? "..." : "Ask"}
        </button>
      </div>

      {/* Suggestions */}
      {!structuredResult && !llmText && (
        <div className="suggestions">
          <p className="sugg-label">Try these:</p>
          <div className="sugg-list">
            {SUGGESTIONS.map((s) => (
              <button
                key={s}
                className="sugg-chip"
                onClick={() => handleSuggestionClick(s)}
              >
                {s}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* LLM streaming answer */}
      {(llmText || loading) && (
        <div className="nl-llm-block">
          <span className="nl-llm-label">
            <span className="nl-llm-icon">✦</span> GPT-4.1
            {loading && <span className="nl-cursor">▌</span>}
          </span>
          <p className="nl-llm-text">{llmText}</p>
        </div>
      )}

      {/* Structured result — only shown as fallback if LLM didn't respond */}
      {structuredResult && !llmText && <ResultView result={structuredResult} onFocusNode={onFocusNode} />}

      {/* History */}
      {history.length > 1 && (
        <div className="query-history">
          <p className="hist-label">Recent:</p>
          {history.slice(1).map((h) => (
            <button
              key={h.ts}
              className="hist-item"
              onClick={() => handleSuggestionClick(h.q)}
            >
              {h.q}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
