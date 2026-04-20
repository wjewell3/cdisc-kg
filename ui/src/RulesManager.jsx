import { useState } from "react";
import "./RulesManager.css";
import CanonicalGroupings from "./CanonicalGroupings";
import "./CanonicalGroupings.css";

const FIELDS = ["intervention", "condition", "sponsor", "status", "phase"];

export default function RulesManager({
  rules,
  addGrouping,
  removeGrouping,
  updateGrouping,
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

  // Inline edit state — id of rule being edited, plus draft values
  const [editId, setEditId] = useState(null);
  const [editField, setEditField] = useState("");
  const [editCanonical, setEditCanonical] = useState("");
  const [editRawValues, setEditRawValues] = useState("");
  const [editNote, setEditNote] = useState("");

  const startEdit = (g) => {
    setEditId(g.id);
    setEditField(g.field);
    setEditCanonical(g.canonical);
    setEditRawValues((g.rawValues || []).join("\n"));
    setEditNote(g.note || "");
  };

  const cancelEdit = () => setEditId(null);

  // Inline edit state for enrollment bounds
  const [editBounds, setEditBounds] = useState(false);
  const [editMin, setEditMin] = useState("");
  const [editMax, setEditMax] = useState("");

  const startEditBounds = () => {
    setEditMin(enrollMin !== null ? String(enrollMin) : "");
    setEditMax(enrollMax !== null ? String(enrollMax) : "");
    setEditBounds(true);
  };

  const saveEditBounds = () => {
    setEnrollmentBounds(
      editMin !== "" ? parseInt(editMin, 10) : null,
      editMax !== "" ? parseInt(editMax, 10) : null,
    );
    setEditBounds(false);
  };

  const saveEdit = () => {
    const rawValues = editRawValues.split("\n").map((v) => v.trim()).filter(Boolean);
    if (!editCanonical.trim() || rawValues.length === 0) return;
    updateGrouping(editId, { field: editField, canonical: editCanonical.trim(), rawValues, note: editNote.trim() });
    setEditId(null);
  };

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

  const [tab, setTab] = useState("canonical");

  return (
    <div className="rm-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="rm-drawer slide-in">
        <div className="rm-header">
          <h2>⚙ Data Quality Rules</h2>
          <span className="rm-header-sub">{totalActive} custom rule{totalActive !== 1 ? "s" : ""} active</span>
          <button className="rm-close" onClick={onClose}>×</button>
        </div>

        <div className="rm-tab-bar">
          <button className={`rm-tab${tab === "canonical" ? " rm-tab-active" : ""}`} onClick={() => setTab("canonical")}>
            🧠 Canonical Groupings (AI)
          </button>
          <button className={`rm-tab${tab === "custom" ? " rm-tab-active" : ""}`} onClick={() => setTab("custom")}>
            ⚙ Custom Rules
          </button>
        </div>

        <div className="rm-body">
        {tab === "canonical" && <CanonicalGroupings />}
        {tab === "custom" && (<>

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
                {editBounds ? (
                  <div className="rm-edit-form">
                    <div className="rm-bounds-row">
                      <label className="rm-bounds-label">
                        Min
                        <input type="number" className="rm-bounds-input" placeholder="e.g. 10" value={editMin} onChange={(e) => setEditMin(e.target.value)} />
                      </label>
                      <label className="rm-bounds-label">
                        Max
                        <input type="number" className="rm-bounds-input" placeholder="e.g. 500000" value={editMax} onChange={(e) => setEditMax(e.target.value)} />
                      </label>
                    </div>
                    <div className="rm-edit-actions">
                      <button className="rm-confirm-btn" onClick={saveEditBounds}>✓ Save</button>
                      <button className="rm-discard-btn" onClick={() => setEditBounds(false)}>✗ Cancel</button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="rm-rule-info">
                      <span className="rm-rule-canonical">Enrollment bounds</span>
                      <span className="rm-rule-raw">
                        {enrollMin !== null ? `min ${enrollMin.toLocaleString()}` : ""}
                        {enrollMin !== null && enrollMax !== null ? " · " : ""}
                        {enrollMax !== null ? `max ${enrollMax.toLocaleString()}` : ""}
                      </span>
                    </div>
                    <div className="rm-rule-actions">
                      <button className="rm-edit-btn" onClick={startEditBounds} title="Edit">✎</button>
                      <button className="rm-remove-btn" onClick={() => setEnrollmentBounds(null, null)} title="Clear bounds">×</button>
                    </div>
                  </>
                )}
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
                      {editId === g.id ? (
                        <div className="rm-edit-form">
                          <div className="rm-manual-grid">
                            <select className="rm-select" value={editField} onChange={(e) => setEditField(e.target.value)}>
                              {FIELDS.map((f2) => <option key={f2} value={f2}>{f2}</option>)}
                            </select>
                            <input
                              className="rm-input"
                              placeholder="Canonical label"
                              value={editCanonical}
                              onChange={(e) => setEditCanonical(e.target.value)}
                            />
                          </div>
                          <textarea
                            className="rm-textarea"
                            placeholder="Raw values (one per line)"
                            value={editRawValues}
                            onChange={(e) => setEditRawValues(e.target.value)}
                            rows={3}
                          />
                          <input
                            className="rm-input"
                            placeholder="Note (optional)"
                            value={editNote}
                            onChange={(e) => setEditNote(e.target.value)}
                            style={{ marginTop: 6 }}
                          />
                          <div className="rm-edit-actions">
                            <button className="rm-confirm-btn" onClick={saveEdit} disabled={!editCanonical.trim() || !editRawValues.trim()}>✓ Save</button>
                            <button className="rm-discard-btn" onClick={cancelEdit}>✗ Cancel</button>
                          </div>
                        </div>
                      ) : (
                        <>
                          <div className="rm-rule-info">
                            <span className="rm-rule-canonical">"{g.canonical}"</span>
                            <span className="rm-rule-raw">← {(g.rawValues || []).join(" · ")}</span>
                            {g.note && <span className="rm-rule-note">{g.note}</span>}
                          </div>
                          <div className="rm-rule-actions">
                            <button className="rm-edit-btn" onClick={() => startEdit(g)} title="Edit">✎</button>
                            <button className="rm-remove-btn" onClick={() => removeGrouping(g.id)} title="Remove">×</button>
                          </div>
                        </>
                      )}
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

        </>)}
        </div>
      </div>
    </div>
  );
}
