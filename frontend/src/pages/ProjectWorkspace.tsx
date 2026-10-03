import { BrandName } from '../components/BrandName';
import { useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Container from '@cloudscape-design/components/container';
import ContentLayout from '@cloudscape-design/components/content-layout';
import Header from '@cloudscape-design/components/header';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Tabs from '@cloudscape-design/components/tabs';
import { HostingComparison, comparisonPeriod } from '../components/HostingComparison';
import { ModelConnections } from '../components/ModelConnections';
import { ProjectBrief } from '../components/ProjectBrief';
import { ProjectTests } from '../components/ProjectTests';
import { RequirementsForm } from '../components/RequirementsForm';
import { useCase } from '../state/CaseContext';
import { useDetailPanel } from '../state/DetailPanelContext';
import { validateForm } from '../state/caseForm';
import { DeploymentsPage } from './DeploymentsPage';
import { AdvisorPanel } from '../components/AdvisorPanel';
import { ProjectSaveControls } from '../components/ProjectSaveControls';
import { ProjectProgress, PROJECT_SECTIONS } from '../components/ProjectProgress';
import { HostingDecisionPath } from '../components/HostingDecisionPath';
import { ProjectSwitcher } from '../components/ProjectSwitcher';
import { NativeUsageInputs } from '../components/NativeUsageInputs';
import { CpuComparisonInputs } from '../components/CpuComparisonInputs';
import { InferenceSizing } from '../components/InferenceSizing';
import { Tokenomics } from '../components/Tokenomics';
import ExpandableSection from '@cloudscape-design/components/expandable-section';

const SECTIONS = ['needs', 'models', 'hosting', 'tests', 'deployment', 'advanced'];

/**
 * One non-linear project workspace. Tabs are destinations, not completion gates.
 * Chat and experts use the same case. Inspecting a model never starts evaluation.
 */
export default function ProjectWorkspace() {
  const state = useCase();
  const { form, patch, result, evaluate, inspection, inspecting } = state;
  const { show } = useDetailPanel();
  const [sizingExpanded, setSizingExpanded] = useState(false);
  const sizingSection = useRef<HTMLDivElement>(null);
  const exploreCompute = (compute: 'cpu' | 'gpu') => {
    state.patchSizingDraft({
      settings: { ...state.sizingDraft.settings, computePreference: compute, hourlyRateUsd: '', rateDescription: '' },
    });
    setSizingExpanded(true);
    requestAnimationFrame(() => sizingSection.current?.scrollIntoView({ block: 'start' }));
  };
  const [params, setParams] = useSearchParams();
  const requestedSection = params.get('view') ?? 'needs';
  const section = SECTIONS.includes(requestedSection) ? requestedSection : 'needs';
  const open = (view: string, source?: string) => {
    const next = new URLSearchParams(params);
    next.set('view', view);
    if (source) next.set('source', source); else next.delete('source');
    setParams(next);
  };
  const ask = (prompt?: string) => {
    if (prompt) state.setDraft(prompt);
    show({ header: 'EDDIE Advisor', content: <AdvisorPanel /> });
  };
  const issues = validateForm(form);
  const compare = () => {
    open('hosting');
    if (!issues.length && !state.submitting && !inspecting) void evaluate();
  };
  const nativeModel = form.sourceKind === 'bedrock' || (
    form.architecture === 'vendor-api' && form.modelName.includes('.') && form.modelName.includes(':')
  );
  const sectionIndex = PROJECT_SECTIONS.findIndex((item) => item.id === section);
  const next = PROJECT_SECTIONS[sectionIndex + 1];
  const incompleteReason = section === 'needs' && !form.description.trim()
    ? 'Describe your goal to complete Your needs.'
    : section === 'models' && (!form.modelName.trim() || !form.architecture.trim())
      ? 'Choose and inspect a model to complete Models & sources.'
      : section === 'hosting' && (!result || state.isOutdated)
        ? 'Run a comparison for your current inputs to complete Compare hosting.'
        : undefined;

  const advanced = (
    <RequirementsForm
      form={form} onChange={patch} onSubmit={compare} onReset={state.reset}
      onApplyPreset={state.applyPreset} submitting={state.submitting}
      activePresetId={state.activePresetId} changeModel={state.changeModel}
      inspection={inspection} fieldOrigins={state.fieldOrigins}
      onInspect={(source) => void state.inspectModel(source)}
      inspecting={inspecting} inspectError={state.inspectError}
    />
  );
  const hosting = (
    <SpaceBetween size="l">
      <Header variant="h2" description="Compare estimated costs first. Only options that pass every required check can become a recommendation.">
        Where could this model run?
      </Header>
      {issues.length > 0 ? (
        <Container header={<Header variant="h3">A little more information is needed to calculate costs</Header>}>
          <SpaceBetween size="m">
            <ul className="eddie-readable-list">
              {issues.map((issue) => <li key={`${issue.field}-${issue.entryIndex}`}>{issue.message}</li>)}
            </ul>
            <SpaceBetween direction="horizontal" size="s">
              <Button variant="primary" onClick={() => open(!form.modelName || !form.architecture ? 'models' : 'needs')}>
                {!form.modelName || !form.architecture ? 'Choose or inspect a model' : 'Update your needs'}
              </Button>
              <Button onClick={() => open('advanced')}>Edit all settings</Button>
            </SpaceBetween>
          </SpaceBetween>
        </Container>
      ) : (
        <>
          <div className="eddie-inline-summary">
            <div>
              <Box fontWeight="bold">{form.modelName}</Box>
              <Box variant="small" color="text-body-secondary">
                {comparisonPeriod(form.horizonHours)} · {form.permittedRegions}
                {form.budgetUsd ? ` · $${form.budgetUsd} budget` : ' · no budget set'}
              </Box>
            </div>
            <SpaceBetween direction="horizontal" size="s">
              <Button onClick={() => open('needs')}>Edit needs</Button>
              {!state.isOutdated ? <Button variant="primary" onClick={compare} loading={state.submitting} disabled={inspecting} data-testid="evaluate-from-page">
                {result ? 'Update comparison' : 'Compare hosting costs'}
              </Button> : null}
            </SpaceBetween>
          </div>
          {nativeModel ? <NativeUsageInputs form={form} onChange={patch} /> : null}
          {!nativeModel && form.weightsExportable ? <CpuComparisonInputs form={form} onChange={patch} /> : null}
          {!nativeModel && !form.billableCopyHours.trim() ? (
            <Box variant="small" color="text-body-secondary">
              Dedicated endpoints assume continuous allocation until you enter a start/stop schedule.
              Batch CPU costs remain incomplete until its allocation schedule is supplied.
            </Box>
          ) : null}
          <HostingComparison
            result={result} loading={state.submitting} error={state.error}
            onRetry={compare} onCancel={state.cancel} neverRun={state.neverRun}
            progress={state.progress} elapsedMs={state.elapsedMs}
            outdatedFields={state.outdatedFields} onReevaluate={compare}
            onAsk={ask} onEditNeeds={() => open('needs')} onTests={() => open('tests')}
            onModels={() => open('models')}
            renderSizing={() => <InferenceSizing onAsk={ask} />}
          />
          {result && !state.isOutdated ? (
            <SpaceBetween direction="horizontal" size="s">
              <Button onClick={() => open('tests')}>Review testing options</Button>
              <Button onClick={() => open('deployment')}>Deployment readiness</Button>
            </SpaceBetween>
          ) : null}
        </>
      )}
      <div ref={sizingSection}>
        <ExpandableSection headerText="Size compute and plan a benchmark" expanded={sizingExpanded}
          onChange={({ detail }) => setSizingExpanded(detail.expanded)}>
          <InferenceSizing onAsk={ask} />
        </ExpandableSection>
      </div>
      <ExpandableSection headerText="Tokenomics: compare GPU prices and Savings Plans">
        <Tokenomics key={form.caseId}
          initialRegion={form.permittedRegions.split(',')[0]?.trim() || 'us-east-1'}
          initialInstance={state.sizingDraft.report?.hardware?.instance ?? ''} />
      </ExpandableSection>
      {!result ? <HostingDecisionPath result={null} outdated={false} onAsk={ask}
        cpuFirst={form.servingPattern === 'batch' && Number(form.concurrency) > 0 && Number(form.concurrency) <= 2}
        onCompute={exploreCompute}
        onBedrock={() => open('models', 'bedrock')} onDeploy={() => open('deployment')} /> : null}
    </SpaceBetween>
  );

  return (
    <ContentLayout
      header={
        <Header
          variant="h1"
          description="Start anywhere. Describe your application, connect a model, or go straight to the details you know."
          actions={
            <SpaceBetween direction="horizontal" size="s">
              <Button onClick={() => ask()} iconName="gen-ai"><BrandName /> Advisor</Button>
              <Button onClick={() => open(section === 'advanced' ? 'needs' : 'advanced')} iconName="settings">
                {section === 'advanced' ? 'Back to overview' : 'All settings'}
              </Button>
            </SpaceBetween>
          }
        >
          Your AI project
        </Header>
      }
    >
      <div className="eddie-project-workspace">
        <SpaceBetween size="l">
          <ProjectSwitcher />
          <ProjectProgress section={section} open={open} />
          <Box variant="small" color="text-body-secondary">Move freely between sections. Save project keeps your work in your account; Save and continue guides you to the next section.</Box>
          {section === 'advanced' ? (
            <SpaceBetween size="m">
              <Box>Every setting is directly editable here. Return to the overview at any time; your values stay with the project.</Box>
              {advanced}
            </SpaceBetween>
          ) : null}
          <div hidden={section === 'advanced'}>
            <Tabs
              activeTabId={section === 'advanced' ? 'needs' : section}
              onChange={({ detail }) => open(detail.activeTabId)}
              ariaLabel="Project sections. Visit any section in any order."
              // Preserve unsaved evaluation examples while moving between sections.
              tabs={[
                { id: 'needs', label: 'Your needs', content: <ProjectBrief onModels={() => open('models')} onAsk={ask} /> },
                { id: 'models', contentRenderStrategy: 'lazy', label: 'Models & sources', content: <ModelConnections onCompare={compare} onSettings={() => open('advanced')} /> },
                { id: 'hosting', label: 'Compare hosting', content: hosting },
                { id: 'tests', contentRenderStrategy: 'lazy', label: 'Tests', content: <ProjectTests onHosting={() => open('hosting')} /> },
                { id: 'deployment', contentRenderStrategy: 'lazy', label: 'Deploy & monitor', content: <DeploymentsPage embedded /> },
              ]}
            />
          </div>
          <ProjectSaveControls incompleteReason={incompleteReason}
            nextLabel={next ? `Save and continue to ${next.label}` : undefined}
            onContinue={next ? () => open(next.id) : undefined} />
        </SpaceBetween>
      </div>
    </ContentLayout>
  );
}
