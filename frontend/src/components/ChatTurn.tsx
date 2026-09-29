import { BrandName, brandText } from './BrandName';
import { Link as RouterLink, useLocation } from 'react-router-dom';
import Avatar from '@cloudscape-design/chat-components/avatar';
import ChatBubble from '@cloudscape-design/chat-components/chat-bubble';
import Alert from '@cloudscape-design/components/alert';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import ExpandableSection from '@cloudscape-design/components/expandable-section';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Table from '@cloudscape-design/components/table';
import { ApiError } from '../api/agentcore';
import type { ToolCall } from '../api/types';
import type { ChatTurn as ChatTurnModel } from '../state/ChatContext';
import type { CaseChange } from '../state/caseForm';
import { DecisionSummaryCard } from './DecisionSummary';
import {
  StrictModeNotice,
  UnsupportedInputsAlert,
} from './DecisionStatus';
import { Markdown } from './Markdown';
import { AwsDocumentationSources } from './AwsDocumentationSources';
import { EDDIE_MARK } from './brand';

/** Friendly names for the advisor's tools, so this reads as a feature. */
const TOOL_LABELS: Record<string, string> = {
  propose_case_patch: 'Recorded a requirement',
  evaluate_placement: 'Ran the deterministic solver',
  get_rates: 'Retrieved live AWS prices',
  get_catalog: 'Listed native Bedrock models',
  inspect_model: 'Read the model’s published information',
  calculate_usage: 'Calculated usage from your assumptions',
  estimate_inference: 'Estimated model memory and compute needs',
  find_runbooks: 'Found relevant inference guidance',
  read_runbooks: 'Read decision checks and public sources',
  lookup_aws_documentation: 'Checked AWS documentation needs',
  read_aws_documentation: 'Read an AWS documentation section',
};

function toolLabel(name: string): string {
  return TOOL_LABELS[name] ?? name;
}

/**
 * What the advisor actually did this turn.
 *
 * This is a product feature rather than debug output: it is how the user can
 * see that the numbers came from the solver being called, not from the model
 * writing plausible figures.
 */
export function ToolTransparency({
  toolCalls,
  rounds,
  truncated,
  evaluatedRequest,
  attempts,
}: {
  toolCalls: ToolCall[];
  rounds: number | null;
  truncated: boolean;
  /** The exact payload the solver received. */
  evaluatedRequest?: unknown;
  /** Prior attempts at this turn, kept for diagnostics after a retry. */
  attempts?: { id: string; at: number; failed: boolean; message: string | null }[];
}) {
  const evaluated = toolCalls.some(
    (call) => call.name === 'evaluate_placement' && call.status === 'success'
  );
  const failures = toolCalls.filter((call) => call.status !== 'success').length;

  return (
    <SpaceBetween size="xs">
      {truncated ? (
        <Alert
          type="warning"
          statusIconAriaLabel="Warning"
          header="This answer is incomplete"
          data-testid="chat-truncated-warning"
        >
          This turn stopped before the advisor finished, so the answer may be
          incomplete. Any figures below still come from the solver, but a step
          the advisor intended to take may not have run. Narrow the question, or
          supply the missing requirement directly.
        </Alert>
      ) : null}

      {/*
        The trust signal stays outside the collapse. Whether the solver was
        actually called is the point of this panel, so it must not be hidden
        behind a section the user has to open. (`headerActions` is also
        ignored by Cloudscape on the `footer` variant.)
      */}
      <SpaceBetween direction="horizontal" size="xs">
        {evaluated ? (
          <StatusIndicator type="success">Solver called</StatusIndicator>
        ) : (
          <StatusIndicator type="info">No evaluation</StatusIndicator>
        )}
        {failures > 0 ? (
          <StatusIndicator type="warning">
            {failures} tool error{failures === 1 ? '' : 's'}
          </StatusIndicator>
        ) : null}
      </SpaceBetween>

      <ExpandableSection
        variant="footer"
        headerText={
          evaluated
            ? 'What the advisor did — including calling the solver'
            : 'What the advisor did'
        }
      >
        <SpaceBetween size="s">
          <Box variant="small" color="text-body-secondary">
            {rounds === null
              ? 'The runtime did not report a round count.'
              : `${rounds} model round${rounds === 1 ? '' : 's'}, ${
                  toolCalls.length
                } tool call${toolCalls.length === 1 ? '' : 's'}.`}
          </Box>
          <Table<ToolCall>
            variant="embedded"
            contentDensity="compact"
            items={toolCalls}
            trackBy="name"
            ariaLabels={{ tableLabel: 'Tools the advisor called' }}
            columnDefinitions={[
              {
                id: 'name',
                header: 'Action',
                cell: (item) => (
                  <SpaceBetween size="xxxs">
                    <Box variant="span" fontWeight="bold">
                      {toolLabel(item.name)}
                    </Box>
                    <Box variant="small" color="text-body-secondary">
                      {item.name}
                    </Box>
                  </SpaceBetween>
                ),
              },
              {
                id: 'status',
                header: 'Status',
                cell: (item) =>
                  item.status === 'success' ? (
                    <StatusIndicator type="success">success</StatusIndicator>
                  ) : (
                    <StatusIndicator type="error">{item.status}</StatusIndicator>
                  ),
              },
              {
                id: 'input',
                header: 'Input',
                cell: (item) => (
                  <Box variant="code" fontSize="body-s">
                    {JSON.stringify(item.input)}
                  </Box>
                ),
              },
            ]}
            empty={
              <Box
                textAlign="center"
                color="text-body-secondary"
                padding={{ vertical: 's' }}
              >
                The advisor answered from the conversation without calling a
                tool. No figures in this turn come from the solver.
              </Box>
            }
          />

          {evaluatedRequest ? (
            <ExpandableSection
              variant="footer"
              headerText="Exact request the solver received"
            >
              <SpaceBetween size="xs">
                <Box variant="small" color="text-body-secondary">
                  Use this to confirm a stated region, budget or concurrency
                  actually arrived, rather than only appearing in the prose.
                </Box>
                <Box variant="code">
                  <pre
                    style={{ whiteSpace: 'pre-wrap', margin: 0 }}
                    data-testid="evaluated-request"
                  >
                    {JSON.stringify(evaluatedRequest, null, 2)}
                  </pre>
                </Box>
              </SpaceBetween>
            </ExpandableSection>
          ) : null}

          {attempts && attempts.length > 1 ? (
            <ExpandableSection
              variant="footer"
              headerText={`Attempt history (${attempts.length})`}
            >
              <SpaceBetween size="xxs">
                {attempts.map((attempt, index) => (
                  <StatusIndicator
                    key={attempt.id}
                    type={attempt.failed ? 'error' : 'success'}
                  >
                    <span data-testid="attempt-entry">
                      {`Attempt ${index + 1}: ${
                        attempt.failed
                          ? attempt.message ?? 'failed'
                          : 'succeeded'
                      }`}
                    </span>
                  </StatusIndicator>
                ))}
              </SpaceBetween>
            </ExpandableSection>
          ) : null}
        </SpaceBetween>
      </ExpandableSection>
    </SpaceBetween>
  );
}

