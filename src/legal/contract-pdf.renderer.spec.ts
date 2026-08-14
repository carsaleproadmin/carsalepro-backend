// Category: DOCUMENT RENDERING. Pure — no DB, no R2, no Nest container.
import { pdfPageCount, trackPageVisits, trackTextDraws } from '../../test/helpers/pdf-inspect';
import { parseInline, parseMarkdownBlocks, spansToText } from './markdown-blocks';
import { contractFontsAvailable, renderContractPdf } from './contract-pdf.renderer';

const OPTS = {
  title: 'Vermittlungsvertrag Fahrzeugprüfung',
  orderNumber: 'ORD-4711',
  locale: 'de',
  // Fixed so two renders of the same input are byte-comparable.
  renderedAt: new Date('2026-07-29T09:00:00.000Z'),
};

describe('parseMarkdownBlocks', () => {
  it('reads headings, paragraphs and lists', () => {
    const blocks = parseMarkdownBlocks(
      ['# Title', '', 'First line', 'second line', '', '- one', '- two', '', '## Section'].join('\n'),
    );
    expect(blocks.map((b) => b.kind)).toEqual([
      'heading',
      'paragraph',
      'list',
      'heading',
    ]);
    expect(blocks[1]).toMatchObject({ kind: 'paragraph' });
    expect((blocks[1] as { lines: unknown[] }).lines).toHaveLength(2);
    expect((blocks[2] as { items: unknown[] }).items).toHaveLength(2);
  });

  it('normalises CRLF', () => {
    expect(parseMarkdownBlocks('# A\r\n\r\nB\r\n')).toHaveLength(2);
  });

  it('closes a list when a paragraph follows without a blank line', () => {
    const blocks = parseMarkdownBlocks('- one\ntext after');
    expect(blocks.map((b) => b.kind)).toEqual(['list', 'paragraph']);
  });
});

describe('parseInline', () => {
  it('splits bold and italic runs', () => {
    expect(parseInline('a **b** c *d*')).toEqual([
      { kind: 'text', text: 'a ' },
      { kind: 'bold', text: 'b' },
      { kind: 'text', text: ' c ' },
      { kind: 'italic', text: 'd' },
    ]);
  });

  it('prefers bold over italic at the same position', () => {
    expect(parseInline('**x**')).toEqual([{ kind: 'bold', text: 'x' }]);
  });

  it('round-trips to the original text', () => {
    const src = 'Der **Auftraggeber** zahlt *sofort* 129,99 €.';
    expect(spansToText(parseInline(src))).toBe('Der Auftraggeber zahlt sofort 129,99 €.');
  });

  it('never returns an empty span list', () => {
    expect(parseInline('')).toEqual([{ kind: 'text', text: '' }]);
  });
});

