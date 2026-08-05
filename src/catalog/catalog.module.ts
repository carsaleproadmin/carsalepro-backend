import { Logger, Module, OnModuleInit } from '@nestjs/common';

import { CatalogController } from './catalog.controller';
import { CATALOG_V1 } from './catalog.data';
import { mergeCatalogI18n } from './catalog.i18n';

@Module({
  controllers: [CatalogController],
})
export class CatalogModule implements OnModuleInit {
  private readonly logger = new Logger(CatalogModule.name);

  /**
   * Folds the machine-translated locale sidecars into the in-memory catalog
   * once at boot, so `GET /catalog` serves all 30 languages while
   * `catalog.data.ts` keeps only the four human-authored ones.
   *
   * Merging here rather than at import time keeps the filesystem read inside
   * Nest's lifecycle: a unit test that imports `catalog.data` gets the
   * hand-authored labels and nothing else, which is what makes the
   * completeness assertions in the mobile repo meaningful.
   */
  onModuleInit(): void {
    const report = mergeCatalogI18n(CATALOG_V1);
    if (report.tags.length === 0) {
      this.logger.warn(
        'No catalog i18n sidecars found — GET /catalog will serve de/en/ru/uk only',
      );
      return;
    }
    const total = Object.values(report.applied).reduce((a, b) => a + b, 0);
    this.logger.log(
      `Catalog i18n merged: ${report.tags.length} locales, ${total} labels`,
    );
    for (const [tag, keys] of Object.entries(report.orphans)) {
      this.logger.warn(
        `catalog.${tag}.json references ${keys.length} unknown entr` +
          `${keys.length === 1 ? 'y' : 'ies'}: ${keys.slice(0, 5).join(', ')}` +
          `${keys.length > 5 ? ', …' : ''}`,
      );
    }
  }
}
