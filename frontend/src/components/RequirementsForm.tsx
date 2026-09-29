import { BrandName, brandText } from './BrandName';
import { useEffect, useMemo, useState } from 'react';
import Alert from '@cloudscape-design/components/alert';
import AttributeEditor from '@cloudscape-design/components/attribute-editor';
import Autosuggest from '@cloudscape-design/components/autosuggest';
import Multiselect from '@cloudscape-design/components/multiselect';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import ColumnLayout from '@cloudscape-design/components/column-layout';
import Container from '@cloudscape-design/components/container';
import ExpandableSection from '@cloudscape-design/components/expandable-section';
import Form from '@cloudscape-design/components/form';
import FormField from '@cloudscape-design/components/form-field';
import Header from '@cloudscape-design/components/header';
import Input from '@cloudscape-design/components/input';
import Select from '@cloudscape-design/components/select';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Textarea from '@cloudscape-design/components/textarea';
import Toggle from '@cloudscape-design/components/toggle';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import { METRIC_HELP, fieldHelp, fieldLabel, metricLabel } from '../copy/lexicon';
import {
  KNOWN_CANDIDATE_IDS,
  OPS_BURDEN_OPTIONS,
  SLO_METRIC_OPTIONS,
  WORKLOAD_PRESETS,
  emptyLatencyEntry,
  metricImpliedPercentile,
  formDutyPercent,
  hasEvidenceCaveat,
  validateForm,
  type CaseFormState,
  type LatencyEvidenceEntry,
} from '../state/caseForm';
import type { FieldOrigins, ModelInspectionResult } from '../state/modelInspection';
import { ModelSection } from './ModelSection';

function option(value: string) {
  return { label: value, value };
}

/**
 * Periods people actually describe, with the hour arithmetic done for them.
 *
 * Nobody thinks in hours. "A year" is 8760 and getting that wrong by a factor of ten
 * changes every cost on the screen, so the conversion belongs here rather than in the
 * user's head. The field stays typeable for an exact figure.
 */
const HORIZON_OPTIONS = [
  { value: '24', label: '24 — one day' },
  { value: '72', label: '72 — three days' },
  { value: '168', label: '168 — one week' },
  { value: '336', label: '336 — two weeks' },
  { value: '720', label: '720 — one month' },
  { value: '2160', label: '2160 — three months' },
  { value: '8760', label: '8760 — one year' },
];

/** Response-time targets in the range real applications ask for. */
const THRESHOLD_OPTIONS = [
  { value: '200', label: '200 ms — interactive typing' },
  { value: '500', label: '500 ms — conversational' },
  { value: '800', label: '800 ms — voice first audio' },
  { value: '1000', label: '1000 ms — one second' },
  { value: '2000', label: '2000 ms' },
  { value: '5000', label: '5000 ms — five seconds' },
  { value: '30000', label: '30000 ms — batch or long generation' },
];

/**
 * Regions EDDIE can evaluate.
 *
 * Bedrock Custom Model Import is not available everywhere, and the label says so, so a
 * residency choice that rules out an import path shows why before the gate does.
 */
const REGION_OPTIONS = [
  { value: 'us-east-1', label: 'us-east-1 — N. Virginia' },
  { value: 'us-east-2', label: 'us-east-2 — Ohio' },
  { value: 'us-west-2', label: 'us-west-2 — Oregon' },
  { value: 'eu-central-1', label: 'eu-central-1 — Frankfurt' },
  { value: 'eu-west-1', label: 'eu-west-1 — Ireland (no Bedrock import)' },
  { value: 'ap-southeast-1', label: 'ap-southeast-1 — Singapore (no Bedrock import)' },
  { value: 'ap-northeast-1', label: 'ap-northeast-1 — Tokyo (no Bedrock import)' },
];

/**
 * Serving-hour suggestions, derived from the horizon.
 *
 * The most consequential number in the whole form, and the least intuitive: it is
 * billable presence, not utilisation. Offering it as a share of the horizon makes the
 * relationship visible instead of leaving the user to multiply.
 */
