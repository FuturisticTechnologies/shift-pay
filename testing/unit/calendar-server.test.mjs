import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { runCalendarServer, dayRow, TABLES } from './load-calendar-server.mjs';

/**
 * The Employee Calendar server script, run offline (load-calendar-server.mjs).
 *
 * The refusal tests in calendar-refusals.test.mjs only mean something if a
 * write that should succeed really does succeed here. This is that control: a
 * plain saveDay on a weekday must write exactly one row and refuse nothing.
 */

const USER = 'emp-1';

describe('calendar server harness', () => {
  test('a valid saveDay writes one day row and refuses nothing', () => {
    const { errors, tables } = runCalendarServer({
      user: USER,
      input: { action: 'saveDay', date: '2026-10-05', shift: 'day', year: 2026, month: 9 },
    });

    assert.deepEqual(errors, []);
    assert.equal(tables[TABLES.day].length, 1);
    assert.equal(dayRow(tables, USER, '2026-10-05').u_shift_type, 'day');
  });
});
