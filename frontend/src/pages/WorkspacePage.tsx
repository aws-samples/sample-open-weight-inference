import { useCallback, useEffect, useRef } from 'react';
import LoadingBar from '@cloudscape-design/chat-components/loading-bar';
import SupportPromptGroup from '@cloudscape-design/chat-components/support-prompt-group';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Container from '@cloudscape-design/components/container';
import Grid from '@cloudscape-design/components/grid';
import PromptInput from '@cloudscape-design/components/prompt-input';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import { useNavigate } from 'react-router-dom';
import { ChatTurnView } from '../components/ChatTurn';
import { DecisionDetail } from '../components/DecisionSummary';
import { YourNeeds } from '../components/YourNeeds';
import { useFillHeight } from '../components/useFillHeight';
import { useCase } from '../state/CaseContext';
import { useChat, type ChatTurn } from '../state/ChatContext';
import { useConversations } from '../state/ConversationsContext';
import { useDetailPanel } from '../state/DetailPanelContext';
import { AdvisorSessionStatus } from '../components/AdvisorSessionStatus';
import { ProjectSaveControls } from '../components/ProjectSaveControls';
import { useChatScroll } from '../components/useChatScroll';

/**
 * The Workspace: one conversation, one decision, one next action.
 *
 * UXR-02 and UXR-03. This replaces the split between `/` (chat) and `/case` (a
 * requirements console). Having both meant the same case was edited in two places with
 * two different vocabularies, and a first-time user landed on whichever they guessed.
 *
 * The conversation is the centre. Requirements, evidence and the full decision open in
 * the contextual panel — one at a time, so the screen never shows the same result as a
 * chat card, a winner card and a split panel simultaneously.
 */

/** The three starters from UXR-02. They fill the composer; they never submit. */
const STARTERS = [
  {
    id: 'choose',
    text: 'Help me choose a model',
    draft:
      'I need help choosing a model. Here is what the application has to do: ',
  },
  {
    id: 'host',
    text: 'Host a model I already have',
    draft: 'I want to host this model: ',
  },
  {
    id: 'cost',
    text: 'Check cost or capacity',
    draft: 'I want to understand the cost of running ',
  },
];

