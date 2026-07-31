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

/**
 * Costruisce il canale verso il modello per l'agente.
 *
 * `claude-cli` resta fuori: la CLI in abbonamento esegue il proprio loop
 * agentico e non espone le chiamate a strumenti una per una, quindi non può
 * pilotare questo ciclo. Per quel provider la strada è esporre i workflow via
 * MCP, non usarlo qui.
 */
export async function createAgentChat(): Promise<AgentChat> {
  const provider = activeProvider();
  if (provider === 'claude-cli') {
    throw new Error(
      "Il provider «Claude (abbonamento)» non può pilotare l'agente dei workflow: " +
        'la CLI esegue un proprio ciclo. Scegli un altro provider in Impostazioni → Modelli AI.',
    );
  }

  const conn = await providerConnection(provider);

  return async ({ system, history, tools }) => {
    const reply = await aiApi.chat({
      provider,
      systemPrompt: system,
      history,
      apiKey: conn.apiKey,
      baseUrl: conn.baseUrl,
      model: conn.model,
      tools,
    });
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
