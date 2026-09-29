import { brandText } from '../components/BrandName';
import { useState } from 'react';
import Alert from '@cloudscape-design/components/alert';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import ColumnLayout from '@cloudscape-design/components/column-layout';
import Container from '@cloudscape-design/components/container';
import ContentLayout from '@cloudscape-design/components/content-layout';
import FormField from '@cloudscape-design/components/form-field';
import Header from '@cloudscape-design/components/header';
import Input from '@cloudscape-design/components/input';
import KeyValuePairs from '@cloudscape-design/components/key-value-pairs';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Spinner from '@cloudscape-design/components/spinner';
import Table from '@cloudscape-design/components/table';
import type { Rate, RatesResponse } from '../api/types';
import { FreshnessBadge } from '../components/EvidenceBadge';
import { UNKNOWN_LABEL, formatTimestamp } from '../components/format';
import { useApp } from '../state/AppContext';
import { useAsync } from '../state/useAsync';

interface RateRow {
  id: string;
  family: string;
  rate: Rate | null;
}

const DEFAULT_INSTANCE_TYPE = 'ml.g5.2xlarge';
const DEFAULT_ARCHITECTURE = 'LlamaForCausalLM';

/** Current price evidence: SKU, unit, effective date, source, freshness. */
export function RatesPage() {
  const { client } = useApp();
  const [instanceType, setInstanceType] = useState(DEFAULT_INSTANCE_TYPE);
  const [architecture, setArchitecture] = useState(DEFAULT_ARCHITECTURE);
  const [query, setQuery] = useState({
    instanceType: DEFAULT_INSTANCE_TYPE,
    architecture: DEFAULT_ARCHITECTURE,
  });

  const rates = useAsync<RatesResponse>(
    (signal) => client.rates(query, signal),
    [client, query.instanceType, query.architecture]
  );

  const data = rates.data;

  const rows: RateRow[] = data
    ? [
        {
          id: 'sagemakerInstanceHour',
          family: 'SageMaker instance hour',
          rate: data.rates.sagemakerInstanceHour,
        },
        {
          id: 'cmiPerCmuMinute',
          family: 'Bedrock CMI per CMU-minute',
          rate: data.rates.cmiPerCmuMinute,
        },
        {
          id: 'cmiPerCmuMonth',
          family: 'Bedrock CMI per CMU-month',
          rate: data.rates.cmiPerCmuMonth,
        },
      ]
    : [];

  const freshnessEntries = Object.entries(data?.freshness ?? {});

  return (
    <ContentLayout
      header={
        <Header
          variant="h1"
          description={brandText("The price evidence behind every cost figure EDDIE produces. A pinned rate is labelled as pinned; it is not presented as a live price.")}
          actions={
            <Button
              iconName="refresh"
              onClick={rates.reload}
              loading={rates.loading}
              ariaLabel="Reload rates"
            >
              Reload
            </Button>
          }
        >
          Price evidence
        </Header>
      }
    >
      <SpaceBetween size="l">
        <Container
          header={
            <Header
              variant="h2"
              description="Rates depend on the instance type and the model architecture that determines the CMI family."
            >
              Query
            </Header>
          }
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              setQuery({ instanceType, architecture });
            }}
          >
            <SpaceBetween size="m">
              <ColumnLayout columns={2}>
                <FormField
                  label="Instance type"
                  description="SageMaker ML instance type."
                >
                  <Input
                    value={instanceType}
                    onChange={({ detail }) => setInstanceType(detail.value)}
                    ariaLabel="Instance type"
                  />
                </FormField>
                <FormField
                  label="Architecture"
                  description="Model architecture class, used to resolve the CMI family."
                >
                  <Input
                    value={architecture}
                    onChange={({ detail }) => setArchitecture(detail.value)}
                    ariaLabel="Architecture"
                  />
                </FormField>
              </ColumnLayout>
              <SpaceBetween direction="horizontal" size="xs">
                <Button
                  variant="primary"
                  loading={rates.loading}
                  loadingText="Retrieving rates"
                  disabled={
                    instanceType.trim() === '' || architecture.trim() === ''
                  }
                  disabledReason={
                    instanceType.trim() === '' || architecture.trim() === ''
                      ? 'Both an instance type and an architecture are required.'
                      : undefined
                  }
                  onClick={() => setQuery({ instanceType, architecture })}
                >
                  Retrieve rates
                </Button>
                <Button
                  formAction="none"
                  onClick={() => {
                    setInstanceType(DEFAULT_INSTANCE_TYPE);
                    setArchitecture(DEFAULT_ARCHITECTURE);
                    setQuery({
                      instanceType: DEFAULT_INSTANCE_TYPE,
                      architecture: DEFAULT_ARCHITECTURE,
                    });
                  }}
                >
                  Reset
                </Button>
              </SpaceBetween>
            </SpaceBetween>
          </form>
        </Container>

        {rates.error ? (
          <Alert
            type="error"
            statusIconAriaLabel="Error"
            header="Could not retrieve price evidence"
            action={
              <Button onClick={rates.reload} iconName="refresh">
                Retry
              </Button>
            }
          >
            {rates.error.message}
          </Alert>
        ) : null}

        <Container
          header={
            <Header variant="h2" description="Freshness per rate family.">
              Snapshot
            </Header>
          }
        >
          {rates.loading && !data ? (
            <Box textAlign="center" padding={{ vertical: 'l' }}>
              <SpaceBetween size="s">
                <Spinner size="large" />
                <Box variant="p">Retrieving price evidence.</Box>
              </SpaceBetween>
            </Box>
          ) : !data ? (
            <Box
              textAlign="center"
              color="text-body-secondary"
              padding={{ vertical: 'l' }}
            >
              <SpaceBetween size="xxs">
                <b>No price snapshot</b>
                <Box variant="small">
                  Retrieve rates above, or retry if the request failed.
                </Box>
              </SpaceBetween>
            </Box>
          ) : (
            <SpaceBetween size="m">
              <KeyValuePairs
                columns={4}
                items={[
                  { label: 'Region', value: data.region || UNKNOWN_LABEL },
                  {
                    label: 'Retrieved at',
                    value: formatTimestamp(data.retrievedAt),
                  },
                  { label: 'CMI family', value: data.cmiFamily ?? UNKNOWN_LABEL },
                  {
                    label: 'CMU version',
                    value: data.cmuVersion ?? UNKNOWN_LABEL,
                  },
                ]}
              />
              {freshnessEntries.length === 0 ? (
                <Alert type="warning" statusIconAriaLabel="Warning">
                  The response carried no freshness information, so these rates
                  cannot be attributed to a live or pinned price list.
                </Alert>
              ) : (
                <SpaceBetween direction="horizontal" size="s">
                  {freshnessEntries.map(([family, freshness]) => (
                    <FreshnessBadge
                      key={family}
                      freshness={freshness}
                      label={family}
                    />
                  ))}
                </SpaceBetween>
              )}
            </SpaceBetween>
          )}
        </Container>

        <Table<RateRow>
          variant="container"
          loading={rates.loading && !data}
          loadingText="Retrieving rates"
          items={rows}
          trackBy="id"
          wrapLines
          ariaLabels={{ tableLabel: 'Current rates with price evidence' }}
          header={
            <Header
              variant="h2"
              description="A missing rate reads as UNKNOWN. It is never shown as zero."
            >
              Rates
            </Header>
          }
          columnDefinitions={[
            {
              id: 'family',
              header: 'Rate family',
              cell: (item) => (
                <Box variant="span" fontWeight="bold">
                  {item.family}
                </Box>
              ),
            },
            {
              id: 'amount',
              header: 'Amount',
              cell: (item) =>
                item.rate ? (
                  `${item.rate.amount} ${item.rate.currency}`
                ) : (
                  <Box variant="span" color="text-status-inactive">
                    {UNKNOWN_LABEL}
                  </Box>
                ),
            },
            {
              id: 'unit',
              header: 'Unit',
              cell: (item) => item.rate?.unit ?? UNKNOWN_LABEL,
            },
            {
              id: 'sku',
              header: 'SKU',
              cell: (item) => item.rate?.sku ?? UNKNOWN_LABEL,
            },
            {
              id: 'effectiveDate',
              header: 'Effective date',
              cell: (item) => item.rate?.effectiveDate ?? UNKNOWN_LABEL,
            },
            {
              id: 'source',
              header: 'Source',
              cell: (item) => item.rate?.source ?? UNKNOWN_LABEL,
            },
            {
              id: 'freshness',
              header: 'Freshness',
              cell: (item) => {
                const freshness = data?.freshness?.[freshnessKey(item.id)];
                return freshness ? (
                  <FreshnessBadge freshness={freshness} />
                ) : (
                  <Box variant="span" color="text-status-inactive">
                    {UNKNOWN_LABEL}
                  </Box>
                );
              },
            },
          ]}
          empty={
            <Box textAlign="center" color="inherit" padding={{ vertical: 'l' }}>
              <SpaceBetween size="xs">
                <b>No rates</b>
                <Box variant="p" color="text-body-secondary">
                  Retrieve rates for an instance type and architecture to see the
                  price evidence.
                </Box>
              </SpaceBetween>
            </Box>
          }
        />
      </SpaceBetween>
    </ContentLayout>
  );
}

/**
 * Map a rate row to its freshness key. The backend reports freshness under
 * `sagemaker`, `cmi_minute` and `cmi_month`.
 */
function freshnessKey(rowId: string): string {
  switch (rowId) {
    case 'sagemakerInstanceHour':
      return 'sagemaker';
    case 'cmiPerCmuMinute':
      return 'cmi_minute';
    case 'cmiPerCmuMonth':
      return 'cmi_month';
    default:
      return rowId;
  }
}

export default RatesPage;
