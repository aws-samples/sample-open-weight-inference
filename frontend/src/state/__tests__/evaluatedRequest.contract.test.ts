import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  COSMETIC_WORKLOAD_KEYS,
  SOLVER_RELEVANT_KEYS,
  canonicalEvaluatePayload,
  evaluatedRequestChanges,
  evaluatedRequestMatches,
} from '../evaluatedRequest';
import { burstyResult, steadyResult } from '../../test/fixtures';

/**
 * Contract: the frontend's notion of "solver-relevant" must match the backend's.
 *
 * The backend computes `evaluatedRequestHash` over a fixed field selection in
 * `_payload_hash`. The frontend does not reimplement that hash — it compares the
 * live form's projected payload against the decision's own `evaluatedRequest`
 * field by field — so what has to stay in step is the *field selection*. This
 * test reads it out of the backend source rather than restating it, because a
 * hand-copied list drifts exactly the way the constant would.
 *
 * The pinned hashes below were produced by executing the backend's own
 * `_payload_hash` over the fixture payloads, not written by hand.
 */

const BACKEND = join(__dirname, '..', '..', '..', '..', 'backend');

function backendSource(): string {
  return readFileSync(join(BACKEND, 'runtime', 'app.py'), 'utf8');
}

/** Pull the `relevant = {...}` block out of `_payload_hash`. */
function payloadHashBody(): string {
  const source = backendSource();
  const start = source.indexOf('def _payload_hash(');
  expect(start, '_payload_hash not found in the backend').toBeGreaterThan(-1);
  const end = source.indexOf('def ', start + 10);
  return source.slice(start, end === -1 ? undefined : end);
}

describe('solver-relevant field selection matches the backend', () => {
  const body = payloadHashBody();

  it('hashes exactly the top-level keys the frontend compares', () => {
    const keys = [...body.matchAll(/^\s{8}"([a-zA-Z]+)":/gm)].map(
      (match) => match[1]
    );
    expect(keys.length).toBeGreaterThan(0);
    expect([...keys].sort()).toEqual([...SOLVER_RELEVANT_KEYS].sort());
  });

  it('excludes caseId from identity, as the frontend does', () => {
    // A renamed case must not invalidate its result.
    expect(SOLVER_RELEVANT_KEYS).not.toContain('caseId');
    expect(body).not.toMatch(/"caseId":/);
  });

  it('excludes the same cosmetic workload keys', () => {
    for (const key of COSMETIC_WORKLOAD_KEYS) {
      expect(body).toContain(`k != "${key}"`);
    }
    // And nothing else is excluded on the backend side.
    const excluded = [...body.matchAll(/k != "([a-zA-Z]+)"/g)].map((m) => m[1]);
    expect(excluded.sort()).toEqual([...COSMETIC_WORKLOAD_KEYS].sort());
  });

  it('truncates the hash to 32 hex characters', () => {
    expect(body).toContain('[:32]');
    for (const hash of [
      burstyResult.evaluatedRequestHash,
      steadyResult.evaluatedRequestHash,
    ]) {
      expect(hash).toMatch(/^[0-9a-f]{32}$/);
    }
  });
});

describe('the three behaviours the backend hash guarantees', () => {
  /*
   * Verified against the deployed backend by the coordinator, and reproduced
   * here against the frontend's comparison so the two cannot disagree about
   * which edits invalidate a decision.
   */
  const evaluated = burstyResult.evaluatedRequest;

  it('a cosmetic edit does not invalidate a result', () => {
    const cosmetic = {
      ...(evaluated as Record<string, unknown>),
      caseId: 'renamed',
      workload: {
        ...((evaluated as { workload: Record<string, unknown> }).workload),
        description: 'A completely different note',
      },
    };
    expect(evaluatedRequestChanges(evaluated, cosmetic)).toEqual([]);
    expect(evaluatedRequestMatches(evaluated, cosmetic)).toBe(true);
  });

  it('changing horizonHours invalidates a result', () => {
    const changed = {
      ...(evaluated as Record<string, unknown>),
      workload: {
        ...((evaluated as { workload: Record<string, unknown> }).workload),
        horizonHours: '720',
      },
    };
    expect(evaluatedRequestChanges(evaluated, changed)).toEqual([
      'Horizon (hours)',
    ]);
  });

  it('changing assumeChecksCleared invalidates a result', () => {
    const changed = {
      ...(evaluated as Record<string, unknown>),
      assumeChecksCleared: false,
    };
    expect(evaluatedRequestChanges(evaluated, changed)).toEqual([
      'Stipulated checks',
    ]);
  });

  it('the fixture hashes differ, because the fixtures differ consequentially', () => {
    expect(burstyResult.evaluatedRequestHash).not.toBe(
      steadyResult.evaluatedRequestHash
    );
    expect(
      evaluatedRequestChanges(
        burstyResult.evaluatedRequest,
        steadyResult.evaluatedRequest
      ).length
    ).toBeGreaterThan(0);
  });
});

describe('canonicalisation is stable', () => {
  it('is idempotent', () => {
    const once = canonicalEvaluatePayload(burstyResult.evaluatedRequest);
    const twice = canonicalEvaluatePayload(once);
    expect(twice).toEqual(once);
  });

  it('treats a missing payload as no information rather than as a difference', () => {
    // Without an evaluated request there is nothing to be stale against, so the
    // decision is not marked out of date on a guess.
    expect(evaluatedRequestChanges(null, burstyResult.evaluatedRequest)).toEqual(
      []
    );
    expect(canonicalEvaluatePayload(null)).toEqual({});
  });
});