describe('renderContractPdf', () => {
  const markdown = [
    '# Vermittlungsvertrag',
    '',
    'Zwischen **CarSalePro** und dem Auftraggeber wird Folgendes vereinbart.',
    '',
    '## 1. Leistungen',
    '',
    '- Vermittlung einer Fahrzeugprüfung',
    '- Abwicklung der Zahlung über Stripe',
    '',
    'Gesamtbetrag: 129,99 €.',
  ].join('\n');

  it('ships the embedded Unicode fonts', () => {
    // Not a nice-to-have: pdfkit's built-in Helvetica is WinAnsi, and the
    // contract interpolates party names from a platform with a Russian locale.
    expect(contractFontsAvailable()).toBe(true);
  });

  it('produces a PDF', async () => {
    const pdf = await renderContractPdf(markdown, OPTS);
    expect(pdf.subarray(0, 5).toString('ascii')).toBe('%PDF-');
    expect(pdf.length).toBeGreaterThan(1024);
  });

  it('is deterministic for identical input', async () => {
    const [a, b] = await Promise.all([
      renderContractPdf(markdown, OPTS),
      renderContractPdf(markdown, OPTS),
    ]);
    expect(a.equals(b)).toBe(true);
  });

  it('handles German umlauts and Cyrillic party names without throwing', async () => {
    const withNames = markdown.replace(
      'dem Auftraggeber',
      'Иван Петров (Straße 1, Köln, Österreich)',
    );
    const pdf = await renderContractPdf(withNames, OPTS);
    expect(pdf.subarray(0, 5).toString('ascii')).toBe('%PDF-');
  });

  it('paginates a long contract and still terminates', async () => {
    const long = Array.from({ length: 400 }, (_, i) => `Absatz ${i + 1}. Ein Satz Text.`).join(
      '\n\n',
    );
    const pdf = await renderContractPdf(long, OPTS);
    expect(pdf.length).toBeGreaterThan(5000);
  });

  it('renders an empty document rather than rejecting', async () => {
    const pdf = await renderContractPdf('', OPTS);
    expect(pdf.subarray(0, 5).toString('ascii')).toBe('%PDF-');
  });

  /*
   * Two footer bugs lived here behind a test that only measured file size.
   *
   *  1. The document was created WITHOUT `bufferPages`, so pdfkit flushed each
   *     page as the next one opened and `bufferedPageRange()` reported the one
   *     page still in memory. Every multi-page contract got a single footer, on
   *     the last page, reading "1 / 1".
   *  2. Each footer `text` call carried a `width` and sat below the bottom
   *     margin, so pdfkit's line wrapper appended a fresh page for it —
   *     `lineBreak: false` does not stop that. A seven-page contract shipped as
   *     twenty-one pages, fourteen of them blank.
   *
   * Neither changed the file size in a way an assertion would notice, so both
   * are pinned structurally instead.
   */
  const longContract = Array.from(
    { length: 200 },
    (_, i) => `Absatz ${i + 1}. Ein Satz Text zur Fahrzeugprüfung.`,
  ).join('\n\n');

  it('footers every page of a multi-page contract, not just the last', async () => {
    const tracker = trackPageVisits();
    try {
      const pdf = await renderContractPdf(longContract, OPTS);
      const pages = pdfPageCount(pdf);
      expect(pages).toBeGreaterThan(1);
      // One visit per page, in order — the page numbering is drawn against the
      // real total, so "3 / 7" is possible at all.
      expect(tracker.visited()).toEqual(Array.from({ length: pages }, (_, i) => i));
    } finally {
      tracker.restore();
    }
  });

  it('does not append a blank page for every footer it draws', async () => {
    const pdf = await renderContractPdf(longContract, OPTS);
    // 200 one-line paragraphs are ~7 A4 pages. Three times that is the wrapper
    // paginating the footer itself.
    expect(pdfPageCount(pdf)).toBeLessThan(12);
  });

  /*
   * A heading is never the last thing on a page.
   *
   * pdfkit breaks a page when the block being drawn does not fit, and a heading
   * is one line, so it fits almost anywhere — "3. Scope of the inspection" sat
   * alone at the foot of page 1 of the English contract while the terms it
   * introduces started on page 2. A reader takes that as an empty section.
   *
   * The drawn glyphs cannot be read back out of the file, so these assert the
   * cursor position at the moment the heading was drawn. `PAGE_MARGIN` is 56.
   */
  const TOP_OF_PAGE = 100;
  /**
   * A4 is 841.89 pt tall and the bottom margin leaves `maxY` at 761.89. A
   * heading plus the two body lines reserved under it is about 45 pt, so a
   * heading drawn below this has nothing readable following it on the page.
   */
  const LOWEST_LEGAL_HEADING_Y = 715;

  it('never strands a heading at the foot of a page', async () => {
    /*
     * Sections of uneven length, so headings land at every distance from the
     * page foot rather than at one contrived offset. Fixing a single filler
     * height to land exactly at the bottom would pin the arithmetic of THIS
     * page geometry instead of the property.
     */
    const letters = 'ABCDEFGHIJKLMNOPQRSTUVWX'.split('');
    const sections = letters
      .map((letter, i) => {
        const body = Array.from({ length: (i % 5) + 1 }, (_, j) => `Satz ${j + 1} hier.`).join(
          '\n\n',
        );
        return `## Kapitel ${letter}\n\n${body}`;
      })
      .join('\n\n');

    const tracker = trackTextDraws();
    try {
      await renderContractPdf(sections, OPTS);
      const headingYs = letters.map((letter) => tracker.drawnAt(`Kapitel ${letter}`)).flat();

      expect(headingYs).toHaveLength(letters.length);
      expect(Math.max(...headingYs)).toBeLessThanOrEqual(LOWEST_LEGAL_HEADING_Y);
    } finally {
      tracker.restore();
    }
  });

  it('leaves a heading where it is when the section fits under it', async () => {
    const tracker = trackTextDraws();
    try {
      await renderContractPdf(
        ['# Vertrag', '', 'Ein Satz.', '', '## 1. Leistungen', '', 'Ein weiterer Satz.'].join('\n'),
        OPTS,
      );
      const [y] = tracker.drawnAt('1. Leistungen');
      // Well down the first page: a break here would be a page-per-heading bug.
      expect(y).toBeGreaterThan(TOP_OF_PAGE);
    } finally {
      tracker.restore();
    }
  });

  it('does not paginate per heading', async () => {
    const manyHeadings = Array.from(
      { length: 12 },
      (_, i) => `## ${i + 1}. Abschnitt\n\nEin kurzer Satz.`,
    ).join('\n\n');
    const pdf = await renderContractPdf(manyHeadings, OPTS);
    expect(pdfPageCount(pdf)).toBeLessThanOrEqual(2);
  });
});
