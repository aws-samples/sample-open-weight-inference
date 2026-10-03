import { brandText } from './BrandName';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import ExpandableSection from '@cloudscape-design/components/expandable-section';
import FormField from '@cloudscape-design/components/form-field';
import Icon, { type IconProps } from '@cloudscape-design/components/icon';
import Modal from '@cloudscape-design/components/modal';
import Select from '@cloudscape-design/components/select';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator, { type StatusIndicatorProps } from '@cloudscape-design/components/status-indicator';
import Table from '@cloudscape-design/components/table';
import Tabs from '@cloudscape-design/components/tabs';
import { DecisionJourney } from './DecisionJourney';
import type { Candidate, EvaluateResponse } from '../api/types';
import {
  allCandidates, asRecord, candidateExplanation, candidateStatus, checkStatus,
  hostingBranches, isConditional, recordedText, type MapStatus, type RouteId,
} from './decisionMapModel';
import { CHECK_LABELS, comparisonPeriod, hostingOptionName } from './hostingLabels';
import { formatMoney, formatTimestamp, toNumber } from './format';
import '../styles/decision-map.css';

export interface DecisionMapActions {
  onAsk?: (prompt: string) => void;
  onEditNeeds?: () => void;
  onTests?: () => void;
  onModels?: () => void;
  renderSizing?: () => ReactNode;
}

const ROUTE_ICONS: Record<RouteId, IconProps.Name> = {
  native: 'gen-ai', import: 'upload', sagemaker: 'multiscreen', cpu: 'settings', gpu: 'multiscreen',
};
const INDICATORS: Record<MapStatus['tone'], StatusIndicatorProps.Type> = {
  chosen: 'success', passed: 'success', pending: 'pending', excluded: 'error', inactive: 'not-started',
};

function Status({ status }: { status: MapStatus }) {
  return <StatusIndicator type={INDICATORS[status.tone]}>{status.label}</StatusIndicator>;
}

function estimate(candidate: Candidate): string {
  return toNumber(candidate.cost?.total) === null
    ? (candidate.target === 'EC2_CPU' || candidate.target === 'AWS_BATCH_CPU')
      ? 'Cost inputs needed' : 'Price not available'
    : formatMoney(candidate.cost?.total);
}

