import { DesktopApp } from './desktop/DesktopApp.tsx';
import { MobileApp } from './mobile/MobileApp.tsx';
import { useIsMobile } from './mobile/useIsMobile.ts';
import { useAuth } from './auth/useAuth.ts';
import { LoginScreen } from './auth/LoginScreen.tsx';

export default function App() {
  const isMobile = useIsMobile();
  const { status } = useAuth();

  // Gate the whole app on auth. Because the shells only mount once authed, the
  // terminal WebSockets never open for an anonymous visitor.
  if (status === 'loading') return null;
  if (status === 'anon') return <LoginScreen />;

  return isMobile ? <MobileApp /> : <DesktopApp />;
}
