import { Module } from '@nestjs/common';
import { ListingsModule } from '../listings/listings.module';
import { MeController } from './me.controller';
import { MeService } from './me.service';

// ListingsModule for `erasePublicPhotoObjects`: GDPR erasure must sweep the
// PUBLIC image bucket as well as the private one, and the rule for deriving
// those keys belongs next to the code that writes them, not copied here.
@Module({
  imports: [ListingsModule],
  controllers: [MeController],
  providers: [MeService],
})
export class MeModule {}
