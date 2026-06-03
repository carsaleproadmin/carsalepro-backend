import { Controller, Get, Header, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { CATALOG_V1, CATALOG_VERSION, CatalogV1 } from './catalog.data';

interface CatalogUpToDate {
  version: string;
  upToDate: true;
}

@ApiTags('catalog')
@Controller('catalog')
export class CatalogController {
  @Get()
  @Header('Cache-Control', 'public, max-age=86400')
  @ApiOperation({
    summary: 'Versioned reference catalog (angles, parts, damage types, K/S/T codes, 98-item checklist)',
    description:
      'The mobile app bundles its own copy of this catalog and treats it as the source of truth. ' +
      'It calls this endpoint opportunistically (non-blocking) to pick up newer reference data without ' +
      'an app release. Pass ?version=<current> — if it matches, the server replies { upToDate: true } ' +
      'instead of the full payload.',
  })
  @ApiQuery({ name: 'version', required: false, description: 'Version the client already has bundled.' })
  @ApiOkResponse({ description: 'Full catalog, or { version, upToDate: true } when the client is current.' })
  get(@Query('version') version?: string): CatalogV1 | CatalogUpToDate {
    if (version && version === CATALOG_VERSION) {
      return { version: CATALOG_VERSION, upToDate: true };
    }
    return CATALOG_V1;
  }
}
