/**
 * Cosa vuole l'utente: parlare, o far costruire qualcosa.
 *
 * Senza questa distinzione ogni messaggio diventa un tentativo di costruire
 * un workflow — «ciao» compreso, che è come si finisce a bruciare quaranta
 * passi per rispondere a un saluto.
 *
 * La decisione la prende il modello, non un elenco di parole chiave: «togli
 * il passaggio dal database» è una richiesta di modifica e «cosa fa questo
 * nodo?» non lo è, ma nessuna euristica lo capisce guardando le parole.
 *
 * Costa una chiamata corta, e serve anche a un'altra cosa: l'assistente può
 * **rispondere** invece di dover per forza toccare il workflow.
 */

import { aiApi } from '../../ai/api';
import { activeProvider, providerConnection } from '../../ai/connection';
import type { Workflow } from '../types';

/** Il segnale con cui il modello chiede di costruire invece di rispondere. */
const BUILD_MARKER = 'COSTRUISCI:';

export type Intent = { kind: 'build'; goal: string } | { kind: 'reply'; text: string };

function describeWorkflow(workflow: Workflow): string {
  if (workflow.nodes.length === 0) return 'Il canvas è vuoto: non c’è ancora nessun workflow.';
  const nodes = workflow.nodes
    .map((n) => `- ${n.id} (${n.defId})${n.label ? ` «${n.label}»` : ''}`)
    .join('\n');
  const edges = workflow.edges
    .map((e) => `- ${e.from} → ${e.to}${e.fromPort ? ` [${e.fromPort}]` : ''}`)
    .join('\n');
  return [
    `Workflow aperto: «${workflow.name}»`,
    `Nodi:\n${nodes}`,
    workflow.edges.length > 0 ? `Collegamenti:\n${edges}` : 'Nessun collegamento.',
  ].join('\n\n');
}

function systemPrompt(workflow: Workflow): string {
  return [
    'Sei l’assistente di un editor di automazioni. Hai due modi di rispondere, e ne scegli uno.',
    '',
    `1. Se l’utente chiede di CREARE o MODIFICARE il workflow, rispondi con una riga sola:`,
    `   ${BUILD_MARKER} <l’obiettivo riscritto in modo completo e chiaro>`,
    '   Nient’altro: nessuna spiegazione, nessun saluto.',
    '',
    '2. Altrimenti — saluti, domande su cosa fa un nodo, richieste di spiegazione,',
    '   consigli, chiacchiere — rispondi normalmente, in italiano, breve.',
    '   In questo caso NON toccare il workflow e non usare il marcatore.',
    '',
    'Esempi:',
    '  «ciao» → una risposta normale, non una costruzione.',
    '  «cosa fa il nodo scarica?» → una spiegazione, non una costruzione.',
    `  «ogni mattina mandami il riepilogo» → ${BUILD_MARKER} ogni mattina scarica i dati e invia un riepilogo per email`,
    `  «togli il passaggio dal database» → ${BUILD_MARKER} rimuovi il nodo che scrive sul database e ricollega il flusso`,
    '',
    describeWorkflow(workflow),
  ].join('\n');
}

/**
 * Decide se rispondere o costruire.
 *
 * Se la chiamata al modello fallisce si ricade sulla costruzione: è quello
 * che l'utente si aspetta da un editor di workflow, e sbagliare in quella
 * direzione costa un tentativo, non una risposta sbagliata.
 */
export async function classify(
  message: string,
  workflow: Workflow,
  history: { role: 'user' | 'assistant'; text: string }[] = [],
): Promise<Intent> {
  const provider = activeProvider();

  try {
    const conn = await providerConnection(provider);
    const reply = await aiApi.chat({
      provider,
      systemPrompt: systemPrompt(workflow),
      history: [
        // Le ultime battute danno il contesto: «e anche su Telegram» si
        // capisce solo sapendo cosa si stava dicendo prima.
        ...history.slice(-4).map((m) => ({ role: m.role, content: m.text })),
        { role: 'user' as const, content: message },
      ],
      apiKey: conn.apiKey,
      baseUrl: conn.baseUrl,
      model: conn.model,
    });

    const text = reply.content.trim();
    const marker = text.indexOf(BUILD_MARKER);
    if (marker >= 0) {
      const goal = text.slice(marker + BUILD_MARKER.length).trim();
      return { kind: 'build', goal: goal || message };
    }
    return { kind: 'reply', text };
  } catch {
    return { kind: 'build', goal: message };
  }
}
