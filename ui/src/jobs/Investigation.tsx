import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useInvestigation } from './useInvestigation.ts';
import { investigateJob, type InvestigationEvent, type Job } from '../shared/api.ts';

// One tool round-trip, folded from a `probe` event + its matching `output`.
type Tool = {
  n: number;
  purpose: string;
  bash: string;
  output?: { exitCode: number | null; stdout: string; stderr: string; rejected?: string };
};
type Item =
  | { kind: 'start'; target: string; reason: string }
  | { kind: 'note'; text: string }
  | { kind: 'tool'; tool: Tool }
  | { kind: 'summary'; text: string }
  | { kind: 'done'; status: 'completed' | 'error'; error?: string };

// Fold the linear event stream into render items, pairing each probe with the
// output that follows it (matched on the probe number).
function fold(events: InvestigationEvent[]): Item[] {
  const items: Item[] = [];
  const toolByN = new Map<number, Tool>();
  for (const e of events) {
    switch (e.type) {
      case 'start': items.push({ kind: 'start', target: e.target, reason: e.reason }); break;
      case 'note': items.push({ kind: 'note', text: e.text }); break;
      case 'probe': {
        const tool: Tool = { n: e.n, purpose: e.purpose, bash: e.bash };
        toolByN.set(e.n, tool);
        items.push({ kind: 'tool', tool });
        break;
      }
      case 'output': {
        const tool = toolByN.get(e.n);
        if (tool) tool.output = { exitCode: e.exitCode, stdout: e.stdout, stderr: e.stderr, rejected: e.rejected };
        break;
      }
      case 'summary': items.push({ kind: 'summary', text: e.text }); break;
      case 'done': items.push({ kind: 'done', status: e.status, error: e.error }); break;
    }
  }
  return items;
}

function ToolCall({ tool }: { tool: Tool }) {
  const out = tool.output;
  return (
    <div className="inv-tool">
      <div className="inv-tool-head">
        <span className="inv-tool-name">run_probe</span>
        <span className="inv-tool-n">#{tool.n}</span>
        {tool.purpose && <span className="inv-tool-purpose">{tool.purpose}</span>}
      </div>
      <pre className="inv-bash"><code>{tool.bash}</code></pre>
      {out?.rejected ? (
        <div className="inv-out rejected">⛔ blocked by safety guard — {out.rejected}</div>
      ) : out ? (
        <div className="inv-out">
          <div className="inv-out-head">
            <span className={`inv-exit ${out.exitCode === 0 ? 'ok' : 'err'}`}>exit {out.exitCode ?? '—'}</span>
          </div>
          {(out.stdout?.trim() || out.stderr?.trim())
            ? <pre className="inv-out-pre">{[out.stdout, out.stderr].filter((s) => s?.trim()).join('\n')}</pre>
            : <pre className="inv-out-pre dim">(no output)</pre>}
        </div>
      ) : (
        <div className="inv-out running">running…</div>
      )}
    </div>
  );
}

export function Investigation({ id }: { id: string }) {
  const { events, status, connected } = useInvestigation(id);
  const items = fold(events);
  const live = status === 'running';

  return (
    <div className="investigation">
      {items.map((it, i) => {
        switch (it.kind) {
          case 'start':
            return (
              <div key={i} className="inv-start">
                <span className="inv-start-dot" />
                investigating <b>{it.target.split('/')[1]}</b> · {it.reason}
              </div>
            );
          case 'note':
            return (
              <div key={i} className="inv-msg">
                <span className="inv-who">AI</span>
                <div className="inv-bubble">{it.text}</div>
              </div>
            );
          case 'tool':
            return <ToolCall key={i} tool={it.tool} />;
          case 'summary':
            return (
              <div key={i} className="inv-summary">
                <div className="inv-summary-h">conclusion</div>
                <div className="inv-summary-body">{it.text}</div>
              </div>
            );
          case 'done':
            return it.status === 'error' ? (
              <div key={i} className="inv-done err">investigation failed{it.error ? ` — ${it.error}` : ''}</div>
            ) : null;
        }
      })}
      {live && (
        <div className="inv-live"><span className="inv-blip" /> {connected ? 'investigating…' : 'reconnecting…'}</div>
      )}
      {items.length === 0 && <div className="inv-empty">connecting to investigation…</div>}
    </div>
  );
}

// The investigation tab: a manual trigger (test the loop / iterate on the prompt
// against the last run) plus every target's latest investigation. The manual
// run streams immediately from the returned id; auto-fired ones come from job
// state. `aiEnabled` gates the trigger (clone-and-go: no deployment ⇒ disabled).
export function JobInvestigations({ job, aiEnabled }: { job: Job; aiEnabled: boolean }) {
  const [target, setTarget] = useState(job.targets[0]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [manualId, setManualId] = useState<string | null>(null);
  const navigate = useNavigate();

  const trigger = async () => {
    setBusy(true);
    setError(null);
    const r = await investigateJob(job.id, target);
    setBusy(false);
    if (r.id) setManualId(r.id);
    else setError(r.error ?? 'failed to start investigation');
  };

  const openChat = (t: string, summary?: string) => {
    const params = new URLSearchParams({ server: t, mode: 'chat' });
    if (summary) params.set('seed', `Investigation summary for ${job.name} on ${t.split('/')[1]}: ${summary}\n\nWhat would you like to investigate or fix?`);
    navigate(`/console?${params.toString()}`);
  };

  const fromState = job.targets
    .map((t) => ({ target: t, inv: job.state.targets[t]?.investigation }))
    .filter((x): x is { target: string; inv: NonNullable<typeof x.inv> } => !!x.inv)
    .filter((x) => x.inv.id !== manualId); // don't double-render the manual one

  return (
    <div className="investigations">
      <div className="inv-trigger">
        {job.targets.length > 1 && (
          <select value={target} onChange={(e) => setTarget(e.target.value)} disabled={busy}>
            {job.targets.map((t) => <option key={t} value={t}>{t.split('/')[1]}</option>)}
          </select>
        )}
        <button onClick={trigger} disabled={busy || !aiEnabled}>
          {busy ? 'Starting…' : 'Investigate last run ▸'}
        </button>
        <button onClick={() => openChat(target)} disabled={!aiEnabled} title="Open an interactive AI chat for this server">
          Chat ▸
        </button>
        {!aiEnabled
          ? <span className="inv-note">AI not configured</span>
          : <span className="inv-note">runs read-only probes on {job.targets.length > 1 ? target.split('/')[1] : 'the host'} · for testing the prompt</span>}
        {error && <span className="inv-note err">{error}</span>}
      </div>

      {manualId && <div className="inv-target"><Investigation id={manualId} /></div>}

      {fromState.map(({ target: t, inv }) => (
        <div key={t} className="inv-target">
          <div className="inv-target-h">
            {job.targets.length > 1 && (
              <span className="mono"><span className="dim">{t.split('/')[0]}/</span>{t.split('/')[1]}</span>
            )}
            <span className={`inv-status ${inv.status}`}>{inv.status}</span>
            {inv.status === 'completed' && (
              <button className="inv-chat-btn" onClick={() => openChat(t, inv.summary)}>
                Chat about this ▸
              </button>
            )}
          </div>
          <Investigation id={inv.id} />
        </div>
      ))}

      {!manualId && fromState.length === 0 && (
        <div className="inv-empty pad">
          No investigation yet. Hit <b>Investigate last run</b> above to probe the
          host (read-only) and correlate the cause. Investigations run only when
          you trigger them here — they don't fire automatically.
        </div>
      )}
    </div>
  );
}