function servingHourOptions(
  horizonHours: string
): { value: string; label: string }[] {
  const horizon = Number(horizonHours);
  if (!Number.isFinite(horizon) || horizon <= 0) {
    return [
      { value: '6', label: '6 hours' },
      { value: '24', label: '24 hours' },
    ];
  }
  const share = (fraction: number, label: string) => {
    const hours = Math.round(horizon * fraction);
    return { value: String(hours), label: `${hours} — ${label}` };
  };
  return [
    share(1, 'always on (100%)'),
    share(0.5, 'half the time (50%)'),
    share(0.25, 'a quarter of the time (25%)'),
    share(0.1, 'occasional bursts (10%)'),
    share(0.05, 'rare bursts (5%)'),
  ];
}

/** Options that carry a human label distinct from the wire value. */
type LabelledOption = { readonly value: string; readonly label: string };

/**
 * Select option for a labelled constant. The wire value is what the backend
 * validates against its enum; the label is only for the reader.
 */
function labelledOption(
  options: readonly LabelledOption[],
  value: string,
  fallbackLabel?: string
) {
  const found = options.find((item) => item.value === value);
  if (found) return { label: found.label, value: found.value };
  // An unrecognised value is shown verbatim rather than silently remapped.
  return { label: fallbackLabel ?? value, value };
}

export interface RequirementsFormProps {
  form: CaseFormState;
  onChange: (patch: Partial<CaseFormState>) => void;
  onSubmit: () => void;
  onReset: () => void;
  onApplyPreset: (presetId: string) => void;
  submitting: boolean;
  activePresetId: string | null;
  /* ------------------------------------------------- model inspection */
  /** Switching model, which invalidates everything read from the previous one. */
  changeModel: (patch: Partial<CaseFormState>) => void;
  inspection: ModelInspectionResult | null;
  fieldOrigins: FieldOrigins;
  onInspect: (source: string) => void;
  inspecting: boolean;
  inspectError: Error | null;
}

/**
 * Editable structured requirements. Every field maps to a documented field of
 * the `/evaluate` request; nothing here is decorative.
 */
