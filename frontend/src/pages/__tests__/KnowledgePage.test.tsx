import { describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AffectsPlacementNotice, KnowledgePage } from '../KnowledgePage';
import {
  knowledgeNotInstalledFixture,
  knowledgeReadyFixture,
} from '../../test/fixtures';
import {
  defaultHandler,
  expectDisabled,
  failEnvelope,
  renderWithProviders,
} from '../../test/harness';
import type { KnowledgeResponse } from '../../api/types';

function renderKnowledge(response: KnowledgeResponse) {
  return renderWithProviders(<KnowledgePage />, {
    handler: defaultHandler({ knowledge: response }),
  });
}

async function ask() {
  await userEvent.type(
    screen.getByLabelText('Knowledge query'),
    'What licence applies?'
  );
  await userEvent.click(screen.getByRole('button', { name: 'Ask' }));
}

describe('AffectsPlacementNotice', () => {
  it('states prominently that governed context does not affect placement', () => {
    renderWithProviders(<AffectsPlacementNotice affectsPlacement={false} />);
    expect(
      screen.getByText('This context does not affect placement')
    ).toBeInTheDocument();
    expect(screen.getByText('affectsPlacement: false')).toBeInTheDocument();
    expect(
      screen.getByText(/never changes a price, a gate outcome/)
    ).toBeInTheDocument();
  });

  it('raises an error if a backend ever claims it does affect placement', () => {
    renderWithProviders(<AffectsPlacementNotice affectsPlacement />);
    expect(
      screen.getByText('Unexpected: this response claims to affect placement')
    ).toBeInTheDocument();
  });
});

describe('KnowledgePage', () => {
  it('consults nothing until a question is asked', () => {
    renderKnowledge(knowledgeReadyFixture);
    expect(screen.getByText('No query yet')).toBeInTheDocument();
    expect(
      screen.getByText(/Nothing is consulted until you do/)
    ).toBeInTheDocument();
  });

  it('renders the affectsPlacement:false banner on a READY answer', async () => {
    renderKnowledge(knowledgeReadyFixture);
    await ask();
    await waitFor(() =>
      expect(
        screen.getByText('This context does not affect placement')
      ).toBeInTheDocument()
    );
    expect(screen.getByText('affectsPlacement: false')).toBeInTheDocument();
    expect(
      screen.getByText(/inference workloads may run in approved regions only/)
    ).toBeInTheDocument();
  });

  it('renders the affectsPlacement:false banner on a NOT_INSTALLED answer too', async () => {
    renderKnowledge(knowledgeNotInstalledFixture);
    await ask();
    await waitFor(() =>
      expect(
        screen.getByText('This context does not affect placement')
      ).toBeInTheDocument()
    );
  });

  it('says plainly that nothing was consulted when NOT_INSTALLED', async () => {
    renderKnowledge(knowledgeNotInstalledFixture);
    await ask();
    await waitFor(() =>
      expect(
        screen.getByText('Knowledge base state: NOT_INSTALLED')
      ).toBeInTheDocument()
    );
    expect(
      screen.getByText(/No governed context was consulted and none exists/)
    ).toBeInTheDocument();
    // It must not imply an answer was produced and merely came back empty.
    expect(
      screen.getByText(/The knowledge base is not installed, so nothing was consulted/)
    ).toBeInTheDocument();
  });

  it('reports a SLEEPING base as not consulted, and points at the wake control', async () => {
    renderKnowledge({
      ...knowledgeNotInstalledFixture,
      state: 'SLEEPING',
      detail: null,
    });
    await ask();
    await waitFor(() =>
      expect(
        screen.getByText('Knowledge base state: SLEEPING')
      ).toBeInTheDocument()
    );
    expect(
      screen.getByText(/Wake it from Demo lifecycle before querying/)
    ).toBeInTheDocument();
  });

  it('shows citations when present and says so when absent', async () => {
    const { unmount } = renderKnowledge(knowledgeReadyFixture);
    await ask();
    await waitFor(() =>
      expect(screen.getAllByTestId('knowledge-citation').length).toBe(1)
    );
    unmount();

    renderKnowledge({ ...knowledgeReadyFixture, citations: [] });
    await ask();
    await waitFor(() =>
      expect(
        screen.getByText(/No citations were returned/)
      ).toBeInTheDocument()
    );
  });

  it('surfaces a handled coordinator failure detail verbatim', async () => {
    renderWithProviders(<KnowledgePage />, {
      handler: () =>
        failEnvelope('knowledge', 'invalid_request', 'payload.query is required'),
    });
    await ask();
    await waitFor(() =>
      expect(
        screen.getByText('payload.query is required')
      ).toBeInTheDocument()
    );
  });

  it('disables Ask until a question is typed, with a reason', () => {
    renderKnowledge(knowledgeReadyFixture);
    expectDisabled(screen.getByRole('button', { name: 'Ask' }));
    expect(screen.getAllByText('Enter a question first.').length).toBeGreaterThan(
      0
    );
  });
});
