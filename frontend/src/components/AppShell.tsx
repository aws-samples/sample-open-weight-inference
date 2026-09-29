import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import AppLayout from '@cloudscape-design/components/app-layout';
import Alert from '@cloudscape-design/components/alert';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import ExpandableSection from '@cloudscape-design/components/expandable-section';
import Flashbar from '@cloudscape-design/components/flashbar';
import HelpPanel from '@cloudscape-design/components/help-panel';
import Link from '@cloudscape-design/components/link';
import Modal from '@cloudscape-design/components/modal';
import SideNavigation, {
  type SideNavigationProps,
} from '@cloudscape-design/components/side-navigation';
import SplitPanel from '@cloudscape-design/components/split-panel';
import SpaceBetween from '@cloudscape-design/components/space-between';
import TopNavigation from '@cloudscape-design/components/top-navigation';
import { useApp } from '../state/AppContext';
import { useConversations, type ConversationSummary } from '../state/ConversationsContext';
import { useDetailPanel } from '../state/DetailPanelContext';
import { useAuth } from '../auth/AuthContext';
import { useNotifications } from '../state/NotificationsContext';
import { EDDIE_WORDMARK } from './brand';
import { BrandName } from './BrandName';

/**
 * The shell, rebuilt to UXR-01.
 *
 * Two primary destinations, not eight. The product owner could not understand the
 * previous navigation, which offered Chat, Case workspace, Comparison, Price evidence,
 * Model catalog, Knowledge, Demo lifecycle and About as peers — so a person arriving to
 * ask "where should I run Qwen?" had to work out which of eight places to start in, and
 * three of them were engineering diagnostics.
 *
 * Now: **Workspace** is where the work happens, **Deployments** is what is running.
 * Everything else is reachable from inside the workspace or from Tools and Settings,
 * which are utilities rather than destinations. Knowledge administration and EDDIE's own
 * infrastructure sleep/wake are settings: they are not places a user deploys a model.
 *
 * The diagnostics strip is gone from first use. Region, solver version, release hash,
 * COA state and demo state were displayed on every screen including the empty one; none
 * of them helps someone describe an application, and their presence was most of what
 * made the interface read as a console. They live in Settings, and a *problem* surfaces
 * where it is relevant with a recovery action.
 */

/** How many saved conversations to list before collapsing the rest. */
const RECENT_LIMIT = 8;

function buildNavItems(options: {
  attentionCount: number;
  caseId?: string;
}): SideNavigationProps.Item[] {
  return [
    { type: 'divider' },
    {
      // Manual entry as a real destination. UXR-01 specified two; the product owner
      // asked for this one back as a page rather than a side panel, because the form is
      // a task that needs the window rather than a detail to glance at.
      type: 'link',
      text: 'Project workspace',
      href: options.caseId ? `/requirements?case=${encodeURIComponent(options.caseId)}&view=needs` : '/requirements',
    },
    {
      type: 'link',
      text: 'Deployments',
      href: '/deployments',
      // The one badge worth carrying in navigation: something needs attention and is
      // probably costing money. Absent when there is nothing wrong.
      info:
        options.attentionCount > 0 ? (
          <Box color="text-status-warning" fontSize="body-s">
            {options.attentionCount} need attention
          </Box>
        ) : undefined,
    }
  ];
}

