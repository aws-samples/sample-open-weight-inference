import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ADVISOR_WRITABLE_FIELDS,
  KNOWN_CANDIDATE_IDS,
  MODALITY_OPTIONS,
  MODEL_PRESETS,
  OPS_BURDEN_OPTIONS,
  VENDOR_API_ARCHITECTURE,
} from '../caseForm';
import { summariseBlockingGates } from '../../components/blockingGates';
import type { Candidate } from '../../api/types';

/**
 * Contract constants pinned against the backend.
 *
 * Every value here is validated server-side by an exact enum or dictionary
 * lookup, so a frontend constant that drifts does not degrade gracefully — it
 * makes the option unusable and returns `invalid_request`. Two such drifts
 * have already shipped (modality and ops burden), so these tests read the
 * backend source directly rather than restating the values by hand: a
 * hand-copied expectation drifts in exactly the same way as the constant.
 */

const BACKEND = join(__dirname, '..', '..', '..', '..', 'backend');

function readBackend(relativePath: string): string {
  return readFileSync(join(BACKEND, relativePath), 'utf8');
}

/** Extract `NAME = "VALUE"` members of a `str, Enum` class. */
function strEnumValues(source: string, className: string): string[] {
  const body = enumBody(source, className);
  return [...body.matchAll(/^\s{4}([A-Z_0-9]+)\s*=\s*"([^"]+)"/gm)].map(
    (match) => match[2]
  );
}

/** Extract member *names* of an enum (used for int-valued enums). */
function enumNames(source: string, className: string): string[] {
  const body = enumBody(source, className);
  return [...body.matchAll(/^\s{4}([A-Z_0-9]+)\s*=\s*/gm)].map(
    (match) => match[1]
  );
}

function enumBody(source: string, className: string): string {
  const start = source.indexOf(`class ${className}(`);
  if (start === -1) throw new Error(`Backend class ${className} not found.`);
  const after = source.slice(start);
  // A class body ends at the next top-level `class ` or `def `.
  const end = after.slice(1).search(/\n(?:class |def )/);
  return end === -1 ? after : after.slice(0, end + 1);
}

describe('backend source is readable', () => {
  it('finds the solver models module', () => {
    expect(readBackend('solver/models.py')).toContain('class Modality');
  });
});

