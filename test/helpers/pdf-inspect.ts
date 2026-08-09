import PDFDocument from 'pdfkit';

/**
 * Assertions about a rendered PDF, shared by the contract and VIN history
 * renderer specs.
 *
 * A PDF is close to unassertable from the outside: pdfkit compresses content
 * streams and embeds a SUBSET of the font, so the drawn text is a sequence of
 * glyph ids with no relation to the characters that produced them. Asserting
 * "the footer says 2 / 3" by reading the bytes is therefore not on the table.
 *
 * What IS observable is the structure — how many page objects the document
 * contains — and how the renderer walked those pages while drawing the footer.
 * Together they pin the property that matters: every page gets a footer, and
 * the page numbers are drawn against the real total.
 *
 * Lives in `test/` rather than `src/` on purpose: `tsconfig.build.json` excludes
 * this directory, so a test-only helper cannot end up in `dist`.
 */

/**
 * Number of pages in a rendered document.
 *
 * Page objects are written as plain dictionaries (only content STREAMS are
 * compressed), so counting `/Type /Page` is reliable. `/Type /Pages` — the tree
 * node — is excluded by requiring a non-`s` character after it.
 */
export function pdfPageCount(pdf: Buffer): number {
  const matches = pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g);
  return matches ? matches.length : 0;
}

export interface PageVisitTracker {
  /** Zero-based page indices the renderer switched to, in order. */
  visited(): number[];
  restore(): void;
}

/**
 * Record every `switchToPage` a renderer performs.
 *
 * This is what makes the `bufferPages` bug visible. With buffering off, pdfkit
 * flushes each page as the next one opens, `bufferedPageRange()` reports the
 * single page still in memory, and the footer loop runs exactly ONCE however
 * long the document is — one footer, on the last page, numbered "1 / 1".
 */
export function trackPageVisits(): PageVisitTracker {
  const spy = jest.spyOn(PDFDocument.prototype, 'switchToPage');
  return {
    visited: () => spy.mock.calls.map((call) => call[0] as number),
    restore: () => spy.mockRestore(),
  };
}
