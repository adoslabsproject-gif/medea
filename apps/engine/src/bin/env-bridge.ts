/**
 * Env var bridging — MUST be the first import in bin/flowforge.ts.
 * Maps user-friendly FLOWFORGE_* names to the schema-expected names
 * BEFORE any other module loads (because logger.ts and config cache
 * the parsed config at module-load time).
 */
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

if (process.env.FLOWFORGE_PORT && !process.env.PORT) {
  process.env.PORT = process.env.FLOWFORGE_PORT;
}
if (process.env.FLOWFORGE_HOST && !process.env.HOST) {
  process.env.HOST = process.env.FLOWFORGE_HOST;
}
if (process.env.FLOWFORGE_CORS_ORIGINS && !process.env.CORS_ORIGINS) {
  process.env.CORS_ORIGINS = process.env.FLOWFORGE_CORS_ORIGINS;
}
if (process.env.FLOWFORGE_LOG_LEVEL && !process.env.LOG_LEVEL) {
  process.env.LOG_LEVEL = process.env.FLOWFORGE_LOG_LEVEL;
}

const dataDir = process.env.FLOWFORGE_DATA_DIR ?? join(homedir(), '.flowforge');
if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
process.env.FLOWFORGE_DATA_DIR = dataDir;
if (!process.env.FLOWFORGE_DB_PATH) {
  process.env.FLOWFORGE_DB_PATH = join(dataDir, 'flowforge.db');
}
