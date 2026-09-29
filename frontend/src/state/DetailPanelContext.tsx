import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

export interface DetailPanelState {
  header: string;
  content: ReactNode;
}

export interface DetailPanelContextValue {
  panel: DetailPanelState | null;
  open: boolean;
  /** Show content in the shell's details surface and reveal it. */
  show: (panel: DetailPanelState) => void;
  close: () => void;
  setOpen: (open: boolean) => void;
}

const DetailPanelContext = createContext<DetailPanelContextValue | null>(null);

/**
 * Lets a page put detail into the shell's split panel.
 *
 * The panel is owned by `AppLayout` in the shell, but the content belongs to the
 * page, so it is passed up through context rather than duplicating an
 * `AppLayout` per route. Cloudscape moves the split panel to the bottom of the
 * viewport at narrow widths, which is the mobile sheet behaviour we want.
 */
export function DetailPanelProvider({ children }: { children: ReactNode }) {
  const [panel, setPanel] = useState<DetailPanelState | null>(null);
  const [open, setOpen] = useState(false);

  const show = useCallback((next: DetailPanelState) => {
    setPanel(next);
    setOpen(true);
  }, []);

  const close = useCallback(() => setOpen(false), []);

  const value = useMemo<DetailPanelContextValue>(
    () => ({ panel, open, show, close, setOpen }),
    [panel, open, show, close]
  );

  return (
    <DetailPanelContext.Provider value={value}>
      {children}
    </DetailPanelContext.Provider>
  );
}

export function useDetailPanel(): DetailPanelContextValue {
  const value = useContext(DetailPanelContext);
  if (!value) {
    throw new Error('useDetailPanel must be used inside <DetailPanelProvider>.');
  }
  return value;
}
