import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { AppleValidator } from './apple-validator';
import { GoogleValidator } from './google-validator';
import { IapValidatorService } from './iap-validator.service';

@Module({
  imports: [HttpModule],
  providers: [AppleValidator, GoogleValidator, IapValidatorService],
  exports: [IapValidatorService],
})
export class IapModule {}
