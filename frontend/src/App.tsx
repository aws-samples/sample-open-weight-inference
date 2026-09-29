import { BrandName } from './components/BrandName';
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import Alert from '@cloudscape-design/components/alert';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import ContentLayout from '@cloudscape-design/components/content-layout';
import Header from '@cloudscape-design/components/header';
import Modal from '@cloudscape-design/components/modal';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Spinner from '@cloudscape-design/components/spinner';
import type { AgentCoreClient } from './api/agentcore';
import { AppShell } from './components/AppShell';
import { AppProvider } from './state/AppContext';
import { CaseProvider, useCase } from './state/CaseContext';
import { EMPTY_PROJECT } from './state/caseForm';
import { ChatProvider } from './state/ChatContext';
import { ConversationsProvider, useConversations } from './state/ConversationsContext';
import { DetailPanelProvider } from './state/DetailPanelContext';
import { useAuth } from './auth/AuthContext';
import { SignInPage } from './pages/SignInPage';
import type { RuntimeConfig } from './api/types';

/**
 * Routing after the UXR-01 redesign.
 *
 * Project details are the main surface. Chat is optional in the Advisor panel.
 * Earlier conversation links (`/c/:id`) still restore the same saved project, but
 * now open its details. Deployments is the other primary destination.
 *
 * Every old path still resolves. UXR-13 requires that the redesign does not break a
 * bookmark or a shared link, so `/case`, `/comparison`, `/catalog`, `/rates`,
 * `/knowledge`, `/demo` and `/about` redirect to where their function now lives rather
 * than to a 404.
 */

const RequirementsPage = lazy(() => import('./pages/RequirementsPage'));
const DeploymentsPage = lazy(() => import('./pages/DeploymentsPage'));
const SettingsPage = lazy(() => import('./pages/SettingsPage'));
const ToolsPage = lazy(() => import('./pages/ToolsPage'));
const AboutPage = lazy(() => import('./pages/AboutPage'));

function RouteFallback() {
  return (
    <Box textAlign="center" padding={{ vertical: 'xxxl' }}>
      <SpaceBetween size="s">
        <Spinner size="large" />
        <Box variant="p" color="text-body-secondary">
          Loading.
        </Box>
      </SpaceBetween>
    </Box>
  );
}

function NotFound() {
  return (
    <ContentLayout header={<Header variant="h1">Page not found</Header>}>
      <Alert
        type="warning"
        statusIconAriaLabel="Warning"
        header="No such page"
        action={
          <Button href="/" variant="primary">
            Go to Workspace
          </Button>
        }
      >
        <BrandName /> has two main places: the Workspace, where you describe what you are
        building, and Deployments, which shows what is running.
      </Alert>
    </ContentLayout>
  );
}

function RestoringSession() {
  return (
    <Box textAlign="center" padding={{ vertical: 'xxxl' }}>
      <SpaceBetween size="s">
        <Spinner size="large" />
        <Box variant="h3"><BrandName /></Box>
        <Box variant="p" color="text-body-secondary">
          Restoring your session.
        </Box>
      </SpaceBetween>
    </Box>
  );
}

function LegacyRedirect({ to }: { to: string }) {
  const { search, hash } = useLocation();
  return <Navigate to={{ pathname: to, search, hash }} replace />;
}

function CaseSwitchGuard({ targetCase, switchCase, stay }: {
  targetCase: string;
  switchCase: () => void;
  stay: () => void;
}) {
  const { caseId, form, draft, persistedTurns, evaluationDraft, projectSave: save } = useCase();
  const hasWork = Boolean(draft || persistedTurns.length ||
    evaluationDraft.rows.some((row) => row.input || row.expected || row.actual) ||
    JSON.stringify({ ...form, caseId: '' }) !== JSON.stringify({ ...EMPTY_PROJECT, caseId: '' }));
  const changing = targetCase !== caseId;
  const needsConfirmation = changing && save.dirty && hasWork;
  useEffect(() => {
    if (changing && !needsConfirmation && !save.loading) switchCase();
  }, [changing, needsConfirmation, save.loading, switchCase]);
  return <Modal visible={needsConfirmation} onDismiss={stay}
    header="Save this project before leaving?"
    footer={<SpaceBetween direction="horizontal" size="s">
      <Button formAction="none" onClick={stay}>Stay here</Button>
      <Button formAction="none" onClick={save.download} iconName="download">Download draft</Button>
      <Button formAction="none" disabled={save.saving}
        onClick={() => { if (save.discardBeforeLeaving()) switchCase(); }}>Leave without saving</Button>
      <Button formAction="none" variant="primary" loading={save.saving}
        disabled={save.loading || save.conflict}
        onClick={async () => { if (await save.save()) switchCase(); }}>Save and open project</Button>
    </SpaceBetween>}>
    <SpaceBetween size="s">
      <div>Your latest project changes have not been saved to your account.</div>
      {save.error ? <Alert type="warning">{save.error} Stay here to resolve the issue, or download your draft.</Alert> : null}
    </SpaceBetween>
  </Modal>;
}

