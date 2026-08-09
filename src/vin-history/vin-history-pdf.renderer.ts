import PDFDocument from 'pdfkit';
import { PdfFonts, registerPdfFonts } from '../legal/pdf-fonts';
import { VinHistoryPayloadV1 } from './vin-history-payload-v1';
import {
  VinHistoryReportModel,
  VinHistoryReportRow,
  VinHistoryReportSection,
  VinHistoryReportSectionId,
  buildVinHistoryReportModel,
} from './vin-history-report-model';

/**
 * Draw the paid VIN history document.
 *
 * This file knows about geometry and nothing else. Every decision about WHAT
 * the document says — sections, empty notes, money, durations, the synthetic
 * warning — is made in `vin-history-report-model.ts`, which is testable;
 * embedded subset fonts make PDF text unreadable without a parser, so a rule
 * that lived here would effectively be untested.
 *
 * pdfkit rather than a headless browser, for the same reasons as the contract
 * renderer: deterministic bytes, tens of milliseconds, and no Chromium on a
 * 512 MB instance.
 */

const PAGE_MARGIN = 44;
/** Reserved strip at the foot of every page for the footer band. */
const FOOTER_SPACE = 30;
/**
 * Explicit height for the footer lines.
 *
 * The footer sits below the bottom margin, and a pdfkit `text` call carrying a
 * `width` goes through the line wrapper, which opens a new page the moment the
 * cursor passes `page.maxY()` — `lineBreak: false` does not prevent it. Three
 * footer draws per page on a seven-page report produced twenty-one extra blank
 * pages, none of which had a footer. Declaring the height tells the wrapper
 * this is one line and it must not paginate.
 */
const FOOTER_LINE_HEIGHT = 12;

const COLOR = {
  ink: '#0e1116',
  body: '#1a1a1a',
  muted: '#6b7380',
  rule: '#d7dbe0',
  headerFill: '#f2f4f7',
  alert: '#b42318',
  alertFill: '#fef3f2',
  ok: '#067647',
  warnFill: '#fffaeb',
  warnBorder: '#dc6803',
} as const;

/** Relative column weights per section. Sum is normalised, so these are ratios. */
const COLUMN_WEIGHTS: Record<VinHistoryReportSectionId, number[]> = {
  owners: [0.6, 1.6, 0.9, 1.3, 1.3, 1.3],
  mileage: [1.3, 1.6, 1.6, 1],
  damages: [1.3, 1.4, 2.4, 1.8, 1],
  registrations: [0.9, 1.2, 1.5, 1.5, 1.4, 1.3],
  recalls: [1.4, 1.2, 1.1, 2.8, 1],
  theft: [1.8, 1.2, 0.9, 1.8, 1.4],
  inspections: [1.2, 1.4, 1.7, 1.4, 0.9, 1.2],
};

export interface VinHistoryPdfOptions {
  /** `User.locale`; anything unsupported falls back to the platform default. */
  locale?: string | null;
  purchaseId?: string | null;
  purchasedAt?: Date | null;
  /** Pass a fixed value to make two renders of one payload byte-identical. */
  renderedAt?: Date;
}

/** What the buyer's browser should call the file. */
export function vinHistoryPdfFilename(vin: string): string {
  return `carsalepro-vin-history-${vin.toUpperCase()}.pdf`;
}

