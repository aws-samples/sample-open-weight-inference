import { useId, useState } from 'react';
import Button from '@cloudscape-design/components/button';
import Icon from '@cloudscape-design/components/icon';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import type { Candidate, EvaluateResponse, Gate } from '../api/types';
import { asRecord, candidateStatus, checkStatus } from './decisionMapModel';
import { CHECK_LABELS } from './hostingLabels';

const STAGES = [
  { id: 'identity', title: 'Can this model run here?', question: 'Model files, architecture and serving software', gates: ['weights', 'weights_exportable', 'artifact', 'recipe', 'architecture', 'modality', 'license', 'licence', 'cpu_runtime', 'cpu_memory'] },
  { id: 'location', title: 'Can you operate it here?', question: 'Location, access, capacity and control', gates: ['region', 'residency', 'quota', 'capacity', 'operations', 'ops_burden', 'held_capacity'] },
  { id: 'performance', title: 'Does it meet the workload?', question: 'Delivery, measured response time and quality', gates: ['latency', 'quality', 'cpu_delivery'] },
  { id: 'economics', title: 'Does the cost fit?', question: 'Complete cost, budget and ranking', gates: ['budget', 'cost_complete', 'cost_completeness'] },
];

/** A visible decision trace, grounded in recorded gates rather than LLM reasoning. */
export function DecisionJourney({ result, candidate, onEditNeeds, onTests }: {
  result: EvaluateResponse; candidate?: Candidate; onEditNeeds?: () => void; onTests?: () => void;
}) {
  const [selected, setSelected] = useState('identity');
  const evidenceId = useId();
  const request = asRecord(result.evaluatedRequest ?? result.request);
  const model = asRecord(request.model);
  const gates = candidate?.gates ?? [];
  const group = (stage: typeof STAGES[number]) => gates.filter((gate) => stage.gates.includes(gate.name));
  const tone = (items: Gate[]) => items.some((gate) => gate.status === 'FAIL') ? 'error'
    : items.some((gate) => checkStatus(gate, result).tone === 'pending') ? 'pending'
      : items.length && items.every((gate) => checkStatus(gate, result).tone === 'passed') ? 'success' : 'not-started';
  const label = (items: Gate[]) => {
    if (!candidate) return 'No evaluated configuration';
    if (!items.length) return 'Not established here';
    if (items.some((gate) => gate.status === 'FAIL')) return 'Requirement not met';
    if (items.some((gate) => gate.status === 'UNKNOWN')) return 'Evidence needed';
    const states = items.map((gate) => checkStatus(gate, result));
    if (states.every((status) => status.label === 'Not requested')) return 'No target set';
    if (states.some((status) => status.label === 'Assumed')) return 'Assumptions in use';
    if (states.some((status) => status.label === 'Supplied result')) return 'Supplied evidence';
    return 'Declared checks met';
  };
  const active = STAGES.find((stage) => stage.id === selected)!;
  const chosen = group(active);
  const notes: Record<string, string> = {
    identity: model.weightsExportable === false
      ? 'This request uses an API without downloadable weights. Another self-hosted model requires its own quality evaluation.'
      : 'Downloadable weights open several paths. The exact artifact, architecture, license and serving runtime must fit each path.',
    location: 'A service appearing in a catalog does not establish account access, quota or available capacity. Review the recorded checks for this configuration.',
    performance: 'Memory fit and modeled tokens per second do not establish latency or answer quality. Use the same model revision, serving configuration and workload in a benchmark.',
    economics: 'Only configurations passing the required checks enter the cost ranking. Missing prices are not zero. A CPU job, a dedicated endpoint and an imported model use different billing meters.',
  };
  return <section className="eddie-journey" aria-label="Decision steps">
    <div className="eddie-journey-heading"><Icon name="share" /><div><h4>Follow the decision</h4><p>Select a question to see the evidence and the next action.</p></div></div>
    <div className="eddie-journey-track">
      {STAGES.map((stage, index) => <div key={stage.id} className="eddie-journey-node" data-active={selected === stage.id} data-status={tone(group(stage))}>
        <span className="eddie-journey-number" aria-hidden="true">{index + 1}</span>
        <Button variant="inline-link" onClick={() => setSelected(stage.id)} ariaExpanded={selected === stage.id}
          ariaControls={evidenceId}>{stage.title}</Button>
        <p>{stage.question}</p>
        <StatusIndicator type={tone(group(stage))}>
          {label(group(stage))}
        </StatusIndicator>
      </div>)}
    </div>
    <div className="eddie-journey-evidence" id={evidenceId} aria-live="polite">
      <div><span className="eddie-map-eyebrow">{active.title}</span><p>{notes[active.id]}</p></div>
      {chosen.length ? <ul>{chosen.map((gate) => <li key={gate.name}>
        <b>{CHECK_LABELS[gate.name] ?? gate.name}: {checkStatus(gate, result).label}.</b> {gate.reason}
      </li>)}</ul> : <p>No matching check result was recorded in this stage.</p>}
      {selected === 'economics' && candidate ? <p><b>Outcome:</b> {candidateStatus(candidate, result).label}.</p> : null}
      {selected === 'performance' && onTests ? <Button onClick={onTests}>Review testing options</Button>
        : onEditNeeds ? <Button onClick={onEditNeeds}>Review my requirements</Button> : null}
    </div>
  </section>;
}
