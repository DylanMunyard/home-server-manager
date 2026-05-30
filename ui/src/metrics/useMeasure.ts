import { useEffect, useRef, useState } from 'react';

// Tracks an element's content width via ResizeObserver — enough to size an SVG
// chart to its container without pulling in another dependency. Height is
// fixed by the caller (charts here are explicitly sized), so width is all we
// need to watch.
export function useMeasure<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      setWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return { ref, width };
}
