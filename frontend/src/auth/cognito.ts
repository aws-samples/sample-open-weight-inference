import {
  AuthenticationDetails,
  CognitoUser,
  CognitoUserPool,
  CognitoUserSession,
} from 'amazon-cognito-identity-js';
import type { RuntimeConfig } from '../api/types';
import { needsRefresh } from './refresh';
import {
  AuthError,
  type AuthClient,
  type AuthSession,
  type SignInOutcome,
} from './types';

function sessionFromCognito(
  user: CognitoUser,
  session: CognitoUserSession
): AuthSession {
  const accessToken = session.getAccessToken();
  const idToken = session.getIdToken();
  const payload = idToken.decodePayload() as Record<string, unknown>;
  const email =
    typeof payload.email === 'string' && payload.email.trim() !== ''
      ? payload.email
      : null;
  const sub =
    typeof payload.sub === 'string' && payload.sub.trim() !== ''
      ? payload.sub
      : null;
  return {
    username: user.getUsername(),
    email,
    sub,
    accessToken: accessToken.getJwtToken(),
    idToken: idToken.getJwtToken(),
    // `getExpiration()` is in seconds since the epoch.
    expiresAt: accessToken.getExpiration() * 1000,
  };
}

function friendlyMessage(error: unknown): { code: string; message: string } {
  const raw = error as { code?: string; name?: string; message?: string };
  const code = raw?.code ?? raw?.name ?? 'AuthError';
  switch (code) {
    case 'NotAuthorizedException':
      return {
        code,
        message:
          'Incorrect username or password, or your session has expired. Try signing in again.',
      };
    case 'UserNotFoundException':
      // Deliberately identical to the wrong-password message so the form does
      // not disclose which usernames exist.
      return {
        code,
        message: 'Incorrect username or password.',
      };
    case 'PasswordResetRequiredException':
      return {
        code,
        message:
          'This account requires a password reset. Ask an administrator to reset it — EDDIE has no self-service reset.',
      };
    case 'UserNotConfirmedException':
      return {
        code,
        message:
          'This account is not confirmed. An administrator must confirm it before you can sign in.',
      };
    case 'CodeMismatchException':
      return { code, message: 'That verification code is not correct.' };
    case 'ExpiredCodeException':
      return {
        code,
        message: 'That verification code has expired. Generate a new one.',
      };
    case 'InvalidPasswordException':
      return {
        code,
        message:
          raw?.message ?? 'That password does not meet the pool policy.',
      };
    case 'LimitExceededException':
    case 'TooManyRequestsException':
      return {
        code,
        message: 'Too many attempts. Wait a moment and try again.',
      };
    default:
      return {
        code,
        message: raw?.message ?? 'Authentication failed.',
      };
  }
}

/**
 * Cognito SRP authentication.
 *
 * The pool is configured for `ALLOW_USER_SRP_AUTH` and
 * `ALLOW_REFRESH_TOKEN_AUTH` with no client secret. Initial authentication
 * uses SRP; a required password change sends the new password over TLS.
 */
export class CognitoAuthClient implements AuthClient {
  private readonly pool: CognitoUserPool;
  /** The user mid-challenge, retained between challenge steps. */
  private pendingUser: CognitoUser | null = null;

  constructor(config: RuntimeConfig) {
    this.pool = new CognitoUserPool({
      UserPoolId: config.userPoolId,
      ClientId: config.userPoolClientId,
    });
  }

  async restore(): Promise<AuthSession | null> {
    const user = this.pool.getCurrentUser();
    if (!user) return null;
    return new Promise<AuthSession | null>((resolve) => {
      user.getSession(
        (error: Error | null, session: CognitoUserSession | null) => {
          if (error || !session || !session.isValid()) {
            resolve(null);
            return;
          }
          resolve(sessionFromCognito(user, session));
        }
      );
    });
  }