describe('advisor case fields stay in sync with the server', () => {
  it('supports the server allowlist, including qualification and inspected facts', () => {
    const source = readBackend('runtime/app.py');
    const body = source.split('ADVISOR_WRITABLE_FIELDS = frozenset(')[1].split('\n)')[0]
      .replace(/#.*$/gm, '');
    const writable = [...body.matchAll(/"([A-Za-z]+)"/g)].map((match) => match[1]);
    const qualification = [...readBackend('solver/qualification.py')
      .split('\n\n\ndef parse_qualification')[0]
      .matchAll(/^\s{4}"([A-Za-z]+)":/gm)].map((match) => match[1]);
    // These arrive only from inspection in the server result. Precision uses
    // the separate inspected-model path and is not an advisor case patch.
    const expected = [...new Set([...writable, ...qualification,
      'totalParamsB', 'contextTokens', 'weightsGb', 'licenseId'])].sort();
    expect([...ADVISOR_WRITABLE_FIELDS].sort()).toEqual(expected);
  });
});

describe('modality options match the backend Modality enum', () => {
  const backendValues = strEnumValues(
    readBackend('solver/models.py'),
    'Modality'
  );

  it('offers exactly the backend values, in the backend order', () => {
    expect(MODALITY_OPTIONS.map((item) => item.value)).toEqual(backendValues);
  });

  it('offers no value the backend would reject', () => {
    for (const item of MODALITY_OPTIONS) {
      expect(backendValues).toContain(item.value);
    }
  });

  it('never reintroduces the invalid options that shipped before', () => {
    // AUDIO, IMAGE and MULTIMODAL are not Modality members. A user who picked
    // AUDIO could only ever get `invalid_request`.
    const offered = MODALITY_OPTIONS.map((item) => item.value);
    for (const invalid of ['AUDIO', 'IMAGE', 'MULTIMODAL']) {
      expect(offered).not.toContain(invalid);
      expect(backendValues).not.toContain(invalid);
    }
  });

  it('gives every option a human label distinct from the raw enum value', () => {
    for (const item of MODALITY_OPTIONS) {
      expect(item.label.length).toBeGreaterThan(0);
      expect(item.label).not.toBe(item.value);
    }
  });
});

describe('ops-burden options match the backend OpsBurden enum', () => {
  // The handler does `OpsBurden[value]`, a lookup by member *name*.
  const backendNames = enumNames(readBackend('solver/models.py'), 'OpsBurden');

  it('offers exactly the backend member names', () => {
    expect(OPS_BURDEN_OPTIONS.map((item) => item.value)).toEqual(backendNames);
  });

  it('never reintroduces the invalid names that shipped before', () => {
    const offered = OPS_BURDEN_OPTIONS.map((item) => item.value);
    for (const invalid of [
      'MANAGED_ENDPOINT',
      'SELF_MANAGED_HOST',
      'CLUSTER_RUNTIME',
    ]) {
      expect(offered).not.toContain(invalid);
      expect(backendNames).not.toContain(invalid);
    }
  });

  it('gives every option a human label', () => {
    for (const item of OPS_BURDEN_OPTIONS) {
      expect(item.label.length).toBeGreaterThan(0);
    }
  });
});

describe('candidate ids match the ids the solver enumerates', () => {
  const source = readBackend('catalog/candidates.py');

  it('lists the two CMI candidate ids verbatim', () => {
    for (const id of ['cmi-scale-to-zero', 'cmi-prewarmed']) {
      expect(source).toContain(`candidate_id="${id}"`);
      expect(KNOWN_CANDIDATE_IDS).toContain(id);
    }
  });

  it('derives the SageMaker ids from the backend instance shortlist', () => {
    const shortlist = source.match(/SAGEMAKER_SHORTLIST\s*=\s*\(([^)]*)\)/);
    expect(shortlist).not.toBeNull();
    const instances = [
      ...(shortlist as RegExpMatchArray)[1].matchAll(/"([^"]+)"/g),
    ].map((match) => match[1]);
    expect(instances.length).toBeGreaterThan(0);
    for (const instance of instances) {
      expect(KNOWN_CANDIDATE_IDS).toContain(`sagemaker-${instance}`);
    }
  });

  it('offers no candidate id the solver never produces', () => {
    const shortlist = source.match(/SAGEMAKER_SHORTLIST\s*=\s*\(([^)]*)\)/);
    const instances = [
      ...(shortlist as RegExpMatchArray)[1].matchAll(/"([^"]+)"/g),
    ].map((match) => match[1]);
    const valid = new Set([
      'cmi-scale-to-zero',
      'cmi-prewarmed',
      ...instances.map((instance) => `sagemaker-${instance}`),
    ]);
    for (const id of KNOWN_CANDIDATE_IDS) {
      expect([...valid]).toContain(id);
    }
  });
});

