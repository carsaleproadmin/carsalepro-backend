/* Load .env for E2E tests without dragging in the @nestjs/config bootstrap. */
import * as fs from 'fs';
import * as path from 'path';

const candidates = [
  path.resolve(__dirname, '../../.env.test'),
  path.resolve(__dirname, '../../.env'),
];
for (const file of candidates) {
  if (!fs.existsSync(file)) continue;
  const content = fs.readFileSync(file, 'utf8');
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim().replace(/^"|"$/g, '');
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
  break;
}

process.env.NODE_ENV = process.env.NODE_ENV ?? 'test';
