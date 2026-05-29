import { useCallback, useEffect, useState } from 'react';
import type { Runbook } from '../shared/api.ts';

// Backs the param form in both shells (CLAUDE.md: share the hook, not the markup).
// Holds the current values, re-initialised from defaults whenever the selected
// runbook changes, and reports whether every required field is filled.
export function useRunbookParams(runbook: Runbook | null) {
  const [values, setValues] = useState<Record<string, string>>({});

  useEffect(() => {
    const init: Record<string, string> = {};
    for (const p of runbook?.params ?? []) init[p.name] = p.default ?? p.choices?.[0] ?? '';
    setValues(init);
  }, [runbook?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const setValue = useCallback((name: string, v: string) => {
    setValues((s) => ({ ...s, [name]: v }));
  }, []);

  const params = runbook?.params ?? [];
  const missing = params.filter((p) => p.required && !(values[p.name] ?? '').trim()).map((p) => p.name);

  return { params, values, setValue, missing, complete: missing.length === 0 };
}
