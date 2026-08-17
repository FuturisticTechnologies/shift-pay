#!/usr/bin/env node
/**
 * Run one test case and produce its Word evidence record.
 *
 *   node run-case.mjs TC-SP-003
 *   node run-case.mjs TC-SP-003 TC-SP-005
 *   node run-case.mjs all
 *
 * Flags: --headless, --no-open, --no-auth
 *
 * The whole point of this script is that a case is one command. It preflights
 * the environment, refreshes the login if it has gone stale, runs Playwright,
 * proves a result actually appeared, builds the document, and hands over the
 * path.
 *
 * THE IMPORTANT DESIGN POINT: three of the nine cases are *expected to fail*, so
 * a non-zero Playwright exit is a normal outcome, not an error. The pipeline
 * carries on and reports the case's own verdict. It aborts only when no result
 * was produced at all — which means the case id was wrong, and is a completely
 * different thing from a case that ran and failed.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TESTING = path.dirname(HERE);
const RESULTS = path.join(HERE, 'results', 'cases');
const PACKS = path.join(TESTING, 'evidence-packs');
const GENERATOR = path.join(TESTING, 'evidence-generator');
const SPEC = path.join(TESTING, 'TEST-CASES-SHIFTPAY.md');
const AUTH_STATE = path.join(HERE, '.auth', 'servicenow.json');
const AUTH_MAX_AGE_MS = 8 * 60 * 60 * 1000;

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  amber: (s) => `\x1b[33m${s}\x1b[0m`,
  blue: (s) => `\x1b[36m${s}\x1b[0m`,
};

function die(message, hint) {
  console.error(`\n${C.red('✖')} ${message}`);
  if (hint) console.error(`  ${C.dim(hint)}`);
  process.exit(1);
}

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, {
    cwd: HERE,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    ...opts,
  });
}

// ── Arguments ───────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith('-')));
const ids = argv.filter((a) => !a.startsWith('-'));

if (!ids.length) {
  console.error(`
${C.bold('Usage')}  node run-case.mjs <CASE-ID...> | all  [--headless] [--no-open] [--no-auth]

  node run-case.mjs TC-SP-003              run one case, watch the browser, open the document
  node run-case.mjs TC-SP-004 TC-SP-005    run several
  node run-case.mjs all                    run every automated case and build the run summary

Cases are defined in ${C.dim(path.relative(process.cwd(), SPEC))}.
`);
  process.exit(2);
}

const headed = !flags.has('--headless');
const open = !flags.has('--no-open');
const doAuth = !flags.has('--no-auth');
const all = ids.length === 1 && ids[0].toLowerCase() === 'all';
const caseIds = all ? [] : ids.map((i) => i.toUpperCase());

// ── 1. Preflight ────────────────────────────────────────────────────────────
// Each failure names the exact fix. A missing dependency should cost one line of
// reading, not a stack trace.

if (!fs.existsSync(path.join(HERE, 'node_modules', '@playwright', 'test'))) {
  die(
    'Playwright is not installed.',
    `cd "${HERE}" && npm install && npx playwright install chromium`
  );
}

if (!fs.existsSync(path.join(HERE, '.env'))) {
  die(
    'No .env file, so there is no credential to sign in with.',
    'Copy .env.example to .env and fill in SN_USER and SN_PASSWORD.'
  );
}
const env = fs.readFileSync(path.join(HERE, '.env'), 'utf8');
for (const key of ['SN_USER', 'SN_PASSWORD']) {
  if (!new RegExp(`^${key}=.+$`, 'm').test(env)) {
    die(`${key} is empty in .env.`, 'Fill it in — see .env.example for what the account needs.');
  }
}

// Probe without a shell: `shell: true` re-splits the argument list, so the
// `-c` payload arrives as two words and python fails on a machine that has it.
// Measured under Git Bash on Windows, where it reported python-docx missing
// while `python -c "import docx"` succeeded at the prompt.
const py = ['python', 'py', 'python3'].find((bin) => {
  try {
    return spawnSync(bin, ['-c', 'import docx'], { shell: false, stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
});
if (!py) {
  die(
    'Python with python-docx is not available, so no Word document can be built.',
    'pip install python-docx'
  );
}

if (!all) {
  const spec = fs.readFileSync(SPEC, 'utf8');
  const unknown = caseIds.filter((id) => !new RegExp(`^###\\s+${id}\\s`, 'm').test(spec));
  if (unknown.length) {
    die(
      `${unknown.join(', ')} ${unknown.length === 1 ? 'is not a case' : 'are not cases'} in the specification.`,
      `Case ids are defined in ${path.relative(process.cwd(), SPEC)}.`
    );
  }
}

// ── 2. Authenticate, if the saved session is missing or stale ───────────────

if (doAuth) {
  const age = fs.existsSync(AUTH_STATE) ? Date.now() - fs.statSync(AUTH_STATE).mtimeMs : Infinity;
  if (age > AUTH_MAX_AGE_MS) {
    console.log(
      C.blue(
        `\n▸ Signing in${Number.isFinite(age) ? ' (saved session is stale)' : ''}…`
      )
    );
    const auth = run('npx', ['playwright', 'test', '--project=setup', '--reporter=list']);
    if (auth.status !== 0) {
      die(
        'Could not sign in to ServiceNow.',
        'Check SN_USER / SN_PASSWORD in .env, and that the instance is awake (a PDI hibernates).'
      );
    }
  } else {
    console.log(C.dim(`▸ Reusing the saved session (${Math.round(age / 60000)} min old).`));
  }
}

// ── 3. Execute ──────────────────────────────────────────────────────────────

const startedAt = Date.now();
const grep = all ? [] : ['--grep', caseIds.join('|')];
console.log(
  C.blue(`\n▸ Running ${all ? 'every automated case' : caseIds.join(', ')}${headed ? ' (browser visible)' : ''}…\n`)
);

const test = run('npx', [
  'playwright', 'test', '--project=sp', '--reporter=list',
  ...(headed ? ['--headed'] : []),
  ...grep,
]);

// A non-zero exit is expected whenever a case fails, and three of ours are meant
// to. Do NOT treat it as fatal — the failing document is the deliverable.
const playwrightFailed = test.status !== 0;

// ── 4. Guard against the silent pass ────────────────────────────────────────
// Playwright can exit 0 having matched no test at all. Without this check, a
// typo'd case id would look like a clean run that produced nothing.

// The directory is absent on a fresh clone — git does not track empty ones — and
// a missing-directory throw here would read as a harness crash rather than as
// "nothing has been run yet".
fs.mkdirSync(RESULTS, { recursive: true });

const produced = [];
for (const file of fs.readdirSync(RESULTS).filter((f) => f.endsWith('.json'))) {
  const id = path.basename(file, '.json').toUpperCase();
  if (!all && !caseIds.includes(id)) continue;
  const payload = JSON.parse(fs.readFileSync(path.join(RESULTS, file), 'utf8'));
  const finished = Date.parse(payload.case.finishedAt ?? 0);
  if (finished >= startedAt - 5000) produced.push(payload.case);
}

if (!produced.length) {
  die(
    all
      ? 'The run produced no case results.'
      : `${caseIds.join(', ')} produced no result — nothing ran.`,
    'The case exists in the specification but has no matching test in specs/shiftpay-cases.spec.ts. ' +
      'Cases marked PENDING are written but not automated.'
  );
}

const missing = all ? [] : caseIds.filter((id) => !produced.some((p) => p.id.toUpperCase() === id));
if (missing.length) {
  console.log(
    C.amber(`\n⚠ ${missing.join(', ')} produced no result — not automated yet. Continuing with the rest.`)
  );
}

// ── 5. Build the documents ──────────────────────────────────────────────────

console.log(C.blue('\n▸ Building the evidence record…\n'));
const gen = run(py, [
  'generate_evidence.py',
  ...produced.flatMap((p) => (all ? [] : ['--only', p.id])),
], { cwd: GENERATOR });

if (gen.status !== 0) {
  die('The evidence generator failed. The run results are intact under results/cases/.');
}

// ── 6. Hand it over ─────────────────────────────────────────────────────────

const seconds = Math.round((Date.now() - startedAt) / 1000);
console.log(`\n${C.bold('Results')}  ${C.dim(`(${seconds}s)`)}`);
for (const c of produced.sort((a, b) => a.id.localeCompare(b.id))) {
  const mark =
    c.verdict === 'PASS' ? C.green('PASS') :
    c.verdict === 'FAIL' ? C.red('FAIL') : C.amber(c.verdict);
  console.log(`  ${mark}  ${c.id}  ${C.dim(c.title)}`);
}

const failed = produced.filter((c) => c.verdict === 'FAIL');
if (failed.length) {
  console.log(
    C.dim(
      `\n  ${failed.length} case(s) failed. For TC-SP-004, TC-SP-005 and TC-SP-009 that is the ` +
        `expected outcome — see the "expected to FAIL" markers in the specification before "fixing" anything.`
    )
  );
} else if (playwrightFailed) {
  console.log(
    C.amber('\n  Playwright exited non-zero but every case recorded a verdict — check the output above.')
  );
}

const docs = produced.map((c) => path.join(PACKS, `${c.id}.docx`)).filter((p) => fs.existsSync(p));
if (all && fs.existsSync(path.join(PACKS, '00-RUN-SUMMARY.docx'))) {
  docs.unshift(path.join(PACKS, '00-RUN-SUMMARY.docx'));
}

console.log(`\n${C.bold('Documents')}`);
docs.forEach((d) => console.log(`  ${d}`));

if (open && docs.length) {
  const first = docs[0];
  if (process.platform === 'win32') spawnSync('cmd', ['/c', 'start', '', first], { stdio: 'ignore' });
  else if (process.platform === 'darwin') spawnSync('open', [first], { stdio: 'ignore' });
  else spawnSync('xdg-open', [first], { stdio: 'ignore' });
}

// Exit 0 whenever every requested case produced a document. The verdict is
// reported above and lives in the document; conflating "a case failed" with "the
// tooling failed" would make this unusable in a pipeline that must always
// publish its evidence.
process.exit(0);