/** Compact summary of the requirements the advisor recorded this turn. */
export function RequirementsUpdated({ changes }: { changes: CaseChange[] }) {
  const { pathname, search } = useLocation();
  const params = new URLSearchParams(search);
  const pathCase = pathname.match(/^\/c\/([A-Za-z0-9_-]{1,100})$/)?.[1];
  if (pathCase) params.set('case', pathCase);
  params.set('view', 'needs');
  params.delete('source');
  if (changes.length === 0) return null;
  return (
    <Alert
      type="info"
      statusIconAriaLabel="Information"
      header={`Requirements updated — ${changes.length} field${
        changes.length === 1 ? '' : 's'
      }`}
      data-testid="requirements-updated"
      action={
        <RouterLink to={{ pathname: '/requirements', search: params.toString() }}>
          <Button>Edit in case workspace</Button>
        </RouterLink>
      }
    >
      <SpaceBetween size="xxs">
        <SpaceBetween size="xs">
          {changes.map((change) => (
            <Box key={`${change.field}-${change.label}`}>
              <b>{change.label}{change.value ? ':' : ''}</b>{change.value ? ` ${change.value}` : ''}
            </Box>
          ))}
        </SpaceBetween>
        <Box variant="small" color="text-body-secondary">
          These are declared inputs recorded from the conversation, not
          measurements. Correct any of them in the case workspace.
        </Box>
      </SpaceBetween>
    </Alert>
  );
}

const USER_AVATAR = (
  // No `initials`: Cloudscape truncates them to two characters, so "You" rendered
  // as "Yo". A person icon carries the same meaning without being cut off, and the
  // full word stays in the tooltip and the accessible name.
  <Avatar ariaLabel="You" tooltipText="You" iconName="user-profile" />
);

const ADVISOR_AVATAR = (
  <Avatar
    ariaLabel="EDDIE advisor"
    tooltipText="Advisor"
    imgUrl={EDDIE_MARK}
    style={{ root: { background: 'transparent', borderColor: 'transparent' } }}
  />
);

/**
 * One exchange.
 *
 * The prose is commentary. Every figure the user sees is rendered from
 * `decision` through the same panels the form produces, so the interface never
 * depends on the advisor's text being numerically correct.
 */
