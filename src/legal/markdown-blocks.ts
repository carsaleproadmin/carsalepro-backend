/**
 * The contract markdown parser, shared by the HTML and PDF renderers.
 *
 * Both outputs are legal documents of the same contract, so they must not be
 * able to disagree about what the source says. Parsing once and rendering the
 * same block list twice is the only way to guarantee that; two hand-written
 * parsers would drift the first time a template used a construct one of them
 * had not been taught.
 *
 * Deliberately tiny — headings, unordered lists, paragraphs, bold and italic is
 * the entire vocabulary the contract templates use.
 */

export type InlineSpan =
  | { kind: 'text'; text: string }
  | { kind: 'bold'; text: string }
  | { kind: 'italic'; text: string };

export type MarkdownBlock =
  | { kind: 'heading'; level: 1 | 2 | 3; spans: InlineSpan[] }
  | { kind: 'paragraph'; lines: InlineSpan[][] }
  | { kind: 'list'; items: InlineSpan[][] };

/** Split a line into text / bold / italic runs. */
export function parseInline(text: string): InlineSpan[] {
  const spans: InlineSpan[] = [];
  // Bold before italic: ** must win over * at the same position.
  const pattern = /\*\*([^*]+)\*\*|\*([^*]+)\*/g;
  let cursor = 0;

  for (let m = pattern.exec(text); m !== null; m = pattern.exec(text)) {
    if (m.index > cursor) {
      spans.push({ kind: 'text', text: text.slice(cursor, m.index) });
    }
    if (m[1] !== undefined) spans.push({ kind: 'bold', text: m[1] });
    else if (m[2] !== undefined) spans.push({ kind: 'italic', text: m[2] });
    cursor = m.index + m[0].length;
  }

  if (cursor < text.length) spans.push({ kind: 'text', text: text.slice(cursor) });
  return spans.length > 0 ? spans : [{ kind: 'text', text: '' }];
}

export function parseMarkdownBlocks(md: string): MarkdownBlock[] {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const blocks: MarkdownBlock[] = [];

  let paragraph: InlineSpan[][] = [];
  let list: InlineSpan[][] = [];

  const flushParagraph = (): void => {
    if (paragraph.length > 0) {
      blocks.push({ kind: 'paragraph', lines: paragraph });
      paragraph = [];
    }
  };
  const flushList = (): void => {
    if (list.length > 0) {
      blocks.push({ kind: 'list', items: list });
      list = [];
    }
  };

  for (const raw of lines) {
    const line = raw.trimEnd();

    if (line.trim() === '') {
      flushParagraph();
      flushList();
      continue;
    }

    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      blocks.push({
        kind: 'heading',
        level: heading[1].length as 1 | 2 | 3,
        spans: parseInline(heading[2]),
      });
      continue;
    }

    const listItem = /^[-*]\s+(.*)$/.exec(line.trim());
    if (listItem) {
      flushParagraph();
      list.push(parseInline(listItem[1]));
      continue;
    }

    flushList();
    paragraph.push(parseInline(line.trim()));
  }

  flushParagraph();
  flushList();
  return blocks;
}

/** Plain text of a span list — used for PDF measurement and for tests. */
export function spansToText(spans: InlineSpan[]): string {
  return spans.map((s) => s.text).join('');
}
