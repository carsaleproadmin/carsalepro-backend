import { Module } from '@nestjs/common';
import { PhotoProcessingService } from './photo-processing.service';

/**
 * Server-side image compression, shared by every feature that accepts an upload.
 *
 * It used to live in `ReportsModule`, and `ListingsModule` reached across for
 * the provider class directly. That worked only because the service has no
 * dependencies of its own — the moment KYC needed it too, the choice was to
 * import all of `ReportsModule` (dragging in the whole legacy mobile report
 * surface, quota included, for a sharp wrapper) or to give it its own module.
 *
 * The sharp concurrency semaphore inside the service is per-INSTANCE, so this
 * module must stay the single provider of it: three modules each declaring
 * `PhotoProcessingService` in `providers` would give three independent
 * semaphores and three times the intended peak memory.
 */
@Module({
  providers: [PhotoProcessingService],
  exports: [PhotoProcessingService],
})
export class PhotoModule {}
