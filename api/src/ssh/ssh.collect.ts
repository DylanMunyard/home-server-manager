import { runScript } from './ssh.session.js';
import type { ServerConfig } from '../servers/servers.types.js';

/** Captured outcome of running a script over SSH to completion. */
export type CollectResult = {
  connected: boolean;        // did the SSH session reach exec?
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal?: string | null;
  error?: string;            // SSH/connect-level error message, if any
  durationMs: number;
};

/**
 * Run a script over SSH, buffering all output into a single result. The
 * request/response counterpart to the streaming `runScript` — used by the jobs
 * runner (one check/remediation tick) and the file routes (one directory
 * listing / delete). Never rejects: connect/exec failures land in `error`.
 */
export function collectScript(server: ServerConfig, contents: string): Promise<CollectResult> {
  const start = Date.now();
  return new Promise((resolve) => {
    let connected = false;
    let stdout = '';
    let stderr = '';
    let exitCode: number | null = null;
    let signal: string | null | undefined;
    let error: string | undefined;

    const handle = runScript(server, contents, (e) => {
      switch (e.type) {
        case 'connect': connected = true; break;
        case 'stdout':  stdout += e.data; break;
        case 'stderr':  stderr += e.data; break;
        case 'exit':    exitCode = e.code; signal = e.signal; break;
        case 'error':   error = e.message; break;
      }
    });

    handle.done.then(() => {
      resolve({ connected, stdout, stderr, exitCode, signal, error, durationMs: Date.now() - start });
    });
  });
}
