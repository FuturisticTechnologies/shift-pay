/**
 * Reconcile the report's money against the summary table it reads.
 *
 * Run this before showing the report to anyone who will act on the numbers.
 * It answers one question: does what the report totals agree with what the
 * widget shows for the same month?
 *
 * The check exists because of a specific failure. The summary table holds
 * clipped *week* rows alongside *month* rows for the same work. A measure that
 * does not filter `u_period_type = "month"` sums both and reports roughly
 * double — confidently, with no error, on a chart that looks correct. That is
 * worse than a blank visual, because a blank visual gets investigated.
 *
 * So this prints both totals side by side. The gap between them is the size of
 * the mistake you avoid by filtering, and seeing it stated in rupees is more
 * persuasive than the rule written down.
 *
 * Usage:
 *   SN_INSTANCE=dev227442 SN_USER=admin SN_PASSWORD=... \
 *     node "Power BI/reconcile-monthly-totals.mjs" 2026 8
 *
 * Read-only. It issues GETs against the Table API and writes nothing.
 */

const SUMMARY = 'x_1995110_shift_0_shift_submission_summary';

const instance = process.env.SN_INSTANCE;
const user = process.env.SN_USER;
const password = process.env.SN_PASSWORD;

if (!instance || !user || !password) {
  console.error(
    'Set SN_INSTANCE, SN_USER and SN_PASSWORD first.\n' +
      'They live in connection.txt at the repo root, which is gitignored and travels in the folder ZIP.'
  );
  process.exit(2);
}

const year = Number(process.argv[2]);
const month = Number(process.argv[3]);

if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
  console.error('Usage: node "Power BI/reconcile-monthly-totals.mjs" <year> <month 1-12>');
  console.error('Note the month is 1-indexed here because u_month is 1-indexed in the table.');
  console.error('The widgets and their data object are 0-indexed; the conversion happens at the');
  console.error('table boundary and this script sits on the table side of it.');
  process.exit(2);
}

const base = `https://${instance}.service-now.com/api/now/table/${SUMMARY}`;
const auth = 'Basic ' + Buffer.from(`${user}:${password}`).toString('base64');

async function fetchRows() {
  const query = `u_year=${year}^u_month=${month}`;
  const fields = 'u_user,u_period_type,u_period_start,u_shift_type,u_count,u_rate_snapshot,u_amount';
  const url = `${base}?sysparm_query=${encodeURIComponent(query)}` +
    `&sysparm_fields=${fields}&sysparm_display_value=true&sysparm_limit=10000`;

  const res = await fetch(url, { headers: { Authorization: auth, Accept: 'application/json' } });
  if (!res.ok) {
    throw new Error(`Table API returned ${res.status} ${res.statusText}. Check the credentials and the instance name.`);
  }
  const body = await res.json();
  return body.result ?? [];
}

const money = (v) => Number(v || 0);
const fmt = (n) =>
  '₹' + n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const rows = await fetchRows();

if (rows.length === 0) {
  console.log(`No summary rows for ${year}-${String(month).padStart(2, '0')}. Nothing to reconcile.`);
  process.exit(0);
}

const monthRows = rows.filter((r) => r.u_period_type === 'month');
const weekRows = rows.filter((r) => r.u_period_type === 'week');
const otherRows = rows.filter((r) => r.u_period_type !== 'month' && r.u_period_type !== 'week');

const monthTotal = monthRows.reduce((a, r) => a + money(r.u_amount), 0);
const weekTotal = weekRows.reduce((a, r) => a + money(r.u_amount), 0);

console.log(`\nShiftPay reconciliation — ${year}-${String(month).padStart(2, '0')}`);
console.log('='.repeat(58));
console.log(`  rows returned        ${rows.length}  (${monthRows.length} month, ${weekRows.length} week)`);
console.log(`  month rows total     ${fmt(monthTotal)}   <- what the report must show`);
console.log(`  week rows total      ${fmt(weekTotal)}`);
console.log(`  unfiltered total     ${fmt(monthTotal + weekTotal)}   <- what an unfiltered measure reports`);

if (monthTotal > 0) {
  const factor = (monthTotal + weekTotal) / monthTotal;
  console.log(`  overstatement        ${factor.toFixed(2)}x`);
}

// Per-user, so a mismatch names the person rather than the month.
const byUser = new Map();
for (const r of monthRows) {
  const u = r.u_user?.display_value ?? r.u_user ?? '(unknown)';
  byUser.set(u, (byUser.get(u) ?? 0) + money(r.u_amount));
}
console.log('\n  Month totals by user — compare each against the widget for the same month:');
for (const [u, amount] of [...byUser].sort((a, b) => b[1] - a[1])) {
  console.log(`    ${u.padEnd(28)} ${fmt(amount)}`);
}

// Things that make a total untrustworthy rather than merely surprising.
const problems = [];

if (otherRows.length) {
  const kinds = [...new Set(otherRows.map((r) => r.u_period_type))].join(', ');
  problems.push(`${otherRows.length} rows carry an unexpected u_period_type (${kinds}). Any measure filtering only on "month" silently drops them.`);
}

const usersWithWeeksOnly = new Set(
  weekRows.map((r) => r.u_user?.display_value ?? r.u_user)
);
for (const u of byUser.keys()) usersWithWeeksOnly.delete(u);
if (usersWithWeeksOnly.size) {
  problems.push(`${usersWithWeeksOnly.size} user(s) have week rows but no month row: ${[...usersWithWeeksOnly].join(', ')}. The report will show nothing for them while the calendar shows work.`);
}

const missingRate = monthRows.filter((r) => !money(r.u_rate_snapshot) && money(r.u_amount));
if (missingRate.length) {
  problems.push(`${missingRate.length} month row(s) carry an amount with no rate snapshot. The amount cannot be explained from the row itself.`);
}

const zeroRate = monthRows.filter((r) => money(r.u_count) && !money(r.u_rate_snapshot));
if (zeroRate.length) {
  problems.push(`${zeroRate.length} month row(s) count shifts at a zero rate snapshot. Expected for the unpaid shift types; suspicious for anything else.`);
}

console.log('');
if (problems.length === 0) {
  console.log('  No anomalies. Month totals above are what the report should report.');
} else {
  console.log('  Worth a look before presenting these numbers:');
  for (const p of problems) console.log(`    - ${p}`);
}
console.log('');