/** The global shell: identity, two destinations, notifications, contextual panel. */
export function AppShell({ children, caseId }: { children: ReactNode; caseId?: string }) {
  const { mode, toggleMode } = useApp();
  const { session, signOut, busy } = useAuth();
  const { items, notify } = useNotifications();
  const { conversations, attentionCount, remove } = useConversations();
  const navigate = useNavigate();
  const location = useLocation();
  const [navOpen, setNavOpen] = useState(
    () => window.innerWidth > 688
  );
  const [helpOpen, setHelpOpen] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<ConversationSummary | null>(null);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const { panel, open: detailOpen, setOpen: setDetailOpen } = useDetailPanel();
  const followNavigation = (href: string) => {
    if (window.innerWidth <= 688) setNavOpen(false);
    navigate(href);
  };
  const confirmRemove = async () => {
    if (!removeTarget || removing) return;
    setRemoving(true);
    setRemoveError(null);
    try {
      await remove(removeTarget.id);
      setRemoveTarget(null);
      notify({ id: 'project-removed', type: 'success', header: 'Project removed',
        content: 'Removed from Recent and your project list.' });
    } catch (cause) {
      setRemoveError(cause instanceof Error ? cause.message : 'Could not remove the project. Please try again.');
    } finally {
      setRemoving(false);
    }
  };

  // Escape closes the navigation drawer. At phone width the drawer covers the page, so
  // leaving it open would trap the reader on a screen whose main heading is then
  // outside the accessible tree.
  useEffect(() => {
    if (!navOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setNavOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [navOpen]);

  const identityLabel = session?.email ?? session?.username ?? null;

  const navItems = useMemo(
    () =>
      buildNavItems({
        attentionCount,
        caseId,
      }),
    [attentionCount, caseId]
  );

  const utilities = useMemo(() => {
    const list: Array<Record<string, unknown>> = [
      {
        type: 'menu-dropdown',
        iconName: 'suggestions',
        text: 'Tools',
        ariaLabel: 'Tools',
        // Each tool opens the same typed service the conversation calls, so a direct
        // GPU question does not require filling in a model intake form first.
        items: [
          { id: 'find-model', text: 'Find a model' },
          { id: 'find-gpu', text: 'Find GPU capacity' },
          { id: 'compare-prices', text: 'Compare prices' },
          { id: 'test-endpoint', text: 'Test an endpoint' },
          { id: 'reports', text: 'Reports' },
        ],
        onItemClick: (event: { detail: { id: string } }) => {
          navigate(`/tools/${event.detail.id}`);
        },
      },
      {
        type: 'button',
        iconName: 'light-dark',
        text: mode === 'dark' ? 'Light mode' : 'Dark mode',
        ariaLabel:
          mode === 'dark' ? 'Switch to light mode' : 'Switch to dark mode',
        disableUtilityCollapse: true,
        onClick: toggleMode,
      },
    ];
    if (identityLabel) {
      list.push({
        type: 'menu-dropdown',
        iconName: 'user-profile',
        text: identityLabel,
        description: identityLabel,
        ariaLabel: `Signed in as ${identityLabel}`,
        items: [
          { id: 'settings', text: 'Settings', iconName: 'settings' },
          { id: 'help', text: 'How decisions are made', iconName: 'status-info' },
          { id: 'signout', text: 'Sign out', iconName: 'sign-out', disabled: busy },
        ],
        onItemClick: (event: { detail: { id: string } }) => {
          if (event.detail.id === 'signout') void signOut();
          if (event.detail.id === 'settings') navigate('/settings');
          if (event.detail.id === 'help') setHelpOpen(true);
        },
      });
    }
    return list as never;
  }, [mode, toggleMode, identityLabel, busy, signOut, navigate]);

  return (
    <>
      <div id="eddie-top-navigation">
        <TopNavigation
          identity={{
            href: '/',
            // No `title`: Cloudscape renders logo and title side by side, and the
            // wordmark already spells EDDIE, so setting both printed it twice.
            logo: { src: EDDIE_WORDMARK, alt: 'EDDIE' },
            onFollow: (event) => {
              event.preventDefault();
              navigate('/');
            },
          }}
          i18nStrings={{
            overflowMenuTriggerText: 'More',
            overflowMenuTitleText: 'All',
            searchIconAriaLabel: 'Search',
            searchDismissIconAriaLabel: 'Close search',
          }}
          utilities={utilities}
        />
      </div>
      <AppLayout
        headerSelector="#eddie-top-navigation"
        navigationOpen={navOpen}
        onNavigationChange={({ detail }) => setNavOpen(detail.open)}
        toolsOpen={helpOpen}
        onToolsChange={({ detail }) => setHelpOpen(detail.open)}
        ariaLabels={{
          navigation: 'Side navigation',
          navigationToggle: 'Open side navigation',
          navigationClose: 'Close side navigation',
          notifications: 'Notifications',
          tools: 'Help panel',
          toolsToggle: 'Open help panel',
          toolsClose: 'Close help panel',
        }}
        notifications={<Flashbar items={items} stackItems />}
        splitPanelOpen={detailOpen && panel !== null}
        onSplitPanelToggle={({ detail }) => setDetailOpen(detail.open)}
        splitPanelPreferences={{ position: 'side' }}
        splitPanel={
          panel ? (
            <SplitPanel
              header={panel.header === 'EDDIE Advisor' ? 'Advisor' : panel.header}
              headerBefore={panel.header === 'EDDIE Advisor' ? <BrandName /> : undefined}
              i18nStrings={{
                preferencesTitle: 'Panel preferences',
                preferencesPositionLabel: 'Panel position',
                preferencesPositionDescription:
                  'Choose where this panel appears.',
                preferencesPositionSide: 'Side',
                preferencesPositionBottom: 'Bottom',
                preferencesConfirm: 'Confirm',
                preferencesCancel: 'Cancel',
                closeButtonAriaLabel: 'Close panel',
                openButtonAriaLabel: 'Open panel',
                resizeHandleAriaLabel: 'Resize this panel',
              }}
            >
              {panel.content}
            </SplitPanel>
          ) : undefined
        }
        navigation={
          <SideNavigation
            itemsControl={
              <div className="eddie-conversation-navigation">
                <Link href="/new" variant="secondary" className="eddie-history-link"
                  style={{ root: { color: { default: 'currentColor' } } }}
                  onFollow={(event) => { event.preventDefault(); followNavigation('/new'); }}>
                  <span className="eddie-history-title">New project</span>
                </Link>
                {conversations.length > 0 ? (
                  <ExpandableSection variant="footer" defaultExpanded headerText="Recent">
                    <ul className="eddie-history-list" aria-label="Recent projects">
                      {conversations.slice(0, RECENT_LIMIT).map((conversation) => {
                        const href = `/requirements?case=${encodeURIComponent(conversation.id)}&view=needs`;
                        const active = caseId === conversation.id;
                        return (
                          <li key={conversation.id} className="eddie-history-item" data-active={active}>
                            <Link href={href} variant="secondary" className="eddie-history-link"
                              style={active ? undefined : { root: { color: { default: 'currentColor' } } }}
                              nativeAttributes={{ title: conversation.title, 'aria-current': active ? 'page' : undefined }}
                              onFollow={(event) => { event.preventDefault(); followNavigation(href); }}>
                              <span className="eddie-history-title">{conversation.title}</span>
                            </Link>
                            <Button variant="icon" iconName="remove" formAction="none"
                              ariaLabel={`Remove ${conversation.title}`}
                              nativeButtonAttributes={{ title: 'Remove' }}
                              onClick={() => { setRemoveError(null); setRemoveTarget(conversation); }}
                            />
                          </li>
                        );
                      })}
                    </ul>
                  </ExpandableSection>
                ) : null}
              </div>
            }
            activeHref={location.pathname === '/requirements' && caseId
              ? `/requirements?case=${encodeURIComponent(caseId)}&view=needs`
              : location.pathname}
            items={navItems}
            onFollow={(event) => {
              if (event.detail.external) return;
              event.preventDefault();
              followNavigation(event.detail.href);
            }}
          />
        }
        tools={
          <HelpPanel header={<h2>How <BrandName /> decides</h2>}>
            <SpaceBetween size="m">
              <div>
                <h3>How often you use it decides the cost</h3>
                <p>
                  A three-day event with six hours of real traffic pays only for
                  the hours a copy is present, which suits importing the model
                  into Amazon Bedrock. A service that runs all the time holds an
                  instance continuously, which suits a managed SageMaker
                  endpoint. The break-even is where the two costs meet.
                </p>
              </div>
              <div>
                <h3>A response-time target rules options out</h3>
                <p>
                  It is not a penalty. An option that cannot meet your target is
                  excluded rather than scored slightly worse, and a cheaper
                  option cannot buy its way past it. Keeping a copy warm is a
                  different, more expensive option that needs its own testing.
                </p>
              </div>
              <div>
                <h3>What has been tested, and what has not</h3>
                <p>
                  <b>Tested here</b> means <BrandName /> observed it for this exact
                  configuration. <b>Estimated</b> is calculated from what you
                  told it and current prices. <b>Not tested</b> means nobody has
                  measured it — which is different from failing, and different
                  again from <BrandName /> being unable to check.
                </p>
              </div>
              <div>
                <h3>Nothing is ranked on a guess</h3>
                <p>
                  An option with a missing fact is held out rather than assumed
                  to pass. If nothing qualifies yet, <BrandName /> says so and offers the
                  test that would resolve it.
                </p>
              </div>
            </SpaceBetween>
          </HelpPanel>
        }
        content={children}
      />
      <Modal visible={removeTarget !== null} header="Remove project?"
        onDismiss={() => { if (!removing) setRemoveTarget(null); }}
        closeAriaLabel="Cancel removal"
        footer={<Box float="right"><SpaceBetween direction="horizontal" size="xs">
          <Button formAction="none" variant="link" disabled={removing}
            onClick={() => setRemoveTarget(null)}>Cancel</Button>
          <Button formAction="none" variant="primary" iconName="remove"
            loading={removing} loadingText="Removing project"
            onClick={() => void confirmRemove()}>Remove</Button>
        </SpaceBetween></Box>}>
        <SpaceBetween size="m">
          <div><b>{removeTarget?.title}</b> will be removed from Recent and your project
            list on all devices. Unsaved edits on this device will be discarded.</div>
          <div>Saved history is retained. Running deployments stay available in Deployments.</div>
          {removeError ? <Alert type="error" header="Project could not be removed">{removeError}</Alert> : null}
        </SpaceBetween>
      </Modal>
    </>
  );
}
