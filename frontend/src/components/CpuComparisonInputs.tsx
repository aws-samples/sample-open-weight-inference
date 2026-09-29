import Box from '@cloudscape-design/components/box';
import ColumnLayout from '@cloudscape-design/components/column-layout';
import ExpandableSection from '@cloudscape-design/components/expandable-section';
import FormField from '@cloudscape-design/components/form-field';
import Input from '@cloudscape-design/components/input';
import Select from '@cloudscape-design/components/select';
import SpaceBetween from '@cloudscape-design/components/space-between';
import type { CaseFormState } from '../state/caseForm';
import { comparisonPeriod } from './hostingLabels';

const DELIVERY = [
  { value: 'unsure', label: 'Not decided' },
  { value: 'batch', label: 'Queued jobs — no live output' },
  { value: 'interactive', label: 'Live or interactive output' },
  { value: 'both', label: 'Both' },
];
const RUNTIME = [
  { value: 'unsure', label: 'Not verified' },
  { value: 'compatible', label: 'A CPU runtime is available' },
  { value: 'gpu-required', label: 'My required runtime needs GPU' },
];

/** Shared project fields; no podcast timing or inferred job volume is prefilled. */
export function CpuComparisonInputs({ form, onChange }: {
  form: CaseFormState; onChange: (patch: Partial<CaseFormState>) => void;
}) {
  const period = comparisonPeriod(form.horizonHours);
  return <ExpandableSection variant="container"
    defaultExpanded={form.modality === 'TTS' || form.servingPattern === 'batch'}
    headerText="Workload and costs for CPU options"
    headerDescription="CPU stays visible while details are unknown. These inputs are shared with your project.">
    <SpaceBetween size="m">
      <ColumnLayout columns={2}>
        <FormField label="Does the workload need live output?">
          <Select options={DELIVERY} selectedOption={DELIVERY.find((o) => o.value === form.servingPattern) ?? DELIVERY[0]}
            onChange={({ detail }) => onChange({ servingPattern: detail.selectedOption.value as CaseFormState['servingPattern'] })} />
        </FormField>
        <FormField label="Job completion deadline (seconds)" description="Include queueing, startup, model loading and generation. Leave blank if undecided.">
          <Input value={form.completionDeadlineSeconds ?? ''} type="number"
            onChange={({ detail }) => onChange({ completionDeadlineSeconds: detail.value })} />
        </FormField>
        <FormField label="Maximum simultaneous jobs or requests">
          <Input value={form.concurrency} type="number"
            onChange={({ detail }) => onChange({ concurrency: detail.value })} />
        </FormField>
        <FormField label={`Jobs or requests in ${period}`} description="Count the same unit for every option, such as one complete episode.">
          <Input value={form.requests ?? ''} type="number"
            onChange={({ detail }) => onChange({ requests: detail.value })} />
        </FormField>
        <FormField label="CPU runtime compatibility" description="A declared runtime still needs validation for this exact model and pipeline.">
          <Select options={RUNTIME} selectedOption={RUNTIME.find((o) => o.value === form.cpuRuntime) ?? RUNTIME[0]}
            onChange={({ detail }) => onChange({ cpuRuntime: detail.selectedOption.value as CaseFormState['cpuRuntime'] })} />
        </FormField>
      </ColumnLayout>
      <ExpandableSection headerText="Allocation schedule and supporting charges">
        <SpaceBetween size="m">
          <Box>Compare the same workload over {period}. A single podcast job's cost cannot be compared with a whole month of endpoint hosting.</Box>
          <FormField label={`Allocated hours per worker in ${period}`}
            description="Shared by EC2 CPU, Batch CPU and dedicated SageMaker compute. Include startup, idle time, retries and shutdown. Blank means always-on EC2/SageMaker; Batch stays unpriced.">
            <Input value={form.dedicatedInstanceHours} type="number"
              onChange={({ detail }) => onChange({ dedicatedInstanceHours: detail.value, scheduled: Boolean(detail.value.trim()) })} />
          </FormField>
          <ColumnLayout columns={2}>
            <FormField label="EC2 CPU supporting-service allowance (USD)" description={`For all ${period}; not per job. Leave unknown costs blank.`}>
              <Input value={form.cpuAdditionalCostUsd ?? ''} type="number"
                onChange={({ detail }) => onChange({ cpuAdditionalCostUsd: detail.value })} />
            </FormField>
            <FormField label="Batch CPU supporting-service allowance (USD)" description={`For all ${period}; not per job. Leave unknown costs blank.`}>
              <Input value={form.batchAdditionalCostUsd ?? ''} type="number"
                onChange={({ detail }) => onChange({ batchAdditionalCostUsd: detail.value })} />
            </FormField>
          </ColumnLayout>
          <FormField label="Allowance sources and included services" description="Account for EBS/S3, network/IP, logs and requests. Required to use either supplied allowance, including zero.">
            <Input value={form.cpuCostNotes ?? ''}
              onChange={({ detail }) => onChange({ cpuCostNotes: detail.value })} />
          </FormField>
          <Box variant="small">Equal allocated time is a costing assumption, not equal throughput. Validate that each configuration completes the planned volume. Update the comparison after editing.</Box>
        </SpaceBetween>
      </ExpandableSection>
    </SpaceBetween>
  </ExpandableSection>;
}