describe('every gate the solver emits has a remedy in the empty state', () => {
  const gateNames = [
    ...new Set(
      [...readBackend('solver/solve.py').matchAll(/Gate\(\s*"([a-z_]+)"/g)].map(
        (match) => match[1]
      )
    ),
  ];

  it('finds the solver gate names', () => {
    expect(gateNames.length).toBeGreaterThan(5);
    expect(gateNames).toContain('weights_exportable');
    expect(gateNames).toContain('operations');
  });

  it('maps every gate name to a remedy and a form section', () => {
    // A gate with no remedy is a dead end for the user, which is the reported
    // bug. `weights_exportable` and `operations` both previously fell through.
    const unmapped: string[] = [];
    for (const name of gateNames) {
      const candidate: Candidate = {
        candidateId: 'c',
        target: 'BEDROCK_CMI',
        region: 'us-east-1',
        modelRef: 'm',
        instanceType: null,
        instanceCount: '1',
        cmusPerCopy: null,
        scaleToZero: true,
        prewarmed: false,
        opsBurden: 'SERVICE_API',
        blastRadius: 'SERVICE_SHARED',
        recipeId: null,
        notes: null,
        isFeasible: false,
        cost: null,
        gates: [{ name, status: 'UNKNOWN', reason: null, evidenceRef: null }],
        failureCount: 0,
        unknownCount: 1,
      };
      const [summary] = summariseBlockingGates([candidate], []);
      if (!summary.remedy || !summary.section) unmapped.push(name);
    }
    expect(unmapped).toEqual([]);
  });
});

describe('model presets are internally consistent', () => {
  it('gives every preset a unique id and label', () => {
    expect(new Set(MODEL_PRESETS.map((p) => p.id)).size).toBe(
      MODEL_PRESETS.length
    );
    expect(new Set(MODEL_PRESETS.map((p) => p.label)).size).toBe(
      MODEL_PRESETS.length
    );
  });

  it('uses only valid modality values', () => {
    const valid = MODALITY_OPTIONS.map((item) => item.value);
    for (const preset of MODEL_PRESETS) {
      expect(valid).toContain(preset.patch.modality);
    }
  });

  it('marks every API-only preset as non-exportable with the vendor sentinel', () => {
    for (const preset of MODEL_PRESETS.filter((item) => item.apiOnly)) {
      expect(preset.patch.weightsExportable).toBe(false);
      expect(preset.patch.architecture).toBe(VENDOR_API_ARCHITECTURE);
    }
  });

  it('leaves self-hosting fields blank on an API-only preset rather than guessing', () => {
    // A wrong weightsGb silently changes which instances look feasible, so a
    // value that does not exist must be absent, not invented.
    for (const preset of MODEL_PRESETS.filter((item) => item.apiOnly)) {
      expect(preset.patch.totalParamsB).toBe('');
      expect(preset.patch.contextTokens).toBe('');
      expect(preset.patch.weightsGb).toBe('');
      expect(preset.patch.licenseId).toBe('');
      expect(preset.patch.hfRepo).toBe('');
    }
  });

  it('explains why each API-only preset cannot be self-hosted', () => {
    for (const preset of MODEL_PRESETS.filter((item) => item.apiOnly)) {
      expect(preset.note).toBeTruthy();
    }
  });

  it('gives every open-weights preset a complete self-hosting block', () => {
    for (const preset of MODEL_PRESETS.filter((item) => !item.apiOnly)) {
      expect(preset.patch.weightsExportable).toBe(true);
      expect(preset.patch.architecture).not.toBe(VENDOR_API_ARCHITECTURE);
      for (const field of [
        'totalParamsB',
        'contextTokens',
        'weightsGb',
        'licenseId',
        'hfRepo',
      ] as const) {
        expect(preset.patch[field]).not.toBe('');
      }
      expect(Number(preset.patch.totalParamsB)).toBeGreaterThan(0);
      expect(Number(preset.patch.weightsGb)).toBeGreaterThan(0);
      expect(Number(preset.patch.contextTokens)).toBeGreaterThan(0);
    }
  });

  it('covers the API-only cases the user actually tried', () => {
    const labels = MODEL_PRESETS.map((item) => item.label);
    expect(labels.some((label) => /ElevenLabs/i.test(label))).toBe(true);
    expect(labels.some((label) => /Cartesia/i.test(label))).toBe(true);
    expect(labels.some((label) => /Nova 2 Sonic/i.test(label))).toBe(true);
    expect(labels.some((label) => /Transcribe/i.test(label))).toBe(true);
  });
});
