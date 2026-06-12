// Node's fetch rejects with a generic TypeError('fetch failed') and buries the
// real reason (ECONNREFUSED, timeout, DNS) in `cause`. Surface it — these
// messages land verbatim in the UI's service chips and must be diagnosable.
export function fetchCause(err: unknown): string {
  const e = err as Error & { cause?: Error & { code?: string } };
  if (e.name === 'TimeoutError') return 'timed out';
  return e.cause?.code ?? e.cause?.message ?? e.message;
}
