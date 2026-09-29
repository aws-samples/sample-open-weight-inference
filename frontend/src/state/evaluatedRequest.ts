import type { EvaluatePayloadEcho, EvaluateRequest } from '../api/types';

/**
 * Comparing a displayed decision against the request that actually produced it.
 *
 * The authoritative input identity is the solver's own `evaluatedRequest`, not a
 * snapshot of the form at submit time. Between a snapshot and the evaluation the
 * advisor can patch the case via `propose_case_patch`, and a strictness change
 * can flip `assumeChecksCleared`, so a snapshot describes what the user typed
 * rather than what ran.
 *
 * The two surfaces build the payload differently — chat omits keys the user
 * never set, the form sends them as `null` — so both sides are normalised to a
 * canonical form before being compared. A raw field-by-field diff would report
 * a difference on every chat-produced decision.
 *
 * The backend hashes the same field selection (`_payload_hash`): `model`,
 * `workload` minus `description`, `slos`, `constraints`, `assumeChecksCleared`
 * and `latencyEvidence`. `caseId` is excluded entirely. A contract test pins
 * that selection against the backend source so the two cannot drift silently.
 */

/** Top-level keys the solver reads. `caseId` is deliberately absent. */
export const SOLVER_RELEVANT_KEYS = [
  'model',
  'workload',
  'slos',
  'constraints',
  'assumeChecksCleared',
  'latencyEvidence',
  'qualityGoal',
  'qualification',
] as const;

/** Workload keys excluded from identity because they do not change the answer. */
export const COSMETIC_WORKLOAD_KEYS = ['description'] as const;

/**
 * Optional flags whose absence the backend reads as `false`.
 *
 * The form always sends them; chat omits them when unset. `false` and absent are
 * therefore the same requirement, and treating them as different would make
 * every chat-produced decision read as stale the moment it arrived.
 *
 * Note this means `evaluatedRequestHash` itself can differ between the two
 * surfaces for a logically identical case, since the backend hashes the literal
 * payload. The hash is used only as a record identity here; staleness uses this
 * normalised comparison.
 */
const FALSE_MEANS_UNSET = new Set(['scheduled', 'requireHeldCapacity']);

/** Human labels for the paths a diff can report. */
const PATH_LABELS: Record<string, string> = {
  'model.name': 'Model name',
  'model.architecture': 'Architecture',
  'model.modality': 'Modality',
  'model.totalParamsB': 'Total parameters (B)',
  'model.contextTokens': 'Context tokens',
  'model.precision': 'Weight precision',
  'model.weightsGb': 'Weights size (GiB)',
  'model.weightsExportable': 'Weights exportable',
  'model.licenseId': 'Licence identifier',
  'model.hfRepo': 'Model source',
  'model.hfCommit': 'Model revision',
  'model.artifactDigest': 'Fine-tuned checkpoint revision',
  'model.sourceKind': 'Model source type',
  'model.inferenceProfileId': 'Bedrock request route',
  'workload.requests': 'Request volume',
  'workload.inputTokensPerRequest': 'Input size',
  'workload.outputTokensPerRequest': 'Output size',
  'workload.horizonHours': 'Horizon (hours)',
  'workload.billableCopyHours': 'Billable copy hours',
  'workload.dedicatedInstanceHours': 'Dedicated instance hours',
  'workload.scheduled': 'Scheduled workload',
  'workload.concurrency': 'Concurrency',
  slos: 'Latency objective',
  'constraints.permittedRegions': 'Permitted regions',
  'constraints.permittedProcessingRegions': 'Allowed processing Regions',
  'constraints.budgetUsd': 'Budget (USD)',
  'constraints.requireHeldCapacity': 'Require held capacity',
  'constraints.maxOpsBurden': 'Maximum ops burden',
  assumeChecksCleared: 'Stipulated checks',
  latencyEvidence: 'Supplied latency evidence',
  qualityGoal: 'Answer-quality goal',
  qualification: 'Qualification answers',
};

function labelFor(path: string): string {
  if (PATH_LABELS[path]) return PATH_LABELS[path];
  // An unmapped path still names itself rather than being hidden.
  const top = path.split('.')[0];
  return PATH_LABELS[top] ?? path;
}

/** True for values the two surfaces use interchangeably to mean "not set". */
function isAbsent(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value as object).length === 0;
  return false;
}

