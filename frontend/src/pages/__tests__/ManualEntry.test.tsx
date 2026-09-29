import { describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WorkspacePage } from '../WorkspacePage';
import {
  LocationProbe,
  RequirementsEditorHarness,
  defaultHandler,
  renderWithProviders,
} from '../../test/harness';
import { chatIntakeOnlyFixture, healthFixture } from '../../test/fixtures';
import { useDetailPanel } from '../../state/DetailPanelContext';
import { FALLBACK_SUGGESTED_PROMPTS } from '../../state/ChatContext';

/**
 * The contextual panel's content is rendered by the shell's SplitPanel, which is not
 * mounted here. This surfaces what the provider was asked to show, so the test observes
 * the real effect of the click rather than a rendered panel.
 */
function PanelProbe() {
  const { panel, open } = useDetailPanel();
  return (
    <div data-testid="panel-probe">
      {open && panel ? `open: ${String(panel.header)}` : 'closed'}
    </div>
  );
}

/** Option labels from an open Autosuggest dropdown. */
function optionTexts(): string[] {
  return [...document.querySelectorAll('[role="option"]')].map(
    (node) => node.textContent ?? ''
  );
}

/**
 * Manual entry, and the absence of irrelevant follow-ups.
 *
 * Both are direct responses to a user report. The redesign made the requirements form
 * reachable only through an "Edit" link on a summary that appears after the first reply,
 * so someone who already knew their horizon, budget and Region had to talk their way to a
 * form. And the follow-up suggestions were five hardcoded examples about a different
 * model, offered after a conversation about a different one entirely.
 */

function renderWorkspace() {
  return renderWithProviders(
    <>
      <WorkspacePage />
      <PanelProbe />
      <LocationProbe />
    </>,
    {
    handler: defaultHandler({
      health: healthFixture,
      chat: chatIntakeOnlyFixture,
      'deployment.list': {
        deployments: [],
        residual: null,
        capability: { targets: [], canCreatePlans: false, note: '' },
        storeConfigured: true,
      },
    }),
      withChat: true,
    }
  );
}

describe('manual entry is offered, not hidden', () => {
  it('offers it on the opening screen, before any conversation', async () => {
    renderWorkspace();
    await waitFor(() =>
      expect(screen.getByText('What are you building?')).toBeInTheDocument()
    );
    // Not behind an Edit link on a summary that does not exist yet.
    expect(screen.getByTestId('enter-manually')).toBeInTheDocument();
  });

  it('navigates to the requirements page rather than opening a side panel', async () => {
    /*
     * This used to open the shell's split panel. The form is a model block, a workload
     * block, constraints and an evidence section; in a panel a third of the window wide
     * every field wrapped and the result was pushed out of view, so it is a page.
     */
    renderWorkspace();
    await waitFor(() =>
      expect(screen.getByTestId('enter-manually')).toBeInTheDocument()
    );
    await userEvent.click(screen.getByTestId('enter-manually'));
    await waitFor(() =>
      expect(screen.getByTestId('location-probe')).toHaveTextContent(
        '/requirements'
      )
    );
    // And it does not also open a competing panel.
    expect(screen.getByTestId('panel-probe')).toHaveTextContent('closed');
  });
});

describe('no irrelevant follow-up suggestions', () => {
  it('shows none of the old hardcoded examples', async () => {
    renderWorkspace();
    await waitFor(() =>
      expect(screen.getByText('What are you building?')).toBeInTheDocument()
    );
    /*
     * These five were returned on every turn regardless of context. A conversation about
     * an always-on Qwen 0.5B service was offered them as "follow-ups".
     */
    for (const stale of [
      /3-day game/,
      /always-on service for a month/,
      /ElevenLabs voices/,
      /Custom Model Import actually cost/,
      /First response after idle must be under 800/,
    ]) {
      expect(screen.queryByText(stale)).toBeNull();
    }
  });

  it('shows no follow-up heading when there is nothing to suggest', async () => {
    renderWorkspace();
    await waitFor(() =>
      expect(screen.getByText('What are you building?')).toBeInTheDocument()
    );
    expect(screen.queryByText(/Follow-up suggestions/)).toBeNull();
    expect(screen.queryByText(/Start from one of these/)).toBeNull();
  });
});

