import Box from '@cloudscape-design/components/box';
import ExpandableSection from '@cloudscape-design/components/expandable-section';
import Link from '@cloudscape-design/components/link';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import type { AwsDocumentationReceipt } from '../api/types';
import { formatTimestamp } from './format';

/** Defense in depth for persisted receipts. Never render an arbitrary source URL. */
function officialDocument(href: string): boolean {
  try {
    const url = new URL(href);
    return url.protocol === 'https:' && url.hostname === 'docs.aws.amazon.com' &&
      !url.port && !url.username && !url.password && !url.search && !url.hash &&
      !/[\s%\\]/.test(href);
  } catch {
    return false;
  }
}

/** Retrieval is a source receipt, not a claim that model-written prose was verified. */
export function AwsDocumentationSources({ receipt }: { receipt?: AwsDocumentationReceipt }) {
  if (!receipt?.checks.length) return null;
  const complete = receipt.checks.every(check => check.state === 'RETRIEVED');
  return (
    <SpaceBetween size="xxs" data-testid="aws-documentation-receipt">
      <StatusIndicator type="info">
        {complete ? 'AWS documentation retrieved' : 'AWS documentation checks incomplete'}
      </StatusIndicator>
      <ExpandableSection variant="footer" headerText="AWS documentation sources">
        <SpaceBetween size="s">
          <Box variant="small" color="text-body-secondary">
            Retrieved through AWS Knowledge MCP for this answer. This checks documentation,
            not your account access, capacity, prices or measured performance.
          </Box>
          {receipt.checks.map(check => (
            <SpaceBetween key={check.topic} size="xxxs">
              <Box fontWeight="bold">{check.label}</Box>
              <Box variant="small" color="text-body-secondary">
                {check.state === 'RETRIEVED'
                  ? `Retrieved ${formatTimestamp(check.retrievedAt)}`
                  : check.state === 'PARTIAL' ? 'Search results were returned, but a needed section could not be read. This check remains unverified.'
                    : check.state === 'DISABLED' ? 'Documentation lookup is disabled in this installation.'
                    : check.state === 'NO_RESULTS' ? 'No matching documentation was returned. This check remains unverified.'
                      : 'Documentation could not be retrieved. This check remains unverified.'}
              </Box>
              {check.sources.filter(source => officialDocument(source.url)).map(source => (
                <Link key={source.id} href={source.url} external externalIconAriaLabel="Opens AWS documentation in a new tab">
                  {source.title}
                </Link>
              ))}
            </SpaceBetween>
          ))}
        </SpaceBetween>
      </ExpandableSection>
    </SpaceBetween>
  );
}