  signIn(username: string, password: string): Promise<SignInOutcome> {
    const user = new CognitoUser({ Username: username, Pool: this.pool });
    this.pendingUser = user;

    const details = new AuthenticationDetails({
      Username: username,
      Password: password,
    });

    return new Promise<SignInOutcome>((resolve, reject) => {
      user.authenticateUser(details, {
        onSuccess: (session) => {
          this.pendingUser = null;
          resolve({ status: 'SIGNED_IN', session: sessionFromCognito(user, session) });
        },
        onFailure: (error) => {
          const { code, message } = friendlyMessage(error);
          reject(new AuthError(code, message));
        },
        totpRequired: () => {
          resolve({ status: 'CHALLENGE', challenge: { kind: 'SOFTWARE_TOKEN_MFA' } });
        },
        mfaRequired: (_name, challengeParameters) => {
          const destination =
            (challengeParameters as Record<string, string> | undefined)
              ?.CODE_DELIVERY_DESTINATION ?? null;
          resolve({
            status: 'CHALLENGE',
            challenge: { kind: 'SMS_MFA', destination },
          });
        },
        mfaSetup: () => {
          resolve({ status: 'CHALLENGE', challenge: { kind: 'MFA_SETUP' } });
        },
        newPasswordRequired: (_userAttributes, requiredAttributes) => {
          // These are existing attributes, not fields to echo back. Cognito
          // rejects an already supplied email in NEW_PASSWORD_REQUIRED.
          // EDDIE's administrator-created accounts must have their required
          // profile fields populated before their first sign-in.
          if (Array.isArray(requiredAttributes) && requiredAttributes.length > 0) {
            this.pendingUser = null;
            reject(new AuthError(
              'MissingRequiredAttributes',
              'Your account is missing required profile information. Ask your administrator to complete the account, then sign in again.'
            ));
            return;
          }
          resolve({
            status: 'CHALLENGE',
            challenge: { kind: 'NEW_PASSWORD_REQUIRED' },
          });
        },
      });
    });
  }

  respondToMfa(code: string): Promise<SignInOutcome> {
    const user = this.pendingUser;
    if (!user) {
      return Promise.reject(
        new AuthError(
          'NoPendingChallenge',
          'There is no sign-in awaiting a verification code. Start again.'
        )
      );
    }
    return new Promise<SignInOutcome>((resolve, reject) => {
      user.sendMFACode(
        code,
        {
          onSuccess: (session) => {
            this.pendingUser = null;
            resolve({
              status: 'SIGNED_IN',
              session: sessionFromCognito(user, session),
            });
          },
          onFailure: (error) => {
            const { code: errorCode, message } = friendlyMessage(error);
            reject(new AuthError(errorCode, message));
          },
        },
        'SOFTWARE_TOKEN_MFA'
      );
    });
  }

  completeNewPassword(newPassword: string): Promise<SignInOutcome> {
    const user = this.pendingUser;
    if (!user) {
      return Promise.reject(
        new AuthError(
          'NoPendingChallenge',
          'There is no sign-in awaiting a new password. Start again.'
        )
      );
    }
    return new Promise<SignInOutcome>((resolve, reject) => {
      user.completeNewPasswordChallenge(
        newPassword,
        {},
        {
          onSuccess: (session) => {
            this.pendingUser = null;
            resolve({
              status: 'SIGNED_IN',
              session: sessionFromCognito(user, session),
            });
          },
          onFailure: (error) => {
            const { code, message } = friendlyMessage(error);
            reject(new AuthError(code, message));
          },
          totpRequired: () => {
            resolve({
              status: 'CHALLENGE',
              challenge: { kind: 'SOFTWARE_TOKEN_MFA' },
            });
          },
          mfaRequired: (_name, challengeParameters) => {
            const destination =
              (challengeParameters as Record<string, string> | undefined)
                ?.CODE_DELIVERY_DESTINATION ?? null;
            resolve({
              status: 'CHALLENGE',
              challenge: { kind: 'SMS_MFA', destination },
            });
          },
        }
      );
    });
  }

  refresh(): Promise<AuthSession> {
    const user = this.pool.getCurrentUser();
    if (!user) {
      return Promise.reject(
        new AuthError('NoCurrentUser', 'You are signed out. Sign in again.')
      );
    }
    return new Promise<AuthSession>((resolve, reject) => {
      // `getSession` transparently uses the refresh token when the access
      // token has expired, which is exactly the silent-refresh behaviour we
      // want for a 60-minute access token inside an 8-hour refresh window.
      user.getSession(
        (error: Error | null, session: CognitoUserSession | null) => {
          if (error || !session) {
            const { code, message } = friendlyMessage(error);
            reject(new AuthError(code, message));
            return;
          }
          const refreshToken = session.getRefreshToken();
          if (session.isValid() && !needsRefresh(sessionFromCognito(user, session))) {
            resolve(sessionFromCognito(user, session));
            return;
          }
          user.refreshSession(refreshToken, (refreshError, refreshed) => {
            if (refreshError || !refreshed) {
              const { code, message } = friendlyMessage(refreshError);
              reject(new AuthError(code, message));
              return;
            }
            resolve(sessionFromCognito(user, refreshed));
          });
        }
      );
    });
  }

  async signOut(): Promise<void> {
    this.pendingUser = null;
    const user = this.pool.getCurrentUser();
    if (!user) return;
    await new Promise<void>((resolve) => {
      // Global sign-out invalidates the refresh token server-side; fall back
      // to a local sign-out if the call fails so the browser never keeps a
      // session the user asked to end.
      user.globalSignOut({
        onSuccess: () => resolve(),
        onFailure: () => {
          user.signOut();
          resolve();
        },
      });
    });
  }
}
