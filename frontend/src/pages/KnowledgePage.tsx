import { BrandName } from '../components/BrandName';
import { useCallback, useState } from 'react';
import Alert from '@cloudscape-design/components/alert';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Container from '@cloudscape-design/components/container';
import ContentLayout from '@cloudscape-design/components/content-layout';
import FormField from '@cloudscape-design/components/form-field';
import Header from '@cloudscape-design/components/header';
import Icon from '@cloudscape-design/components/icon';
import KeyValuePairs from '@cloudscape-design/components/key-value-pairs';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Spinner from '@cloudscape-design/components/spinner';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Textarea from '@cloudscape-design/components/textarea';
import { useApp } from '../state/AppContext';
import type { KnowledgeResponse, KnowledgeState } from '../api/types';
import { UNKNOWN_LABEL } from '../components/format';

const STATE_COPY: Record<
  KnowledgeState,
  {
    indicator: 'success' | 'warning' | 'error' | 'pending';
    label: string;
    body: string;
  }
> = {
  READY: {
    indicator: 'success',
    label: 'READY',
    body: 'The governed knowledge base answered this query.',
  },
  NOT_INSTALLED: {
    indicator: 'warning',
    label: 'NOT_INSTALLED',
    body: 'The COA knowledge base is not installed in this environment. No governed context was consulted and none exists to consult — this is not an empty result from a working system.',
  },
  SLEEPING: {
    indicator: 'pending',
    label: 'SLEEPING',
    body: 'The knowledge base is asleep to save cost. Wake it from Demo lifecycle before querying; nothing was consulted for this request.',
  },
  ERROR: {
    indicator: 'error',
    label: 'ERROR',
    body: 'The knowledge base reported an error. No governed context was returned.',
  },
};

/**
 * The banner that must appear on every knowledge result.
 *
 * COA context is explanatory only: it never moves a price, a gate or a
 * ranking. Making that unmissable is a product requirement, not decoration.
 */
export function AffectsPlacementNotice({
  affectsPlacement,
}: {
  affectsPlacement: boolean;
}) {
  if (affectsPlacement) {
    // Defensive: the contract fixes this to false. If a backend ever sends
    // true, say so loudly rather than quietly rendering the reassuring copy.
    return (
      <Alert
        type="error"
        statusIconAriaLabel="Error"
        header="Unexpected: this response claims to affect placement"
      >
        The knowledge action returned <Box variant="code">affectsPlacement: true</Box>,
        which contradicts <BrandName />'s contract that governed context never
        influences a price or a gate. Treat this result as untrusted and report
        it.
      </Alert>
    );
  }
  return (
    <Alert
      type="info"
      statusIconAriaLabel="Information"
      header="This context does not affect placement"
      data-testid="affects-placement-notice"
    >
      <SpaceBetween size="xs">
        <Box variant="span">
          <Box variant="code">affectsPlacement: false</Box> — governed context is
          explanatory only. It never changes a price, a gate outcome, a cost
          line item or the ranking. The solver reads none of it.
        </Box>
        <Box variant="small" color="text-body-secondary">
          To change a placement decision you must change the requirements, the
          evidence, or the constraints on the case workspace.
        </Box>
      </SpaceBetween>
    </Alert>
  );
}

const SUGGESTED_QUERIES = [
  'What licence conditions apply to redistributing these model weights?',
  'Which regions are approved for hosting customer inference workloads?',
  'What is our policy on scale-to-zero endpoints for production traffic?',
];

