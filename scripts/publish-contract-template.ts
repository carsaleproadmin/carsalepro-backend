/**
 * Publish a contract template from the code into the database.
 *
 *   npx ts-node scripts/publish-contract-template.ts --key contract_en --dry-run
 *   npx ts-node scripts/publish-contract-template.ts --key contract_en
 *
 * WHY THIS SCRIPT EXISTS
 *
 * `prisma/seed.ts` writes the content of `CONTRACT_TEMPLATES` only when a key
 * has no version, or when the active version is still an E10 draft stub. If the
 * active version holds real content, the seed leaves it alone, because an admin
 * may have edited it and a seed must not destroy that edit. Render runs
 * `prisma migrate deploy` on start and never runs the seed, so a new agreement
 * written in `legal-contracts.content.ts` does not reach production by itself.
 *
 * This script closes that gap. It creates a NEW version (max + 1) with the
 * content from the code, makes it active, and deactivates the versions before
 * it. Contracts that are already rendered are not touched: each `OrderContract`
 * keeps the `templateVersion` it was rendered from, and its frozen HTML and
 * markdown stay as they were.
 *
 * A data migration in SQL was the other option. It would put a second copy of
 * the agreement in `prisma/migrations`, and the two copies would disagree after
 * the first edit.
 */
import { PrismaClient } from '@prisma/client';
import { CONTRACT_TEMPLATES, ContractKey } from '../src/legal/legal-contracts.content';

const prisma = new PrismaClient();

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function main(): Promise<void> {
  const key = (arg('key') ?? 'contract_en') as ContractKey;
  const dryRun = flag('dry-run');

  const tpl = CONTRACT_TEMPLATES[key];
  if (!tpl) {
    throw new Error(`Unknown template key: ${key}`);
  }

  const active = await prisma.legalTemplate.findFirst({
    where: { key, active: true },
    orderBy: { version: 'desc' },
  });
  const latest = await prisma.legalTemplate.findFirst({
    where: { key },
    orderBy: { version: 'desc' },
    select: { version: true },
  });

  if (active && active.bodyMd === tpl.bodyMd && active.title === tpl.title) {
    console.log(`${key}: the active version v${active.version} is identical. Nothing to do.`);
    return;
  }

  const nextVersion = (latest?.version ?? 0) + 1;
  console.log(`${key}: active=${active ? `v${active.version}` : 'none'} -> new v${nextVersion}`);
  console.log(`  locale: ${tpl.locale}`);
  console.log(`  title:  ${tpl.title}`);
  console.log(`  body:   ${tpl.bodyMd.length} characters`);

  if (dryRun) {
    console.log('Dry run. Nothing was written.');
    return;
  }

  await prisma.$transaction([
    prisma.legalTemplate.updateMany({
      where: { key, active: true },
      data: { active: false },
    }),
    prisma.legalTemplate.create({
      data: {
        key,
        version: nextVersion,
        locale: tpl.locale,
        title: tpl.title,
        bodyMd: tpl.bodyMd,
        active: true,
      },
    }),
  ]);

  console.log(`${key}: v${nextVersion} is now active.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
