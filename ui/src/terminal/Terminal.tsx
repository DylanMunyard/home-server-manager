import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

export type TerminalHandle = {
  write: (data: string) => void;
  clear: () => void;
  fit:  () => { cols: number; rows: number } | null;
};

export type TerminalProps = {
  onInput?:  (data: string) => void;
  onResize?: (size: { cols: number; rows: number }) => void;
};

export const Terminal = forwardRef<TerminalHandle, TerminalProps>(({ onInput, onResize }, ref) => {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef  = useRef<FitAddon | null>(null);
  // Writes that arrive before xterm has finished initialising (the host can
  // still be 0×0 in the first frame after mount) go into this buffer and are
  // flushed once init completes.
  const pendingRef = useRef<string[]>([]);

  // Stash latest callbacks so the term init effect doesn't have to depend on them.
  const inputRef  = useRef(onInput);
  const resizeRef = useRef(onResize);
  inputRef.current  = onInput;
  resizeRef.current = onResize;

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    let term: XTerm | null = null;
    let fit: FitAddon | null = null;
    let ro: ResizeObserver | null = null;

    // Poll for a real layout box before opening xterm. The mobile shell's
    // flex column can settle a frame or two after mount; opening into a 0×0
    // host produces a fit() of 0 cols × 0 rows and the renderer paints
    // nothing. Up to ~1s of retries (≈60 frames) handles the slowest cases
    // without falling back to a visibly broken terminal.
    let tries = 0;
    const tryInit = () => {
      if (disposed) return;
      const rect = host.getBoundingClientRect();
      if (rect.width < 20 || rect.height < 20) {
        if (tries++ < 60) requestAnimationFrame(tryInit);
        return;
      }
      term = new XTerm({
        fontFamily: 'JetBrains Mono, ui-monospace, Menlo, monospace',
        fontSize: 13,
        theme: {
          background: '#05080e',
          foreground: '#e2e8f0',
          cursor: '#10b981',
          selectionBackground: 'rgba(16, 185, 129, 0.35)',
        },
        convertEol: true,
        cursorBlink: true,
      });
      fit = new FitAddon();
      term.loadAddon(fit);
      term.open(host);
      try { fit.fit(); } catch { /* ignore */ }
      termRef.current = term;
      fitRef.current  = fit;
      term.onData((data) => inputRef.current?.(data));
      term.onResize(({ cols, rows }) => resizeRef.current?.({ cols, rows }));
      if (pendingRef.current.length) {
        for (const chunk of pendingRef.current) term.write(chunk);
        pendingRef.current = [];
      }

      // Now that the terminal is alive, hook up a refit-on-resize observer.
      ro = new ResizeObserver(() => { try { fit?.fit(); } catch { /* ignore */ } });
      ro.observe(host);
    };
    tryInit();

    return () => {
      disposed = true;
      ro?.disconnect();
      term?.dispose();
      termRef.current = null;
      fitRef.current  = null;
    };
  }, []);

  useImperativeHandle(ref, () => ({
    write: (data: string) => {
      const t = termRef.current;
      if (t) t.write(data);
      else pendingRef.current.push(data);
    },
    clear: () => {
      const t = termRef.current;
      if (t) t.clear();
      else pendingRef.current = [];
    },
    fit: () => {
      const t = termRef.current;
      if (!t) return null;
      try { fitRef.current?.fit(); } catch { /* ignore */ }
      return { cols: t.cols, rows: t.rows };
    },
  }), []);

  // position: relative — xterm internals use absolute positioning (viewport
  // / scroll overlay), so the host must be the containing block or those
  // layers end up positioned against whichever ancestor is positioned, which
  // on the mobile shell is the entire .m-app — visually breaking the terminal.
  return <div className="terminal-wrap"><div ref={hostRef} style={{ width: '100%', height: '100%', position: 'relative' }} /></div>;
});
