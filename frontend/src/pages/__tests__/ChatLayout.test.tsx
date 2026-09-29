import { describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WorkspacePage } from '../WorkspacePage';
import type { ChatResponse } from '../../api/types';
import { chatIntakeOnlyFixture, chatWithDecisionFixture } from '../../test/fixtures';
import {
  okEnvelope,
  renderWithProviders,
  streamOnce,
  type ActionHandler,
} from '../../test/harness';

/**
 * Layout structure for the pinned composer.
 *
 * jsdom has no layout engine, so these assert the *structure* that produces the
 * fix — a measured pane height, the thread as the only scroll container, and a
 * non-shrinking composer after it. The pixel acceptance check
 * (`composerViewportY + composerHeight <= window.innerHeight`) is a browser
 * measurement and is not claimed here.
 */

function chatHandler(response: ChatResponse): ActionHandler {
  return (action, _payload, stream) =>
    action === 'chat'
      ? stream
        ? streamOnce(response)
        : okEnvelope(action, response)
      : okEnvelope(action, {});
}

function renderChat(response: ChatResponse) {
  return renderWithProviders(<WorkspacePage />, {
    handler: chatHandler(response),
    withChat: true,
  });
}

function composerBox() {
  return screen.getByRole('textbox', { name: 'Message EDDIE' });
}

async function ask(text: string) {
  await userEvent.type(composerBox(), text);
  await userEvent.click(screen.getByRole('button', { name: 'Send message' }));
}

describe('the chat pane fills the available height rather than the viewport', () => {
  it('sizes the pane from its own offset, not from 100vh', async () => {
    // jsdom reports innerHeight 768 and every rect as 0, so the measured height
    // is innerHeight - top. The point is that it is derived, not a viewport unit.
    renderChat(chatIntakeOnlyFixture);
    await ask('Hello');
    await waitFor(() =>
      expect(screen.getByTestId('chat-pane')).toBeInTheDocument()
    );

    const pane = screen.getByTestId('chat-pane');
    expect(pane.style.height).toMatch(/^\d+px$/);
    // A viewport unit here is exactly the defect: the pane sits below the top
    // navigation and the context strip, so 100vh overhangs by their height.
    expect(pane.getAttribute('style')).not.toContain('vh');
    expect(pane.className).toContain('eddie-chat-pane');
  });

  it('never exceeds the viewport height', async () => {
    renderChat(chatIntakeOnlyFixture);
    await ask('Hello');
    await waitFor(() =>
      expect(screen.getByTestId('chat-pane')).toBeInTheDocument()
    );
    const height = Number(
      screen.getByTestId('chat-pane').style.height.replace('px', '')
    );
    expect(height).toBeLessThanOrEqual(window.innerHeight);
  });

  it('keeps the pane height constant as the conversation grows', async () => {
    renderChat(chatWithDecisionFixture);
    await ask('First turn');
    await waitFor(() =>
      expect(screen.getByText('Placement decision')).toBeInTheDocument()
    );
    const afterOne = screen.getByTestId('chat-pane').style.height;

    await ask('Second turn');
    await waitFor(() =>
      expect(screen.getAllByText('Placement decision').length).toBe(2)
    );
    const afterTwo = screen.getByTestId('chat-pane').style.height;

    // The thread absorbs the growth by scrolling; the pane does not grow, so
    // the composer cannot be pushed past the fold by content.
    expect(afterTwo).toBe(afterOne);
  });
});

describe('the thread is the only scrolling region', () => {
  it('marks the thread scrollable and the composer non-shrinking', async () => {
    renderChat(chatIntakeOnlyFixture);
    await ask('Hello');
    await waitFor(() =>
      expect(screen.getByTestId('chat-thread')).toBeInTheDocument()
    );

    const thread = screen.getByTestId('chat-thread');
    expect(thread.className).toContain('eddie-chat-thread');

    // The composer is a sibling *after* the thread inside the pane, so it is
    // pinned below it rather than being pushed down by the conversation.
    const pane = screen.getByTestId('chat-pane');
    const children = Array.from(pane.children);
    expect(children).toHaveLength(2);
    expect(children[0]).toBe(thread);
    expect(children[1].className).toContain('eddie-chat-composer');
    expect(children[1].contains(composerBox())).toBe(true);
  });

  it('puts the conversation inside the thread, not in the pinned footer', async () => {
    renderChat(chatWithDecisionFixture);
    await ask('Evaluate it');
    await waitFor(() =>
      expect(screen.getByText('Placement decision')).toBeInTheDocument()
    );

    const thread = screen.getByTestId('chat-thread');
    expect(thread.contains(screen.getByText('Evaluate it'))).toBe(true);
    expect(thread.contains(screen.getByText('Placement decision'))).toBe(true);
    // Only the composer and its provenance line are pinned.
    const footer = screen.getByTestId('chat-pane').children[1];
    expect(footer.contains(screen.getByText('Placement decision'))).toBe(false);
  });

  it('keeps the follow-up chips in the thread so the footer stays short', async () => {
    renderChat(chatIntakeOnlyFixture);
    await ask('Hello');
    await waitFor(() =>
      expect(
        screen.getByText(/Follow-up suggestions/)
      ).toBeInTheDocument()
    );
    const thread = screen.getByTestId('chat-thread');
    expect(
      thread.contains(screen.getByText(/Follow-up suggestions/))
    ).toBe(true);
  });

  it('keeps the composer reachable without scrolling after a decision turn', async () => {
    renderChat(chatWithDecisionFixture);
    await ask('Evaluate it');
    await waitFor(() =>
      expect(screen.getByText('Placement decision')).toBeInTheDocument()
    );
    // The composer lives outside the scroll container entirely, so no amount of
    // conversation can move it out of view.
    const thread = screen.getByTestId('chat-thread');
    expect(thread.contains(composerBox())).toBe(false);
  });
});

describe('the empty state is unchanged', () => {
  it('keeps the centred hero composition that already passed on phone', () => {
    renderChat(chatIntakeOnlyFixture);
    expect(screen.getByText('What are you building?')).toBeInTheDocument();
    expect(composerBox()).toBeInTheDocument();
    // No pane wrapper before the first turn: the verified-good hero layout is
    // left exactly as it was.
    expect(screen.queryByTestId('chat-pane')).toBeNull();
    expect(screen.queryByTestId('chat-thread')).toBeNull();
  });
});
