import { useSearchParams } from 'react-router-dom';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import PromptInput from '@cloudscape-design/components/prompt-input';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import { useCase } from '../state/CaseContext';
import { useChat } from '../state/ChatContext';
import { ChatTurnView } from './ChatTurn';
import { AdvisorSessionStatus } from './AdvisorSessionStatus';
import { useChatScroll } from './useChatScroll';

const HELP: Record<string, { label: string; text: string }> = {
  needs: { label: 'Help me describe my workload', text: 'Help me fill out this project. Read what I already entered and ask the next one or two useful questions. I am new to model hosting.' },
  models: { label: 'Help me choose a model', text: 'Help me choose a model for this task. Explain whether an existing Bedrock model or my own model is a better starting point. Use the catalog and source tools, and identify what still needs testing.' },
  hosting: { label: 'Why these hosting options?', text: 'Explain why these hosting options were considered for my current project. Include Amazon Bedrock native models, Custom Model Import, SageMaker and self-managed GPUs. Separate actual checks from options this installation has not evaluated.' },
  tests: { label: 'Help me design a useful test', text: 'Help me design a small answer-quality evaluation for my actual task. Ask for examples and a success criterion. Explain separately how to benchmark response speed.' },
  deployment: { label: 'Help me understand deployment', text: 'Explain what this deployment plan would create, how it is authenticated, what it costs and how removal is confirmed. Do not deploy or approve anything.' },
};

/** Uses the same chat and form as the full conversation; no second agent state. */
export function AdvisorPanel() {
  const { draft, setDraft, outdatedFields, projectSave } = useCase();
  const { turns, sending, stopping, progress, send, retry, cancel, restoring } = useChat();
  const [params, setParams] = useSearchParams();
  const help = HELP[params.get('view') ?? 'needs'] ?? HELP.needs;
  const { threadRef, onScroll, hasNewText, jumpToLatest } = useChatScroll(turns);
  const compare = () => {
    const next = new URLSearchParams(params);
    next.set('view', 'hosting');
    setParams(next);
  };
  const submit = (value: string) => {
    if (!value.trim() || sending) return;
    setDraft('');
    void send(value);
  };
  return (
    <section className="eddie-advisor-panel" aria-label="Advisor conversation and controls">
      <Box color="text-body-secondary">Ask a question or describe a change. Agreed requirements appear in your project.</Box>
      <AdvisorSessionStatus reportedError={projectSave.error} />
      <div ref={threadRef} onScroll={onScroll} className="eddie-advisor-thread" role="log" aria-label="Advisor conversation">
        <SpaceBetween size="l">
          {turns.length ? turns.map((turn, index) => (
            <ChatTurnView key={turn.id} turn={turn} compact
              onRetry={() => void retry(turn.id)}
              onOpenDetail={compare}
              outdatedFields={index === turns.length - 1 ? outdatedFields : []}
            />
          )) : (
            <div className="eddie-advisor-welcome">
              <Box variant="h3">Let’s work through it together</Box>
              <Box>You can start with the problem you want to solve. I’ll ask about the details that matter and show what changes.</Box>
              <Box color="text-body-secondary">Prices come from AWS data. Performance stays unverified until it is tested.</Box>
            </div>
          )}
        </SpaceBetween>
      </div>
      {hasNewText ? <Button variant="inline-link" iconName="angle-down" onClick={jumpToLatest}>Jump to latest</Button> : null}
      {sending ? <SpaceBetween direction="horizontal" size="s">
        <StatusIndicator type="loading">{progress.at(-1)?.message ?? 'Advisor is working'}</StatusIndicator>
        <Button formAction="none" variant="inline-link" onClick={cancel} disabled={stopping}>{stopping ? 'Stopping' : 'Stop'}</Button>
      </SpaceBetween> : null}
      <Button variant="inline-link" onClick={() => setDraft(help.text)}>{help.label}</Button>
      <PromptInput
        value={draft}
        onChange={({ detail }) => setDraft(detail.value)}
        onAction={({ detail }) => submit(detail.value)}
        ariaLabel="Message EDDIE Advisor"
        placeholder="For example: Why SageMaker instead of Bedrock?"
        actionButtonAriaLabel="Send to Advisor" actionButtonIconName="send"
        disableActionButton={sending || restoring || !draft.trim()}
        minRows={2} maxRows={6}
      />
      <Box variant="small" color="text-body-secondary">Advisor messages are saved to your account. Use Save project for form changes. Chat cannot approve a deployment.</Box>
    </section>
  );
}
