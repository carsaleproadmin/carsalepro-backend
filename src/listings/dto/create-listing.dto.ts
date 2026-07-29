import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches, MaxLength } from 'class-validator';

/**
 * Accepts both report-code forms. The pattern previously only allowed the
 * legacy sequential codes, which silently rejected every `CSP-<uuid v4>` code
 * the current mobile app produces — i.e. every recent report could not be
 * listed at all.
 *
 * The legacy branch stays at 12 digits rather than the reports DTO's 6: accepting
 * a code that cannot exist is not a vulnerability, and narrowing it would break
 * fixtures that generate longer numeric codes.
 */
export class CreateListingDto {
  @ApiProperty({
    example: 'CSP-042',
    description:
      'Report code to claim. Either the legacy CSP-### form or CSP-<uuid v4>. ' +
      'Claiming is single-use and irreversible.',
  })
  @IsString()
  @MaxLength(48)
  @Matches(
    /^CSP-(\d{1,12}|[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i,
  )
  reportCode!: string;
}
