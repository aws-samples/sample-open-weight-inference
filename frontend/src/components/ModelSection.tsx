import { BrandName } from './BrandName';
/**
 * Choosing a model, and what EDDIE could read about it.
 *
 * The shape of this screen is the point. A first-time user is asked for one thing
 * they know — where their model is — and EDDIE reads the rest. The technical
 * properties are still here, still editable, but collapsed and labelled with where
 * each value came from.
 *
 * Previously this block asked, at the top level and as apparently-required fields,
 * for an architecture class ("Required. Determines the CMI family"), a parameter
 * count, a context length, a weights size and a licence identifier — all prefilled
 * with Llama's numbers, with no way to tell a seeded example from an established
 * fact.
 */

import { useEffect, useState } from 'react';
import Alert from '@cloudscape-design/components/alert';
import Autosuggest from '@cloudscape-design/components/autosuggest';
import Badge from '@cloudscape-design/components/badge';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import ColumnLayout from '@cloudscape-design/components/column-layout';
import ExpandableSection from '@cloudscape-design/components/expandable-section';
import FormField from '@cloudscape-design/components/form-field';
import Input from '@cloudscape-design/components/input';
import Link from '@cloudscape-design/components/link';
import Select from '@cloudscape-design/components/select';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Spinner from '@cloudscape-design/components/spinner';
import {
  ORIGIN_COLOR,
  ORIGIN_HELP,
  ORIGIN_LABEL,
  fieldHelp,
  fieldLabel,
  type FieldOrigin,
} from '../copy/lexicon';
import {
  MODALITY_OPTIONS,
  MODEL_PRESETS,
  PRECISION_OPTIONS,
  VENDOR_API_ARCHITECTURE,
  type CaseFormState,
} from '../state/caseForm';
import {
  accessNeedsAction,
  originFor,
  type FieldOrigins,
  type InspectableField,
  type ModelInspectionResult,
} from '../state/modelInspection';

function option(value: string) {
  return { value, label: value };
}

/** A value's origin, as a badge with an explanation on hover. */
export function OriginBadge({ origin }: { origin: FieldOrigin }) {
  return (
    <span title={ORIGIN_HELP[origin]}>
      <Badge color={ORIGIN_COLOR[origin]}>{ORIGIN_LABEL[origin]}</Badge>
    </span>
  );
}

/**
 * What the inspection found, or why it did not.
 *
 * Access state is given its own alert rather than being folded into an error,
 * because a gated repository is not a failure: it is a specific action the user can
 * take, and saying "could not detect" would hide that.
 */
