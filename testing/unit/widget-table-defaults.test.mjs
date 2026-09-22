import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Every widget's table-name defaults name a real table, and agree with
 * themselves. SP-61, TC-SP-031.
 *
 * A widget option that names a table is written twice: as the `default` in
 * option-schema.json and as the `options.x || 'default'` fallback in the server
 * script. The calendar shipped five that named no table at all and ran only
 * because its sp_instance overrode every one — latent until someone placed the
 * widget on a new page. Nothing failed, so nothing said so.
 *
 * Reads the widget folders from disk, so a new widget is covered the day it is
 * added without anyone editing this file.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// The application's tables as they exist on the instance. The same list the
// Playwright pack keeps in testing/automation/lib/servicenow.ts.
const REAL_TABLES = new Set([
  'x_1995110_shift_0_u_shift_submission',
  'x_1995110_shift_0_monthly_timesheet',
  'x_1995110_shift_0_shift_type',
  'x_1995110_shift_0_shift_submission_summary',
  'x_1995110_shift_0_shift_co_entitlement',
  'x_1995110_shift_0_shift_day_change',
]);

const WIDGETS = fs
  .readdirSync(ROOT, { withFileTypes: true })
  .filter((d) => d.isDirectory() && fs.existsSync(path.join(ROOT, d.name, 'widget.server-script.js')))
  .map((d) => d.name);

/** `options.<name>_table || '<value>'` pairs from a server script. */
function serverFallbacks(dir) {
  const src = fs.readFileSync(path.join(ROOT, dir, 'widget.server-script.js'), 'utf8');
  return [...src.matchAll(/options\.(\w+_table)\s*\|\|\s*'([^']*)'/g)].map((m) => ({
    option: m[1],
    value: m[2],
  }));
}

/** `{ <name>_table: default }` from option-schema.json, or {} if there is none. */
function schemaDefaults(dir) {
  const file = path.join(ROOT, dir, 'option-schema.json');
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const opt of JSON.parse(fs.readFileSync(file, 'utf8'))) {
    if (/_table$/.test(opt.name)) out[opt.name] = opt.default;
  }
  return out;
}

test('the widget folders were found', () => {
  // Guards the guard: a path change that finds no widgets would pass every
  // per-widget test below by running none of them.
  assert.ok(WIDGETS.length >= 4, `found only ${WIDGETS.length}: ${WIDGETS.join(', ')}`);
});

for (const dir of WIDGETS) {
  describe(dir, () => {
    test('every server-script table fallback names a real table', () => {
      const bad = serverFallbacks(dir)
        .filter((f) => !REAL_TABLES.has(f.value))
        .map((f) => `options.${f.option} || '${f.value}'`);
      assert.deepEqual(bad, []);
    });

    test('every option-schema table default names a real table', () => {
      const bad = Object.entries(schemaDefaults(dir))
        .filter(([, value]) => !REAL_TABLES.has(value))
        .map(([name, value]) => `${name}: "${value}"`);
      assert.deepEqual(bad, []);
    });

    test('option-schema and server script agree on each default', () => {
      const schema = schemaDefaults(dir);
      const disagree = serverFallbacks(dir)
        .filter((f) => f.option in schema && schema[f.option] !== f.value)
        .map((f) => `${f.option}: schema "${schema[f.option]}", script '${f.value}'`);
      assert.deepEqual(disagree, []);
    });
  });
}
