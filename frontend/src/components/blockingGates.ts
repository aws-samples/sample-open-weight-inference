import type { Candidate, GateStatus } from '../api/types';

/**
 * A gate that is keeping candidates out of the ranking, aggregated across the
 * candidates it blocks, together with the specific control that would resolve
 * it.
 */
export interface BlockingGate {
  gateName: string;
  status: Extract<GateStatus, 'FAIL' | 'UNKNOWN'>;
  /** Distinct reasons the solver gave, in first-seen order. */
  reasons: string[];
  affectedCandidates: string[];
  /** Where in the form to go, or `null` when no form control can fix it. */
  remedy: string | null;
  /** The form section holding that control, for the "expand this" hint. */
  section: string | null;
}

interface RemedyRule {
  match: RegExp;
  remedy: string;
  section: string;
}

/**
 * Gate-name patterns mapped to the control that resolves them.
 *
 * Names come from the solver, so matching is by pattern rather than by an
 * exhaustive list: an unrecognised gate still reports its own name and reason,
 * it just carries no remedy hint rather than a wrong one.
 */
const REMEDY_RULES: RemedyRule[] = [
  {
    match: /declared_requirements/i,
    remedy: 'These requirements are recorded, but this comparison cannot verify them yet. Ask EDDIE Advisor what review or test is needed; keep requirements that still apply.',
    section: 'Your needs',
  },
  {
    match: /quality/i,
    remedy: 'Define acceptance criteria and test representative examples for this task. A price quote or supplied answer score does not prove model quality.',
    section: 'Tests',
  },
  {
    // Ordered first: an API-only artifact is not a form mistake to correct,
    // so this must not fall through to the "fix the model spec" rule.
    match: /weights_exportable|exportable|api-only|api only/i,
    remedy:
      'Nothing in this form resolves it: the model has no exportable weights, so no self-hosted target can serve it. The honest path is an API integration with the provider. To evaluate a self-hostable model instead, pick one from “Start from a known model”.',
    section: 'Model',
  },
  {
    match: /modality/i,
    remedy:
      'This target does not support the model’s inputs or outputs. Speech and embedding models need a compatible native API or a validated serving container on SageMaker or your own compute. Change the model type only if it is incorrect.',
    section: 'Model',
  },
  {
    match: /latency|p50|p95|p99|ttft|slo|cold/i,
    remedy:
      'Keep “Set a response-time target” enabled when it is a requirement. Supply latency evidence from a benchmark of this exact model and configuration under “Advanced evidence and assumptions”.',
    section: 'Response time',
  },
  {
    match: /licen[cs]e|entitle/i,
    remedy:
      'Verify the model licence and any provider access terms for your intended use. Naming a licence does not itself establish permission.',
    section: 'Advanced evidence and assumptions',
  },
  {
    match: /quota|limit|headroom/i,
    remedy:
      'Check the applied quota and current usage in the target AWS account. Request an increase if needed; quota headroom alone does not guarantee capacity.',
    section: 'Advanced evidence and assumptions',
  },
  {
    match: /recipe|support/i,
    remedy:
      'Validate the serving container and configuration for this model before deployment. A price estimate is not a tested deployment recipe.',
    section: 'Advanced evidence and assumptions',
  },
  {
    match: /capacity|reservation|allocation/i,
    remedy:
      'Confirm obtainable capacity in the target Region. If “Require held capacity” is enabled, record the reservation or existing allocation that satisfies it.',
    section: 'Advanced evidence and assumptions',
  },
  {
    match: /budget|cost|price|unpriced/i,
    remedy:
      'Raise or clear “Budget (USD)”. A missing price makes the budget gate unresolvable rather than passed.',
    section: 'Region and budget',
  },
  {
    match: /region|residency|location/i,
    remedy: 'Add the required region to “Permitted regions”.',
    section: 'Region and budget',
  },
  {
    // The solver's gate is named `operations`, which contains neither "ops"
    // nor "operational" as a substring — match the stem instead.
    match: /operation|burden|\bops\b/i,
    remedy: 'Raise “Maximum ops burden”, or clear it to remove the ceiling.',
    section: 'Region and budget',
  },
  {
    match: /artifact|architecture|precision|memory|context|modality/i,
    remedy:
      'Correct the model specification — architecture, precision, weights size or context limit — in the “Model” section.',
    section: 'Model',
  },
];

function remedyFor(gateName: string, reason: string | null): RemedyRule | null {
  const haystack = `${gateName} ${reason ?? ''}`;
  return REMEDY_RULES.find((rule) => rule.match.test(haystack)) ?? null;
}

/**
 * Aggregate the gates blocking every non-ranked candidate.
 *
 * Unresolved gates are listed before failures, because an unresolved gate is
 * usually an evidence gap the user can close from this form, whereas a failure
 * is a real elimination.
 */
export function summariseBlockingGates(
  unresolved: Candidate[],
  excluded: Candidate[]
): BlockingGate[] {
  const byKey = new Map<string, BlockingGate>();

  const collect = (
    candidates: Candidate[],
    status: 'UNKNOWN' | 'FAIL'
  ) => {
    for (const candidate of candidates) {
      for (const gate of candidate.gates) {
        if (gate.status !== status) continue;
        const key = `${status}:${gate.name}`;
        const existing = byKey.get(key);
        const rule = remedyFor(gate.name, gate.reason);
        if (existing) {
          if (gate.reason && !existing.reasons.includes(gate.reason)) {
            existing.reasons.push(gate.reason);
          }
          if (!existing.affectedCandidates.includes(candidate.candidateId)) {
            existing.affectedCandidates.push(candidate.candidateId);
          }
        } else {
          byKey.set(key, {
            gateName: gate.name,
            status,
            reasons: gate.reason ? [gate.reason] : [],
            affectedCandidates: [candidate.candidateId],
            remedy: rule?.remedy ?? null,
            section: rule?.section ?? null,
          });
        }
      }
    }
  };

  collect(unresolved, 'UNKNOWN');
  collect(excluded, 'FAIL');

  return [...byKey.values()];
}

/** The distinct form sections a user would need to open to act on these gates. */
export function sectionsToOpen(gates: BlockingGate[]): string[] {
  const sections: string[] = [];
  for (const gate of gates) {
    if (gate.section && !sections.includes(gate.section)) {
      sections.push(gate.section);
    }
  }
  return sections;
}
