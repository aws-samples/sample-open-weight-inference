import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import { useCase } from '../state/CaseContext';
import { projectFingerprint } from '../state/persistence';
import { evaluatedRequestMatches } from '../state/evaluatedRequest';
import { toEvaluateRequest } from '../state/caseForm';

export const PROJECT_SECTIONS = [
  { id: 'needs', label: 'Your needs', purpose: 'Qualify' },
  { id: 'models', label: 'Models & sources', purpose: 'Choose' },
  { id: 'hosting', label: 'Compare hosting', purpose: 'Route & size' },
  { id: 'tests', label: 'Tests', purpose: 'Evaluate' },
  { id: 'deployment', label: 'Deploy & monitor', purpose: 'Deploy & track' },
];

/** Progress describes saved work. It is never deployment approval or proof of quality. */
export function ProjectProgress({ section, open }: { section: string; open: (id: string) => void }) {
  const { projectSave, form, result, isOutdated, inspection, evaluationDraft } = useCase();
  const saved = projectSave.savedDocument;
  const needsKeys = [
    'description', 'workloadType', 'servingPattern', 'permittedRegions', 'budgetUsd',
    'horizonHours', 'concurrency', 'provideSlo', 'sloMetric', 'sloThresholdMs',
    'sloIncludeCold', 'trafficPattern', 'requests', 'requestsPerMinute',
    'successCriteria', 'goLiveDate', 'platformPreference', 'growthNotes', 'availabilityNeeds',
    'complianceNeeds', 'weightCustody', 'currentSpendUsd', 'benchmarkedAlternatives',
    'modelStage', 'selectionStage', 'inputTokensPerRequest', 'outputTokensPerRequest',
    'billableCopyHours', 'dedicatedInstanceHours', 'scheduled', 'sloPercentile',
  ] as const;
  const needsSaved = Boolean(saved?.form.description.trim()) && needsKeys.every((key) => saved?.form[key] === form[key]);
  const modelSaved = Boolean(saved?.form.modelName && saved.form.architecture) &&
    ['hfRepo', 'hfCommit', 'modelName', 'architecture', 'sourceLocation', 'sourceKind', 'inferenceProfileId', 'permittedProcessingRegions'].every((key) =>
      saved?.form[key as keyof typeof form] === form[key as keyof typeof form]) &&
    projectFingerprint(saved?.inspection) === projectFingerprint(inspection);
  const comparisonSaved = Boolean(saved?.decision && result && !isOutdated &&
    evaluatedRequestMatches(saved.decision.evaluatedRequest, toEvaluateRequest(form)));
  const testsSaved = Boolean(evaluationDraft.rows.some((row) => row.input.trim() && row.expected.trim())) &&
    projectFingerprint(saved?.evaluationDraft) === projectFingerprint(evaluationDraft);
  const labels: Record<string, string> = {
    needs: needsSaved ? 'Brief saved' : 'Draft',
    models: modelSaved ? 'Model saved' : 'Choose a model',
    hosting: comparisonSaved ? 'Comparison saved' : isOutdated ? 'Update needed' : 'Compare options',
    tests: testsSaved ? 'Test examples saved' : 'Quality & speed',
    deployment: 'Review before deploying',
  };
  const done: Record<string, boolean> = { needs: needsSaved, models: modelSaved, hosting: comparisonSaved, tests: testsSaved };
  return (
    <nav aria-label="Project progress" className="eddie-project-progress">
      {PROJECT_SECTIONS.map((item) => (
        <div key={item.id} className={section === item.id ? 'eddie-progress-item active' : 'eddie-progress-item'} aria-current={section === item.id ? 'step' : undefined}>
          <Button variant="inline-link" onClick={() => open(item.id)}>{item.purpose}</Button>
          <StatusIndicator type={done[item.id] ? 'success' : item.id === 'hosting' && isOutdated ? 'warning' : 'pending'}>
            <Box variant="span" fontSize="body-s">{labels[item.id]}</Box>
          </StatusIndicator>
        </div>
      ))}
    </nav>
  );
}
