/**
 * An in-memory GlideRecord, for Script Includes that genuinely read and write.
 *
 *   const tables = { sum: [], day: [{ sys_id: 'd1', u_user: 'emp-1', ... }] };
 *   loadScriptInclude(['ShiftPayAggregator'], { GlideRecord: fakeGlide(tables) });
 *
 * Models only what the code under test calls: addQuery with =, <, >=, <= and
 * IN, addNullQuery, setLimit, orderBy (ascending), query/next, get/update/
 * deleteRecord on the current row, getValue/getDisplayValue/getUniqueValue,
 * deleteMultiple, and initialize/setValue/insert. Anything else is absent, so
 * code that starts relying on more of the API fails here rather than being
 * quietly mis-simulated.
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
      '<': (a, b) => a < b,
      '>=': (a, b) => a >= b,
      '<=': (a, b) => a <= b,
      IN: (a, b) => b.split(',').includes(a),
    };
    // addNullQuery is modelled as a filter with the NULL operator, so it can
    // sit in the same list and be combined with the others.
    const NULL = Symbol('null');
    let sortField = null;
    const matches = (row) =>
      filters.every(([field, op, value]) => {
        if (op === NULL) return row[field] == null || row[field] === '';
        return OPS[op](String(row[field] ?? ''), value);
      });

    this.addQuery = (field, op, value) => {
      if (value === undefined) [op, value] = ['=', op];
      if (!OPS[op]) throw new Error(`fakeGlide: operator "${op}" is not modelled`);
      filters.push([field, op, String(value)]);
    };
    this.addNullQuery = (field) => {
      filters.push([field, NULL, null]);
    };
    // Rows are returned whole, so a limit is only a cap on how many come back.
    let limit = Infinity;
    this.setLimit = (n) => {
      limit = n;
    };
    this.query = () => {
      results = rows.filter(matches).slice(0, limit);
      if (sortField) {
        results.sort((a, b) => String(a[sortField] ?? '').localeCompare(String(b[sortField] ?? '')));
      }
      cursor = -1;
    };
    this.next = () => {
      current = results[++cursor] ?? null;
      return current !== null;
    };
    // get(sys_id) positions the record on one row, as on the instance. The
    // row itself becomes current, so setValue + update writes through to it.
    this.get = (sysId) => {
      const row = rows.find((r) => r.sys_id === sysId);
      if (!row) return false;
      current = row;
      return true;
    };
    this.update = () => {
      if (!current) throw new Error('fakeGlide: update() with no current record');
      return current.sys_id;
    };
    this.deleteRecord = () => {
      if (!current) throw new Error('fakeGlide: deleteRecord() with no current record');
      rows.splice(rows.indexOf(current), 1);
      return true;
    };
    this.getValue = (field) => (current[field] == null ? null : String(current[field]));
    this.getDisplayValue = (field) => this.getValue(field);
    this.orderBy = (field) => {
      sortField = field;
    };
    this.getUniqueValue =() => current.sys_id;
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
