import Alert from '@cloudscape-design/components/alert';
import Button from '@cloudscape-design/components/button';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import { useChat } from '../state/ChatContext';

export function AdvisorSessionStatus({ reportedError }: { reportedError?: string | null }) {
  const { restoring, historyProblem, refreshHistory, hasEarlierMessages, loadEarlier } = useChat();
  // The workspace's save controls already explain a shared connection failure.
  // Keep distinct conversation failures visible, and keep the full chat page
  // self-contained when it has no save controls.
  if (historyProblem && historyProblem === reportedError) return null;
  if (historyProblem) return (
    <Alert type="warning" header="Saved messages could not be opened"
      action={<Button formAction="none" onClick={() => void refreshHistory()}>Check saved conversation</Button>}>
      {historyProblem}
    </Alert>
  );
  if (restoring) return <StatusIndicator type="loading">Checking saved conversation</StatusIndicator>;
  return hasEarlierMessages
    ? <Button formAction="none" iconName="arrow-up" onClick={() => void loadEarlier()}>Earlier messages</Button>
    : null;
}
