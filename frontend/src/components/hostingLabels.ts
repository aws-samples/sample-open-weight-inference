import type { Candidate } from '../api/types';
import { toNumber } from './format';

/** A comparison period, not a promise about how long resources will run. */
export function comparisonPeriod(hours: string | undefined): string {
  const value = toNumber(hours);
  if (value === null) return 'the requested period';
  if (value > 0 && value % 24 === 0) {
    const days = value / 24;
    return `${days.toLocaleString('en-US')} ${days === 1 ? 'day' : 'days'}`;
  }
  return `${value.toLocaleString('en-US')} ${value === 1 ? 'hour' : 'hours'}`;
}

export function hostingOptionName(candidate: Candidate): string {
  if (candidate.target === 'BEDROCK_NATIVE') {
    return candidate.inferenceProfileId ? 'Amazon Bedrock · cross-region API' : 'Amazon Bedrock · model API';
  }
  if (candidate.target === 'BEDROCK_CMI') {
    return candidate.scaleToZero ? 'Amazon Bedrock · pause when idle' : 'Amazon Bedrock · keep ready';
  }
  if (candidate.target === 'SAGEMAKER_REALTIME') {
    return `Amazon SageMaker · ${candidate.instanceType ?? 'dedicated endpoint'}`;
  }
  if (candidate.target === 'EC2_CPU') return `Amazon EC2 CPU · ${candidate.instanceType}`;
  if (candidate.target === 'AWS_BATCH_CPU') return `AWS Batch on EC2 CPU · ${candidate.instanceType}`;
  return candidate.target;
}

export const CHECK_LABELS: Record<string, string> = {
  region: 'Allowed locations',
  architecture: 'Model compatibility',
  modality: 'Text, image or audio support',
  weights_exportable: 'Access to model files',
  license: 'Usage terms and access',
  licence: 'Usage terms and access',
  recipe: 'Serving software',
  quota: 'Account quota',
  capacity: 'Available capacity',
  latency: 'Response time',
  quality: 'Answer quality',
  budget: 'Budget',
  operations: 'Operational effort',
  ops: 'Operational effort',
  declared_requirements: 'Other requirements',
  cpu_runtime: 'CPU runtime compatibility',
  cpu_memory: 'CPU process memory',
  cpu_delivery: 'Delivery, deadline and workload',
};
