/**
 * Schema della tabella `generations` (storage privato delle generazioni media).
 *
 * Una SOLA fonte di verità per: il DDL (creazione idempotente in DB Studio), la
 * lista colonne (usata dai test di contratto sullo schema), e i valori ammessi
 * per `rating`. Niente input utente nel DDL → nessun rischio injection.
 *
 * @module services/private-generations/schema
 */

/** Nome del database DB Studio (embedded sqlite) che ospita le generazioni. */
export const GENERATIONS_DB_NAME = 'private_generations';

/** Nome tabella. */
export const GENERATIONS_TABLE = 'generations';

/** Colonne attese (contratto verificato dai test — anti-drift schema↔codice). */
export const GENERATIONS_COLUMNS = [
  'id',
  'created_at',
  'kind',
  'prompt',
  'negative',
  'params',
  'seed',
  'width',
  'height',
  'checkpoint',
  'mime',
  'media_ref',
  'size_bytes',
  'rating',
  'notes',
  'conversation_id',
] as const;

export type GenerationColumn = (typeof GENERATIONS_COLUMNS)[number];

/** Valori ammessi per il voto. NULL = non votato. */
export const RATINGS = ['up', 'down'] as const;
export type Rating = (typeof RATINGS)[number];

/**
 * DDL idempotente. `kind` e `rating` sono CHECK-vincolati a livello DB (difesa
 * in profondità, oltre alla validazione applicativa). `media_ref` è il
 * content-address (sha256) nel BinaryStore del tenant.
 */
export const CREATE_GENERATIONS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS ${GENERATIONS_TABLE} (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('image','video')),
  prompt TEXT NOT NULL,
  negative TEXT,
  params TEXT,
  seed INTEGER,
  width INTEGER,
  height INTEGER,
  checkpoint TEXT,
  mime TEXT NOT NULL,
  media_ref TEXT NOT NULL,
  size_bytes INTEGER,
  rating TEXT CHECK (rating IN ('up','down')),
  notes TEXT,
  conversation_id TEXT
);
CREATE INDEX IF NOT EXISTS generations_created_idx ON ${GENERATIONS_TABLE}(created_at DESC);
CREATE INDEX IF NOT EXISTS generations_rating_idx ON ${GENERATIONS_TABLE}(rating);
CREATE INDEX IF NOT EXISTS generations_conv_idx ON ${GENERATIONS_TABLE}(conversation_id);
`.trim();

/**
 * Migrazioni additive idempotenti per tabelle GIÀ esistenti (CREATE IF NOT EXISTS
 * non aggiunge colonne). Ogni statement è eseguito best-effort: se la colonna
 * esiste già SQLite dà "duplicate column" → si ignora.
 */
export const GENERATIONS_MIGRATIONS = [
  `ALTER TABLE ${GENERATIONS_TABLE} ADD COLUMN conversation_id TEXT`,
] as const;
