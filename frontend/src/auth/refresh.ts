import type { AuthSession } from './types';

/**
 * Refresh the access token this far before it actually expires, so an
 * in-flight invocation never carries a token that expires mid-request.
 */
export const REFRESH_SKEW_MS = 5 * 60 * 1000;

/** Never schedule a timer tighter than this, to avoid a refresh storm. */
export const MIN_REFRESH_DELAY_MS = 10 * 1000;

/** True when the token is expired or inside the refresh skew window. */
export function needsRefresh(
  session: AuthSession | null,
  now: number = Date.now()
): boolean {
  if (!session) return false;
  return session.expiresAt - now <= REFRESH_SKEW_MS;
}

/** True when the token cannot be used at all any more. */
export function isExpired(
  session: AuthSession | null,
  now: number = Date.now()
): boolean {
  if (!session) return true;
  return session.expiresAt <= now;
}

/**
 * Delay until the next proactive silent refresh. Clamped so a token that is
 * already inside the skew window refreshes promptly but not instantly.
 */
export function refreshDelayMs(
  session: AuthSession | null,
  now: number = Date.now()
): number | null {
  if (!session) return null;
  const target = session.expiresAt - REFRESH_SKEW_MS - now;
  return Math.max(MIN_REFRESH_DELAY_MS, target);
}

/** Remaining access-token lifetime in whole minutes, for display. */
export function minutesRemaining(
  session: AuthSession | null,
  now: number = Date.now()
): number | null {
  if (!session) return null;
  return Math.max(0, Math.floor((session.expiresAt - now) / 60000));
}
