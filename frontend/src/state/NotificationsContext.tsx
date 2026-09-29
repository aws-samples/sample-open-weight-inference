import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { FlashbarProps } from '@cloudscape-design/components/flashbar';

export type NotificationType = 'error' | 'warning' | 'success' | 'info';

export interface NotifyInput {
  type: NotificationType;
  header: string;
  content?: ReactNode;
  /** Stable id — publishing the same id twice replaces the earlier message. */
  id?: string;
}

export interface NotificationsContextValue {
  items: FlashbarProps.MessageDefinition[];
  notify: (input: NotifyInput) => string;
  dismiss: (id: string) => void;
  clearAll: () => void;
}

const NotificationsContext = createContext<NotificationsContextValue | null>(
  null
);

let autoId = 0;

export function NotificationsProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<FlashbarProps.MessageDefinition[]>([]);

  const dismiss = useCallback((id: string) => {
    setItems((current) => current.filter((item) => item.id !== id));
  }, []);

  const clearAll = useCallback(() => setItems([]), []);

  const notify = useCallback(
    (input: NotifyInput) => {
      const id = input.id ?? `notification-${++autoId}`;
      const message: FlashbarProps.MessageDefinition = {
        id,
        type: input.type,
        header: input.header,
        content: input.content,
        dismissible: true,
        dismissLabel: `Dismiss ${input.header}`,
        onDismiss: () => dismiss(id),
      };
      setItems((current) => [
        message,
        ...current.filter((item) => item.id !== id),
      ]);
      return id;
    },
    [dismiss]
  );

  const value = useMemo<NotificationsContextValue>(
    () => ({ items, notify, dismiss, clearAll }),
    [items, notify, dismiss, clearAll]
  );

  return (
    <NotificationsContext.Provider value={value}>
      {children}
    </NotificationsContext.Provider>
  );
}

export function useNotifications(): NotificationsContextValue {
  const value = useContext(NotificationsContext);
  if (!value) {
    throw new Error(
      'useNotifications must be used inside <NotificationsProvider>.'
    );
  }
  return value;
}
