import type { RunbookParam } from '../shared/api.ts';

type Props = {
  params: RunbookParam[];
  values: Record<string, string>;
  onChange: (name: string, value: string) => void;
};

// Desktop param form. Mobile renders its own markup (BookDetailScreen) off the
// same useRunbookParams hook — only presentation differs.
export function RunbookParams({ params, values, onChange }: Props) {
  if (params.length === 0) return null;
  return (
    <div className="param-form">
      <div className="param-form-h">inputs</div>
      {params.map((p) => (
        <label key={p.name} className="param-row">
          <span className="param-k">
            {p.name}
            {p.required && <span className="param-req">*</span>}
          </span>
          {p.choices ? (
            <select value={values[p.name] ?? ''} onChange={(e) => onChange(p.name, e.target.value)}>
              {p.choices.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          ) : (
            <input
              type="text"
              value={values[p.name] ?? ''}
              placeholder={p.label}
              onChange={(e) => onChange(p.name, e.target.value)}
            />
          )}
          {p.label !== p.name && <span className="param-label">{p.label}</span>}
        </label>
      ))}
    </div>
  );
}
