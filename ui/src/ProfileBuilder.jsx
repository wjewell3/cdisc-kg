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
  { value: "RANDOMIZED", label: "Randomized" },
  { value: "NON_RANDOMIZED", label: "Non-Randomized" },
  { value: "NA", label: "N/A (single-arm)" },
];

const MASKINGS = [
  { value: "", label: "Any" },
  { value: "NONE", label: "Open Label" },
  { value: "SINGLE", label: "Single Blind" },
  { value: "DOUBLE", label: "Double Blind" },
  { value: "TRIPLE", label: "Triple Blind" },
  { value: "QUADRUPLE", label: "Quadruple Blind" },
];

const INTERVENTION_MODELS = [
  { value: "", label: "Any" },
  { value: "PARALLEL", label: "Parallel" },
  { value: "SINGLE_GROUP", label: "Single Group" },
  { value: "CROSSOVER", label: "Crossover" },
  { value: "FACTORIAL", label: "Factorial" },
  { value: "SEQUENTIAL", label: "Sequential" },
];

const PRIMARY_PURPOSES = [
  { value: "", label: "Any" },
  { value: "TREATMENT", label: "Treatment" },
  { value: "PREVENTION", label: "Prevention" },
  { value: "DIAGNOSTIC", label: "Diagnostic" },
  { value: "SUPPORTIVE_CARE", label: "Supportive Care" },
  { value: "SCREENING", label: "Screening" },
  { value: "HEALTH_SERVICES_RESEARCH", label: "Health Services Research" },
  { value: "BASIC_SCIENCE", label: "Basic Science" },
  { value: "DEVICE_FEASIBILITY", label: "Device Feasibility" },
];

const INTERVENTION_TYPES = [
  { value: "", label: "Any" },
  { value: "DRUG", label: "Drug" },
  { value: "BIOLOGICAL", label: "Biological" },
  { value: "DEVICE", label: "Device" },
  { value: "PROCEDURE", label: "Procedure" },
  { value: "BEHAVIORAL", label: "Behavioral" },
  { value: "RADIATION", label: "Radiation" },
  { value: "DIETARY_SUPPLEMENT", label: "Dietary Supplement" },
  { value: "GENETIC", label: "Genetic" },
  { value: "DIAGNOSTIC_TEST", label: "Diagnostic Test" },
  { value: "COMBINATION_PRODUCT", label: "Combination Product" },
  { value: "OTHER", label: "Other" },
];

const GENDERS = [
  { value: "", label: "Any" },
  { value: "ALL", label: "All" },
  { value: "FEMALE", label: "Female Only" },
  { value: "MALE", label: "Male Only" },
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
  { value: "true", label: "Yes" },
  { value: "false", label: "No" },
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
