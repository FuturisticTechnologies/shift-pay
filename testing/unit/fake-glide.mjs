/**
 * An in-memory GlideRecord, for Script Includes that genuinely read and write.
 *
 *   const tables = { sum: [], day: [{ sys_id: 'd1', u_user: 'emp-1', ... }] };
 *   loadScriptInclude(['ShiftPayAggregator'], { GlideRecord: fakeGlide(tables) });
 *
 * Models only what the Script Includes call: addQuery with =, >= and <=,
 * query/next, getValue/getUniqueValue, deleteMultiple, and
 * initialize/setValue/insert. Anything else is absent, so a Script Include that
 * starts relying on more of the API fails here rather than being quietly
 * mis-simulated.
 *
 * Values are compared as strings, like getValue returns them. That is what
 * makes the 'YYYY-MM-DD' range queries work lexically, exactly as on the
 * instance.
 */
export function fakeGlide(tables) {
  let seq = 0;

  return function GlideRecord(table) {
    if (!tables[table]) tables[table] = [];
    const rows = tables[table];
    const filters = [];
    let results = [];
    let cursor = -1;
    let current = null;

    const OPS = {
      '=': (a, b) => a === b,
      '>=': (a, b) => a >= b,
      '<=': (a, b) => a <= b,
    };
    const matches = (row) =>
      filters.every(([field, op, value]) => OPS[op](String(row[field] ?? ''), value));

    this.addQuery = (field, op, value) => {
      if (value === undefined) [op, value] = ['=', op];
      if (!OPS[op]) throw new Error(`fakeGlide: operator "${op}" is not modelled`);
      filters.push([field, op, String(value)]);
    };
    this.query = () => {
      results = rows.filter(matches);
      cursor = -1;
    };
    this.next = () => {
      current = results[++cursor] ?? null;
      return current !== null;
    };
    this.getValue = (field) => (current[field] == null ? null : String(current[field]));
    this.getUniqueValue = () => current.sys_id;
    this.deleteMultiple = () => {
      for (const row of rows.filter(matches)) rows.splice(rows.indexOf(row), 1);
    };
    this.initialize = () => {
      current = {};
    };
    this.setValue = (field, value) => {
      current[field] = value;
    };
    this.insert = () => {
      current.sys_id = `${table}-${++seq}`;
      rows.push(current);
      return current.sys_id;
    };
  };
}
