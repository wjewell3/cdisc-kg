import { useState, useCallback, useMemo } from "react";

const STORAGE_KEY = "cdisc_dq_rules";
const DEFAULT_RULES = { groupings: [], bounds: { enrollment: { min: null, max: null } } };

function loadRules() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    if (!stored || typeof stored !== "object") return { ...DEFAULT_RULES };
    return { ...DEFAULT_RULES, ...stored, groupings: stored.groupings || [] };
  } catch {
    return { ...DEFAULT_RULES };
  }
}

function persist(rules) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(rules)); } catch {}
}

export function useDataQuality() {
  const [rules, setRules] = useState(loadRules);

  const addGrouping = useCallback(({ field, canonical, rawValues, note = "" }) => {
    setRules((prev) => {
      const next = {
        ...prev,
        groupings: [
          ...(prev.groupings || []),
          {
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            field,
            canonical,
            rawValues,
            note,
            createdAt: new Date().toISOString(),
          },
        ],
      };
      persist(next);
      return next;
    });
  }, []);

  const removeGrouping = useCallback((id) => {
    setRules((prev) => {
      const next = { ...prev, groupings: prev.groupings.filter((g) => g.id !== id) };
      persist(next);
      return next;
    });
  }, []);

  const updateGrouping = useCallback((id, { field, canonical, rawValues, note }) => {
    setRules((prev) => {
      const next = {
        ...prev,
        groupings: prev.groupings.map((g) =>
          g.id === id ? { ...g, field, canonical, rawValues, note } : g
        ),
      };
      persist(next);
      return next;
    });
  }, []);

  const setEnrollmentBounds = useCallback((min, max) => {
    setRules((prev) => {
      const next = {
        ...prev,
        bounds: { ...prev.bounds, enrollment: { min: min ?? null, max: max ?? null } },
      };
      persist(next);
      return next;
    });
  }, []);

  const exportRules = useCallback(() => JSON.stringify(rules, null, 2), [rules]);

  const importRules = useCallback((json) => {
    try {
      const parsed = JSON.parse(json);
      if (parsed && typeof parsed === "object") {
        const next = { ...DEFAULT_RULES, ...parsed, groupings: parsed.groupings || [] };
        persist(next);
        setRules(next);
      }
    } catch {}
  }, []);

  // Stable primitive values for dep arrays
  const enrollMin = rules.bounds?.enrollment?.min ?? null;
  const enrollMax = rules.bounds?.enrollment?.max ?? null;

  // Normalize a single display value for a given field
  const normalizeValue = useCallback((field, value) => {
    if (!value) return value;
    const low = value.toLowerCase().trim();
    const rule = (rules.groupings || []).find(
      (g) => g.field === field && (g.rawValues || []).some((rv) => rv.toLowerCase().trim() === low)
    );
    return rule ? rule.canonical : value;
  }, [rules.groupings]);

  // Apply grouping rules to an aggData [[label, count]] array — merges grouped entries
  const normalizeAggData = useCallback((field, data) => {
    if (!data?.length) return data;
    const grouped = new Map();
    const order = [];
    for (const [label, count] of data) {
      const canonical = normalizeValue(field, label);
      if (!grouped.has(canonical)) { grouped.set(canonical, 0); order.push(canonical); }
      grouped.set(canonical, grouped.get(canonical) + count);
    }
    return order.map((k) => [k, grouped.get(k)]).sort((a, b) => b[1] - a[1]);
  }, [normalizeValue]);

  return {
    rules,
    addGrouping,
    removeGrouping,
    updateGrouping,
    setEnrollmentBounds,
    exportRules,
    importRules,
    normalizeValue,
    normalizeAggData,
    enrollMin,
    enrollMax,
  };
}
