import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional } from 'class-validator';

/**
 * The body of `POST /applications/:id/submit` (DEN-364).
 *
 * THE CHECK IS NOT IN THIS FILE, AND THAT IS THE POINT. The field is optional
 * here and mandatory in `KycService.submitApplication`, which refuses anything
 * but `true` with the named code `terms_not_accepted`. Two reasons:
 *
 * - A `@Equals(true)` here answers with the validation pipe's generic shape, so
 *   the one refusal a client has to tell apart from "your documents are
 *   incomplete" would arrive without a code to test.
 * - The route took no body at all until now. An older website build posts
 *   nothing, and a required field would turn that into a validation error
 *   before the service is reached - the same refusal, worded as if the request
 *   were malformed.
 *
 * The website also holds the submit button disabled until the box is ticked.
 * That is a second line and not the control: this is an ordinary authorised
 * route and answers a plain POST from anywhere, so a check that lived only in
 * the browser would be missing exactly for the caller who went round it.
 */
export class SubmitKycApplicationDto {
  @ApiPropertyOptional({
    example: true,
    description:
      'The applicant confirms the framework terms: the inspector works as an independent ' +
      'contractor and carries the liability for the inspection and its report. Anything but ' +
      'true is refused with `terms_not_accepted`.',
  })
  @IsOptional()
  @IsBoolean()
  termsAccepted?: boolean;
}
