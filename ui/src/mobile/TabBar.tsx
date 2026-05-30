export type MobileTab = 'books' | 'dashboard' | 'servers' | 'jobs';

type Props = {
  active: MobileTab;
  onChange: (tab: MobileTab) => void;
};

const TABS: { id: MobileTab; label: string; iconClip: string }[] = [
  { id: 'books',     label: 'books',   iconClip: 'polygon(0 0, 100% 0, 100% 78%, 50% 100%, 0 78%)' },
  { id: 'dashboard', label: 'dash',    iconClip: 'polygon(0 60%, 25% 60%, 25% 30%, 50% 30%, 50% 80%, 75% 80%, 75% 10%, 100% 10%, 100% 100%, 0 100%)' },
  { id: 'servers',   label: 'servers', iconClip: 'polygon(0 0, 100% 0, 100% 30%, 0 30%, 0 35%, 100% 35%, 100% 65%, 0 65%, 0 70%, 100% 70%, 100% 100%, 0 100%)' },
  { id: 'jobs',      label: 'jobs',    iconClip: 'polygon(30% 0, 70% 0, 100% 30%, 100% 70%, 70% 100%, 30% 100%, 0 70%, 0 30%)' },
];

export function TabBar({ active, onChange }: Props) {
  return (
    <nav className="m-tabbar four">
      {TABS.map((t) => (
        <button
          key={t.id}
          className={`m-tab ${active === t.id ? 'active' : ''}`}
          onClick={() => onChange(t.id)}
        >
          <span className="m-tab-ic" style={{ clipPath: t.iconClip }} />
          <span>{t.label}</span>
        </button>
      ))}
    </nav>
  );
}
