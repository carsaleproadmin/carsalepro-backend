import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsEmail,
  IsInt,
  IsLatitude,
  IsLongitude,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';

/** Upsert the caller's inspector profile (all fields optional / additive). */
export class UpdateInspectorProfileDto {
  @ApiPropertyOptional({ example: 'KFZ Müller GmbH' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  companyName?: string;

  @ApiPropertyOptional({ example: 'Musterstraße 1, 10115 Berlin' })
  @IsOptional()
  @IsString()
  @MaxLength(240)
  baseAddress?: string;

  @ApiPropertyOptional({ example: 'DE123456789', description: 'Tax identification number (DAC7).' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  taxId?: string;

  @ApiPropertyOptional({ example: 'DE999999999', description: 'VAT identification number (DAC7).' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  vatId?: string;

  @ApiPropertyOptional({
    example: '+491761234567',
    description:
      'Work phone shown to the customer once an order is completed. Include the country code: ' +
      'a number without a leading "+" stays usable for tel: but earns no WhatsApp link, ' +
      'because there is no country to assume for an international platform.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  contactPhone?: string;

  @ApiPropertyOptional({
    example: 'kontakt@kfz-mueller.de',
    description: 'Work email shown to the customer. Falls back to the account address when unset.',
  })
  @IsOptional()
  /*
   * An empty string is the CLEAR instruction, and must not be validated as an
   * address. The other three channels accept it for free (`@IsString`), and the
   * service already reads blank as "store null" — `@IsEmail` alone made this one
   * field disagree, so a form that sends all four back on every save (which the
   * website's profile form does) was answered 400 and could not be saved at all.
   */
  @ValidateIf((dto: UpdateInspectorProfileDto) => dto.contactEmail !== '')
  @IsEmail()
  @MaxLength(160)
  contactEmail?: string;

  @ApiPropertyOptional({
    example: true,
    description: 'True when the work phone is reachable on WhatsApp.',
  })
  @IsOptional()
  @IsBoolean()
  contactWhatsapp?: boolean;

  @ApiPropertyOptional({
    example: '@kfz_mueller',
    description:
      'Telegram username. "@name", "name", "t.me/name" and a full URL are all accepted; ' +
      'the bare username is stored. Telegram has no reliable public link to a chat by phone ' +
      'number, which is why this is its own field and not a flag on the phone.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  contactTelegram?: string;

  @ApiPropertyOptional({ example: 52.52, description: 'Base latitude (WGS84).' })
  @IsOptional()
  @IsLatitude()
  lat?: number;

  @ApiPropertyOptional({ example: 13.405, description: 'Base longitude (WGS84).' })
  @IsOptional()
  @IsLongitude()
  lng?: number;

  @ApiPropertyOptional({ example: 50, minimum: 1, maximum: 500 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(500)
  searchRadiusKm?: number;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  available?: boolean;

  /**
   * What this inspector charges as the base fee, in CENTS (DEN-213).
   *
   * `null` clears it and returns the inspector to the platform base - which is
   * a different statement from "0", and the reason this is nullable rather than
   * defaulted.
   *
   * The BOUND is not here. It depends on the platform base, which is a runtime
   * setting and may differ by region, so it is checked in the service where
   * that number is known; a decorator would have to hardcode today's 39 EUR.
   */
  @ApiPropertyOptional({ example: 4500, nullable: true, description: 'Base fee in cents.' })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsInt()
  @Min(0)
  baseFeeCents?: number | null;
}
