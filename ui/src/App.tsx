import { useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { DesktopApp } from './desktop/DesktopApp.tsx';
import { MobileApp } from './mobile/MobileApp.tsx';
import { useIsMobile } from './mobile/useIsMobile.ts';
import { useAuth } from './auth/useAuth.ts';
import { LoginScreen } from './auth/LoginScreen.tsx';

export default function App() {
  const isMobile = useIsMobile();
  const { status } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();

  // Cross-shell URL reconciliation: a desktop-format URL opened on mobile
  // (and vice versa) gets bounced to that shell's equivalent root. We don't
  // try to translate every screen — the user lands on the right starting page
  // and navigates from there.
  useEffect(() => {
    if (status !== 'authed') return;
    if (isMobile && !location.pathname.startsWith('/m')) {
      navigate('/m/books', { replace: true });
    } else if (!isMobile && location.pathname.startsWith('/m')) {
      navigate('/console', { replace: true });
    } else if (!isMobile && location.pathname === '/') {
      navigate('/console', { replace: true });
    }
  }, [isMobile, status, location.pathname, navigate]);

  // Gate the whole app on auth. Because the shells only mount once authed, the
  // terminal WebSockets never open for an anonymous visitor.
  if (status === 'loading') return null;
  if (status === 'anon') return <LoginScreen />;

  return isMobile ? <MobileApp /> : <DesktopApp />;
}
