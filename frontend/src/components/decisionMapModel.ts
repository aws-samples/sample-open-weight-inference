import type { Candidate, EvaluateResponse, Gate, Target } from '../api/types';
import { CHECK_LABELS } from './hostingLabels';

export type RouteId = 'native' | 'import' | 'sagemaker' | 'cpu' | 'gpu';
export type MapTone = 'chosen' | 'passed' | 'pending' | 'excluded' | 'inactive';
export interface MapStatus {
  label: string;
  tone: MapTone;
}
export interface HostingBranch {
  id: RouteId;
  title: string;
  subtitle: string;
  candidates: Candidate[];
  status: MapStatus;
  explanation: string;
}

/** Presentation of an existing decision. This module never ranks or reprices it. */
export function allCandidates(result: EvaluateResponse): Candidate[] {
  return [...(result.ranked ?? []), ...(result.unresolved ?? []), ...(result.excluded ?? [])];
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

export function recordedText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

export function isConditional(result: EvaluateResponse): boolean {
  return result.checksStipulated || result.qualification?.conditional === true;
}

export function candidateStatus(candidate: Candidate, result: EvaluateResponse): MapStatus {
  if (candidate.gates.some((gate) => gate.status === 'FAIL')) return { label: 'Ruled out', tone: 'excluded' };
  if (!candidate.gates.length || candidate.gates.some((gate) => gate.status === 'UNKNOWN')) {
    return { label: 'Needs verification', tone: 'pending' };
  }
  const ranked = (result.ranked ?? []).some((item) => item.candidateId === candidate.candidateId);
  if (!ranked) return { label: 'Not ranked', tone: 'pending' };
  const chosen = result.winner?.candidateId === candidate.candidateId;
  if (isConditional(result)) {
    return { label: chosen ? 'Conditional cost leader' : 'Conditional fit', tone: 'pending' };
  }
  return chosen
    ? { label: 'Selected by solver', tone: 'chosen' }
    : { label: 'Passed required checks', tone: 'passed' };
}

export function checkStatus(gate: Gate, result: EvaluateResponse): MapStatus {
  if (gate.status === 'FAIL') return { label: 'Not met', tone: 'excluded' };
  if (gate.status === 'UNKNOWN') return { label: 'Needs verification', tone: 'pending' };
  if (/^no .*(objective|ceiling|target|requirement|budget).*(declared|set|provided)|^no budget/i.test(gate.reason ?? '')) {
    return { label: 'Not requested', tone: 'inactive' };
  }
  if (result.checksStipulated && ['license', 'licence', 'recipe', 'quota', 'capacity'].includes(gate.name)) {
    return { label: 'Assumed', tone: 'pending' };
  }
  if (gate.name === 'latency' && result.qualification?.latencyStatus === 'SUPPLIED') {
    return { label: 'Supplied result', tone: 'pending' };
  }
  return { label: 'Met', tone: 'passed' };
}

export function candidateExplanation(candidate: Candidate, result: EvaluateResponse): string {
  const failures = candidate.gates.filter((gate) => gate.status === 'FAIL');
  const pending = candidate.gates.filter((gate) => gate.status === 'UNKNOWN');
  const names = (gates: Gate[]) => gates.slice(0, 2)
    .map((gate) => CHECK_LABELS[gate.name] ?? gate.name.replaceAll('_', ' ')).join(' and ');
  if (failures.length) {
    return `${names(failures)} ${failures.length === 1 ? 'is' : 'are'} not met.${failures.length > 2 ? ` ${failures.length - 2} more ${failures.length === 3 ? 'check' : 'checks'} also failed.` : ''}`;
  }
  if (pending.length) {
    const labels = pending.slice(0, 2).map((gate) =>
      (CHECK_LABELS[gate.name] ?? gate.name.replaceAll('_', ' ')).toLowerCase());
    return `Still to verify: ${labels.join('; ')}.${pending.length > 2 ? ` ${pending.length - 2} other ${pending.length === 3 ? 'check needs' : 'checks need'} evidence.` : ''}`;
  }
  if (!candidate.gates.length) return 'No check results were recorded for this configuration.';
  if (isConditional(result)) return 'This result depends on assumptions or unmeasured performance. Review the checks before choosing it.';
  if (result.winner?.candidateId === candidate.candidateId) {
    return 'The solver selected this configuration after checking requirements and comparing the qualifying options.';
  }
  return 'Read the recorded checks and cost comparison for this configuration.';
}

export function hostingBranches(result: EvaluateResponse): HostingBranch[] {
  const candidates = allCandidates(result);
  const request = asRecord(result.evaluatedRequest ?? result.request);
  const model = asRecord(request.model);
  const nativeApi = model.sourceKind === 'bedrock' ||
    (candidates.length > 0 && candidates.every((candidate) => candidate.target === 'BEDROCK_NATIVE'));
  const definitions: { id: RouteId; title: string; subtitle: string; target: Target | null }[] = [
    { id: 'native', title: 'Bedrock model API', subtitle: 'Use an already-hosted model', target: 'BEDROCK_NATIVE' },
    { id: 'import', title: 'Bedrock import', subtitle: 'Bring supported model files', target: 'BEDROCK_CMI' },
    { id: 'sagemaker', title: 'SageMaker', subtitle: 'Managed serving on compatible compute', target: 'SAGEMAKER_REALTIME' },
    { id: 'cpu', title: 'CPU serving / batch', subtitle: 'Test CPU before assuming GPU', target: null },
    { id: 'gpu', title: 'EC2 / EKS GPUs', subtitle: 'Operate your own serving stack', target: null },
  ];
  const qualification = asRecord(request.qualification);
  const workload = asRecord(request.workload);
  const cpuFirst = qualification.servingPattern === 'batch' && Number(workload.concurrency) > 0 && Number(workload.concurrency) <= 2
    && !nativeApi && model.weightsExportable !== false;
  if (cpuFirst) definitions.unshift(...definitions.splice(definitions.findIndex((item) => item.id === 'cpu'), 1));
  return definitions.map((definition) => {
    const items = candidates.filter((candidate) => definition.id === 'cpu'
      ? candidate.target === 'EC2_CPU' || candidate.target === 'AWS_BATCH_CPU'
      : candidate.target === definition.target);
    if (!items.length) {
      const explanation = nativeApi && model.weightsExportable === false && definition.id !== 'native'
        ? 'The selected hosted API has no downloadable model files in this request. Choose a model with available files to evaluate this route.'
        : definition.id === 'cpu'
        ? 'CPU is a real inference path. For batch, low-concurrency work, check the runtime, process memory and completion deadline first. Use the sizing sheet to compare CPU options; no CPU deployment was qualified by this run.'
        : definition.id === 'gpu'
        ? 'This installation does not evaluate custom EC2 or EKS configurations yet. AWS availability has not been ruled out.'
        : definition.id === 'native'
            ? 'A native Bedrock option was not evaluated for this request. Browse the catalog; an alternative model needs its own quality checks.'
            : 'No configuration for this route was evaluated in this comparison.';
      return { ...definition, candidates: items,
        status: definition.id === 'cpu' && cpuFirst
          ? { label: 'Benchmark CPU first', tone: 'pending' as const }
          : { label: 'Not evaluated', tone: 'inactive' as const }, explanation };
    }
    const chosen = items.find((candidate) => candidate.candidateId === result.winner?.candidateId);
    const ranked = items.find((candidate) => (result.ranked ?? []).some((item) => item.candidateId === candidate.candidateId));
    const unresolved = items.find((candidate) => !candidate.gates.some((gate) => gate.status === 'FAIL'));
    const focus = chosen ?? ranked ?? unresolved ?? items[0];
    const status = candidateStatus(focus, result);
    return { ...definition, candidates: items, status, explanation: candidateExplanation(focus, result) };
  });
}
