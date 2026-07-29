import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface FinanceSummary {
  from: string;
  to: string;
  currency: 'EUR';
  payments: { count: number; grossCents: number };
  byPurpose: {
    order: { count: number; cents: number };
    ppv: { count: number; cents: number };
    gold: { count: number; cents: number };
    /** BE-S3 paid VIN history. */
    vin_history: { count: number; cents: number };
  };
  refunds: { count: number; cents: number };
  payouts: { count: number; cents: number };
  platformNetCents: number;
}

const DAC7_HEADER = [
  'inspectorUserId',
  'name',
  'email',
  'companyName',
  'taxId',
  'vatId',
  'countryCode',
  'payoutCount',
  'totalPayoutCents',
  'totalPayoutEur',
];

@Injectable()
export class AdminFinanceService {
  constructor(private readonly prisma: PrismaService) {}

  async summary(from?: string, to?: string): Promise<FinanceSummary> {
    const toDate = to ? new Date(to) : new Date();
    const fromDate = from ? new Date(from) : new Date(toDate.getTime() - 30 * 86_400_000);
    const window = { gte: fromDate, lte: toDate };

    const succeeded = await this.prisma.payment.findMany({
      where: { status: 'succeeded', createdAt: window },
      select: { purpose: true, amountCents: true },
    });
    const grossCents = succeeded.reduce((sum, p) => sum + p.amountCents, 0);
    const byPurpose = {
      order: { count: 0, cents: 0 },
      ppv: { count: 0, cents: 0 },
      gold: { count: 0, cents: 0 },
      vin_history: { count: 0, cents: 0 },
    };
    for (const p of succeeded) {
      const bucket = byPurpose[p.purpose as keyof typeof byPurpose];
      if (bucket) {
        bucket.count += 1;
        bucket.cents += p.amountCents;
      }
    }

    const refundAgg = await this.prisma.refund.aggregate({
      where: { createdAt: window },
      _count: { _all: true },
      _sum: { amountCents: true },
    });
    const payoutAgg = await this.prisma.payout.aggregate({
      where: { status: 'paid', createdAt: window },
      _count: { _all: true },
      _sum: { amountCents: true },
    });

    const refundsCents = refundAgg._sum.amountCents ?? 0;
    const payoutsCents = payoutAgg._sum.amountCents ?? 0;

    return {
      from: fromDate.toISOString(),
      to: toDate.toISOString(),
      currency: 'EUR',
      payments: { count: succeeded.length, grossCents },
      byPurpose,
      refunds: { count: refundAgg._count._all, cents: refundsCents },
      payouts: { count: payoutAgg._count._all, cents: payoutsCents },
      platformNetCents: grossCents - refundsCents - payoutsCents,
    };
  }

  /** DAC7 CSV: one row per inspector with paid payouts in the calendar year. */
  async dac7Csv(year: number): Promise<string> {
    const start = new Date(Date.UTC(year, 0, 1, 0, 0, 0, 0));
    const end = new Date(Date.UTC(year + 1, 0, 1, 0, 0, 0, 0));

    const grouped = await this.prisma.payout.groupBy({
      by: ['inspectorId'],
      where: { status: 'paid', createdAt: { gte: start, lt: end } },
      _count: { _all: true },
      _sum: { amountCents: true },
    });

    const rows: string[] = [DAC7_HEADER.join(',')];

    // Stable order by inspectorId for deterministic output.
    grouped.sort((a, b) => a.inspectorId.localeCompare(b.inspectorId));

    for (const g of grouped) {
      const profile = await this.prisma.inspectorProfile.findUnique({
        where: { userId: g.inspectorId },
        include: { user: { select: { name: true, email: true, countryCode: true } } },
      });
      const totalCents = g._sum.amountCents ?? 0;
      const cols = [
        g.inspectorId,
        profile?.user.name ?? '',
        profile?.user.email ?? '',
        profile?.companyName ?? '',
        profile?.taxId ?? '',
        profile?.vatId ?? '',
        profile?.user.countryCode ?? '',
        String(g._count._all),
        String(totalCents),
        (totalCents / 100).toFixed(2),
      ];
      rows.push(cols.map((c) => csvEscape(c)).join(','));
    }

    return rows.join('\r\n') + '\r\n';
  }
}

/** Quote a CSV field and double any inner quotes. */
function csvEscape(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}
