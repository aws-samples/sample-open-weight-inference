import { BrandName, brandText } from './BrandName';
import Alert from '@cloudscape-design/components/alert';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import ColumnLayout from '@cloudscape-design/components/column-layout';
import Container from '@cloudscape-design/components/container';
import ExpandableSection from '@cloudscape-design/components/expandable-section';
import FormField from '@cloudscape-design/components/form-field';
import Header from '@cloudscape-design/components/header';
import Input from '@cloudscape-design/components/input';
import Select from '@cloudscape-design/components/select';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Textarea from '@cloudscape-design/components/textarea';
import Toggle from '@cloudscape-design/components/toggle';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import { useCase } from '../state/CaseContext';
import { metricImpliedPercentile, type CaseFormState } from '../state/caseForm';
import { missingPlanningInputs } from '../state/qualification';

const REGIONS = [
  { value: 'us-east-1', label: 'US East · N. Virginia' },
  { value: 'us-east-2', label: 'US East · Ohio' },
  { value: 'us-west-2', label: 'US West · Oregon' },
  { value: 'eu-central-1', label: 'Europe · Frankfurt' },
  { value: 'eu-west-1', label: 'Europe · Ireland' },
  { value: 'ap-southeast-1', label: 'Asia Pacific · Singapore' },
  { value: 'ap-southeast-2', label: 'Asia Pacific · Sydney' },
];
const PATTERNS = [
  { value: 'unknown', label: 'I’m not sure yet' },
  { value: 'always', label: 'Available all the time' },
  { value: 'occasional', label: 'Occasional use or bursts' },
  { value: 'scheduled', label: 'Specific times or an event' },
];
const SPEEDS = [
  { value: 'p99_latency_ms', label: 'The complete answer' },
  { value: 'ttft_ms', label: 'The first words appear' },
  { value: 'ttfa_ms', label: 'The first audio plays' },
];

