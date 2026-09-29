/**
 * One place for the words the product says to people.
 *
 * The non-expert review found the same jargon in a field label, the assistant's
 * reply, a validation message and a results table -- so renaming the label alone
 * moved the problem one screen along. Anything a user reads comes from here.
 *
 * Two rules:
 *
 * 1.  **Renaming a label must not rename the concept.** "Concurrency" becomes
 *     "requests running at once", not "users": those are different numbers.
 *     Time-to-first-audio stays distinct from total completion. The configured
 *     context limit stays distinct from the model's maximum and from the input
 *     lengths actually sent.
 * 2.  **API enums and technical identifiers are unchanged.** `LlamaForCausalLM`,
 *     `p99_latency_ms` and `BEDROCK_CMI` remain exactly what the contracts say;
 *     only their presentation is translated, and the raw value stays inspectable
 *     in the evidence panels.
 */

/** Where a value in the model block came from. */
export type FieldOrigin =
  | 'DETECTED'
  | 'PROVIDED'
  | 'EXAMPLE'
  | 'NOT_DETECTED'
  | 'NOT_APPLICABLE';

/**
 * Labels for a value's origin.
 *
 * "Detected" is reserved for an actual inspection of the model's source. A seeded
 * preset is "Example" and a typed value is "Provided by you" -- presenting either
 * as detected was the specific dishonesty the review called out.
 */
export const ORIGIN_LABEL: Record<FieldOrigin, string> = {
  DETECTED: 'Detected from model',
  PROVIDED: 'Provided by you',
  EXAMPLE: 'Example',
  NOT_DETECTED: 'Not detected',
  NOT_APPLICABLE: 'Not applicable',
};

/** Cloudscape badge colours. Grey for anything not established. */
export const ORIGIN_COLOR: Record<FieldOrigin, 'green' | 'blue' | 'grey'> = {
  DETECTED: 'green',
  PROVIDED: 'blue',
  EXAMPLE: 'grey',
  NOT_DETECTED: 'grey',
  NOT_APPLICABLE: 'grey',
};

export const ORIGIN_HELP: Record<FieldOrigin, string> = {
  DETECTED:
    "Read from the model's published metadata at a specific revision. The source and time are in Evidence.",
  PROVIDED: 'You entered this. EDDIE uses it as given and does not verify it.',
  EXAMPLE:
    'A starting value from a built-in example, not a fact about your model. Inspect the model or correct it.',
  NOT_DETECTED:
    'Not established. Checks that need this fact stay unresolved rather than assuming a value.',
  NOT_APPLICABLE:
    'Does not apply to this kind of model — a hosted API has no weight files to size.',
};

/**
 * The hosting targets, named by what they are for.
 *
 * "CMI" is removed from the primary flow entirely: it is an internal abbreviation
 * for Bedrock Custom Model Import and meant nothing to the reviewer.
 */
export const TARGET_LABEL: Record<string, string> = {
  BEDROCK_CMI: 'Import your model into Amazon Bedrock',
  BEDROCK_NATIVE: 'Use an already hosted model',
  SAGEMAKER_REALTIME: 'Managed endpoint — Amazon SageMaker',
  EC2_GPU: 'GPU server — Amazon EC2',
  VENDOR_API: "Use the provider's own API",
};

export const TARGET_HELP: Record<string, string> = {
  BEDROCK_CMI:
    'Amazon Bedrock hosts model weights you supply. You are billed for the time a copy is present and ready, in short windows, so an idle service can cost nothing between bursts.',
  BEDROCK_NATIVE:
    'A model Amazon Bedrock already serves. You pay per token and deploy nothing, but you cannot change the model.',
  SAGEMAKER_REALTIME:
    'AWS runs the serving infrastructure on instances you choose. Capacity is held continuously, so you pay for it whether or not requests arrive.',
  EC2_GPU:
    'You run the GPU servers and the serving software. The most control, and the most work: patching, scaling, monitoring and recovery are yours.',
  VENDOR_API:
    "The model stays with its provider and you call their API. Your data crosses that boundary, and the weights are never in your account.",
};

