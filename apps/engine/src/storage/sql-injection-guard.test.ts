/**
 * SQL INJECTION GUARD — anti-drift sugli identificatori interpolati.
 *
 * SQLite non parametrizza gli IDENTIFICATORI (nomi tabella/colonna): un
 * `prepare(`… ${x} …`)` dove `x` è un identificatore va SEMPRE validato
 * (`assertSqlIdent`, whitelist, union-type letterale) o non deve esistere.
 * I VALORI usano invece i placeholder `?` e sono sempre sicuri.
 *
 * L'audit 2026-07 ha verificato UNO A UNO tutti i siti che interpolano nel
 * testo SQL raw (argomento di `prepare`/`exec`): tutti sicuri. Questo guard
 * INCHIODA quell'invariante: se nasce un NUOVO sito, o ne cambia il numero in
 * un file, il test diventa rosso finché un umano non lo verifica e lo dichiara
 * qui con motivo — oppure lo parametrizza. Nessun `${…}` in SQL raw può più
 * entrare in silenzio.
 *
 * NB complementare a `db-schema-coverage.test.ts`: quello valida la
 * CORRETTEZZA (le colonne esistono); questo valida la SICUREZZA (l'identificatore
 * è validato). Due reti diverse sullo stesso codice.
 *
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectTsFiles } from './__testkit__/sql-coverage.js';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Trova gli argomenti-stringa SQL raw che interpolano: `prepare(`…${`,
 * `exec(`…${`. NON `.get/.all/.run` (ricevono VALORI parametrizzati) né
 * `.get(`…`)` su Map JS (falsi positivi). Conta un match per riga.
 */
