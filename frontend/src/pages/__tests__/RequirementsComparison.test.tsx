import { describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RequirementsPage } from '../RequirementsPage';
import { DEFAULT_FORM, WORKLOAD_PRESETS, toEvaluateRequest } from '../../state/caseForm';
import {
  defaultHandler,
  renderWithProviders,
  streamOnce,
} from '../../test/harness';
import { healthFixture } from '../../test/fixtures';
import recordedSupportCase from '../../test/fixtures/support-case-live.json';

describe('requirements and comparison stay in sync', () => {
  it('usage shortcuts never manufacture evidence or change non-usage requirements', () => {
    const original = {
      ...DEFAULT_FORM,
      budgetUsd: '2000',
      permittedRegions: 'us-west-2',
      provideSlo: true,
      sloThresholdMs: '5000',
      concurrency: '4',
      description: 'Support-ticket assistant',
      assumeChecksCleared: false,
    };
    expect(DEFAULT_FORM.assumeChecksCleared).toBe(false);
    for (const preset of WORKLOAD_PRESETS) {
      const before = toEvaluateRequest(original);
      const after = toEvaluateRequest({ ...original, ...preset.patch });
      expect(after.model).toEqual(before.model);
      expect(after.constraints).toEqual(before.constraints);
      expect(after.slos).toEqual(before.slos);
      expect(after.latencyEvidence).toEqual(before.latencyEvidence);
      expect(after.assumeChecksCleared).toBe(false);
      expect(after.workload.concurrency).toBe(4);
      expect(after.workload.description).toBe(original.description);
    }
  });

  it('submits once from the form, hides stale costs, and sends the edited budget', async () => {
    const fallback = defaultHandler({ health: healthFixture });
    const { invocations } = renderWithProviders(<RequirementsPage />, {
      withCase: true,
      handler: (action, payload, stream) =>
        action === 'evaluate'
          ? streamOnce({
              ...recordedSupportCase,
              evaluatedRequest: payload,
              requestHash: JSON.stringify(payload),
            })
          : fallback(action, payload, stream),
    });
    await userEvent.click(screen.getByRole('tab', { name: 'Compare hosting' }));
    await userEvent.click(screen.getByRole('button', { name: 'Compare hosting costs' }));
    await waitFor(() => expect(screen.getByText('$879.84')).toBeVisible());
    expect(invocations.filter((call) => call.action === 'evaluate')).toHaveLength(1);

    await userEvent.click(screen.getByRole('tab', { name: 'Your needs' }));
    const budget = screen.getByRole('spinbutton', { name: 'Hosting budget in USD' });
    await userEvent.clear(budget);
    await userEvent.type(budget, '500');
    await userEvent.click(screen.getByRole('tab', { name: 'Compare hosting' }));
    expect(screen.getByText('Your requirements changed')).toBeVisible();
    expect(screen.queryByText('$879.84')).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Update comparison' }));
    await waitFor(() => expect(invocations.filter((call) => call.action === 'evaluate')).toHaveLength(2));
    const calls = invocations.filter((call) => call.action === 'evaluate');
    expect(calls[1].payload).toMatchObject({
      constraints: { budgetUsd: '500' },
      assumeChecksCleared: false,
    });
  });

  it('the page action respects the same validation as the form action', async () => {
    const { invocations } = renderWithProviders(<RequirementsPage />, {
      withCase: true,
      handler: defaultHandler({ health: healthFixture }),
    });
    await userEvent.clear(screen.getByRole('spinbutton', { name: 'Comparison period in days' }));
    await userEvent.click(screen.getByRole('tab', { name: 'Compare hosting' }));
    expect(screen.getByText('A little more information is needed to calculate costs')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Compare hosting costs' })).toBeNull();
    expect(invocations.filter((call) => call.action === 'evaluate')).toHaveLength(0);
  });
});
