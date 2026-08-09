import { Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../config/configuration';
import { PaymentsModule } from '../payments/payments.module';
import { R2Module } from '../r2/r2.module';
import { MockVinHistoryProvider } from './providers/mock-vin-history.provider';
import { MeVinChecksController, VinHistoryController } from './vin-history.controller';
import { VIN_HISTORY_PROVIDER } from './vin-history.provider';
import { VinHistoryService } from './vin-history.service';

/**
 * Paid VIN history (BE-S3).
 *
 * Separate from `VinModule`, which is the FREE NHTSA decode and whose
 * `VinCache.payload` is a frozen mobile contract — nothing here touches it.
 *
 * `PaymentsModule` is imported for `StripeService`; the reverse dependency
 * (settling a `vin_history` checkout) is resolved lazily in `PaymentsService`
 * through `ModuleRef`, exactly as it already does for `OrdersService`, so the
 * two modules never form a cycle.
 */
@Module({
  imports: [PaymentsModule, R2Module],
  controllers: [VinHistoryController, MeVinChecksController],
  providers: [
    VinHistoryService,
    {
      // One provider is bound per process. Today only the mock exists; wiring a
      // real one is a new class implementing VinHistoryProvider plus a branch
      // here — deliberately NOT a per-request strategy lookup, because which
      // provider produced a cached payload is recorded on the row.
      provide: VIN_HISTORY_PROVIDER,
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppConfig, true>) => {
        const { provider, allowSyntheticSale } = config.get('vinHistory', { infer: true });
        if (provider && provider !== 'mock') {
          // Fail LOUD but fall back SAFE: the mock refuses paid unlocks in
          // production, so a mis-set env var costs a 503, never a charge for
          // data nobody fetched.
          new Logger('VinHistoryModule').error(
            `VIN_HISTORY_PROVIDER='${provider}' is not implemented — falling back to the mock. ` +
              'Paid unlocks will answer 503 provider_unavailable in production.',
          );
        }
        return new MockVinHistoryProvider(
          config.get('nodeEnv', { infer: true }),
          allowSyntheticSale,
        );
      },
    },
  ],
  exports: [VinHistoryService],
})
export class VinHistoryModule {}
