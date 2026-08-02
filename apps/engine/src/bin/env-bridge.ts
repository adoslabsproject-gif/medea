/**
 * Env var bridging — MUST be the first import in bin/flowforge.ts.
 * Maps user-friendly MEDEA_* names to the schema-expected names
 * BEFORE any other module loads (because logger.ts and config cache
 * the parsed config at module-load time).
 */
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

if (process.env.MEDEA_PORT && !process.env.PORT) {
  process.env.PORT = process.env.MEDEA_PORT;
}
if (process.env.MEDEA_HOST && !process.env.HOST) {
  process.env.HOST = process.env.MEDEA_HOST;
}
if (process.env.MEDEA_CORS_ORIGINS && !process.env.CORS_ORIGINS) {
  process.env.CORS_ORIGINS = process.env.MEDEA_CORS_ORIGINS;
}
if (process.env.MEDEA_LOG_LEVEL && !process.env.LOG_LEVEL) {
  process.env.LOG_LEVEL = process.env.MEDEA_LOG_LEVEL;
}

const dataDir = process.env.MEDEA_DATA_DIR ?? join(homedir(), '.flowforge');
if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
process.env.MEDEA_DATA_DIR = dataDir;
if (!process.env.MEDEA_DB_PATH) {
  process.env.MEDEA_DB_PATH = join(dataDir, 'flowforge.db');
}
