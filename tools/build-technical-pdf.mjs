/**
 * Build the ShiftPay technical design document as a PDF.
 *
 *   node tools/build-technical-pdf.mjs
 *
 * Reads ShiftPay-Technical-Document.md at the repository root and writes
 * ShiftPay-Technical-Document.pdf beside it. Same source, same nine diagrams
 * and same branding as build-technical-doc.py, which produces the .docx — this
 * is the read-and-sign-off format, that one is the hand-it-over-to-edit format.
 * Neither is derived from the other; both render the markdown, which stays the
 * source of record.
 *
 * The markdown reader, the stylesheet and the print live in lib/markdown-pdf.mjs,
 * shared with build-brd-pdf.mjs. What stays here is the cover.
 *
 * The diagrams must have been rendered first — they are committed, so normally
 * they are simply there. If one is missing the build stops and names it:
 *
 *   python tools/diagrams/build-diagrams.py && node tools/diagrams/render.mjs
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  BRAND, inline, renderMarkdown, styles, wordmark, printPdf,
} from './lib/markdown-pdf.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(HERE);
const SOURCE = path.join(REPO, 'ShiftPay-Technical-Document.md');
const TARGET = path.join(REPO, 'ShiftPay-Technical-Document.pdf');

const DOC_KIND = 'Technical Design Document';
const FALLBACK_CONFIDENTIALITY =
  'Confidential. Prepared by Futuristic Technologies. ' +
  'Contains system design detail and must not be redistributed without written consent.';

// `**Document type:** Technical Design Document` — the front matter's metadata
// shape. The wordmark line above it has no colon inside the bold and so is
// correctly not read as a fact.
const FACT = /^\*\*(.+?):\*\*\s*(.*)$/;

/**
 * Lift the title and the metadata block off the top of the document.
 *
 * They become the cover, so the body must not repeat them; the body starts at
 * the Contents heading, which is where the first horizontal rule leaves off —
 * the same cut build-technical-doc.py makes. Finding no facts is survivable and
 * says so; the cover then carries the title alone rather than a section of the
 * document being silently swallowed.
 */
function frontMatter(markdown) {
  const lines = markdown.split(/\r?\n/);
  let title = '';
  const facts = [];
  let i = 0;

  for (; i < lines.length; i++) {
    const s = lines[i].trim();
    if (/^-{3,}$/.test(s)) { i++; break; }
    if (!s) continue;
    if (s.startsWith('# ')) { title = s.slice(2).trim(); continue; }
    const fact = FACT.exec(s);
    if (fact) facts.push([fact[1], fact[2]]);
  }

  return { title, facts, body: lines.slice(i).join('\n') };
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
    '<table class="facts cover-facts">' + rows + '</table>',
    '<p class="tagline">' + BRAND.tagline + '</p>',
    '</section>',
  ].join('\n');
}

// The Contents page lists sections that are not links in print, so its numbers
// need to read as a column rather than as body prose.
const EXTRA_STYLES = `
  h1 + p strong, .contents-part { color: ${BRAND.blue}; }
  ol li { padding-left: 1mm; }
`;

async function main() {
  const markdown = await readFile(SOURCE, 'utf8');
  const front = frontMatter(markdown);
  if (!front.facts.length) {
    console.warn('  note: no metadata found — the cover shows the title only');
  }

  // Keep the footer's confidentiality wording sourced from the document rather
  // than restated here, so the two cannot disagree.
  const classification = front.facts.find(([k]) => /classification/i.test(k));
  const confidentiality = classification ? classification[1] : FALLBACK_CONFIDENTIALITY;

  const html = '<!doctype html><meta charset="utf-8">' +
    '<title>' + front.title + '</title>' +
    '<style>' + styles(EXTRA_STYLES) + '</style>' +
    cover(front, await wordmark(REPO)) +
    await renderMarkdown(front.body, { repoRoot: REPO });

  return printPdf({
    html,
    target: TARGET,
    docKind: DOC_KIND,
    title: front.title,
    confidentiality,
  });
}

const target = await main();
console.log('wrote ' + path.relative(REPO, target));
