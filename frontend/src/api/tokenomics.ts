export interface PoolCost {
  instances: number;
  annualCostUsd: string | null;
  monthlyEquivalentUsd: string | null;
  upfrontUsd: string | null;
  recurringMonthlyUsd: string | null;
  termCommitmentUsd: string | null;
  annualSavingsUsd: string | null;
  savingsPercent: string | null;
  hourlyCommitmentUsd: string | null;
  costPerMillionOutputTokensUsd: string | null;
}

export interface CommitmentRow {
  id: string;
  planType: 'OnDemand' | 'Compute' | 'EC2Instance';
  termYears: number;
  paymentOption: string;
  status: 'AVAILABLE' | 'NOT_LISTED' | 'UNAVAILABLE';
  reason?: string | null;
  effectiveHourlyRateUsd: string | null;
  breakEvenAllocatedPercent: string | null;
  evidence: {
    sourceUrl?: string;
    offeringId?: string;
    sku?: string;
    effectiveDate?: string | null;
  };
  pools: PoolCost[];
}

export interface TokenomicsReport {
  schemaVersion: 1;
  scope: 'PUBLIC_EC2_COMPUTE_ESTIMATE';
  quoteHash: string;
  currency: 'USD';
  instanceType: string;
  region: string;
  poolSizes: number[];
  hoursPerDay: string;
  hoursPerYear: string;
  commitmentHoursPerYear: string;
  monthlyOutputTokens: string | null;
  retrievedAt: string;
  hardware: { gpus: number; accelerator: string; sourceUrl?: string } | null;
  rows: CommitmentRow[];
  assumptions: string[];
  calculatorUrl: string;
  sources: { label: string; url: string }[];
}

export function planName(row: CommitmentRow): string {
  return row.planType === 'OnDemand' ? 'On-Demand' :
    `${row.termYears}-year ${row.planType === 'Compute' ? 'Compute' : 'EC2 Instance'} Savings Plan`;
}

/** Export the quote's assumptions and source identities, not just its dollar cells. */
export function tokenomicsCsv(report: TokenomicsReport): string {
  const cell = (value: unknown) => {
    const text = String(value ?? '');
    const safe = /^[=+@\t\r]/.test(text) || (/^-/.test(text) && !/^-\d+(?:\.\d+)?$/.test(text))
      ? `'${text}` : text;
    return `"${safe.replace(/"/g, '""')}"`;
  };
  const data: unknown[][] = [
    ['Public EC2 compute estimate', report.instanceType, report.region, report.retrievedAt],
    ['Allocated hours per day', report.hoursPerDay, 'SP commitment hours per year', report.commitmentHoursPerYear],
    ['Monthly output tokens (supplied)', report.monthlyOutputTokens ?? 'Not supplied'],
    ...report.assumptions.map((text) => ['Assumption', text]),
    ['Plan', 'Payment', 'Status', 'Instances', 'GPUs', 'Annual USD', 'Monthly equivalent USD',
      'Upfront USD', 'Recurring monthly USD', 'Full-term commitment USD', 'Annual savings USD',
      'Savings percent', 'Effective rate USD/instance-hour', 'Hourly commitment USD',
      'USD/million supplied output tokens', 'Price SKU or offering', 'Source', 'Quote hash'],
  ];
  for (const row of report.rows) {
    for (const pool of row.pools) {
      data.push([
        planName(row), row.paymentOption, row.status, pool.instances,
        report.hardware ? report.hardware.gpus * pool.instances : 'Not verified',
        pool.annualCostUsd, pool.monthlyEquivalentUsd, pool.upfrontUsd, pool.recurringMonthlyUsd,
        pool.termCommitmentUsd, pool.annualSavingsUsd, pool.savingsPercent,
        row.effectiveHourlyRateUsd, pool.hourlyCommitmentUsd, pool.costPerMillionOutputTokensUsd,
        row.evidence.offeringId ?? row.evidence.sku, row.evidence.sourceUrl, report.quoteHash,
      ]);
    }
  }
  return data.map((row) => row.map(cell).join(',')).join('\r\n');
}