export function ChatTurnView({
  turn,
  onRetry,
  onOpenDetail,
  outdatedFields = [],
  compact = false,
}: {
  turn: ChatTurnModel;
  onRetry?: () => void;
  /** Opens the full decision in the shell's details surface. */
  onOpenDetail?: (turn: ChatTurnModel) => void;
  /**
   * Only ever non-empty for the newest turn: a historical turn is a transcript
   * of what was true then, so it is never marked out of date.
   */
  outdatedFields?: string[];
  compact?: boolean;
}) {
  const response = turn.response;
  const decision = response?.decision ?? null;
  const attempts = turn.attempts.map((attempt) => ({
    id: attempt.id,
    at: attempt.at,
    failed: attempt.error !== null,
    message: attempt.error?.message ?? null,
  }));

  return (
    <SpaceBetween size="m">
      <ChatBubble
        type="outgoing"
        ariaLabel={`You said: ${turn.prompt}`}
        avatar={USER_AVATAR}
      >
        <Box variant="p">{turn.prompt}</Box>
      </ChatBubble>
      {turn.retainedEdits?.length ? (
        <Alert type="info" header="Your newer edits were kept">
          You changed {turn.retainedEdits.join(', ')} while the Advisor was working.
          Those fields were not replaced by its response. Update the comparison to use your latest inputs.
        </Alert>
      ) : null}

      {(turn.pending || turn.error || (!response && turn.completionStatus)) && turn.streamedReply ? (
        <ChatBubble type="incoming" ariaLabel="EDDIE Advisor answer" avatar={ADVISOR_AVATAR}>
          <div data-testid="answer-stream" aria-busy={turn.pending}>
            <Markdown source={turn.streamedReply} />
          </div>
        </ChatBubble>
      ) : null}
      {turn.completionStatus === 'CANCELLED' && !response ? (
        <StatusIndicator type="stopped">Response stopped in this browser. Partial text is preserved while <BrandName /> checks the saved outcome.</StatusIndicator>
      ) : null}

      {turn.error ? (
        <ChatBubble
          type="incoming"
          ariaLabel="The advisor could not answer"
          avatar={ADVISOR_AVATAR}
        >
          <Alert
            type="error"
            statusIconAriaLabel="Error"
            header={
              turn.error instanceof ApiError && turn.error.handled
                ? 'The coordinator rejected this turn'
                : 'The advisor could not answer'
            }
            action={
              onRetry ? (
                <Button iconName="refresh" onClick={onRetry}>
                  Check saved answer
                </Button>
              ) : undefined
            }
          >
            <SpaceBetween size="xs">
              <Box variant="span" data-testid="chat-turn-error">
                {brandText(turn.error.message)}
              </Box>
              <Box variant="small" color="text-body-secondary">
                Any partial text above is preserved. Checking the saved answer does not rerun the model.
              </Box>
            </SpaceBetween>
          </Alert>
        </ChatBubble>
      ) : response ? (
        <>
          <ChatBubble
            type="incoming"
            ariaLabel="EDDIE advisor replied"
            avatar={ADVISOR_AVATAR}
          >
            <SpaceBetween size="m">
              {response.reply ? (
                <div data-testid="answer-complete"><Markdown source={response.reply} /></div>
              ) : (
                <Box variant="p" color="text-body-secondary">
                  {response.status === 'CANCELLED'
                    ? 'Stopped before any answer text arrived.'
                    : 'The advisor could not produce an answer for this turn.'}
                </Box>
              )}

              {response.status && response.status !== 'COMPLETE' ? (
                <StatusIndicator type={response.status === 'CANCELLED' ? 'stopped' : 'warning'}>
                  {response.detail ?? 'This answer is incomplete. Partial text is preserved.'}
                </StatusIndicator>
              ) : null}
              <RequirementsUpdated changes={turn.changes} />
              <AwsDocumentationSources receipt={response.awsDocumentation} />

              <ToolTransparency
                toolCalls={response.toolCalls ?? []}
                rounds={response.rounds ?? null}
                truncated={response.truncated === true && !response.status}
                evaluatedRequest={response.evaluatedRequest ?? undefined}
                attempts={attempts}
              />
            </SpaceBetween>
          </ChatBubble>

          {/*
            Reported before any recommendation: an input the solver could not
            act on must not be discovered after reading the ranking.
          */}
          <UnsupportedInputsAlert
            unsupportedInputs={response.unsupportedInputs}
          />
          <StrictModeNotice strict={response.strictRequestedByAdvisor === true} />

          {decision && compact ? (
            <Button onClick={() => onOpenDetail?.(turn)}>View updated comparison</Button>
          ) : decision ? (
            // A compact summary only. The full report lives in the details
            // surface, so the conversation stays readable.
            <DecisionSummaryCard
              result={decision}
              outdatedFields={outdatedFields}
              onOpenDetail={
                onOpenDetail ? () => onOpenDetail(turn) : undefined
              }
            />
          ) : null}
        </>
      ) : null}
    </SpaceBetween>
  );
}
