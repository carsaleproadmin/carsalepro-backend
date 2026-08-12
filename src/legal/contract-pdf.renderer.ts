import PDFDocument from 'pdfkit';
import {
  InlineSpan,
  MarkdownBlock,
  parseMarkdownBlocks,
  spansToText,
} from './markdown-blocks';
import { pdfFontsAvailable, registerPdfFonts } from './pdf-fonts';

/**
 * Render a contract to PDF with pdfkit.
 *
 * No headless browser. The source is already markdown and we already own a
 * parser for it, so rendering the same block list to pdfkit primitives skips
 * HTML entirely: deterministic output, ~1 MB of dependency, tens of
 * milliseconds, and no risk of a Chromium OOM on a 512 MB instance.
 *
 * Noto Sans is embedded rather than using pdfkit's built-in Helvetica, which is
 * WinAnsi-encoded. The contract interpolates customer and inspector names, and
 * the platform serves a Russian locale — a Cyrillic name must not silently turn
 * into mojibake in a legal document. The fonts are shared with the VIN history
 * renderer through `pdf-fonts.ts`.
 */

const PAGE_MARGIN = 56;
const BODY_SIZE = 10.5;
const LINE_GAP = 3;

interface RenderOptions {
  /** Contract title, printed as the document heading and PDF metadata. */
  title: string;
  /** ORD-#### — printed in the header so a paper copy is traceable. */
  orderNumber: string;
  locale: string;
  /** Rendered at the foot of every page. Pass a fixed value to keep output stable. */
  renderedAt: Date;
}

/**
 * True when the embedded Unicode fonts shipped with the build.
 *
 * Kept as a named export because the contract service and its spec both assert
 * on it; the implementation now lives with the fonts themselves.
 */
export function contractFontsAvailable(): boolean {
  return pdfFontsAvailable();
}