export function WorkspacePage() {
  const {
    turns,
    sending,
    stopping,
    restoring,
    progress,
    suggestedPrompts,
    provenance,
    advisorModelId,
    send,
    retry,
    cancel,
  } = useChat();
  // The form itself lives on /requirements now, so this page needs only the case
  // summary, the staleness signal and the ability to re-evaluate from a decision panel.
  const {
    form,
    draft,
    setDraft,
    outdatedFields,
    decisionRecord,
    evaluate,
  } = useCase();
  const { show, close } = useDetailPanel();
  const { touch } = useConversations();
  const navigate = useNavigate();

  const { threadRef, onScroll, hasNewText, jumpToLatest } = useChatScroll(turns);
  const threadEnd = useRef<HTMLDivElement | null>(null);
  const {
    ref: paneRef,
    height: paneHeight,
    remeasure: remeasurePane,
  } = useFillHeight<HTMLDivElement>();
  const empty = turns.length === 0;

  // Keep the sidebar's title and ordering current without a reload.
  useEffect(() => {
    const first = turns.find((turn) => turn.prompt)?.prompt ?? null;
    touch(form.caseId, first, turns.length);
  }, [turns, form.caseId, touch]);

  useEffect(() => {
    remeasurePane();
  }, [empty, remeasurePane]);

  const submit = (text: string) => {
    const value = text.trim();
    if (value === '' || sending) return;
    setDraft('');
    void send(value);
  };

  /**
   * Requirements open as their own page, not in the split panel.
   *
   * The form is a model block, a workload block, constraints and an evidence section; in
   * a panel a third of the window wide every field wrapped and the result was pushed out
   * of view. Filling in requirements deserves the whole window.
   */
  const openRequirements = useCallback(() => {
    navigate('/requirements');
  }, [navigate]);

  const openDecision = useCallback(
    (turn: ChatTurn) => {
      const decision = turn.response?.decision;
      if (!decision) return;
      const isCurrent =
        decisionRecord?.evaluatedRequestHash != null &&
        decisionRecord.evaluatedRequestHash ===
          (decision.evaluatedRequestHash ?? null);
      show({
        header: 'Full comparison',
        content: (
          <DecisionDetail
            result={decision}
            outdatedFields={isCurrent ? outdatedFields : []}
            onReevaluate={isCurrent ? () => void evaluate() : undefined}
          />
        ),
      });
    },
    [show, decisionRecord, outdatedFields, evaluate]
  );

  // A decision that goes out of date must not sit in an open panel looking current.
  useEffect(() => {
    if (outdatedFields.length > 0) close();
  }, [outdatedFields.length, close]);

  const newestWithDecision = [...turns]
    .reverse()
    .find((turn) => turn.response?.decision)?.id;

  const composer = (
    <PromptInput
      value={draft}
      onChange={({ detail }) => setDraft(detail.value)}
      onAction={({ detail }) => submit(detail.value)}
      actionButtonIconName="send"
      actionButtonAriaLabel="Send message"
      disableActionButton={draft.trim() === '' || sending || restoring}
      placeholder="Describe your application, paste a model link, or ask about GPUs…"
      ariaLabel="Message EDDIE"
      minRows={2}
      maxRows={8}
      disabled={sending}
    />
  );

  const progressPanel = sending ? (
    <Container>
      <SpaceBetween size="s">
        <LoadingBar variant="gen-ai" />
        <SpaceBetween direction="horizontal" size="xs">
          <StatusIndicator type="loading">
            <span data-testid="chat-progress">
              {progress[progress.length - 1]?.message ?? 'Working'}
            </span>
          </StatusIndicator>
          <Button formAction="none" variant="inline-link" onClick={cancel} disabled={stopping}>
            {stopping ? 'Stopping' : 'Stop'}
          </Button>
        </SpaceBetween>
      </SpaceBetween>
    </Container>
  ) : null;

  const persistenceAlert = <AdvisorSessionStatus />;

  /* ---------------------------------------------------------- empty state */

  if (empty) {
    return (
      <Box padding={{ vertical: 'xxxl', horizontal: 'l' }}>
        <Grid
          gridDefinition={[
            {
              colspan: { default: 12, s: 10, m: 9, l: 8, xl: 7 },
              offset: { s: 1, m: 2, l: 2, xl: 3 },
            },
          ]}
        >
          <SpaceBetween size="xl">
            {persistenceAlert}
            <Box textAlign="center">
              <SpaceBetween size="xs">
                <Box
                  variant="h1"
                  fontSize="heading-xl"
                  fontWeight="bold"
                  id="eddie-workspace-heading"
                >
                  What are you building?
                </Box>
                <Box variant="p" color="text-body-secondary">
                  Explore models, compare hosting costs and plan how to test your application.
                </Box>
              </SpaceBetween>
            </Box>
            <ProjectSaveControls />

            {composer}
            {progressPanel}

            {/*
              Starters fill the composer so the user can edit before sending. A click
              that immediately spends a model call is not an editable starter, and none
              of these begins work that incurs inference or build cost.
            */}
            <SpaceBetween size="xs">
              <SupportPromptGroup
                ariaLabel="Ways to start. Selecting one fills the message box so you can edit it before sending."
                alignment="horizontal"
                items={STARTERS.map((starter) => ({
                  id: starter.id,
                  text: starter.text,
                }))}
                onItemClick={({ detail }) => {
                  const starter = STARTERS.find((item) => item.id === detail.id);
                  if (starter) setDraft(starter.draft);
                }}
              />
            </SpaceBetween>

            {/*
              Manual entry, offered from the start.
              *
              Conversation is not the only way in. Making the form reachable only through
              an "Edit" link on a summary that appears after the first reply meant an
              expert who already knows their horizon, budget and Region had to talk their
              way to a form -- answering questions one at a time to reach something they
              could have filled in directly.
            */}
            <Box textAlign="center">
              <Button
                iconName="edit"
                onClick={openRequirements}
                data-testid="enter-manually"
              >
                Open project workspace
              </Button>
            </Box>
          </SpaceBetween>
        </Grid>
      </Box>
    );
  }

  /* --------------------------------------------------------- active state */

  return (
    <div
      ref={paneRef}
      className="eddie-chat-pane"
      style={paneHeight !== undefined ? { height: `${paneHeight}px` } : undefined}
      data-testid="chat-pane"
    >
      <div ref={threadRef} onScroll={onScroll} className="eddie-chat-thread" data-testid="chat-thread">
        <Box padding={{ vertical: 'l', horizontal: 'l' }}>
          <SpaceBetween size="l">
            {persistenceAlert}

            {/*
              The compact summary, with the editor one click away. `Edit` opens the same
              panel the empty state offers, so the manual path is always available rather
              than being a fallback discovered late.
            */}
            <YourNeeds
              form={form}
              onEdit={openRequirements}
              outdatedFields={outdatedFields}
            />

            <SpaceBetween size="l">
              {turns.map((turn) => (
                <ChatTurnView
                  key={turn.id}
                  turn={turn}
                  onRetry={turn.error ? () => void retry(turn.id) : undefined}
                  onOpenDetail={openDecision}
                  outdatedFields={
                    turn.id === newestWithDecision ? outdatedFields : []
                  }
                />
              ))}
            </SpaceBetween>

            {progressPanel}

            {suggestedPrompts.length > 0 ? (
              <SpaceBetween size="xs">
                <Box variant="small" color="text-body-secondary">
                  Follow-up suggestions — selecting one fills the box
                </Box>
                <SupportPromptGroup
                  ariaLabel="Follow-up suggestions. Selecting one fills the message box."
                  alignment="vertical"
                  items={suggestedPrompts.map((prompt, index) => ({
                    id: `suggested-${index}`,
                    text: prompt,
                  }))}
                  onItemClick={({ detail }) => {
                    const index = Number(detail.id.replace('suggested-', ''));
                    const prompt = suggestedPrompts[index];
                    if (prompt) setDraft(prompt);
                  }}
                />
              </SpaceBetween>
            ) : null}

            <div ref={threadEnd} />
          </SpaceBetween>
        </Box>
      </div>

      <div className="eddie-chat-composer">
        <Box padding={{ bottom: 'l', horizontal: 'l', top: 'xs' }}>
          <SpaceBetween size="xs">
            {hasNewText ? <Button variant="inline-link" iconName="angle-down" onClick={jumpToLatest}>Jump to latest</Button> : null}
            {composer}
            {/*
              Kept from the previous design deliberately. This is not diagnostics: it
              states that the prose is commentary and the figures came from the solver,
              and names which model wrote the prose. Removing it as clutter would remove
              a truthfulness affordance.
            */}
            {provenance || advisorModelId ? (
              <Box
                variant="small"
                color="text-body-secondary"
                textAlign="center"
                data-testid="chat-provenance"
              >
                <SpaceBetween size="xxxs">
                  {provenance ? <div>{provenance}</div> : null}
                  {advisorModelId ? (
                    <div>Prose written by {advisorModelId}.</div>
                  ) : null}
                </SpaceBetween>
              </Box>
            ) : null}
            <Box textAlign="center">
              <Button variant="inline-link" iconName="undo" onClick={() => navigate('/new')}>
                New conversation
              </Button>
            </Box>
            <ProjectSaveControls />
          </SpaceBetween>
        </Box>
      </div>
    </div>
  );
}

export default WorkspacePage;
