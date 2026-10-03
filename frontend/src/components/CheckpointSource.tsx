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

  // Whether the files are a fine-tune or a published model is read from the
  // manifest at inspection, not assumed from the library they came from.
  function choose(value: string) {
    changeModel({
      sourceKind: 'checkpoint', sourceLocation: value, modelName: '',
      modelIntent: 'specific', weightsExportable: true,
    });
  }
  const speech = checkpoint?.artifactFormat === 'gguf-speech-bundle';
  const mib = (bytes?: number) => bytes === undefined ? '—' : `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  const options = (library?.checkpoints ?? []).map((item) => ({
    value: item.source, label: item.label, description: item.library,
  }));
  return <Container header={<Header variant="h3"
    description="Model files packaged for this installation: your fine-tuned checkpoint, or a reviewed published model with its runtime files. Choose where they run in Compare hosting."
    actions={<Button formAction="none" iconName="refresh" loading={loading} onClick={() => setRefresh((value) => value + 1)}>Refresh library</Button>}>
    Your model library
  </Header>}>
    <SpaceBetween size="m">
      {loadError ? <Alert type="info" header="The checkpoint library could not be loaded">
        Your project is unchanged. Retry, or ask the workshop facilitator to check that your model library is installed.
      </Alert> : null}
      <FormField label="Choose a model" description="Only models shared with this installation or your authorized project are listed.">
        <Select ariaLabel="Choose a model" statusType={loading ? 'loading' : 'finished'}
          loadingText="Reading your model library" options={options}
          selectedOption={options.find((item) => item.value === source) ?? null}
          placeholder="Select a model from your library" empty="No models have been published here yet."
          filteringType="auto" onChange={({ detail }) => choose(detail.selectedOption.value ?? '')}
          disabled={inspecting} />
      </FormField>
      <ExpandableSection headerText="Have a model manifest location?">
        <FormField label="Checkpoint manifest" description="Use the private S3 manifest supplied by your model owner. No credentials or presigned URLs.">
          <Input ariaLabel="Checkpoint manifest" value={source} disabled={inspecting}
            onChange={({ detail }) => choose(detail.value)}
            placeholder="s3://your-library/checkpoints/…/manifest.json" />
        </FormField>
      </ExpandableSection>
      <Button formAction="none" variant="primary" loading={inspecting} disabled={!source.trim()}
        onClick={() => void inspectModel(source.trim())}>Read model details</Button>
      {inspectError ? <Alert type="error" header="Could not read this model">{inspectError.message}</Alert> : null}
      {speech && checkpoint && inspection && checkpoint.source === source ? <>
        <StatusIndicator type="success">Model details read</StatusIndicator>
        <ColumnLayout columns={2} variant="text-grid">
          <div><Box variant="small" color="text-label">Your model</Box><Box fontWeight="bold">{checkpoint.name}</Box>
            <Box variant="small">Published model, unchanged · no training history</Box></div>
          <div><Box variant="small" color="text-label">What it does</Box><Box>Text to speech</Box>
            <Box variant="small">Text in; 16-bit mono audio at 22,050 Hz out</Box></div>
          <div><Box variant="small" color="text-label">Files</Box>
            <Box>Model {mib(checkpoint.componentBytes?.tts)} · Codec {mib(checkpoint.componentBytes?.codec)} · Tokenizer {mib(checkpoint.componentBytes?.tokenizer)}</Box>
            <Box variant="small">All three are required to produce audio</Box></div>
          <div><Box variant="small" color="text-label">Format</Box><Box>GGUF · {inspection.fields.precision.value} · {inspection.fields.architecture.value}</Box>
            <Box variant="small">Runs in {checkpoint.runtime?.name ?? 'its native runtime'}</Box></div>
        </ColumnLayout>
        <Box>These files run in a GGUF speech runtime, not in Transformers-based serving or Bedrock model import. Hosting still needs testing.</Box>
        <ExpandableSection headerText="Model identity and evidence">
          <SpaceBetween size="s">
            <Box variant="small">Bundle manifest SHA-256: <span style={{ overflowWrap: 'anywhere' }}>{checkpoint.revision}</span></Box>
            {(checkpoint.upstream ?? []).map((item) => <Box key={item.role} variant="small">
              {item.role === 'tts' ? 'Model' : 'Codec'} source: <Link external href={item.url}>{item.source}</Link> at revision {item.revision}
            </Box>)}
            {checkpoint.runtime ? <Box variant="small">Runtime: {checkpoint.runtime.name}, source revision {checkpoint.runtime.revision}</Box> : null}
            <Box variant="small">Licence: {inspection.fields.licenseId.value}</Box>
            <Box variant="small">Every file matches the reviewed recipe’s size and SHA-256. Full content is checked again before deployment.</Box>
          </SpaceBetween>
        </ExpandableSection>
        <Button formAction="none" onClick={onCompare}>Compare hosting for this model</Button>
      </> : null}
      {!speech && checkpoint && inspection && checkpoint.source === source ? <>
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
            <Box variant="small">Training run: {checkpoint.lineage?.trainingRun}</Box>
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