export function renderContractPdf(markdown: string, opts: RenderOptions): Promise<Buffer> {
  const blocks = parseMarkdownBlocks(markdown);

  return new Promise<Buffer>((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'A4',
        margins: {
          top: PAGE_MARGIN,
          bottom: PAGE_MARGIN + 24, // room for the footer
          left: PAGE_MARGIN,
          right: PAGE_MARGIN,
        },
        info: {
          Title: opts.title,
          Author: 'CarSalePro',
          Subject: `Inspection contract ${opts.orderNumber}`,
          CreationDate: opts.renderedAt,
        },
        autoFirstPage: true,
        // Load-bearing, not a tuning knob. Without it pdfkit writes each page
        // out the moment the next one starts, `bufferedPageRange()` below then
        // reports only the page still in memory, and every multi-page contract
        // ships with a footer on the LAST page alone, numbered "1 / 1".
        bufferPages: true,
      });

      const chunks: Buffer[] = [];
      doc.on('data', (c: Buffer) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const fonts = registerPdfFonts(doc);

      drawHeader(doc, opts, fonts.regular, fonts.bold);
      for (const block of blocks) {
        drawBlock(doc, block, fonts.regular, fonts.bold);
      }
      drawFooters(doc, opts, fonts.regular);

      doc.end();
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

function drawHeader(
  doc: PDFKit.PDFDocument,
  opts: RenderOptions,
  fontRegular: string,
  fontBold: string,
): void {
  doc.font(fontBold).fontSize(9).fillColor('#6b7380').text('CARSALEPRO', { continued: true });
  doc.font(fontRegular).text(`   ${opts.orderNumber}`, { align: 'left' });
  doc.moveDown(0.6);
  doc.font(fontBold).fontSize(16).fillColor('#0e1116').text(opts.title);
  doc.moveDown(0.8);
  doc
    .moveTo(PAGE_MARGIN, doc.y)
    .lineTo(doc.page.width - PAGE_MARGIN, doc.y)
    .strokeColor('#d7dbe0')
    .lineWidth(0.75)
    .stroke();
  doc.moveDown(0.9);
}

function drawBlock(
  doc: PDFKit.PDFDocument,
  block: MarkdownBlock,
  fontRegular: string,
  fontBold: string,
): void {
  switch (block.kind) {
    case 'heading': {
      const size = block.level === 1 ? 14 : block.level === 2 ? 12 : 11;
      const gapBefore = block.level === 1 ? 0.7 : 0.5;
      const text = spansToText(block.spans);

      doc.font(fontBold).fontSize(size).fillColor('#0e1116');
      if (!headingFitsWithContent(doc, text, gapBefore)) {
        doc.addPage();
      } else {
        doc.moveDown(gapBefore);
      }

      doc.font(fontBold).fontSize(size).fillColor('#0e1116');
      doc.text(text, { lineGap: LINE_GAP });
      doc.moveDown(0.25);
      break;
    }
    case 'paragraph': {
      doc.font(fontRegular).fontSize(BODY_SIZE).fillColor('#1a1a1a');
      for (const line of block.lines) {
        drawSpans(doc, line, fontRegular, fontBold);
      }
      doc.moveDown(0.5);
      break;
    }
    case 'list': {
      doc.font(fontRegular).fontSize(BODY_SIZE).fillColor('#1a1a1a');
      for (const item of block.items) {
        const x = doc.x;
        doc.text('•', x, doc.y, { continued: true, lineGap: LINE_GAP });
        doc.text('  ', { continued: true });
        drawSpans(doc, item, fontRegular, fontBold, { indent: 12 });
      }
      doc.moveDown(0.5);
      break;
    }
  }
}

/**
 * Body lines that must fit under a heading before the heading may stay on the
 * page. Two is the smallest number that stops a section title from being the
 * last thing on a sheet: with one line, "3. Scope of the inspection" plus the
 * opening clause sat alone at the foot of page 1 while the terms it introduces
 * began on page 2, which reads as though the section were empty.
 */
const MIN_LINES_UNDER_HEADING = 2;

/**
 * True when the heading AND the first lines of the text it introduces fit in
 * what is left of the page.
 *
 * pdfkit paginates a heading only when the heading itself does not fit, so it
 * happily leaves one at the very bottom. There is no lookahead at the next
 * block here on purpose: reserving a fixed two body lines needs no knowledge of
 * what follows, and every heading in a contract is followed by prose or a list
 * whose lines are this height. The caller must have selected the heading font
 * and size before asking, because the measurement uses them.
 */
function headingFitsWithContent(
  doc: PDFKit.PDFDocument,
  text: string,
  gapBefore: number,
): boolean {
  const width = doc.page.width - PAGE_MARGIN * 2;
  const headingHeight = doc.heightOfString(text, { width, lineGap: LINE_GAP });
  // The body lines are reserved from the nominal size, not measured: switching
  // the font to measure them and switching back would leave the caller's font
  // state depending on this predicate. 1.2 is the leading of the embedded face.
  const bodyLine = BODY_SIZE * 1.2 + LINE_GAP;
  const needed =
    doc.currentLineHeight(true) * gapBefore +
    headingHeight +
    MIN_LINES_UNDER_HEADING * bodyLine;

  return doc.y + needed <= doc.page.maxY();
}

/**
 * Draw one line of mixed formatting. pdfkit's `continued` flag keeps runs on the
 * same line; the final run closes it.
 */
function drawSpans(
  doc: PDFKit.PDFDocument,
  spans: InlineSpan[],
  fontRegular: string,
  fontBold: string,
  opts: { indent?: number } = {},
): void {
  const nonEmpty = spans.filter((s) => s.text.length > 0);
  if (nonEmpty.length === 0) {
    doc.moveDown(0.4);
    return;
  }

  nonEmpty.forEach((span, i) => {
    const last = i === nonEmpty.length - 1;
    doc.font(span.kind === 'bold' ? fontBold : fontRegular);
    // pdfkit has no italic cut of an embedded family; render italics as regular
    // rather than synthesising a slant, which reads as a rendering bug.
    doc.text(span.text, {
      continued: !last,
      lineGap: LINE_GAP,
      indent: i === 0 ? opts.indent : undefined,
    });
  });
}

/**
 * Page n/m plus the render timestamp, on every page.
 *
 * `height` is not cosmetic. The footer sits BELOW the bottom margin, and any
 * pdfkit `text` call that carries a `width` goes through the line wrapper,
 * which opens a new page as soon as the cursor passes `page.maxY()` —
 * `lineBreak: false` does not stop it. Every footer drawn was therefore
 * appending a blank page to the document (and those pages got no footer of
 * their own). Giving the wrapper an explicit height tells it this text is one
 * line and it must not paginate.
 */
const FOOTER_LINE_HEIGHT = 12;

function drawFooters(doc: PDFKit.PDFDocument, opts: RenderOptions, fontRegular: string): void {
  const range = doc.bufferedPageRange();
  const stamp = opts.renderedAt.toISOString().slice(0, 16).replace('T', ' ');

  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const y = doc.page.height - PAGE_MARGIN;
    const width = doc.page.width - PAGE_MARGIN * 2;
    doc.font(fontRegular).fontSize(8).fillColor('#6b7380');
    doc.text(`${opts.orderNumber} · ${stamp} UTC`, PAGE_MARGIN, y, {
      width,
      height: FOOTER_LINE_HEIGHT,
      align: 'left',
      lineBreak: false,
    });
    doc.text(`${i - range.start + 1} / ${range.count}`, PAGE_MARGIN, y, {
      width,
      height: FOOTER_LINE_HEIGHT,
      align: 'right',
      lineBreak: false,
    });
  }
}