const RAW_SQL_INTERP = /\.(?:prepare|exec)\(\s*`[^`]*\$\{/gu;

interface SiteFile {
  /** path relativo a src/, con slash normalizzati. */
  rel: string;
  /** numero di siti SQL-raw-interpolati nel file. */
  count: number;
}

function scanSites(): SiteFile[] {
  const files = collectTsFiles(SRC_ROOT);
  const out: SiteFile[] = [];
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    const matches = src.match(RAW_SQL_INTERP);
    if (!matches || matches.length === 0) continue;
    out.push({ rel: relative(SRC_ROOT, file).replaceAll('\\', '/'), count: matches.length });
  }
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

/**
 * ALLOWLIST — ogni file che interpola identificatori in SQL raw, con il NUMERO
 * di siti verificati sicuri e il MECCANISMO che li rende sicuri. Verificato
 * uno-a-uno nell'audit 2026-07.
 *
 * Regola per il prossimo che tocca il codice: se questo test diventa rosso,
 * NON alzare il numero alla cieca. Apri il file, verifica che il nuovo `${…}`
 * in SQL sia un IDENTIFICATORE validato (assertSqlIdent / whitelist /
 * union-type letterale) o un frammento di soli `?` — poi aggiorna qui con la
 * ragione. Se è un valore, usa un placeholder `?` invece di interpolarlo.
 */
const ALLOWED: Record<string, { count: number; reason: string }> = {
  // ── Identificatori validati / hardcoded ──────────────────────────────
  'storage/migrate.ts': {
    count: 2,
    reason: 'ensureColumn(): table/column passano da assertSqlIdent() prima dell\'interpolazione; definition vieta terminatori di statement.',
  },
  'storage/db.ts': {
    count: 1,
    reason: 'addColumn(): name/type sono LETTERALI hardcoded nel codice di migrazione (folder_id/TEXT, ...), mai input utente.',
  },
  'routes/tenant-health.ts': {
    count: 1,
    reason: 'countRows(): table è un union-type letterale \'workflows\' | \'runs\' — il compilatore vieta ogni altro valore.',
  },
  'routes/backup.ts': {
    count: 3,
    reason: 'table/cols validati contro EXPORT_TABLES + PRAGMA table_info (whitelist esplicita documentata inline); valori parametrizzati.',
  },
  'services/ai-scaffold/template-cache/template.service.ts': {
    count: 1,
    reason: 'bumpCounter(): col = ok ? "success_count" : "fail_count" — ternario di due letterali, mai input.',
  },
  // ── whereSql / sets da frammenti hardcoded uniti con join ────────────
  'routes/users.ts': {
    count: 1,
    reason: 'PATCH users: gli SET sono frammenti hardcoded ("display_name = ?", ...) uniti con join; i VALORI sono parametrizzati.',
  },
  'routes/ai-chat.ts': {
    count: 2,
    reason: 'whereSql da frammenti hardcoded ("tenant_id = ?", "user_id = ?", "surface = ?") uniti con join; valori parametrizzati.',
  },
  'services/ai-conversations/conversation.service.ts': {
    count: 1,
    reason: 'conditions da frammenti hardcoded ("user_id = ?", "deleted_at IS NULL", "surface = ?") uniti con join; valori parametrizzati.',
  },
  'services/ai-interactions.service.ts': {
    count: 3,
    reason: 'whereSql da frammenti hardcoded uniti con join; LIMIT/OFFSET e i valori WHERE sono parametrizzati (?).',
  },
  'services/custom-nodes/service.ts': {
    count: 3,
    reason: 'whereSql da frammenti hardcoded ("status = ?", "category = ?", "owner_user_id = ?") uniti con join; valori parametrizzati.',
  },
  'services/tenant.service.ts': {
    count: 3,
    reason: 'list()/count()/update(): whereSql da frammenti hardcoded ("status = ?", "plan = ?", "deleted_at IS NULL") e sets hardcoded, uniti con join; valori parametrizzati.',
  },
  'services/workflow-control-tools.service.ts': {
    count: 1,
    reason: 'listWorkflows(): where = enabledOnly ? "WHERE enabled = 1" : "" — letterale binario, nessun input.',
  },
  // ── placeholders = ids.map(() => "?") (soli punti-interrogativi) ──────
  'routes/runs-history.ts': {
    count: 6,
    reason: 'whereSql da frammenti hardcoded + placeholders = ids.map(() => "?") per le clausole IN; valori parametrizzati.',
  },
  'routes/dashboard.ts': {
    count: 1,
    reason: 'workflow_id IN (${placeholders}) con placeholders = soli "?"; valori parametrizzati.',
  },
  'services/checkpoint.service.ts': {
    count: 2,
    reason: 'run id IN (${placeholders}/${claimedPh}) con placeholders = soli "?"; il resto della query è statico.',
  },
  'services/client-portal.service.ts': {
    count: 1,
    reason: 'conditions con id IN (${placeholders}) — placeholders soli "?"; altre condizioni frammenti hardcoded; valori parametrizzati.',
  },
};

describe('SQL injection guard — identificatori interpolati (anti-drift)', () => {
  it('OGNI sito SQL-raw-interpolato è in allowlist, col numero atteso', () => {
    const sites = scanSites();
    const problems: string[] = [];

    for (const site of sites) {
      const allow = ALLOWED[site.rel];
      if (!allow) {
        problems.push(
          `NUOVO file con SQL raw interpolato: "${site.rel}" (${site.count} siti). ` +
          `Verifica che ogni \${…} sia un identificatore VALIDATO (assertSqlIdent/whitelist/union) ` +
          `o un frammento di soli "?", poi dichiaralo in ALLOWED con la ragione. Se è un valore, usa "?".`,
        );
        continue;
      }
      if (allow.count !== site.count) {
        problems.push(
          `CAMBIATO il numero di query dinamiche in "${site.rel}": atteso ${allow.count}, trovato ${site.count}. ` +
          `Un sito è stato aggiunto/rimosso — ri-verifica la sicurezza di TUTTI i \${…} SQL del file e aggiorna il count.`,
        );
      }
    }

    // Un file dichiarato che NON ha più siti (rimossi tutti) va ripulito dall'allowlist.
    const scannedRels = new Set(sites.map((s) => s.rel));
    for (const rel of Object.keys(ALLOWED)) {
      if (!scannedRels.has(rel)) {
        problems.push(`"${rel}" è in ALLOWED ma non ha più SQL raw interpolato: rimuovilo dall'allowlist.`);
      }
    }

    expect(problems, `\n${problems.join('\n')}\n`).toEqual([]);
  });

  it('l\'allowlist non è vuota (il guard sta davvero scansionando, non un no-op verde)', () => {
    // Anti green-fake: se il regex smettesse di matchare, scanSites() tornerebbe
    // [] e il test sopra passerebbe banalmente. Questo lo impedisce.
    expect(scanSites().length).toBeGreaterThanOrEqual(6);
  });
});
