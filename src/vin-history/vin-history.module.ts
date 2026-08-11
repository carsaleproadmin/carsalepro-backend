import { HttpModule } from '@nestjs/axios';
import { Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../config/configuration';
import { PaymentsModule } from '../payments/payments.module';
import { R2Module } from '../r2/r2.module';
import { VinModule } from '../vin/vin.module';
import { HttpService } from '@nestjs/axios';
import { CarsxeClient } from './providers/carsxe.client';
import { CarsxeVinHistoryProvider } from './providers/carsxe-vin-history.provider';
import { MockVinHistoryProvider } from './providers/mock-vin-history.provider';
import {
  MeVinChecksController,
  PublicVinReportController,
  VinHistoryController,
} from './vin-history.controller';
import { VIN_HISTORY_PROVIDER } from './vin-history.provider';
import { VinHistoryService } from './vin-history.service';

/**
 * Paid VIN history (BE-S3).
 *
 * `PaymentsModule` is imported for `StripeService`; the reverse dependency
 * (settling a `vin_history` checkout) is resolved lazily in `PaymentsService`
 * through `ModuleRef`, exactly as it already does for `OrdersService`, so the
 * two modules never form a cycle.
 *
 * `VinModule` is imported for the FREE decode, and the direction of that import
 * is the whole point. The two modules stay separate — `VinCache.payload` is a
 * frozen mobile contract and nothing here writes to it — but the paid preview
 * now NAMES the car the visitor typed, and the decode that does it is already
 * built, already cached in Postgres and costs nothing per call. It is consumed
 * as a service. It is deliberately NOT consumed over `GET /vin/:vin`: that is a
 * legacy mobile root route on a frozen contract, and the website is not allowed
 * to depend on it.
 *
 * `HttpModule` is here for the real data provider's outbound calls.
 */
@Module({
  imports: [PaymentsModule, R2Module, VinModule, HttpModule],
  controllers: [VinHistoryController, MeVinChecksController, PublicVinReportController],
  providers: [
    VinHistoryService,
    {
      // One provider is bound per process, and deliberately NOT a per-request
      // strategy lookup: which provider produced a cached payload is recorded on
      // the row, so the choice has to be stable for the life of the process.
      //
      // Adding another is a class implementing VinHistoryProvider plus one
      // branch here. Whatever else changes, the fall-through must keep returning
      // the mock: an unknown or misspelt VIN_HISTORY_PROVIDER has to cost a 503,
      // never a crash and never a charge for data nobody fetched.
      provide: VIN_HISTORY_PROVIDER,
      inject: [ConfigService, HttpService],
      useFactory: (config: ConfigService<AppConfig, true>, http: HttpService) => {
        const { provider, allowSyntheticSale } = config.get('vinHistory', { infer: true });
        const logger = new Logger('VinHistoryModule');

        if (provider === 'carsxe') {
          const client = new CarsxeClient(http, config);
          if (!client.configured) {
            // Named but unusable. Deliberately NOT a boot failure: an operator
            // who sets the name before the key gets a service that runs and
            // refuses to sell, rather than one that will not start. `configured`
            // is false, so `POST /unlock` answers 503 and takes no money.
            logger.error(
              "VIN_HISTORY_PROVIDER='carsxe' but VIN_HISTORY_API_KEY is empty — " +
                'paid unlocks will answer 503 provider_unavailable.',
            );
          }
          return new CarsxeVinHistoryProvider(client);
        }

        if (provider && provider !== 'mock') {
          // Fail LOUD but fall back SAFE: the mock refuses paid unlocks in
          // production, so a mis-set env var costs a 503, never a charge for
          // data nobody fetched.
          logger.error(
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
