/**
 * Markdown to branded PDF — the part both document builders share.
 *
 * Used by tools/build-brd-pdf.mjs and tools/build-technical-pdf.mjs. Each of
 * those owns its cover and its front matter; this owns the markdown reader, the
 * print stylesheet and the Chromium print itself.
 *
 * The split follows the same reasoning the Python builders state: branding is a
 * shared seam, page furniture is not. The difference here is that the markdown
 * reader is *logic*, not furniture — two copies of it would drift, and a
 * renderer that drops a table row is a document that misstates a requirement.
 * So the reader is shared and the covers are not.
 *
 * Branding is transcribed from testing/evidence-generator/branding.py rather
 * than imported — that module is Python and returns docx RGBColor objects, so
 * there is nothing to share across the language boundary but the values. The
 * palette below is the seam; keep it in step with branding.py on a rebrand.
 *
 * Supported markdown subset — everything the two source documents use:
 *   # Part N — Title      part divider, starts a new page
 *   # / ## / ### / ####   headings
 *   ![alt](path)          figure, embedded at content width
 *   | a | b |             table, with or without a header row
 *   ``` fenced ```        monospaced block (the ASCII diagrams)
 *   > quoted text         called-out note
 *   - bullet   1. item    lists (ordered lists keep their source numbering)
 *   ---                   section rule
 *   **bold**  `code`  *italic*   inline, anywhere above
 */

import { chromium } from '../../testing/automation/node_modules/playwright-core/index.mjs';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

// Palette — mirrors branding.py.
export const BRAND = {
  blue: '#006096',
  deep: '#003654',
  orange: '#F7662D',
  ink: '#1A1A1A',
  muted: '#606676',
  rule: '#D5D9E0',
  labelFill: '#F2F6F9',
  codeFill: '#F4F6F8',
  noteFill: '#FDF1E0',
  bodyFont: 'Calibri, "Segoe UI", sans-serif',
  monoFont: 'Consolas, "Courier New", monospace',
  company: 'Futuristic Technologies',
  tagline: 'Decode the future',
  product: 'Shift Pay Management',
};

// --------------------------------------------------------------------------
// Inline markdown
// --------------------------------------------------------------------------

