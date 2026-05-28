import { DesktopApp } from './desktop/DesktopApp.tsx';
import { MobileApp } from './mobile/MobileApp.tsx';
import { useIsMobile } from './mobile/useIsMobile.ts';

export default function App() {
  return useIsMobile() ? <MobileApp /> : <DesktopApp />;
}
