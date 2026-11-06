import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { R2Module } from '../r2/r2.module';
import { PublicController } from './public.controller';
import { PublicService } from './public.service';

@Module({
  imports: [PrismaModule, R2Module],
  controllers: [PublicController],
  providers: [PublicService],
  // The listing editor's preview reads the masked report (DEN-562).
  exports: [PublicService],
})
export class PublicModule {}