export const escapeHtml = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function inline(text) {
  // Code spans come out first and go back last, so a ** or * that happens to
  // sit inside backticks is shown rather than read as emphasis.
  const spans = [];
  let out = text.replace(/`([^`]+)`/g, (_, code) => {
    spans.push(code);
    return '\u0000' + (spans.length - 1) + '\u0000';
  });
  out = escapeHtml(out)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
  return out.replace(/\u0000(\d+)\u0000/g,
    (_, i) => '<code>' + escapeHtml(spans[Number(i)]) + '</code>');
}

export const splitRow = (line) =>
  line.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

export const isDivider = (line) => /^\|[\s:\-|]+\|$/.test(line.trim());

// A cell holding nothing but a requirement id — FR-E1, PC-10, OBJ-3. The
// narrow Ref column otherwise wraps them at the hyphen, one line per half.
const isRef = (cell) => /^[A-Z]{2,4}-[A-Z]?\d+$/.test(cell);

const IMAGE = /^!\[([^\]]*)\]\(([^)]+)\)$/;

// --------------------------------------------------------------------------
// Block markdown
// --------------------------------------------------------------------------

function renderTable(lines, i) {
  const rows = [];
  while (i < lines.length && lines[i].trim().startsWith('|')) {
    if (!isDivider(lines[i])) rows.push(splitRow(lines[i].trim()));
    i++;
  }
  // A header row is one with something in it. The metadata tables in the BRD
  // open with an empty `| | |` header, which is a layout device rather than a
  // header — those render as a label/value grid instead of a banded table.
  const headed = rows.length > 1 && rows[0].some((c) => c !== '');
  let html = '<table class="' + (headed ? 'grid' : 'facts') + '">';
  rows.forEach((cells, r) => {
    const tag = headed && r === 0 ? 'th' : 'td';
    html += '<tr>' + cells.map((c) =>
      '<' + tag + (isRef(c) ? ' class="ref"' : '') + '>' + inline(c) +
      '</' + tag + '>').join('') + '</tr>';
  });
  return [html + '</table>', i];
}

function renderList(lines, i, ordered) {
  const pattern = ordered ? /^(\d+)\.\s+(.*)$/ : /^[-*]\s+(.*)$/;
  const items = [];
  let start = null;
  while (i < lines.length) {
    const m = pattern.exec(lines[i].trim());
    if (!m) break;
    if (ordered && start === null) start = m[1];
    items.push('<li>' + inline(ordered ? m[2] : m[1]) + '</li>');
    i++;
  }
  if (!ordered) return ['<ul>' + items.join('') + '</ul>', i];
  // Keep the source numbering. The technical document's Contents runs 1–8,
  // then 9–14, then 15–17 as three separate lists; renumbering each from 1
  // would silently renumber the document's own sections.
  return ['<ol start="' + start + '">' + items.join('') + '</ol>', i];
}

/**
 * Embed a figure as a data URI.
 *
 * The page is printed through setContent with no base URL, so a relative src
 * would resolve against about:blank and quietly print nothing. Missing files
 * are a hard failure for the same reason: a diagram that silently vanishes from
 * a handover document is worse than a build that stops and says which one.
 */
async function figure(src, alt, repoRoot) {
  const file = path.resolve(repoRoot, src);
  if (!existsSync(file)) {
    throw new Error(
      'missing figure: ' + src + '\n' +
      'run: python tools/diagrams/build-diagrams.py && node tools/diagrams/render.mjs'
    );
  }
  const ext = path.extname(file).slice(1).toLowerCase();
  const mime = ext === 'svg' ? 'image/svg+xml' : 'image/' + (ext === 'jpg' ? 'jpeg' : ext);
  const uri = 'data:' + mime + ';base64,' + (await readFile(file)).toString('base64');
  return '<figure><img src="' + uri + '" alt="' + escapeHtml(alt) + '"></figure>';
}

/**
 * Render a markdown body to HTML.
 *
 * `repoRoot` resolves figure paths, which are written repo-relative in source.
 */
export async function renderMarkdown(markdown, { repoRoot }) {
  const lines = markdown.split(/\r?\n/);
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const stripped = lines[i].trim();

    if (!stripped) { i++; continue; }

    // ---- figure ----------------------------------------------------------
    const img = IMAGE.exec(stripped);
    if (img) {
      out.push(await figure(img[2], img[1], repoRoot));
      i++;
      continue;
    }

    // ---- fenced block ----------------------------------------------------
    if (stripped.startsWith('```')) {
      const body = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        body.push(lines[i]);
        i++;
      }
      i++;                                      // past the closing fence
      while (body.length && !body[0].trim()) body.shift();
      while (body.length && !body[body.length - 1].trim()) body.pop();
      out.push('<pre>' + escapeHtml(body.join('\n')) + '</pre>');
      continue;
    }

    // ---- rule ------------------------------------------------------------
    if (/^-{3,}$/.test(stripped)) {
      // A rule that only separates two sections is redundant once the heading
      // below it carries its own — drop it rather than draw the line twice.
      const next = lines.slice(i + 1).find((l) => l.trim());
      if (!next || !next.trim().startsWith('#')) out.push('<hr>');
      i++;
      continue;
    }

    // ---- heading ---------------------------------------------------------
    const heading = /^(#{1,4})\s+(.*)$/.exec(stripped);
    if (heading) {
      const level = heading[1].length;
      const title = heading[2];
      // `# Part I — Domain` opens a new page, split into the label and the
      // name the way the Word builder's part divider does. The first section
      // of the part then follows on the same page, as it does there.
      if (level === 1 && /^part\s/i.test(title)) {
        const [label, name] = title.split(/\s*—\s*/);
        out.push(
          '<section class="part">' +
          '<div class="part-label">' + escapeHtml(label.toUpperCase()) + '</div>' +
          '<h1 class="part-title">' + escapeHtml(name || label) + '</h1>' +
          '</section>');
      } else {
        out.push('<h' + level + '>' + inline(title) + '</h' + level + '>');
      }
      i++;
      continue;
    }

    // ---- blockquote ------------------------------------------------------
    if (stripped.startsWith('>')) {
      const block = [];
      while (i < lines.length && lines[i].trim().startsWith('>')) {
        block.push(lines[i].trim().replace(/^>\s?/, ''));
        i++;
      }
      out.push('<blockquote>' + inline(block.filter(Boolean).join(' ')) + '</blockquote>');
      continue;
    }

    // ---- table -----------------------------------------------------------
    if (stripped.startsWith('|')) {
      const [html, next] = renderTable(lines, i);
      out.push(html);
      i = next;
      continue;
    }

    // ---- lists -----------------------------------------------------------
    if (/^[-*]\s+/.test(stripped)) {
      const [html, next] = renderList(lines, i, false);
      out.push(html);
      i = next;
      continue;
    }
    if (/^\d+\.\s+/.test(stripped)) {
      const [html, next] = renderList(lines, i, true);
      out.push(html);
      i = next;
      continue;
    }

    // ---- paragraph -------------------------------------------------------
    // One line, one paragraph — deliberately not the markdown convention of
    // joining consecutive lines into a soft-wrapped block. Neither source
    // document hard-wraps prose: every paragraph is a single long line, and the
    // only run of consecutive prose lines in either is the technical document's
    // four Appendix entries, which are four separate entries and joined into a
    // run-on line by the conventional reading. This is also what the Word
    // builder does, so the two renderings of the same source agree.
    out.push('<p>' + inline(stripped) + '</p>');
    i++;
  }

  return out.join('\n');
}

