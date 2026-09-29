import Box from '@cloudscape-design/components/box';
import ColumnLayout from '@cloudscape-design/components/column-layout';
import Container from '@cloudscape-design/components/container';
import FormField from '@cloudscape-design/components/form-field';
import Header from '@cloudscape-design/components/header';
import Input from '@cloudscape-design/components/input';
import SpaceBetween from '@cloudscape-design/components/space-between';
import type { CaseFormState } from '../state/caseForm';
import { comparisonPeriod } from './HostingComparison';

/** These values are user estimates. No model guesses traffic or token counts. */
export function NativeUsageInputs({ form, onChange }: {
  form: CaseFormState;
  onChange: (patch: Partial<CaseFormState>) => void;
}) {
  return <Container
    header={<Header variant="h3" description="Bedrock charges for the text processed. Enter estimates to calculate a total, or leave these blank to see the rates.">Usage for the API estimate</Header>}
    data-testid="native-usage"
  >
    <SpaceBetween size="m">
      <ColumnLayout columns={3}>
        <FormField label={`Requests in ${comparisonPeriod(form.horizonHours)}`}>
          <Input value={form.requests ?? ''} type="number"
            onChange={({ detail }) => onChange({ requests: detail.value })}
            ariaLabel="API requests during comparison period" placeholder="For example: 30000" />
        </FormField>
        <FormField label="Average input tokens per request" description="Include instructions, conversation history and documents.">
          <Input value={form.inputTokensPerRequest ?? ''} type="number"
            onChange={({ detail }) => onChange({ inputTokensPerRequest: detail.value })}
            ariaLabel="API average input tokens" placeholder="For example: 1000" />
        </FormField>
        <FormField label="Average output tokens per request" description="The generated answer, including any billable reasoning tokens.">
          <Input value={form.outputTokensPerRequest ?? ''} type="number"
            onChange={({ detail }) => onChange({ outputTokensPerRequest: detail.value })}
            ariaLabel="API average output tokens" placeholder="For example: 250" />
        </FormField>
      </ColumnLayout>
      <Box variant="small" color="text-body-secondary">
        Tokens are the pieces of text a model processes. Exact counts vary by model and language.
        These are planning estimates; a test with representative requests can establish actual usage.
        Update the comparison after editing.
      </Box>
    </SpaceBetween>
  </Container>;
}
