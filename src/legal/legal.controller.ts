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

function resolveLang(queryLang: string | undefined, acceptLanguage: string | undefined): LegalLang {
  const q = (queryLang ?? '').toLowerCase();
  if (LEGAL_LANGS.includes(q as LegalLang)) return q as LegalLang;
  const header = (acceptLanguage ?? '').toLowerCase();
  for (const lang of LEGAL_LANGS) {
    if (header.includes(lang)) return lang;
  }
  return 'de'; // Germany is the primary market.
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
