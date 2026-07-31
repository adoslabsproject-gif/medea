/** Tool registry — wrapper TS verso i command Rust.
 *
 *  Protocollo (allineato all'app Liara, percorso cloud):
 *  - i tool sono passati al modello con il **tool-use nativo OpenAI**
 *    (`tools: [{type:"function", function:{name, description, parameters}}]`);
 *  - il modello risponde con `tool_calls`, oppure — se è un fine-tuned che
 *    scrive i marker nel testo — con `<tool_call>{"name":…,"arguments":…}`,
 *    che il backend riconosce e normalizza allo stesso formato;
 *  - i risultati rientrano nella history come turni `role: "tool"`.
 *
 *  Niente simulazione: un tool inesistente ritorna un errore esplicito.
 */

import { invoke } from '@tauri-apps/api/core';

/** `read` = nessun effetto · `write` = scrive in locale ·
 *  `sensitive` = scrive e richiede conferma utente ·
 *  `proposal` = produce una card che l'utente deve confermare. */
export type ToolKind = 'read' | 'write' | 'sensitive' | 'proposal';

export interface ToolDescriptor {
  name: string;
  description: string;
  params: Record<string, unknown>;
  kind: ToolKind;
  example: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ToolCallResult {
  call: ToolCall;
  /** `null` se l'esecuzione è fallita o è stata negata dall'utente. */
  result: unknown;
  error: string | null;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
}

let cachedRegistry: ToolDescriptor[] | null = null;

export async function listTools(): Promise<ToolDescriptor[]> {
  if (cachedRegistry) return cachedRegistry;
  cachedRegistry = await invoke<ToolDescriptor[]>('ai_tools_list');
  return cachedRegistry;
}

/** Schema dei tool nel formato che il modello si aspetta (OpenAI function). */
export function toOpenAiTools(tools: ToolDescriptor[]): Record<string, unknown>[] {
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.params,
    },
  }));
}

export async function callTool(call: ToolCall): Promise<ToolCallResult> {
  const startedAt = new Date().toISOString();
  const t0 = performance.now();
  const base = { call, startedAt };
  try {
    const result = await invoke<unknown>('ai_tools_call', { name: call.name, args: call.args });
    return {
      ...base,
      result,
      error: null,
      finishedAt: new Date().toISOString(),
      durationMs: Math.round(performance.now() - t0),
    };
  } catch (e) {
    return {
      ...base,
      result: null,
      error: String(e),
      finishedAt: new Date().toISOString(),
      durationMs: Math.round(performance.now() - t0),
    };
  }
}

/** Descrizione leggibile dell'azione, mostrata nella richiesta di conferma. */
export function consentAction(call: ToolCall, tool: ToolDescriptor | undefined): string {
  const a = call.args;
  const val = (k: string) => {
    const v = a[k];
    switch (typeof v) {
      case 'string':
        return v;
      case 'number':
      case 'bigint':
      case 'boolean':
        return v.toString();
      case 'undefined':
        return '';
      default:
        return v === null ? '' : JSON.stringify(v);
    }
  };
  switch (call.name) {
    case 'customer_update':
      return `aggiornare l'anagrafica del cliente #${val('id')}`;
    case 'customer_classify':
      return `classificare l'organizzazione #${val('id')} come ${val('role')}`;
    case 'pricing_set_override':
      return `impostare il prezzo dedicato di ${val('articleCode')} a ${val('unitPrice')} per il cliente #${val('customerId')}`;
    case 'discount_set':
      return `impostare uno sconto del ${val('discountPct')}% per il cliente #${val('customerId')}`;
    case 'article_create':
      return `creare l'articolo ${val('code')}`;
    case 'article_update':
      return `modificare l'articolo ${val('code')}`;
    case 'article_bulk_update':
      return `modificare in blocco ${Array.isArray(a.codes) ? a.codes.length : '?'} articoli`;
    case 'document_create_quote':
      return `registrare un preventivo per il cliente #${val('customerId')}`;
    case 'document_create_order':
      return `registrare un ordine (${val('direction')}) per il cliente #${val('customerId')}`;
    default:
      return tool?.description ?? `eseguire ${call.name}`;
  }
}
