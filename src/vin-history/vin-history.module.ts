import { HttpModule } from '@nestjs/axios';
import { Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../config/configuration';
import { PaymentsModule } from '../payments/payments.module';
import { R2Module } from '../r2/r2.module';
import { VinModule } from '../vin/vin.module';
import { HttpService } from '@nestjs/axios';
import { CarapiClient } from './providers/carapi.client';
import { CarapiVinHistoryProvider } from './providers/carapi-vin-history.provider';
import { CarsxeClient } from './providers/carsxe.client';
import { CarsxeVinHistoryProvider } from './providers/carsxe-vin-history.provider';
import { CompositeVinHistoryProvider } from './providers/composite-vin-history.provider';
import { MockVinHistoryProvider } from './providers/mock-vin-history.provider';
import { ProviderResponseCache } from './provider-response.cache';
import {
  MeVinChecksController,
  PublicVinReportController,
  VinHistoryController,
} from './vin-history.controller';
import { VIN_HISTORY_PROVIDER, VinHistoryProvider } from './vin-history.provider';
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
 *
 * `ProviderResponseCache` is a plain provider rather than something built inside
 * the factory because it needs `PrismaService` and `SettingsService`, both of
 * which are `@Global()` — Nest injects them, and no branch below has to know how
 * to construct a cache.
 */
@Module({
  imports: [PaymentsModule, R2Module, VinModule, HttpModule],
  controllers: [VinHistoryController, MeVinChecksController, PublicVinReportController],
  providers: [
    VinHistoryService,
    ProviderResponseCache,
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
      inject: [ConfigService, HttpService, ProviderResponseCache],
      useFactory: (
        config: ConfigService<AppConfig, true>,
        http: HttpService,
        cache: ProviderResponseCache,
      ) => {
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

        /*
         * Several sources behind one report.
         *
         * The member list is built from whatever is CONFIGURED, so turning a
         * source on or off is an environment change and never a code change, and
         * a key that has not been issued yet simply means one fewer source
         * rather than a broken deployment. Each member is cached under its OWN
         * name (`ProviderResponseCache`), so a warm row for one source does not
         * re-pay the other.
         *
         * ⚠️ The MOCK is never a member. It would put generated records beside
         * real ones inside a single merged payload, where `synthetic` is one flag
         * for the whole report — and the merge marks a report synthetic only if
         * EVERY member was, so a mock beside a real source would be sold as
         * fully sourced. With no member configured the composite reports
         * `configured: false` and every paid unlock answers 503, which is the
         * same safe refusal the mock gives in production.
         */
        if (provider === 'aggregate') {
          const members: VinHistoryProvider[] = [];

          const carsxe = new CarsxeVinHistoryProvider(new CarsxeClient(http, config));
          if (carsxe.configured) members.push(carsxe);

          /*
           * The order of this list is the order `sources[]` is written in and
           * the order the merge resolves a single-valued section from, so the
           * most complete source belongs first.
           *
           * CarsXE leads because a US-titled car is the case where a full
           * history exists at all — a title ladder, salvage auctions, insurance
           * write-offs. CarAPI follows and is the only one of the two that
           * describes a European car: identity, a full equipment list, and for
           * some countries an odometer ladder. Neither is a superset of the
           * other, which is the whole reason both are here.
           */
          const carapi = new CarapiVinHistoryProvider(new CarapiClient(http, config));
          if (carapi.configured) members.push(carapi);

          if (members.length === 0) {
            logger.error(
              "VIN_HISTORY_PROVIDER='aggregate' but no source is configured — " +
                'paid unlocks will answer 503 provider_unavailable.',
            );
          } else {
            logger.log(
              `VIN history runs on ${members.length} source(s): ${members
                .map((m) => m.name)
                .join(', ')}`,
            );
          }

          return new CompositeVinHistoryProvider(members, cache);
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
