import { useState } from 'react';

type Props = { contents: string; title?: string };

export function ScriptViewer({ contents, title }: Props) {
  const [copied, setCopied] = useState(false);
  const lines = contents.replace(/\n$/, '').split('\n');

  const copyScript = async () => {
    try {
      await navigator.clipboard.writeText(contents);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // fallback
    }
  };

  return (
    <div className="script">
      <div className="script-header">
        <div className="script-header-left">
          <span className="script-badge">BASH</span>
          <span className="script-title">{title ?? 'runbook script'}</span>
          <span className="script-meta">{lines.length} lines</span>
        </div>
        <button
          type="button"
          className={`script-copy-btn ${copied ? 'copied' : ''}`}
          onClick={copyScript}
          title="Copy script to clipboard"
        >
          {copied ? '✓ Copied' : 'Copy'}
        </button>
      </div>
      <pre>
        {lines.map((text, i) => {
          const isComment = /^\s*#/.test(text);
          return (
            <div key={i} className="line">
              <span className="ln">{i + 1}</span>
              <span className={`lc${isComment ? ' comment' : ''}`}>{text || ' '}</span>
            </div>
          );
        })}
      </pre>
    </div>
  );
}
