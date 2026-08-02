/**
 * Tenant Context Builder — Layer A enterprise 2026.
 *
 * Pre-LLM, leggi le risorse REALI del tenant (databases, email accounts,
 * workspaces) e iniettale nel system prompt. Il LLM smette di INVENTARE
 * `databaseId="db_opportunities"` e usa l'UUID vero.
 *
 * Riduce ~60-70% i reject di quality gate per `SUSPICIOUS_RESOURCE_ID`.
 *
 * Graceful: se le service call falliscono, ritorna context vuoto + log
 * (il singleshot prosegue senza injection, fallback al comportamento
 * precedente).
 */

import { DbStudioService } from '@/services/db-studio.service.js';
import { SystemEmailAccountsService } from '@/services/system-email-accounts.service.js';
import { LlmProvidersService } from '@/services/llm-providers.service.js';
import { tenantAiPreferences } from '@/services/tenant-ai-preferences.service.js';
import { logger } from '@/lib/logger.js';

export interface TenantContextResources {
  databases: {
    id: string;
    name: string;
    description: string | null;
    tables: string[];
    /**
     * Mappa nome-tabella → nomi-colonna. Alimenta la rule
     * `DB_COLUMN_NOT_IN_SCHEMA` del quality-gate (validazione colonne
     * rowJson/whereJson/patchJson). Tabelle senza colonne note sono assenti
     * dalla mappa (→ il gate skippa il check colonna, mantenendo il table check).
     */
    columns: Record<string, string[]>;
    /**
     * DB LOCALE scrivibile (`connection.embedded === true`)? Solo qui si possono
     * CREARE/scrivere tabelle. I DB ESTERNI connessi dal tenant (es. il Postgres
     * NHA, spesso read-only) sono `false`: le loro tabelle vanno offerte SOLO come
     * sorgenti di lettura, MAI come target di nuove tabelle/insert.
     *
     * Bug reale (senza1dio, 2026-06-16): il grounding listava NHA → il modello
     * pescava `admin_url_secrets` (tabella admin di NHA) invece di creare
     * `rss_sources` in un DB locale → workflow rotto + CREATE TABLE su read-only.
     */
    writable: boolean;
  }[];
  emailAccounts: { id: string; label: string; fromAddress: string; isDefault: boolean }[];
  /**
   * The LLM provider name the scaffold MUST wire into every `agent_*` node.
   * Resolved from the tenant's explicit Settings preference, then from the
   * first configured external provider, then from Liara. `null` when nothing
   * is available — the agent is instructed to abort with a clear UX message.
   */
  defaultLlmProvider: string | null;
  /** Configured providers (name + hasKey). Used only for the prompt rendering. */
  llmProviders: { provider: string; hasKey: boolean }[];
}

const dbStudio = new DbStudioService();
const emailAccounts = new SystemEmailAccountsService();
const llmProviders = new LlmProvidersService();

export function buildTenantContext(tenantId: string): TenantContextResources {
  const out: TenantContextResources = {
    databases: [],
    emailAccounts: [],
    defaultLlmProvider: null,
    llmProviders: [],
  };
  try {
    const dbs = dbStudio.list(tenantId);
    out.databases = dbs.slice(0, 20).map((d) => {
      // Tables sono nel spec (Database.tables[]) — estraiamo nomi + colonne.
      const dAny = d as {
        id: string;
        name: string;
        description?: string | null;
        tables?: { name?: string; columns?: { name?: string }[] }[];
        connection?: { embedded?: boolean };
      };
      const tableNames: string[] = [];
      const columns: Record<string, string[]> = {};
      if (Array.isArray(dAny.tables)) {
        for (const t of dAny.tables.slice(0, 50)) {
          const tName = String(t.name ?? '').trim();
          if (!tName) continue;
          tableNames.push(tName);
          const colNames = Array.isArray(t.columns)
            ? t.columns
                .map((c) => String(c.name ?? '').trim())
                .filter(Boolean)
                .slice(0, 100)
            : [];
          // Solo tabelle con colonne note entrano nella mappa (il gate skippa
          // il check colonna sulle tabelle assenti, evitando falsi positivi).
          if (colNames.length > 0) columns[tName] = colNames;
        }
      }
      return {
        id: dAny.id,
        name: dAny.name,
        description: dAny.description ?? null,
        tables: tableNames,
        columns,
        writable: dAny.connection?.embedded === true,
      };
    });
  } catch (e) {
    logger.debug(
      { err: e instanceof Error ? e.message : String(e), tenantId },
      '[tenant-context] db list failed (graceful)',
    );
  }
  try {
    out.emailAccounts = emailAccounts.picker(tenantId).slice(0, 10);
  } catch (e) {
    logger.debug(
      { err: e instanceof Error ? e.message : String(e), tenantId },
      '[tenant-context] email accounts list failed (graceful)',
    );
  }
  try {
    const configured = llmProviders
      .list(tenantId)
      .filter((p) => p.hasKey)
      .map((p) => ({ provider: p.provider, hasKey: true }));
    out.llmProviders = configured;
    out.defaultLlmProvider = tenantAiPreferences.resolveDefaultProvider(tenantId, configured);
  } catch (e) {
    logger.debug(
      { err: e instanceof Error ? e.message : String(e), tenantId },
      '[tenant-context] llm providers list failed (graceful)',
    );
  }
  return out;
}

/**
 * Formatta come blocco system prompt — text-only, compatto (~200-500 token
 * tipicamente per tenant con 1-5 risorse). Inserito DOPO il SYSTEM_PROMPT
 * base, PRIMA del user prompt.
 */
