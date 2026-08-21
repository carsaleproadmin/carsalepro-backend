import { Controller, Get, Header, Param, Query, Req } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import {
  getLegalContent,
  legalLastUpdated,
  LEGAL_LANGS,
  LegalLang,
  renderLegalHtml,
} from './legal.content';

/**
 * Which of the three languages to serve.
 *
 * **The fallback is `en`, not `de`, and that changed on 2026-08-19.** It used to
 * return German for anything it did not recognise, and the mobile app sends the
 * raw language code of whichever of its 35 languages the inspector picked — so a
 * Greek user requesting `?lang=el` matched neither the document list nor the
 * Accept-Language header and was served German. Thirty-one of thirty-five
 * locales read this policy in a language they had not chosen.
 *
 * The app's own documented rule for a destination that does not speak the
 * user's language is English, on the stated grounds that an unreadable page in
 * a language the user did not pick is worse than the lingua franca
 * (`external_links.dart`). This is that rule, on the other side of the wire, so
 * the two can no longer disagree.
 *
 * German is still first choice where the CALLER asks for it or the browser
 * prefers it, which is every German visitor.
 */
function resolveLang(queryLang: string | undefined, acceptLanguage: string | undefined): LegalLang {
  const q = (queryLang ?? '').toLowerCase();
  if (LEGAL_LANGS.includes(q as LegalLang)) return q as LegalLang;
  const header = (acceptLanguage ?? '').toLowerCase();
  for (const lang of LEGAL_LANGS) {
    if (header.includes(lang)) return lang;
  }
  return 'en';
}

@ApiTags('legal')
@Controller('legal')
export class LegalController {
  @Get()
  @ApiOperation({ summary: 'Index of canonical legal-document URLs (JSON)' })
  @ApiOkResponse({
    schema: {
      example: {
        privacy: { de: '/legal/privacy?lang=de', en: '/legal/privacy?lang=en', ru: '/legal/privacy?lang=ru' },
        terms: { de: '/legal/terms?lang=de', en: '/legal/terms?lang=en', ru: '/legal/terms?lang=ru' },
        updatedAt: '2026-06-03',
      },
    },
  })
  index(): Record<string, unknown> {
    const build = (doc: 'privacy' | 'terms'): Record<LegalLang, string> =>
      LEGAL_LANGS.reduce(
        (acc, lang) => {
          acc[lang] = `/legal/${doc}?lang=${lang}`;
          return acc;
        },
        {} as Record<LegalLang, string>,
      );
    return { privacy: build('privacy'), terms: build('terms'), updatedAt: legalLastUpdated() };
  }

  @Get(':doc')
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Cache-Control', 'public, max-age=3600')
  @ApiOperation({ summary: 'Privacy Policy or Terms of Use as localized HTML' })
  @ApiParam({ name: 'doc', enum: ['privacy', 'terms'] })
  @ApiQuery({ name: 'lang', enum: ['de', 'en', 'ru'], required: false })
  document(
    @Param('doc') doc: string,
    @Query('lang') lang: string | undefined,
    @Req() req: Request,
  ): string {
    const docType = doc === 'terms' ? 'terms' : 'privacy';
    const resolved = resolveLang(lang, req.headers['accept-language']);
    return renderLegalHtml(getLegalContent(docType, resolved), resolved);
  }
}
