import { useState, useCallback } from "react";
import "./ProfileBuilder.css";

const PHASES = [
  { value: "", label: "Any" },
  { value: "EARLY_PHASE1", label: "Early Phase 1" },
  { value: "PHASE1", label: "Phase 1" },
  { value: "PHASE1/PHASE2", label: "Phase 1/2" },
  { value: "PHASE2", label: "Phase 2" },
  { value: "PHASE2/PHASE3", label: "Phase 2/3" },
  { value: "PHASE3", label: "Phase 3" },
  { value: "PHASE4", label: "Phase 4" },
];

const ALLOCATIONS = [
  { value: "", label: "Any" },
  { value: "Randomized", label: "Randomized" },
  { value: "Non-Randomized", label: "Non-Randomized" },
  { value: "N/A", label: "N/A (single-arm)" },
];

const MASKINGS = [
  { value: "", label: "Any" },
  { value: "None", label: "Open Label" },
  { value: "Single", label: "Single Blind" },
  { value: "Double", label: "Double Blind" },
  { value: "Triple", label: "Triple Blind" },
  { value: "Quadruple", label: "Quadruple Blind" },
];

const INTERVENTION_MODELS = [
  { value: "", label: "Any" },
  { value: "Parallel Assignment", label: "Parallel" },
  { value: "Single Group Assignment", label: "Single Group" },
  { value: "Crossover Assignment", label: "Crossover" },
  { value: "Factorial Assignment", label: "Factorial" },
  { value: "Sequential Assignment", label: "Sequential" },
];

const PRIMARY_PURPOSES = [
  { value: "", label: "Any" },
  { value: "Treatment", label: "Treatment" },
  { value: "Prevention", label: "Prevention" },
  { value: "Diagnostic", label: "Diagnostic" },
  { value: "Supportive Care", label: "Supportive Care" },
  { value: "Screening", label: "Screening" },
  { value: "Health Services Research", label: "Health Services Research" },
  { value: "Basic Science", label: "Basic Science" },
  { value: "Device Feasibility", label: "Device Feasibility" },
];

const INTERVENTION_TYPES = [
  { value: "", label: "Any" },
  { value: "Drug", label: "Drug" },
  { value: "Biological", label: "Biological" },
  { value: "Device", label: "Device" },
  { value: "Procedure", label: "Procedure" },
  { value: "Behavioral", label: "Behavioral" },
  { value: "Radiation", label: "Radiation" },
  { value: "Dietary Supplement", label: "Dietary Supplement" },
  { value: "Genetic", label: "Genetic" },
  { value: "Diagnostic Test", label: "Diagnostic Test" },
  { value: "Other", label: "Other" },
];

const GENDERS = [
  { value: "", label: "Any" },
  { value: "All", label: "All" },
  { value: "Female", label: "Female Only" },
  { value: "Male", label: "Male Only" },
];

const AGE_GROUPS = [
  { value: "", label: "Any" },
  { value: "child", label: "Pediatric" },
  { value: "adult", label: "Adult" },
  { value: "older_adult", label: "Older Adult" },
];

const GEOGRAPHIES = [
  { value: "", label: "Any" },
  { value: "us_only", label: "US Sites" },
  { value: "international", label: "International Only" },
];

const MULTI_SITES = [
  { value: "", label: "Any" },
  { value: "single", label: "Single-Site" },
  { value: "multi", label: "Multi-Site" },
];

const HEALTHY_VOLS = [
  { value: "", label: "Any" },
  { value: "Yes", label: "Yes" },
  { value: "No", label: "No" },
];

const EMPTY_PROFILE = {
  condition: "", phase: "", allocation: "", masking: "",
  intervention_model: "", primary_purpose: "", intervention_type: "",
  gender: "", age_group: "", healthy_volunteers: "",
  geography: "", multi_site: "",
};

