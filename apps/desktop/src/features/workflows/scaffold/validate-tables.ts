/**
 * Validazione delle tabelle richieste dal workflow (`tablesToCreate`).
 *
 * Un nome di tabella generato da un modello finisce dentro una DDL: qui si
 * garantisce che sia un identificatore e nient'altro. Niente quoting a valle
 * può sostituire questo filtro — un nome che non passa di qui non arriva mai
 * al database.
 */

import type { ScaffoldOutput } from './schema';
import { TABLE_COLUMN_TYPES } from './schema';
import type { Violation } from './validate';

/** Identificatore SQL sicuro: minuscolo, senza quoting, senza sorprese. */
const IDENTIFIER = /^[a-z][a-z0-9_]*$/;
const MAX_IDENTIFIER_LEN = 64;
const MAX_COLUMNS = 32;

/** Le tabelle di Medea (vedi `src-tauri/src/db/schema.rs`): un workflow non
 *  può chiedere di crearne una che ombreggia il database dell'app. */
export const RESERVED_TABLE_NAMES: ReadonlySet<string> = new Set([
  'accounts',
  'app_settings',
  'article_brands',
  'article_categories',
  'articles',
  'attachments',
  'contacts',
  'customer_category_discounts',
  'customer_document_items',
  'customer_documents',
  'customer_price_overrides',
  'email_templates',
  'folder_message_uids',
  'folders',
  'message_labels',
  'messages',
  'messages_fts',
  'notes',
  'organizations',
  'price_list_items',
  'price_lists',
  'reminders',
  'schema_version',
  'workflows',
]);

const COLUMN_TYPES = new Set<string>(TABLE_COLUMN_TYPES);

function invalidTable(name: string, message: string): Violation {
  return { kind: 'invalid_table', field: name, message };
}

function invalidColumn(table: string, column: string, message: string): Violation {
  return { kind: 'invalid_column', field: `${table}.${column}`, message };
}

function validateTableName(name: string, seen: Set<string>): Violation[] {
  const violations: Violation[] = [];
  if (!IDENTIFIER.test(name) || name.length > MAX_IDENTIFIER_LEN) {
    violations.push(
      invalidTable(
        name,
        `"${name}" non è un nome di tabella valido: solo minuscole, cifre e underscore (max ${MAX_IDENTIFIER_LEN}), iniziando con una lettera.`,
      ),
    );
    return violations;
  }
  if (name.startsWith('sqlite_')) {
    violations.push(
      invalidTable(name, `"${name}" è riservato a SQLite: il prefisso "sqlite_" non è ammesso.`),
    );
  } else if (RESERVED_TABLE_NAMES.has(name)) {
    violations.push(
      invalidTable(name, `"${name}" è una tabella di Medea: scegli un nome che non esiste già.`),
    );
  }
  if (seen.has(name)) {
    violations.push(invalidTable(name, `La tabella "${name}" è dichiarata più di una volta.`));
  }
  seen.add(name);
  return violations;
}

type ScaffoldTable = NonNullable<ScaffoldOutput['tablesToCreate']>[number];

function validateColumns(table: ScaffoldTable): Violation[] {
  const violations: Violation[] = [];
  if (table.columns.length === 0) {
    violations.push(invalidTable(table.name, `La tabella "${table.name}" non ha colonne.`));
    return violations;
  }
  if (table.columns.length > MAX_COLUMNS) {
    violations.push(
      invalidTable(
        table.name,
        `La tabella "${table.name}" ha ${table.columns.length} colonne: il massimo è ${MAX_COLUMNS}.`,
      ),
    );
  }
  const seen = new Set<string>();
  for (const col of table.columns) {
    if (!IDENTIFIER.test(col.name) || col.name.length > MAX_IDENTIFIER_LEN) {
      violations.push(
        invalidColumn(
          table.name,
          col.name,
          `"${col.name}" non è un nome di colonna valido: solo minuscole, cifre e underscore, iniziando con una lettera.`,
        ),
      );
    } else if (seen.has(col.name)) {
      violations.push(
        invalidColumn(
          table.name,
          col.name,
          `La colonna "${col.name}" è dichiarata due volte in "${table.name}".`,
        ),
      );
    }
    seen.add(col.name);
    if (!COLUMN_TYPES.has(col.type)) {
      violations.push(
        invalidColumn(
          table.name,
          col.name,
          `Il tipo "${col.type}" della colonna "${col.name}" non esiste. Tipi ammessi: ${[...COLUMN_TYPES].join(' | ')}.`,
        ),
      );
    }
  }
  return violations;
}

/** Tutte le tabelle richieste, contro le regole sopra. */
export function validateTables(output: ScaffoldOutput): Violation[] {
  const tables = output.tablesToCreate ?? [];
  const violations: Violation[] = [];
  const seenNames = new Set<string>();
  for (const table of tables) {
    violations.push(...validateTableName(table.name, seenNames));
    violations.push(...validateColumns(table));
  }
  return violations;
}
