import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CpuComparisonInputs } from '../CpuComparisonInputs';
import { DEFAULT_FORM, toEvaluateRequest, validateForm } from '../../state/caseForm';

function Project() {
  const [form, setForm] = useState({ ...DEFAULT_FORM, modality: 'TTS' });
  return <>
    <CpuComparisonInputs form={form} onChange={(patch) => setForm((current) => ({ ...current, ...patch }))} />
    <output data-testid="payload">{JSON.stringify(toEvaluateRequest(form))}</output>
  </>;
}

describe('CPU comparison inputs', () => {
  it('keeps numerical edits while opening another control and shares them with the request', async () => {
    const user = userEvent.setup();
    render(<Project />);
    const deadline = screen.getByRole('spinbutton', { name: /Job completion deadline/ });
    await user.type(deadline, '1200');
    await user.click(screen.getByRole('button', { name: /Does the workload need live output/ }));
    await user.click(screen.getByRole('option', { name: 'Queued jobs — no live output' }));
    expect(deadline).toHaveValue(1200);
    await user.type(screen.getByRole('spinbutton', { name: 'Maximum simultaneous jobs or requests' }), '1');
    await user.type(screen.getByRole('spinbutton', { name: /Jobs or requests in/ }), '4');
    await user.click(screen.getByRole('button', { name: 'Allocation schedule and supporting charges' }));
    await user.type(screen.getByRole('spinbutton', { name: /Allocated hours per worker/ }), '2');
    await user.type(screen.getByRole('spinbutton', { name: 'Batch CPU supporting-service allowance (USD)' }), '0.50');
    await user.type(screen.getByRole('textbox', { name: 'Allowance sources and included services' }), 'Fixture estimate for storage and network');
    const payload = JSON.parse(screen.getByTestId('payload').textContent!);
    expect(payload.qualification).toMatchObject({ completionDeadlineSeconds: '1200', servingPattern: 'batch',
      cpuCostNotes: 'Fixture estimate for storage and network' });
    expect(Number(payload.qualification.batchAdditionalCostUsd)).toBe(0.5);
    expect(payload.workload).toMatchObject({ concurrency: 1, requests: '4', dedicatedInstanceHours: '2', scheduled: true });
    expect(payload.qualification.cpuAdditionalCostUsd).toBeUndefined();
  });

  it('rejects fractional concurrency and impossible per-worker allocation before comparison', () => {
    const issues = validateForm({ ...DEFAULT_FORM, concurrency: '1.5', horizonHours: '72', dedicatedInstanceHours: '73',
      completionDeadlineSeconds: '0' });
    expect(issues.map((issue) => issue.field)).toEqual(expect.arrayContaining([
      'concurrency', 'dedicatedInstanceHours', 'completionDeadlineSeconds',
    ]));
  });
});
