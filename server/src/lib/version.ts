import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Repository root (server/src/lib → ../../..). */
export const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** Reads the app version from package.json once at startup. */
export function readAppVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as {
      version?: unknown;
    };
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}
