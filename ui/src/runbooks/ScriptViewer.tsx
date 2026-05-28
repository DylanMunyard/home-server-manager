type Props = { contents: string };

export function ScriptViewer({ contents }: Props) {
  const lines = contents.replace(/\n$/, '').split('\n');
  return (
    <div className="script">
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
