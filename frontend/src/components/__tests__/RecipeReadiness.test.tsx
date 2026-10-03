import { webcrypto } from 'node:crypto';
import { screen, waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import { TestDeployment } from '../TestDeployment';
import type { DeploymentCapability } from '../../api/types';
import capability from '../../test/fixtures/speech-only-capability.json';
import { okEnvelope, renderWithProviders } from '../../test/harness';
import { EMPTY_PROJECT } from '../../state/caseForm';

it('does not offer a GPU Qwen trial in a speech-only installation', async () => {
  const actions: string[] = [];
  Object.defineProperty(globalThis.crypto, 'subtle', {
    value: webcrypto.subtle, configurable: true,
  });
  renderWithProviders(<TestDeployment
    capability={capability as DeploymentCapability} onStarted={() => {}}
  />, {
    withCase: true,
    initialForm: {
      ...EMPTY_PROJECT, hfRepo: 'Qwen/Qwen2.5-0.5B-Instruct',
      modelName: 'Qwen2.5 0.5B Instruct', hfCommit: 'b'.repeat(40),
      sourceKind: 'huggingface', permittedRegions: 'us-east-1',
    },
    handler: (action) => {
      actions.push(action);
      return okEnvelope(action, action === 'plan.list' ? { plans: [] } : {});
    },
  });
  expect(capability.speechRecipe.available).toBe(true);
  expect(capability.checkpointRecipe.available).toBe(false);
  await waitFor(() => expect(actions).toContain('plan.list'));
  const button = screen.queryByRole('button', { name: 'Review test deployment' });
  expect(button === null || button.hasAttribute('disabled')).toBe(true);
});
