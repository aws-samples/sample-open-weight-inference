import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BreakevenPanel, VERDICT_HEADLINE } from '../BreakevenPanel';
import { burstyResult, steadyResult } from '../../test/fixtures';
import type { Breakeven } from '../../api/types';

describe('BreakevenPanel — verdict rendering in both directions', () => {
  it('renders BURST_FAVOURS_CMI with its headline, code and duty figures', () => {
    render(<BreakevenPanel breakeven={burstyResult.breakeven} />);

    expect(screen.getByTestId('breakeven-verdict-headline')).toHaveTextContent(
      VERDICT_HEADLINE.BURST_FAVOURS_CMI
    );
    expect(screen.getByTestId('breakeven-verdict-code')).toHaveTextContent(
      'BURST_FAVOURS_CMI'
    );
    // The figures appear both in the summary pairs and in the data table.
    expect(screen.getAllByText('17.02%').length).toBeGreaterThan(0);
    expect(screen.getAllByText('8.33%').length).toBeGreaterThan(0);
    expect(
      screen.getByText(/below the 17.02% break-even/)
    ).toBeInTheDocument();
  });

  it('renders STEADY_FAVOURS_DEDICATED with its headline, code and duty figures', () => {
    render(<BreakevenPanel breakeven={steadyResult.breakeven} />);

    expect(screen.getByTestId('breakeven-verdict-headline')).toHaveTextContent(
      VERDICT_HEADLINE.STEADY_FAVOURS_DEDICATED
    );
    expect(screen.getByTestId('breakeven-verdict-code')).toHaveTextContent(
      'STEADY_FAVOURS_DEDICATED'
    );
    expect(screen.getAllByText('100.00%').length).toBeGreaterThan(0);
    expect(
      screen.getByText(/above the 17.02% break-even/)
    ).toBeInTheDocument();
  });

  it('does not leak the opposite verdict headline', () => {
    render(<BreakevenPanel breakeven={burstyResult.breakeven} />);
    expect(
      screen.queryByText(VERDICT_HEADLINE.STEADY_FAVOURS_DEDICATED)
    ).toBeNull();
  });
});

describe('BreakevenPanel — missing data', () => {
  it('explains the absence rather than rendering an empty panel', () => {
    render(<BreakevenPanel breakeven={null} />);
    expect(
      screen.getByText('No break-even comparison available')
    ).toBeInTheDocument();
  });

  it('states that a null verdict is a null verdict', () => {
    const breakeven: Breakeven = {
      breakevenDutyPercent: '17.02',
      cmiActiveHourly: '6.86',
      dedicatedHourly: '1.22',
      actualDutyPercent: '17.02',
      verdict: null,
      explanation: 'The duty cycle sits on the break-even point.',
      cmiComparedCandidate: 'cmi-scale-to-zero',
      dedicatedComparedCandidate: 'sagemaker-dedicated-warm',
    };
    render(<BreakevenPanel breakeven={breakeven} />);
    expect(screen.getByText('No verdict')).toBeInTheDocument();
  });

  it('renders an unknown duty cycle as UNKNOWN and refuses to chart it', () => {
    const breakeven: Breakeven = {
      breakevenDutyPercent: null,
      cmiActiveHourly: null,
      dedicatedHourly: '1.22',
      actualDutyPercent: '8.33',
      verdict: null,
      explanation: null,
      cmiComparedCandidate: null,
      dedicatedComparedCandidate: 'sagemaker-dedicated-warm',
    };
    render(<BreakevenPanel breakeven={breakeven} />);
    expect(
      screen.getByText('Duty cycle cannot be charted')
    ).toBeInTheDocument();
    expect(screen.getAllByText('UNKNOWN').length).toBeGreaterThan(0);
  });
});
