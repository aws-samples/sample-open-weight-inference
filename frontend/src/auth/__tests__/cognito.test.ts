import { afterEach, describe, expect, it, vi } from 'vitest';
import { CognitoUser } from 'amazon-cognito-identity-js';
import { CognitoAuthClient } from '../cognito';
import { configFixture } from '../../test/fixtures';

afterEach(() => vi.restoreAllMocks());

describe('Cognito first sign-in', () => {
  it('changes the temporary password without resubmitting existing email or identity attributes', async () => {
    vi.spyOn(CognitoUser.prototype, 'authenticateUser').mockImplementation((_details, callbacks) => {
      callbacks.newPasswordRequired?.({
        email: 'participant@example.test',
        email_verified: 'true',
        sub: 'immutable-participant-id',
      }, []);
    });
    const complete = vi.spyOn(CognitoUser.prototype, 'completeNewPasswordChallenge')
      .mockImplementation((_password, attributes, callbacks) => {
        // Cognito rejected the live workshop flow when email was sent here.
        expect(attributes).toEqual({});
        callbacks.totpRequired?.('SOFTWARE_TOKEN_MFA', {});
      });
    const client = new CognitoAuthClient(configFixture);
    await expect(client.signIn('participant', 'temporary-test-value')).resolves.toEqual({
      status: 'CHALLENGE', challenge: { kind: 'NEW_PASSWORD_REQUIRED' },
    });
    await expect(client.completeNewPassword('new-test-value')).resolves.toEqual({
      status: 'CHALLENGE', challenge: { kind: 'SOFTWARE_TOKEN_MFA' },
    });
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('explains an incomplete account instead of opening a password form that cannot succeed', async () => {
    vi.spyOn(CognitoUser.prototype, 'authenticateUser').mockImplementation((_details, callbacks) => {
      callbacks.newPasswordRequired?.({}, ['email']);
    });
    const complete = vi.spyOn(CognitoUser.prototype, 'completeNewPasswordChallenge');
    const client = new CognitoAuthClient(configFixture);
    await expect(client.signIn('participant', 'temporary-test-value')).rejects.toMatchObject({
      code: 'MissingRequiredAttributes',
    });
    await expect(client.completeNewPassword('new-test-value')).rejects.toMatchObject({
      code: 'NoPendingChallenge',
    });
    expect(complete).not.toHaveBeenCalled();
  });
});