/** The cards and connectors are a view of one recorded solver result. */
export function DecisionMap({ result, initialCandidateId, onDismiss, ...actions }: {
  result: EvaluateResponse;
  initialCandidateId: string | null;
  onDismiss: () => void;
} & DecisionMapActions) {
  const [view, setView] = useState('decision');
  const branches = hostingBranches(result);
  const all = allCandidates(result);
  const firstId = initialCandidateId ?? result.winner?.candidateId
    ?? result.unresolved?.[0]?.candidateId ?? all[0]?.candidateId;
  const [branchId, setBranchId] = useState<RouteId>(
    !initialCandidateId && branches[0]?.id === 'cpu' ? 'cpu'
      : branches.find((branch) => branch.candidates.some((item) => item.candidateId === firstId))?.id ?? 'native'
  );
  const [candidateId, setCandidateId] = useState<string | undefined>(firstId);
  const active = branches.find((branch) => branch.id === branchId)!;
  const candidate = active.candidates.find((item) => item.candidateId === candidateId) ?? active.candidates[0];
  const request = asRecord(result.evaluatedRequest ?? result.request);
  const model = asRecord(request.model);
  const constraints = asRecord(request.constraints);
  const slos = Array.isArray(request.slos) ? request.slos : null;
  const regionList = Array.isArray(constraints.permittedRegions)
    ? constraints.permittedRegions.filter((value): value is string => typeof value === 'string') : [];
  const processingRegions = Array.isArray(constraints.permittedProcessingRegions)
    ? constraints.permittedProcessingRegions.filter((value): value is string => typeof value === 'string') : [];
  const budget = recordedText(constraints.budgetUsd)
    ?? (typeof constraints.budgetUsd === 'number' ? String(constraints.budgetUsd) : null);
  const period = comparisonPeriod(result.horizonHours);
  const detailsId = useId();
  const pathsRef = useRef<HTMLElement>(null);
  const detailsRef = useRef<HTMLElement>(null);
  const scrollFrame = useRef<number | null>(null);
  useEffect(() => () => {
    if (scrollFrame.current !== null) window.cancelAnimationFrame(scrollFrame.current);
  }, []);
  const conditional = isConditional(result);
  const ranked = result.ranked ?? [];
  const hasWinner = result.winner !== null && result.winner !== undefined;
  const outcome = hasWinner
    ? conditional ? 'A cost leader, with conditions' : 'A path meets your requirements'
    : (result.unresolved ?? []).length ? 'Verify the gaps before choosing'
      : (result.excluded ?? []).length ? 'These configurations do not meet your needs'
        : 'No configuration has been evaluated';

  function selectBranch(id: RouteId) {
    setBranchId(id);
    const branch = branches.find((item) => item.id === id)!;
    setCandidateId(branch.candidates.find((item) => item.candidateId === result.winner?.candidateId)?.candidateId
      ?? branch.candidates[0]?.candidateId);
    if (scrollFrame.current !== null) window.cancelAnimationFrame(scrollFrame.current);
    scrollFrame.current = window.requestAnimationFrame(() => {
      scrollFrame.current = null;
      const details = detailsRef.current;
      if (!details) return;
      const animate = typeof window.matchMedia === 'function'
        && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      details.focus({ preventScroll: true });
      details.scrollIntoView({
        block: 'start', behavior: animate ? 'smooth' : 'auto',
      });
    });
  }
  function leave(action?: () => void) {
    onDismiss();
    action?.();
  }
  function challenge() {
    const target = candidate ? `${hostingOptionName(candidate)} (${candidate.candidateId})` : active.title;
    leave(() => actions.onAsk?.(
      `Help me challenge the ${target} path in comparison ${result.requestHash}. ` +
      'Explain the recorded checks, evidence gaps and what could change the result. ' +
      'Do not assume missing checks pass or invent prices or performance. Ask before changing my requirements. ' +
      'After an agreed change, update the project and re-evaluate it. Do not deploy anything.'
    ));
  }

  return (
    <Modal visible size="xx-large" height={900} position="top" onDismiss={onDismiss}
      header={brandText("How EDDIE reached this result")} closeAriaLabel="Close decision map"
      footer={<div className="eddie-map-footer">
        <Box variant="small" color="text-body-secondary">
          Changes to your requirements need a new comparison.
        </Box>
        <Button onClick={onDismiss}>Back to comparison</Button>
      </div>}>
      {actions.renderSizing ? <Tabs activeTabId={view} onChange={({ detail }) => setView(detail.activeTabId)}
        tabs={[{ id: 'decision', label: 'Why this decision' }, { id: 'sizing', label: 'Compute & evidence' }]} /> : null}
      <div hidden={view !== 'decision'}>
      <div className="eddie-decision-map" data-testid="decision-map">
        <div className="eddie-map-intro">
          <div>
            <div className="eddie-map-eyebrow"><Icon name="map" /> Decision map</div>
            <h2 className="eddie-map-title">{outcome}</h2>
            <p>Select a path to see its checks, costs, and what would change the result.</p>
          </div>
          <div className="eddie-map-legend" aria-label="Decision map legend">
            <Status status={{ label: 'Meets checks', tone: 'passed' }} />
            <Status status={{ label: 'Needs evidence', tone: 'pending' }} />
            <Status status={{ label: 'Ruled out', tone: 'excluded' }} />
            <Status status={{ label: 'Not evaluated', tone: 'inactive' }} />
          </div>
        </div>

        <section className="eddie-map-canvas" aria-label="Hosting paths from your evaluated requirements"
          ref={pathsRef} tabIndex={-1}>
          <div className="eddie-map-root">
            <span className="eddie-map-eyebrow">Your evaluated request</span>
            <h3>{recordedText(model.name) ?? all[0]?.modelRef ?? 'Model not recorded'}</h3>
            <div className="eddie-map-facts">
              <span><Icon name="calendar" /> {period}</span>
              <span><Icon name="location-pin" /> {regionList.length ? `AWS Region: ${regionList.join(', ')}` : 'Location not recorded'}</span>
              <span><Icon name="ticket" /> {toNumber(budget) === null ? 'Budget not set' : `${formatMoney(budget)} budget`}</span>
              <span><Icon name="history" /> {slos === null ? 'Speed target not recorded' : slos.length ? `${slos.length} response-time target${slos.length === 1 ? '' : 's'}` : 'Speed target not set'}</span>
            </div>
            {processingRegions.length ? <p className="eddie-map-processing">
              Allowed processing locations: {processingRegions.join(', ')}
            </p> : null}
          </div>
          <div className="eddie-map-branches">
            {branches.map((branch) => (
              <section key={branch.id} className="eddie-map-branch" data-active={branchId === branch.id}
                data-tone={branch.status.tone} data-testid={`decision-branch-${branch.id}`}
                aria-label={`${branch.title} path`}>
                <div className="eddie-map-branch-icon"><Icon name={ROUTE_ICONS[branch.id]} size="medium" /></div>
                <h3>{branch.title}</h3>
                <p className="eddie-map-subtitle">{branch.subtitle}</p>
                <Status status={branch.status} />
                <p className="eddie-map-route-note">
                  {branch.candidates.length
                    ? `${branch.candidates.length} configuration${branch.candidates.length === 1 ? '' : 's'} evaluated`
                    : 'No configuration in this run'}
                </p>
                <Button fullWidth variant={branchId === branch.id ? 'primary' : 'normal'}
                  ariaLabel={`Explore ${branch.title}`}
                  ariaExpanded={branchId === branch.id} ariaControls={detailsId}
                  onClick={() => selectBranch(branch.id)}>
                  {branchId === branch.id ? 'Viewing this path' : 'Explore path'}
                </Button>
              </section>
            ))}
          </div>
        </section>

        <section className="eddie-map-details" id={detailsId} aria-label="Selected hosting path"
          ref={detailsRef} tabIndex={-1}>
          <div className="eddie-map-details-heading">
            <div>
              <div className="eddie-map-eyebrow">Inside this path</div>
              <h3>{active.title}</h3>
            </div>
            <SpaceBetween direction="horizontal" size="m">
              <Status status={candidate ? candidateStatus(candidate, result) : active.status} />
              <Button iconName="arrow-up" variant="inline-link" onClick={() => {
                pathsRef.current?.focus({ preventScroll: true });
                pathsRef.current?.scrollIntoView({ block: 'start' });
              }}>All paths</Button>
            </SpaceBetween>
          </div>
          <p className="eddie-map-explanation" aria-live="polite">
            {candidate ? candidateExplanation(candidate, result) : active.explanation}
          </p>
          {candidate ? <DecisionJourney result={result} candidate={candidate}
            onEditNeeds={actions.onEditNeeds ? () => leave(actions.onEditNeeds) : undefined}
            onTests={actions.onTests ? () => leave(actions.onTests) : undefined} /> : null}
          {candidate ? (
            <>
              {active.candidates.length > 1 ? (
                <div className="eddie-map-configuration">
                  <FormField label="Configuration to explain">
                    <Select
                      selectedOption={{ value: candidate.candidateId, label: hostingOptionName(candidate) }}
                      options={active.candidates.map((item) => ({
                        value: item.candidateId, label: hostingOptionName(item),
                        description: `${estimate(item)} · ${candidateStatus(item, result).label}`,
                      }))}
                      onChange={({ detail }) => setCandidateId(detail.selectedOption.value)}
                    />
                  </FormField>
                </div>
              ) : null}
              <div className="eddie-map-detail-grid">
                <section className="eddie-map-checks" aria-label="Recorded requirement checks">
                  <div className="eddie-map-section-heading">
                    <h4>Requirement checks</h4>
                    <p>Open any check for the recorded reason and evidence.</p>
                  </div>
                  {candidate.gates.map((gate) => (
                    <div key={gate.name} className="eddie-map-check" data-tone={checkStatus(gate, result).tone}>
                      <ExpandableSection headerText={CHECK_LABELS[gate.name] ?? gate.name.replaceAll('_', ' ')}
                        headerActions={<Status status={checkStatus(gate, result)} />}>
                        <SpaceBetween size="xs">
                          <Box>{gate.reason || 'No explanation was recorded for this check.'}</Box>
                          <Box variant="small" color="text-body-secondary">
                            {gate.evidenceRef ? `Evidence reference: ${gate.evidenceRef}` : 'No separate evidence reference was recorded.'}
                          </Box>
                        </SpaceBetween>
                      </ExpandableSection>
                    </div>
                  ))}
                  {!candidate.gates.length ? <p>No check results were recorded.</p> : null}
                </section>
                <aside className="eddie-map-cost" aria-label="Cost and next action">
                  <div className="eddie-map-eyebrow">Estimated cost · {period}</div>
                  <div className="eddie-map-price">{estimate(candidate)}</div>
                  <p>{candidate.cost && !candidate.cost.isComplete
                    ? 'Some cost components are missing. This is an incomplete estimate.'
                    : 'Based on the usage and rates recorded in this comparison.'}</p>
                  {candidate.cost && !candidate.cost.isComplete
                    && candidate.cost.knownSubtotal != null
                    && candidate.cost.items.some((item) => item.amount !== null) ? (
                    <p>Known subtotal: <b>{formatMoney(candidate.cost.knownSubtotal)}</b>.
                      Missing charges are not treated as zero.</p>
                  ) : null}
                  <div className="eddie-map-cost-outcome">
                    <Icon name={result.winner?.candidateId === candidate.candidateId ? 'flag' : 'filter'} />
                    <div><b>{result.winner?.candidateId === candidate.candidateId
                      ? conditional ? 'Lowest cost under the assumptions' : 'Selected from the qualifying options'
                      : ranked.some((item) => item.candidateId === candidate.candidateId)
                        ? 'Included in the cost ranking' : 'Not included in the cost ranking'}</b>
                      <p>{ranked.some((item) => item.candidateId === candidate.candidateId)
                        ? 'See the recorded ranking below. Equal costs use the stated tie-breaks.'
                        : 'An estimated price does not establish that this configuration meets your requirements.'}</p>
                    </div>
                  </div>
                  <Box variant="small">{brandText(result.qualification?.latencyStatus === 'NOT_REQUESTED'
                    ? 'No response-time target was set. No speed claim is being made.'
                    : result.qualification?.latencyStatus === 'SUPPLIED'
                      ? 'Response-time results were supplied, not measured by EDDIE.'
                      : result.qualification?.performanceMeasured
                        ? 'Open the response-time check for evidence applicable to this configuration.'
                        : 'Response time has not been measured for this comparison.')}</Box>
                  {result.checksStipulated ? (
                    <Status status={{ label: 'Some account checks were assumed', tone: 'pending' }} />
                  ) : null}
                  {actions.onAsk ? <Button iconName="gen-ai" fullWidth onClick={challenge}>Challenge this option</Button> : null}
                  {actions.onEditNeeds ? <Button iconName="edit" fullWidth onClick={() => leave(actions.onEditNeeds)}>Change my requirements</Button> : null}
                  {actions.onTests ? <Button variant="inline-link" onClick={() => leave(actions.onTests)}>Review testing options</Button> : null}
                </aside>
              </div>
              <ExpandableSection headerText="Cost ranking and tie-breaks">
                <SpaceBetween size="s">
                  {ranked.length ? (
                    <Table variant="embedded" wrapLines items={ranked} trackBy="candidateId"
                      ariaLabels={{ tableLabel: 'Recorded solver ranking' }}
                      columnDefinitions={[
                        { id: 'position', header: 'Order', cell: (item) => ranked.indexOf(item) + 1 },
                        { id: 'option', header: 'Option', cell: hostingOptionName },
                        { id: 'price', header: `Estimate · ${period}`, cell: estimate },
                      ]} />
                  ) : <Box>No option passed every required check, so the solver produced no cost ranking.</Box>}
                  <Box>When exact total costs are equal, the solver prefers less operational effort,
                    a smaller failure impact, then the recorded location preference. A stable configuration
                    identifier resolves any remaining tie. Response speed is a requirement, not a weighted score.</Box>
                  {conditional && ranked.length ? <Box>This ranking is conditional on the recorded assumptions and evidence.</Box> : null}
                </SpaceBetween>
              </ExpandableSection>
              <ExpandableSection headerText="Price evidence for this configuration">
                <SpaceBetween size="s">
                  {(candidate.cost?.items ?? []).map((item, index) => (
                    <div key={`${item.label}-${index}`} className="eddie-map-price-source">
                      <b>{item.label}</b>
                      <span>{item.quantity ?? 'Quantity not recorded'} {item.quantityUnit ?? ''}</span>
                      <span>{item.rate ? `${item.rate.amount} ${item.rate.unit}` : 'Rate not recorded'}</span>
                      <span>{item.rate?.source ?? 'Source not recorded'}</span>
                      {item.note ? <span>{item.note}</span> : null}
                      <span>SKU: {item.rate?.sku ?? 'Not recorded'} · Effective: {item.rate?.effectiveDate ?? 'Not recorded'}</span>
                    </div>
                  ))}
                  {!candidate.cost?.items.length ? <Box>No priced line items were recorded for this configuration.</Box> : null}
                </SpaceBetween>
              </ExpandableSection>
            </>
          ) : (
            <div className="eddie-map-unevaluated">
              <Icon name="search" size="large" />
              <div><h4>{active.id === 'cpu' || active.id === 'gpu'
                ? 'Plan the compute experiment' : 'This route needs an evaluation'}</h4>
                <p>{active.id === 'cpu'
                  ? 'Use the sizing sheet to check CPU runtime support, memory and the completion budget, then choose a service for the trial. A recorded speech run provides a concrete example.'
                  : active.id === 'gpu'
                    ? 'Inspect weight precision, attention-cache memory, GPU sharing and the traffic assumptions. Use the resulting configuration as a benchmark candidate.'
                    : 'No configuration on this path was checked in this run. That does not mean the route failed.'}</p>
                <SpaceBetween direction="horizontal" size="s">
                  {actions.renderSizing && (active.id === 'cpu' || active.id === 'gpu') ? (
                    <Button variant="primary" onClick={() => setView('sizing')}>Explore compute and evidence</Button>
                  ) : null}
                  {actions.onModels && active.id !== 'gpu' && active.id !== 'cpu' ? (
                    <Button onClick={() => leave(actions.onModels)}>Explore models and sources</Button>
                  ) : null}
                  {actions.onAsk ? <Button iconName="gen-ai" onClick={challenge}>Ask what this path needs</Button> : null}
                </SpaceBetween>
              </div>
            </div>
          )}
        </section>
        <div className="eddie-map-provenance">
          <Icon name="lock-private" />
          <span>Built from the recorded solver checks. Comparison {result.requestHash || 'reference not recorded'}.
            {result.retrievedAt ? ` Prices retrieved ${formatTimestamp(result.retrievedAt)}.` : ''}</span>
        </div>
      </div>
      </div>
      {view === 'sizing' ? actions.renderSizing?.() : null}
    </Modal>
  );
}
