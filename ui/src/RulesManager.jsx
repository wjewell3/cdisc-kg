import { useState } from "react";
import "./RulesManager.css";

const FIELDS = ["intervention", "condition", "sponsor", "status", "phase"];

export default function RulesManager({
  rules,
  addGrouping,
  removeGrouping,
  setEnrollmentBounds,
  enrollMin,
  enrollMax,
  exportRules,
  importRules,
  onClose,
}) {
  // AI parse
  const [aiText, setAiText] = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  const [aiResult, setAiResult] = useState(null);
  const [aiError, setAiError] = useState(null);

  // Manual add form
  const [addField, setAddField] = useState("intervention");
  const [addCanonical, setAddCanonical] = useState("");
  const [addRawValues, setAddRawValues] = useState("");
  const [addNote, setAddNote] = useState("");

  const parseWithAI = async () => {
    if (!aiText.trim() || aiLoading) return;
    setAiLoading(true); setAiResult(null); setAiError(null);
    try {
      const res = await fetch("/api/dq", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: aiText }),
      });
      const data = await res.json();
      if (!res.ok) {
        const isExpired = (data.detail || "").includes("403") || (data.error || "").includes("403");
        throw new Error(isExpired
          ? "GitHub Copilot token expired — refresh it with: kubectl delete secret aact-credentials -n cdisc-kg && kubectl create secret generic aact-credentials -n cdisc-kg --from-literal=GITHUB_COPILOT_TOKEN=<new-token> ... then vercel env rm GITHUB_COPILOT_TOKEN && vercel env add GITHUB_COPILOT_TOKEN production"
          : data.error || `HTTP ${res.status}`);
      }
      setAiResult(data);
    } catch (e) {
      setAiError(e.message);
    } finally {
      setAiLoading(false);
    }
  };

  const confirmAiResult = () => {
    if (!aiResult) return;
    if (aiResult.ruleType === "grouping") {
      addGrouping({
        field: aiResult.field,
        canonical: aiResult.canonical,
        rawValues: aiResult.rawValues,
        note: `AI — ${aiText}`,
      });
    } else if (aiResult.ruleType === "bounds") {
      setEnrollmentBounds(aiResult.min ?? null, aiResult.max ?? null);
    }
    setAiText(""); setAiResult(null);
  };

  const handleManualAdd = () => {
    const rawValues = addRawValues.split("\n").map((v) => v.trim()).filter(Boolean);
    if (!addCanonical.trim() || rawValues.length === 0) return;
    addGrouping({ field: addField, canonical: addCanonical.trim(), rawValues, note: addNote.trim() });
    setAddCanonical(""); setAddRawValues(""); setAddNote("");
  };

  const groupingsByField = FIELDS.reduce((acc, f) => {
    acc[f] = (rules.groupings || []).filter((g) => g.field === f);
    return acc;
  }, {});
  const totalGroupings = (rules.groupings || []).length;
  const totalActive = totalGroupings + (enrollMin !== null || enrollMax !== null ? 1 : 0);

  return (
    <div className="rm-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="rm-drawer slide-in">
        <div className="rm-header">
          <h2>⚙ Data Quality Rules</h2>
          <span className="rm-header-sub">{totalActive} rule{totalActive !== 1 ? "s" : ""} active</span>
          <button className="rm-close" onClick={onClose}>×</button>
        </div>

        <div className="rm-body">

          {/* ── Ask AI ── */}
          <div className="rm-section">
            <h3>Ask AI to create a rule</h3>
            <p className="rm-hint">
              e.g. <em>"group Protocol, protocol, and No Intervention as No Intervention in intervention"</em><br />
              or <em>"limit enrollment between 10 and 500000"</em>
            </p>
            <div className="rm-ai-row">
              <input
                className="rm-input rm-ai-input"
                placeholder="Describe the rule in plain English…"
                value={aiText}
                onChange={(e) => setAiText(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && parseWithAI()}
              />
              <button className="rm-ai-btn" onClick={parseWithAI} disabled={aiLoading || !aiText.trim()}>
                {aiLoading ? "…" : "Parse"}
              </button>
            </div>
            {aiError && <div className="rm-ai-error">⚠ {aiError}</div>}
            {aiResult && (
              <div className="rm-ai-result">
                <div className="rm-ai-preview">
                  {aiResult.ruleType === "grouping" ? (
                    <>
                      <span className="rm-preview-label">Field:</span> {aiResult.field} ·{" "}
                      <span className="rm-preview-label">Canonical:</span> "{aiResult.canonical}" ·{" "}
                      <span className="rm-preview-label">Groups:</span> {(aiResult.rawValues || []).join(", ")}
                    </>
                  ) : (
                    <>
                      <span className="rm-preview-label">Enrollment bounds:</span>{" "}
                      min = {aiResult.min ?? "none"}, max = {aiResult.max ?? "none"}
                    </>
                  )}
                </div>
                <div className="rm-ai-actions">
                  <button className="rm-confirm-btn" onClick={confirmAiResult}>✓ Apply</button>
                  <button className="rm-discard-btn" onClick={() => setAiResult(null)}>✗ Discard</button>
                </div>
              </div>
            )}
          </div>

          {/* ── Add manually ── */}
          <div className="rm-section">
            <h3>Add grouping manually</h3>
            <div className="rm-manual-grid">
              <select className="rm-select" value={addField} onChange={(e) => setAddField(e.target.value)}>
                {FIELDS.map((f) => <option key={f} value={f}>{f}</option>)}
              </select>
              <input
                className="rm-input"
                placeholder="Canonical label (e.g. No Intervention)"
                value={addCanonical}
                onChange={(e) => setAddCanonical(e.target.value)}
              />
            </div>
            <textarea
              className="rm-textarea"
              placeholder={"Raw values to collapse (one per line):\nProtocol\nprotocol\nNo Intervention"}
              value={addRawValues}
              onChange={(e) => setAddRawValues(e.target.value)}
              rows={4}
            />
            <input
              className="rm-input"
              placeholder="Note (optional)"
              value={addNote}
              onChange={(e) => setAddNote(e.target.value)}
              style={{ marginTop: 6 }}
            />
            <button
              className="rm-add-btn"
              onClick={handleManualAdd}
              disabled={!addCanonical.trim() || !addRawValues.trim()}
            >
              + Add Rule
            </button>
          </div>

          {/* ── Enrollment Bounds ── */}
          <div className="rm-section">
            <h3>Enrollment Bounds</h3>
            <p className="rm-hint">
              Filters the <em>comparables</em> pool used by Trial Intelligence and restricts chart display.
              Useful to exclude placeholder registries (e.g. 99,999,999) or tiny pilots.
            </p>
            <div className="rm-bounds-row">
              <label className="rm-bounds-label">
                Min enrollment
                <input
                  type="number"
                  className="rm-bounds-input"
                  placeholder="e.g. 10"
                  value={enrollMin ?? ""}
                  onChange={(e) => setEnrollmentBounds(
                    e.target.value ? parseInt(e.target.value, 10) : null,
                    enrollMax
                  )}
                />
              </label>
              <label className="rm-bounds-label">
                Max enrollment
                <input
                  type="number"
                  className="rm-bounds-input"
                  placeholder="e.g. 100000"
                  value={enrollMax ?? ""}
                  onChange={(e) => setEnrollmentBounds(
                    enrollMin,
                    e.target.value ? parseInt(e.target.value, 10) : null
                  )}
                />
              </label>
            </div>
            {(enrollMin !== null || enrollMax !== null) && (
              <button className="rm-clear-bounds-btn" onClick={() => setEnrollmentBounds(null, null)}>
                Clear bounds
              </button>
            )}
          </div>

          {/* ── Active rules ── */}
          <div className="rm-section">
            <h3>Active Rules</h3>
            {(enrollMin !== null || enrollMax !== null) && (
              <div className="rm-rule-row rm-bounds-active">
                <div className="rm-rule-info">
                  <span className="rm-rule-canonical">Enrollment bounds</span>
                  <span className="rm-rule-raw">
                    {enrollMin !== null ? `min ${enrollMin.toLocaleString()}` : ""}
                    {enrollMin !== null && enrollMax !== null ? " · " : ""}
                    {enrollMax !== null ? `max ${enrollMax.toLocaleString()}` : ""}
                  </span>
                </div>
                <button className="rm-remove-btn" onClick={() => setEnrollmentBounds(null, null)} title="Clear bounds">×</button>
              </div>
            )}
            {totalGroupings === 0 && enrollMin === null && enrollMax === null ? (
              <p className="rm-empty">No rules yet — add one above.</p>
            ) : totalGroupings === 0 ? null : (
              FIELDS.map((f) => groupingsByField[f].length > 0 && (
                <div key={f} className="rm-field-group">
                  <div className="rm-field-label">{f}</div>
                  {groupingsByField[f].map((g) => (
                    <div key={g.id} className="rm-rule-row">
                      <div className="rm-rule-info">
                        <span className="rm-rule-canonical">"{g.canonical}"</span>
                        <span className="rm-rule-raw">← {(g.rawValues || []).join(" · ")}</span>
                        {g.note && <span className="rm-rule-note">{g.note}</span>}
                      </div>
                      <button className="rm-remove-btn" onClick={() => removeGrouping(g.id)} title="Remove">×</button>
                    </div>
                  ))}
                </div>
              ))
            )}
          </div>

          {/* ── Export / Import ── */}
          <div className="rm-section rm-section-last">
            <h3>Export / Import</h3>
            <div className="rm-export-row">
              <button
                className="rm-export-btn"
                onClick={() => {
                  const blob = new Blob([exportRules()], { type: "application/json" });
                  const a = document.createElement("a");
                  a.href = URL.createObjectURL(blob);
                  a.download = "dq-rules.json";
                  a.click();
                }}
              >
                ⬇ Export JSON
              </button>
              <label className="rm-import-label">
                ⬆ Import JSON
                <input
                  type="file"
                  accept=".json"
                  style={{ display: "none" }}
                  onChange={(e) => {
                    const file = e.target.files[0];
                    if (!file) return;
                    const reader = new FileReader();
                    reader.onload = (ev) => importRules(ev.target.result);
                    reader.readAsText(file);
                    e.target.value = "";
                  }}
                />
              </label>
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}
