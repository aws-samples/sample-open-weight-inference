import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { AwsDocumentationSources } from '../AwsDocumentationSources';
import type { AwsDocumentationReceipt } from '../../api/types';

const receipt: AwsDocumentationReceipt = {
  provider: 'AWS Knowledge MCP', affectsPlacement: false,
  checks: [{ topic: 'bedrock-import', label: 'Bedrock Custom Model Import', state: 'RETRIEVED',
    retrievedAt: '2026-09-29T01:00:00Z', sources: [{ id: 'source-1', title: 'Import documentation',
      url: 'https://docs.aws.amazon.com/bedrock/latest/userguide/model-customization-import-model.html' }] }],
};

describe('AWS documentation receipts', () => {
  it('shows retrieved sources without claiming verified answers', async () => {
    render(<AwsDocumentationSources receipt={receipt} />);
    expect(screen.getByText('AWS documentation retrieved')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'AWS documentation sources' }));
    expect(screen.getByRole('link', { name: /Import documentation/ })).toHaveAttribute('href', receipt.checks[0].sources[0].url);
    expect(screen.getByText(/not your account access/)).toBeVisible();
    expect(screen.queryByText(/answer verified/i)).toBeNull();
  });

  it.each(['DISABLED', 'UNAVAILABLE', 'NO_RESULTS'] as const)('keeps %s honest', async state => {
    render(<AwsDocumentationSources receipt={{ ...receipt, checks: [{ ...receipt.checks[0], state, retrievedAt: null, sources: [] }] }} />);
    expect(screen.getByText('AWS documentation checks incomplete')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'AWS documentation sources' }));
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.queryByText('AWS documentation retrieved')).toBeNull();
  });

  it('keeps the source link but marks a failed detail read incomplete', async () => {
    render(<AwsDocumentationSources receipt={{ ...receipt, checks: [{ ...receipt.checks[0], state: 'PARTIAL' }] }} />);
    expect(screen.getByText('AWS documentation checks incomplete')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'AWS documentation sources' }));
    expect(screen.getByText(/a needed section could not be read/)).toBeVisible();
    expect(screen.getByRole('link', { name: /Import documentation/ })).toBeVisible();
    expect(screen.queryByText('AWS documentation retrieved')).toBeNull();
  });

  it('does not add a notice for a general conversation without AWS checks', () => {
    const { container } = render(<AwsDocumentationSources receipt={{ ...receipt, checks: [] }} />);
    expect(container).toBeEmptyDOMElement();
  });

  it.each(['javascript:alert(1)', 'https://attacker.example/',
    'https://docs.aws.amazon.com.attacker.example/page', 'https://user:password@docs.aws.amazon.com/page',
    'https://docs.aws.amazon.com/page?private=secret', 'https://docs.aws.amazon.com/%2f%2fattacker.example'])
  ('does not render a hostile source link: %s', async url => {
    render(<AwsDocumentationSources receipt={{ ...receipt, checks: [{ ...receipt.checks[0], sources: [{ id: 'bad', title: '<script>bad</script>', url }] }] }} />);
    await userEvent.click(screen.getByRole('button', { name: 'AWS documentation sources' }));
    expect(screen.queryByRole('link')).toBeNull();
    expect(document.querySelector('script')).toBeNull();
  });
});
