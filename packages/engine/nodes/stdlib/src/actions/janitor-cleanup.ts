/**
 * Janitor Cleanup workflow node — esegue una rule di pulizia dati come
 * step di un workflow.
 *
 * Use case tipici:
 *   • Pre-step prima di processare dati: pulisci marine_leads orfani
 *     prima di inviare campagna email
 *   • Scheduled workflow notturno: esegui ciclo Janitor completo +
 *     notifica admin se quarantenate > soglia
 *   • Onboarding nuovo tenant: pulizia dati legacy
 *
 * Federico-grade UI a prova di idiota:
 *   • Modalità (select): "Esegui regola singola" vs "Esegui ciclo"
 *   • Rule ID (text + help link): "system.runs.zombie" copia-incollabile
 *     da /janitor (lista visibile in Salute Dati)
 *   • Dry-run (boolean): toggle preview vs live
 *   • Override params (json): JSON object per parametri ad-hoc
 *   • Output branching: 4 porte (success / detection / clean / error)
 *
 * Output flow:
 *   • port 'success' → quando rule esegue (anche con quarantine > 0)
 *   • port 'detection' → quando rowsQuarantined > 0 ("trovate corruzioni")
 *   • port 'clean' → quando rowsQuarantined == 0 ("tutto ok")
 *   • port 'error' → rule fallita (lock contention / DB irraggiungibile)
 */
import type { NodeModule } from '../types.js';

