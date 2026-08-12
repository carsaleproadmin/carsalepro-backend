/**
 * Re-render the contract of every order that already has one.
 *
 *   npx ts-node scripts/rerender-order-contracts.ts --dry-run
 *   npx ts-node scripts/rerender-order-contracts.ts --yes
 *   npx ts-node scripts/rerender-order-contracts.ts --yes --order=<id>
 *
 * READ THIS BEFORE YOU RUN IT ON PRODUCTION DATA.
 *
 * An `OrderContract` is a frozen record. It keeps the template version, the
 * substituted markdown and the rendered HTML from the moment the order reached
 * ASSIGNED, so that the document cannot change under the parties after they
 * have worked and been paid. This script DESTROYS that property: it deletes the
 * old row and renders a new one from the template that is active now. The
 * parties then see terms they never agreed to.
 *
 * There is one honest use: a development or staging database, where the rows
 * are demonstration data and nobody relies on them. On production, a contract
 * that must be corrected is corrected by cancelling and re-issuing the order,
 * or by a decision that is recorded outside this script.
 *
 * The old R2 objects are not deleted. The key contains the template version
 * (`contracts/<orderId>/v<version>.html`), so a new version writes a new object
 * and the old one stays as evidence of what was issued before.
 *
 * `--dry-run` is the default. The script writes only with `--yes`.
 */
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { LegalContractService } from '../src/legal/legal-contract.service';

function arg(name: string): string | undefined {
  const i = process.argv.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i === -1) return undefined;
  const a = process.argv[i];
  return a.includes('=') ? a.split('=').slice(1).join('=') : process.argv[i + 1];
}

function flag(name: string): boolean {
  return process.argv.some((a) => a === `--${name}`);
}

async function main(): Promise<void> {
  const apply = flag('yes');
  const onlyOrder = arg('order');

  const ctx = await NestFactory.createApplicationContext(AppModule, {
    logger: ['warn', 'error'],
  });
  const prisma = ctx.get(PrismaService);
  const legal = ctx.get(LegalContractService);

  const orders = await prisma.order.findMany({
    where: {
      contractId: { not: null },
      ...(onlyOrder ? { id: onlyOrder } : {}),
    },
    select: { id: true, number: true, status: true, contractId: true },
    orderBy: { createdAt: 'asc' },
  });

  console.log(`${orders.length} order(s) have a contract.`);
  if (!apply) {
    for (const o of orders) {
      const c = await prisma.orderContract.findUnique({
        where: { id: o.contractId as string },
        select: { templateKey: true, templateVersion: true },
      });
      console.log(`  ${o.number} (${o.status}): ${c?.templateKey} v${c?.templateVersion}`);
    }
    console.log('Dry run. Nothing was written. Add --yes to re-render.');
    await ctx.close();
    return;
  }

  let done = 0;
  let failed = 0;
  for (const o of orders) {
    const oldId = o.contractId as string;
    try {
      // Detach first. `renderContractForOrder` is idempotent and returns the
      // existing contract while `order.contract_id` still points at one.
      await prisma.order.update({ where: { id: o.id }, data: { contractId: null } });
      await prisma.orderContract.delete({ where: { id: oldId } });
      const fresh = await legal.renderContractForOrder(o.id);
      const row = await prisma.orderContract.findUniqueOrThrow({
        where: { id: fresh.id },
        select: { templateKey: true, templateVersion: true },
      });
      console.log(`  ${o.number}: -> ${row.templateKey} v${row.templateVersion}`);
      done += 1;
    } catch (err) {
      failed += 1;
      console.error(`  ${o.number}: FAILED ${(err as Error).message}`);
    }
  }

  console.log(`Re-rendered ${done} contract(s). ${failed} failed.`);
  await ctx.close();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
