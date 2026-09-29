import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  clearCase,
  listCaseIds,
  listSavedConversations,
  loadCase,
  rememberRemovedProjects,
  removedProjectIds,
  saveCase,
  storageKey,
} from '../persistence';
import { DEFAULT_FORM, EMPTY_PROJECT } from '../caseForm';
import { CaseProvider, useCase } from '../CaseContext';
import { useChat } from '../ChatContext';
import { burstyResult, chatWithDecisionFixture, configFixture } from '../../test/fixtures';
import {
  okEnvelope,
  renderWithProviders,
  streamOnce,
  type ActionHandler,
} from '../../test/harness';

const SCOPE = {
  userPoolId: configFixture.userPoolId,
  sub: 'sub-test-user-0001',
  caseId: 'case-001',
};

beforeEach(() => window.localStorage.clear());
afterEach(() => window.localStorage.clear());

describe('storage scoping', () => {
  it('keys on the user pool, the Cognito subject and the case id', () => {
    const key = storageKey(SCOPE) as string;
    expect(key).toContain(configFixture.userPoolId);
    expect(key).toContain('sub-test-user-0001');
    expect(key).toContain('case-001');
  });

  it('refuses to persist when there is no subject to isolate users by', () => {
    // A shared bucket would let one signed-in user read another's case.
    expect(storageKey({ ...SCOPE, sub: null })).toBeNull();
    expect(saveCase({ ...SCOPE, sub: null }, blank())).toBeNull();
    expect(loadCase({ ...SCOPE, sub: null }).data).toBeNull();
  });

  it('isolates one user from another in the same browser', () => {
    saveCase(SCOPE, { ...blank(), draft: 'first user draft' });
    const other = { ...SCOPE, sub: 'sub-other-user' };
    expect(loadCase(other).data).toBeNull();

    saveCase(other, { ...blank(), draft: 'second user draft' });
    expect(loadCase(SCOPE).data?.draft).toBe('first user draft');
    expect(loadCase(other).data?.draft).toBe('second user draft');
  });

  it('isolates one case from another for the same user', () => {
    saveCase(SCOPE, { ...blank(), draft: 'case one' });
    saveCase({ ...SCOPE, caseId: 'case-002' }, { ...blank(), draft: 'case two' });
    expect(loadCase(SCOPE).data?.draft).toBe('case one');
    expect(listCaseIds(SCOPE)).toEqual(['case-001', 'case-002']);
  });

  it('never writes a token or credential', () => {
    saveCase(SCOPE, {
      ...blank(),
      draft: 'a draft',
    });
    const raw = window.localStorage.getItem(storageKey(SCOPE) as string) ?? '';
    expect(raw).not.toContain('accessToken');
    expect(raw).not.toContain('idToken');
    expect(raw).not.toContain('Bearer');
  });
});

function blank() {
  return {
    form: DEFAULT_FORM,
    decision: null,
    turns: [],
    draft: '',
  };
}