function InspectionSummary({
  inspection,
  error,
}: {
  inspection: ModelInspectionResult | null;
  error: Error | null;
}) {
  if (error) {
    return (
      <Alert
        type="error"
        statusIconAriaLabel="Error"
        header="Could not inspect this model"
        data-testid="inspect-error"
      >
        <SpaceBetween size="xs">
          <Box variant="span">{error.message}</Box>
          <Box variant="small" color="text-body-secondary">
            Nothing was recorded. You can enter the technical details yourself under
            Model details.
          </Box>
        </SpaceBetween>
      </Alert>
    );
  }
  if (!inspection) return null;

  if (!inspection.ok) {
    return (
      <Alert
        type="warning"
        statusIconAriaLabel="Warning"
        header="Nothing could be read from this source"
        data-testid="inspect-not-ok"
      >
        <SpaceBetween size="xs">
          <Box variant="span">{inspection.error}</Box>
          {inspection.accessDetail ? (
            <Box variant="small" color="text-body-secondary">
              {inspection.accessDetail}
            </Box>
          ) : null}
        </SpaceBetween>
      </Alert>
    );
  }

  const detected = Object.entries(inspection.fields).filter(
    ([, field]) => field.origin === 'DETECTED'
  );
  const undetected = Object.entries(inspection.fields).filter(
    ([, field]) => field.origin !== 'DETECTED'
  );

  return (
    <SpaceBetween size="xs">
      <SpaceBetween direction="horizontal" size="xs">
        <StatusIndicator type="success">
          <span data-testid="inspect-detected-count">
            Read {detected.length} of {detected.length + undetected.length}{' '}
            properties
          </span>
        </StatusIndicator>
        {inspection.revision ? (
          <Box variant="small" color="text-body-secondary">
            {/* The revision matters: these values describe this commit, and a
                later inspection of the same branch is a different one. */}
            revision{' '}
            <Box variant="code" fontSize="body-s">
              {inspection.revision.slice(0, 12)}
            </Box>
          </Box>
        ) : null}
      </SpaceBetween>

      {accessNeedsAction(inspection.access) ? (
        <Alert
          type="info"
          statusIconAriaLabel="Information"
          header={
            inspection.access === 'GATED'
              ? 'This model requires its terms to be accepted'
              : 'This model needs credentials'
          }
          data-testid="inspect-access"
        >
          <SpaceBetween size="xs">
            <Box variant="span">{inspection.accessDetail}</Box>
            <Box variant="small" color="text-body-secondary">
              <BrandName /> can still compare hosting options. Accepting the terms is a
              step you have to take before the weights can be downloaded, and it is
              not something a typed licence name satisfies.
            </Box>
          </SpaceBetween>
        </Alert>
      ) : null}

      {undetected.length > 0 ? (
        <ExpandableSection
          variant="footer"
          headerText={`${undetected.length} property could not be read`.replace(
            '1 property could',
            '1 property could'
          )}
        >
          <SpaceBetween size="xxs">
            {undetected.map(([name, field]) => (
              <Box key={name} variant="small" color="text-body-secondary">
                <b>{fieldLabel(name)}</b>: {field.detail}
              </Box>
            ))}
          </SpaceBetween>
        </ExpandableSection>
      ) : null}

      {inspection.notes.length > 0 ? (
        <SpaceBetween size="xxs">
          {inspection.notes.map((note) => (
            <Box key={note} variant="small" color="text-body-secondary">
              {note}
            </Box>
          ))}
        </SpaceBetween>
      ) : null}
    </SpaceBetween>
  );
}

/** Usage terms, replacing the bare "Licence identifier" text input. */
function UsageTerms({
  form,
  inspection,
  origin,
}: {
  form: CaseFormState;
  inspection: ModelInspectionResult | null;
  origin: FieldOrigin;
}) {
  const licence = form.licenseId.trim();
  return (
    <FormField
      label={fieldLabel('usageTerms')}
      description={fieldHelp('usageTerms')}
    >
      <SpaceBetween size="xs">
        <SpaceBetween direction="horizontal" size="xs">
          {licence === '' ? (
            <Box variant="span" color="text-status-inactive">
              Not established
            </Box>
          ) : (
            <Box variant="span" fontWeight="bold" data-testid="usage-terms-value">
              {licence}
            </Box>
          )}
          <OriginBadge origin={origin} />
        </SpaceBetween>
        {inspection?.ok && inspection.repo ? (
          <Box variant="small">
            <Link
              external
              externalIconAriaLabel="Opens in a new tab"
              href={`https://huggingface.co/${inspection.repo}`}
            >
              Read the terms on the model page
            </Link>
          </Box>
        ) : null}
        <Box variant="small" color="text-body-secondary">
          {/* The review was explicit that a typed identifier is neither
              verification nor acceptance. */}
          A licence name is a label, not permission. Whatever it says, the
          applicable terms have to be resolved before anything is deployed.
        </Box>
      </SpaceBetween>
    </FormField>
  );
}

/** One technical property: its value, its origin, and an editable override. */
function DetailField({
  name,
  form,
  origins,
  onChange,
  numeric,
  errorText,
}: {
  name: InspectableField;
  form: CaseFormState;
  origins: FieldOrigins;
  onChange: (patch: Partial<CaseFormState>) => void;
  numeric?: boolean;
  errorText?: string;
}) {
  const origin = originFor(name, form, origins);
  const notApplicable = origin === 'NOT_APPLICABLE';
  return (
    <FormField
      label={
        <SpaceBetween direction="horizontal" size="xs">
          <span>{fieldLabel(name)}</span>
          <OriginBadge origin={origin} />
        </SpaceBetween>
      }
      description={fieldHelp(name)}
      errorText={errorText}
    >
      <Input
        value={String(form[name] ?? '')}
        type={numeric ? 'number' : 'text'}
        inputMode={numeric ? 'decimal' : undefined}
        onChange={({ detail }) =>
          onChange({ [name]: detail.value } as Partial<CaseFormState>)
        }
        disabled={notApplicable}
        placeholder={
          notApplicable
            ? 'Not applicable to a hosted API'
            : 'Not detected — leave blank if you do not know'
        }
        data-testid={`detail-${name}`}
      />
    </FormField>
  );
}