export function formatTenantContextForPrompt(ctx: TenantContextResources): string {
  if (
    ctx.databases.length === 0 &&
    ctx.emailAccounts.length === 0 &&
    ctx.defaultLlmProvider === null &&
    ctx.llmProviders.length === 0
  ) {
    return ''; // niente injection se tenant non ha risorse configurate
  }
  const lines: string[] = ['### RISORSE REALI DEL TENANT (USA QUESTI ID, NON INVENTARE)'];
  // LLM provider section first — it's the most often-violated rule.
  if (ctx.defaultLlmProvider) {
    lines.push(
      '',
      '**LLM provider DI DEFAULT del tenant (regola HARD):**',
      `- DEFAULT: \`${ctx.defaultLlmProvider}\` — usa QUESTO nome ESATTO in \`config.provider\` di OGNI nodo \`agent_*\`.`,
      `- Configurati: ${ctx.llmProviders.map((p) => `"${p.provider}"`).join(', ') || '(solo il default)'}.`,
      '- `config.model` lascialo VUOTO (`""`) — il runtime usa il default del provider.',
      '- NIENTE `apiKey` hard-coded. NIENTE guess di "gpt-4o"/"claude" basato sul training data.',
    );
  } else {
    lines.push(
      '',
      '**LLM provider DI DEFAULT del tenant:**',
      '- NESSUNO configurato (e Liara è disabilitato per questo tenant).',
      '- ABORT con messaggio: "Per usare nodi `agent_*` configura un provider in Settings → AI o abilita Liara."',
    );
  }
  const writableDbs = ctx.databases.filter((d) => d.writable);
  const readonlyDbs = ctx.databases.filter((d) => !d.writable);
  if (writableDbs.length > 0) {
    lines.push('', '**DB LOCALI SCRIVIBILI (qui — e SOLO qui — si CREANO/scrivono le tabelle):**');
    for (const db of writableDbs) {
      const desc = db.description ? ` — ${db.description.slice(0, 60)}` : '';
      const tablesLine =
        db.tables.length > 0
          ? `\n    tabelle esistenti: [${db.tables.map((t) => `"${t}"`).join(', ')}]`
          : '\n    (nessuna tabella ancora — creane di nuove con nomi sensati al dominio, es. "rss_sources")';
      lines.push(`- id="${db.id}" name="${db.name}"${desc}${tablesLine}`);
    }
  } else if (readonlyDbs.length > 0) {
    // Ci sono DB ma TUTTI esterni read-only (caso senza1dio: solo NHA). Va detto
    // ESPLICITAMENTE che non sono scrivibili, altrimenti il modello ci pesca dentro.
    lines.push(
      '',
      '**DB LOCALI SCRIVIBILI:** NESSUNO ancora.',
      '- Per le tabelle che il workflow deve POPOLARE, scegli nomi sensati al dominio (es. "rss_sources", "articoli") e il sistema creerà automaticamente un DB locale che le contiene.',
      '- NON scrivere MAI in un DB esterno read-only qui sotto.',
    );
  }
  if (readonlyDbs.length > 0) {
    lines.push(
      '',
      '**DB ESTERNI — SOLO LETTURA (NON creare/scrivere tabelle qui, mai db_insert/db_update):**',
    );
    for (const db of readonlyDbs) {
      const desc = db.description ? ` — ${db.description.slice(0, 60)}` : '';
      const tablesLine =
        db.tables.length > 0
          ? `\n    tabelle (solo per db_query in lettura): [${db.tables.map((t) => `"${t}"`).join(', ')}]`
          : '';
      lines.push(`- id="${db.id}" name="${db.name}" [READ-ONLY]${desc}${tablesLine}`);
    }
  }
  if (ctx.emailAccounts.length > 0) {
    lines.push('', '**Email accounts disponibili (per campi `systemAccountId`):**');
    for (const acc of ctx.emailAccounts) {
      lines.push(
        `- id="${acc.id}" label="${acc.label}" from="${acc.fromAddress}"${acc.isDefault ? ' [DEFAULT]' : ''}`,
      );
    }
  }
  lines.push(
    '',
    '**REGOLE FERREE:**',
    '1. Per `databaseId` USA SOLO un id dalla lista sopra (NON inventare "db_opportunities", "main_db" etc)',
    '2. SCRITTURE (db_insert/db_update) e tabelle NUOVE: SOLO in un DB LOCALE SCRIVIBILE. MAI in un DB [READ-ONLY] — è dati altrui e fallirebbe. NON usare tabelle dei DB read-only come target di scrittura (es. NON `admin_url_secrets`).',
    '3. Per le tabelle che il workflow popola, se non esiste già una tabella locale adatta, DICHIARALA da creare con un nome aderente al dominio del task (es. "rss_sources", non una tabella a caso vista altrove).',
    '4. db_query in LETTURA può usare le tabelle dei DB [READ-ONLY] elencate.',
    '5. Per `systemAccountId` USA SOLO un id dalla lista sopra (NON inventare "email-account-1" etc)',
    "6. Se NESSUNA risorsa appropriata è disponibile per il caso d'uso, usa `{{secrets.NOME_DESCRITTIVO}}` (l'utente la configurerà)",
    '7. Per URL/host/email/dominio che NON CONOSCI usa SEMPRE `{{secrets.X}}` MAI placeholder come "company.com", "bucket-name", "miosito.com", "tuosito.it", "noreply@..."',
  );
  return lines.join('\n');
}
