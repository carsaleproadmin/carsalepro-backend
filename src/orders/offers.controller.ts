import { Controller, HttpCode, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/auth.decorators';
import { OrdersService } from './orders.service';

@ApiTags('offers')
@ApiBearerAuth()
@Controller('api/v1/offers')
export class OffersController {
  constructor(private readonly orders: OrdersService) {}

  @Post(':offerId/accept')
  @HttpCode(200)
  @ApiOperation({ summary: 'Inspector accepts an offer (PAID → ASSIGNED)' })
  async accept(@CurrentUser('id') userId: string, @Param('offerId') offerId: string) {
    return this.orders.acceptOffer(offerId, userId);
  }

  @Post(':offerId/decline')
  @HttpCode(200)
  @ApiOperation({ summary: 'Inspector declines an offer (cascades to next nearest)' })
  async decline(@CurrentUser('id') userId: string, @Param('offerId') offerId: string) {
    return this.orders.declineOffer(offerId, userId);
  }
}
