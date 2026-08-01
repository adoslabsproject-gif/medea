/**
 * Un errore del motore, spiegato.
 *
 * I messaggi che arrivano da un esecutore sono scritti per chi ha scritto
 * l'esecutore: «ECONNREFUSED 127.0.0.1:5432», «Unexpected token < in JSON at
 * position 0». Dicono la verità e non dicono cosa fare.
 *
 * Qui si dà al modello l'errore **col suo contesto** — quale nodo, com'era
 * configurato, cosa gli era arrivato — e gli si chiede due cose sole: cosa è
 * successo e cosa provare. Senza il contesto risponderebbe con la spiegazione
 * generica del messaggio, che si trova già su internet.
 *
 * Il prompt chiede esplicitamente di **non inventare**: se dall'errore non si
 * capisce, deve dirlo. Una diagnosi sbagliata detta con sicurezza fa perdere
 * più tempo del messaggio grezzo.
 */

import { aiApi } from '../../ai/api';
import { activeProvider, providerConnection } from '../../ai/connection';

export interface DaSpiegare {
  nodeId: string;
  defId?: string;
  error: string;
  /** Come era configurato il nodo: spesso l'errore sta lì. */
  config?: Record<string, unknown>;
  /** Cosa gli era arrivato in ingresso. */
  input?: string;
}

/** Il segreto non deve arrivare al modello: si sostituisce, non si toglie. */
const CHIAVE_SENSIBILE = /pass(word)?|secret|token|api[_-]?key|credential|auth/i;

/**
 * La configurazione senza le credenziali.
 *
 * Mandare a un servizio esterno la password SMTP di qualcuno perché spieghi
 * un timeout sarebbe sproporzionato. I nomi dei campi restano — servono a
 * capire com'era fatto il nodo — spariscono solo i valori.
 */
export function ripulisci(config: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!config) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    out[key] =
      CHIAVE_SENSIBILE.test(key) && typeof value === 'string' && value ? '«nascosto»' : value;
  }
  return out;
}

export function buildPrompt(dati: DaSpiegare): string {
  return [
    'Un passo di un workflow è fallito. Spiega a chi lo ha disegnato — non a chi ha scritto il motore — cosa è successo e cosa provare.',
    '',
    `Nodo: ${dati.nodeId}${dati.defId ? ` (${dati.defId})` : ''}`,
    `Errore: ${dati.error}`,
    `Configurazione: ${JSON.stringify(ripulisci(dati.config))}`,
    ...(dati.input ? [`Ingresso ricevuto: ${dati.input.slice(0, 800)}`] : []),
    '',
    'Rispondi in italiano, in due parti brevi:',
    '1. COSA È SUCCESSO — una frase, senza gergo.',
    '2. COSA PROVARE — al massimo tre punti, concreti e riferiti a QUESTA configurazione.',
    '',
    "Se dall'errore non si capisce, dillo invece di indovinare: una diagnosi sbagliata detta con sicurezza fa perdere più tempo del messaggio grezzo.",
  ].join('\n');
}

/** Chiede al modello di spiegare. */
export async function explainError(dati: DaSpiegare): Promise<string> {
  const provider = activeProvider();
  const conn = await providerConnection(provider);

  const reply = await aiApi.chat({
    provider,
    systemPrompt: 'Sei un tecnico che aiuta chi disegna automazioni. Sei breve e non inventi.',
    history: [{ role: 'user', content: buildPrompt(dati) }],
    apiKey: conn.apiKey,
    baseUrl: conn.baseUrl,
    model: conn.model,
  });

  return reply.content.trim();
}
