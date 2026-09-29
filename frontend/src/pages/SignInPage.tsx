import { BrandName, brandText } from '../components/BrandName';
import { useState } from 'react';
import Alert from '@cloudscape-design/components/alert';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Container from '@cloudscape-design/components/container';
import Form from '@cloudscape-design/components/form';
import FormField from '@cloudscape-design/components/form-field';
import Grid from '@cloudscape-design/components/grid';
import Header from '@cloudscape-design/components/header';
import Icon from '@cloudscape-design/components/icon';
import Input from '@cloudscape-design/components/input';
import SpaceBetween from '@cloudscape-design/components/space-between';
import type { RuntimeConfig } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { EDDIE_WORDMARK } from '../components/brand';

/**
 * The only unauthenticated view. The pool is admin-create-only, so there is
 * deliberately no sign-up or self-service reset link — offering one would be a
 * control that cannot work.
 */
export function SignInPage({ config }: { config: RuntimeConfig }) {
  const {
    status,
    challenge,
    error,
    busy,
    signIn,
    respondToMfa,
    completeNewPassword,
    cancelChallenge,
  } = useAuth();

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  const inChallenge = status === 'CHALLENGE' && challenge !== null;
  const mismatch =
    newPassword !== '' && confirmPassword !== '' && newPassword !== confirmPassword;

  const credentialsIncomplete = username.trim() === '' || password === '';

  const heading = !inChallenge
    ? 'Sign in'
    : challenge.kind === 'NEW_PASSWORD_REQUIRED'
      ? 'Set a new password'
      : challenge.kind === 'MFA_SETUP'
        ? 'Multi-factor authentication setup required'
        : 'Enter your verification code';

  return (
    <Box padding={{ vertical: 'xxxl', horizontal: 'l' }}>
      <Grid
        gridDefinition={[
          { colspan: { default: 12, s: 8, m: 6, l: 4 }, offset: { s: 2, m: 3, l: 4 } },
        ]}
      >
        <SpaceBetween size="l">
          <Box textAlign="center">
            <SpaceBetween size="xxs">
              <Box variant="h1" fontSize="display-l" fontWeight="bold">
                <span className="eddie-signin-brand">
                  <img className="eddie-signin-wordmark" src={EDDIE_WORDMARK} alt="EDDIE" />
                </span>
              </Box>
              <Box variant="p" color="text-body-secondary">
                Evaluate, Design &amp; Deploy Inference Environments
              </Box>
            </SpaceBetween>
          </Box>

          <Container header={<Header variant="h2">{heading}</Header>}>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (busy) return;
                if (!inChallenge) {
                  if (!credentialsIncomplete) void signIn(username, password);
                } else if (challenge.kind === 'NEW_PASSWORD_REQUIRED') {
                  if (newPassword !== '' && confirmPassword !== '' && !mismatch) {
                    void completeNewPassword(newPassword);
                  }
                } else if (
                  challenge.kind === 'SOFTWARE_TOKEN_MFA' ||
                  challenge.kind === 'SMS_MFA'
                ) {
                  if (code.trim() !== '') void respondToMfa(code);
                }
              }}
            >
              <Form
                actions={
                  <SpaceBetween direction="horizontal" size="xs">
                    {inChallenge ? (
                      <Button
                        formAction="none"
                        onClick={() => {
                          setCode('');
                          setNewPassword('');
                          setConfirmPassword('');
                          setPassword('');
                          cancelChallenge();
                        }}
                        disabled={busy}
                        disabledReason={
                          busy ? 'A sign-in step is in progress.' : undefined
                        }
                      >
                        Start again
                      </Button>
                    ) : null}
                    <Button
                      variant="primary"
                      loading={busy}
                      loadingText="Signing in"
                      disabled={
                        !inChallenge
                          ? credentialsIncomplete
                          : challenge.kind === 'NEW_PASSWORD_REQUIRED'
                            ? newPassword === '' || confirmPassword === '' || mismatch
                            : challenge.kind === 'MFA_SETUP'
                              ? true
                              : code.trim() === ''
                      }
                      disabledReason={
                        !inChallenge
                          ? credentialsIncomplete
                            ? 'Enter your username and password.'
                            : undefined
                          : challenge.kind === 'NEW_PASSWORD_REQUIRED'
                            ? mismatch
                              ? 'The two passwords do not match.'
                              : newPassword === '' || confirmPassword === ''
                                ? 'Enter and confirm your new password.'
                                : undefined
                            : challenge.kind === 'MFA_SETUP'
                              ? 'MFA enrolment cannot be completed from this screen. An administrator must enrol your authenticator.'
                              : code.trim() === ''
                                ? 'Enter the code from your authenticator.'
                                : undefined
                      }
                    >
                      {!inChallenge
                        ? 'Sign in'
                        : challenge.kind === 'NEW_PASSWORD_REQUIRED'
                          ? 'Set password and continue'
                          : 'Verify'}
                    </Button>
                  </SpaceBetween>
                }
              >
                <SpaceBetween size="l">
                  {error ? (
                    <Alert
                      type="error"
                      statusIconAriaLabel="Error"
                      header="Sign-in failed"
                    >
                      {error.message}
                    </Alert>
                  ) : null}

                  {!inChallenge ? (
                    <>
                      <FormField
                        label="Username"
                        description={brandText("Your EDDIE user pool username, created for you by an administrator.")}
                      >
                        <Input
                          value={username}
                          type="text"
                          name="username"
                          autoComplete="username"
                          onChange={({ detail }) => setUsername(detail.value)}
                          ariaLabel="Username"
                          disabled={busy}
                        />
                      </FormField>
                      <FormField label="Password">
                        <Input
                          value={password}
                          type="password"
                          name="password"
                          autoComplete="current-password"
                          onChange={({ detail }) => setPassword(detail.value)}
                          ariaLabel="Password"
                          disabled={busy}
                        />
                      </FormField>
                    </>
                  ) : challenge.kind === 'NEW_PASSWORD_REQUIRED' ? (
                    <>
                      <Alert type="info" statusIconAriaLabel="Information">
                        This account was created by an administrator and needs a
                        password of your own before first use.
                      </Alert>
                      <FormField label="New password">
                        <Input
                          value={newPassword}
                          type="password"
                          autoComplete="new-password"
                          onChange={({ detail }) => setNewPassword(detail.value)}
                          ariaLabel="New password"
                          disabled={busy}
                        />
                      </FormField>
                      <FormField
                        label="Confirm new password"
                        errorText={mismatch ? 'The two passwords do not match.' : undefined}
                      >
                        <Input
                          value={confirmPassword}
                          type="password"
                          autoComplete="new-password"
                          onChange={({ detail }) =>
                            setConfirmPassword(detail.value)
                          }
                          ariaLabel="Confirm new password"
                          disabled={busy}
                        />
                      </FormField>
                    </>
                  ) : challenge.kind === 'MFA_SETUP' ? (
                    <Alert
                      type="warning"
                      statusIconAriaLabel="Warning"
                      header="An authenticator must be enrolled first"
                    >
                      Cognito requires multi-factor enrolment before this
                      account can sign in, and <BrandName /> cannot enrol an
                      authenticator from this screen. Ask an administrator to
                      complete enrolment for your user.
                    </Alert>
                  ) : (
                    <>
                      <Alert type="info" statusIconAriaLabel="Information">
                        {challenge.kind === 'SMS_MFA'
                          ? `Enter the code sent to ${
                              challenge.destination ?? 'your registered device'
                            }.`
                          : 'Enter the current six-digit code from your authenticator app.'}
                      </Alert>
                      <FormField label="Verification code">
                        <Input
                          value={code}
                          type="text"
                          inputMode="numeric"
                          autoComplete="one-time-code"
                          onChange={({ detail }) => setCode(detail.value)}
                          ariaLabel="Verification code"
                          disabled={busy}
                        />
                      </FormField>
                    </>
                  )}
                </SpaceBetween>
              </Form>
            </form>
          </Container>

          <Box textAlign="center" color="text-body-secondary" fontSize="body-s">
            <SpaceBetween size="xxs">
              <div>
                <Icon name="lock-private" size="small" />{' '}
                Accounts are created by an administrator. <BrandName /> has no self-service
                sign-up or password reset.
              </div>
              <div>
                Region {config.region}
                {config.releaseId ? ` · release ${config.releaseId}` : ''}
              </div>
            </SpaceBetween>
          </Box>
        </SpaceBetween>
      </Grid>
    </Box>
  );
}

export default SignInPage;
