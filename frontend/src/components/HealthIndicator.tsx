import Box from '@cloudscape-design/components/box';
import KeyValuePairs from '@cloudscape-design/components/key-value-pairs';
import Popover from '@cloudscape-design/components/popover';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import type { HealthResponse } from '../api/types';
import type { AsyncResult } from '../state/useAsync';
import { UNKNOWN_LABEL, formatTimestamp } from './format';

/**
 * Backend health in the global shell. Loading, degraded and unreachable are
 * all distinct, visible states — never a silent green light.
 */
export function HealthIndicator({
  health,
}: {
  health: AsyncResult<HealthResponse>;
}) {
  if (health.loading && !health.data) {
    return (
      <StatusIndicator type="loading">Checking API health</StatusIndicator>
    );
  }

  if (health.error || !health.data) {
    return (
      <Popover
        dismissButton={false}
        position="bottom"
        size="medium"
        triggerType="custom"
        header="API unreachable"
        content={
          <SpaceBetween size="xs">
            <Box variant="span">
              {health.error?.message ??
                'The health endpoint returned no usable response.'}
            </Box>
            <Box variant="small" color="text-body-secondary">
              Evaluations, the catalog and price evidence will fail until the
              API responds.
            </Box>
          </SpaceBetween>
        }
      >
        <StatusIndicator type="error">API unreachable</StatusIndicator>
      </Popover>
    );
  }

  const data = health.data;
  const degraded = data.status !== 'OK';

  return (
    <Popover
      dismissButton={false}
      position="bottom"
      size="medium"
      triggerType="custom"
      header={`API ${data.status}`}
      content={
        <KeyValuePairs
          columns={1}
          items={[
            { label: 'Status', value: data.status },
            { label: 'Solver version', value: data.solverVersion || UNKNOWN_LABEL },
            { label: 'Region', value: data.region || UNKNOWN_LABEL },
            {
              label: 'Price list',
              value: `${data.priceList?.status ?? UNKNOWN_LABEL} · sample rate ${
                data.priceList?.sampleRate ?? UNKNOWN_LABEL
              }`,
            },
            { label: 'Reported at', value: formatTimestamp(data.timestamp) },
          ]}
        />
      }
    >
      <StatusIndicator type={degraded ? 'warning' : 'success'}>
        API {data.status}
      </StatusIndicator>
    </Popover>
  );
}