export function RequirementsForm({
  form,
  onChange,
  onSubmit,
  onReset,
  onApplyPreset,
  submitting,
  activePresetId,
  changeModel,
  inspection,
  fieldOrigins,
  onInspect,
  inspecting,
  inspectError,
}: RequirementsFormProps) {
  const issues = useMemo(() => validateForm(form), [form]);
  const issueFor = (field: keyof CaseFormState) =>
    issues.find(
      (issue) => issue.field === field && issue.entryIndex === undefined
    )?.message;
  const entryIssue = (
    index: number,
    entryField: keyof LatencyEvidenceEntry
  ) =>
    issues.find(
      (issue) =>
        issue.entryIndex === index && issue.entryField === entryField
    )?.message;
  const duty = formDutyPercent(form);
  const activePreset = WORKLOAD_PRESETS.find(
    (preset) => preset.id === activePresetId
  );

  const patchEntry = (
    index: number,
    entryPatch: Partial<LatencyEvidenceEntry>
  ) =>
    onChange({
      latencyEvidence: form.latencyEvidence.map((entry, position) =>
        position === index ? { ...entry, ...entryPatch } : entry
      ),
    });

  // Open the evidence section whenever a caveat is active, so the warning and
  // the control that caused it are visible together. Applying a preset counts:
  // otherwise the stipulation it sets would be invisible in a collapsed
  // section. The user can still collapse it afterwards.
  const [evidenceExpanded, setEvidenceExpanded] = useState(() =>
    hasEvidenceCaveat(form)
  );
  useEffect(() => {
    if (hasEvidenceCaveat(form)) setEvidenceExpanded(true);
    // Keyed on the preset and the caveat flags rather than the whole form, so
    // ordinary typing does not re-open a section the user just closed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePresetId, form.assumeChecksCleared, form.provideLatencyEvidence]);

  return (
    <Container
      header={
        <Header
          variant="h2"
          description="Start with your model and expected usage. Technical details are optional."
        >
          Your workload
        </Header>
      }
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (issues.length === 0 && !submitting) onSubmit();
        }}
      >
        <Form
          actions={
            <SpaceBetween direction="horizontal" size="xs">
              <Button
                formAction="none"
                onClick={onReset}
                disabled={submitting}
                disabledReason={
                  submitting
                    ? 'An evaluation is in progress. Wait for it to finish before resetting.'
                    : undefined
                }
              >
                Reset to defaults
              </Button>
              <Button
                variant="primary"
                loading={submitting}
                loadingText="Comparing options"
                disabled={issues.length > 0}
                disabledReason={
                  issues.length > 0
                    ? `Fix ${issues.length} invalid field${
                        issues.length === 1 ? '' : 's'
                      } before evaluating.`
                    : undefined
                }
                formAction="submit"
              >
                Compare hosting options
              </Button>
            </SpaceBetween>
          }
          errorText={
            issues.length > 0
              ? `${issues.length} field${
                  issues.length === 1 ? '' : 's'
                } need attention before this request can be evaluated.`
              : undefined
          }
        >
          <SpaceBetween size="l">

            <ModelSection
              form={form}
              onChange={onChange}
              onChangeModel={changeModel}
              inspection={inspection}
              fieldOrigins={fieldOrigins}
              onInspect={onInspect}
              inspecting={inspecting}
              inspectError={inspectError}
              issueFor={issueFor}
            />


            <ExpandableSection headerText="Usage" defaultExpanded>
              <SpaceBetween size="m">
            <FormField
              label="Choose a usage pattern"
              description="A shortcut for usage hours. Your model, budget and speed target stay the same."
            >
              <SpaceBetween size="xs">
                <SpaceBetween direction="horizontal" size="xs">
                  {WORKLOAD_PRESETS.map((preset) => (
                    <Button
                      key={preset.id}
                      formAction="none"
                      variant={
                        activePresetId === preset.id ? 'primary' : 'normal'
                      }
                      onClick={() => onApplyPreset(preset.id)}
                      disabled={submitting}
                      disabledReason={
                        submitting
                          ? 'An evaluation is in progress.'
                          : undefined
                      }
                    >
                      {preset.label}
                    </Button>
                  ))}
                </SpaceBetween>
                <Box variant="small" color="text-body-secondary">
                  {activePreset?.description ??
                    'Choose a starting point, or enter your own usage below.'}
                </Box>
                {duty === null ? (
                  <StatusIndicator type="info">
                    Enter usage hours to compare running patterns
                  </StatusIndicator>
                ) : (
                  <StatusIndicator type="info">
                    Active for an estimated {duty.toFixed(2)}% of this period
                  </StatusIndicator>
                )}
              </SpaceBetween>
            </FormField>

                <ColumnLayout columns={2}>
                  {/*
                    Autosuggest rather than a bare number box.
                    *
                    Both of these are hours, and nobody thinks in hours: "a year" is 8760
                    and "always on" means the two fields are equal. The options carry the
                    arithmetic and the field stays typeable, so an expert can still enter
                    an exact figure.
                  */}
                  <FormField
                    label={fieldLabel('horizonHours')}
                    description={fieldHelp('horizonHours')}
                    constraintText="In hours. Pick a period or type an exact number."
                    errorText={issueFor('horizonHours')}
                  >
                    <Autosuggest
                      value={form.horizonHours}
                      options={HORIZON_OPTIONS}
                      enteredTextLabel={(value) => `Use ${value} hours`}
                      placeholder="e.g. 8760"
                      ariaLabel={fieldLabel('horizonHours')}
                      empty="Type a number of hours."
                      onChange={({ detail }) =>
                        onChange({ horizonHours: detail.value })
                      }
                    />
                  </FormField>
                  <FormField
                    label={fieldLabel('billableCopyHours')}
                    description={fieldHelp('billableCopyHours')}
                    constraintText={
                      form.horizonHours.trim() !== ''
                        ? `Equal to ${form.horizonHours} for an always-on service.`
                        : 'Hours a copy must be present and ready.'
                    }
                    errorText={issueFor('billableCopyHours')}
                    secondaryControl={
                      form.horizonHours.trim() !== '' ? (
                        <Button
                          formAction="none"
                          onClick={() =>
                            onChange({ billableCopyHours: form.horizonHours })
                          }
                          data-testid="always-on"
                        >
                          Always on
                        </Button>
                      ) : undefined
                    }
                  >
                    <Autosuggest
                      value={form.billableCopyHours}
                      options={servingHourOptions(form.horizonHours)}
                      enteredTextLabel={(value) => `Use ${value} hours`}
                      placeholder="e.g. 6"
                      ariaLabel={fieldLabel('billableCopyHours')}
                      empty="Type a number of hours."
                      onChange={({ detail }) =>
                        onChange({ billableCopyHours: detail.value })
                      }
                    />
                  </FormField>
                  <FormField
                    label="Requests running at once"
                    description="Peak simultaneous requests, not the total number of users."
                    errorText={issueFor('concurrency')}
                  >
                    <Input
                      type="number"
                      inputMode="numeric"
                      value={form.concurrency}
                      onChange={({ detail }) =>
                        onChange({ concurrency: detail.value })
                      }
                      ariaLabel="Concurrency"
                      placeholder="Optional"
                    />
                  </FormField>
                </ColumnLayout>
                <ExpandableSection headerText="Advanced scheduling (optional)">
                  <SpaceBetween size="m">
                  <FormField
                    label="Dedicated instance hours"
                    description={brandText("Optional override for dedicated GPU billing. Otherwise EDDIE uses the comparison period.")}
                    errorText={issueFor('dedicatedInstanceHours')}
                  >
                    <Input
                      type="number"
                      inputMode="decimal"
                      value={form.dedicatedInstanceHours}
                      onChange={({ detail }) =>
                        onChange({ dedicatedInstanceHours: detail.value })
                      }
                      ariaLabel="Dedicated instance hours"
                      placeholder="Optional"
                    />
                  </FormField>
                <Toggle
                  checked={form.scheduled}
                  onChange={({ detail }) => onChange({ scheduled: detail.checked })}
                  description="You can plan startup and shutdown around known operating hours."
                >
                  Workload runs on a known schedule
                </Toggle>
                  </SpaceBetween>
                </ExpandableSection>
                <FormField label="What are you building?" description="A short description to keep this comparison in context.">
                  <Textarea
                    rows={2}
                    value={form.description}
                    onChange={({ detail }) =>
                      onChange({ description: detail.value })
                    }
                    ariaLabel="Workload description"
                  />
                </FormField>
              </SpaceBetween>
            </ExpandableSection>

            <ExpandableSection
              headerText="Response time"
              defaultExpanded
            >
              <SpaceBetween size="m">
                <Toggle
                  checked={form.provideSlo}
                  onChange={({ detail }) => onChange({ provideSlo: detail.checked })}
                  description="Keep this on when your application has a speed requirement."
                >
                  Set a response-time target
                </Toggle>

                {!form.provideSlo ? (
                  <Box variant="small" color="text-body-secondary">
                    Cost comparison only. No response-time requirement will be checked.
                  </Box>
                ) : (
                  <>
                    <ColumnLayout columns={2}>
                      <FormField
                        label="What has to be fast?"
                        description={METRIC_HELP[form.sloMetric]}
                      >
                        <Select
                          // Plain labels, wire values unchanged: the first token,
                          // the first audio frame and the completed answer are
                          // different requirements and must stay distinguishable.
                          selectedOption={{
                            value: form.sloMetric,
                            label: metricLabel(form.sloMetric),
                          }}
                          options={SLO_METRIC_OPTIONS.map((value) => ({
                            value,
                            label: metricLabel(value),
                            description: METRIC_HELP[value],
                          }))}
                          onChange={({ detail }) => {
                            const metric =
                              detail.selectedOption.value ?? form.sloMetric;
                            // The percentile follows the metric. Leaving it at 99
                            // while switching to p50 produced a request the backend
                            // rejects as self-contradictory.
                            const implied = metricImpliedPercentile(metric);
                            onChange({
                              sloMetric: metric,
                              ...(implied !== null
                                ? { sloPercentile: implied }
                                : {}),
                            });
                          }}
                          ariaLabel="What has to be fast?"
                        />
                      </FormField>
                      <FormField
                        label="Target (milliseconds)"
                        description="1000 milliseconds = 1 second."
                        errorText={issueFor('sloThresholdMs')}
                      >
                        <Autosuggest
                          value={form.sloThresholdMs}
                          options={THRESHOLD_OPTIONS}
                          enteredTextLabel={(value) => `Use ${value} ms`}
                          placeholder="e.g. 800"
                          ariaLabel="Response-time target in milliseconds"
                          empty="Type a number of milliseconds."
                          onChange={({ detail }) =>
                            onChange({ sloThresholdMs: detail.value })
                          }
                        />
                      </FormField>
                    </ColumnLayout>
                    <Toggle
                      checked={form.sloIncludeCold}
                      onChange={({ detail }) =>
                        onChange({ sloIncludeCold: detail.checked })
                      }
                      description="Include startup delays after quiet periods. Keeping a model warm does not guarantee that every request will be warm."
                    >
                      Count the first request after idle
                    </Toggle>
                    <Box variant="small" color="text-body-secondary" data-testid="needs-measurement-note">
                      <BrandName /> needs benchmark results before it can confirm this target.
                    </Box>
                    <ExpandableSection headerText="Advanced response-time settings">
                      <ColumnLayout columns={2}>
                      <FormField
                        label="Percentile"
                        description={
                          metricImpliedPercentile(form.sloMetric) !== null
                            ? 'Set by the metric above. Choose a different metric to change it.'
                            : 'Optional. This objective names no percentile of its own.'
                        }
                        errorText={issueFor('sloPercentile')}
                      >
                        <Input
                          type="number"
                          inputMode="decimal"
                          value={form.sloPercentile}
                          onChange={({ detail }) =>
                            onChange({ sloPercentile: detail.value })
                          }
                          ariaLabel="SLO percentile"
                          // Read-only rather than free: the metric is the single
                          // source of truth for the percentile it names.
                          disabled={metricImpliedPercentile(form.sloMetric) !== null}
                        />
                      </FormField>
                      <FormField
                        label="Error budget fraction"
                        errorText={issueFor('sloErrorBudgetFraction')}
                      >
                        <Input
                          type="number"
                          inputMode="decimal"
                          value={form.sloErrorBudgetFraction}
                          onChange={({ detail }) =>
                            onChange({ sloErrorBudgetFraction: detail.value })
                          }
                          ariaLabel="Error budget fraction"
                          placeholder="Optional"
                        />
                      </FormField>
                      </ColumnLayout>
                    </ExpandableSection>
                  </>
                )}
              </SpaceBetween>
            </ExpandableSection>

            <ExpandableSection headerText="Region and budget">
              <SpaceBetween size="m">
                <FormField
                  label={fieldLabel('permittedRegions')}
                  description={fieldHelp('permittedRegions')}
                  constraintText={brandText("EDDIE must respect your data-location requirements.")}
                  errorText={issueFor('permittedRegions')}
                >
                  {/*
                    A multiselect rather than a comma-separated string. Residency is a
                    hard gate, so a typo silently narrowed or widened it -- "us-east1"
                    matched nothing and read as no constraint at all.
                  */}
                  <Multiselect
                    selectedOptions={form.permittedRegions
                      .split(',')
                      .map((region) => region.trim())
                      .filter((region) => region !== '')
                      .map((region) => ({
                        value: region,
                        label:
                          REGION_OPTIONS.find((item) => item.value === region)
                            ?.label ?? region,
                      }))}
                    options={REGION_OPTIONS}
                    onChange={({ detail }) =>
                      onChange({
                        permittedRegions: detail.selectedOptions
                          .map((option) => option.value ?? '')
                          .filter((value) => value !== '')
                          .join(','),
                      })
                    }
                  placeholder="Any supported Region"
                    filteringType="auto"
                    tokenLimit={4}
                  />
                </FormField>
                <ColumnLayout columns={2}>
                  <FormField
                    label={fieldLabel('budgetUsd')}
                    description="Leave blank for no budget limit."
                    errorText={issueFor('budgetUsd')}
                  >
                    <Input
                      type="number"
                      inputMode="decimal"
                      value={form.budgetUsd}
                      onChange={({ detail }) =>
                        onChange({ budgetUsd: detail.value })
                      }
                      ariaLabel="Budget in US dollars"
                      placeholder="Optional"
                    />
                  </FormField>
                  <FormField
                    label="What will your team manage?"
                    description="Choose how much infrastructure your team is willing to operate."
                  >
                    <Select
                      selectedOption={
                        form.maxOpsBurden.trim() === ''
                          ? { label: 'No ceiling', value: '' }
                          : labelledOption(
                              OPS_BURDEN_OPTIONS,
                              form.maxOpsBurden
                            )
                      }
                      options={[
                        { label: 'No ceiling', value: '' },
                        ...OPS_BURDEN_OPTIONS.map((item) => ({
                          label: item.label,
                          value: item.value,
                        })),
                      ]}
                      onChange={({ detail }) =>
                        onChange({
                          maxOpsBurden: detail.selectedOption.value ?? '',
                        })
                      }
                      ariaLabel="Maximum ops burden"
                    />
                  </FormField>
                </ColumnLayout>
                <Toggle
                  checked={form.requireHeldCapacity}
                  onChange={({ detail }) =>
                    onChange({ requireHeldCapacity: detail.checked })
                  }
                  description="Require evidence of reserved or already allocated capacity."
                >
                  Require held capacity
                </Toggle>
              </SpaceBetween>
            </ExpandableSection>

            <ExpandableSection
              headerText="Advanced evidence and assumptions"
              // Controlled so a preset that turns on a stipulation also opens
              // the section: the warning and its cause must be visible
              // together, never a caveat whose control is hidden.
              expanded={evidenceExpanded}
              onChange={({ detail }) => setEvidenceExpanded(detail.expanded)}
              headerActions={
                !evidenceExpanded && hasEvidenceCaveat(form) ? (
                  <StatusIndicator type="warning">
                    Assumptions or supplied results in use
                  </StatusIndicator>
                ) : undefined
              }
            >
              <SpaceBetween size="m">
                <Toggle
                  checked={form.assumeChecksCleared}
                  onChange={({ detail }) =>
                    onChange({ assumeChecksCleared: detail.checked })
                  }
                  description="For a hypothetical estimate only. This does not verify your account or allow deployment."
                >
                  Assume account and deployment checks pass
                </Toggle>

                {!form.assumeChecksCleared ? (
                  <Box variant="small" color="text-body-secondary">
                    <BrandName /> will keep options unverified until their licence, account
                    access and available capacity have been checked.
                  </Box>
                ) : null}

                <Toggle
                  checked={form.provideLatencyEvidence}
                  onChange={({ detail }) =>
                    onChange({
                      provideLatencyEvidence: detail.checked,
                      // Opening the toggle with nothing to fill in is a dead
                      // end, so seed one row.
                      latencyEvidence:
                        detail.checked && form.latencyEvidence.length === 0
                          ? [emptyLatencyEntry(KNOWN_CANDIDATE_IDS[0])]
                          : form.latencyEvidence,
                    })
                  }
                  description={brandText("Supplied evidence is labelled SUPPLIED. EDDIE does not present it as its own measurement.")}
                >
                  Supply latency evidence for a candidate
                </Toggle>

                {form.provideLatencyEvidence ? (
                  <>
                    <Alert type="info" statusIconAriaLabel="Information">
                      These figures are attributed to you, not measured by{' '}
                      <BrandName />. Evidence is only applied to a candidate whose id
                      matches exactly.
                    </Alert>
                    <AttributeEditor<LatencyEvidenceEntry>
                      items={form.latencyEvidence}
                      addButtonText="Add evidence for another candidate"
                      removeButtonText="Remove"
                      removeButtonAriaLabel={(item) =>
                        `Remove latency evidence for ${
                          item.candidateId || 'this candidate'
                        }`
                      }
                      onAddButtonClick={() =>
                        onChange({
                          latencyEvidence: [
                            ...form.latencyEvidence,
                            emptyLatencyEntry(),
                          ],
                        })
                      }
                      onRemoveButtonClick={({ detail }) =>
                        onChange({
                          latencyEvidence: form.latencyEvidence.filter(
                            (_entry, index) => index !== detail.itemIndex
                          ),
                        })
                      }
                      empty="No evidence records. Add one, or turn the toggle off."
                      definition={[
                        {
                          label: 'Candidate ID',
                          errorText: (_item, index) =>
                            entryIssue(index, 'candidateId'),
                          control: (item, index) => (
                            <Autosuggest
                              value={item.candidateId}
                              options={KNOWN_CANDIDATE_IDS.map(option)}
                              enteredTextLabel={(value) => `Use "${value}"`}
                              placeholder="e.g. cmi-scale-to-zero"
                              ariaLabel={`Candidate ID for evidence record ${
                                index + 1
                              }`}
                              onChange={({ detail }) =>
                                patchEntry(index, { candidateId: detail.value })
                              }
                            />
                          ),
                        },
                        {
                          label: 'p50 (ms)',
                          errorText: (_item, index) => entryIssue(index, 'p50Ms'),
                          control: (item, index) => (
                            <Input
                              type="number"
                              inputMode="decimal"
                              value={item.p50Ms}
                              ariaLabel={`p50 latency for evidence record ${
                                index + 1
                              }`}
                              onChange={({ detail }) =>
                                patchEntry(index, { p50Ms: detail.value })
                              }
                            />
                          ),
                        },
                        {
                          label: 'p99 (ms)',
                          errorText: (_item, index) => entryIssue(index, 'p99Ms'),
                          control: (item, index) => (
                            <Input
                              type="number"
                              inputMode="decimal"
                              value={item.p99Ms}
                              ariaLabel={`p99 latency for evidence record ${
                                index + 1
                              }`}
                              onChange={({ detail }) =>
                                patchEntry(index, { p99Ms: detail.value })
                              }
                            />
                          ),
                        },
                        {
                          label: 'Cold start (ms)',
                          constraintText:
                            'Counts against the objective when cold requests are included.',
                          errorText: (_item, index) =>
                            entryIssue(index, 'coldStartMs'),
                          control: (item, index) => (
                            <Input
                              type="number"
                              inputMode="decimal"
                              value={item.coldStartMs}
                              ariaLabel={`Cold start for evidence record ${
                                index + 1
                              }`}
                              onChange={({ detail }) =>
                                patchEntry(index, { coldStartMs: detail.value })
                              }
                            />
                          ),
                        },
                        {
                          label: 'Sample count',
                          errorText: (_item, index) =>
                            entryIssue(index, 'sampleCount'),
                          control: (item, index) => (
                            <Input
                              type="number"
                              inputMode="numeric"
                              value={item.sampleCount}
                              ariaLabel={`Sample count for evidence record ${
                                index + 1
                              }`}
                              onChange={({ detail }) =>
                                patchEntry(index, { sampleCount: detail.value })
                              }
                            />
                          ),
                        },
                        {
                          label: 'Violation rate bound',
                          errorText: (_item, index) =>
                            entryIssue(index, 'violationRateUpperBound'),
                          control: (item, index) => (
                            <Input
                              type="number"
                              inputMode="decimal"
                              value={item.violationRateUpperBound}
                              ariaLabel={`Violation rate upper bound for evidence record ${
                                index + 1
                              }`}
                              onChange={({ detail }) =>
                                patchEntry(index, {
                                  violationRateUpperBound: detail.value,
                                })
                              }
                            />
                          ),
                        },
                      ]}
                    />
                    {issueFor('latencyEvidence') ? (
                      <Alert type="error" statusIconAriaLabel="Error">
                        {issueFor('latencyEvidence')}
                      </Alert>
                    ) : null}
                  </>
                ) : null}
              </SpaceBetween>
            </ExpandableSection>
            <ExpandableSection
              headerText="Technical identifiers"
              headerDescription="For support and diagnostics. Nothing here changes a recommendation."
              variant="footer"
            >
              {/*
                Case ID was at the top of the form under "Identifies this case in the
                backend" -- a backend identifier presented as the second thing a user is
                asked for. It is still editable, in the section where identifiers belong.
              */}
              <FormField
                label="Case ID"
                description="How this case is recorded. Change it only if you have a reason to."
                errorText={issueFor('caseId')}
              >
                <Input
                  value={form.caseId}
                  onChange={({ detail }) => onChange({ caseId: detail.value })}
                  ariaLabel="Case ID"
                />
              </FormField>
            </ExpandableSection>

          </SpaceBetween>
        </Form>
      </form>
    </Container>
  );
}
