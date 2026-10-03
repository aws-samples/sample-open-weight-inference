import { act, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { Tokenomics } from '../Tokenomics';
import { failEnvelope, okEnvelope, renderWithProviders } from '../../test/harness';
import fixture from '../../test/fixtures/tokenomics-synthetic.json';
import { tokenomicsCsv, type TokenomicsReport } from '../../api/tokenomics';

const report = fixture as TokenomicsReport;

describe('Tokenomics with synthetic API responses', () => {
  it('adopts a newly sized instance without overwriting an explicit comparison choice', async () => {
    function SizingUpdate() {
      const [instance, setInstance] = useState('');
      return <>
        <button onClick={() => setInstance('p6-b200.48xlarge')}>Size the first model</button>
        <button onClick={() => setInstance('g5.2xlarge')}>Size another model</button>
        <Tokenomics initialInstance={instance} />
      </>;
    }
    renderWithProviders(<SizingUpdate />);
    await userEvent.click(screen.getByRole('button', { name: 'Size the first model' }));
    const instance = screen.getByRole('combobox', { name: 'EC2 instance type' });
    expect(instance).toHaveValue('p6-b200.48xlarge');
    await userEvent.clear(instance);
    await userEvent.type(instance, 'g6e.2xlarge');
    await userEvent.click(screen.getByRole('button', { name: 'Size another model' }));
    expect(instance).toHaveValue('g6e.2xlarge');
  });

  it('fetches the chosen public price scope and separates annual cost from the full commitment', async () => {
    const { invocations } = renderWithProviders(<Tokenomics />, {
      handler: (action) => okEnvelope(action, action === 'tokenomics.compare' ? report : {}),
    });
    await userEvent.click(screen.getByRole('button', { name: 'Use B200 pool example' }));
    await userEvent.click(screen.getByRole('button', { name: 'Compare public prices' }));
    await screen.findByText('Compare commitments');
    expect(invocations.find((call) => call.action === 'tokenomics.compare')?.payload).toEqual({
      instanceType: 'p6-b200.48xlarge', region: 'us-east-1', poolSizes: [1, 2],
      hoursPerDay: '24', monthlyOutputTokens: null,
    });
    expect(screen.getByRole('columnheader', { name: '1 instance (8 GPUs)' })).toBeVisible();
    expect(screen.getByRole('columnheader', { name: '2 instances (16 GPUs)' })).toBeVisible();
    const annual = within(screen.getByText('1-year Compute Savings Plan').closest('tr')!);
    expect(annual.getByText('$35,040')).toBeVisible();
    expect(annual.getByText('$70,080')).toBeVisible();
    const prepaid = within(screen.getByRole('row', { name: /3-year EC2 Instance Savings Plan All Upfront/ }));
    expect(prepaid.getByText('$105,120 paid at the start')).toBeVisible();
    expect(prepaid.getByText('$210,240 committed over 3 years')).toBeVisible();
    expect(screen.getByRole('link', { name: 'AWS Pricing Calculator' })).toHaveAttribute('href', 'https://calculator.aws/');
  });

  it('does not show missing terms as zero dollars or infer a one-year offer', async () => {
    const missing = structuredClone(report);
    const row = missing.rows.find((entry) => entry.id === 'EC2Instance-1-no-upfront')!;
    row.status = 'NOT_LISTED';
    row.reason = 'No matching public offer was returned.';
    row.effectiveHourlyRateUsd = null;
    row.pools = row.pools.map((pool) => ({
      ...pool, annualCostUsd: null, monthlyEquivalentUsd: null, termCommitmentUsd: null,
      upfrontUsd: null, annualSavingsUsd: null, savingsPercent: null,
    }));
    renderWithProviders(<Tokenomics initialInstance="p6-b200.48xlarge" />, {
      handler: (action) => okEnvelope(action, action === 'tokenomics.compare' ? missing : {}),
    });
    await userEvent.click(screen.getByRole('button', { name: 'Compare public prices' }));
    const scope = within((await screen.findByText('1-year EC2 Instance Savings Plan')).closest('tr')!);
    expect(scope.getAllByText('Not listed')).toHaveLength(2);
    expect(scope.queryByText('$0')).not.toBeInTheDocument();
    expect(scope.getByText('Not available')).toBeVisible();
  });

  it('clears the previous quote when inputs change and ignores a late response', async () => {
    let resolve!: (value: Response) => void;
    const pending = new Promise<Response>((done) => { resolve = done; });
    const { invocations } = renderWithProviders(<Tokenomics initialInstance="p6-b200.48xlarge" />, {
      handler: (action) => action === 'tokenomics.compare' ? pending : okEnvelope(action, {}),
    });
    await userEvent.click(screen.getByRole('button', { name: 'Compare public prices' }));
    await waitFor(() => expect(invocations.some((call) => call.action === 'tokenomics.compare')).toBe(true));
    const region = screen.getByRole('textbox', { name: 'Tokenomics AWS Region' });
    await userEvent.clear(region);
    await userEvent.type(region, 'us-west-2');
    await act(async () => { resolve(okEnvelope('tokenomics.compare', report)); });
    expect(screen.queryByText('Compare commitments')).not.toBeInTheDocument();
    expect(region).toHaveValue('us-west-2');
  });

  it('a failed refresh cannot leave an old quote presented as the new result', async () => {
    let calls = 0;
    renderWithProviders(<Tokenomics initialInstance="p6-b200.48xlarge" />, {
      handler: (action) => {
        if (action !== 'tokenomics.compare') return okEnvelope(action, {});
        return ++calls === 1 ? okEnvelope(action, report) :
          failEnvelope(action, 'unavailable', 'Public pricing unavailable');
      },
    });
    await userEvent.click(screen.getByRole('button', { name: 'Compare public prices' }));
    await screen.findByText('Compare commitments');
    await userEvent.click(screen.getByRole('button', { name: 'Compare public prices' }));
    await screen.findByText(/Public pricing unavailable/);
    expect(screen.queryByText('Compare commitments')).not.toBeInTheDocument();
  });

  it('exports exact values, the term, source and assumptions with spreadsheet-safe text', () => {
    const sample = structuredClone(report);
    sample.rows[1].evidence.offeringId = '=HYPERLINK("https://example.test")';
    const csv = tokenomicsCsv(sample);
    expect(csv).toContain('"105120.00"');
    expect(csv).toContain('"3-year EC2 Instance Savings Plan"');
    expect(csv).toContain('"\'=HYPERLINK(""https://example.test"")"');
    expect(csv).toContain('Savings Plans are hourly spending commitments');
    expect(csv).toContain('DescribeSavingsPlansOfferingRates'); // The pricing API source is retained.
    expect(csv).toContain(report.quoteHash);
  });
});
