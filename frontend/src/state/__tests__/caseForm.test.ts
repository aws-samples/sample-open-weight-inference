import { describe, expect, it } from 'vitest';
import {
  ADVISOR_WRITABLE_FIELDS,
  DEFAULT_FORM,
  WORKLOAD_PRESETS,
  caseToFormPatch,
  describeCasePatch,
  formToAdvisorCase,
  emptyLatencyEntry,
  formDutyPercent,
  hasEvidenceCaveat,
  toEvaluateRequest,
  validateForm,
  type CaseFormState,
} from '../caseForm';

function preset(id: string) {
  const found = WORKLOAD_PRESETS.find((item) => item.id === id);
  if (!found) throw new Error(`Preset ${id} is missing.`);
  return found;
}

/** The form a user gets by clicking one preset button from the default state. */
function applyPreset(id: string): CaseFormState {
  return { ...DEFAULT_FORM, ...preset(id).patch };
}

describe('preset catalogue', () => {
  it('offers two usage shortcuts without a fabricated benchmark scenario', () => {
    expect(WORKLOAD_PRESETS.map((item) => item.id)).toEqual([
      'bursty-3-day',
      'always-on-30-day',
    ]);
  });

  it('explains what each preset demonstrates', () => {
    for (const item of WORKLOAD_PRESETS) {
      expect(item.label.length).toBeGreaterThan(0);
      expect(item.description.length).toBeGreaterThan(0);
      expect(item.demonstrates.length).toBeGreaterThan(0);
    }
  });

  it('never assumes account checks passed or supplies performance evidence', () => {
    for (const item of WORKLOAD_PRESETS) {
      const form = { ...DEFAULT_FORM, ...item.patch };
      expect(form.assumeChecksCleared).toBe(false);
      expect(toEvaluateRequest(form).assumeChecksCleared).toBe(false);
      expect(toEvaluateRequest(form).latencyEvidence).toBeNull();
      expect(hasEvidenceCaveat(form)).toBe(false);
    }
  });

  it('every preset produces a valid request', () => {
    for (const item of WORKLOAD_PRESETS) {
      expect(validateForm({ ...DEFAULT_FORM, ...item.patch })).toEqual([]);
    }
  });
});

describe('preset: 3-day bursty event', () => {
  const form = applyPreset('bursty-3-day');
  const request = toEvaluateRequest(form);

  it('sets a 72-hour horizon with 6 billable copy hours', () => {
    expect(request.workload.horizonHours).toBe('72');
    expect(request.workload.billableCopyHours).toBe('6');
    expect(request.workload.dedicatedInstanceHours).toBeNull();
  });

  it('implies an 8.33% duty cycle', () => {
    expect(formDutyPercent(form)).toBeCloseTo(8.333, 2);
  });

  it('leaves an initially absent response-time objective absent', () => {
    expect(form.provideSlo).toBe(false);
    expect(request.slos).toEqual([]);
  });

  it('supplies no latency evidence, because no objective needs it', () => {
    expect(request.latencyEvidence).toBeNull();
  });
});

describe('preset: Always-on 30 days', () => {
  const form = applyPreset('always-on-30-day');
  const request = toEvaluateRequest(form);

  it('sets a 720-hour horizon served continuously', () => {
    expect(request.workload.horizonHours).toBe('720');
    expect(request.workload.billableCopyHours).toBe('720');
    expect(request.workload.dedicatedInstanceHours).toBeNull();
  });

  it('implies a 100% duty cycle', () => {
    expect(formDutyPercent(form)).toBe(100);
  });

  it('does not add an objective or evidence to the default case', () => {
    expect(request.slos).toEqual([]);
    expect(request.latencyEvidence).toBeNull();
  });

  it('differs from the bursty preset only in the workload block', () => {
    const bursty = toEvaluateRequest(applyPreset('bursty-3-day'));
    // Same artifact and constraints — only the usage shape moves.
    expect(request.model).toEqual(bursty.model);
    expect(request.constraints).toEqual(bursty.constraints);
    expect(request.slos).toEqual(bursty.slos);
    expect(request.workload).not.toEqual(bursty.workload);
  });
});

