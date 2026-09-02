/**
 * Build the ShiftPay Business Requirements Document as a PDF.
 *
 *   node tools/build-brd-pdf.mjs
 *
 * Reads BRD-ShiftPay.md at the repository root and writes BRD-ShiftPay.pdf
 * beside it. The markdown is the source of record — edit it and re-run this,
 * the same contract the Word builders in this folder keep.
 *
 * Why Chromium rather than python-docx: the Word deliverables are Word files
 * because they are handed over for editing. A BRD goes out to be read and
 * signed off, so PDF is the format — and a Word-to-PDF step would need Word or
 * LibreOffice on the build machine, neither of which SETUP.md asks for. Any
 * Chromium prints this: the test pack's, or the Chrome or Edge already on the
 * machine. Nothing new to install.
 *
 * The markdown reader, the stylesheet and the print live in lib/markdown-pdf.mjs,
 * shared with build-technical-pdf.mjs. What stays here is the cover.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  BRAND, inline, splitRow, isDivider, renderMarkdown, styles, wordmark, printPdf,
} from './lib/markdown-pdf.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(HERE);
const SOURCE = path.join(REPO, 'BRD-ShiftPay.md');
const TARGET = path.join(REPO, 'BRD-ShiftPay.pdf');

const DOC_KIND = 'Business Requirements Document';
const CONFIDENTIALITY =
  'Confidential. Prepared by Futuristic Technologies. ' +
  'Contains commercially sensitive requirements and must not be redistributed ' +
  'without written consent.';

/**
 * Lift the title, subtitle and metadata table off the top of the document.
 *
 * They become the cover, so the body must not repeat them. Everything from the
 * revision history down is returned untouched. If the shape of the front matter
 * ever changes this finds no metadata table and the cover falls back to the
 * title alone, rather than silently swallowing a section of requirements.
 */
function frontMatter(markdown) {
  const lines = markdown.split(/\r?\n/);
  let title = '';
  let subtitle = '';
  const facts = [];
  let i = 0;

  for (; i < lines.length; i++) {
    const s = lines[i].trim();
    if (!s) continue;
    if (s.startsWith('# ')) { title = s.slice(2).trim(); continue; }
    if (s.startsWith('## ')) { subtitle = s.slice(3).trim(); continue; }
    if (s.startsWith('|')) {
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        const cells = splitRow(lines[i].trim());
        if (!isDivider(lines[i]) && cells[0]) facts.push([cells[0], cells[1] || '']);
        i++;
      }
      break;
    }
    break;                                      // prose before the table: stop
  }

  // Step over the rule that closes the front matter, so the body opens cleanly.
  while (i < lines.length && (!lines[i].trim() || /^-{3,}$/.test(lines[i].trim()))) i++;

  return { title, subtitle, facts, body: lines.slice(i).join('\n') };
}

function cover(front, mark) {
  const rows = front.facts
    .map(([k, v]) => '<tr><th>' + inline(k) + '</th><td>' + inline(v) + '</td></tr>')
    .join('');
  return [
    '<section class="cover">',
    mark,
    '<div class="eyebrow">' + BRAND.product + ' &nbsp;·&nbsp; ' + DOC_KIND + '</div>',
    '<h1 class="cover-title">' + inline(front.title) + '</h1>',
    '<p class="cover-sub">' + inline(front.subtitle) + '</p>',
    '<table class="facts cover-facts">' + rows + '</table>',
    '<p class="tagline">' + BRAND.tagline + '</p>',
    '</section>',
  ].join('\n');
}

async function main() {
  const markdown = await readFile(SOURCE, 'utf8');
  const front = frontMatter(markdown);
  if (!front.facts.length) {
    console.warn('  note: no metadata table found — the cover shows the title only');
  }

  const html = '<!doctype html><meta charset="utf-8">' +
    '<title>' + front.title + '</title>' +
    '<style>' + styles() + '</style>' +
    cover(front, await wordmark(REPO)) +
    await renderMarkdown(front.body, { repoRoot: REPO });

  return printPdf({
    html,
    target: TARGET,
    docKind: DOC_KIND,
    title: front.title,
    confidentiality: CONFIDENTIALITY,
  });
}

const target = await main();
console.log('wrote ' + path.relative(REPO, target));
