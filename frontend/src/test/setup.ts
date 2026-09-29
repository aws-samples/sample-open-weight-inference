import '@testing-library/jest-dom/vitest';
import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

// jsdom does not implement these browser APIs that Cloudscape relies on.
if (!('ResizeObserver' in globalThis)) {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  (globalThis as unknown as Record<string, unknown>).ResizeObserver =
    ResizeObserverStub;
}

if (!('matchMedia' in window)) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

if (!('scrollTo' in Element.prototype)) {
  (Element.prototype as unknown as { scrollTo: () => void }).scrollTo = () => {};
}

if (!('scrollIntoView' in Element.prototype)) {
  (
    Element.prototype as unknown as { scrollIntoView: () => void }
  ).scrollIntoView = () => {};
}

// Tests must never reach the network. Any accidental fetch fails loudly.
const failingFetch = vi.fn(() =>
  Promise.reject(new Error('Network access is not allowed in tests.'))
);
vi.stubGlobal('fetch', failingFetch);

afterEach(() => {
  cleanup();
  failingFetch.mockClear();
  // The case is persisted to localStorage, so it would otherwise leak between
  // tests in the same file and quietly restore another test's model or result.
  try {
    window.localStorage.clear();
    window.sessionStorage.clear();
  } catch {
    /* storage unavailable in this environment */
  }
});
