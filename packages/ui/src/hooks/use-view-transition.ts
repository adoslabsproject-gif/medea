import { useCallback } from 'react';

/**
 * Wrap an updater in `document.startViewTransition` when supported, fall back
 * to a plain call otherwise. Used for route changes and selection animations.
 *
 * `startViewTransition` is included in modern TS DOM lib but is still optional
 * at runtime, so we feature-detect rather than rely on the type alone.
 */
export function useViewTransition() {
  return useCallback((updater: () => void | Promise<void>) => {
    const start = (
      document as Document & {
        startViewTransition?: (cb: () => void | Promise<void>) => unknown;
      }
    ).startViewTransition;
    if (typeof start === 'function') {
      start.call(document, updater);
    } else {
      void updater();
    }
  }, []);
}
