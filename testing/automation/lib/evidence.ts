import { Page } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { EVIDENCE_DIR, SN_INSTANCE } from '../playwright.config';

/**
 * Structured evidence capture.
 *
 * A test case's Word document and its automated execution have to come from the
 * same source or they drift apart, and a drifted evidence pack is worse than
 * none — it certifies something nobody ran. So specs record what they did here,
 * and the Python generator renders exactly that. Nothing is retyped.
 *
 * The shape mirrors what a manual tester writes on paper: what I did, what I
 * expected, what I saw, and the record underneath that settles it.
 */

export type Verdict = 'PASS' | 'FAIL' | 'BLOCKED' | 'NOT RUN';

export interface EvidenceStep {
  n: number;
  text: string;
  at: string;
  screenshots: string[];
}

export interface RecordDump {
  label: string;
  table: string;
  query: string;
  rows: Record<string, string>[];
  at: string;
}

export interface CaseResult {
  id: string;
  title: string;
  startedAt: string;
  finishedAt?: string;
  verdict: Verdict;
  verdictReason?: string;
  steps: EvidenceStep[];
  records: RecordDump[];
  observations: string[];
  expected: string[];
  actual: string[];
}

/**
 * One JSON file per case, written as the case finishes.
 *
 * Deliberately not a single accumulating manifest: Playwright starts a fresh
 * worker process after a failed test, which resets module state, so an
 * in-memory array silently loses every case recorded before the first failure.
 * Three of the nine cases here are expected to fail, so that is not a
 * hypothetical — it would lose most of the pack.
 */
let currentCase: CaseEvidence | null = null;

/**
 * How the run describes itself in every document it produces.
 *
 * Stated by the spec rather than assumed, so a document never misrepresents how
 * a case was executed — the one thing an evidence pack must not do.
 */
let runMeta: { instance: string; executedBy: string; executedVia: string } | null = null;

export function describeRun(meta: {
  instance: string;
  executedBy: string;
  executedVia: string;
}): void {
  runMeta = meta;
}

export class CaseEvidence {
  private result: CaseResult;
  private stepNo = 0;
  private flushed = false;

  constructor(id: string, title: string) {
    this.result = {
      id,
      title,
      startedAt: new Date().toISOString(),
      verdict: 'NOT RUN',
      steps: [],
      records: [],
      observations: [],
      expected: [],
      actual: [],
    };
    currentCase = this;
  }

  /** Describe a step as a tester would write it, before performing it. */
  step(text: string): EvidenceStep {
    this.stepNo += 1;
    const s: EvidenceStep = {
      n: this.stepNo,
      text,
      at: new Date().toISOString(),
      screenshots: [],
    };
    this.result.steps.push(s);
    return s;
  }

  /** Attach a screenshot to the most recent step, or to the case if none yet. */
  async shot(page: Page, label: string): Promise<string> {
    const dir = path.join(EVIDENCE_DIR, this.result.id);
    fs.mkdirSync(dir, { recursive: true });
    const safe = label.replace(/[^a-z0-9-_]+/gi, '-').toLowerCase();
    const file = path.join(dir, `${String(this.stepNo).padStart(2, '0')}-${safe}.png`);
    await page.screenshot({ path: file, fullPage: true });
    const current = this.result.steps[this.result.steps.length - 1];
    if (current) current.screenshots.push(file);
    return file;
  }

  /**
   * The record behind the screen. This is what decides the verdict — a repainted
   * calendar cell proves the browser did something, not that the row moved.
   */
  record(label: string, table: string, query: string, rows: Record<string, string>[]): void {
    this.result.records.push({ label, table, query, rows, at: new Date().toISOString() });
  }

  expect(text: string): void {
    this.result.expected.push(text);
  }

  actual(text: string): void {
    this.result.actual.push(text);
  }

  /** Anything worth telling the reader that is not pass/fail. */
  observe(text: string): void {
    this.result.observations.push(text);
    console.log(`    [${this.result.id}] ${text}`);
  }

  pass(reason?: string): void {
    this.finish('PASS', reason);
  }

  fail(reason: string): void {
    this.finish('FAIL', reason);
  }

  blocked(reason: string): void {
    this.finish('BLOCKED', reason);
  }

  private finish(verdict: Verdict, reason?: string): void {
    this.result.verdict = verdict;
    this.result.verdictReason = reason;
    this.result.finishedAt = new Date().toISOString();
    console.log(`    [${this.result.id}] ${verdict}${reason ? ' — ' + reason : ''}`);
  }

  /**
   * Persist the case. Called from afterEach so it runs whether the test ended
   * cleanly or threw — a case that blew up mid-assertion is still evidence, and
   * losing it would leave the pack quietly incomplete.
   */
  flush(outDir: string, testStatus?: string, testError?: string): void {
    if (this.flushed) return;
    this.flushed = true;

    // An assertion that throws skips the verdict call. Rather than filing the
    // case as NOT RUN, take the framework's word for it and carry the error
    // through as the reason.
    if (this.result.verdict === 'NOT RUN' && testStatus && testStatus !== 'passed') {
      this.result.verdict = 'FAIL';
      this.result.verdictReason =
        testError?.split('\n').slice(0, 6).join('\n') ??
        `Test ended with status "${testStatus}".`;
    } else if (this.result.verdict === 'NOT RUN' && testStatus === 'passed') {
      this.result.verdict = 'PASS';
      this.result.verdictReason = 'All assertions passed; no explicit verdict was recorded.';
    }
    this.result.finishedAt = this.result.finishedAt ?? new Date().toISOString();

    const dir = path.join(outDir, 'cases');
    fs.mkdirSync(dir, { recursive: true });
    const payload = {
      run: runMeta ?? {
        instance: SN_INSTANCE,
        executedBy: process.env.SN_USER || 'unknown',
        executedVia:
          'Playwright (automated); every screen assertion cross-checked against the ServiceNow Table API',
      },
      case: this.result,
    };
    fs.writeFileSync(
      path.join(dir, `${this.result.id}.json`),
      JSON.stringify(payload, null, 2)
    );
  }
}

/**
 * Flush whichever case the finished test was recording.
 *
 * Wire this into `test.afterEach` once per spec file; individual cases then need
 * no teardown of their own.
 */
export function flushCurrentCase(
  outDir: string,
  testStatus?: string,
  testError?: string
): void {
  if (!currentCase) return;
  currentCase.flush(outDir, testStatus, testError);
  currentCase = null;
}
