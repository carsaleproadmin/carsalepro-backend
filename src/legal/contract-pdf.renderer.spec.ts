// Category: DOCUMENT RENDERING. Pure — no DB, no R2, no Nest container.
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
});