describe('caller-supplied latency evidence', () => {
  // Synthetic serialization fixtures, confined to unit tests. Usage shortcuts in
  // the application must never supply these numbers as measured evidence.
  const form: CaseFormState = {
    ...DEFAULT_FORM,
    provideSlo: true,
    sloThresholdMs: '800',
    provideLatencyEvidence: true,
    latencyEvidence: [
      {
        ...emptyLatencyEntry('cmi-scale-to-zero'),
        p50Ms: '120', p99Ms: '500', coldStartMs: '45000',
        sampleCount: '12000', violationRateUpperBound: '0.004',
      },
      {
        ...emptyLatencyEntry('sagemaker-ml.g5.2xlarge'),
        p50Ms: '95', p99Ms: '410', coldStartMs: '0',
        sampleCount: '12000', violationRateUpperBound: '0.001',
      },
    ],
  };
  const request = toEvaluateRequest(form);

  it('keeps the metric-implied percentile out of the serialized objective', () => {
    // The backend derives p99 from the metric. An independent percentile could
    // contradict that metric when the user changes the selection.
    expect(request.slos).toEqual([{
      metric: 'p99_latency_ms',
      thresholdMs: '800',
      includeCold: true,
      errorBudgetFraction: '0.01',
    }]);
  });

  it('keys supplied evidence by candidate id and preserves decimal strings', () => {
    expect(Object.keys(request.latencyEvidence ?? {}).sort()).toEqual([
      'cmi-scale-to-zero',
      'sagemaker-ml.g5.2xlarge',
    ]);
    expect(request.latencyEvidence?.['cmi-scale-to-zero']).toMatchObject({
      p99Ms: '500', coldStartMs: '45000', violationRateUpperBound: '0.004',
    });
    expect(request.latencyEvidence?.['sagemaker-ml.g5.2xlarge']).toMatchObject({
      p99Ms: '410', coldStartMs: '0', violationRateUpperBound: '0.001',
    });
  });

  it('preserves the response-time target and supplied evidence when usage changes', () => {
    for (const item of WORKLOAD_PRESETS) {
      const changed = toEvaluateRequest({ ...form, ...item.patch });
      expect(changed.slos).toEqual(request.slos);
      expect(changed.latencyEvidence).toEqual(request.latencyEvidence);
      expect(changed.assumeChecksCleared).toBe(false);
    }
  });
});

describe('toEvaluateRequest', () => {
  it('sends blank optional numeric fields as null, never as 0', () => {
    const request = toEvaluateRequest({
      ...DEFAULT_FORM,
      dedicatedInstanceHours: '',
      concurrency: '',
      budgetUsd: '',
      maxOpsBurden: '',
    });
    expect(request.workload.dedicatedInstanceHours).toBeNull();
    expect(request.workload.concurrency).toBeNull();
    expect(request.constraints.budgetUsd).toBeNull();
    expect(request.constraints.maxOpsBurden).toBeNull();
  });

  it('preserves decimal strings verbatim rather than rounding through a float', () => {
    const request = toEvaluateRequest({
      ...DEFAULT_FORM,
      provideSlo: true,
      sloErrorBudgetFraction: '0.0100',
      provideLatencyEvidence: true,
      latencyEvidence: [
        { ...emptyLatencyEntry('cmi-scale-to-zero'), violationRateUpperBound: '0.004' },
      ],
    });
    expect(request.slos[0]?.errorBudgetFraction).toBe('0.0100');
    expect(
      request.latencyEvidence?.['cmi-scale-to-zero']?.violationRateUpperBound
    ).toBe('0.004');
  });

  it('splits permitted regions into a trimmed list', () => {
    const request = toEvaluateRequest({
      ...DEFAULT_FORM,
      permittedRegions: 'us-east-1, eu-west-1 ,',
    });
    expect(request.constraints.permittedRegions).toEqual([
      'us-east-1',
      'eu-west-1',
    ]);
  });

  it('omits latency evidence entirely when the toggle is off', () => {
    const request = toEvaluateRequest({
      ...DEFAULT_FORM,
      provideLatencyEvidence: false,
      latencyEvidence: [emptyLatencyEntry('cmi-scale-to-zero')],
    });
    expect(request.latencyEvidence).toBeNull();
  });

  it('skips evidence rows with a blank candidate id', () => {
    const request = toEvaluateRequest({
      ...DEFAULT_FORM,
      provideLatencyEvidence: true,
      latencyEvidence: [
        emptyLatencyEntry('cmi-scale-to-zero'),
        emptyLatencyEntry('  '),
      ],
    });
    expect(Object.keys(request.latencyEvidence ?? {})).toEqual([
      'cmi-scale-to-zero',
    ]);
  });

  it('sends an empty SLO array, not a null, when there is no objective', () => {
    const request = toEvaluateRequest({ ...DEFAULT_FORM, provideSlo: false });
    expect(request.slos).toEqual([]);
  });
});

