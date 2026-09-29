import { brandText } from '../components/BrandName';
import { useCallback, useEffect, useRef, useState } from 'react';
import Alert from '@cloudscape-design/components/alert';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Container from '@cloudscape-design/components/container';
import ContentLayout from '@cloudscape-design/components/content-layout';
import Header from '@cloudscape-design/components/header';
import KeyValuePairs from '@cloudscape-design/components/key-value-pairs';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Spinner from '@cloudscape-design/components/spinner';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Table from '@cloudscape-design/components/table';
import type { DemoState, DemoStatusResponse } from '../api/types';
import { UNKNOWN_LABEL, formatTimestamp } from '../components/format';
import { useApp } from '../state/AppContext';

type IndicatorType =
  | 'success'
  | 'warning'
  | 'error'
  | 'pending'
  | 'in-progress'
  | 'stopped';

export const DEMO_STATE_COPY: Record<
  DemoState,
  { indicator: IndicatorType; label: string; body: string }
> = {
  NOT_CONFIGURED: {
    indicator: 'stopped',
    label: 'NOT_CONFIGURED',
    body: 'Sleep mode is not configured in this environment. There is nothing to wake or put to sleep, and no cost is being controlled here.',
  },
  SLEEPING: {
    indicator: 'stopped',
    label: 'SLEEPING',
    body: 'The knowledge stack is stopped. Knowledge queries will report SLEEPING until it is woken. Waking takes minutes, not seconds.',
  },
  WAKING: {
    indicator: 'in-progress',
    label: 'WAKING',
    body: 'The stack is starting. This takes several minutes and EDDIE cannot predict the remaining time, so no countdown is shown — only the real state as the backend reports it.',
  },
  READY: {
    indicator: 'success',
    label: 'READY',
    body: 'The knowledge stack is running and can answer queries.',
  },
  SLEEPING_IN_PROGRESS: {
    indicator: 'in-progress',
    label: 'SLEEPING_IN_PROGRESS',
    body: 'The stack is shutting down. Wait for SLEEPING before waking it again.',
  },
  ERROR: {
    indicator: 'error',
    label: 'ERROR',
    body: 'The lifecycle controller reported an error. Check the detail below; resources may still be running and billable.',
  },
};

/** Poll only while a transition is genuinely in flight. */
const TRANSITIONAL: DemoState[] = ['WAKING', 'SLEEPING_IN_PROGRESS'];
const POLL_INTERVAL_MS = 15000;

export function DemoStateIndicator({ state }: { state: DemoState }) {
  const copy = DEMO_STATE_COPY[state] ?? {
    indicator: 'pending' as IndicatorType,
    label: state,
    body: '',
  };
  return <StatusIndicator type={copy.indicator}>{copy.label}</StatusIndicator>;
}

interface ServiceRow {
  service: string;
  status: string;
}

/**
 * COA sleep-mode operation.
 *
 * States are reported exactly as the backend gives them. `WAKING` shows a
 * genuine indeterminate indicator and the measured `resumeTimeNote`; there is
 * no synthetic progress bar and no predicted completion time.
 */
