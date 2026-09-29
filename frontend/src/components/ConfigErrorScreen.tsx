import { BrandName } from './BrandName';
import Alert from '@cloudscape-design/components/alert';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Container from '@cloudscape-design/components/container';
import Grid from '@cloudscape-design/components/grid';
import Header from '@cloudscape-design/components/header';
import SpaceBetween from '@cloudscape-design/components/space-between';

/**
 * Terminal state when `/config.json` is missing, malformed, or still points at
 * the retired API Gateway. Nothing else can work, so the screen names the
 * missing fields rather than offering controls that would fail.
 */
export function ConfigErrorScreen({ detail }: { detail: string }) {
  return (
    <Box padding={{ vertical: 'xxxl', horizontal: 'l' }}>
      <Grid
        gridDefinition={[
          {
            colspan: { default: 12, s: 10, m: 8, l: 6 },
            offset: { s: 1, m: 2, l: 3 },
          },
        ]}
      >
        <SpaceBetween size="l">
          <Box textAlign="center">
            <Box variant="h1" fontSize="display-l" fontWeight="bold">
              <BrandName />
            </Box>
          </Box>
          <Container
            header={<Header variant="h2">This deployment is not configured</Header>}
          >
            <SpaceBetween size="m">
              <Alert
                type="error"
                statusIconAriaLabel="Error"
                header="Runtime configuration could not be loaded"
              >
                {detail}
              </Alert>
              <Box variant="p">
                <BrandName /> invokes an AgentCore Runtime directly from the browser
                using your Cognito token, so it needs all of the following in{' '}
                <Box variant="code">/config.json</Box>:
              </Box>
              <Box variant="code">
                <pre style={{ whiteSpace: 'pre-wrap', margin: 0 }}>
                  {JSON.stringify(
                    {
                      agentRuntimeArn: 'arn:aws:bedrock-agentcore:…:runtime/…',
                      region: 'us-east-1',
                      releaseId: '…',
                      userPoolId: 'us-east-1_…',
                      userPoolClientId: '…',
                    },
                    null,
                    2
                  )}
                </pre>
              </Box>
              <Box variant="p" color="text-body-secondary">
                There is no local fallback: guessing a runtime ARN or a user pool
                would produce an application that appears to work and fails on
                every action.
              </Box>
              <Button
                variant="primary"
                iconName="refresh"
                onClick={() => window.location.reload()}
              >
                Reload
              </Button>
            </SpaceBetween>
          </Container>
        </SpaceBetween>
      </Grid>
    </Box>
  );
}
