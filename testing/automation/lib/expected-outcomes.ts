/**
 * What each automated case is *supposed* to do.
 *
 * Six of the nine pass. Three fail, and they are meant to: two are real
 * defects the client has not asked us to fix yet, one is a deliberate demo
 * defect. A fully green run is therefore not good news — it means an
 * assertion stopped asserting, which is the failure mode a test pack cannot
 * detect about itself.
 *
 * This module is the machine-readable half of the table in testing/README.md.
 * The prose there explains *why* each of the three fails; this exists so a run
 * can be checked against the expectation without a human reading the prose and
 * remembering it.
 *
 * When a defect is genuinely fixed, change its entry here and update
 * TEST-CASES-SHIFTPAY.md in the same commit. Changing one without the other is
 * exactly the drift both files exist to prevent.
 */

export type Outcome = 'pass' | 'fail';

export interface Expectation {
  outcome: Outcome;
  /** Why, in one line. Only meaningful for the three that fail. */
  because?: string;
  /** The board item tracking it, so a red case leads somewhere. */
  ticket?: string;
}

export const EXPECTED: Record<string, Expectation> = {
  'TC-SP-001': { outcome: 'pass' },
  'TC-SP-002': { outcome: 'pass' },
  'TC-SP-003': { outcome: 'pass' },
  'TC-SP-004': {
    outcome: 'fail',
    because: 'a refused write is painted on screen as though it succeeded',
    ticket: 'SP-57',
  },
  'TC-SP-005': {
    outcome: 'fail',
    because: 'the weekend dropdown offers two shifts the documented rules forbid',
    ticket: 'SP-58',
  },
  'TC-SP-006': { outcome: 'pass' },
  'TC-SP-007': { outcome: 'pass' },
  'TC-SP-008': { outcome: 'pass' },
  'TC-SP-009': {
    outcome: 'fail',
    because: 'the "Awaiting action" tile contradicts the queue — a deliberate demo defect',
    ticket: 'SP-59',
  },
};

export interface Deviation {
  caseId: string;
  expected: Outcome;
  actual: Outcome;
  note: string;
}

/**
 * Compare a run against the expectation.
 *
 * Both directions are reported. A case that was expected to fail and passed is
 * the more interesting of the two: either somebody fixed a defect without
 * updating the spec, or the assertion has quietly stopped checking anything.
 *
 * An unknown case ID is a deviation too rather than something to skip. A typo
 * in a case name would otherwise silently drop that case from the comparison.
 */
export function compareRun(actual: Record<string, Outcome>): Deviation[] {
  const out: Deviation[] = [];

  for (const [caseId, got] of Object.entries(actual)) {
    const want = EXPECTED[caseId];
    if (!want) {
      out.push({
        caseId,
        expected: 'pass',
        actual: got,
        note: 'not in the expected-outcomes table — check the case ID spelling',
      });
      continue;
    }
    if (want.outcome === got) continue;

    out.push({
      caseId,
      expected: want.outcome,
      actual: got,
      note:
        want.outcome === 'fail'
          ? `expected to fail (${want.because}, ${want.ticket}). Passing means the defect ` +
            'was fixed without updating the spec, or the assertion no longer asserts.'
          : 'a case that should pass has regressed',
    });
  }

  for (const caseId of Object.keys(EXPECTED)) {
    if (caseId in actual) continue;
    out.push({
      caseId,
      expected: EXPECTED[caseId].outcome,
      actual: 'fail',
      note: 'did not run — a case missing from a run is not a case that passed',
    });
  }

  return out;
}

/** One-line summary for a run log or a console line. */
export function summarise(deviations: Deviation[], total: number): string {
  if (deviations.length === 0) {
    const failing = Object.values(EXPECTED).filter((e) => e.outcome === 'fail').length;
    return `${total} cases ran exactly as expected: ${total - failing} pass, ${failing} fail.`;
  }
  return (
    `${deviations.length} of ${total} cases did not match the expectation: ` +
    deviations.map((d) => `${d.caseId} expected ${d.expected}, got ${d.actual}`).join('; ')
  );
}
