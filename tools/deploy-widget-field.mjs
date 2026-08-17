#!/usr/bin/env node
/**
 * Build a safe cnit body file for one field of one record, and print the exact
 * command to push it.
 *
 *   node tools/deploy-widget-field.mjs <sourceFile> <field> [outFile]
 *
 * Example — the Manager Approval template:
 *   node tools/deploy-widget-field.mjs "Manager Approval UI Widget/widget.template.html" template
 *
 * WHY THIS EXISTS. CLAUDE.md documents the trap in prose; this is the prose made
 * executable, because getting it wrong returns HTTP 200 and stores garbage.
 *
 *   1. PowerShell 5.1's ConvertTo-Json does NOT escape characters above 127, and
 *      cnit reads body files with no -Encoding. The combination mangles every
 *      non-ASCII character silently. So this escapes the *serialised JSON* to
 *      pure ASCII \uXXXX and writes the file as ASCII.
 *
 *      Note "serialised JSON", not "the string". Escaping the input before
 *      JSON.stringify puts literal backslash-u text into the field value, which
 *      is a different and much less obvious kind of wrong — it round-trips to
 *      the wrong content rather than failing.
 *
 *   2. The working copy is CRLF on Windows but the stored field is LF, so
 *      pushing verbatim rewrites every line and buries the real change in a
 *      whole-file diff. Line endings are normalised to LF.
 *
 *   3. The payload is parsed back and compared to the source before anything is
 *      printed. A payload that does not round-trip is never offered for push.
 *
 * After pushing, ALWAYS read the field back and compare it to the local file.
 * `cnit get` ignores -SysId — it is a `put`-only parameter — so verify with
 * `get <table> -Query "sys_id=<id>"` or you may be reading the first row of the
 * whole table.
 */

import fs from 'node:fs';
import path from 'node:path';

const [src, field, outArg] = process.argv.slice(2);

if (!src || !field) {
  console.error('Usage: node tools/deploy-widget-field.mjs <sourceFile> <field> [outFile]');
  process.exit(2);
}
if (!fs.existsSync(src)) {
  console.error(`Source file not found: ${src}`);
  process.exit(1);
}

const out = outArg ?? path.join(process.cwd(), `.deploy-${field}.json`);

const text = fs.readFileSync(src, 'utf8').replace(/\r\n/g, '\n');
const json = JSON.stringify({ [field]: text }).replace(
  /[-￿]/g,
  (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')
);
fs.writeFileSync(out, json, 'ascii');

const back = JSON.parse(fs.readFileSync(out, 'ascii'))[field];
if (back !== text) {
  console.error('ROUND TRIP FAILED — the payload does not decode to the source file. Not safe to push.');
  process.exit(1);
}

const nonAscii = [...text].filter((c) => c.codePointAt(0) > 127).length;
console.log(`${src}`);
console.log(`  ${text.length} chars, ${nonAscii} non-ASCII, normalised to LF`);
console.log(`  payload: ${out} (${fs.statSync(out).size} bytes, ASCII, round-trip verified)`);
console.log(`
Push it:

  & "<path>\\cnit-instance-tools\\cnit.ps1" put <table> \`
      -ProfileName shiftpay-admin -SysId <sys_id> \`
      -Body "${out}" -Write

Then read it back and compare — a push can return 200 and store garbage:

  & "<path>\\cnit.ps1" get <table> -ProfileName shiftpay-admin \`
      -Query "sys_id=<sys_id>" -Fields ${field} -ExcludeRefLinks
`);
