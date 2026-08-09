import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The one place that knows where the embedded PDF fonts live.
 *
 * Two documents are rendered server-side — the per-order contract and the paid
 * VIN history report — and both need a Unicode face: contracts interpolate
 * party names, VIN histories are served in de/en/ru, and pdfkit's built-in
 * Helvetica is WinAnsi-encoded, so a Cyrillic name or a Russian label silently
 * becomes mojibake in a document someone paid for.
 *
 * The TTFs ship once, under `src/legal/assets` (copied to `dist` by
 * `nest-cli.json`). A second copy beside the VIN history renderer would be
 * ~1.2 MB of duplicated binary in the repo and in every image, and the two
 * copies would drift the first time one was updated.
 */

const FONT_DIR = join(__dirname, 'assets');
const REGULAR_PATH = join(FONT_DIR, 'NotoSans-Regular.ttf');
const BOLD_PATH = join(FONT_DIR, 'NotoSans-Bold.ttf');

/** Font names to draw with, plus whether the Unicode faces actually loaded. */
export interface PdfFonts {
  regular: string;
  bold: string;
  /** False when the assets did not ship and pdfkit's WinAnsi built-ins are in use. */
  embedded: boolean;
}

/** True when the embedded Unicode fonts shipped with the build. */
export function pdfFontsAvailable(): boolean {
  return existsSync(REGULAR_PATH) && existsSync(BOLD_PATH);
}

// Read once per process rather than once per document: a report rendered on
// every download would otherwise re-read 1.2 MB from disk each time. pdfkit
// parses the buffer and does not write to it, so one shared copy is safe.
let regularBytes: Buffer | null = null;
let boldBytes: Buffer | null = null;

/**
 * Register the Unicode faces on a document and return the names to draw with.
 *
 * Falls back to the built-ins rather than throwing: a missing asset must
 * degrade Latin text, not fail a contract render or a paid download.
 */
export function registerPdfFonts(doc: PDFKit.PDFDocument): PdfFonts {
  if (!pdfFontsAvailable()) {
    return { regular: 'Helvetica', bold: 'Helvetica-Bold', embedded: false };
  }
  regularBytes ??= readFileSync(REGULAR_PATH);
  boldBytes ??= readFileSync(BOLD_PATH);
  doc.registerFont('NotoSans', regularBytes);
  doc.registerFont('NotoSans-Bold', boldBytes);
  return { regular: 'NotoSans', bold: 'NotoSans-Bold', embedded: true };
}
