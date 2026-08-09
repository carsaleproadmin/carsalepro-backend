import { Module } from '@nestjs/common';
import { TestingController } from './testing.controller';

/**
 * Endpoints that exist only so the e2e suite can reach states the application
 * otherwise takes hours to arrive at.
 *
 * **It is registered by `AppModule` only when `NODE_ENV === 'test'`.** The gate
 * lives at the import site, not inside a guard here, so in every other
 * environment the routes are not merely refused — they do not exist, and no
 * amount of misconfiguration can bring them back.
 *
 * The bar for adding to this module is high: a state the product genuinely
 * cannot produce on demand. `POST orders/:id/expire-search` qualifies because
 * the inspector-search window is six hours long and the "nobody accepted" path
 * — the one that releases a customer's hold — is otherwise untestable.
 */
@Module({
  controllers: [TestingController],
})
export class TestingModule {}
