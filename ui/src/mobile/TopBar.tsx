type Props = {
  title?: string;     // brand or screen title
  meta?: string;      // top-right meta line (e.g. "7N · 3G")
  onBack?: () => void;
  backLabel?: string;
};

export function TopBar({ title = 'home-lab', meta, onBack, backLabel = 'back' }: Props) {
  return (
    <div className="m-topbar">
      <div>
        {onBack
          ? <button className="m-back" onClick={onBack}>{backLabel}</button>
          : <span className="m-wm">{title}</span>}
      </div>
      <div className="m-meta">{meta}</div>
    </div>
  );
}
