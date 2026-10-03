import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DeploymentDetails, modelLabel } from '../DeploymentDetails';
import { okEnvelope, renderWithProviders } from '../../test/harness';
import type { DeploymentView } from '../../api/types';

const live: DeploymentView = {
  jobId: 'job-speech', planId: 'plan-speech', projectId: 'project', target: 'SAGEMAKER_REALTIME',
  state: 'EXPERIMENTAL', recipeId: 'sagemaker-magpie-cpu', instanceType: 'ml.m6g.xlarge',
  modelRef: 's3://library/manifest.json', region: 'us-east-1', hourlyUsd: '0.1848',
  createdAt: '2026-10-03T08:30:00Z', updatedAt: '2026-10-03T08:33:00Z',
  deadlineAt: '2026-10-03T08:55:00Z', resourceExpiresAt: '2026-10-03T09:00:00Z', resourcesExpired: false,
  steps: [{ name: 'create-endpoint', state: 'DONE', startedAt: null, endedAt: null, detail: 'In service.' },
    { name: 'test-invocation', state: 'PENDING', startedAt: null, endedAt: null, detail: '' }],
  resources: [], billableResourceCount: 1, failureReason: null, publishedRoute: null,
};

const receipt = {
  runId: 'invoke-1', at: '2026-10-03T08:35:19Z', model: live.modelRef!, revision: 'r', jobId: live.jobId,
  elapsedMs: '37516.9', metric: 'single_request_end_to_end_ms' as const, sampleCount: 1,
  percentileQualified: false, qualityQualified: false, promptStored: false, outputStored: false,
  decoded: true, audioSeconds: '11.61', sampleRateHz: 22050, synthesisSeconds: '37.333',
  peakRssMiB: '893.4', speaker: 'jason', inputSha256: 'a'.repeat(64), outputSha256: 'b'.repeat(64),
  instanceType: 'ml.m6g.xlarge',
};

describe('a speech trial', () => {
  beforeEach(() => {
    vi.stubGlobal('URL', Object.assign(URL, {
      createObjectURL: vi.fn(() => 'blob:speech'), revokeObjectURL: vi.fn(),
    }));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('sends supplied text with the preset voice and shows a decoded, unstored result', async () => {
    const { invocations } = renderWithProviders(<DeploymentDetails deployment={live} onChange={() => {}} />, {
      handler: (action) => action === 'deployment.invoke'
        ? okEnvelope(action, { audio: btoa('RIFF'), format: 'audio/wav', receipt })
        : okEnvelope(action, {}),
    });
    expect(screen.getByText('Verify complete audio')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Use the workshop sentence' }));
    expect(screen.getByText('182/200 characters')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Generate audio' }));
    expect(await screen.findByText(/Complete audio decoded: 11.61 seconds, 22050 Hz mono/)).toBeVisible();
    expect(screen.getByText(/not a throughput or speech-quality measurement/)).toBeVisible();
    expect(screen.getByRole('link', { name: 'Download the WAV' })).toHaveAttribute('href', 'blob:speech');
    const call = invocations.find((row) => row.action === 'deployment.invoke');
    expect(call?.payload).toMatchObject({ jobId: 'job-speech', speaker: 'jason' });
    expect((call?.payload as { text: string }).text.length).toBeLessThanOrEqual(200);
  });

  it('keeps the text-model trial for other recipes', () => {
    renderWithProviders(<DeploymentDetails deployment={{ ...live, recipeId: 'sagemaker-qwen-small-vllm' }} onChange={() => {}} />);
    expect(screen.getByRole('button', { name: 'Send to model' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Generate audio' })).toBeNull();
  });
});

describe('trial labels', () => {
  it('names a library model without showing its bucket or account', () => {
    const ref = 's3://eddie-lab-artifacts-123456789012/checkpoints/eddie-lab/shared/magpie-tts-v2607/' + 'd'.repeat(64) + '/manifest.json';
    expect(modelLabel(ref)).toBe('magpie-tts-v2607 · from your model library');
    expect(modelLabel(ref)).not.toContain('123456789012');
    expect(modelLabel('Qwen/Qwen2.5-0.5B-Instruct')).toBe('Qwen/Qwen2.5-0.5B-Instruct');
  });
});
