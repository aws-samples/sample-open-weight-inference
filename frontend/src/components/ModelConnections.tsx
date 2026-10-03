import { BrandName, brandText } from './BrandName';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import Alert from '@cloudscape-design/components/alert';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Cards from '@cloudscape-design/components/cards';
import Container from '@cloudscape-design/components/container';
import ExpandableSection from '@cloudscape-design/components/expandable-section';
import FormField from '@cloudscape-design/components/form-field';
import Header from '@cloudscape-design/components/header';
import Input from '@cloudscape-design/components/input';
import Link from '@cloudscape-design/components/link';
import SegmentedControl from '@cloudscape-design/components/segmented-control';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import { ModelSection } from './ModelSection';
import { useCase } from '../state/CaseContext';
import { MODEL_PRESETS } from '../state/caseForm';
import { CatalogPage } from '../pages/CatalogPage';
import { CheckpointSource } from './CheckpointSource';

/** The source is the user's choice. A library name alone is not an AWS target. */
export function ModelConnections({ onCompare, onSettings }: {
  onCompare: () => void;
  onSettings: () => void;
}) {
  const {
    form, patch, changeModel, inspection, inspecting, inspectError, inspectModel,
    fieldOrigins,
  } = useCase();
  const source = form.hfRepo;
  const [view, setView] = useState(form.sourceKind === 'checkpoint' ? 'company' :
    form.sourceKind === 'bedrock' || form.architecture === 'vendor-api' ? 'bedrock' : 'huggingface');
  const [params] = useSearchParams();
  useEffect(() => {
    const requested = params.get('source');
    if (requested && ['bedrock', 'huggingface', 'company'].includes(requested)) setView(requested);
  }, [params]);
  const [search, setSearch] = useState('');
  const suggestions = MODEL_PRESETS.filter((model) =>
    !model.apiOnly && model.patch.modality === 'TEXT' && Number(model.patch.totalParamsB) <= 12 &&
    `${model.label} ${model.patch.hfRepo}`.toLowerCase().includes(search.toLowerCase())
  );
  const inspect = (repo: string, name = repo) => {
    const value = repo.trim();
    if (!value) return;
    changeModel({
      modelName: name,
      hfRepo: value,
      modelIntent: 'specific',
      sourceKind: 'huggingface',
      weightsExportable: true,
    });
    void inspectModel(value);
  };
  return (
    <SpaceBetween size="l">
      <Header
        variant="h2"
        description="An AI model is the part that generates or interprets content. Start with a source you know, or explore a few options."
      >
        Find or connect a model
      </Header>
      <SegmentedControl
        label="Model source"
        selectedId={view}
        onChange={({ detail }) => setView(detail.selectedId)}
        options={[
          { id: 'huggingface', text: 'Hugging Face' },
          { id: 'bedrock', text: 'Amazon Bedrock' },
          { id: 'company', text: 'Your model library' },
        ]}
      />
      {view === 'huggingface' ? (
        <>
          {form.modelStage === 'fine-tuned' ? <Alert type="info" header="Use the checkpoint saved after fine-tuning">
            The original base model does not include your changes. Paste the repository containing your fine-tuned weights,
            or choose Your model library for a private checkpoint.
          </Alert> : null}
          <Container header={<Header variant="h3">Have a model link?</Header>}>
            <SpaceBetween size="m">
              <FormField
                label="Hugging Face model link or repository"
                description={brandText("EDDIE reads the published details. It does not download the weights or execute repository code.")}
              >
                <div className="eddie-input-action">
                  <Input
                    value={source}
                    onChange={({ detail }) => changeModel({
                      hfRepo: detail.value, modelName: detail.value,
                      sourceKind: 'huggingface', modelIntent: 'specific',
                      weightsExportable: true,
                    })}
                    placeholder="https://huggingface.co/Qwen/Qwen2.5-7B-Instruct"
                    ariaLabel="Hugging Face model source"
                    onKeyDown={(event) => {
                      if (event.detail.key === 'Enter' && !inspecting) inspect(source);
                    }}
                  />
                  <Button
                    variant="primary"
                    onClick={() => inspect(source)}
                    loading={inspecting}
                    disabled={!source.trim()}
                  >
                    Read model details
                  </Button>
                </div>
              </FormField>
              {inspectError ? <Alert type="error" header="Could not read this source">{inspectError.message}</Alert> : null}
              {inspection ? (
                <SpaceBetween size="s">
                  <StatusIndicator type={inspection.ok ? 'success' : 'warning'}>
                    {inspection.ok ? `Model information read from ${inspection.repo}` : 'This source needs attention'}
                  </StatusIndicator>
                  {inspection.error ? <Box>{inspection.error}</Box> : null}
                  {inspection.accessDetail ? <Box>{inspection.accessDetail}</Box> : null}
                  <Box variant="small" color="text-body-secondary">
                    Reading model information does not test answer quality, accept its licence or confirm that it can be deployed.
                  </Box>
                  <Button onClick={onCompare} disabled={!form.architecture || inspecting}>
                    Compare hosting for this model
                  </Button>
                </SpaceBetween>
              ) : null}
            </SpaceBetween>
          </Container>

          {!form.modelName || form.modelIntent === 'choose' ? (
            <Container header={<Header variant="h3" description="These are starting points for text tasks, not a quality ranking. Select one to read its current published details.">No model chosen yet?</Header>}>
              <SpaceBetween size="m">
                <Input type="search" value={search} onChange={({ detail }) => setSearch(detail.value)} ariaLabel="Search model starting points" placeholder="Search Qwen, Mistral, Llama…" />
                <Cards
                  items={suggestions.slice(0, search ? 12 : 3)}
                  trackBy="id"
                  cardsPerRow={[{ cards: 1 }, { minWidth: 650, cards: 3 }]}
                  cardDefinition={{
                    header: (item) => item.label,
                    sections: [
                      { id: 'source', content: (item) => <Link external href={`https://huggingface.co/${item.patch.hfRepo}`}>Model page</Link> },
                      { id: 'action', content: (item) => <Button disabled={inspecting} onClick={() => inspect(item.patch.hfRepo, item.label)}>Explore this model</Button> },
                    ],
                  }}
                  empty={<Box>No matching starting point. You can paste any supported Hugging Face repository above.</Box>}
                />
              </SpaceBetween>
            </Container>
          ) : null}
          {form.modelName ? (
            <ExpandableSection headerText="Model facts and expert overrides" variant="container">
              <ModelSection
                form={form}
                onChange={patch}
                onChangeModel={changeModel}
                issueFor={() => undefined}
                inspection={inspection}
                fieldOrigins={fieldOrigins}
                onInspect={(value) => void inspectModel(value)}
                inspecting={inspecting}
                inspectError={inspectError}
              />
            </ExpandableSection>
          ) : null}
        </>
      ) : null}
      {view === 'bedrock' ? (
        <SpaceBetween size="m">
          <Box>
            Hosted models are accessed through an API. A model listing does not establish its suitability for your task or your account’s access.
          </Box>
          <CatalogPage
            embedded region={form.permittedRegions.split(',')[0].trim() || undefined}
            selection={{
              modelId: form.sourceKind === 'bedrock' || form.architecture === 'vendor-api' ? form.modelName : '',
              profileId: form.inferenceProfileId,
              onModel: (model) => changeModel({
                modelName: model.modelId, sourceKind: 'bedrock',
                modelIntent: 'specific', selectionStage: 'committed',
                architecture: 'vendor-api', weightsExportable: false,
                provideLatencyEvidence: false, latencyEvidence: [],
              }),
              onRoute: (profile, region) => patch({
                inferenceProfileId: profile?.id ?? '',
                permittedProcessingRegions: (profile?.processingRegions ?? [region]).join(', '),
              }),
              onCompare,
            }}
          />
        </SpaceBetween>
      ) : null}
      {view === 'company' ? (
        <SpaceBetween size="l">
          <CheckpointSource onCompare={onCompare} />
          <ExpandableSection headerText="Another company source or vendor integration" variant="container">
          <SpaceBetween size="m">
            <FormField label="Source location" description="A repository, S3 location, container image or vendor documentation link. Do not include passwords or access tokens.">
              <Input
                value={form.sourceLocation ?? ''}
                onChange={({ detail }) => changeModel({
                  sourceLocation: detail.value, sourceKind: 'company', modelName: '',
                  modelIntent: 'specific',
                })}
                placeholder="For example: s3://your-model-bucket/model/"
                ariaLabel="Company model source"
              />
            </FormField>
            <Box>
              Company models may need a private package or container. A vendor library may only call a hosted API; it does not necessarily include a model that you can deploy.
            </Box>
            <Alert type="info" header="Private source access needs an adapter">
              The checkpoint library above reads approved private model files. Other private repositories, custom containers and vendor APIs need their own reviewed adapter.
              The location is saved with your project; credentials are never requested here.
            </Alert>
            <Button onClick={onSettings}>Enter model details I already know</Button>
          </SpaceBetween>
          </ExpandableSection>
        </SpaceBetween>
      ) : null}
      <ExpandableSection headerText="Open-source and open-weight: what is the difference?">
        <Box>
          Open weights means model parameters are available under stated terms. Open-source AI involves additional freedoms and access to the information and code needed to modify the system.{' '}
          <BrandName /> uses the actual source, licence and serving requirements; you do not need to classify the model yourself.
        </Box>
        <Link external href="https://opensource.org/ai/open-source-ai-definition">Read the Open Source AI Definition</Link>
      </ExpandableSection>
    </SpaceBetween>
  );
}