export function renderVinHistoryPdf(
  payload: VinHistoryPayloadV1,
  options: VinHistoryPdfOptions = {},
): Promise<Buffer> {
  const renderedAt = options.renderedAt ?? new Date();
  const model = buildVinHistoryReportModel(payload, { ...options, renderedAt });

  return new Promise<Buffer>((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'A4',
        margins: {
          top: PAGE_MARGIN,
          bottom: PAGE_MARGIN + FOOTER_SPACE,
          left: PAGE_MARGIN,
          right: PAGE_MARGIN,
        },
        info: {
          Title: `${model.title} — ${model.vin}`,
          Author: 'CarSalePro',
          Subject: model.synthetic
            ? `${model.title} ${model.vin} (generated data)`
            : `${model.title} ${model.vin}`,
          CreationDate: renderedAt,
        },
        autoFirstPage: true,
        // Every page carries a footer, and the footers are drawn after the body
        // so they can say "3 / 7". Without this pdfkit flushes each page as the
        // next one opens and only the last page would get one.
        bufferPages: true,
      });

      const chunks: Buffer[] = [];
      doc.on('data', (c: Buffer) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const fonts = registerPdfFonts(doc);

      drawHeader(doc, model, fonts);
      if (model.syntheticWarning) drawSyntheticWarning(doc, model, fonts);
      drawHighlights(doc, model, fonts);
      for (const section of model.sections) {
        drawSection(doc, section, fonts);
      }
      drawFooters(doc, model, fonts);

      doc.end();
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

// ============================================================
// Geometry helpers
// ============================================================

function contentWidth(doc: PDFKit.PDFDocument): number {
  return doc.page.width - PAGE_MARGIN * 2;
}

function bottomLimit(doc: PDFKit.PDFDocument): number {
  return doc.page.height - PAGE_MARGIN - FOOTER_SPACE;
}

/** Open a new page when `needed` points would run into the footer band. */
function ensureSpace(doc: PDFKit.PDFDocument, needed: number): void {
  if (doc.y + needed > bottomLimit(doc)) doc.addPage();
}

function columnWidths(doc: PDFKit.PDFDocument, id: VinHistoryReportSectionId, count: number): number[] {
  const weights =
    COLUMN_WEIGHTS[id]?.length === count ? COLUMN_WEIGHTS[id] : new Array<number>(count).fill(1);
  const total = weights.reduce((a, b) => a + b, 0);
  const usable = contentWidth(doc);
  return weights.map((w) => (usable * w) / total);
}

// ============================================================
// Blocks
// ============================================================

function drawHeader(doc: PDFKit.PDFDocument, model: VinHistoryReportModel, fonts: PdfFonts): void {
  doc.font(fonts.bold).fontSize(9).fillColor(COLOR.muted).text('CARSALEPRO');
  doc.moveDown(0.3);
  doc.font(fonts.bold).fontSize(19).fillColor(COLOR.ink).text(model.title);
  doc.font(fonts.regular).fontSize(9.5).fillColor(COLOR.muted).text(model.subtitle);
  doc.moveDown(0.5);

  doc.font(fonts.bold).fontSize(15).fillColor(COLOR.ink).text(model.vin, { characterSpacing: 0.6 });
  doc.moveDown(0.4);

  // Meta pairs, two per line, so the retrieval / purchase / render dates sit
  // next to their own labels and cannot be read as one another.
  const width = contentWidth(doc) / 2;
  doc.fontSize(8.5);
  for (let i = 0; i < model.meta.length; i += 2) {
    const y = doc.y;
    drawMetaPair(doc, model.meta[i], PAGE_MARGIN, y, width - 8, fonts);
    if (model.meta[i + 1]) {
      drawMetaPair(doc, model.meta[i + 1], PAGE_MARGIN + width, y, width - 8, fonts);
    }
    doc.y = y + 12;
  }

  doc.moveDown(0.5);
  horizontalRule(doc);
  doc.moveDown(0.6);
}

function drawMetaPair(
  doc: PDFKit.PDFDocument,
  entry: { label: string; value: string },
  x: number,
  y: number,
  width: number,
  fonts: PdfFonts,
): void {
  doc.font(fonts.regular).fillColor(COLOR.muted).text(`${entry.label}: `, x, y, {
    width,
    continued: true,
    lineBreak: false,
  });
  doc.font(fonts.bold).fillColor(COLOR.body).text(entry.value, { lineBreak: false });
}

function horizontalRule(doc: PDFKit.PDFDocument): void {
  doc
    .moveTo(PAGE_MARGIN, doc.y)
    .lineTo(doc.page.width - PAGE_MARGIN, doc.y)
    .strokeColor(COLOR.rule)
    .lineWidth(0.75)
    .stroke();
}

/**
 * The generated-data frame.
 *
 * Deliberately the first thing under the VIN and impossible to mistake for a
 * disclaimer footnote: the mock provider may sell in production behind
 * `VIN_HISTORY_ALLOW_SYNTHETIC_SALE`, and a buyer must not be able to read this
 * document without being told what it is.
 */
function drawSyntheticWarning(
  doc: PDFKit.PDFDocument,
  model: VinHistoryReportModel,
  fonts: PdfFonts,
): void {
  const warning = model.syntheticWarning;
  if (!warning) return;

  const width = contentWidth(doc);
  const inner = width - 24;
  doc.fontSize(9);
  const bodyHeight = doc.font(fonts.regular).heightOfString(warning.body, { width: inner });
  const height = bodyHeight + 34;

  ensureSpace(doc, height + 10);
  const top = doc.y;
  doc
    .roundedRect(PAGE_MARGIN, top, width, height, 4)
    .fillAndStroke(COLOR.warnFill, COLOR.warnBorder);

  doc
    .font(fonts.bold)
    .fontSize(9)
    .fillColor(COLOR.warnBorder)
    .text(`${warning.badge} · ${warning.title}`, PAGE_MARGIN + 12, top + 9, { width: inner });
  doc
    .font(fonts.regular)
    .fontSize(9)
    .fillColor(COLOR.body)
    .text(warning.body, PAGE_MARGIN + 12, top + 22, { width: inner });

  doc.y = top + height + 12;
  doc.x = PAGE_MARGIN;
}

function drawHighlights(
  doc: PDFKit.PDFDocument,
  model: VinHistoryReportModel,
  fonts: PdfFonts,
): void {
  doc.font(fonts.bold).fontSize(12).fillColor(COLOR.ink).text(model.highlightsTitle, PAGE_MARGIN, doc.y);
  doc.moveDown(0.4);

  const columns = 2;
  const cellWidth = contentWidth(doc) / columns;
  const cellHeight = 17;

  for (let i = 0; i < model.highlights.length; i += columns) {
    ensureSpace(doc, cellHeight);
    const top = doc.y;
    for (let c = 0; c < columns; c += 1) {
      const item = model.highlights[i + c];
      if (!item) continue;
      const x = PAGE_MARGIN + c * cellWidth;
      const tone =
        item.tone === 'alert' ? COLOR.alert : item.tone === 'ok' ? COLOR.ok : COLOR.body;
      doc
        .font(fonts.regular)
        .fontSize(9)
        .fillColor(COLOR.muted)
        .text(item.label, x, top + 3, { width: cellWidth * 0.58, lineBreak: false });
      doc
        .font(fonts.bold)
        .fontSize(9)
        .fillColor(tone)
        .text(item.value, x + cellWidth * 0.58, top + 3, {
          width: cellWidth * 0.42 - 8,
          lineBreak: false,
        });
    }
    doc.y = top + cellHeight;
    doc
      .moveTo(PAGE_MARGIN, doc.y - 4)
      .lineTo(doc.page.width - PAGE_MARGIN, doc.y - 4)
      .strokeColor(COLOR.rule)
      .lineWidth(0.4)
      .stroke();
  }
  doc.moveDown(0.8);
}

function drawSection(
  doc: PDFKit.PDFDocument,
  section: VinHistoryReportSection,
  fonts: PdfFonts,
): void {
  // Keep the title with at least the header row: a section heading alone at the
  // foot of a page reads as "this section is empty".
  ensureSpace(doc, 64);
  doc.font(fonts.bold).fontSize(12).fillColor(COLOR.ink).text(section.title, PAGE_MARGIN, doc.y);
  doc.moveDown(0.35);

  if (section.rows.length === 0) {
    // The section still exists. "No accident records" and "we hold no accident
    // data" are different claims, and a vanished heading makes the second one
    // look like the first.
    const width = contentWidth(doc);
    doc.fontSize(9).font(fonts.regular);
    const height = doc.heightOfString(section.emptyNote ?? '', { width: width - 20 }) + 14;
    ensureSpace(doc, height);
    const top = doc.y;
    doc.roundedRect(PAGE_MARGIN, top, width, height, 3).fillAndStroke(COLOR.headerFill, COLOR.rule);
    doc
      .font(fonts.regular)
      .fontSize(9)
      .fillColor(COLOR.muted)
      .text(section.emptyNote ?? '', PAGE_MARGIN + 10, top + 7, { width: width - 20 });
    doc.y = top + height + 14;
    doc.x = PAGE_MARGIN;
    return;
  }

  const widths = columnWidths(doc, section.id, section.columns.length);
  drawTableHead(doc, section, widths, fonts);
  for (const row of section.rows) {
    drawTableRow(doc, section, row, widths, fonts);
  }
  doc.moveDown(0.9);
  doc.x = PAGE_MARGIN;
}

const CELL_PAD = 5;

function drawTableHead(
  doc: PDFKit.PDFDocument,
  section: VinHistoryReportSection,
  widths: number[],
  fonts: PdfFonts,
): void {
  doc.font(fonts.bold).fontSize(8);
  const height =
    Math.max(
      ...section.columns.map((c, i) =>
        doc.heightOfString(c, { width: widths[i] - CELL_PAD * 2 }),
      ),
    ) +
    CELL_PAD * 2;

  ensureSpace(doc, height + 18);
  const top = doc.y;
  doc.rect(PAGE_MARGIN, top, contentWidth(doc), height).fill(COLOR.headerFill);

  let x = PAGE_MARGIN;
  section.columns.forEach((label, i) => {
    doc
      .font(fonts.bold)
      .fontSize(8)
      .fillColor(COLOR.muted)
      .text(label, x + CELL_PAD, top + CELL_PAD, { width: widths[i] - CELL_PAD * 2 });
    x += widths[i];
  });
  doc.y = top + height;
  doc.x = PAGE_MARGIN;
}

function drawTableRow(
  doc: PDFKit.PDFDocument,
  section: VinHistoryReportSection,
  row: VinHistoryReportRow,
  widths: number[],
  fonts: PdfFonts,
): void {
  doc.font(fonts.regular).fontSize(8.5);
  const cellHeights = row.cells.map((cell, i) =>
    doc.heightOfString(cell, { width: widths[i] - CELL_PAD * 2 }),
  );
  const notesText = row.notes.join(' · ');
  const notesHeight =
    notesText.length > 0
      ? doc.fontSize(7.5).heightOfString(notesText, { width: contentWidth(doc) - CELL_PAD * 2 }) + 2
      : 0;
  const height = Math.max(...cellHeights, 9) + CELL_PAD * 2 + notesHeight;

  if (doc.y + height > bottomLimit(doc)) {
    doc.addPage();
    drawTableHead(doc, section, widths, fonts);
  }

  const top = doc.y;
  if (row.flagged) {
    doc.rect(PAGE_MARGIN, top, contentWidth(doc), height).fill(COLOR.alertFill);
    doc.rect(PAGE_MARGIN, top, 2, height).fill(COLOR.alert);
  }

  let x = PAGE_MARGIN;
  row.cells.forEach((cell, i) => {
    doc
      .font(fonts.regular)
      .fontSize(8.5)
      .fillColor(row.flagged ? COLOR.alert : COLOR.body)
      .text(cell, x + CELL_PAD, top + CELL_PAD, { width: widths[i] - CELL_PAD * 2 });
    x += widths[i];
  });

  if (notesText.length > 0) {
    doc
      .font(fonts.regular)
      .fontSize(7.5)
      .fillColor(row.flagged ? COLOR.alert : COLOR.muted)
      .text(notesText, PAGE_MARGIN + CELL_PAD, top + CELL_PAD + Math.max(...cellHeights, 9), {
        width: contentWidth(doc) - CELL_PAD * 2,
      });
  }

  doc.y = top + height;
  doc.x = PAGE_MARGIN;
  doc
    .moveTo(PAGE_MARGIN, doc.y)
    .lineTo(doc.page.width - PAGE_MARGIN, doc.y)
    .strokeColor(COLOR.rule)
    .lineWidth(0.4)
    .stroke();
}

/**
 * The footer band, on EVERY page.
 *
 * Carries the VIN (pages get separated and photocopied), the page number, and —
 * when the data is generated — the synthetic mark, so no single sheet of this
 * document can circulate looking like a real vehicle history.
 */
function drawFooters(
  doc: PDFKit.PDFDocument,
  model: VinHistoryReportModel,
  fonts: PdfFonts,
): void {
  const range = doc.bufferedPageRange();

  for (let i = range.start; i < range.start + range.count; i += 1) {
    doc.switchToPage(i);
    const width = doc.page.width - PAGE_MARGIN * 2;
    const y = doc.page.height - PAGE_MARGIN - 14;

    doc
      .moveTo(PAGE_MARGIN, y - 6)
      .lineTo(doc.page.width - PAGE_MARGIN, y - 6)
      .strokeColor(COLOR.rule)
      .lineWidth(0.5)
      .stroke();

    // Three strings share one line, so the left one gives way when the
    // synthetic mark is present: the mark is the more important of the two and
    // an overlap would make both unreadable.
    const left = model.syntheticWarning ? model.vin : `${model.footerText} · ${model.vin}`;

    doc.font(fonts.regular).fontSize(7.5).fillColor(COLOR.muted);
    doc.text(left, PAGE_MARGIN, y, {
      width,
      height: FOOTER_LINE_HEIGHT,
      align: 'left',
      lineBreak: false,
    });
    doc.text(model.pageLabel(i - range.start + 1, range.count), PAGE_MARGIN, y, {
      width,
      height: FOOTER_LINE_HEIGHT,
      align: 'right',
      lineBreak: false,
    });

    // The synthetic mark rides on every single sheet, because pages get
    // separated, photocopied and forwarded on their own.
    if (model.syntheticWarning) {
      doc
        .font(fonts.bold)
        .fontSize(7.5)
        .fillColor(COLOR.alert)
        .text(model.syntheticWarning.footer, PAGE_MARGIN, y, {
          width,
          height: FOOTER_LINE_HEIGHT,
          align: 'center',
          lineBreak: false,
        });
    }
  }
}
