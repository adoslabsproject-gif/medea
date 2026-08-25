/**
 * GOLDEN EVAL SUITE del catalog retriever — la metrica che mancava.
 *
 * ~50 query REALI (IT/EN, il modo in cui gli utenti chiedono davvero) → il
 * defId atteso DEVE comparire nei top-10 del retrieval lessicale
 * (deterministico, embedder spento → CI stabile). Il run riporta OGNI miss
 * con la query e i top ottenuti: una modifica all'indice (tokenizer, alias,
 * boost, stopword) che degrada il recall FALLISCE qui con la lista esatta
 * delle query rotte — mai più tuning "a occhio".
 *
 * Regole di manutenzione:
 *   • recall atteso = 100%: se una query nuova fallisce, si corregge l'INDICE
 *     (searchAliases nel NodeDef / synonym map), non si abbassa la soglia.
 *   • `expectAnyOf` ammette più defId legittimi (es. "manda su slack" →
 *     community_slack O integration_slack_post): la query utente è ambigua,
 *     il retriever è corretto con uno qualsiasi.
 *   • Query in ITALIANO REALE prima di tutto: è la lingua dell'utenza.
 */
import { describe, it, expect } from 'vitest';
import { buildNodeCatalog } from '@/services/ai-scaffold/node-catalog.js';
import { CatalogRetriever } from './retriever.js';

const nullEmbedder = async (): Promise<number[] | null> => null;
const K = 10;

interface GoldenQuery {
  query: string;
  expectAnyOf: string[];
}