// --------------------------------------------------------------------------
// Print stylesheet
// --------------------------------------------------------------------------

/**
 * The shared print stylesheet. `extra` appends document-specific rules — the
 * cover, and anything one document needs and the other does not.
 */
export function styles(extra = '') {
  return `
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: ${BRAND.bodyFont};
    font-size: 10.5pt;
    line-height: 1.45;
    color: ${BRAND.ink};
  }

  h1, h2, h3, h4 { color: ${BRAND.deep}; page-break-after: avoid; }
  h1 { font-size: 17pt; margin: 0 0 4mm; }
  h2 {
    font-size: 15pt; margin: 9mm 0 3mm; padding-top: 2.5mm;
    border-top: 2px solid ${BRAND.blue}; color: ${BRAND.blue};
  }
  h3 { font-size: 11.5pt; margin: 6mm 0 2mm; }
  h4 { font-size: 10.5pt; margin: 5mm 0 1.5mm; color: ${BRAND.muted}; }
  p { margin: 0 0 2.5mm; }
  ul, ol { margin: 0 0 3mm; padding-left: 6mm; }
  li { margin-bottom: 1.2mm; }
  hr { border: 0; border-top: 1px solid ${BRAND.rule}; margin: 6mm 0; }

  /* A part divider opens a page and the part's first section follows it on
     that page — the same shape as the Word builder's part_divider. */
  section.part {
    page-break-before: always;
    padding-top: 30mm; margin-bottom: 8mm;
    border-bottom: 2px solid ${BRAND.rule}; padding-bottom: 3mm;
  }
  .part-label {
    font-size: 11pt; font-weight: 700; letter-spacing: 3px;
    color: ${BRAND.orange}; margin-bottom: 2mm;
  }
  h1.part-title { font-size: 30pt; margin: 0; color: ${BRAND.deep}; }
  section.part + h2 { border-top: 0; padding-top: 0; margin-top: 0; }

  figure { margin: 4mm 0 5mm; text-align: center; page-break-inside: avoid; }
  figure img { width: 100%; height: auto; }

  code {
    font-family: ${BRAND.monoFont}; font-size: 9pt;
    background: ${BRAND.codeFill}; padding: 0 1mm; border-radius: 2px;
  }
  pre {
    font-family: ${BRAND.monoFont}; font-size: 8pt; line-height: 1.35;
    background: ${BRAND.codeFill}; border-left: 3px solid ${BRAND.blue};
    padding: 3mm 4mm; margin: 0 0 4mm; white-space: pre-wrap;
    page-break-inside: avoid;
  }
  blockquote {
    margin: 0 0 3mm; padding: 2.5mm 4mm;
    background: ${BRAND.noteFill}; border-left: 3px solid ${BRAND.orange};
  }

  table { width: 100%; border-collapse: collapse; margin: 0 0 4mm; font-size: 9.5pt; }
  th, td {
    border: 1px solid ${BRAND.rule}; padding: 1.6mm 2.2mm;
    text-align: left; vertical-align: top;
  }
  table.grid th { background: ${BRAND.blue}; color: #FFFFFF; font-weight: 700; }
  /* A column header is often a field name, so it arrives as a code span. Its
     pale chip background on the blue header leaves white text unreadable. */
  table.grid th code { background: transparent; color: #FFFFFF; padding: 0; }
  table.grid tr:nth-child(even) td { background: #FAFBFC; }
  table.facts th { background: ${BRAND.labelFill}; color: ${BRAND.deep}; width: 32%; }
  td.ref, th.ref { white-space: nowrap; width: 1%; font-weight: 600; color: ${BRAND.deep}; }
  /* A row split across a page break loses its alignment with the header, so
     keep each one whole; a table may still break between rows. */
  tr { page-break-inside: avoid; }

  .cover { page-break-after: always; padding-top: 4mm; }
  .cover .logo { width: 46mm; margin-bottom: 14mm; }
  .cover .wordmark {
    font-size: 13pt; font-weight: 700; letter-spacing: 3px;
    color: ${BRAND.blue}; border-bottom: 2px solid ${BRAND.rule};
    padding-bottom: 4mm; margin-bottom: 14mm;
  }
  .eyebrow { font-size: 10pt; font-weight: 700; color: ${BRAND.blue}; margin-bottom: 2mm; }
  .cover-title {
    font-size: 26pt; color: ${BRAND.deep};
    margin: 0 0 3mm; border: 0; padding: 0;
  }
  .cover-sub { font-size: 13pt; color: ${BRAND.ink}; margin: 0 0 12mm; }
  .cover-facts { margin-bottom: 14mm; }
  .tagline { color: ${BRAND.orange}; font-size: 10pt; margin: 0; }
${extra}`;
}

