import Box from '@cloudscape-design/components/box';
import ColumnLayout from '@cloudscape-design/components/column-layout';
import ExpandableSection from '@cloudscape-design/components/expandable-section';
import Link from '@cloudscape-design/components/link';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import type { EvaluateResponse, Rate } from '../api/types';
import { formatMoney, formatTimestamp } from './format';

function price(rate: Rate | null): string {
  return rate ? `$${Number(rate.amount).toLocaleString('en-US', { maximumFractionDigits: 10 })} per million tokens` : 'Rate not available';
}

export function NativePriceEvidence({ result }: { result: EvaluateResponse }) {
  const candidates = [...(result.ranked ?? []), ...(result.unresolved ?? []), ...(result.excluded ?? [])];
  return <SpaceBetween size="m">{(result.nativePricing ?? []).map((quote) => {
    const candidate = candidates.find((c) => c.candidateId === quote.candidateId);
    return <div key={quote.candidateId} data-testid="native-price-evidence">
      <SpaceBetween size="s">
        <Box variant="h3">How the Bedrock estimate was calculated</Box>
        <ColumnLayout columns={2}>
          <div><Box fontWeight="bold">Input text</Box><Box>{price(quote.inputRate)}</Box></div>
          <div><Box fontWeight="bold">Output text</Box><Box>{price(quote.outputRate)}</Box></div>
        </ColumnLayout>
        {quote.missingUsage.length ? (
          <StatusIndicator type="info">To calculate a total, enter: {quote.missingUsage.join('; ')}.</StatusIndicator>
        ) : (
          <Box>
            {(candidate?.cost?.items ?? []).map((item) => (
              <div key={item.label}>
                {item.label}: {item.quantity} {item.quantityUnit} × {item.rate ? `$${Number(item.rate.amount).toLocaleString('en-US', { maximumFractionDigits: 10 })}` : 'rate unavailable'}
                {' = '}{item.amount === null ? 'not priced' : formatMoney(item.amount)}.
              </div>
            ))}
          </Box>
        )}
        <Box variant="small">
          {quote.inferenceProfileId ? `Request route: ${quote.inferenceProfileId}. ` : `API entry: ${quote.region}. `}
          {quote.processingRegions.length ? `May process in: ${quote.processingRegions.join(', ')}.` : 'Select and verify the processing location in Models & sources.'}
        </Box>
        <ExpandableSection headerText="Price sources and what is included">
          <SpaceBetween size="s">
            <Box>{quote.scope}</Box>
            <Box>Retrieved {formatTimestamp(quote.retrievedAt)}.</Box>
            {[quote.inputRate, quote.outputRate].filter((rate): rate is Rate => !!rate).map((rate, i) => (
              <Box key={i} variant="small">{rate.source} · SKU {rate.sku} · effective {rate.effectiveDate}</Box>
            ))}
            <SpaceBetween direction="horizontal" size="s">
              <Link external href={quote.pricingSource}>AWS pricing</Link>
              <Link external href={quote.routingSource}>AWS request-routing documentation</Link>
            </SpaceBetween>
          </SpaceBetween>
        </ExpandableSection>
      </SpaceBetween>
    </div>;
  })}</SpaceBetween>;
}
