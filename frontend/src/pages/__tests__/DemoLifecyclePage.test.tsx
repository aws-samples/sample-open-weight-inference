import { describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DEMO_STATE_COPY, DemoLifecyclePage } from '../DemoLifecyclePage';
import type { DemoState, DemoStatusResponse } from '../../api/types';
import {
  demoNotConfiguredFixture,
  demoSleepingFixture,
  demoWakingFixture,
} from '../../test/fixtures';
import {
  agentCore424,
  defaultHandler,
  expectDisabled,
  expectEnabled,
  okEnvelope,
  renderWithProviders,
} from '../../test/harness';

function renderDemo(status: DemoStatusResponse) {
  return renderWithProviders(<DemoLifecyclePage />, {
    handler: defaultHandler({
      'demo.status': status,
      'demo.wake': { ...status, state: 'WAKING' },
      'demo.sleep': { ...status, state: 'SLEEPING_IN_PROGRESS' },
    }),
  });
}

describe('demo lifecycle states', () => {
  it('defines honest copy for every state in the contract', () => {
    const states: DemoState[] = [
      'NOT_CONFIGURED',
      'SLEEPING',
      'WAKING',
      'READY',
      'SLEEPING_IN_PROGRESS',
      'ERROR',
    ];
    for (const state of states) {
      expect(DEMO_STATE_COPY[state]).toBeDefined();
      expect(DEMO_STATE_COPY[state].label).toBe(state);
      expect(DEMO_STATE_COPY[state].body.length).toBeGreaterThan(0);
    }
  });

  it('renders SLEEPING with the measured resume time, not a promise', async () => {
    renderDemo(demoSleepingFixture);
    await waitFor(() =>
      expect(screen.getByText('State: SLEEPING')).toBeInTheDocument()
    );
    expect(screen.getByTestId('resume-time-note')).toHaveTextContent(
      'The last observed wake took 412 seconds end to end.'
    );
    expect(
      screen.getByText(/an observation of previous wakes, not a commitment/)
    ).toBeInTheDocument();
    expect(screen.getByText('412 s (measured)')).toBeInTheDocument();
  });

  it('renders WAKING with the real state and no fabricated progress bar', async () => {
    renderDemo(demoWakingFixture);
    await waitFor(() =>
      expect(screen.getByText('State: WAKING')).toBeInTheDocument()
    );
    expect(
      screen.getByText(/cannot predict the remaining time/)
    ).toHaveTextContent(/takes several minutes and EDDIE.*cannot predict/);
    expect(
      screen.getByText(/Transition in progress. Re-checking every 15 seconds./)
    ).toBeInTheDocument();
    // No determinate progress indicator, and no invented percentage.
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(screen.queryByText(/%/)).toBeNull();
  });

  it('renders READY as available for queries', async () => {
    renderDemo({ ...demoSleepingFixture, state: 'READY' });
    await waitFor(() =>
      expect(screen.getByText('State: READY')).toBeInTheDocument()
    );
    expect(
      screen.getByText(/running and can answer queries/)
    ).toBeInTheDocument();
  });

  it('renders SLEEPING_IN_PROGRESS as a transition, not as asleep', async () => {
    renderDemo({ ...demoSleepingFixture, state: 'SLEEPING_IN_PROGRESS' });
    await waitFor(() =>
      expect(
        screen.getByText('State: SLEEPING_IN_PROGRESS')
      ).toBeInTheDocument()
    );
    expect(
      screen.getByText(/Wait for SLEEPING before waking it again/)
    ).toBeInTheDocument();
  });

  it('renders ERROR and warns that resources may still be billable', async () => {
    renderDemo({ ...demoSleepingFixture, state: 'ERROR' });
    await waitFor(() =>
      expect(screen.getByText('State: ERROR')).toBeInTheDocument()
    );
    expect(
      screen.getByText(/resources may still be running and billable/)
    ).toBeInTheDocument();
  });

  it('renders NOT_CONFIGURED without implying anything is being managed', async () => {
    renderDemo(demoNotConfiguredFixture);
    await waitFor(() =>
      expect(screen.getByText('State: NOT_CONFIGURED')).toBeInTheDocument()
    );
    expect(
      screen.getByText(/nothing to wake or put to sleep/)
    ).toBeInTheDocument();
    expect(
      screen.getByText(/no managed services to report/)
    ).toBeInTheDocument();
    // Unknown values read as UNKNOWN, not as zero or an empty cell.
    expect(screen.getAllByText('UNKNOWN').length).toBeGreaterThan(0);
  });
});

