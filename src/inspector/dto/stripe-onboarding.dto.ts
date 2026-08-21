import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString, Length } from 'class-validator';
import { STRIPE_BUSINESS_TYPES, type StripeBusinessType } from '../../payments/stripe.service';

/**
 * Body of `POST /inspector/stripe-onboarding`. Both keys are optional, and an
 * empty body is a legitimate request: it means "use what you already know about
 * me", which is how the website called this route before either field existed.
 */
export class StartStripeOnboardingDto {
  @ApiPropertyOptional({
    example: 'PL',
    description:
      'ISO 3166-1 alpha-2 country the payout account belongs to, upper case. ' +
      'Defaults to the stored country, then to the platform country. ' +
      'Stripe fixes an account country at creation, so once onboarding has started ' +
      'a different value is refused with `connect_country_locked` rather than ignored.',
  })
  @IsOptional()
  @IsString()
  @Length(2, 2)
  /*
   * Shape only — a two-letter code. Which countries Stripe supports is not
   * enumerated here on purpose: a hardcoded roster would refuse a country the
   * day Stripe adds it, and go stale unnoticed the day one is dropped. Stripe's
   * own rejection is mapped onto `connect_country_unsupported`, which names the
   * country back to the inspector.
   */
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  country?: string;

  @ApiPropertyOptional({
    enum: STRIPE_BUSINESS_TYPES,
    example: 'company',
    description:
      'Legal form of the payout account. OMIT it to let Stripe Express ask during ' +
      'onboarding — that is the default and, for an applicant who is unsure, the right answer. ' +
      'Was hardcoded to `individual` until 2026-08-19, which is why no company could be onboarded.',
  })
  @IsOptional()
  @IsIn(STRIPE_BUSINESS_TYPES)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  businessType?: StripeBusinessType;
}
