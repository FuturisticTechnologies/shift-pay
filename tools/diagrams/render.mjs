/**
 * Render the diagram SVGs to PNG.
 *
 *   node tools/diagrams/render.mjs
 *
 * Uses the Chromium the test pack already has installed, at a 2x device scale
 * so the images stay crisp when Word places them at ~6.4in wide. A browser is
 * used rather than a Python raster library because these diagrams are typeset
 * as much as drawn: the text has to be laid out with the same font engine that
 * the rest of the document assumes, and arrowheads and dash patterns have to
 * survive antialiasing.
 */

import { chromium } from '../../testing/automation/node_modules/playwright-core/index.mjs';
import { readdir, readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SVG_DIR = path.join(HERE, 'svg');
const PNG_DIR = path.join(HERE, 'png');
const SCALE = 2;

const names = (await readdir(SVG_DIR)).filter((f) => f.endsWith('.svg')).sort();
if (!names.length) {
  console.error('no SVGs found — run build-diagrams.py first');
  process.exit(1);
}

await mkdir(PNG_DIR, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: SCALE });

for (const name of names) {
  const svg = await readFile(path.join(SVG_DIR, name), 'utf8');
  const width = Number(/width="(\d+)"/.exec(svg)[1]);
  const height = Number(/height="(\d+)"/.exec(svg)[1]);

  await page.setViewportSize({ width, height });
  // Zero the body margin, or the screenshot picks up the default 8px gutter.
  await page.setContent(
    `<!doctype html><meta charset="utf-8">
     <style>html,body{margin:0;padding:0;background:#fff}</style>${svg}`,
    { waitUntil: 'load' }
  );

  const out = path.join(PNG_DIR, name.replace(/\.svg$/, '.png'));
  await page.screenshot({ path: out, clip: { x: 0, y: 0, width, height } });
  console.log(`  ${path.basename(out)}  ${width}x${height} @${SCALE}x`);
}

await browser.close();
console.log(`rendered ${names.length} diagrams to ${PNG_DIR}`);
