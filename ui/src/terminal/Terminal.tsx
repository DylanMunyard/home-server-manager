import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
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

  // Stash latest callbacks so the term init effect doesn't have to depend on them
  // (which would tear down the terminal on every render).
  const inputRef  = useRef(onInput);
  const resizeRef = useRef(onResize);
  inputRef.current  = onInput;
  resizeRef.current = onResize;

  useEffect(() => {
    if (!hostRef.current) return;
    const term = new XTerm({
      fontFamily: 'JetBrains Mono, ui-monospace, Menlo, monospace',
      fontSize: 13,
      theme: { background: '#111111', foreground: '#e6e1d3', cursor: '#f4d36a' },
      convertEol: true,
      cursorBlink: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(hostRef.current);
    fit.fit();
    termRef.current = term;
    fitRef.current  = fit;

    term.onData((data) => inputRef.current?.(data));
    term.onResize(({ cols, rows }) => resizeRef.current?.({ cols, rows }));

    const ro = new ResizeObserver(() => { try { fit.fit(); } catch { /* ignore */ } });
    ro.observe(hostRef.current);

    return () => { ro.disconnect(); term.dispose(); termRef.current = null; fitRef.current = null; };
  }, []);

  useImperativeHandle(ref, () => ({
    write: (data: string) => termRef.current?.write(data),
    clear: () => termRef.current?.clear(),
    fit: () => {
      const t = termRef.current;
      if (!t) return null;
      try { fitRef.current?.fit(); } catch { /* ignore */ }
      return { cols: t.cols, rows: t.rows };
    },
  }), []);

  return <div className="terminal-wrap"><div ref={hostRef} style={{ width: '100%', height: '100%' }} /></div>;
});
