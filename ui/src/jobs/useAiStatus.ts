import { useEffect, useState } from 'react';
import { fetchAiStatus, type AiStatus } from '../shared/api.ts';

// Whether Azure OpenAI is configured — gates the AI affordances (clone-and-go:
// a checkout without a deployment hides them). Fetched once; treats a load
// failure as "disabled" so the UI degrades gracefully.
export function useAiStatus(): AiStatus | null {
  const [status, setStatus] = useState<AiStatus | null>(null);
  useEffect(() => {
    fetchAiStatus()
      .then(setStatus)
      .catch(() => setStatus({ enabled: false, deployment: null, apiVersion: '' }));
  }, []);
  return status;
}
