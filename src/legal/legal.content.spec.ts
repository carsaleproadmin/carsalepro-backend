import {
  getLegalContent,
  legalLastUpdated,
  LEGAL_LANGS,
  renderLegalHtml,
} from './legal.content';

/**
 * The legal documents, and one assertion that should have existed from the day
 * they were written.
 *
 * `[COMPANY NAME]`, `[COMPANY ADDRESS]` and `[CONTACT EMAIL]` were interpolated
 * into the controller paragraph and the intro of both documents, in all three
 * languages, from 2026-06 to 2026-08-19. Nothing failed: no build, no test, no
 * `/health` probe. A store reviewer opening the privacy policy would have read a
 * square bracket where the data controller has to be named — GDPR Art. 13 for
 * the policy, §5 DDG for the Impressum.
 *
 * The guard is a placeholder scan rather than a check for the three known
 * strings, because the next placeholder will not be one of those three.
 */
describe('legal content', () => {
  const docs = ['privacy', 'terms'] as const;

  /** Every string a reader can see, flattened. */
  function visibleText(doc: (typeof docs)[number], lang: (typeof LEGAL_LANGS)[number]) {
    const content = getLegalContent(doc, lang);
    return [
      content.title,
      content.lastUpdatedLabel,
      content.intro,
      ...content.sections.flatMap((s) => [s.heading, ...s.paragraphs]),
    ];
  }

  it('carries no unfilled placeholder, in any document or language', () => {
    const offences: string[] = [];
    for (const doc of docs) {
      for (const lang of LEGAL_LANGS) {
        for (const text of visibleText(doc, lang)) {
          // A bracket pair is how every placeholder in this file was written,
          // and it appears in no legitimate sentence in any of the three
          // languages. `[` alone would false-positive on nothing today, but the
          // pair is what makes the intent unambiguous to a later reader.
          const match = /\[[^\]]*\]/.exec(text);
          if (match) offences.push(`${doc}/${lang}: ${match[0]}`);
        }
      }
    }
    expect(offences).toEqual([]);
  });

  it('names the controller and a contact address in every language', () => {
    // The positive half. A scan for brackets passes just as happily if somebody
    // deletes the sentence instead of filling it in.
    for (const lang of LEGAL_LANGS) {
      const blob = visibleText('privacy', lang).join(' ');
      expect(blob).toContain('CarSalePro LLC');
      expect(blob).toContain('Cheyenne');
      expect(blob).toMatch(/[^\s@]+@[^\s@]+\.[^\s@]+/);
    }
  });

  it('renders every document in every language without throwing', () => {
    for (const doc of docs) {
      for (const lang of LEGAL_LANGS) {
        const html = renderLegalHtml(getLegalContent(doc, lang), lang);
        expect(html).toContain('<html');
        expect(html).toContain(legalLastUpdated());
        expect(html.length).toBeGreaterThan(1000);
      }
    }
  });
});
