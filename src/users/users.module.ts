import { Module } from '@nestjs/common';
import { LinkCodesModule } from '../link-codes/link-codes.module';
import { ListingsModule } from '../listings/listings.module';
import { PrismaModule } from '../prisma/prisma.module';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

// ListingsModule for `erasePublicPhotoObjects` — see `eraseMe`.
@Module({
  imports: [PrismaModule, LinkCodesModule, ListingsModule],
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
