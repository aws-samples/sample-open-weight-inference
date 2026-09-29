import { Mode, applyMode } from '@cloudscape-design/global-styles';

export type ThemeMode = 'light' | 'dark';

const STORAGE_KEY = 'eddie.theme-mode';

function prefersDark(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return true;
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  } catch {
    return true;
  }
}

/**
 * Resolve the initial mode: an explicit stored preference wins, otherwise the
 * OS preference, otherwise dark (dark is EDDIE's primary visual reference).
 */
export function readStoredMode(): ThemeMode {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === 'light' || stored === 'dark') return stored;
  } catch {
    /* localStorage unavailable (private mode, SSR) — fall through */
  }
  return prefersDark() ? 'dark' : 'light';
}

export function persistMode(mode: ThemeMode): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    /* persistence is best-effort */
  }
}

/** Push the mode into Cloudscape's global stylesheet. */
export function applyThemeMode(mode: ThemeMode): void {
  applyMode(mode === 'dark' ? Mode.Dark : Mode.Light);
}
