import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsNotEmpty, IsString, MaxLength, Min } from 'class-validator';
import { Transform } from 'class-transformer';

/**
 * What an inspector asks for an order the search could not give them
 * (DEN-344).
 *
 * The real bounds are not here. The ceiling depends on how far THIS inspector
 * is from THIS car and on their own base fee, so it is computed by the service
 * and refused with `counter_offer_price_invalid`, which names the maximum. What
 * this class checks is the shape: a positive whole number of cents, and a
 * reason a person actually typed.
 */
export class CreateCounterOfferDto {
  /**
   * What the inspector is PAID, not what the customer pays (DEN-344). The
   * customer's sum is derived from it, and the platform fee is the difference,
   * so the figure typed here is the figure that reaches the inspector exactly.
   */
  @ApiProperty({ example: 4160, description: 'What the inspector is paid, in cents' })
  @IsInt()
  @Min(1)
  payoutCents!: number;

  /**
   * Mandatory, and mandatory on purpose: the customer is being asked to pay
   * more than they were quoted, and a bare number reads as haggling. "38 km
   * instead of 12" reads as a reason. It is shown to the customer verbatim, so
   * it is trimmed rather than left with the whitespace of a paste.
   */
  @ApiProperty({ example: 'The car is 38 km from me, the order is priced for 12 km.' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  reason!: string;
}
