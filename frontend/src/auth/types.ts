/** An authenticated Cognito session. */
export interface AuthSession {
  username: string;
  email: string | null;
  /** Cognito subject claim: the stable per-user id used to scope stored state. */
  sub: string | null;
  accessToken: string;
  idToken: string;
  /** Epoch milliseconds at which the access token expires. */
  expiresAt: number;
}

/**
 * A challenge Cognito raised instead of completing sign-in.
 *
 * `NEW_PASSWORD_REQUIRED` matters here: the pool is admin-create-only, so a
 * newly created user always hits it on first sign-in.
 */
export type AuthChallenge =
  | { kind: 'NONE' }
  | { kind: 'SOFTWARE_TOKEN_MFA' }
  | { kind: 'SMS_MFA'; destination: string | null }
  | { kind: 'NEW_PASSWORD_REQUIRED' }
  | { kind: 'MFA_SETUP' };

/** Result of a sign-in attempt or a challenge response. */
export type SignInOutcome =
  | { status: 'SIGNED_IN'; session: AuthSession }
  | { status: 'CHALLENGE'; challenge: AuthChallenge };

/** Raised for any authentication failure, carrying a displayable message. */
export class AuthError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
  }
}

/**
 * The authentication surface the application depends on.
 *
 * Defined as an interface so the UI can be tested against a fake without
 * reaching Cognito.
 */
export interface AuthClient {
  /** Restore a persisted session, or `null` if there is none. */
  restore(): Promise<AuthSession | null>;
  signIn(username: string, password: string): Promise<SignInOutcome>;
  /** Answer an MFA challenge (TOTP or SMS). */
  respondToMfa(code: string): Promise<SignInOutcome>;
  /** Answer a NEW_PASSWORD_REQUIRED challenge. */
  completeNewPassword(newPassword: string): Promise<SignInOutcome>;
  /** Exchange the refresh token for a new access token. */
  refresh(): Promise<AuthSession>;
  signOut(): Promise<void>;
}