function RoutedCase({ children }: { children: ReactNode }) {
  const location = useLocation();
  const navigate = useNavigate();
  const { conversations, removedIds } = useConversations();
  const params = new URLSearchParams(location.search);
  const pathCase = location.pathname.match(/^\/c\/([A-Za-z0-9_-]{1,100})$/)?.[1];
  const queryCase = params.get('case');
  const requestedCase = pathCase ?? (queryCase && /^[A-Za-z0-9_-]{1,100}$/.test(queryCase) ? queryCase : null);
  const freshCase = useMemo(() => `project-${crypto.randomUUID()}`, [location.key]);
  const [activeCase, setActiveCase] = useState(
    () => requestedCase ?? (location.pathname === '/new' ? freshCase : 'case-001')
  );
  const selectedCase = location.pathname === '/new' ? freshCase : requestedCase ?? activeCase;
  const activeRemoved = removedIds.has(activeCase);
  const selectedRemoved = removedIds.has(selectedCase);
  const stableLocation = useRef({ pathname: location.pathname, search: location.search });
  if (selectedCase === activeCase) {
    stableLocation.current = { pathname: location.pathname, search: location.search };
  }
  const switchCase = useCallback(() => {
    setActiveCase(selectedCase);
    if (location.pathname === '/new') navigate(`/requirements?case=${encodeURIComponent(selectedCase)}&view=needs`, { replace: true });
  }, [selectedCase, location.pathname, navigate]);
  const stay = useCallback(() => navigate(stableLocation.current, { replace: true }), [navigate]);
  useEffect(() => {
    if (activeRemoved) {
      // Removal already confirmed discarding this draft. Do not offer to save it
      // again, and do not remount its chat/session from an old history link.
      const next = conversations.find((item) => !removedIds.has(item.id))?.id
        ?? `project-${crypto.randomUUID()}`;
      setActiveCase(next);
      navigate(`/requirements?case=${encodeURIComponent(next)}&view=needs`, { replace: true });
    } else if (selectedRemoved) {
      stay();
    }
  }, [activeRemoved, selectedRemoved, conversations, removedIds, navigate, stay]);
  useEffect(() => {
    if (activeRemoved || selectedRemoved) return;
    if (location.pathname === '/new' && selectedCase === activeCase) {
      navigate(`/requirements?case=${encodeURIComponent(selectedCase)}&view=needs`, { replace: true });
      return;
    }
    if (selectedCase === activeCase && selectedCase !== 'case-001' && !requestedCase &&
        ['/', '/requirements'].includes(location.pathname)) {
      // Add the project only on canonical workspace routes. Updating a legacy
      // URL here races its redirect and can leave Navigate's empty view mounted.
      const next = new URLSearchParams(location.search);
      next.set('case', selectedCase);
      navigate({ pathname: location.pathname, search: next.toString() }, { replace: true });
    }
  }, [selectedCase, activeCase, requestedCase, location.pathname, location.search, navigate,
    activeRemoved, selectedRemoved]);
  // Keep the current provider alive until leaving is resolved. This also covers
  // browser back/forward, not only clicks on the side navigation.
  return <CaseProvider key={activeCase} caseId={activeCase}>
    {!activeRemoved && !selectedRemoved
      ? <CaseSwitchGuard targetCase={selectedCase} switchCase={switchCase} stay={stay} />
      : null}
    {children}
  </CaseProvider>;
}

/**
 * The authenticated application.
 *
 * There is no unauthenticated view other than sign-in: the AgentCore runtime is invoked
 * directly from the browser with the user's own token, so without a session there is
 * nothing to show.
 */
function ProjectAppShell({ children }: { children: ReactNode }) {
  const { caseId } = useCase();
  return <AppShell caseId={caseId}>{children}</AppShell>;
}

export function App({
  config,
  client,
}: {
  config: RuntimeConfig;
  /** Injectable transport, for tests. Production builds it from the config. */
  client?: AgentCoreClient;
}) {
  const { status } = useAuth();

  if (status === 'RESTORING') return <RestoringSession />;
  if (status !== 'SIGNED_IN') return <SignInPage config={config} />;

  return (
    <AppProvider config={config} client={client}>
      <ConversationsProvider>
        <RoutedCase>
          {/* Chat sits inside CaseProvider so an advisor patch updates the same case
              revision the requirements editor shows. */}
          <ChatProvider>
            <DetailPanelProvider>
              <ProjectAppShell>
                <Suspense fallback={<RouteFallback />}>
                  <Routes>
                    <Route path="/" element={<RequirementsPage />} />
                    {/* Existing conversation bookmarks now open project details. */}
                    <Route path="/c/:conversationId" element={<RequirementsPage />} />
                    <Route path="/new" element={<RequirementsPage />} />
                    <Route path="/requirements" element={<RequirementsPage />} />
                    <Route path="/deployments" element={<DeploymentsPage />} />
                    <Route path="/settings" element={<SettingsPage />} />
                    <Route path="/tools/:toolId" element={<ToolsPage />} />
                    <Route path="/about" element={<AboutPage />} />

                    {/* ---- legacy paths, preserved (UXR-13) ---- */}
                    {/* The old dedicated case page, which is what /requirements is. */}
                    <Route
                      path="/case"
                      element={<LegacyRedirect to="/requirements" />}
                    />
                    {/* Comparison opens from a decision in the conversation. */}
                    <Route
                      path="/comparison"
                      element={<LegacyRedirect to="/" />}
                    />
                    <Route
                      path="/catalog"
                      element={<LegacyRedirect to="/tools/find-model" />}
                    />
                    <Route
                      path="/rates"
                      element={<LegacyRedirect to="/tools/compare-prices" />}
                    />
                    <Route
                      path="/knowledge"
                      element={<LegacyRedirect to="/settings" />}
                    />
                    <Route
                      path="/demo"
                      element={<LegacyRedirect to="/settings" />}
                    />
                    <Route
                      path="/index.html"
                      element={<LegacyRedirect to="/" />}
                    />
                    <Route path="*" element={<NotFound />} />
                  </Routes>
                </Suspense>
              </ProjectAppShell>
            </DetailPanelProvider>
          </ChatProvider>
        </RoutedCase>
      </ConversationsProvider>
    </AppProvider>
  );
}

export default App;
