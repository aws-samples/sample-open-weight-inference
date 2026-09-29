import type { CaseFormState } from './caseForm';

/** Declared context, carried through to the solver; never evidence of compliance. */
export const QUALIFICATION_FIELDS = [
  'workloadType', 'modelStage', 'selectionStage', 'servingPattern', 'goLiveDate',
  'platformPreference', 'growthNotes', 'availabilityNeeds', 'complianceNeeds',
  'weightCustody', 'currentSpendUsd', 'benchmarkedAlternatives', 'requestsPerMinute',
  'cpuRuntime', 'completionDeadlineSeconds', 'cpuAdditionalCostUsd',
  'batchAdditionalCostUsd', 'cpuCostNotes',
] as const;

export function qualificationPayload(form: CaseFormState): Record<string, string> | null {
  const entries = QUALIFICATION_FIELDS.flatMap((key) => {
    const value = form[key]?.trim();
    return value && value !== 'unsure' ? [[key, value]] : [];
  });
  return entries.length ? Object.fromEntries(entries) : null;
}

export function missingPlanningInputs(form: CaseFormState): { label: string; consequence: string; question: string }[] {
  const missing = [];
  if (!form.requests?.trim() && !form.requestsPerMinute?.trim() && !form.concurrency.trim()) {
    missing.push({
      label: 'Usage is not known yet',
      consequence: 'Instance costs can be estimated, but capacity has not been sized for your traffic.',
      question: 'Help me estimate usage. Ask about users, busy periods and how often they send requests. Show the arithmetic and ask me to confirm before updating my project.',
    });
  }
  if (!form.provideSlo) {
    missing.push({
      label: 'No response-time target',
      consequence: 'Options will not be checked against a speed requirement.',
      question: 'Help me choose a response-time target. Ask how people use the application and whether the first words or the whole answer matters. Do not invent measured performance.',
    });
  }
  if (!form.successCriteria?.trim()) {
    missing.push({
      label: 'Answer quality is not defined yet',
      consequence: 'We need examples of good answers before judging which model is suitable.',
      question: 'Help me define answer quality for this project. Ask for an example task, an acceptable answer and what mistakes would be unacceptable.',
    });
  }
  return missing;
}
