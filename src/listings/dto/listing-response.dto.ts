import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ListingVehicleDto {
  @ApiProperty({ example: 'BMW', nullable: true })
  make!: string | null;

  @ApiProperty({ example: '320d', nullable: true })
  model!: string | null;

  @ApiProperty({ example: 2018, nullable: true })
  year!: number | null;

  @ApiProperty({ example: 120000, nullable: true })
  mileageKm!: number | null;
}

export class MyListingItemDto {
  @ApiProperty({ example: 'ckqz2zk5e0000a8b8h4t8j2z3' })
  id!: string;

  @ApiProperty({ example: 'DRAFT' })
  status!: string;

  @ApiProperty({
    example: 'report',
    enum: ['report', 'manual'],
    description:
      '"report" = backed by an inspection (verified). "manual" = seller-declared, no inspection.',
  })
  source!: string;

  @ApiProperty({ example: 'standard' })
  package!: string;

  @ApiProperty({ example: 1850000 })
  priceCents!: number;

  @ApiProperty({ example: 'Berlin' })
  city!: string;

  @ApiProperty({ example: '10115', nullable: true })
  plz!: string | null;

  @ApiProperty({ example: 'One owner, full service history.', nullable: true })
  description!: string | null;

  @ApiProperty({ type: ListingVehicleDto })
  vehicle!: ListingVehicleDto;

  @ApiProperty({ example: 'CSP-042', nullable: true, description: 'Null for a manual listing.' })
  reportCode!: string | null;

  @ApiProperty({ example: 3, description: 'Photos in the seller gallery (manual listings).' })
  photoCount!: number;

  @ApiProperty({ example: '2026-06-13T10:00:00.000Z', nullable: true })
  publishedAt!: string | null;

  @ApiProperty({ example: '2026-07-13T10:00:00.000Z', nullable: true })
  expiresAt!: string | null;

  @ApiProperty({ example: 0 })
  viewsCount!: number;
}

export class MyListingsListDto {
  @ApiProperty({ type: [MyListingItemDto] })
  items!: MyListingItemDto[];
}

export class ListingPackageDto {
  @ApiProperty({ example: 'gold', enum: ['standard', 'gold'] })
  package!: 'standard' | 'gold';

  @ApiProperty({ example: 999, description: 'Integer cents. 0 means free.' })
  amountCents!: number;

  @ApiProperty({ example: 'EUR' })
  currency!: string;

  @ApiProperty({ example: 30 })
  durationDays!: number;
}

/**
 * Package prices, so the seller-facing picker renders live tariffs instead of
 * copy baked into the translation files.
 */
export class ListingPackagesDto {
  @ApiProperty({ type: [ListingPackageDto] })
  items!: ListingPackageDto[];
}

export class PublishResultDto {
  @ApiPropertyOptional({ example: 'ACTIVE' })
  status?: string;

  @ApiPropertyOptional({ example: 999, description: 'What this publish charged, in cents.' })
  amountCents?: number;

  @ApiPropertyOptional({ example: 'EUR' })
  currency?: string;

  @ApiPropertyOptional({ example: '2026-07-13T10:00:00.000Z' })
  expiresAt?: string;

  @ApiPropertyOptional({
    example: 'https://checkout.stripe.com/c/pay/cs_test_...',
    description: 'Present for a Gold checkout — redirect the seller here.',
  })
  checkoutUrl?: string;

  @ApiPropertyOptional({
    example: true,
    description: 'True when Stripe is unconfigured and the Gold upgrade was auto-activated (mock mode).',
  })
  mock?: boolean;
}
