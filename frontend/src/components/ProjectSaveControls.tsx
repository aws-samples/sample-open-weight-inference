import { useEffect, useState } from 'react';
import Alert from '@cloudscape-design/components/alert';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Modal from '@cloudscape-design/components/modal';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import { useCase } from '../state/CaseContext';

/** Save always means an acknowledged account write, never only a browser cache. */
export function ProjectSaveControls({ nextLabel, onContinue, incompleteReason }: {
  nextLabel?: string;
  onContinue?: () => void;
  incompleteReason?: string;
}) {
  const { projectSave: save, persistenceProblem, form } = useCase();
  const [confirmReload, setConfirmReload] = useState(false);
  useEffect(() => {
    if (!save.dirty || !(form.description || form.modelName)) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [save.dirty, form.description, form.modelName]);
  const status = save.loading ? 'Opening saved project…'
    : save.saving ? 'Saving to your account…'
    : save.error ? 'Draft kept in this browser'
    : save.savedAt && !save.dirty ? `Saved to your account at ${new Date(save.savedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
    : save.savedAt ? 'Changes not saved to your account yet'
    : 'Not saved to your account yet';
  return (
    <div className="eddie-save-controls" aria-label="Project saving">
      <SpaceBetween size="s">
        {save.error ? (
          <Alert type="warning" header="Your current draft has been kept"
            action={save.conflict ? <Button onClick={() => setConfirmReload(true)}>Review saved version</Button> : undefined}>
            {save.error}
          </Alert>
        ) : null}
        {persistenceProblem && save.dirty ? (
          <Box color="text-body-secondary" variant="small">
            Browser draft backup is unavailable. Use Save project to keep your changes in your account, or Download a copy.
          </Box>
        ) : null}
        <div className="eddie-inline-summary">
          <div aria-live="polite">
            <StatusIndicator type={save.loading || save.saving ? 'loading' : !save.error && save.savedAt && !save.dirty ? 'success' : 'info'}>{status}</StatusIndicator>
            {incompleteReason ? <Box variant="small" color="text-body-secondary">{incompleteReason} You can still save a draft or visit another section.</Box> : null}
          </div>
          <SpaceBetween direction="horizontal" size="s">
            <Button formAction="none" iconName="download" onClick={save.download}>Download a copy</Button>
            <Button formAction="none" loading={save.saving} disabled={save.loading || save.conflict}
              onClick={() => void save.save()}>Save project</Button>
            {onContinue ? <Button formAction="none" variant="primary" loading={save.saving}
              disabled={save.loading || save.conflict || Boolean(incompleteReason)}
              onClick={async () => { if (await save.save()) onContinue(); }}>
              {nextLabel ?? 'Save and continue'}
            </Button> : null}
          </SpaceBetween>
        </div>
      </SpaceBetween>
      <Modal visible={confirmReload} onDismiss={() => setConfirmReload(false)} header="Load the saved version?"
        footer={<SpaceBetween direction="horizontal" size="s">
          <Button onClick={() => setConfirmReload(false)}>Keep editing</Button>
          <Button iconName="download" onClick={save.download}>Download my draft</Button>
          <Button variant="primary" onClick={async () => { setConfirmReload(false); await save.reload(); }}>Load saved version</Button>
        </SpaceBetween>}>
        Loading replaces this browser’s current draft. Download a copy first if you want to keep your unsaved changes. The saved project is not overwritten.
      </Modal>
    </div>
  );
}
