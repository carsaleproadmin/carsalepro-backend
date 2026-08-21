import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches } from 'class-validator';
import { REPORT_CODE_PATTERN } from '../../public/dto/report-lookup.dto';

export class CreatePpvDto {
  @ApiProperty({
    example: 'CSP-179932ec-2a51-4b3f-9a7e-2b3c4d5e6f70',
    description:
      'Report code to purchase pay-per-view access to. Both forms are accepted: ' +
      'the current CSP-<uuid v4> and the legacy sequential CSP-###.',
  })
  @IsString()
  /*
   * DEN-161. This used to be `/^CSP-\d{1,6}$/` — the sequential form ALONE,
   * while the mobile app has written `CSP-<uuid v4>` codes for a long time and
   * every other surface (report creation, listing claim, order attach, the
   * public lookups) accepts both. So the one endpoint that takes money for a
   * report refused every report anybody actually has, with a 400 the buyer saw
   * as a button that does nothing.
   *
   * Imported rather than copied a fifth time: this pattern drifting is exactly
   * what produced the defect.
   */
  @Matches(REPORT_CODE_PATTERN)
  reportCode!: string;
}
