/**
 * Requirement-coverage gate — ENFORCEMENT (non bypass).
 *
 * Il scaffold non basta che sia VALIDO: deve FARE quello che l'utente ha chiesto.
 * Estrae dal prompt le capability esplicitamente richieste — ognuna con un NODO
 * REALE che la soddisfa — e verifica che il workflow le copra. Se ne manca una →
 * reject + retry con feedback che dice ESATTAMENTE quale nodo aggiungere; all'ultimo
 * tentativo → warning prominente (non fallisce del tutto + non viene cachato).
 *
 * Differenza dalla 1ª bozza (scartata): allora "grafico" non aveva un nodo →
 * rigettare era un BYPASS. Ora `action_generate_chart` ESISTE (creato apposta),
 * quindi enforciare "usa il grafico" è legittimo: "se il prompt lo esige e il nodo
 * c'è, DEVI usarlo". Filosofia utente: niente bypass, e niente workflow a metà.
 *
 * REGOLA: enforciamo SOLO capability con un nodo che le soddisfa (no reject infinito).
 */

export interface CapabilitySpec {
  id: string;
  /** Etichetta per il feedback. */
  label: string;
  /** Nodo consigliato nel feedback di retry. */
  suggestNode: string;
  /** Se il prompt matcha → capability RICHIESTA (pattern specifici, anti-falso-positivo). */
  promptKeywords: RegExp;
  /** defId che SODDISFANO la capability. */
  satisfiedBy: RegExp;
}

export const ENFORCED_CAPABILITIES: readonly CapabilitySpec[] = [
  {
    id: 'chart',
    label: 'grafico / visualizzazione dati',
    suggestNode: 'action_generate_chart',
    promptKeywords:
      /(grafic|chart|diagramm|istogramm|\bgraph\b|a\s+torta|a\s+barre|andament\w*\s+(grafic|visual)|visualizz\w*\s+(i\s+)?dati)/i,
    satisfiedBy: /^action_generate_chart$/,
  },
  {
    id: 'db_query',
    label: 'interrogazione/confronto su database (storico)',
    suggestNode: 'db_query',
    promptKeywords:
      /(db[_\s-]?query|confront\w*\s+stor|settimana\s+scors|vs\.?\s+settimana|dati?\s+stor|interrog\w*\s+(il\s+)?(db|database)|query\s+(sul\s+)?(db|database))/i,
    satisfiedBy: /^db_(query|sql_query|subscribe)$/,
  },
  {
    id: 'db_persist',
    label: 'salvataggio dati su database',
    suggestNode: 'db_insert',
    promptKeywords:
      /(salv\w+\s+(su|nel|in)\s+(db|database|tabella)|inseris\w+\s+(nel|in)\s+(db|database|tabella)|registr\w+\s+(su|nel)\s+(db|database)|persist\w+\s+(i\s+)?dati)/i,
    satisfiedBy: /^db_(insert|insert_batch|update)$/,
  },
  {
    id: 'email',
    label: 'invio email',
    suggestNode: 'action_send_email',
    promptKeywords:
      /(invi\w*\s+(una?\s+)?(e-?mail|mail)|mand\w*\s+(una?\s+)?(e-?mail|mail)|notific\w*\s+via\s+(e-?mail|mail)|report\s+(via\s+)?(e-?mail|mail)|e-?mail\s+(di\s+)?(report|conferma|notifica|riepilogo))/i,
    satisfiedBy: /(send_email|email_send_tracked|email_personalize|webhook_respond)/,
  },
  {
    id: 'pdf',
    label: 'generazione PDF',
    suggestNode: 'action_pdf_generate',
    promptKeywords:
      /(gener\w*\s+(un\s+)?pdf|crea\w*\s+(un\s+)?pdf|report\s+pdf|fattura\s+pdf|documento\s+pdf|esport\w*\s+(in\s+)?pdf)/i,
    satisfiedBy: /^action_pdf_generate$/,
  },
  {
    /**
     * «dimmi», «avvisami», «fammi sapere».
     *
     * Chiesto due volte in questa sessione e disatteso due volte: il workflow
     * componeva il messaggio con un `action_text` e poi non lo consegnava a
     * nessuno. Il flusso finiva in silenzio — nessun errore, nessuna email,
     * e l'utente che aspettava una risposta mai arrivata.
     *
     * `action_text` NON soddisfa: comporre non è avvisare. Serve un nodo che
     * porti il messaggio a una persona.
     *
     * I termini sono all'imperativo e rivolti a chi scrive — «dimmi», non
     * «notifica» — perché «notifica» come sostantivo compare in mille contesti
     * e chiederebbe un canale dove non serve.
     */
    id: 'notifica',
    label: 'avvisare l’utente (il messaggio deve essere CONSEGNATO, non solo composto)',
    suggestNode: 'action_send_email',
    promptKeywords:
      /(dimmi|dammi\s+conferma|fammi\s+sapere|avvisa(mi|rmi)?\b|notifica(mi|rmi)\b|mandami|inviami|segnala(mi|rmi)\b|comunicami|informami|tienimi\s+aggiornat)/i,
    satisfiedBy:
      /(send_email|email_send_tracked|community_slack|community_telegram|community_discord|community_twilio|community_sendgrid|integration_slack_post|integration_telegram_send|whatsapp_send|webhook_respond|api_response)/,
  },
];

