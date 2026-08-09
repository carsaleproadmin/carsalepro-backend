import { ConflictException, Controller, HttpCode, NotFoundException, Param, Post } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Public } from '../auth/auth.decorators';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Test-only affordances. Registered by `AppModule` **only when
 * `NODE_ENV === 'test'`** — see the module docblock.
 */
@ApiExcludeController()
@Controller('api/v1/testing')
export class TestingController {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Move an order's inspector-search deadline into the past.
   *
   * Without this the "nobody accepted" path cannot be covered at all: the real
   * window is `orderSearchWindowMinutes` (six hours by default), and the only
   * alternatives are a fake clock across an HTTP boundary or a direct database
   * write from the spec — which would test the cron against a state the
   * application itself never produces.
   *
   * It refuses when `searchExpiresAt` is NULL rather than inventing a deadline.
   * A null deadline means the order predates manual capture and its money was
   * charged outright; backfilling one — even in a test — would teach the suite
   * that a state the production rule forbids is reachable.
   */
  @Public()
  @Post('orders/:id/expire-search')
  @HttpCode(200)
  async expireSearch(@Param('id') id: string): Promise<{
    orderId: string;
    searchExpiresAt: string;
  }> {
    const order = await this.prisma.order.findUnique({
      where: { id },
      select: { id: true, searchExpiresAt: true },
    });
    if (!order) {
      throw new NotFoundException({ error: { code: 'not_found', message: 'Order not found' } });
    }
    if (!order.searchExpiresAt) {
      throw new ConflictException({
        error: {
          code: 'search_window_absent',
          message: 'This order has no search window; it was never an authorization hold.',
        },
      });
    }

    const searchExpiresAt = new Date(Date.now() - 60_000);
    await this.prisma.order.update({ where: { id }, data: { searchExpiresAt } });
    return { orderId: id, searchExpiresAt: searchExpiresAt.toISOString() };
  }
}
