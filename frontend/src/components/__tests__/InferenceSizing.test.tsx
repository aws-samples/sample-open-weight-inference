import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { EvaluateRequest } from '../../api/types';
import type { SizingReport, SizingSettings } from '../../api/sizing';
import fixtures from '../../test/fixtures/inference-sizing.json';
import { okEnvelope, renderWithProviders } from '../../test/harness';
import { DEFAULT_SIZING } from '../../state/sizingDraft';
import { useCase } from '../../state/CaseContext';
import { InferenceSizing } from '../InferenceSizing';

function SaveProbe() {
  const { projectSave, sizingDraft } = useCase();
  return <>
    <button onClick={() => void projectSave.save()}>Save test project</button>
    <output data-testid="sizing-settings">{JSON.stringify(sizingDraft.settings)}</output>
  </>;
}

function reply(payload: unknown, kind: 'gpu' | 'cpu' = 'gpu') {
  const { request, settings } = payload as { request: EvaluateRequest; settings: SizingSettings };
  return { ...fixtures[kind], request, settings: { ...DEFAULT_SIZING, ...settings } } as SizingReport;
}

describe('manual compute planning', () => {
  it('keeps edits immediately, marks old results stale, and saves the sheet with the project', async () => {
    const { invocations } = renderWithProviders(<><InferenceSizing /><SaveProbe /></>, {
      withCase: true,
      handler: (action, payload) => {
        if (action === 'sizing.estimate') return okEnvelope(action, reply(payload));
        if (action === 'case.save') {
          const body = payload as { caseId: string; document: unknown };
          return okEnvelope(action, { project: { ...body, revision: 'saved-1', savedAt: '2026-09-23T00:00:00Z' } });
        }
        return okEnvelope(action, {});
      },
    });
    await userEvent.click(screen.getByRole('button', { name: 'Build sizing sheet' }));
    await screen.findByTestId('inference-sizing-report');
    expect(screen.getByTestId('inference-sizing-report')).toHaveAttribute('data-stale', 'false');
    const jobs = screen.getByRole('textbox', { name: 'Simultaneous jobs or requests' });
    await userEvent.clear(jobs);
    await userEvent.type(jobs, '12');
    expect(screen.getByTestId('sizing-settings')).toHaveTextContent('"jobConcurrency":"12"');
    expect(screen.getByTestId('inference-sizing-report')).toHaveAttribute('data-stale', 'true');
    await userEvent.click(screen.getByRole('button', { name: 'Save test project' }));
    await waitFor(() => expect(invocations.some((call) => call.action === 'case.save')).toBe(true));
    const save = invocations.find((call) => call.action === 'case.save')!.payload as {
      document: { sizingDraft: { settings: SizingSettings; report: SizingReport } };
    };
    expect(save.document.sizingDraft.settings.jobConcurrency).toBe('12');
    expect(save.document.sizingDraft.report.settings.jobConcurrency).toBe('');
  });

  it('discards a late calculation rather than replacing newer manual values', async () => {
    let finish!: (response: Response) => void;
    let submitted: unknown;
    renderWithProviders(<InferenceSizing />, {
      withCase: true,
      handler: (action, payload) => {
        if (action === 'sizing.estimate') {
          submitted = payload;
          return new Promise<Response>((resolve) => { finish = resolve; });
        }
        return okEnvelope(action, {});
      },
    });
    await userEvent.click(screen.getByRole('button', { name: 'Build sizing sheet' }));
    await userEvent.type(screen.getByRole('textbox', { name: 'Simultaneous jobs or requests' }), '4');
    await act(async () => finish(okEnvelope('sizing.estimate', reply(submitted))));
    expect(await screen.findByText(/Inputs changed while the sheet was updating/)).toBeVisible();
    expect(screen.queryByTestId('inference-sizing-report')).toBeNull();
    expect(screen.getByRole('textbox', { name: 'Simultaneous jobs or requests' })).toHaveValue('4');
  });

  it('shows the recorded Magpie run without treating it as this project’s measurement', async () => {
    const { invocations } = renderWithProviders(<InferenceSizing />, {
      withCase: true,
      handler: (action, payload) => action === 'sizing.estimate'
        ? okEnvelope(action, reply(payload, 'cpu')) : okEnvelope(action, {}),
    });
    await userEvent.click(screen.getByRole('button', { name: 'Build sizing sheet' }));
    await screen.findByTestId('inference-sizing-report');
    await userEvent.click(screen.getByRole('tab', { name: 'Recorded example' }));
    expect(screen.getByText('Recorded example: speech on CPU')).toBeVisible();
    expect(screen.getByText(/Recorded example.*one request/)).toBeVisible();
    expect(screen.getByText('11.6')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: /What this proves/ }));
    expect(screen.getByText(/does not demonstrate live or streaming voice/)).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Reproduction details' }));
    expect(screen.getByText(/bundle magpie-tts-v2607/)).toBeVisible();
    expect(invocations.filter((call) => call.action === 'sizing.estimate')).toHaveLength(1);
  });

  it('shows no recorded example tab when no real record is installed, and never a placeholder', async () => {
    const { invocations } = renderWithProviders(<InferenceSizing />, {
      withCase: true,
      handler: (action, payload) => {
        if (action !== 'sizing.estimate') return okEnvelope(action, {});
        const report = reply(payload, 'cpu');
        return okEnvelope(action, { ...report, guidance: { ...report.guidance, example: null } });
      },
    });
    await userEvent.click(screen.getByRole('button', { name: 'Build sizing sheet' }));
    await screen.findByTestId('inference-sizing-report');
    await userEvent.click(screen.getByRole('button', { name: /What still needs evidence/ }));
    expect(screen.getByText('Reported process memory:')).toBeVisible();
    expect(screen.queryByRole('tab', { name: 'Recorded example' })).toBeNull();
    expect(screen.queryByRole('tab', { name: 'Podcast example' })).toBeNull();
    expect(invocations.filter((call) => call.action === 'sizing.estimate')).toHaveLength(1);
    const billableOrMutating = new Set([
      'plan.create', 'plan.approve', 'deployment.invoke', 'deployment.delete', 'demo.wake',
    ]);
    expect(invocations.some((call) => billableOrMutating.has(call.action))).toBe(false);
  });
});