/** Model and workload field labels, with a plain explanation of each. */
export const FIELD: Record<string, { label: string; help?: string }> = {
  modelName: { label: 'Model name' },
  modelSource: {
    label: 'Model source',
    help: 'A Hugging Face repository or link. EDDIE reads its published details; it never runs code from the repository.',
  },
  architecture: {
    label: 'Architecture',
    help: "Read from the model's configuration and used to check which hosting options support it.",
  },
  modality: {
    label: 'What should the model work with?',
    help: 'Text, images, audio, or a supported combination.',
  },
  precision: {
    label: 'Number format of the weights',
    help: 'How precisely each weight is stored. Changing it is a conversion with quality and speed consequences, not a setting.',
  },
  totalParamsB: {
    label: 'Size (billions of parameters)',
    help: 'How many parameters the model has. Counted from the model files, not from its name.',
  },
  contextTokens: {
    label: 'Longest input the model supports',
    help: 'The maximum from the model configuration. What this deployment is configured for, and how long your actual requests are, are separate questions.',
  },
  weightsGb: {
    label: 'Model file size (GiB)',
    help: 'The download size of one copy of the weights. This is not the GPU memory needed: the runtime, the cache and each simultaneous request add to it.',
  },
  usageTerms: {
    label: 'Usage terms',
    help: 'The licence the model is published under, and whether anything still has to be accepted before the weights can be used.',
  },
  weightsExportable: {
    label: 'Can this model be hosted in your AWS account?',
    help: 'True only when model files are actually available to you. A provider offering an API does not mean its weights can be deployed.',
  },
  horizonHours: {
    label: 'How long will you run it?',
    help: 'The period every option is costed over. A date range, a duration, or a comparison window.',
  },
  billableCopyHours: {
    label: 'Hours active during that period',
    help: 'Estimated billable time for a copy that pauses when idle. Include time it stays loaded between requests. Choose Always on for continuous service.',
  },
  concurrency: {
    label: 'Requests or live sessions at once',
    help: 'The peak number running simultaneously — not your total number of users.',
  },
  budgetUsd: {
    label: 'Most you can spend over that period',
  },
  permittedRegions: {
    label: 'Where may this run?',
    help: 'AWS Regions your data may be processed in.',
  },
  maxOpsBurden: {
    label: 'What will your team manage?',
    help: 'How much of the serving work you are willing to own: updates, scaling, monitoring and recovery.',
  },
  sloThresholdMs: {
    label: 'Response-time target',
  },
  requireHeldCapacity: {
    label: 'Must capacity be reserved in advance?',
  },
};

/** Response-time metrics. The distinction between these is preserved. */
export const METRIC_LABEL: Record<string, string> = {
  p99_latency_ms: 'Full response, 99% of requests',
  p95_latency_ms: 'Full response, 95% of requests',
  p50_latency_ms: 'Full response, half of requests',
  ttft_ms: 'Time until the first text appears',
  ttfa_ms: 'Time until the first audio plays',
  conversation_response_ms: 'Delay before the model replies in conversation',
};

export const METRIC_HELP: Record<string, string> = {
  p99_latency_ms:
    'The whole response completes within this time for at least 99% of requests. The slowest 1% may take longer.',
  p95_latency_ms:
    'The whole response completes within this time for at least 95% of requests.',
  p50_latency_ms:
    'Half of requests complete within this time. Half take longer, so this is not a guarantee.',
  ttft_ms:
    'How long before the first word appears. Streaming can start early while the full answer still takes longer.',
  ttfa_ms:
    'How long before the first audio is heard. Distinct from how long the whole utterance takes.',
  conversation_response_ms:
    'How long the person waits before the model starts responding in a live exchange.',
};

/**
 * Requirement-check outcomes.
 *
 * UNKNOWN is deliberately split. "Not checked yet", "Couldn't verify" and "Not
 * enough information" are different situations with different next actions, and
 * collapsing them into one word left users with nothing to do about it.
 */
export const CHECK_STATUS_LABEL: Record<string, string> = {
  PASS: 'Meets this requirement',
  FAIL: "Doesn't meet this requirement",
  UNKNOWN: 'Not enough information',
  NOT_CHECKED: 'Not checked yet',
  UNVERIFIABLE: "Couldn't verify",
};

/** How well a figure is established. Applicability and sources stay in details. */
export const EVIDENCE_LABEL: Record<string, string> = {
  MEASURED: 'Tested for this configuration',
  SUPPLIED: 'Provided results',
  PROJECTED: 'Estimated',
  UNKNOWN: 'Not enough information',
  LIVE: 'Current AWS price',
  PINNED: 'Recorded AWS price',
};

export const LATENCY_STATUS_LABEL: Record<string, string> = {
  MEASURED: 'Tested for this configuration',
  SUPPLIED: 'Based on results you provided',
  NOT_MEASURED: 'Not tested',
  NOT_REQUESTED: 'Response-time target not set',
};

/** Terms that need a plain gloss the first time they appear. */
export const GLOSS: Record<string, string> = {
  dutyCycle:
    'The share of the period a copy has to be present and ready. Six hours of traffic in a three-day event is about 8%.',
  breakeven:
    'The point where two options cost the same. Below it the burst-priced option is cheaper; above it the continuously running one is.',
  quota:
    "A limit on your AWS account for a particular resource. Having room under the limit does not mean a GPU is free to allocate.",
  coldStart:
    'The delay when a copy has to be loaded because none was running. It affects the first request after an idle period.',
};

/** The word for a target that cannot be assessed because a model fact is missing. */
export const NEEDS_MODEL_INFORMATION = 'Needs model information';

/**
 * Turn a raw target id into a name, falling back to the id.
 *
 * Falls back rather than throwing: a target added to the backend before this map
 * should appear under its identifier, not crash the page or vanish from a list.
 */
export function targetLabel(target: string | null | undefined): string {
  if (!target) return 'Unknown option';
  return TARGET_LABEL[target] ?? target;
}

export function metricLabel(metric: string | null | undefined): string {
  if (!metric) return 'Response time';
  return METRIC_LABEL[metric] ?? metric;
}

export function fieldLabel(name: string): string {
  return FIELD[name]?.label ?? name;
}

export function fieldHelp(name: string): string | undefined {
  return FIELD[name]?.help;
}