export interface MissingCapability {
  id: string;
  label: string;
  suggestNode: string;
}

/** Capability richieste dal prompt ma NON coperte dai nodi del workflow. */
export function extractMissingCapabilities(
  prompt: string,
  nodeDefIds: readonly string[],
): MissingCapability[] {
  const missing: MissingCapability[] = [];
  for (const cap of ENFORCED_CAPABILITIES) {
    if (!cap.promptKeywords.test(prompt)) continue;
    if (nodeDefIds.some((d) => cap.satisfiedBy.test(d))) continue;
    missing.push({ id: cap.id, label: cap.label, suggestNode: cap.suggestNode });
  }
  return missing;
}

export interface CapabilityInjection {
  node: { id: string; defId: string; config: Record<string, string> };
  edge: { from: string; to: string } | null;
}

/**
 * Refinement "l'ho fatto io per te" (NON un warning): all'ULTIMO tentativo,
 * inietta DETERMINISTICAMENTE il nodo mancante, cablato sui dati del nodo
 * terminale a monte, con config sensata (template che l'utente rifinisce).
 *
 * TUTTE le capability enforced sono iniettabili — niente più "ti manca X":
 * il nodo c'è, connesso, pronto. Ritorna null solo se non c'è alcun nodo a cui
 * agganciarlo (workflow vuoto).
 */
const CAPABILITY_INJECTORS: Record<
  string,
  (sourceId: string) => { defId: string; config: Record<string, string> }
> = {
  chart: (src) => ({
    defId: 'action_generate_chart',
    config: {
      chartType: 'bar',
      dataJson: `{{$node.${src}.json}}`,
      title: 'Grafico (auto)',
      labelField: 'label',
      valueField: 'value',
      outputFormat: 'dataUri',
    },
  }),
  db_query: () => ({
    defId: 'db_query',
    // Template di confronto storico — l'utente specifica tabella/colonne reali.
    config: {
      sql: "SELECT * FROM records WHERE created_at >= date('now','-7 days') ORDER BY created_at",
      databaseId: '{{secrets.DATABASE_ID}}',
    },
  }),
  db_persist: (src) => ({
    defId: 'db_insert',
    config: {
      table: 'records',
      rowJson: `{{$node.${src}.json}}`,
      databaseId: '{{secrets.DATABASE_ID}}',
    },
  }),
  email: (src) => ({
    defId: 'action_send_email',
    config: {
      systemAccountId: '{{secrets.EMAIL_ACCOUNT_ID}}',
      to: '{{secrets.NOTIFY_EMAIL}}',
      subject: 'Report automatico',
      body: `{{$node.${src}.json}}`,
      bodyType: 'html',
    },
  }),
  pdf: (src) => ({
    defId: 'action_pdf_generate',
    config: {
      title: 'Report',
      sectionsJson: `[{"heading":"Dati","body":"{{$node.${src}.json}}"}]`,
    },
  }),
};

export function buildCapabilityInjection(
  capId: string,
  nodes: readonly { id: string; defId: string }[],
  edges: readonly { from: string; to: string }[],
): CapabilityInjection | null {
  const make = CAPABILITY_INJECTORS[capId];
  if (!make) return null;
  // Sorgente dati = un nodo TERMINALE (nessun edge uscente) non-trigger; il nuovo
  // nodo si attacca dopo, consumandone l'output. Fallback: l'ultimo nodo.
  const hasOutgoing = new Set(edges.map((e) => e.from));
  const source =
    nodes.find((n) => !hasOutgoing.has(n.id) && !n.defId.startsWith('trigger_')) ??
    nodes[nodes.length - 1];
  if (!source) return null;
  const spec = make(source.id);
  const id = `${spec.defId}_auto`;
  return {
    node: { id, defId: spec.defId, config: spec.config },
    edge: { from: source.id, to: id },
  };
}

/** Feedback per il retry: dice ESATTAMENTE quale nodo aggiungere. */
export function buildCoverageFeedback(missing: readonly MissingCapability[]): string {
  if (missing.length === 0) return '';
  const lines = missing.map(
    (m) =>
      `- MANCA: ${m.label}. Il prompt la richiede esplicitamente. AGGIUNGI il nodo \`${m.suggestNode}\` e collegalo nel flusso.`,
  );
  return [
    `Workflow rejected — quality gate (requirement coverage): il workflow NON copre ${missing.length.toString()} capability ESPLICITAMENTE richieste:`,
    ...lines,
    'Rigenera includendo questi nodi, mantenendo il resto del flusso corretto.',
  ].join('\n');
}
