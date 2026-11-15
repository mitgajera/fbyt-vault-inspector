// Loads vault-inspector/.env (if present) into process.env before anything reads it.
// Imported first in cli.ts. The path is resolved from this module, so it works from src/ (tsx)
// and dist/ (compiled) whatever the current directory is. Real environment variables win.
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const envPath = resolve(dirname(fileURLToPath(import.meta.url)), '..', '.env');
if (existsSync(envPath)) {
  const before = { ...process.env };
  process.loadEnvFile(envPath);
  for (const [k, v] of Object.entries(before)) process.env[k] = v; // shell values take precedence
}
export {};
