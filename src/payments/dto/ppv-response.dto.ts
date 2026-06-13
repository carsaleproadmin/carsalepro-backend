import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class PpvCheckoutResponseDto {
  @ApiPropertyOptional({
    example: 'https://checkout.stripe.com/c/pay/cs_test_...',
    description: 'URL to redirect the buyer to. Present unless alreadyOwned.',
  })
  checkoutUrl?: string;

  @ApiPropertyOptional({
    example: true,
    description: 'True when the user already purchased (or owns) this report — no charge made.',
  })
  alreadyOwned?: boolean;

  @ApiPropertyOptional({
    example: true,
    description: 'True when Stripe is unconfigured and the purchase was auto-completed (mock mode).',
  })
  mock?: boolean;
}

export class ReportPurchaseItemDto {
  @ApiProperty({ example: 'ckqz2zk5e0000a8b8h4t8j2z3' })
  reportId!: string;

  @ApiProperty({ example: 'CSP-042' })
  code!: string;

  @ApiProperty({
    example: { make: 'BMW', model: '320d', year: 2018 },
    description: 'Minimal vehicle summary for the purchases list.',
  })
  vehicle!: { make: string | null; model: string | null; year: number | null };

  @ApiProperty({ example: '2026-06-13T10:00:00.000Z' })
  purchasedAt!: string;
}

export class ReportPurchaseListDto {
  @ApiProperty({ type: [ReportPurchaseItemDto] })
  items!: ReportPurchaseItemDto[];
}
