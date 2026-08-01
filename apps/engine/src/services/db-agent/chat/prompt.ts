/**
 * Costruzione del system prompt del DB-agent chat. Puro e snapshot-testabile.
 *
 * @module services/db-agent/chat/prompt
 */

export interface DbAgentPromptContext {
  /** Schema del DB selezionato già serializzato (tabelle + colonne).
   *  Presente in modalità DATABASE (un DB aperto). */
  schemaContext?: string;
  /** Panoramica dei database del workspace (nome · engine · #tabelle).
   *  Presente in modalità GLOBALE (DB Studio senza un DB selezionato) → Liara
   *  può elencare/creare un database da zero. Ha la precedenza su schemaContext. */
  databasesOverview?: string;
  /** Contesto opzionale del workflow corrente (se la chat è aperta sull'editor). */
  workflowContext?: string;
}

const PERSONA =
  'Sei Liara, l\'assistente DB di FlowForge. Operi ESCLUSIVAMENTE sui database del workspace dell\'utente corrente: non esistono, per te, database o tenant di altri. Rispondi in italiano, conciso e operativo.';
const TOOLS_RULES =
  'Strumenti: usa read_db_schema / run_select / run_sql per capire e leggere; per modificare lo schema preferisci preview_schema_plan (mostra l\'SQL) e POI apply_schema_plan (atomico). Per i dati: insert_row / update_rows / delete_rows.';
const SAFETY_RULES =
  'REGOLE: (1) prima di un cambiamento non banale, mostra l\'anteprima e spiega cosa farà. (2) Le operazioni distruttive (drop_table, drop_column, apply_schema_plan con drop, delete_rows, update_rows) richiedono la conferma esplicita prevista dallo strumento: NON inventare conferme, chiedi all\'utente. (3) run_sql è di SOLA LETTURA. (4) se uno strumento torna un errore, spiegalo all\'utente e proponi la correzione, non riprovare in loop.';

/**
 * System prompt: persona + confine tenant + regole d'uso degli strumenti.
 * NB: il confine tenant è garantito dal CODICE (executeDbAgentTool), non dal
 * prompt — qui lo si ribadisce solo per allineare il comportamento del modello.
 *
 * Due modalità:
 *  • DATABASE  (schemaContext): un DB è selezionato → lavora sul suo schema.
 *  • GLOBALE   (databasesOverview): DB Studio senza selezione → list_databases +
 *    create_database per partire da zero.
 */
export function buildDbAgentSystemPrompt(ctx: DbAgentPromptContext): string {
  const parts: string[] = [PERSONA, TOOLS_RULES, SAFETY_RULES];

  if (ctx.databasesOverview !== undefined) {
    parts.push(
      'MODALITÀ DB STUDIO (nessun database selezionato): puoi elencare i database del workspace (list_databases) e crearne di nuovi (create_database). Se l\'utente chiede un nuovo database, crealo e POI proponi di aggiungere le tabelle.',
      `[DATABASE DEL WORKSPACE]\n${ctx.databasesOverview}`,
    );
  } else {
    parts.push(`[SCHEMA DEL DATABASE SELEZIONATO]\n${ctx.schemaContext ?? ''}`);
  }

  if (ctx.workflowContext && ctx.workflowContext.trim().length > 0) {
    parts.push(`[WORKFLOW CORRENTE]\n${ctx.workflowContext}`);
  }
  return parts.join('\n\n');
}
