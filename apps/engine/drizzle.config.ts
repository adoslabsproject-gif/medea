import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/storage/schema.ts',
  out: './drizzle',
  dbCredentials: {
    url: process.env.MEDEA_DB_PATH ?? './data/medea.sqlite',
  },
  verbose: true,
  strict: true,
});