describe('the form offers choices instead of bare numbers', () => {
  function renderForm() {
    return renderWithProviders(<RequirementsEditorHarness />, {
      handler: defaultHandler({ health: healthFixture }),
      withCase: true,
    });
  }

  it('suggests real periods for the horizon', async () => {
    renderForm();
    // Autosuggest, so typing filters real options that carry the hour arithmetic.
    // Options are matched by text content: Cloudscape splits the highlighted substring
    // across elements, so a plain text query does not find them.
    const input = screen.getByPlaceholderText('e.g. 8760');
    await userEvent.clear(input);
    await userEvent.type(input, '87');
    await waitFor(() =>
      expect(optionTexts().some((text) => text.includes('one year'))).toBe(true)
    );
  });

  it('offers an always-on shortcut that matches the horizon', async () => {
    renderForm();
    await userEvent.click(screen.getByTestId('always-on'));
    // Serving hours equal the horizon: a 100% duty cycle, without the user multiplying.
    await waitFor(() => {
      const serving = screen.getByPlaceholderText('e.g. 6') as HTMLInputElement;
      const horizon = screen.getByPlaceholderText('e.g. 8760') as HTMLInputElement;
      expect(serving.value).toBe(horizon.value);
    });
  });

  it('makes Region a choice rather than a comma-separated string', async () => {
    renderForm();
    // A typo in a hard residency gate silently read as no constraint at all.
    expect(
      screen.getAllByText('Where may this run?').length
    ).toBeGreaterThan(0);
    expect(screen.queryByText(/Comma-separated/)).toBeNull();
    // Cloudscape's Multiselect renders its placeholder as text, not a placeholder
    // attribute, so it is matched as content.
    expect(
      screen.getByText('Any supported Region')
    ).toBeInTheDocument();
  });

  it('suggests response-time targets with what they mean', async () => {
    renderForm();
    await userEvent.click(screen.getByText('Set a response-time target'));
    const threshold = screen.getByPlaceholderText('e.g. 800');
    await userEvent.clear(threshold);
    await userEvent.type(threshold, '80');
    await waitFor(() =>
      expect(
        optionTexts().some((text) => text.includes('voice first audio'))
      ).toBe(true)
    );
  });
});

describe('the fix is applied in every layer that could supply a suggestion', () => {
  it('has no hardcoded fallback list in the frontend either', () => {
    /*
     * The first attempt emptied only the backend's SUGGESTED_PROMPTS, and nothing the
     * user saw changed: the frontend kept substituting its own copy of the same four
     * examples. Two lists with identical content in two layers is how a fix looks
     * applied and is not.
     */
    expect(FALLBACK_SUGGESTED_PROMPTS).toEqual([]);
  });

  it('has no example prompt text left in the shipped source', async () => {
    // Guards the whole class rather than the four strings that happened to be there.
    const sources = import.meta.glob('../../**/*.{ts,tsx}', {
      query: '?raw',
      import: 'default',
      eager: true,
    }) as Record<string, string>;
    const offenders: string[] = [];
    for (const [path, source] of Object.entries(sources)) {
      // `import.meta.glob` keys are relative and can be a bare filename, so a
      // directory check alone misses `./ChatPage.test.tsx`. Filenames are matched too.
      const isTest =
        path.includes('__tests__') ||
        path.includes('/test/') ||
        /\.(test|spec)\.tsx?$/.test(path);
      if (isTest) continue;
      if (/3-day game|ElevenLabs voices/.test(source)) offenders.push(path);
    }
    expect(offenders, `offenders: ${offenders.join(', ')}`).toEqual([]);
  });
});
