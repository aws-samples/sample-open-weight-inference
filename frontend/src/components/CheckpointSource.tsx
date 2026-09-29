import { useEffect, useState } from 'react';
import Alert from '@cloudscape-design/components/alert';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import ColumnLayout from '@cloudscape-design/components/column-layout';
import Container from '@cloudscape-design/components/container';
import ExpandableSection from '@cloudscape-design/components/expandable-section';
import FormField from '@cloudscape-design/components/form-field';
import Header from '@cloudscape-design/components/header';
import Input from '@cloudscape-design/components/input';
import Link from '@cloudscape-design/components/link';
import Select from '@cloudscape-design/components/select';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import { useApp } from '../state/AppContext';
import { useCase } from '../state/CaseContext';
import type { CheckpointLibrary } from '../api/types';

/** A model's files are selected independently of the service that will host them. */
export function CheckpointSource({ onCompare }: { onCompare: () => void }) {
  const { client } = useApp();
  const { form, changeModel, inspection, inspectModel, inspecting, inspectError } = useCase();
  const [library, setLibrary] = useState<CheckpointLibrary | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const source = form.sourceLocation ?? '';
  const checkpoint = inspection?.ok ? inspection.checkpoint : undefined;
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setLoadError(false);
    void client.listCheckpoints(controller.signal).then((result) => {
      if (!controller.signal.aborted) setLibrary(result);
    }).catch(() => {
      if (!controller.signal.aborted) setLoadError(true);
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [client, refresh]);

  function choose(value: string) {
    changeModel({
      sourceKind: 'checkpoint', sourceLocation: value, modelName: '',
      modelIntent: 'specific', modelStage: 'fine-tuned', weightsExportable: true,
    });
  }
  const options = (library?.checkpoints ?? []).map((item) => ({
    value: item.source, label: item.label, description: item.library,
  }));
  return <Container header={<Header variant="h3"
    description="A checkpoint is the set of model files saved after training. Choose your own fine-tuned files here; choose where they run in Compare hosting."
    actions={<Button formAction="none" iconName="refresh" loading={loading} onClick={() => setRefresh((value) => value + 1)}>Refresh library</Button>}>
    Your fine-tuned model
  </Header>}>
    <SpaceBetween size="m">
      {loadError ? <Alert type="info" header="The checkpoint library could not be loaded">
        Your project is unchanged. Retry, or ask the workshop facilitator to check that your model library is installed.
      </Alert> : null}
      <FormField label="Choose a checkpoint" description="Only models shared with this installation or your authorized project are listed.">
        <Select ariaLabel="Choose a checkpoint" statusType={loading ? 'loading' : 'finished'}
          loadingText="Reading your model library" options={options}
          selectedOption={options.find((item) => item.value === source) ?? null}
          placeholder="Select your fine-tuned model" empty="No checkpoints have been published here yet."
          filteringType="auto" onChange={({ detail }) => choose(detail.selectedOption.value ?? '')}
          disabled={inspecting} />
      </FormField>
      <ExpandableSection headerText="Have a checkpoint manifest location?">
        <FormField label="Checkpoint manifest" description="Use the private S3 manifest supplied by your model owner. No credentials or presigned URLs.">
          <Input ariaLabel="Checkpoint manifest" value={source} disabled={inspecting}
            onChange={({ detail }) => choose(detail.value)}
            placeholder="s3://your-library/checkpoints/…/manifest.json" />
        </FormField>
      </ExpandableSection>
      <Button formAction="none" variant="primary" loading={inspecting} disabled={!source.trim()}
        onClick={() => void inspectModel(source.trim())}>Read checkpoint details</Button>
      {inspectError ? <Alert type="error" header="Could not read this checkpoint">{inspectError.message}</Alert> : null}
      {checkpoint && inspection && checkpoint.source === source ? <>
        <StatusIndicator type="success">Checkpoint details read</StatusIndicator>
        <ColumnLayout columns={2} variant="text-grid">
          <div><Box variant="small" color="text-label">Your checkpoint</Box><Box fontWeight="bold">{checkpoint.name}</Box>
            <Box variant="small">Fine-tuned · {checkpoint.artifactFormat === 'merged-checkpoint' ? 'Adapter merged into complete weights' : 'Complete weights'}</Box></div>
          <div><Box variant="small" color="text-label">Base model used for training</Box><Box>{checkpoint.baseModel.source}</Box>
            <Box variant="small">This is the starting model, not the artifact selected for hosting.</Box></div>
          <div><Box variant="small" color="text-label">Model size</Box><Box>{inspection.fields.totalParamsB.value} billion parameters · {inspection.fields.weightsGb.value} GiB</Box></div>
          <div><Box variant="small" color="text-label">Format</Box><Box>Safetensors · {inspection.fields.precision.value}</Box></div>
        </ColumnLayout>
        <Box>Training history was supplied by the model owner. Answer quality and response time still need testing.</Box>
        <ExpandableSection headerText="Checkpoint identity and evidence">
          <SpaceBetween size="s">
            <Box variant="small">Checkpoint SHA-256: <span style={{ overflowWrap: 'anywhere' }}>{checkpoint.revision}</span></Box>
            <Box variant="small">Base revision: {checkpoint.baseModel.revision}</Box>
            <Box variant="small">Training run: {checkpoint.lineage.trainingRun}</Box>
            <Box variant="small">Configuration and tensor headers were read. Every file’s full content hash is checked before deployment.</Box>
          </SpaceBetween>
        </ExpandableSection>
        <Button formAction="none" onClick={onCompare}>Compare hosting for this checkpoint</Button>
      </> : null}
      <ExpandableSection headerText="What if I only have a LoRA adapter?">
        <SpaceBetween size="s">
          <Box>An adapter contains changes to another model. This recipe needs the adapter merged into its exact base model, then exported with the tokenizer as Safetensors. Ask the model owner for that complete checkpoint.</Box>
          <Link external href="https://docs.aws.amazon.com/bedrock/latest/userguide/custom-model-import-prereq.html">Bedrock model-import requirements</Link>
        </SpaceBetween>
      </ExpandableSection>
    </SpaceBetween>
  </Container>;
}
