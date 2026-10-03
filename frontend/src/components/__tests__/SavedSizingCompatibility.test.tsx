import React, { type ReactNode } from 'react';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import beforeMagpie from '../../test/fixtures/legacy-inference-sizing.json';
import { okEnvelope, renderWithProviders } from '../../test/harness';
import { DEFAULT_FORM, EMPTY_PROJECT } from '../../state/caseForm';
import { InferenceSizing } from '../InferenceSizing';

class SavedReportBoundary extends React.Component<
  { children: ReactNode }, { error: string | null }
> {
  state = { error: null as string | null };
  static getDerivedStateFromError(error: Error) {
    return { error: error.message };
  }
  render() {
    return this.state.error
      ? <div data-testid="saved-report-render-error">{this.state.error}</div>
      : this.props.children;
  }
}

it('can reopen a pre-Magpie saved sizing report and view its recorded example', async () => {
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    renderWithProviders(<SavedReportBoundary><InferenceSizing /></SavedReportBoundary>, {
      withCase: true,
      initialForm: EMPTY_PROJECT,
      caseId: 'legacy-project',
      handler: (action) => {
        if (action === 'case.get') {
          return okEnvelope(action, {
            project: {
              caseId: 'legacy-project',
              revision: 'pre-magpie-saved-project',
              savedAt: '2026-10-02T00:00:00Z',
              document: {
                form: DEFAULT_FORM,
                decision: null,
                turns: [],
                draft: '',
                inspection: null,
                fieldOrigins: {},
                sizingDraft: {
                  settings: beforeMagpie.cpu.settings,
                  report: beforeMagpie.cpu,
                },
              },
            },
          });
        }
        return okEnvelope(action, {});
      },
    });
    await screen.findByTestId('inference-sizing-report');
    await userEvent.click(screen.getByRole('tab', { name: 'Recorded example' }));
    expect(screen.queryByTestId('saved-report-render-error')).toBeNull();
    expect(screen.getByText('Saved recorded example')).toBeVisible();
    expect(screen.getByText('This example uses an earlier report format.')).toBeVisible();
    expect(screen.queryByText(/Magpie TTS/)).not.toBeInTheDocument();
  } finally {
    consoleError.mockRestore();
  }
});