/** COA governed context, clearly separated from anything the solver reads. */
export function KnowledgePage() {
  const { client } = useApp();
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<KnowledgeResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [lastQuery, setLastQuery] = useState<string | null>(null);

  const run = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (trimmed === '') return;
      setLoading(true);
      setError(null);
      try {
        const response = await client.knowledge({ query: trimmed });
        setResult(response);
        setLastQuery(trimmed);
      } catch (caught) {
        setResult(null);
        setError(caught instanceof Error ? caught : new Error(String(caught)));
        setLastQuery(trimmed);
      } finally {
        setLoading(false);
      }
    },
    [client]
  );

  const stateCopy = result ? STATE_COPY[result.state] : null;

  return (
    <ContentLayout
      header={
        <Header
          variant="h1"
          description="Ask the COA governed knowledge base. Answers here explain policy and context; they never influence a price, a gate or the ranking."
        >
          Knowledge
        </Header>
      }
    >
      <SpaceBetween size="l">
        <Container header={<Header variant="h2">Query</Header>}>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void run(query);
            }}
          >
            <SpaceBetween size="m">
              <FormField
                label="Question"
                description="Plain language. The query is sent to the governed knowledge base only."
              >
                <Textarea
                  value={query}
                  rows={3}
                  onChange={({ detail }) => setQuery(detail.value)}
                  ariaLabel="Knowledge query"
                  placeholder="Ask about licence terms, approved regions, or internal policy."
                  disabled={loading}
                />
              </FormField>

              <FormField label="Suggested questions">
                <SpaceBetween size="xs">
                  {SUGGESTED_QUERIES.map((suggestion) => (
                    <Button
                      key={suggestion}
                      formAction="none"
                      variant="link"
                      disabled={loading}
                      disabledReason={
                        loading ? 'A query is in progress.' : undefined
                      }
                      onClick={() => {
                        setQuery(suggestion);
                        void run(suggestion);
                      }}
                    >
                      {suggestion}
                    </Button>
                  ))}
                </SpaceBetween>
              </FormField>

              <SpaceBetween direction="horizontal" size="xs">
                <Button
                  variant="primary"
                  loading={loading}
                  loadingText="Querying"
                  disabled={query.trim() === ''}
                  disabledReason={
                    query.trim() === '' ? 'Enter a question first.' : undefined
                  }
                  onClick={() => void run(query)}
                >
                  Ask
                </Button>
                {result || error ? (
                  <Button
                    formAction="none"
                    onClick={() => {
                      setResult(null);
                      setError(null);
                      setLastQuery(null);
                      setQuery('');
                    }}
                  >
                    Clear
                  </Button>
                ) : null}
              </SpaceBetween>
            </SpaceBetween>
          </form>
        </Container>

        {loading ? (
          <Container header={<Header variant="h2">Querying</Header>}>
            <Box textAlign="center" padding={{ vertical: 'xl' }}>
              <SpaceBetween size="s">
                <Spinner size="large" />
                <Box variant="p">Reading governed context.</Box>
              </SpaceBetween>
            </Box>
          </Container>
        ) : error ? (
          <Alert
            type="error"
            statusIconAriaLabel="Error"
            header="The knowledge query failed"
            action={
              lastQuery ? (
                <Button iconName="refresh" onClick={() => void run(lastQuery)}>
                  Retry
                </Button>
              ) : undefined
            }
          >
            {error.message}
          </Alert>
        ) : !result ? (
          <Container header={<Header variant="h2">Answer</Header>}>
            <Box
              textAlign="center"
              color="text-body-secondary"
              padding={{ vertical: 'xl' }}
            >
              <SpaceBetween size="xs">
                <Box variant="h3">No query yet</Box>
                <Box variant="p">
                  Ask a question above. Nothing is consulted until you do.
                </Box>
              </SpaceBetween>
            </Box>
          </Container>
        ) : (
          <SpaceBetween size="l">
            {/* Rendered first and always, whatever the state. */}
            <AffectsPlacementNotice affectsPlacement={result.affectsPlacement} />

            <Container
              header={
                <Header
                  variant="h2"
                  description={lastQuery ? `Query: ${lastQuery}` : undefined}
                  actions={
                    stateCopy ? (
                      <StatusIndicator type={stateCopy.indicator}>
                        {stateCopy.label}
                      </StatusIndicator>
                    ) : undefined
                  }
                >
                  Answer
                </Header>
              }
            >
              <SpaceBetween size="m">
                {stateCopy ? (
                  <Alert
                    type={
                      result.state === 'READY'
                        ? 'success'
                        : result.state === 'ERROR'
                          ? 'error'
                          : 'warning'
                    }
                    statusIconAriaLabel={stateCopy.indicator}
                    header={`Knowledge base state: ${stateCopy.label}`}
                  >
                    {stateCopy.body}
                    {result.detail ? ` ${result.detail}` : ''}
                  </Alert>
                ) : null}

                <KeyValuePairs
                  columns={3}
                  items={[
                    { label: 'State', value: result.state },
                    {
                      label: 'Trust',
                      value: result.trust ?? UNKNOWN_LABEL,
                    },
                    {
                      label: 'Affects placement',
                      value: (
                        <StatusIndicator type="info">
                          {String(result.affectsPlacement)}
                        </StatusIndicator>
                      ),
                    },
                  ]}
                />

                {result.state === 'READY' && result.context ? (
                  <Box variant="div">
                    <Box variant="h4">Context</Box>
                    <Box variant="p">
                      <span style={{ whiteSpace: 'pre-wrap' }}>
                        {result.context}
                      </span>
                    </Box>
                  </Box>
                ) : (
                  <Box variant="p" color="text-body-secondary">
                    No context was returned.
                    {result.state === 'NOT_INSTALLED'
                      ? ' The knowledge base is not installed, so nothing was consulted.'
                      : ''}
                  </Box>
                )}

                <div>
                  <Box variant="h4">Citations</Box>
                  {!result.citations || result.citations.length === 0 ? (
                    <Box variant="p" color="text-body-secondary">
                      No citations were returned. Without a citation this
                      context has no traceable source.
                    </Box>
                  ) : (
                    <SpaceBetween size="xs">
                      {result.citations.map((citation, index) => (
                        <Box
                          key={index}
                          variant="code"
                          data-testid="knowledge-citation"
                        >
                          <Icon name="file" size="small" />{' '}
                          {JSON.stringify(citation)}
                        </Box>
                      ))}
                    </SpaceBetween>
                  )}
                </div>
              </SpaceBetween>
            </Container>
          </SpaceBetween>
        )}
      </SpaceBetween>
    </ContentLayout>
  );
}

export default KnowledgePage;
