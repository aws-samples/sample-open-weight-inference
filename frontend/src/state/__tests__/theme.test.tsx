import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Mode, applyMode } from '@cloudscape-design/global-styles';
import { AppShell } from '../../components/AppShell';
import { ConversationsProvider } from '../ConversationsContext';
import { healthFixture } from '../../test/fixtures';
import { defaultHandler, renderWithProviders } from '../../test/harness';

vi.mock('@cloudscape-design/global-styles', async () => {
  const actual = await vi.importActual<
    typeof import('@cloudscape-design/global-styles')
  >('@cloudscape-design/global-styles');
  return { ...actual, applyMode: vi.fn() };
});

const applyModeMock = vi.mocked(applyMode);
const STORAGE_KEY = 'eddie.theme-mode';

function setSystemPrefersDark(prefersDark: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: query.includes('dark') ? prefersDark : false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

function renderShell() {
  return renderWithProviders(
    <ConversationsProvider><AppShell>
      <div>content</div>
    </AppShell></ConversationsProvider>,
    { handler: defaultHandler({ health: healthFixture }) }
  );
}

beforeEach(() => {
  applyModeMock.mockClear();
  window.localStorage.clear();
});

afterEach(() => {
  window.localStorage.clear();
});

describe('theme persistence drives applyMode', () => {
  it('applies the persisted dark preference on mount', async () => {
    window.localStorage.setItem(STORAGE_KEY, 'dark');
    setSystemPrefersDark(false);
    renderShell();
    await waitFor(() => expect(applyModeMock).toHaveBeenCalled());
    // The explicit stored choice wins over the OS preference.
    expect(applyModeMock).toHaveBeenLastCalledWith(Mode.Dark);
  });

  it('applies the persisted light preference on mount', async () => {
    window.localStorage.setItem(STORAGE_KEY, 'light');
    setSystemPrefersDark(true);
    renderShell();
    await waitFor(() => expect(applyModeMock).toHaveBeenCalled());
    expect(applyModeMock).toHaveBeenLastCalledWith(Mode.Light);
  });

  it('honours prefers-color-scheme on a first visit with nothing stored', async () => {
    setSystemPrefersDark(false);
    renderShell();
    await waitFor(() => expect(applyModeMock).toHaveBeenCalled());
    expect(applyModeMock).toHaveBeenLastCalledWith(Mode.Light);
  });

  it('defaults to dark when the OS prefers dark and nothing is stored', async () => {
    setSystemPrefersDark(true);
    renderShell();
    await waitFor(() => expect(applyModeMock).toHaveBeenCalled());
    expect(applyModeMock).toHaveBeenLastCalledWith(Mode.Dark);
  });

  it('toggling flips applyMode and persists the new choice', async () => {
    window.localStorage.setItem(STORAGE_KEY, 'dark');
    setSystemPrefersDark(true);
    renderShell();
    await waitFor(() =>
      expect(applyModeMock).toHaveBeenLastCalledWith(Mode.Dark)
    );

    const toggle = screen.getAllByLabelText('Switch to light mode')[0];
    await userEvent.click(toggle);

    await waitFor(() =>
      expect(applyModeMock).toHaveBeenLastCalledWith(Mode.Light)
    );
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('light');

    // And back again, so the control works in both directions.
    await userEvent.click(screen.getAllByLabelText('Switch to dark mode')[0]);
    await waitFor(() =>
      expect(applyModeMock).toHaveBeenLastCalledWith(Mode.Dark)
    );
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('dark');
  });

  it('an explicit choice survives a remount, overriding the OS preference', async () => {
    setSystemPrefersDark(true);
    const first = renderShell();
    await waitFor(() => expect(applyModeMock).toHaveBeenCalled());
    await userEvent.click(screen.getAllByLabelText('Switch to light mode')[0]);
    await waitFor(() =>
      expect(window.localStorage.getItem(STORAGE_KEY)).toBe('light')
    );
    first.unmount();

    applyModeMock.mockClear();
    renderShell();
    await waitFor(() => expect(applyModeMock).toHaveBeenCalled());
    expect(applyModeMock).toHaveBeenLastCalledWith(Mode.Light);
  });
});