describe('round trip', () => {
  it('restores the form, decision and draft', () => {
    const decision = {
      decision: burstyResult,
      evaluatedRequest: burstyResult.evaluatedRequest,
      evaluatedRequestHash: burstyResult.evaluatedRequestHash,
      at: 1,
      source: 'chat' as const,
    };
    saveCase(SCOPE, {
      form: { ...DEFAULT_FORM, horizonHours: '720' },
      decision,
      turns: [
        {
          id: 't1',
          prompt: 'Where should I host this?',
          reply: 'Here is the answer.',
          changedFields: ['Horizon (hours)'],
          decision: burstyResult,
          toolCallSummary: [{ name: 'evaluate_placement', status: 'success' }],
          truncated: false,
          advisorModelId: 'model-x',
          at: 2,
        },
      ],
      draft: 'an unsent message',
    });

    const { data, problem } = loadCase(SCOPE);
    expect(problem).toBeNull();
    expect(data?.form.horizonHours).toBe('720');
    expect(data?.decision?.evaluatedRequestHash).toBe(
      burstyResult.evaluatedRequestHash
    );
    // The request itself is persisted too, so staleness survives a refresh.
    expect(data?.decision?.evaluatedRequest).not.toBeNull();
    expect(data?.turns).toHaveLength(1);
    expect(data?.draft).toBe('an unsent message');
  });

  it('reports a corrupt payload rather than silently starting fresh', () => {
    window.localStorage.setItem(storageKey(SCOPE) as string, '{not json');
    const { data, problem } = loadCase(SCOPE);
    expect(data).toBeNull();
    expect(problem?.kind).toBe('load');
    expect(problem?.message).toContain('could not be parsed');
  });

  it('reports an incompatible stored version rather than half-reading it', () => {
    window.localStorage.setItem(
      storageKey(SCOPE) as string,
      JSON.stringify({ version: 999, caseId: 'case-001' })
    );
    const { data, problem } = loadCase(SCOPE);
    expect(data).toBeNull();
    expect(problem?.message).toContain('earlier version');
  });

  it('reports a save failure explicitly', () => {
    const setItem = vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation((key: string) => {
        if (String(key).includes('probe')) return;
        throw new Error('QuotaExceededError: quota exceeded');
      });
    const problem = saveCase(SCOPE, blank());
    expect(problem?.kind).toBe('save');
    expect(problem?.message).toContain('storage is full');
    setItem.mockRestore();
  });

  it('clears a case on request', () => {
    saveCase(SCOPE, blank());
    expect(loadCase(SCOPE).data).not.toBeNull();
    clearCase(SCOPE);
    expect(loadCase(SCOPE).data).toBeNull();
  });

  it('discards only the requested user and project backup', () => {
    const otherProject = { ...SCOPE, caseId: 'case-002' };
    const otherUser = { ...SCOPE, sub: 'another-user' };
    for (const scope of [SCOPE, otherProject, otherUser]) saveCase(scope, blank());
    expect(clearCase(SCOPE)).toBeNull();
    expect(loadCase(SCOPE).data).toBeNull();
    expect(loadCase(otherProject).data).not.toBeNull();
    expect(loadCase(otherUser).data).not.toBeNull();
  });

  it('reports a failed discard so navigation can keep the draft open', () => {
    saveCase(SCOPE, blank());
    const remove = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('Storage is blocked');
    });
    try {
      expect(clearCase(SCOPE)?.message).toContain('Could not discard the browser draft');
      expect(loadCase(SCOPE).data).not.toBeNull();
    } finally {
      remove.mockRestore();
    }
  });

  it('keeps removed drafts out after a late write and isolates removal by account and project', () => {
    const other = { ...SCOPE, caseId: 'keep' };
    const otherUser = { ...SCOPE, sub: 'another-user' };
    const otherPool = { ...SCOPE, userPoolId: 'another-pool' };
    for (const scope of [SCOPE, other, otherUser, otherPool]) saveCase(scope, blank());
    rememberRemovedProjects(SCOPE, [SCOPE.caseId]);
    saveCase(SCOPE, { ...blank(), draft: 'Late chat completion' });
    expect(loadCase(SCOPE).data).toBeNull();
    expect(removedProjectIds(SCOPE)).toEqual([SCOPE.caseId]);
    expect(listSavedConversations(SCOPE).map((item) => item.id)).toEqual(['keep']);
    for (const scope of [other, otherUser, otherPool]) expect(loadCase(scope).data).not.toBeNull();
  });
});

/* ------------------------------------------------- through the providers */

function Probe() {
  const { draft, setDraft, result, form } = useCase();
  const { turns } = useChat();
  return (
    <div>
      <span data-testid="draft">{draft}</span>
      <span data-testid="horizon">{form.horizonHours}</span>
      <span data-testid="result">
        {result?.evaluatedRequestHash ?? 'none'}
      </span>
      <span data-testid="turns">{turns.length}</span>
      <button onClick={() => setDraft('typed but unsent')}>type draft</button>
    </div>
  );
}

function Sender() {
  const { send } = useChat();
  return <button onClick={() => void send('Evaluate this')}>chat send</button>;
}

function handler(): ActionHandler {
  return (action, _payload, stream) =>
    action.startsWith('case.') || action.startsWith('chat.')
      ? okEnvelope(action, {})
      : stream
      ? streamOnce(chatWithDecisionFixture)
      : okEnvelope(action, chatWithDecisionFixture);
}