/**
 * The company wordmark for a cover, as a data URI image where the brand asset
 * has been dropped in and a typographic fallback where it has not — the same
 * optional-by-design contract branding.py's logo_path() keeps.
 */
export async function wordmark(repoRoot) {
  const logo = path.join(
    repoRoot, 'testing', 'evidence-generator', 'assets', 'ft-logo.png');
  if (!existsSync(logo)) {
    console.warn('  note: no logo in testing/evidence-generator/assets — using the wordmark');
    return '<div class="wordmark">' + BRAND.company.toUpperCase() + '</div>';
  }
  const uri = 'data:image/png;base64,' + (await readFile(logo)).toString('base64');
  return '<img class="logo" src="' + uri + '" alt="' + BRAND.company + '">';
}

// --------------------------------------------------------------------------
// Printing
// --------------------------------------------------------------------------

/**
 * Launch whichever Chromium this machine has.
 *
 * The diagram renderer next door assumes the browser the test pack installs,
 * because it runs on a machine that has already been through SETUP.md track B.
 * A document build has no such claim on the reader — this must work on a laptop
 * that only ever wanted the PDF — so the bundled browser is tried first and the
 * installed Chrome or Edge stands in for it. Print layout is Chromium's either
 * way; the channel changes nothing about the output.
 */
export async function launch() {
  const attempts = [
    ['the browser installed by the test pack', {}],
    ['Google Chrome', { channel: 'chrome' }],
    ['Microsoft Edge', { channel: 'msedge' }],
  ];
  for (const [what, options] of attempts) {
    try {
      return await chromium.launch(options);
    } catch {
      console.warn('  note: could not launch ' + what + ', trying the next');
    }
  }
  throw new Error(
    'No Chromium available. Install Chrome or Edge, or run ' +
    '`npx playwright install chromium` in testing/automation.'
  );
}

// Chromium renders the header and footer in their own document, so they get
// their own inline styling — nothing from styles() reaches them.
//
// The font stack is single-quoted: this is an inline style attribute, and
// BRAND.bodyFont quotes "Segoe UI" with the same double quote that closes the
// attribute. That failure is silent — Chromium drops the malformed template and
// prints the page with no running head at all.
const CHROME_FONT = BRAND.bodyFont.replace(/"/g, "'");

const chrome = (left, right) =>
  '<div style="width:100%;font-family:' + CHROME_FONT + ';font-size:7.5pt;' +
  'color:' + BRAND.muted + ';padding:0 16mm;display:flex;' +
  'justify-content:space-between;"><span>' + left + '</span><span>' + right +
  '</span></div>';

/**
 * Print an assembled page to `target`.
 *
 * setContent rather than a temp file: every asset is already inlined as a data
 * URI, so there is no reason for the assembled document to touch disk.
 */
export async function printPdf({ html, target, docKind, title, confidentiality }) {
  const browser = await launch();
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: 'load' });
  await page.pdf({
    path: target,
    format: 'A4',
    printBackground: true,
    displayHeaderFooter: true,
    headerTemplate: chrome(
      '<b style="color:' + BRAND.blue + '">' + escapeHtml(title) + '</b>',
      BRAND.product + ' &nbsp;·&nbsp; ' + docKind
    ),
    footerTemplate: chrome(
      confidentiality.split('.')[0] + '.',
      'Page <span class="pageNumber"></span> of <span class="totalPages"></span>'
    ),
    margin: { top: '20mm', bottom: '16mm', left: '16mm', right: '16mm' },
  });
  await browser.close();
  return target;
}
