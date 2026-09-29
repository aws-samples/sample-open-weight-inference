import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Below this the pane stops constraining itself and lets the page scroll
 * normally, so a very short viewport does not squash the thread to nothing.
 */
const MIN_PANE_HEIGHT = 320;

/**
 * Measure the height still available below an element's top edge.
 *
 * Derived from the element's own position rather than from a viewport unit, so
 * it is correct whatever chrome sits above it — the top navigation, the context
 * strip and the notification area all change height independently. A `100vh`
 * pane below that chrome overhangs by exactly the chrome's height, which is the
 * defect this replaces.
 *
 * `window.innerHeight` is used rather than `100vh` because it tracks mobile
 * browser chrome the way `100dvh` does.
 *
 * A callback ref is used rather than an object ref so measurement happens the
 * moment the node attaches: the pane only exists once the conversation starts,
 * so a mount-time effect would run while the ref was still empty.
 */
export function useFillHeight<T extends HTMLElement>(): {
  ref: (node: T | null) => void;
  height: number | undefined;
  /** Force a re-measure after chrome changes that no observer reports. */
  remeasure: () => void;
} {
  const nodeRef = useRef<T | null>(null);
  const [height, setHeight] = useState<number | undefined>(undefined);

  const measure = useCallback(() => {
    const element = nodeRef.current;
    if (!element || typeof window === 'undefined') return;
    const top = element.getBoundingClientRect().top;
    const available = window.innerHeight - top;
    setHeight((current) => {
      const next = available >= MIN_PANE_HEIGHT ? available : undefined;
      if (next === undefined) return undefined;
      // Ignore sub-pixel churn so setting the height cannot feed back into
      // another measurement.
      if (current !== undefined && Math.abs(current - next) < 2) return current;
      return next;
    });
  }, []);

  const ref = useCallback(
    (node: T | null) => {
      nodeRef.current = node;
      if (node) measure();
      else setHeight(undefined);
    },
    [measure]
  );

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.addEventListener('resize', measure);
    let observer: ResizeObserver | undefined;
    if (typeof ResizeObserver !== 'undefined') {
      // Chrome above the pane can reflow without a window resize — a wrapping
      // context strip, or a flashbar appearing.
      observer = new ResizeObserver(measure);
      observer.observe(document.body);
    }
    return () => {
      window.removeEventListener('resize', measure);
      observer?.disconnect();
    };
  }, [measure]);

  return { ref, height, remeasure: measure };
}