describe('demo lifecycle controls', () => {
  it('disables both actions when sleep mode is not configured, with a reason', async () => {
    renderDemo(demoNotConfiguredFixture);
    await waitFor(() =>
      expect(screen.getByText('State: NOT_CONFIGURED')).toBeInTheDocument()
    );
    expectDisabled(screen.getByRole('button', { name: 'Wake' }));
    expectDisabled(screen.getByRole('button', { name: 'Sleep' }));
    // The reason is exposed, not just the disabled state.
    expect(
      screen.getAllByText(/Sleep mode is not configured/).length
    ).toBeGreaterThan(0);
  });

  it('disables Wake while already READY and Sleep while already SLEEPING', async () => {
    const { unmount } = renderDemo({ ...demoSleepingFixture, state: 'READY' });
    await waitFor(() =>
      expect(screen.getByText('State: READY')).toBeInTheDocument()
    );
    expectDisabled(screen.getByRole('button', { name: 'Wake' }));
    expectEnabled(screen.getByRole('button', { name: 'Sleep' }));
    unmount();

    renderDemo(demoSleepingFixture);
    await waitFor(() =>
      expect(screen.getByText('State: SLEEPING')).toBeInTheDocument()
    );
    expectDisabled(screen.getByRole('button', { name: 'Sleep' }));
    expectEnabled(screen.getByRole('button', { name: 'Wake' }));
  });

  it('disables both actions during a transition', async () => {
    renderDemo(demoWakingFixture);
    await waitFor(() =>
      expect(screen.getByText('State: WAKING')).toBeInTheDocument()
    );
    expectDisabled(screen.getByRole('button', { name: 'Wake' }));
    expectDisabled(screen.getByRole('button', { name: 'Sleep' }));
  });

  it('moves to WAKING after a wake request', async () => {
    renderDemo(demoSleepingFixture);
    await waitFor(() =>
      expect(screen.getByText('State: SLEEPING')).toBeInTheDocument()
    );
    await userEvent.click(screen.getByRole('button', { name: 'Wake' }));
    await waitFor(() =>
      expect(screen.getByText('State: WAKING')).toBeInTheDocument()
    );
  });

  it('keeps the last known state visible when a refresh fails', async () => {
    let calls = 0;
    renderWithProviders(<DemoLifecyclePage />, {
      handler: (action) => {
        if (action !== 'demo.status') return okEnvelope(action, demoSleepingFixture);
        calls += 1;
        return calls === 1
          ? okEnvelope(action, demoSleepingFixture)
          : agentCore424();
      },
    });
    await waitFor(() =>
      expect(screen.getByText('State: SLEEPING')).toBeInTheDocument()
    );
    await userEvent.click(
      screen.getByRole('button', { name: 'Refresh demo lifecycle status' })
    );
    await waitFor(() =>
      expect(
        screen.getByText('Could not read the lifecycle status')
      ).toBeInTheDocument()
    );
    // The prior state is retained but flagged as possibly stale.
    expect(screen.getByText('State: SLEEPING')).toBeInTheDocument();
    expect(screen.getByText(/it may now be stale/)).toBeInTheDocument();
  });

  it('shows the generic coordinator-error text for a 424 without inventing a cause', async () => {
    renderWithProviders(<DemoLifecyclePage />, {
      handler: () => agentCore424(),
    });
    await waitFor(() =>
      expect(
        screen.getByText('Could not read the lifecycle status')
      ).toBeInTheDocument()
    );
    expect(
      screen.getByText(/does not pass the underlying detail through/)
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/Received error \(400\) from runtime/)
    ).toBeNull();
  });
});
