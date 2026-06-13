import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';

/**
 * Global so JwtService (token verify) and AuthService are available to the
 * app-wide JwtAuthGuard and to the OAuth bridge. Secrets are passed per call
 * from ConfigService, so JwtModule needs no static secret here.
 */
@Global()
@Module({
  imports: [PrismaModule, JwtModule.register({})],
  controllers: [AuthController],
  providers: [AuthService],
  exports: [AuthService, JwtModule],
})
export class AuthModule {}
