/**
 * Un nodo che elabora un contenuto che non gli arriva mai.
 *
 * Il 2026-08-06 il wizard ha consegnato «riassunto_serale» così:
 *
 *     trigger_cron → agent_summarizer → slack, database
 *
 * Nessun nodo legge la posta. Il cron produce un istante; il riassuntore
 * avrebbe riassunto quello, senza errori, e il testo sarebbe partito via
 * email. È il difetto che nessun controllo di forma può vedere: il grafo è
 * connesso, i campi obbligatori ci sono, le espressioni sono scritte bene.
 *
 * La regola gemella sta nel motore (`rule-niente-da-elaborare.ts`), dove
 * rifiuta e fa rigenerare. Qui serve a chi disegna a mano: il canvas non deve
 * accettare in silenzio quello che il generatore rifiuta.
 *
 * ── Perché non blocca lavoro legittimo ──
 *
 * Non indovina il senso: usa due fatti dichiarati nel catalogo. Un nodo `ai`
 * senza `prompt` né `goal` non porta con sé la cosa su cui lavorare. Un
 * `trigger_cron` dichiara di produrre un istante e nient'altro. Scatta solo
 * quando TUTTA la catena a monte è fatta di quei trigger: basta un
 * `action_fetch_url` o un `trigger_imap` in mezzo e tace.
 *
 * @module features/workflows/quality/rules-materia
 */

import { buildAncestors } from './graph';
import type { QualityGateInput, QualityIssue } from './types';

/**
 * I campi con cui un nodo si porta dietro la propria materia.
 *
 * Due soli di proposito: `instruction` o `schema` dicono COSA estrarre, non DA
 * COSA — chi li ha il contenuto lo aspetta lo stesso.
 */
const CAMPI_CHE_PORTANO_LA_MATERIA: ReadonlySet<string> = new Set(['prompt', 'goal']);

/**
 * I trigger che non producono niente su cui lavorare.
 *
 * Solo il cron, e solo perché il suo contratto lo dice per esteso. Ogni altro
 * trigger porta un messaggio, un record, un evento — cioè qualcosa.
 * `trigger_manual` resta fuori: chi avvia a mano può incollare il testo.
 */
const TRIGGER_SENZA_CONTENUTO: ReadonlySet<string> = new Set(['trigger_cron']);

export function checkNienteDaElaborare(input: QualityGateInput): QualityIssue[] {
  const issues: QualityIssue[] = [];
  const defIdPerNodo = new Map(input.nodes.map((n) => [n.id, n.defId]));

  for (const node of input.nodes) {
    const def = input.defs?.get(node.defId);
    // Senza la definizione non si può sapere se aspetta un contenuto: meglio
    // tacere che sbagliare.
    if (!def) continue;
    if (def.type !== 'ai') continue;
    if ((def.configFields ?? []).some((f) => CAMPI_CHE_PORTANO_LA_MATERIA.has(f.key))) continue;

    const monte = buildAncestors(node.id, input.edges);
    // Nessun antenato è un caso diverso — un nodo scollegato — e ha già il suo
    // controllo.
    if (monte.size === 0) continue;

    const tuttiSterili = [...monte].every((id) => {
      const defId = defIdPerNodo.get(id);
      return defId !== undefined && TRIGGER_SENZA_CONTENUTO.has(defId);
    });
    if (!tuttiSterili) continue;

    issues.push({
      severity: 'critical',
      code: 'NIENTE_DA_ELABORARE',
      nodeId: node.id,
      message:
        `"${node.id}" lavora sul contenuto che riceve, ma a monte c'è solo un trigger a tempo, ` +
        'che produce un istante e nient’altro: elaborerebbe l’orario in cui è scattato, e lo ' +
        'farebbe senza errori. Metti fra i due il nodo che procura il contenuto — la posta da ' +
        'leggere, la pagina da scaricare, la query da eseguire.',
    });
  }
  return issues;
}