describe('CHAT-04: a case survives a remount', () => {
  it('recovers the transcript, the decision and the draft', async () => {
    const first = renderWithProviders(
      <>
        <Sender />
        <Probe />
      </>,
      { handler: handler(), withChat: true }
    );

    await userEvent.click(screen.getByRole('button', { name: 'chat send' }));
    await waitFor(() =>
      expect(screen.getByTestId('result')).toHaveTextContent(
        burstyResult.evaluatedRequestHash as string
      )
    );
    await userEvent.click(screen.getByRole('button', { name: 'type draft' }));
    await waitFor(() =>
      expect(screen.getByTestId('draft')).toHaveTextContent('typed but unsent')
    );

    // Simulate a refresh: unmount everything and mount fresh providers.
    first.unmount();

    renderWithProviders(<Probe />, { handler: handler(), withChat: true });

    await waitFor(() =>
      expect(screen.getByTestId('result')).toHaveTextContent(
        burstyResult.evaluatedRequestHash as string
      )
    );
    expect(screen.getByTestId('draft')).toHaveTextContent('typed but unsent');
    expect(screen.getByTestId('turns')).toHaveTextContent('1');
  });

  it('does not restore a different subject as the same case', async () => {
    const first = renderWithProviders(<Probe />, {
      handler: handler(),
      withChat: true,
    });
    await userEvent.click(screen.getByRole('button', { name: 'type draft' }));
    await waitFor(() =>
      expect(screen.getByTestId('draft')).toHaveTextContent('typed but unsent')
    );
    first.unmount();

    // A different Cognito subject must see an empty case.
    const { FakeAuthClient, makeSession } = await import('../../test/harness');
    renderWithProviders(<Probe />, {
      handler: handler(),
      withChat: true,
      auth: new FakeAuthClient({
        initial: makeSession({ sub: 'sub-someone-else', username: 'other' }),
      }),
    });

    await waitFor(() =>
      expect(screen.getByTestId('turns')).toHaveTextContent('0')
    );
    expect(screen.getByTestId('draft').textContent).toBe('');
  });
});


function ScopeEditor() {
  const { form, patch, draft, setDraft, restoredKey } = useCase();
  return <>
    <output data-testid="scope-ready">{restoredKey}</output>
    <output data-testid="scope-goal">{form.description}</output>
    <output data-testid="scope-draft">{draft}</output>
    <button onClick={() => { patch({ description: 'First project only' }); setDraft('First draft only'); }}>Edit first project</button>
  </>;
}
function ScopeSwitcher() {
  const [id, setId] = useState('case-001');
  return <>
    <button onClick={() => setId('case-002')}>Open empty second project</button>
    <CaseProvider caseId={id}><ScopeEditor /></CaseProvider>
  </>;
}

it('never writes the old project into a newly selected project before restoration commits', async () => {
  const writes = vi.spyOn(Storage.prototype, 'setItem');
  renderWithProviders(<ScopeSwitcher />);
  await waitFor(() => expect(screen.getByTestId('scope-ready')).toHaveTextContent('case-001'));
  await userEvent.click(screen.getByRole('button', { name: 'Edit first project' }));
  await waitFor(() => expect(loadCase(SCOPE).data?.form.description).toBe('First project only'));
  writes.mockClear();
  await userEvent.click(screen.getByRole('button', { name: 'Open empty second project' }));
  await waitFor(() => expect(screen.getByTestId('scope-ready')).toHaveTextContent('case-002'));
  expect(screen.getByTestId('scope-goal').textContent).toBe(EMPTY_PROJECT.description);
  expect(screen.getByTestId('scope-draft').textContent).toBe('');
  const otherKey = storageKey({ ...SCOPE, caseId: 'case-002' });
  const otherWrites = writes.mock.calls.filter(([key]) => key === otherKey).map(([, value]) => value);
  expect(otherWrites.length).toBeGreaterThan(0);
  expect(otherWrites.every((value) => !value.includes('First project only') && !value.includes('First draft only'))).toBe(true);
  expect(loadCase(SCOPE).data?.form.description).toBe('First project only');
  writes.mockRestore();
});