describe('validateForm', () => {
  it('accepts the default form', () => {
    expect(validateForm(DEFAULT_FORM)).toEqual([]);
  });

  it('requires the architecture the backend rejects a request without', () => {
    const issues = validateForm({ ...DEFAULT_FORM, architecture: '  ' });
    expect(issues.map((i) => i.field)).toContain('architecture');
  });

  it('rejects billable copy hours greater than the horizon', () => {
    const issues = validateForm({
      ...DEFAULT_FORM,
      horizonHours: '72',
      billableCopyHours: '100',
    });
    expect(issues.map((i) => i.field)).toContain('billableCopyHours');
  });

  it('ignores SLO fields when no objective is set', () => {
    const issues = validateForm({
      ...DEFAULT_FORM,
      provideSlo: false,
      sloThresholdMs: '',
      sloPercentile: '',
    });
    expect(issues).toEqual([]);
  });

  it('requires the threshold once an objective is set', () => {
    const issues = validateForm({
      ...DEFAULT_FORM,
      provideSlo: true,
      sloThresholdMs: '',
    });
    expect(issues.map((i) => i.field)).toContain('sloThresholdMs');
  });

  it('requires at least one permitted region', () => {
    const issues = validateForm({ ...DEFAULT_FORM, permittedRegions: '' });
    expect(issues.map((i) => i.field)).toContain('permittedRegions');
  });

  it('requires a candidate id on every evidence record', () => {
    const issues = validateForm({
      ...DEFAULT_FORM,
      provideLatencyEvidence: true,
      latencyEvidence: [emptyLatencyEntry('')],
    });
    const issue = issues.find((i) => i.entryField === 'candidateId');
    expect(issue?.entryIndex).toBe(0);
    expect(issue?.message).toContain('candidate id is required');
  });

  it('rejects duplicate evidence for the same candidate', () => {
    const issues = validateForm({
      ...DEFAULT_FORM,
      provideLatencyEvidence: true,
      latencyEvidence: [
        emptyLatencyEntry('cmi-scale-to-zero'),
        emptyLatencyEntry('cmi-scale-to-zero'),
      ],
    });
    expect(
      issues.some((i) => i.entryIndex === 1 && /Duplicate/.test(i.message))
    ).toBe(true);
  });

  it('rejects a non-numeric latency figure and reports which row and column', () => {
    const issues = validateForm({
      ...DEFAULT_FORM,
      provideLatencyEvidence: true,
      latencyEvidence: [
        { ...emptyLatencyEntry('cmi-scale-to-zero'), p99Ms: 'fast' },
      ],
    });
    const issue = issues.find((i) => i.entryField === 'p99Ms');
    expect(issue?.entryIndex).toBe(0);
  });

  it('asks for a record when evidence is enabled but empty', () => {
    const issues = validateForm({
      ...DEFAULT_FORM,
      provideLatencyEvidence: true,
      latencyEvidence: [],
    });
    expect(issues.map((i) => i.field)).toContain('latencyEvidence');
  });
});