export default function ProfileBuilder({ profile, onChange, onApply, loading }) {
  const [expanded, setExpanded] = useState(false);

  const set = useCallback((field, value) => {
    onChange({ ...profile, [field]: value });
  }, [profile, onChange]);

  const activeCount = Object.values(profile).filter(Boolean).length;

  const handleReset = () => {
    onChange({ ...EMPTY_PROFILE });
  };

  const handleKeyDown = (e) => {
    if (e.key === "Enter" && profile.condition.trim()) onApply();
  };

  return (
    <div className="profile-builder">
      <div className="pb-header">
        <div className="pb-title-row">
          <span className="pb-icon">🎯</span>
          <h3 className="pb-title">Trial Profile</h3>
          {activeCount > 0 && <span className="pb-active-count">{activeCount} active</span>}
        </div>
        <div className="pb-actions">
          {activeCount > 0 && <button className="pb-reset" onClick={handleReset}>Reset</button>}
          <button className={`pb-apply${loading ? " pb-loading" : ""}`} onClick={onApply} disabled={loading || (!profile.condition && !profile.phase && !profile.intervention_type)}>
            {loading ? "Building…" : "Build Cohort"}
          </button>
        </div>
      </div>

      <div className="pb-primary-row">
        <div className="pb-field pb-condition">
          <label>Condition / Disease</label>
          <input
            type="text"
            value={profile.condition}
            onChange={e => set("condition", e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="e.g. Breast Cancer, Diabetes, NSCLC"
          />
        </div>
        <div className="pb-field">
          <label>Phase</label>
          <select value={profile.phase} onChange={e => set("phase", e.target.value)}>
            {PHASES.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
        <div className="pb-field">
          <label>Intervention Type</label>
          <select value={profile.intervention_type} onChange={e => set("intervention_type", e.target.value)}>
            {INTERVENTION_TYPES.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
        <button className="pb-expand-toggle" onClick={() => setExpanded(!expanded)}>
          {expanded ? "▾ Less" : "▸ More Design Params"}
        </button>
      </div>

      {expanded && (
        <div className="pb-advanced-row">
          <div className="pb-field-group">
            <span className="pb-group-label">Design</span>
            <div className="pb-field">
              <label>Allocation</label>
              <select value={profile.allocation} onChange={e => set("allocation", e.target.value)}>
                {ALLOCATIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
            <div className="pb-field">
              <label>Masking</label>
              <select value={profile.masking} onChange={e => set("masking", e.target.value)}>
                {MASKINGS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
            <div className="pb-field">
              <label>Model</label>
              <select value={profile.intervention_model} onChange={e => set("intervention_model", e.target.value)}>
                {INTERVENTION_MODELS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
            <div className="pb-field">
              <label>Purpose</label>
              <select value={profile.primary_purpose} onChange={e => set("primary_purpose", e.target.value)}>
                {PRIMARY_PURPOSES.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
          </div>

          <div className="pb-field-group">
            <span className="pb-group-label">Population</span>
            <div className="pb-field">
              <label>Gender</label>
              <select value={profile.gender} onChange={e => set("gender", e.target.value)}>
                {GENDERS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
            <div className="pb-field">
              <label>Age Group</label>
              <select value={profile.age_group} onChange={e => set("age_group", e.target.value)}>
                {AGE_GROUPS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
            <div className="pb-field">
              <label>Healthy Volunteers</label>
              <select value={profile.healthy_volunteers} onChange={e => set("healthy_volunteers", e.target.value)}>
                {HEALTHY_VOLS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
          </div>

          <div className="pb-field-group">
            <span className="pb-group-label">Geography</span>
            <div className="pb-field">
              <label>Region</label>
              <select value={profile.geography} onChange={e => set("geography", e.target.value)}>
                {GEOGRAPHIES.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
            <div className="pb-field">
              <label>Sites</label>
              <select value={profile.multi_site} onChange={e => set("multi_site", e.target.value)}>
                {MULTI_SITES.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export { EMPTY_PROFILE };