/** Optional, directly editable sections. This is a brief, never a wizard gate. */
export function ProjectBrief({ onModels, onAsk }: { onModels: () => void; onAsk?: (prompt: string) => void }) {
  const { form, patch } = useCase();
  const pattern = form.trafficPattern ??
    (form.billableCopyHours === form.horizonHours ? 'always' : 'unknown');
  const days = form.horizonHours.trim() === '' ? '' : String(Number(form.horizonHours) / 24);
  const seconds = form.sloThresholdMs.trim() === '' ? '' : String(Number(form.sloThresholdMs) / 1000);
  const setDays = (value: string) => {
    const hours = value.trim() === '' ? '' : String(Number(value) * 24);
    patch({
      horizonHours: hours,
      ...(pattern === 'always' ? { billableCopyHours: hours } : {}),
    });
  };
  const setPattern = (value: string) => patch({
    trafficPattern: value as CaseFormState['trafficPattern'],
    scheduled: value === 'scheduled',
    billableCopyHours: value === 'always' ? form.horizonHours : '',
    dedicatedInstanceHours: '',
  });
  const choice = (field: keyof CaseFormState, label: string, options: { value: string; label: string }[]) => (
    <FormField label={label}>
      <Select
        options={options}
        selectedOption={options.find((option) => option.value === form[field]) ?? null}
        placeholder="I’m not sure yet"
        ariaLabel={label}
        onChange={({ detail }) => patch({ [field]: detail.selectedOption.value })}
      />
    </FormField>
  );
  const unknown = { value: 'unsure', label: 'I’m not sure yet' };

  return (
    <SpaceBetween size="l">
      <Container header={<Header variant="h2"
        description="Plan how to run an existing model, including one your team has already fine-tuned.">
        What should the application do?
      </Header>}>
        <SpaceBetween size="m">
          {form.workloadType === 'training' || form.workloadType === 'both' ? (
            <Alert type="info" header="Confirm the inference workload"
              action={<Button formAction="none" onClick={() => patch({
                workloadType: 'inference', requests: '', requestsPerMinute: '',
                inputTokensPerRequest: '', outputTokensPerRequest: '', concurrency: '',
                billableCopyHours: '', dedicatedInstanceHours: '', scheduled: false,
                trafficPattern: 'unknown', provideSlo: false, sloThresholdMs: '',
                provideLatencyEvidence: false, latencyEvidence: [],
              })}>Use this project for inference</Button>}>
              This older project includes training. <BrandName /> hosts existing models,
              including fine-tuned models. Switching keeps your model and goal and clears
              usage and response-time estimates so you can enter inference requirements.
            </Alert>
          ) : null}
          <FormField
            label="Your goal"
            constraintText="Required to complete this section. Everything else can be refined as you learn."
            description="Describe the task in your own words. You don’t need to know which model or AWS service to use."
          >
            <Textarea
              value={form.description}
              onChange={({ detail }) => patch({ description: detail.value })}
              placeholder="For example: help our support team sort incoming requests and draft replies for a person to review."
              rows={3}
              ariaLabel="Your goal"
            />
          </FormField>
          {choice('servingPattern', 'How will people get the answers?', [
            { value: 'interactive', label: 'Interactively — people wait for an answer' },
            { value: 'batch', label: 'In batches — process a set of tasks later' },
            { value: 'both', label: 'Both' }, unknown,
          ])}
          <ColumnLayout columns={2}>
            {choice('selectionStage', 'Have you decided on a model?', [
              { value: 'exploring', label: 'I’m comparing options' },
              { value: 'committed', label: 'I need to use a particular model' }, unknown,
            ])}
            {choice('modelStage', 'Has your model been customized?', [
              { value: 'base', label: 'No — use the published model' },
              { value: 'fine-tuned', label: 'Yes — we have fine-tuned weights' }, unknown,
            ])}
          </ColumnLayout>
          <FormField
            label="What would a good answer look like? — optional"
            description="This becomes the brief for testing answer quality. Writing it down does not mean a model has passed."
          >
            <Input
              value={form.successCriteria ?? ''}
              onChange={({ detail }) => patch({ successCriteria: detail.value })}
              placeholder="Correct category, concise reply, and no invented refund policy"
              ariaLabel="What would a good answer look like?"
            />
          </FormField>
          <div className="eddie-inline-summary">
            <div>
              <Box variant="awsui-key-label">Model</Box>
              <Box>{form.modelName || 'You haven’t chosen one yet'}</Box>
            </div>
            <Button onClick={onModels} iconName="search">
              {form.modelName ? 'Change or inspect model' : 'Explore models'}
            </Button>
          </div>
        </SpaceBetween>
      </Container>

      <Container header={<Header variant="h2">Usage and budget</Header>}>
        <SpaceBetween size="m">
          <ColumnLayout columns={2}>
            <FormField label="When will people use it?">
              <Select
                selectedOption={PATTERNS.find((option) => option.value === pattern) ?? PATTERNS[0]}
                options={PATTERNS}
                onChange={({ detail }) => setPattern(detail.selectedOption.value ?? 'unknown')}
                ariaLabel="When will people use it?"
              />
            </FormField>
            <FormField label="Compare costs over" constraintText="Days. This is an estimate window; it does not create or reserve resources.">
              <Input value={days} type="number" inputMode="decimal" onChange={({ detail }) => setDays(detail.value)} ariaLabel="Comparison period in days" />
            </FormField>
            <FormField label="Budget for that period — optional" constraintText="USD, for hosting. Test spending is approved separately.">
              <Input value={form.budgetUsd} type="number" inputMode="decimal" onChange={({ detail }) => patch({ budgetUsd: detail.value })} placeholder="For example: 2000" ariaLabel="Hosting budget in USD" />
            </FormField>
            <FormField label="Where may the model run?" description="Choose a location that meets your data requirements. More locations are available in all settings.">
              <Select
                options={REGIONS}
                selectedOption={REGIONS.find((option) => option.value === form.permittedRegions) ??
                  (form.permittedRegions ? { value: form.permittedRegions, label: form.permittedRegions } : null)}
                placeholder="Choose a location"
                onChange={({ detail }) => patch({ permittedRegions: detail.selectedOption.value ?? '' })}
                ariaLabel="Where may the model run?"
              />
            </FormField>
            <FormField label="When do you want to launch? — optional" description="An intended date helps identify lead-time questions. It is not a capacity reservation.">
              <Input value={form.goLiveDate ?? ''} onChange={({ detail }) => patch({ goLiveDate: detail.value })} ariaLabel="Go-live date" placeholder="For example: 1 December 2026" />
            </FormField>
          </ColumnLayout>

          <ExpandableSection headerText="Usage details — if you know them" variant="footer">
            <SpaceBetween size="m">
              <ColumnLayout columns={2}>
                <FormField label="Requests per minute when busy" description="An arrival rate, not the number of people waiting at once. Leave blank if you don’t know.">
                  <Input value={form.requestsPerMinute ?? ''} type="number" onChange={({ detail }) => patch({ requestsPerMinute: detail.value })} ariaLabel="Requests per minute when busy" />
                </FormField>
                <FormField label="Requests during this period" description="Total requests across the comparison period. Leave blank if you don’t know.">
                  <Input value={form.requests ?? ''} type="number" onChange={({ detail }) => patch({ requests: detail.value })} ariaLabel="Requests during this period" />
                </FormField>
                <FormField label="Requests at the same time" description="For example, four people each waiting for one answer.">
                  <Input value={form.concurrency} type="number" onChange={({ detail }) => patch({ concurrency: detail.value })} ariaLabel="Requests at the same time" />
                </FormField>
                <FormField label="Average input size" constraintText={brandText("Tokens per request. Use your measurements; EDDIE does not convert words into an exact token count.")}>
                  <Input value={form.inputTokensPerRequest ?? ''} type="number" onChange={({ detail }) => patch({ inputTokensPerRequest: detail.value })} ariaLabel="Average input tokens" />
                </FormField>
                <FormField label="Average answer size" constraintText="Tokens per request. Different models may use different token counts.">
                  <Input value={form.outputTokensPerRequest ?? ''} type="number" onChange={({ detail }) => patch({ outputTokensPerRequest: detail.value })} ariaLabel="Average output tokens" />
                </FormField>
              </ColumnLayout>
              {pattern !== 'always' ? (
                <FormField
                  label="Estimated billed hours for an idle-pausing copy"
                  description="Advanced estimate: include idle billing windows and warm-up time. Unknown usage is compared as continuous availability."
                >
                  <Input value={form.billableCopyHours} type="number" onChange={({ detail }) => patch({ billableCopyHours: detail.value })} ariaLabel="Estimated billed copy hours" />
                </FormField>
              ) : null}
            </SpaceBetween>
          </ExpandableSection>
        </SpaceBetween>
      </Container>
      <Container header={<Header variant="h2" description={brandText("These help EDDIE identify constraints and switching risks. Leave anything you don’t know blank.")}>Your platform and requirements</Header>}>
        <SpaceBetween size="m">
          <ColumnLayout columns={2}>
            {choice('platformPreference', 'Where are you starting?', [
              { value: 'new', label: 'A new application' },
              { value: 'sagemaker', label: 'We already use SageMaker' },
              { value: 'eks-ec2', label: 'We already operate EKS or EC2' }, unknown,
            ])}
            {choice('weightCustody', 'Who may manage the model weights?', [
              { value: 'aws-managed', label: 'An AWS managed service is acceptable' },
              { value: 'own-account', label: 'Weights must stay under our account’s control' }, unknown,
            ])}
          </ColumnLayout>
          <ExpandableSection headerText="Growth, availability, data policies and current spending">
            <SpaceBetween size="m">
              <FormField label="What might change in the next 6–12 months?">
                <Input value={form.growthNotes ?? ''} onChange={({ detail }) => patch({ growthNotes: detail.value })} ariaLabel="Expected growth" placeholder="For example: expand from 20 to 100 support agents" />
              </FormField>
              <FormField label="What availability or recovery do you need?">
                <Input value={form.availabilityNeeds ?? ''} onChange={({ detail }) => patch({ availabilityNeeds: detail.value })} ariaLabel="Availability requirements" placeholder="For example: business hours only; a short outage is acceptable" />
              </FormField>
              <FormField label="Any data, privacy or compliance requirements?" description={brandText("Include residency and policies that affect hosting. EDDIE records these for review; it does not certify compliance.")}>
                <Textarea rows={2} value={form.complianceNeeds ?? ''} onChange={({ detail }) => patch({ complianceNeeds: detail.value })} ariaLabel="Data and compliance requirements" />
              </FormField>
              <FormField label="Current monthly inference spend — optional" constraintText="USD per month. This is your baseline, separate from the proposed hosting budget.">
                <Input value={form.currentSpendUsd ?? ''} type="number" onChange={({ detail }) => patch({ currentSpendUsd: detail.value })} ariaLabel="Current monthly inference spend" />
              </FormField>
              <FormField label="Which alternatives have you already tested?" description="Name any models or services and the results you have. Reported results still need evidence before they qualify an option.">
                <Textarea rows={2} value={form.benchmarkedAlternatives ?? ''} onChange={({ detail }) => patch({ benchmarkedAlternatives: detail.value })} ariaLabel="Alternatives already tested" />
              </FormField>
            </SpaceBetween>
          </ExpandableSection>
        </SpaceBetween>
      </Container>
      {missingPlanningInputs(form).length ? (
        <Container header={<Header variant="h3" description="These are optional for exploration. You can save and continue.">What we still need to learn</Header>}>
          <SpaceBetween size="m">
            {missingPlanningInputs(form).map((item) => (
              <div key={item.label} className="eddie-inline-summary">
                <div><StatusIndicator type="info">{item.label}</StatusIndicator><Box color="text-body-secondary">{item.consequence}</Box></div>
                {onAsk ? <Button iconName="gen-ai" onClick={() => onAsk(item.question)}>Help me decide</Button> : null}
              </div>
            ))}
          </SpaceBetween>
        </Container>
      ) : null}

      <Container header={<Header variant="h2">How quickly should it respond?</Header>}>
        <SpaceBetween size="m">
          <Toggle
            checked={form.provideSlo}
            onChange={({ detail }) => patch({ provideSlo: detail.checked })}
          >
            I have a response-time target
          </Toggle>
          {form.provideSlo ? (
            <>
              <ColumnLayout columns={2}>
                <FormField label="What should happen first?">
                  <Select
                    selectedOption={SPEEDS.find((option) => option.value === form.sloMetric) ?? { value: form.sloMetric, label: form.sloMetric }}
                    options={SPEEDS}
                    onChange={({ detail }) => patch({ sloMetric: detail.selectedOption.value ?? 'p99_latency_ms' })}
                    ariaLabel="Response-time measure"
                  />
                </FormField>
                <FormField label="Within how many seconds?" constraintText={`For at least ${metricImpliedPercentile(form.sloMetric) ?? form.sloPercentile}% of requests. Change the percentile in all settings.`}>
                  <Input
                    value={seconds}
                    type="number"
                    inputMode="decimal"
                    onChange={({ detail }) => patch({ sloThresholdMs: detail.value.trim() === '' ? '' : String(Number(detail.value) * 1000) })}
                    ariaLabel="Response target in seconds"
                    placeholder="For example: 5"
                  />
                </FormField>
              </ColumnLayout>
              <Toggle checked={form.sloIncludeCold} onChange={({ detail }) => patch({ sloIncludeCold: detail.checked })}>
                Include the first request after an idle period
              </Toggle>
              <Box variant="small" color="text-body-secondary">
                A speed target is a requirement to test. Estimated costs do not prove an option meets it.
              </Box>
            </>
          ) : (
            <Box color="text-body-secondary">
              You can explore costs now and set a speed target when you know what the application needs.
            </Box>
          )}
        </SpaceBetween>
      </Container>
    </SpaceBetween>
  );
}
