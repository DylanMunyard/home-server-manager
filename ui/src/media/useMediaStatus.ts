import { useEffect, useState } from 'react';
import { fetchMediaStatus, type MediaStatus } from '../shared/api.ts';

// Whether any arr is configured — gates the media nav button / tab (clone-and-
// go: a checkout without Radarr/Sonarr hides the view). Fetched once; a load
// failure counts as "disabled" so the UI degrades gracefully.
export function useMediaStatus(): MediaStatus | null {
  const [status, setStatus] = useState<MediaStatus | null>(null);
  useEffect(() => {
    fetchMediaStatus()
      .then(setStatus)
      .catch(() => setStatus({ enabled: false, services: { radarr: false, sonarr: false, plex: false } }));
  }, []);
  return status;
}