describe('formDutyPercent', () => {
  it('returns null rather than 0 when the duty cycle is not computable', () => {
    expect(
      formDutyPercent({ ...DEFAULT_FORM, billableCopyHours: '' })
    ).toBeNull();
    expect(formDutyPercent({ ...DEFAULT_FORM, horizonHours: '0' })).toBeNull();
  });
});

describe('hasEvidenceCaveat', () => {
  it('is true for a stipulation and for supplied evidence, false for neither', () => {
    expect(
      hasEvidenceCaveat({ ...DEFAULT_FORM, assumeChecksCleared: true })
    ).toBe(true);
    expect(
      hasEvidenceCaveat({
        ...DEFAULT_FORM,
        assumeChecksCleared: false,
        provideLatencyEvidence: true,
      })
    ).toBe(true);
    expect(
      hasEvidenceCaveat({
        ...DEFAULT_FORM,
        assumeChecksCleared: false,
        provideLatencyEvidence: false,
      })
    ).toBe(false);
  });
});

describe('chat / form case syncing', () => {
  it('keeps a unique case-field allowlist without identity or approval fields', () => {
    // The source-to-source test in contract-constants checks every backend key.
    expect(new Set(ADVISOR_WRITABLE_FIELDS).size).toBe(ADVISOR_WRITABLE_FIELDS.length);
    for (const key of ['caseId', 'projectId', 'approved', 'assumeChecksCleared', 'provideLatencyEvidence']) {
      expect(ADVISOR_WRITABLE_FIELDS).not.toContain(key);
    }
  });

  it('carries the constraints that were previously dropped', () => {
    // These reached only the advisor's prose while the solver ranked against
    // different constraints.
    for (const field of [
      'permittedRegions',
      'budgetUsd',
      'concurrency',
      'sloMetric',
      'requireHeldCapacity',
      'maxOpsBurden',
    ] as const) {
      expect(ADVISOR_WRITABLE_FIELDS).toContain(field);
    }
  });

  it('normalises a region list from the wire into the form’s string form', () => {
    expect(
      caseToFormPatch({ permittedRegions: ['us-west-2', 'eu-west-1'] })
    ).toEqual({ permittedRegions: 'us-west-2, eu-west-1' });
  });

  it('round-trips a stated region and budget', () => {
    const patch = caseToFormPatch({
      permittedRegions: ['us-west-2'],
      budgetUsd: 200,
      concurrency: 4,
    });
    const request = toEvaluateRequest({ ...DEFAULT_FORM, ...patch });
    expect(request.constraints.permittedRegions).toEqual(['us-west-2']);
    expect(request.constraints.budgetUsd).toBe('200');
    expect(request.workload.concurrency).toBe(4);
  });

  it('coerces advisor numbers into the form’s string representation', () => {
    const patch = caseToFormPatch({
      horizonHours: 72,
      contextTokens: 128000,
      weightsGb: 16,
    });
    expect(patch.horizonHours).toBe('72');
    expect(patch.contextTokens).toBe('128000');
    expect(patch.weightsGb).toBe('16');
  });

  it('drops a key the advisor invented rather than writing it to the form', () => {
    const patch = caseToFormPatch({
      architecture: 'LlamaForCausalLM',
      // Not in the whitelist.
      somethingMadeUp: 'x',
      caseId: 'hijacked',
      precision: 'INT4',
    });
    expect(patch).toEqual({ architecture: 'LlamaForCausalLM' });
  });

  it('never clears a field the advisor did not mention', () => {
    // A null or blank value must not overwrite a real user value with ''.
    expect(caseToFormPatch({ architecture: null })).toEqual({});
    expect(caseToFormPatch({ architecture: '' })).toEqual({});
    expect(caseToFormPatch({})).toEqual({});
  });

  it('turns the SLO on when the advisor sets a threshold', () => {
    // The backend only sends `slos` when a threshold exists, so a threshold
    // with provideSlo false would be silently ignored on the next evaluation.
    const patch = caseToFormPatch({ sloThresholdMs: '800' });
    expect(patch.sloThresholdMs).toBe('800');
    expect(patch.provideSlo).toBe(true);
  });

  it('carries booleans through as booleans', () => {
    expect(caseToFormPatch({ weightsExportable: true })).toEqual({
      weightsExportable: true,
    });
    expect(caseToFormPatch({ requireHeldCapacity: true })).toEqual({
      requireHeldCapacity: true,
    });
  });

  it('clears the previous artifact when the model becomes API-only', () => {
    // The retest found a Llama repository and parameter count still in the case
    // after switching to an ElevenLabs TTS integration.
    const patch = caseToFormPatch({
      modelName: 'ElevenLabs (vendor API)',
      architecture: 'vendor-api',
      modality: 'TTS',
      weightsExportable: false,
    });
    expect(patch.weightsExportable).toBe(false);
    expect(patch.hfRepo).toBe('');
    expect(patch.totalParamsB).toBe('');
    expect(patch.weightsGb).toBe('');
    expect(patch.contextTokens).toBe('');
    expect(patch.licenseId).toBe('');
    expect(patch.provideLatencyEvidence).toBe(false);
  });

  it('drops the stale artifact from the request after that transition', () => {
    const patch = caseToFormPatch({
      architecture: 'vendor-api',
      weightsExportable: false,
    });
    const request = toEvaluateRequest({ ...DEFAULT_FORM, ...patch });
    // Nothing from the previous Llama default is still on the wire.
    expect(request.model.hfRepo).toBeNull();
    expect(request.model.weightsGb).toBeNull();
    expect(request.model.totalParamsB).toBeNull();
    expect(request.model.weightsExportable).toBe(false);
  });

  it('leaves an open-weights patch untouched', () => {
    const patch = caseToFormPatch({
      architecture: 'MistralForCausalLM',
      weightsExportable: true,
    });
    expect(patch.hfRepo).toBeUndefined();
    expect(patch.totalParamsB).toBeUndefined();
  });

  it('describes a patch with human labels for the updated-requirements summary', () => {
    const changes = describeCasePatch({
      architecture: 'LlamaForCausalLM',
      horizonHours: '72',
      weightsExportable: false,
    });
    // Ordered by the field declaration list, so the summary reads the same way
    // every turn regardless of the order the advisor happened to emit keys in.
    expect(changes).toEqual([
      { field: 'architecture', label: 'Architecture', value: 'LlamaForCausalLM' },
      { field: 'weightsExportable', label: 'Weights exportable', value: 'No' },
      { field: 'horizonHours', label: 'Horizon (hours)', value: '72' },
    ]);
  });

  it('describes nothing for an empty patch', () => {
    expect(describeCasePatch({})).toEqual([]);
  });

  it('projects the form onto the advisor case, omitting blanks', () => {
    const advisorCase = formToAdvisorCase({
      ...DEFAULT_FORM,
      hfRepo: '',
      provideSlo: true,
      sloThresholdMs: '800',
    });
    expect(advisorCase.architecture).toBe('LlamaForCausalLM');
    expect(advisorCase.sloThresholdMs).toBe('800');
    expect('hfRepo' in advisorCase).toBe(false);
  });

  it('omits a threshold the user has switched off', () => {
    const advisorCase = formToAdvisorCase({
      ...DEFAULT_FORM,
      provideSlo: false,
      sloThresholdMs: '800',
    });
    expect('sloThresholdMs' in advisorCase).toBe(false);
  });

  it('round-trips a patch through the form without losing a value', () => {
    const patch = caseToFormPatch({
      architecture: 'MixtralForCausalLM',
      horizonHours: 720,
      weightsExportable: false,
    });
    const advisorCase = formToAdvisorCase({ ...DEFAULT_FORM, ...patch });
    expect(advisorCase.architecture).toBe('MixtralForCausalLM');
    expect(advisorCase.horizonHours).toBe('720');
    expect(advisorCase.weightsExportable).toBe(false);
  });
});