const GOLDEN: GoldenQuery[] = [
  // ── Code / n8n-speak (la classe del bug 2026-06-12) ──
  { query: 'creami un nodo code', expectAnyOf: ['action_run_js', 'action_run_python'] },
  { query: 'esegui uno script python', expectAnyOf: ['action_run_python'] },
  { query: 'aggiungi un function node', expectAnyOf: ['action_run_js'] },
  { query: 'esegui del codice javascript', expectAnyOf: ['action_run_js'] },
  { query: 'set fields sul risultato', expectAnyOf: ['logic_transform', 'action_set_fields'] },
  { query: 'split in batches', expectAnyOf: ['logic_loop'] },
  // ── Email ──
  { query: 'manda una mail al cliente', expectAnyOf: ['action_send_email'] },
  { query: 'invia una email con allegato', expectAnyOf: ['action_send_email'] },
  { query: 'quando arriva una email', expectAnyOf: ['trigger_imap'] },
  {
    query: 'valida che la email esista davvero',
    expectAnyOf: ['action_email_validate_mx', 'action_validate'],
  },
  // ── HTTP / web ──
  { query: 'chiama una api rest', expectAnyOf: ['action_http'] },
  { query: 'fai una richiesta http', expectAnyOf: ['action_http'] },
  {
    query: 'scarica una pagina web',
    expectAnyOf: ['action_fetch_url', 'action_web_fetch_advanced', 'action_http'],
  },
  {
    query: 'estrai dati da una pagina html',
    expectAnyOf: ['action_html_extract', 'agent_html_extractor', 'action_html_select'],
  },
  {
    query: 'fai web scraping del sito',
    expectAnyOf: ['action_scrape_smart', 'action_recursive_spider', 'action_sitemap_crawler'],
  },
  { query: 'cerca su internet', expectAnyOf: ['action_web_search'] },
  // ── Database ──
  { query: 'salva una riga nel database', expectAnyOf: ['db_insert', 'db_insert_batch'] },
  { query: 'interroga il database', expectAnyOf: ['db_query', 'db_sql_query'] },
  { query: 'aggiorna un record nel database', expectAnyOf: ['db_update'] },
  { query: 'cancella le righe vecchie dal db', expectAnyOf: ['db_delete'] },
  // ── Trigger ──
  { query: 'pianifica ogni giorno alle 8', expectAnyOf: ['trigger_cron'] },
  { query: 'quando arriva una richiesta webhook', expectAnyOf: ['trigger_webhook'] },
  { query: 'quando un form viene compilato', expectAnyOf: ['trigger_form'] },
  { query: 'leggi un feed rss', expectAnyOf: ['trigger_rss_feed'] },
  // Una risposta sola, e non per severità: `db_subscribe` era l'alternativa
  // ammessa qui, e non aveva né executor né watcher — sceglierlo dava un
  // workflow che non parte mai, in silenzio. Rimosso il 2026-08-06 (ADR 0010).
  { query: 'quando cambia una tabella del database', expectAnyOf: ['trigger_db_change'] },
  // ── Logic / flow ──
  { query: 'aggiungi una condizione if', expectAnyOf: ['logic_if'] },
  { query: 'switch su più casi', expectAnyOf: ['logic_switch'] },
  { query: 'unisci i rami paralleli', expectAnyOf: ['logic_merge'] },
  { query: 'join dei branch', expectAnyOf: ['logic_merge'] },
  { query: 'esegui un ciclo per ogni elemento', expectAnyOf: ['logic_loop'] },
  { query: 'aspetta 5 minuti', expectAnyOf: ['logic_delay', 'logic_wait'] },
  { query: 'trasforma i dati con jsonata', expectAnyOf: ['logic_transform'] },
  { query: 'filtra gli ordini sopra 100 euro', expectAnyOf: ['action_filter', 'logic_if'] },
  { query: 'rimuovi i duplicati dalla lista', expectAnyOf: ['logic_distinct', 'action_array'] },
  { query: 'ordina la lista per prezzo', expectAnyOf: ['action_array', 'logic_group_by'] },
  { query: 'raggruppa per categoria', expectAnyOf: ['logic_group_by', 'action_array'] },
  // ── File / formati ──
  { query: 'leggi un file csv', expectAnyOf: ['action_csv', 'action_file_read'] },
  { query: 'estrai il testo da un pdf', expectAnyOf: ['action_pdf_parse'] },
  { query: 'genera un pdf', expectAnyOf: ['action_pdf_generate'] },
  { query: 'leggi un file excel', expectAnyOf: ['action_xlsx_parse'] },
  { query: 'scrivi su un file', expectAnyOf: ['action_file_write'] },
  // ── Agent / AI ──
  { query: 'riassumi il testo', expectAnyOf: ['agent_summarizer'] },
  { query: 'traduci in inglese', expectAnyOf: ['agent_translator'] },
  {
    query: 'classifica i messaggi in categorie',
    expectAnyOf: ['agent_classifier', 'agent_intent_router'],
  },
  { query: 'estrai i campi strutturati dal testo', expectAnyOf: ['agent_extractor'] },
  {
    query: 'chiama un llm con un prompt',
    expectAnyOf: ['action_llm_complete', 'ai_agent_tool_loop'],
  },
  { query: 'cerca nella knowledge base', expectAnyOf: ['rag_search', 'ai_rag_search'] },
  // ── Integrazioni ──
  {
    query: 'invia un messaggio su slack',
    expectAnyOf: ['community_slack', 'integration_slack_post'],
  },
  {
    query: 'notifica su telegram',
    expectAnyOf: ['community_telegram', 'integration_telegram_send'],
  },
  { query: 'crea un issue su github', expectAnyOf: ['community_github'] },
  { query: 'aggiungi una riga su google sheets', expectAnyOf: ['community_google_sheets'] },
  { query: 'crea una pagina su notion', expectAnyOf: ['community_notion'] },
  { query: 'manda un sms', expectAnyOf: ['community_twilio'] },
  // ── Utility ──
  { query: 'valida una partita iva', expectAnyOf: ['action_validate'] },
  { query: 'genera un uuid', expectAnyOf: ['action_uuid'] },
  { query: 'formatta una data', expectAnyOf: ['action_date_format', 'action_datetime'] },
  { query: 'firma un token jwt', expectAnyOf: ['action_jwt'] },
  { query: 'rispondi alla richiesta del webhook', expectAnyOf: ['action_webhook_respond'] },
  { query: 'genera un grafico', expectAnyOf: ['action_generate_chart'] },
];

describe('🏆 GOLDEN EVAL — recall@10 del retriever lessicale', () => {
  it(`tutte le ${String(GOLDEN.length)} golden query trovano il defId atteso nei top-${String(K)}`, async () => {
    const catalog = buildNodeCatalog();
    const r = new CatalogRetriever(catalog, nullEmbedder);
    const misses: string[] = [];
    for (const g of GOLDEN) {
      const top = await r.retrieve(g.query, { lexicalOnly: true, k: K });
      const ids = top.map((n) => n.defId);
      if (!g.expectAnyOf.some((id) => ids.includes(id))) {
        misses.push(
          `"${g.query}" → atteso uno di [${g.expectAnyOf.join(', ')}], top-${String(K)}: [${ids.join(', ')}]`,
        );
      }
    }
    const recall = (GOLDEN.length - misses.length) / GOLDEN.length;
    expect(
      misses,
      `recall@${String(K)} = ${(recall * 100).toFixed(1)}% — query fallite:\n${misses.join('\n')}`,
    ).toEqual([]);
  });
});
