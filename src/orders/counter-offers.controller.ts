import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/auth.decorators';
import { CounterOffersService } from './counter-offers.service';
import { CreateCounterOfferDto } from './dto/counter-offer.dto';

/**
 * Counter-offers (DEN-344). Two audiences, one resource:
 *
 *  - the INSPECTOR lists orders below their rate and names a price;
 *  - the CUSTOMER reads the one price waiting for them and answers it.
 *
 * Both sides are authenticated and both are checked against the order in the
 * service — the routes carry no role guard of their own, because "is this your
 * order" and "may you take this job" are not role questions.
 */
@ApiTags('counter-offers')
@ApiBearerAuth()
@Controller('api/v1')
export class CounterOffersController {
  constructor(private readonly counterOffers: CounterOffersService) {}

  @Get('inspector/orders/out-of-range')
  @ApiOperation({ summary: 'Orders the inspector can reach but that pay less than their rate' })
  async listForInspector(@CurrentUser('id') userId: string) {
    return this.counterOffers.listOpenForInspector(userId);
  }

  @Post('orders/:orderId/counter-offers')
  @HttpCode(201)
  @ApiOperation({ summary: 'Inspector names a price for an order nobody took' })
  async create(
    @CurrentUser('id') userId: string,
    @Param('orderId') orderId: string,
    @Body() dto: CreateCounterOfferDto,
  ) {
    return this.counterOffers.create(orderId, userId, dto);
  }

  @Post('counter-offers/:id/withdraw')
  @HttpCode(200)
  @ApiOperation({ summary: 'Inspector takes their price back while it still waits' })
  async withdraw(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.counterOffers.withdraw(id, userId);
  }

  /**
   * Declared BEFORE the `orders/:orderId/...` routes for the ordinary Nest
   * reason: a literal segment and a parameter never collide here, but the
   * customer's two reads belong side by side.
   */
  @Get('counter-offers/mine')
  @ApiOperation({ summary: 'Every price waiting for an answer on this customer’s orders' })
  async mine(@CurrentUser('id') userId: string) {
    return this.counterOffers.pendingForCustomer(userId);
  }

  @Get('orders/:orderId/counter-offers/current')
  @ApiOperation({ summary: 'The one counter-offer waiting for the customer, or null' })
  async current(@CurrentUser('id') userId: string, @Param('orderId') orderId: string) {
    return this.counterOffers.currentForCustomer(orderId, userId);
  }

  /**
   * Accepting opens a PAYMENT; it does not finish the handover. The customer
   * pays the new price with the client secret this returns, and only when that
   * hold exists is the old one released — so a refused card costs them nothing.
   */
  @Post('orders/:orderId/counter-offers/:id/accept')
  @HttpCode(200)
  @ApiOperation({ summary: 'Customer accepts the price and starts paying it' })
  async accept(
    @CurrentUser('id') userId: string,
    @Param('orderId') orderId: string,
    @Param('id') id: string,
  ) {
    return this.counterOffers.accept(orderId, id, userId);
  }

  @Post('orders/:orderId/counter-offers/:id/decline')
  @HttpCode(200)
  @ApiOperation({ summary: 'Customer refuses the price; the search continues' })
  async decline(
    @CurrentUser('id') userId: string,
    @Param('orderId') orderId: string,
    @Param('id') id: string,
  ) {
    return this.counterOffers.decline(orderId, id, userId);
  }
}
