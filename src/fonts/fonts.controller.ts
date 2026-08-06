import { Controller, Get, Header, Logger, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';

import { R2Service } from '../r2/r2.service';
import { FONT_MANIFEST, FontPackFile } from './fonts.manifest';

interface FontManifestEntry {
  name: string;
  pack: string;
  url: string;
  sha256: string;
  bytes: number;
}

interface FontManifestResponse {
  files: FontManifestEntry[];
}

/**
 * Where the mobile app gets its CJK PDF fonts.
 *
 * `package:pdf` embeds its own fonts and cannot use the platform's, so a
 * Chinese, Japanese or Korean report needs a real ~10 MB file. Bundling all
 * four faces would add ~33 MB to an app most of whose users never generate one,
 * so they live in the reports bucket and are fetched once, on demand.
 *
 * The URLs are presigned and short-lived; the app caches the bytes, not the URL.
 */
@ApiTags('fonts')
@Controller('fonts')
export class FontsController {
  private readonly logger = new Logger(FontsController.name);

  constructor(private readonly r2: R2Service) {}

  @Get('manifest')
  // Short cache: the URLs expire, so a long-lived cached manifest would hand
  // clients links that 403. The FILES are immutable and cached on the device.
  @Header('Cache-Control', 'public, max-age=300')
  @ApiOperation({
    summary: 'Downloadable PDF font packs (CJK), with presigned URLs and digests',
    description:
      'The app fetches a pack the first time it generates a report in Chinese, ' +
      'Japanese or Korean, verifies each file against its SHA-256 and caches it. ' +
      'The digest is not optional: a truncated TrueType file does not throw when ' +
      'parsed, it produces a font with zero glyph metrics, and the report renders ' +
      'with invisible text.',
  })
  @ApiQuery({
    name: 'pack',
    required: false,
    description: 'Limit to one pack id (noto-sans-sc | noto-sans-kr).',
  })
  @ApiOkResponse({ description: 'Font files with presigned download URLs.' })
  async manifest(@Query('pack') pack?: string): Promise<FontManifestResponse> {
    const wanted: FontPackFile[] = pack
      ? FONT_MANIFEST.filter((f) => f.pack === pack)
      : FONT_MANIFEST;

    const files: FontManifestEntry[] = [];
    for (const file of wanted) {
      try {
        const { url } = await this.r2.createPresignedDownloadUrl(file.key);
        files.push({
          name: file.name,
          pack: file.pack,
          url,
          sha256: file.sha256,
          bytes: file.bytes,
        });
      } catch (e) {
        // One unsigned file must not take the whole manifest down: the app can
        // still fetch the other pack, and a partial manifest surfaces as a
        // FontPackUnavailable with a name in it rather than an opaque 500.
        this.logger.error(
          `Could not presign ${file.key}: ${(e as Error).message}`,
        );
      }
    }

    return { files };
  }
}