export function DemoLifecyclePage() {
  const { client } = useApp();
  const [status, setStatus] = useState<DemoStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [acting, setActing] = useState<'wake' | 'sleep' | null>(null);
  const [lastCheckedAt, setLastCheckedAt] = useState<number | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refresh = useCallback(
    async (options: { quiet?: boolean } = {}) => {
      if (!options.quiet) setLoading(true);
      try {
        const response = await client.demoStatus();
        if (!mounted.current) return;
        setStatus(response);
        setError(null);
        setLastCheckedAt(Date.now());
      } catch (caught) {
        if (!mounted.current) return;
        setError(caught instanceof Error ? caught : new Error(String(caught)));
        setLastCheckedAt(Date.now());
      } finally {
        if (mounted.current) setLoading(false);
      }
    },
    [client]
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Poll only during a real transition, then stop. No unbounded polling.
  useEffect(() => {
    if (!status || !TRANSITIONAL.includes(status.state)) return;
    const timer = window.setInterval(() => {
      void refresh({ quiet: true });
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [status, refresh]);

  const act = useCallback(
    async (action: 'wake' | 'sleep') => {
      setActing(action);
      setError(null);
      try {
        const response =
          action === 'wake'
            ? await client.demoWake()
            : await client.demoSleep();
        if (!mounted.current) return;
        setStatus(response);
        setLastCheckedAt(Date.now());
      } catch (caught) {
        if (!mounted.current) return;
        setError(caught instanceof Error ? caught : new Error(String(caught)));
      } finally {
        if (mounted.current) setActing(null);
      }
    },
    [client]
  );

  const state = status?.state ?? null;
  const copy = state ? DEMO_STATE_COPY[state] : null;
  const notConfigured = state === 'NOT_CONFIGURED';
  const transitional = state !== null && TRANSITIONAL.includes(state);

  const serviceRows: ServiceRow[] = status?.services
    ? Object.entries(status.services).map(([service, value]) => ({
        service,
        status: String(value),
      }))
    : [];

  const wakeDisabledReason = notConfigured
    ? 'Sleep mode is not configured in this environment, so there is nothing to wake.'
    : state === 'READY'
      ? 'The stack is already running.'
      : transitional
        ? `A transition is already in progress (${state}). Wait for it to finish.`
        : acting !== null
          ? 'Another lifecycle action is in progress.'
          : undefined;

  const sleepDisabledReason = notConfigured
    ? 'Sleep mode is not configured in this environment, so there is nothing to put to sleep.'
    : state === 'SLEEPING'
      ? 'The stack is already asleep.'
      : transitional
        ? `A transition is already in progress (${state}). Wait for it to finish.`
        : acting !== null
          ? 'Another lifecycle action is in progress.'
          : undefined;

  return (
    <ContentLayout
      header={
        <Header
          variant="h1"
          description={brandText("Start and stop the COA knowledge stack. Waking takes minutes; EDDIE reports the real state and the measured resume time rather than predicting one.")}
          actions={
            <Button
              iconName="refresh"
              onClick={() => void refresh()}
              loading={loading}
              ariaLabel="Refresh demo lifecycle status"
            >
              Refresh
            </Button>
          }
        >
          Demo lifecycle
        </Header>
      }
    >
      <SpaceBetween size="l">
        {error ? (
          <Alert
            type="error"
            statusIconAriaLabel="Error"
            header="Could not read the lifecycle status"
            action={
              <Button iconName="refresh" onClick={() => void refresh()}>
                Retry
              </Button>
            }
          >
            <SpaceBetween size="xs">
              <Box variant="span">{error.message}</Box>
              <Box variant="small" color="text-body-secondary">
                The last known state is kept below rather than discarded, but it
                may now be stale.
              </Box>
            </SpaceBetween>
          </Alert>
        ) : null}

        <Container
          header={
            <Header
              variant="h2"
              description="The authoritative state as reported by the lifecycle controller."
              actions={
                <SpaceBetween direction="horizontal" size="xs">
                  <Button
                    onClick={() => void act('wake')}
                    loading={acting === 'wake'}
                    loadingText="Requesting wake"
                    disabled={wakeDisabledReason !== undefined}
                    disabledReason={wakeDisabledReason}
                    iconName="status-positive"
                  >
                    Wake
                  </Button>
                  <Button
                    onClick={() => void act('sleep')}
                    loading={acting === 'sleep'}
                    loadingText="Requesting sleep"
                    disabled={sleepDisabledReason !== undefined}
                    disabledReason={sleepDisabledReason}
                    iconName="status-stopped"
                  >
                    Sleep
                  </Button>
                </SpaceBetween>
              }
            >
              Status
            </Header>
          }
        >
          {loading && !status ? (
            <Box textAlign="center" padding={{ vertical: 'xl' }}>
              <SpaceBetween size="s">
                <Spinner size="large" />
                <Box variant="p">Reading lifecycle status.</Box>
              </SpaceBetween>
            </Box>
          ) : !status ? (
            <Box
              textAlign="center"
              color="text-body-secondary"
              padding={{ vertical: 'xl' }}
            >
              <SpaceBetween size="xs">
                <Box variant="h3">No status available</Box>
                <Box variant="p">
                  The lifecycle controller returned no status. Retry above.
                </Box>
              </SpaceBetween>
            </Box>
          ) : (
            <SpaceBetween size="m">
              <SpaceBetween direction="horizontal" size="s">
                <DemoStateIndicator state={status.state} />
                {transitional ? (
                  // An indeterminate spinner, because the backend gives no
                  // percentage and inventing one would be a lie.
                  <SpaceBetween direction="horizontal" size="xxs">
                    <Spinner />
                    <Box variant="small" color="text-body-secondary">
                      Transition in progress. Re-checking every 15 seconds.
                    </Box>
                  </SpaceBetween>
                ) : null}
              </SpaceBetween>

              {copy ? (
                <Alert
                  type={
                    status.state === 'READY'
                      ? 'success'
                      : status.state === 'ERROR'
                        ? 'error'
                        : status.state === 'WAKING' ||
                            status.state === 'SLEEPING_IN_PROGRESS'
                          ? 'info'
                          : 'warning'
                  }
                  statusIconAriaLabel={copy.indicator}
                  header={`State: ${copy.label}`}
                >
                  {brandText(copy.body)}
                </Alert>
              ) : null}

              {status.resumeTimeNote ? (
                <Alert
                  type="info"
                  statusIconAriaLabel="Information"
                  header="Measured resume time"
                >
                  <SpaceBetween size="xxs">
                    <Box variant="span" data-testid="resume-time-note">
                      {status.resumeTimeNote}
                    </Box>
                    <Box variant="small" color="text-body-secondary">
                      This is an observation of previous wakes, not a commitment
                      for this one.
                    </Box>
                  </SpaceBetween>
                </Alert>
              ) : null}

              {status.expired === true ? (
                <Alert
                  type="warning"
                  statusIconAriaLabel="Warning"
                  header="This environment's lifetime has expired"
                >
                  Resources may have been reclaimed, or may still be running and
                  billable. Verify before relying on them.
                </Alert>
              ) : null}

              {status.costNote ? (
                <Alert
                  type="warning"
                  statusIconAriaLabel="Warning"
                  header="Cost exposure"
                >
                  {status.costNote}
                </Alert>
              ) : null}

              <KeyValuePairs
                columns={4}
                items={[
                  { label: 'State', value: status.state },
                  {
                    label: 'Neptune status',
                    value: status.neptuneStatus ?? UNKNOWN_LABEL,
                  },
                  {
                    label: 'Last wake duration',
                    value:
                      status.lastWakeSeconds === null ||
                      status.lastWakeSeconds === undefined
                        ? UNKNOWN_LABEL
                        : `${status.lastWakeSeconds} s (measured)`,
                  },
                  {
                    label: 'Expires at',
                    value: status.expiresAt
                      ? formatTimestamp(status.expiresAt)
                      : UNKNOWN_LABEL,
                  },
                  {
                    label: 'Expired',
                    value:
                      status.expired === null || status.expired === undefined
                        ? UNKNOWN_LABEL
                        : status.expired
                          ? 'Yes'
                          : 'No',
                  },
                  {
                    label: 'Status checked',
                    value: lastCheckedAt
                      ? new Date(lastCheckedAt).toLocaleTimeString()
                      : UNKNOWN_LABEL,
                  },
                ]}
              />
            </SpaceBetween>
          )}
        </Container>

        <Table<ServiceRow>
          variant="container"
          items={serviceRows}
          trackBy="service"
          loading={loading && !status}
          loadingText="Reading service status"
          ariaLabels={{ tableLabel: 'Underlying service status' }}
          header={
            <Header
              variant="h2"
              counter={serviceRows.length > 0 ? `(${serviceRows.length})` : undefined}
              description="Reported verbatim by the lifecycle controller."
            >
              Services
            </Header>
          }
          columnDefinitions={[
            {
              id: 'service',
              header: 'Service',
              cell: (item) => (
                <Box variant="span" fontWeight="bold">
                  {item.service}
                </Box>
              ),
            },
            {
              id: 'status',
              header: 'Status',
              cell: (item) => item.status,
            },
          ]}
          empty={
            <Box textAlign="center" color="inherit" padding={{ vertical: 'l' }}>
              <SpaceBetween size="xs">
                <b>No service detail</b>
                <Box variant="p" color="text-body-secondary">
                  {notConfigured
                    ? 'Sleep mode is not configured, so there are no managed services to report.'
                    : 'The controller returned no per-service status for this state.'}
                </Box>
              </SpaceBetween>
            </Box>
          }
        />
      </SpaceBetween>
    </ContentLayout>
  );
}

export default DemoLifecyclePage;