export const janitorCleanupNode: NodeModule = {
  def: {
    id: 'action_janitor_cleanup',
    type: 'action',
    label: 'Salute dati: pulisci tabella',
    icon: 'sparkles',
    color: '#22c55e',
    description:
      'Eseguito enterprise di una regola del sistema "Salute Dati" (Janitor) come step di un workflow ' +
      'business — il pattern data-quality-as-code di FlowForge che permette di automatizzare le pulizie ' +
      'ricorrenti del database del cliente (dedup duplicati, normalizzazione campi, anonimizzazione GDPR, ' +
      'rimozione record obsoleti, consolidamento anagrafica) senza dover scrivere SQL manualmente né rischiare ' +
      'errori distruttivi su tabelle di produzione. Le regole Janitor sono definite dall\'admin del tenant ' +
      'nell\'interfaccia "Salute Dati" dell\'editor (UI no-code con builder visuale di trasformazione) e ' +
      'queste sono semplicemente eseguite da questo nodo come step di un workflow più ampio. ' +
      'Funziona su QUALUNQUE database collegato al sistema FlowForge — supporta i 5 dialetti SQL principali ' +
      'usati in produzione: SQLite (default del runtime tenant + databases del cliente locali), PostgreSQL ' +
      '(il preferred per produzione enterprise, supporta features avanzate come window functions e CTE), ' +
      'MySQL/MariaDB (l\'altro tier-1 RDBMS open-source comune in legacy LAMP stack), Microsoft SQL Server ' +
      '(per integrazione con enterprise Windows infrastructure), DuckDB (analytic columnar in-process database ' +
      'per workflow di analytics ETL pesanti). Il nodo astrae le differenze di syntax SQL tra i dialetti — ' +
      'l\'admin definisce la regola UNA volta e funziona su qualsiasi DB collegato. ' +
      'Due modalità operative complementari per coprire i pattern d\'uso: ' +
      '(1) singola — applica una specifica regola identificata per nome o id, utile quando il workflow è ' +
      'focused su una pulizia specifica (es. "dedup_customers" eseguito post-import bulk); ' +
      '(2) ciclo — itera ed esegue TUTTE le regole abilitate del database target nell\'ordine definito ' +
      'dall\'admin (priority-based), pattern per workflow di "pulizia generale notturna" che fa healthcheck ' +
      'completo. ' +
      'Report dettagliato per audit + compliance enterprise: ogni execution produce un report strutturato di ' +
      'cosa è stato fatto (record affected, righe inserted/updated/deleted, byte freed) salvabile come allegato ' +
      'email al CFO/DPO/admin per traceability; opzionale rollback transaction (tutte le modifiche in una ' +
      'transaction SQL — se qualcosa va male il rollback automatico ripristina lo stato pre-execution evitando ' +
      'dati corrotti). ' +
      'Use case business reali: pulizia notturna duplicati clienti CRM via trigger_cron daily 03:00 + ' +
      'action_janitor_cleanup mode=cycle (rilevamento duplicati per email/VAT + consolidamento campi nel ' +
      'master record + soft-delete dei duplicati con audit log); consolidamento contatti dopo import bulk ' +
      'da CSV legacy con anagrafica sporca (run manuale post-import del workflow di onboarding cliente); ' +
      'job scheduled di anonimizzazione record GDPR scaduti (10 anni di retention superati per dati fiscali, ' +
      '12 anni per atti societari — la regola Janitor sostituisce campi PII con hash deterministic preservando ' +
      'la chiave per analytics aggregati); audit-friendly cleanup con report scritto per compliance ISO 27001 ' +
      'che richiede documentazione delle data quality operations periodiche.',
    configFields: [
      {
        key: 'mode',
        label: 'Modalità',
        type: 'select',
        required: true,
        defaultValue: 'single',
        options: ['single', 'cycle'],
        help: 'single = scegli UNA regola sotto. cycle = esegui automaticamente TUTTE le regole abilitate per il tenant. Per il dettaglio delle regole disponibili, apri il pannello "🧹 Salute dati" dalla sidebar.',
      },
      {
        key: 'ruleId',
        label: 'ID Regola (solo modalità "single")',
        type: 'text',
        required: false,
        placeholder: 'system.runs.zombie',
        help: 'Identificatore stabile della regola da eseguire. Esempi built-in: system.runs.zombie, system.runs.corrupted_json, system.runs.truncated_steps, system.runs.orphan_checkpoint. Le DSL rule custom hanno id del tipo dsl_<nanoid>. Apri "🧹 Salute dati" → tab Regole per la lista completa.',
        showIf: { field: 'mode', equals: 'single' },
      },
      {
        key: 'dryRun',
        label: 'Dry-run (anteprima, non modifica nulla)',
        type: 'boolean',
        required: false,
        defaultValue: 'false',
        help: 'Quando attivo: la rule esegue la detection ma NON sposta righe in quarantena. Il flow procede con rowsDetected popolato ma rowsQuarantined=0. Utile per validare pre-prod. Default OFF (esecuzione live).',
      },
      {
        key: 'failOnDetection',
        label: 'Fallisci il nodo se trova corruzioni',
        type: 'boolean',
        required: false,
        defaultValue: 'false',
        help: 'Quando attivo: se rowsQuarantined > 0, il nodo va in status="error" (porta error fires). Per workflow di compliance che devono bloccarsi se trovano dati corrotti. Default OFF: il nodo procede sempre, l\'output rowsQuarantined è ispezionabile.',
      },
      {
        key: 'maxRowsPerRun',
        label: 'Limite righe per esecuzione',
        type: 'number',
        required: false,
        placeholder: 'usa il default della regola',
        help: 'Solo modalità "single". Override del maxRowsPerRun della regola. Lascia vuoto per usare il default configurato. Range: 1 — 100.000.',
        showIf: { field: 'mode', equals: 'single' },
      },
      {
        key: 'paramsOverride',
        label: 'Override parametri (JSON)',
        type: 'json',
        required: false,
        placeholder: '{"zombieThresholdMs": 600000}',
        help: 'Solo modalità "single". JSON object che sovrascrive i parametri specifici della regola per questa esecuzione. Esempio: {"zombieThresholdMs": 600000} per rendere "runs.zombie" più aggressiva (10 min invece di 30). Lascia vuoto per usare i parametri configurati.',
        showIf: { field: 'mode', equals: 'single' },
      },
      {
        key: 'tagFilter',
        label: 'Filtra per tag (CSV)',
        type: 'text',
        required: false,
        placeholder: 'critical,recovery',
        help: 'Solo modalità "cycle". CSV di tag — vengono eseguite solo le regole che hanno almeno uno di questi tag. Vuoto = tutte le regole abilitate.',
        showIf: { field: 'mode', equals: 'cycle' },
      },
    ],
    outputs: ['success', 'detection', 'clean', 'error'],
    branching: true,
    vendor: 'flowforge',
    version: '1.0.0',
  },
};
