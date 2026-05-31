import { useState } from 'react';
import { testAlert, type Runbook, type RunbookParam, type ServerSummary } from '../shared/api.ts';
import { ConfirmDialog } from '../shared/ConfirmDialog.tsx';

type Tab = 'script' | 'props';

type Props = {
  runbook: Runbook | null;
  target: ServerSummary | null;
  params: RunbookParam[];
  values: Record<string, string>;
  onParamChange: (name: string, value: string) => void;
  onPickTarget: () => void;
  onRun: () => void;
  canRun: boolean;
};

export function BookDetailScreen({ runbook, target, params, values, onParamChange, onPickTarget, onRun, canRun }: Props) {
  // Land on the props tab when there are inputs to fill — that's the gate to Run.
  const [tab, setTab] = useState<Tab>(params.length > 0 ? 'props' : 'script');
  const [alertBusy, setAlertBusy] = useState(false);
  const [alertMsg, setAlertMsg] = useState<string | null>(null);
  const [confirmRun, setConfirmRun] = useState(false);
  if (!runbook) return <div className="m-empty">loading…</div>;

  // A runbook flagged `confirm:` prompts before the standalone run.
  const onRunClick = () => { if (runbook.confirm) setConfirmRun(true); else onRun(); };

  const sendTestAlert = async () => {
    setAlertBusy(true);
    setAlertMsg(null);
    const r = await testAlert(runbook.id, target?.id ?? null);
    setAlertBusy(false);
    setAlertMsg(r.sent ? 'SENT ✓' : 'FAILED');
  };

  return (
    <>
      <div className="m-dhead">
        <div className="m-dhead-ttl">{runbook.name}</div>
        {runbook.description && <div className="m-dhead-desc">{runbook.description}</div>}
        <div className="m-dhead-target">
          {target
            ? <span className="m-chip"><span className="m-chip-dot" />{target.name}</span>
            : <button className="m-chip add" onClick={onPickTarget}>+ pick target</button>}
          {target && <span className="m-chip key">{target.authType}</span>}
        </div>
      </div>

      <div className="m-subtabs">
        <button className={`m-subtab ${tab === 'script' ? 'active' : ''}`} onClick={() => setTab('script')}>script</button>
        <button className={`m-subtab ${tab === 'props'  ? 'active' : ''}`} onClick={() => setTab('props')}>props</button>
      </div>

      <div className="m-content">
        {tab === 'script'
          ? <ScriptView contents={runbook.contents} />
          : <PropsView runbook={runbook} target={target} params={params} values={values} onParamChange={onParamChange} />}
      </div>

      <div className="m-actionbar two">
        <button
          className="m-run-btn outline small"
          disabled={alertBusy}
          onClick={sendTestAlert}
          title="Send a test ntfy alert simulating a failure — nothing runs"
        >
          {alertBusy ? 'SENDING…' : alertMsg ?? 'TEST ALERT'}
        </button>
        <button
          className="m-run-btn"
          disabled={!canRun}
          onClick={onRunClick}
        >
          RUN ▸
        </button>
      </div>

      {confirmRun && runbook.confirm && (
        <ConfirmDialog
          title={`Run ${runbook.name}?`}
          message={runbook.confirm}
          confirmLabel="Run anyway"
          danger
          onCancel={() => setConfirmRun(false)}
          onConfirm={() => { setConfirmRun(false); onRun(); }}
        />
      )}
    </>
  );
}

function ScriptView({ contents }: { contents: string }) {
  const lines = contents.replace(/\n$/, '').split('\n');
  return (
    <div className="m-script">
      {lines.map((text, i) => {
        const isComment = /^\s*#/.test(text);
        return (
          <div className="m-sln" key={i}>
            <span className="m-ln-no">{i + 1}</span>
            <span className={`m-ln-tx ${isComment ? 'com' : ''}`}>{text || ' '}</span>
          </div>
        );
      })}
    </div>
  );
}

function PropsView({ runbook, target, params, values, onParamChange }: {
  runbook: Runbook;
  target: ServerSummary | null;
  params: RunbookParam[];
  values: Record<string, string>;
  onParamChange: (name: string, value: string) => void;
}) {
  return (
    <div>
      {params.map((p) => (
        <div className="m-param" key={p.name}>
          <label className="m-param-k" htmlFor={`p-${p.name}`}>
            {p.name}{p.required && <span className="m-param-req">*</span>}
          </label>
          {p.choices ? (
            <select id={`p-${p.name}`} className="m-param-in" value={values[p.name] ?? ''} onChange={(e) => onParamChange(p.name, e.target.value)}>
              {p.choices.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          ) : (
            <input id={`p-${p.name}`} className="m-param-in" type="text" value={values[p.name] ?? ''} placeholder={p.label} onChange={(e) => onParamChange(p.name, e.target.value)} />
          )}
        </div>
      ))}
      <div className="m-prop"><span className="m-prop-k">file</span><span className="m-prop-v">config/scripts/{runbook.filename}</span></div>
      <div className="m-prop"><span className="m-prop-k">target</span><span className="m-prop-v">{target ? `${target.user}@${target.host}` : '—'}</span></div>
      <div className="m-prop"><span className="m-prop-k">auth</span><span className="m-prop-v">{target ? target.authType : '—'}</span></div>
    </div>
  );
}
