import { Module } from '@nestjs/common';

import { R2Module } from '../r2/r2.module';
import { FontsController } from './fonts.controller';

/**
 * Serves the downloadable CJK PDF font packs.
 *
 * A root route with `@Public()`-equivalent reach: the global JWT guard only
 * enforces on `/api/v1`, and the mobile app authenticates with `X-Device-Id`,
 * so `/fonts/manifest` sits alongside `/catalog` and `/legal` on the legacy
 * surface. It is an additive route — the frozen mobile contract is untouched.
 */
@Module({
  imports: [R2Module],
  controllers: [FontsController],
})
export class FontsModule {}
