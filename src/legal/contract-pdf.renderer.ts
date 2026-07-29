import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import PDFDocument from 'pdfkit';
import {
  InlineSpan,
  MarkdownBlock,
  parseMarkdownBlocks,
  spansToText,
} from './markdown-blocks';

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
 * into mojibake in a legal document.
 */

const FONT_DIR = join(__dirname, 'assets');
const REGULAR = join(FONT_DIR, 'NotoSans-Regular.ttf');
const BOLD = join(FONT_DIR, 'NotoSans-Bold.ttf');

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

/** True when the embedded Unicode fonts shipped with the build. */
export function contractFontsAvailable(): boolean {
  return existsSync(REGULAR) && existsSync(BOLD);
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
      });

      const chunks: Buffer[] = [];
      doc.on('data', (c: Buffer) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      // Fall back to the built-ins if the assets did not ship. Latin text still
      // renders correctly; the caller logs the degradation.
      const hasFonts = contractFontsAvailable();
      const fontRegular = hasFonts ? 'NotoSans' : 'Helvetica';
      const fontBold = hasFonts ? 'NotoSans-Bold' : 'Helvetica-Bold';
      if (hasFonts) {
        doc.registerFont('NotoSans', readFileSync(REGULAR));
        doc.registerFont('NotoSans-Bold', readFileSync(BOLD));
      }

      drawHeader(doc, opts, fontRegular, fontBold);
      for (const block of blocks) {
        drawBlock(doc, block, fontRegular, fontBold);
      }
      drawFooters(doc, opts, fontRegular);

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
      doc.moveDown(block.level === 1 ? 0.7 : 0.5);
      doc.font(fontBold).fontSize(size).fillColor('#0e1116');
      doc.text(spansToText(block.spans), { lineGap: LINE_GAP });
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

/** Page n/m plus the render timestamp, on every page. */
function drawFooters(doc: PDFKit.PDFDocument, opts: RenderOptions, fontRegular: string): void {
  const range = doc.bufferedPageRange();
  const stamp = opts.renderedAt.toISOString().slice(0, 16).replace('T', ' ');

  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const y = doc.page.height - PAGE_MARGIN;
    doc.font(fontRegular).fontSize(8).fillColor('#6b7380');
    doc.text(
      `${opts.orderNumber} · ${stamp} UTC`,
      PAGE_MARGIN,
      y,
      { width: doc.page.width - PAGE_MARGIN * 2, align: 'left', lineBreak: false },
    );
    doc.text(
      `${i - range.start + 1} / ${range.count}`,
      PAGE_MARGIN,
      y,
      { width: doc.page.width - PAGE_MARGIN * 2, align: 'right', lineBreak: false },
    );
  }
}
