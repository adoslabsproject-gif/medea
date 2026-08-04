/**
 * Ponte fra l'agente dei workflow e il provider configurato.
 *
 * L'agente ragiona in termini di strumenti e non sa nulla di OpenAI o
 * Anthropic: la traduzione nei rispettivi formati avviene nel backend Rust,
 * che espone un'unica forma normalizzata. Qui si mettono solo insieme le
 * credenziali e si adatta la firma.
 */

import { aiApi } from '../../ai/api';
import { activeProvider, providerConnection } from '../../ai/connection';

import type { AgentChat } from './agent';
import type { ScaffoldLlm } from './run';

/**
 * Costruisce il canale verso il modello per l'agente.
 *
 * `claude-cli` resta fuori: la CLI in abbonamento esegue il proprio loop
 * agentico e non espone le chiamate a strumenti una per una, quindi non può
 * pilotare questo ciclo. Per quel provider la strada è esporre i workflow via
 * MCP, non usarlo qui.
 */
/**
 * Il modello nella forma che serve alla generazione in una volta sola.
 *
 * È l'altra strada per costruire un workflow, e per molti modelli è l'unica
 * praticabile: invece di chiedere di *pilotare* la costruzione chiamando
 * strumenti a ogni passo, si chiede di *scriverlo* — un JSON conforme allo
 * schema, in una risposta. Qualunque modello sa scrivere; non tutti sanno
 * chiamare strumenti nel formato che ci aspettiamo.
 */
export async function createScaffoldLlm(
  onTokens?: (usati: { input: number; output: number }) => void,
): Promise<ScaffoldLlm> {
  const provider = activeProvider();
  const conn = await providerConnection(provider);
  const requestId = `singleshot-${String(Date.now())}`;

  return {
    // Adesso l'output vincolato c'è: lo schema viaggia nella richiesta e il
    // server lo fa rispettare token per token. Il modello non può rispondere
    // con un discorso, né restituire lo schema al posto dei dati — erano i
    // due modi in cui falliva.
    //
    // La riparazione resta: vincolare la *forma* non garantisce che i defId
    // esistano o che i campi abbiano senso, e per quello servono i controlli.
    supportsStructuredOutput: true,
    isTuned: provider === 'liara',
    async complete({ system, user, schema }) {
      const reply = await aiApi.chat({
        provider,
        systemPrompt: system,
        history: [{ role: 'user', content: user }],
        apiKey: conn.apiKey,
        baseUrl: conn.baseUrl,
        model: conn.model,
        requestId,
        jsonSchema: schema as Record<string, unknown>,
      });
      if (reply.usage) onTokens?.(reply.usage);
      return reply.content;
    },
  };
}

export async function createAgentChat(
  /** Chiamata dopo ogni risposta con quanti token è costata, se il provider
   *  lo dichiara. Serve a mostrare il conto mentre l'agente lavora. */
  onTokens?: (usati: { input: number; output: number }) => void,
): Promise<AgentChat> {
  const provider = activeProvider();
  if (provider === 'claude-cli') {
    throw new Error(
      "Il provider «Claude (abbonamento)» non può pilotare l'agente dei workflow: " +
        'la CLI esegue un proprio ciclo. Scegli un altro provider in Impostazioni → Modelli AI.',
    );
  }

  const conn = await providerConnection(provider);

  // Un nome per il ciclo, così `stop` può fermare la chiamata in volo e non
  // solo smettere di aspettarla.
  const requestId = `scaffold-${String(Date.now())}`;

  return async ({ system, history, tools }) => {
    const reply = await aiApi.chat({
      provider,
      systemPrompt: system,
      history,
      apiKey: conn.apiKey,
      baseUrl: conn.baseUrl,
      model: conn.model,
      tools,
      requestId,
    });
    if (reply.usage) onTokens?.(reply.usage);
    return {
      content: reply.content,
      toolCalls: reply.toolCalls.map((c) => ({
        id: c.id,
        name: c.name,
        arguments: c.arguments,
      })),
    };
  };
}