export function ModelSection({
  form,
  onChange,
  onChangeModel,
  inspection,
  fieldOrigins,
  onInspect,
  inspecting,
  inspectError,
  issueFor,
}: {
  form: CaseFormState;
  onChange: (patch: Partial<CaseFormState>) => void;
  /** Switching model: clears everything derived from the previous one. */
  onChangeModel: (patch: Partial<CaseFormState>) => void;
  inspection: ModelInspectionResult | null;
  fieldOrigins: FieldOrigins;
  onInspect: (source: string) => void;
  inspecting: boolean;
  inspectError: Error | null;
  issueFor: (field: keyof CaseFormState) => string | undefined;
}) {
  const [source, setSource] = useState(form.hfRepo);
  useEffect(() => setSource(form.hfRepo), [form.hfRepo]);
  const apiOnly =
    !form.weightsExportable ||
    form.architecture.trim() === VENDOR_API_ARCHITECTURE;

  const preset = MODEL_PRESETS.find((item) => item.label === form.modelName);

  return (
    <ExpandableSection headerText="Your model" defaultExpanded variant="default">
      <SpaceBetween size="l">
        <FormField
          label="Which model do you want to use?"
          description="Pick a known model, or paste a Hugging Face link to any other."
        >
          <Autosuggest
            value={form.modelName}
            options={MODEL_PRESETS.map((item) => ({
              value: item.label,
              description: item.apiOnly
                ? "Hosted by its provider — no model files to deploy"
                : 'Open weights you can host',
            }))}
            enteredTextLabel={(value) => `Use "${value}"`}
            placeholder="Llama, Mistral, Qwen, ElevenLabs, Nova Sonic…"
            ariaLabel="Which model do you want to use?"
            empty="No match. Type a name, then paste its Hugging Face link below."
            onChange={({ detail }) => detail.value.trim() === '' ? onChangeModel({ modelName: '' }) : onChange({ modelName: detail.value })}
            onSelect={({ detail }) => {
              const chosen = MODEL_PRESETS.find(
                (item) => item.label === detail.value
              );
              if (chosen) {
                // A different model invalidates everything read from the last one.
                onChangeModel({ ...chosen.patch });
                setSource(chosen.patch.hfRepo);
              } else {
                onChangeModel({ modelName: detail.value });
                setSource('');
              }
            }}
          />
        </FormField>

        {preset && !preset.apiOnly && Object.values(fieldOrigins).some((origin) => origin === 'EXAMPLE') ? (
          <Box variant="small" color="text-body-secondary">
            These are example values for {preset.label}, not facts about your copy
            of it. Inspect the model to replace them with what its source
            publishes.
          </Box>
        ) : null}

        {!apiOnly ? (
          <FormField
            label={fieldLabel('modelSource')}
            description={fieldHelp('modelSource')}
            secondaryControl={
              <Button
                onClick={() => onInspect(source)}
                disabled={source.trim() === '' || inspecting}
                loading={inspecting}
                data-testid="inspect-model"
                iconName="search"
                // This section sits inside a Cloudscape Form, where a Button
                // defaults to submitting it. Without this, clicking Inspect also
                // ran a full placement evaluation -- against the model properties
                // as they were *before* the inspection returned.
                formAction="none"
              >
                Inspect model
              </Button>
            }
          >
            <Input
              value={source}
              onChange={({ detail }) => setSource(detail.value)}
              onKeyDown={(event) => {
                if (event.detail.key === 'Enter') {
                  event.preventDefault();
                  if (source.trim() !== '' && !inspecting) onInspect(source);
                }
              }}
              placeholder="mistralai/Mistral-7B-Instruct-v0.3"
              ariaLabel={fieldLabel('modelSource')}
              data-testid="model-source"
            />
          </FormField>
        ) : null}

        {inspecting ? (
          <Box data-testid="inspecting">
            <SpaceBetween direction="horizontal" size="xs">
              <Spinner />
              <Box variant="span" color="text-body-secondary">
                Reading the model's published details…
              </Box>
            </SpaceBetween>
          </Box>
        ) : (
          <InspectionSummary inspection={inspection} error={inspectError} />
        )}

        {apiOnly ? (
          <Alert
            type="info"
            statusIconAriaLabel="Information"
            header="This model is hosted by its provider"
            data-testid="api-only-note"
          >
            <SpaceBetween size="xs">
              <Box variant="span">
                {preset?.note ??
                  'There are no model files to deploy, so it cannot be hosted in your AWS account.'}
              </Box>
              <Box variant="span">
                Use the provider’s API for this model. In Models &amp; sources, you can select a native
                Bedrock model and compare Standard text token costs. Other vendor API pricing needs
                a supported connector. Response time stays unverified until it has been tested.
              </Box>
            </SpaceBetween>
          </Alert>
        ) : null}

        <ColumnLayout columns={2}>
          <FormField
            label={fieldLabel('modality')}
            description={fieldHelp('modality')}
          >
            <Select
              selectedOption={
                MODALITY_OPTIONS.find((o) => o.value === form.modality) ??
                option(form.modality)
              }
              options={MODALITY_OPTIONS.map((o) => ({ ...o }))}
              onChange={({ detail }) =>
                onChange({ modality: detail.selectedOption.value ?? form.modality })
              }
            />
          </FormField>
          <UsageTerms
            form={form}
            inspection={inspection}
            origin={originFor('licenseId', form, fieldOrigins)}
          />
        </ColumnLayout>

        {/*
          Collapsed by default. Everything in here is either detected or an expert
          override; a first-time user never has to open it, which is the acceptance
          criterion the review set.
        */}
        <ExpandableSection
          headerText="Model details"
          headerDescription="Technical properties read from the model. Override any of them if you know better."
          variant="footer"
          data-testid="model-details"
        >
          <SpaceBetween size="m">
            <ColumnLayout columns={2}>
              <DetailField
                name="architecture"
                form={form}
                origins={fieldOrigins}
                onChange={onChange}
                errorText={issueFor('architecture')}
              />
              <FormField
                label={
                  <SpaceBetween direction="horizontal" size="xs">
                    <span>{fieldLabel('precision')}</span>
                    <OriginBadge
                      origin={originFor('precision', form, fieldOrigins)}
                    />
                  </SpaceBetween>
                }
                description={fieldHelp('precision')}
              >
                <Select
                  selectedOption={option(form.precision)}
                  options={PRECISION_OPTIONS.map(option)}
                  onChange={({ detail }) =>
                    onChange({
                      precision: detail.selectedOption.value ?? form.precision,
                    })
                  }
                  disabled={apiOnly}
                />
              </FormField>
              <DetailField
                name="totalParamsB"
                form={form}
                origins={fieldOrigins}
                onChange={onChange}
                numeric
                errorText={issueFor('totalParamsB')}
              />
              <DetailField
                name="contextTokens"
                form={form}
                origins={fieldOrigins}
                onChange={onChange}
                numeric
                errorText={issueFor('contextTokens')}
              />
              <DetailField
                name="weightsGb"
                form={form}
                origins={fieldOrigins}
                onChange={onChange}
                numeric
                errorText={issueFor('weightsGb')}
              />
              <FormField
                label={fieldLabel('modelName')}
                errorText={issueFor('modelName')}
              >
                <Input
                  value={form.modelName}
                  onChange={({ detail }) => detail.value.trim() === '' ? onChangeModel({ modelName: '' }) : onChange({ modelName: detail.value })}
                />
              </FormField>
            </ColumnLayout>

            <Box variant="small" color="text-body-secondary">
              Leaving a value blank is fine. It stays unknown rather than becoming
              zero, and any option that needs it is reported as needing model
              information instead of being ranked on a guess.
            </Box>
          </SpaceBetween>
        </ExpandableSection>
      </SpaceBetween>
    </ExpandableSection>
  );
}

export default ModelSection;
