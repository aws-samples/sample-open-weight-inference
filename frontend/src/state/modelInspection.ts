/**
 * Model inspection results and the provenance of every model field.
 *
 * The point of this module is that a value's origin travels with it. Before, the
 * form seeded Llama's numbers as defaults and the interface could not distinguish
 * them from something the user had established — so "8" parameters looked identical
 * whether it came from a preset, a guess, or the model's own file headers.
 */

import type { CaseFormState } from './caseForm';
import type { AccessState, ModelInspectionResult } from '../api/types';
import type { FieldOrigin } from '../copy/lexicon';
import { VENDOR_API_ARCHITECTURE } from './caseForm';

// The wire shapes live with the other API types so there is one definition of the
// coordinator's contract; this module adds the behaviour around them.
export type {
  AccessState,
  InspectedField,
  ModelInspectionResult,
} from '../api/types';

/** The model fields an inspection can establish. */
export const INSPECTABLE_FIELDS = [
  'architecture',
  'totalParamsB',
  'contextTokens',
  'weightsGb',
  'precision',
  'licenseId',
] as const;

export type InspectableField = (typeof INSPECTABLE_FIELDS)[number];

/**
 * Origins for each inspectable field, held alongside the form.
 *
 * Absent means nothing is known about where the value came from, which is treated
 * as `PROVIDED` when there is a value: the only way a value exists without an
 * origin is that a user typed it.
 */
export type FieldOrigins = Partial<Record<InspectableField, FieldOrigin>>;

/**
 * Origins implied by an inspection.
 *
 * A field the inspection could not establish becomes `NOT_DETECTED` *only if the
 * form has no value for it*. Overwriting a value the user typed with "not detected"
 * would discard their input and mislabel what is on screen.
 */
export function originsFromInspection(
  result: ModelInspectionResult,
  form: CaseFormState
): FieldOrigins {
  const origins: FieldOrigins = {};
  for (const name of INSPECTABLE_FIELDS) {
    const field = result.fields[name];
    if (field?.origin === 'DETECTED' && field.value !== null) {
      origins[name] = 'DETECTED';
    } else if (String(form[name] ?? '').trim() === '') {
      origins[name] = 'NOT_DETECTED';
    } else {
      origins[name] = 'PROVIDED';
    }
  }
  return origins;
}

/**
 * The form patch an inspection implies.
 *
 * Detected values are applied. A field the inspection could *not* establish is
 * cleared unless the user typed it, because whatever is sitting there describes a
 * different model. Leaving it kept the built-in Llama example's 128000-token
 * context after inspecting a source that publishes no context at all — a value
 * from one model, presented as belonging to another, and passed to the solver.
 *
 * A `PROVIDED` value survives: that is the user's own input, and an expert override
 * stays theirs and stays labelled as such.
 */
export function patchFromInspection(
  result: ModelInspectionResult,
  origins: FieldOrigins = {}
): Partial<CaseFormState> {
  const patch: Partial<CaseFormState> = {};
  for (const name of INSPECTABLE_FIELDS) {
    const field = result.fields[name];
    if (field?.origin === 'DETECTED' && field.value !== null) {
      // Every inspectable field is a string in the form, so the detected value is
      // carried through verbatim rather than parsed and reformatted.
      patch[name] = field.value as never;
    } else if (origins[name] !== 'PROVIDED') {
      patch[name] = '' as never;
    }
  }
  const modality = result.fields.modality;
  if (modality?.origin === 'DETECTED' && modality.value &&
      ['TEXT', 'TTS', 'ASR', 'EMBEDDING', 'VISION_LANGUAGE', 'SPEECH_TO_SPEECH'].includes(modality.value)) {
    patch.modality = modality.value as CaseFormState['modality'];
  }
  if (result.checkpoint && result.ok) {
    Object.assign(patch, {
      sourceKind: 'checkpoint', sourceLocation: result.checkpoint.source,
      modelName: result.checkpoint.name, modelStage: 'fine-tuned',
      modelIntent: 'specific', selectionStage: 'committed',
      artifactDigest: result.checkpoint.revision, hfRepo: '', hfCommit: '',
    });
  } else {
    if (result.repo) patch.hfRepo = result.repo;
    patch.hfCommit = result.revision ?? '';
    patch.artifactDigest = '';
  }
  // A repository we could inspect publishes weight files, so an artifact exists to
  // host. Whether the licence permits hosting it is a separate, unresolved matter.
  if (result.ok) patch.weightsExportable = true;
  return patch;
}

/**
 * The origin to display for one field.
 *
 * `NOT_APPLICABLE` wins over everything for an API-only model: a hosted API has no
 * weight files, so "not detected" would imply inspection might one day find a size
 * that does not exist.
 */
export function originFor(
  field: InspectableField,
  form: CaseFormState,
  origins: FieldOrigins
): FieldOrigin {
  const apiOnly =
    !form.weightsExportable ||
    form.architecture.trim() === VENDOR_API_ARCHITECTURE;
  if (apiOnly && field !== 'architecture') return 'NOT_APPLICABLE';
  const recorded = origins[field];
  if (recorded) return recorded;
  return String(form[field] ?? '').trim() === '' ? 'NOT_DETECTED' : 'PROVIDED';
}

/**
 * Origins after a model change, which invalidates everything derived.
 *
 * Keeping the previous model's parameter count because the new source did not
 * publish one would attribute one model's properties to another. Every inspectable
 * field is cleared, and the caller clears the values to match.
 */
export function originsAfterModelChange(): FieldOrigins {
  const origins: FieldOrigins = {};
  for (const name of INSPECTABLE_FIELDS) origins[name] = 'NOT_DETECTED';
  return origins;
}

/** The form patch a model change implies: clear every derived value. */
export function patchAfterModelChange(): Partial<CaseFormState> {
  return {
    architecture: '',
    totalParamsB: '',
    contextTokens: '',
    weightsGb: '',
    licenseId: '',
    hfRepo: '',
    hfCommit: '',
    artifactDigest: '',
    sourceLocation: '',
    precision: '',
    inferenceProfileId: '',
    permittedProcessingRegions: '',
    provideLatencyEvidence: false,
    latencyEvidence: [],
  };
}

/**
 * Model facts a target needs but the case does not have.
 *
 * Used to show "Needs model information" against an option instead of ranking it on
 * an assumed value. Only the facts that change a placement are listed: a missing
 * licence identifier does not stop a cost being computed, though it does stop a
 * deployment.
 */
export function missingModelFacts(form: CaseFormState): string[] {
  const apiOnly =
    !form.weightsExportable ||
    form.architecture.trim() === VENDOR_API_ARCHITECTURE;
  if (apiOnly) return [];
  const missing: string[] = [];
  if (form.architecture.trim() === '') missing.push('architecture');
  if (form.weightsGb.trim() === '') missing.push('weightsGb');
  return missing;
}

/** True when the source needs something accepted or granted before use. */
export function accessNeedsAction(access: AccessState): boolean {
  return access === 'GATED' || access === 'PRIVATE' || access === 'AUTHENTICATION_REQUIRED';
}
