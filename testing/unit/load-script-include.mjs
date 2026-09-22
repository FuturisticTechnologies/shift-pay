import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT_INCLUDES = path.join(ROOT, 'Script Includes');

/**
 * Load Script Includes into a Node vm context, with the platform stubbed out.
 *
 * The files under Script Includes/ are the deployed source, byte for byte, so
 * the tests run exactly what the instance runs — nothing is copied or
 * transpiled. The one thing a Script Include needs that Node lacks is the
 * platform: `Class.create()` and the `gs` / `GlideRecord` globals.
 *
 * The default `GlideRecord` throws on construction. Every rule these tests
 * exercise is reachable by handing the catalogue and an entitlements object to
 * the constructor, so a test that queries a table has left the path it meant to
 * test — and should say so loudly rather than get a quiet empty result back.
 * A test that genuinely needs a table passes its own stub in `globals`.
 *
 *   const { ShiftPayCalendarRules } = loadScriptInclude(['ShiftPayCalendarRules']);
 */
export function loadScriptInclude(names, globals = {}) {
  const sandbox = {
    // ServiceNow's Prototype-style class factory: `new X(cfg)` calls initialize.
    Class: {
      create: () =>
        function () {
          this.initialize.apply(this, arguments);
        },
    },
    gs: {
      getUserID: () => 'unit-test-user',
      // No system property is set, so every lookup takes its default. That is
      // the instance today for x_shiftpay.holiday_schedule (TC-SP-030).
      getProperty: (_name, fallback) => fallback,
      info: () => {},
      warn: () => {},
    },
    GlideRecord: function (table) {
      throw new Error(
        `GlideRecord('${table}') was constructed. Pass the data to the constructor, ` +
          'or supply a GlideRecord stub in globals.'
      );
    },
    ...globals,
  };
  vm.createContext(sandbox);
  for (const name of [].concat(names)) {
    const file = path.join(SCRIPT_INCLUDES, `${name}.js`);
    vm.runInContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: file });
  }
  return sandbox;
}

/**
 * Strip values back to plain JSON.
 *
 * Arrays built inside the vm context have that context's Array.prototype, so
 * assert.deepStrictEqual rejects them against a literal on prototype alone.
 * This is also the shape the widget sees: `data` crosses the wire as JSON.
 */
export function plain(value) {
  return JSON.parse(JSON.stringify(value));
}
