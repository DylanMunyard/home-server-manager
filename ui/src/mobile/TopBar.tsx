type Props = {
  title?: string;     // brand or screen title
  meta?: string;      // top-right meta line (e.g. "7N · 3G")
  onBack?: () => void;
  backLabel?: string;
  signOut?: boolean;  // show a "sign out" link (root screens only)
};

export function TopBar({ title = 'home-lab', meta, onBack, backLabel = 'back', signOut }: Props) {
  return (
    <div className="m-topbar">
      <div>
        {onBack
          ? <button className="m-back" onClick={onBack}>{backLabel}</button>
          : <span className="m-wm">{title}</span>}
      </div>
      <div className="m-topbar-right">
        <span className="m-meta">{meta}</span>
        {signOut && <a className="m-signout" href="/api/auth/logout">sign out</a>}
      </div>
    </div>
  );
}
