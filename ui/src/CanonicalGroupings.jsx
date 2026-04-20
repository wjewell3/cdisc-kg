import { useState, useEffect, useCallback } from "react";

/**
 * CanonicalGroupings — review & edit the server-side canonical-groupings catalog.
 *
 * - Loads from GET /api/dq?action=canonical
 * - Saves to POST /api/dq?action=canonical
 * - Regenerates via POST /api/dq?action=canonical-rebuild
 *
 * Catalog shape: { _meta, <field>: [{ canonical, rawValues, note }, ...], ... }
 */
export default function CanonicalGroupings() {
  const [catalog, setCatalog] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [rebuilding, setRebuilding] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [draft, setDraft] = useState(null); // working copy

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const r = await fetch("/api/dq?action=canonical");
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setCatalog(j); setDraft(JSON.parse(JSON.stringify(j)));
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const dirty = catalog && draft && JSON.stringify(catalog) !== JSON.stringify(draft);

  const save = async () => {
    if (!draft) return;
    setSaving(true); setError(null); setNotice(null);
    try {
      const r = await fetch("/api/dq?action=canonical", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setCatalog(j.catalog || draft); setDraft(JSON.parse(JSON.stringify(j.catalog || draft)));
      setNotice("Saved.");
      setTimeout(() => setNotice(null), 2500);
    } catch (e) { setError(e.message); }
    finally { setSaving(false); }
  };

  const rebuild = async (fields) => {
    if (rebuilding) return;
    if (!confirm(`Regenerate canonical groupings for ${fields.join(", ")} using GPT-4.1? This will overwrite the current groups for these fields.`)) return;
    setRebuilding(true); setError(null); setNotice(null);
    try {
      const r = await fetch("/api/dq?action=canonical-rebuild", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fields }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setCatalog(j.catalog); setDraft(JSON.parse(JSON.stringify(j.catalog)));
      const summary = Object.entries(j.report || {}).map(([f, v]) => v.error ? `${f}: ${v.error}` : `${f}: ${v.groups} groups from ${v.raw_values_clustered} values`).join(" · ");
      setNotice(`AI rebuild complete — ${summary}`);
    } catch (e) { setError(e.message); }
    finally { setRebuilding(false); }
  };

  const updateGroup = (field, idx, patch) => {
    setDraft(d => {
      const next = { ...d };
      next[field] = next[field].map((g, i) => i === idx ? { ...g, ...patch } : g);
      return next;
    });
  };

  const deleteGroup = (field, idx) => {
    setDraft(d => {
      const next = { ...d };
      next[field] = next[field].filter((_, i) => i !== idx);
      return next;
    });
  };

  const addGroup = (field) => {
    setDraft(d => {
      const next = { ...d };
      next[field] = [...(next[field] || []), { canonical: "New group", rawValues: [], note: "" }];
      return next;
    });
  };

  const addField = (field) => {
    if (!field) return;
    setDraft(d => {
      const next = { ...d };
      if (!next[field]) next[field] = [];
      return next;
    });
  };

  if (loading) return <div className="cg-loading">Loading catalog…</div>;
  if (error && !catalog) return <div className="cg-error">⚠ {error} <button onClick={load}>Retry</button></div>;
  if (!draft) return null;

  const fields = Object.keys(draft).filter(k => !k.startsWith("_"));

  return (
    <div className="cg-root">
      <div className="cg-intro">
        <p className="cg-lede">
          GPT-4.1 clusters raw categorical values into canonical groups. These are applied server-side to every endpoint that returns category arrays — so charts, stop-reason breakdowns, and withdrawal reasons all collapse synonyms consistently.
        </p>
        <div className="cg-top-actions">
          <button
            className="cg-rebuild-btn"
            onClick={() => rebuild(["phase", "stop_reason", "withdrawal_reason"])}
            disabled={rebuilding}
            title="Query distinct values from SQLite, send to GPT-4.1, replace groups"
          >
            {rebuilding ? "🧠 Clustering with GPT-4.1…" : "🧠 Regenerate all with AI"}
          </button>
          <button
            className={`cg-save-btn${dirty ? " cg-save-dirty" : ""}`}
            onClick={save}
            disabled={!dirty || saving}
          >
            {saving ? "Saving…" : dirty ? "💾 Save changes" : "✓ Saved"}
          </button>
        </div>
        {notice && <div className="cg-notice">{notice}</div>}
        {error && <div className="cg-error-inline">⚠ {error}</div>}
        {draft._meta?.updated && (
          <div className="cg-meta">
            Last updated: {new Date(draft._meta.updated).toLocaleString()} · source: {draft._meta.source || "seed"}
          </div>
        )}
      </div>

      {fields.map(field => (
        <div key={field} className="cg-field-section">
          <div className="cg-field-header">
            <h4>{field.replace(/_/g, " ")}</h4>
            <span className="cg-field-count">{(draft[field] || []).length} groups</span>
            <button className="cg-field-rebuild" onClick={() => rebuild([field])} disabled={rebuilding} title="Regenerate this field only">
              🧠 Rebuild
            </button>
            <button className="cg-field-add" onClick={() => addGroup(field)}>+ Group</button>
          </div>
          {(draft[field] || []).length === 0 && (
            <p className="cg-empty">No groups. Click <em>Rebuild</em> to cluster with AI, or add manually.</p>
          )}
          {(draft[field] || []).map((g, idx) => (
            <GroupEditor
              key={idx}
              group={g}
              onChange={patch => updateGroup(field, idx, patch)}
              onDelete={() => deleteGroup(field, idx)}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

function GroupEditor({ group, onChange, onDelete }) {
  const [editing, setEditing] = useState(false);
  const [draftRaw, setDraftRaw] = useState((group.rawValues || []).join("\n"));
  const [draftCanonical, setDraftCanonical] = useState(group.canonical);
  const [draftNote, setDraftNote] = useState(group.note || "");

  useEffect(() => {
    if (!editing) {
      setDraftRaw((group.rawValues || []).join("\n"));
      setDraftCanonical(group.canonical);
      setDraftNote(group.note || "");
    }
  }, [group, editing]);

  const save = () => {
    onChange({
      canonical: draftCanonical.trim() || group.canonical,
      rawValues: draftRaw.split("\n").map(s => s.trim()).filter(Boolean),
      note: draftNote.trim(),
    });
    setEditing(false);
  };

  if (editing) {
    return (
      <div className="cg-group cg-group-editing">
        <input className="cg-canonical-input" value={draftCanonical} onChange={e => setDraftCanonical(e.target.value)} placeholder="Canonical label" />
        <textarea className="cg-raw-textarea" value={draftRaw} onChange={e => setDraftRaw(e.target.value)} rows={Math.min(10, (group.rawValues || []).length + 2)} placeholder="Raw values (one per line)" />
        <input className="cg-note-input" value={draftNote} onChange={e => setDraftNote(e.target.value)} placeholder="Note (optional)" />
        <div className="cg-group-actions">
          <button className="cg-save-group" onClick={save}>✓ Save</button>
          <button className="cg-cancel-group" onClick={() => setEditing(false)}>Cancel</button>
        </div>
      </div>
    );
  }

  return (
    <div className="cg-group">
      <div className="cg-group-header">
        <span className="cg-canonical">{group.canonical}</span>
        <span className="cg-group-count">{(group.rawValues || []).length} raw</span>
        <div className="cg-group-actions">
          <button className="cg-edit-group" onClick={() => setEditing(true)} title="Edit">✎</button>
          <button className="cg-delete-group" onClick={onDelete} title="Delete">×</button>
        </div>
      </div>
      <div className="cg-raw-values">
        {(group.rawValues || []).map((rv, i) => (
          <span key={i} className="cg-raw-chip">{rv || <em>(blank)</em>}</span>
        ))}
      </div>
      {group.note && <div className="cg-note">{group.note}</div>}
    </div>
  );
}
