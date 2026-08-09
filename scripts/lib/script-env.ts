/**
 * Shared plumbing for the standalone `npx ts-node scripts/*.ts` migrations.
 *
 * These scripts run OUTSIDE Nest — no ConfigService, no Joi validation — so each
 * one used to carry its own copy of the same four helpers. One copy is enough:
 * a bug in `.env` parsing that only half the migrations have is worse than a
 * shared file.
 */
import * as fs from 'fs';
import * as path from 'path';

/** Load `.env` the same way test/helpers/load-env.ts does — no extra dependency. */
export function loadEnv(file = path.resolve(__dirname, '../../.env')): void {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line
      .slice(eq + 1)
      .trim()
      .replace(/^"|"$/g, '');
    // Never override what the operator put in the real environment.
    if (!(key in process.env)) process.env[key] = value;
  }
}

/** Read a variable or abort — a half-configured migration is worse than none. */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`FATAL: ${name} is not set. Aborting.`);
    process.exit(1);
  }
  return value;
}

export function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

export function option(name: string, fallback: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}
