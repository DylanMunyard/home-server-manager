import type { JobTrigger } from '../shared/api.ts';

// Tiny, dependency-free humanizer for the cron shapes a personal homelab
// actually uses. Anything it doesn't recognise falls back to the raw cron,
// so the raw form (shown underneath) is always the source of truth.
type Parsed = { human: string; cadence: string };

function pad(n: string): string {
  return n.padStart(2, '0');
}

export function humanizeCron(cron: string): Parsed {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return { human: cron, cadence: 'cron' };
  const [min, hour, dom, mon, dow] = parts;
  const everyField = (f: string) => f === '*';

  // */N in a field
  const stepMin = /^\*\/(\d+)$/.exec(min);
  const stepHour = /^\*\/(\d+)$/.exec(hour);

  // every N minutes:  */N * * * *
  if (stepMin && everyField(hour) && everyField(dom) && everyField(mon) && everyField(dow)) {
    const n = Number(stepMin[1]);
    return { human: n === 1 ? 'every minute' : `every ${n} minutes`, cadence: `${n}m` };
  }

  // every N hours:  0 */N * * *
  if (min === '0' && stepHour && everyField(dom) && everyField(mon) && everyField(dow)) {
    const n = Number(stepHour[1]);
    return { human: n === 1 ? 'every hour' : `every ${n} hours`, cadence: `${n}h` };
  }

  // hourly at minute M:  M * * * *
  if (/^\d+$/.test(min) && everyField(hour) && everyField(dom) && everyField(mon) && everyField(dow)) {
    return { human: `hourly · :${pad(min)}`, cadence: '1h' };
  }

  // daily at HH:MM:  M H * * *
  if (/^\d+$/.test(min) && /^\d+$/.test(hour) && everyField(dom) && everyField(mon) && everyField(dow)) {
    return { human: `daily · ${pad(hour)}:${pad(min)}`, cadence: '1d' };
  }

  // weekly:  M H * * D
  if (/^\d+$/.test(min) && /^\d+$/.test(hour) && everyField(dom) && everyField(mon) && /^\d$/.test(dow)) {
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    return { human: `weekly · ${days[Number(dow) % 7]} ${pad(hour)}:${pad(min)}`, cadence: '1w' };
  }

  return { human: cron, cadence: 'cron' };
}

// when.exit (+ optional stdout) → readable gate, e.g. `exit ≠ 0 · stdout ~ "media-data"`
export function condText(when: JobTrigger | undefined): string {
  if (!when) return 'always';
  const ex =
    when.exit === undefined || when.exit === 'nonzero' ? 'exit ≠ 0'
    : when.exit === 'zero' ? 'exit = 0'
    : `exit = ${when.exit}`;
  return when.stdoutContains ? `${ex} · stdout ~ "${when.stdoutContains}"` : ex;
}

// running > waiting-for-tick (armed). The API has no pause concept (run-now only).
export type JobUiState = 'running' | 'armed';

export function uiState(running: boolean): JobUiState {
  return running ? 'running' : 'armed';
}
