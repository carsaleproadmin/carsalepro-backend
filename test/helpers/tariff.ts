import { INestApplication } from '@nestjs/common';
import { PrismaService } from '../../src/prisma/prisma.service';
import { SettingsService } from '../../src/settings/settings.service';
import {
  PLATFORM_SETTING_DEFAULTS,
  SettingKey,
} from '../../src/settings/platform-settings.constants';

/**
 * Pin the order tariff for a suite, and put it back afterwards.
 *
 * Suites used to assert hardcoded totals against whatever the seed happened to
 * leave in the shared database. That coupled them to each other: the admin
 * settings suite PATCHes `orderBaseFeeEur` as part of an acceptance test and
 * does not restore it, so every suite that ran afterwards priced against a
 * different base and only passed by coincidence. Pin what you assert.
 */

/** Keys that participate in a quote. Anything here is saved and restored. */
const TARIFF_KEYS: SettingKey[] = [
  'orderBaseFeeEur',
  'orderRatePerKmEur',
  'orderRatePerMinuteEur',
  'orderMinimumFareEur',
  'orderSurgeMultiplier',
  'orderPeakMultiplier',
  'orderPeakStartHour',
  'orderPeakEndHour',
  'orderDetourFactor',
  'orderReturnTripFactor',
  'orderFreeRadiusKm',
  'orderCapKm',
  'platformFeePercent',
  'expertSearchRadiusKm',
];

export interface PinnedTariff {
  /** Restore whatever was there before `pinTariff` ran. */
  restore(): Promise<void>;
}

/**
 * @param overrides values to force for the duration of the suite. Anything not
 *   overridden is reset to the shipped default, so a leaked value from another
 *   suite cannot change the answer.
 */
export async function pinTariff(
  app: INestApplication,
  overrides: Partial<Record<SettingKey, number>> = {},
): Promise<PinnedTariff> {
  const prisma = app.get(PrismaService);
  const settings = app.get(SettingsService);

  const previous = new Map<SettingKey, number | undefined>();
  for (const key of TARIFF_KEYS) {
    const row = await prisma.platformSetting.findUnique({ where: { key } });
    previous.set(key, row ? Number(row.value) : undefined);

    const value = overrides[key] ?? PLATFORM_SETTING_DEFAULTS[key];
    await prisma.platformSetting.upsert({
      where: { key },
      create: { key, value },
      update: { value },
    });
  }
  settings.invalidate();

  return {
    async restore(): Promise<void> {
      for (const [key, value] of previous) {
        if (value === undefined) {
          await prisma.platformSetting.deleteMany({ where: { key } });
        } else {
          await prisma.platformSetting.updateMany({ where: { key }, data: { value } });
        }
      }
      settings.invalidate();
    },
  };
}

/**
 * What a quote costs when the inspector sits at the order location.
 *
 * Distance is 0, and RoutingService floors travel time at one minute — which
 * the return-trip factor then bills twice, so the fare is base + two minutes.
 * That lands under the minimum fare and is floored to it. Expressed as a
 * computation rather than a literal so the suites stay correct if a default is
 * ever retuned.
 */
export function colocatedQuote(overrides: Partial<Record<SettingKey, number>> = {}) {
  const get = (key: SettingKey) => overrides[key] ?? PLATFORM_SETTING_DEFAULTS[key];
  const cents = (key: SettingKey) => Math.round(get(key) * 100);

  const baseFeeCents = cents('orderBaseFeeEur');
  const timeFeeCents = Math.round(
    cents('orderRatePerMinuteEur') * Math.max(1, get('orderReturnTripFactor')),
  );
  const subtotalCents = baseFeeCents + timeFeeCents;
  const totalCents = Math.max(subtotalCents, cents('orderMinimumFareEur'));
  const platformFeeCents = Math.round((totalCents * get('platformFeePercent')) / 100);

  return {
    baseFeeCents,
    distanceFeeCents: 0,
    timeFeeCents,
    subtotalCents,
    totalCents,
    platformFeeCents,
    inspectorShareCents: totalCents - platformFeeCents,
  };
}
