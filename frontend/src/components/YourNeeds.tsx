import { BrandName } from './BrandName';
import Badge from '@cloudscape-design/components/badge';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import SpaceBetween from '@cloudscape-design/components/space-between';
import { metricLabel } from '../copy/lexicon';
import { metricImpliedPercentile, type CaseFormState } from '../state/caseForm';

/**
 * The few consequential facts, in one line, with a way to correct them.
 *
 * UXR-03. The previous design put a full requirements form beside the conversation, so
 * the screen asked for architecture classes and billing units before anything useful
 * had happened. This shows only what actually changes the answer, in the user's own
 * terms, and opens the editor when they want to change something.
 *
 * Deliberately absent: case id, solver version, request hash, precision, weight size,
 * parameter count. Those are model details or technical identifiers and belong in the
 * contextual panels.
 */

/** A short, plain rendering of one fact, or null when it is not set. */
function facts(form: CaseFormState): { label: string; value: string }[] {
  const out: { label: string; value: string }[] = [];

  if (form.modelName.trim() !== '') {
    out.push({ label: 'Model', value: form.modelName.trim() });
  }

  const horizon = Number(form.horizonHours);
  if (Number.isFinite(horizon) && horizon > 0) {
    // Hours are how the solver thinks; days are how people describe an event.
    const value =
      horizon >= 168
        ? `${Math.round(horizon / 168)} week${horizon >= 336 ? 's' : ''}`
        : horizon >= 24
          ? `${Math.round(horizon / 24)} day${horizon >= 48 ? 's' : ''}`
          : `${horizon} hour${horizon === 1 ? '' : 's'}`;
    out.push({ label: 'Over', value });
  }

  const billable = Number(form.billableCopyHours);
  if (Number.isFinite(billable) && form.billableCopyHours.trim() !== '') {
    out.push({
      label: 'Serving for',
      value: `${billable} hour${billable === 1 ? '' : 's'}`,
    });
  }

  if (form.provideSlo && form.sloThresholdMs.trim() !== '') {
    const percentile = metricImpliedPercentile(form.sloMetric);
    out.push({
      label: metricLabel(form.sloMetric),
      value:
        `under ${form.sloThresholdMs} ms` +
        (percentile ? ` for ${percentile}% of requests` : '') +
        // Cold policy is part of the requirement, so it is shown rather than buried.
        (form.sloIncludeCold ? ', including after idle' : ', warm requests only'),
    });
  }

  if (form.budgetUsd.trim() !== '') {
    out.push({ label: 'Budget', value: `$${form.budgetUsd}` });
  }

  const regions = form.permittedRegions
    .split(',')
    .map((region) => region.trim())
    .filter((region) => region !== '');
  if (regions.length > 0) {
    out.push({ label: 'In', value: regions.join(', ') });
  }

  if (form.concurrency.trim() !== '') {
    out.push({ label: 'At once', value: `${form.concurrency} requests` });
  }

  return out;
}

export function YourNeeds({
  form,
  onEdit,
  outdatedFields = [],
}: {
  form: CaseFormState;
  onEdit: () => void;
  /** Non-empty when a change has invalidated the current result. */
  outdatedFields?: string[];
}) {
  const items = facts(form);

  if (items.length === 0) {
    return (
      <Box variant="small" color="text-body-secondary" data-testid="your-needs-empty">
        Tell <BrandName /> what you are building and it will summarise what it understands
        here.
      </Box>
    );
  }

  return (
    <Box data-testid="your-needs">
      <SpaceBetween size="xxs">
        <SpaceBetween direction="horizontal" size="xs" alignItems="center">
          <Box variant="awsui-key-label">Your project</Box>
          <Button variant="inline-link" onClick={onEdit} data-testid="edit-needs">
            Edit
          </Button>
          {outdatedFields.length > 0 ? (
            <Badge color="blue">Changed — results need updating</Badge>
          ) : null}
        </SpaceBetween>
        <SpaceBetween direction="horizontal" size="xs">
          {items.map((item) => (
            <Box key={item.label} variant="small" color="text-body-secondary">
              <b>{item.label}:</b> {item.value}
            </Box>
          ))}
        </SpaceBetween>
      </SpaceBetween>
    </Box>
  );
}

export default YourNeeds;