/**
 * Canonicalise one value.
 *
 * Numbers and numeric strings are compared as strings, because the form holds
 * decimals as strings while the advisor may send JSON numbers, and `"4"` and `4`
 * describe the same requirement.
 */
function canonicalScalar(value: unknown): string | boolean {
  if (typeof value === 'boolean') return value;
  return String(value).trim();
}

function canonicalObject(
  source: unknown,
  skip: readonly string[] = []
): Record<string, string | boolean | unknown> {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return {};
  const out: Record<string, string | boolean | unknown> = {};
  for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
    if (skip.includes(key)) continue;
    if (isAbsent(value)) continue;
    if (value === false && FALSE_MEANS_UNSET.has(key)) continue;
    if (Array.isArray(value)) {
      out[key] = value.map((item) =>
        item && typeof item === 'object'
          ? canonicalObject(item)
          : canonicalScalar(item)
      );
      continue;
    }
    if (value && typeof value === 'object') {
      const nested = canonicalObject(value);
      if (Object.keys(nested).length > 0) out[key] = nested;
      continue;
    }
    out[key] = canonicalScalar(value);
  }
  return out;
}

export type CanonicalPayload = Record<string, unknown>;

/**
 * Project any evaluate payload — the form's or the runtime's echo — into the
 * canonical form used for comparison.
 */
export function canonicalEvaluatePayload(
  payload: EvaluatePayloadEcho | EvaluateRequest | null | undefined
): CanonicalPayload {
  if (!payload) return {};
  const source = payload as unknown as Record<string, unknown>;
  const out: CanonicalPayload = {};

  for (const key of SOLVER_RELEVANT_KEYS) {
    const value = source[key];
    if (key === 'workload') {
      const workload = canonicalObject(value, COSMETIC_WORKLOAD_KEYS);
      if (Object.keys(workload).length > 0) out.workload = workload;
      continue;
    }
    if (key === 'assumeChecksCleared') {
      // A boolean that is genuinely false is meaningful, so it is not "absent".
      out.assumeChecksCleared = value === true;
      continue;
    }
    if (key === 'slos') {
      const slos = Array.isArray(value)
        ? value
            .map((item) => canonicalObject(item))
            .filter((item) => Object.keys(item).length > 0)
        : [];
      if (slos.length > 0) out.slos = slos;
      continue;
    }
    if (key === 'qualityGoal') {
      if (typeof value === 'string' && value.trim()) out[key] = value.trim();
      continue;
    }
    if (isAbsent(value)) continue;
    const nested = canonicalObject(value);
    if (Object.keys(nested).length > 0) out[key] = nested;
  }

  return out;
}

function collectPaths(
  before: unknown,
  after: unknown,
  path: string,
  changed: Set<string>
): void {
  const bothObjects =
    before &&
    after &&
    typeof before === 'object' &&
    typeof after === 'object' &&
    !Array.isArray(before) &&
    !Array.isArray(after);

  if (bothObjects) {
    const keys = new Set([
      ...Object.keys(before as object),
      ...Object.keys(after as object),
    ]);
    for (const key of keys) {
      collectPaths(
        (before as Record<string, unknown>)[key],
        (after as Record<string, unknown>)[key],
        path ? `${path}.${key}` : key,
        changed
      );
    }
    return;
  }

  if (JSON.stringify(before ?? null) !== JSON.stringify(after ?? null)) {
    changed.add(path);
  }
}

/**
 * Labels of the solver-relevant fields that differ between two payloads.
 *
 * An empty array means the decision still describes what would be evaluated
 * now. Editing `description` or `caseId` never appears here.
 */
export function evaluatedRequestChanges(
  evaluated: EvaluatePayloadEcho | EvaluateRequest | null | undefined,
  current: EvaluateRequest | EvaluatePayloadEcho | null | undefined
): string[] {
  if (!evaluated) return [];
  const before = canonicalEvaluatePayload(evaluated);
  const after = canonicalEvaluatePayload(current);
  const paths = new Set<string>();
  collectPaths(before, after, '', paths);
  const labels = [...paths].map(labelFor);
  return [...new Set(labels)].sort();
}

/** True when the two payloads would produce the same evaluation. */
export function evaluatedRequestMatches(
  a: EvaluatePayloadEcho | EvaluateRequest | null | undefined,
  b: EvaluatePayloadEcho | EvaluateRequest | null | undefined
): boolean {
  return (
    JSON.stringify(canonicalEvaluatePayload(a)) ===
    JSON.stringify(canonicalEvaluatePayload(b))
  );
}
