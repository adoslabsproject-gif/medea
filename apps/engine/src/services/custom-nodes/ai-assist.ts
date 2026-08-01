/**
 * Custom Node Editor — AI Assist via Liara gateway.
 *
 * 5 azioni AI con prompt template ottimizzati per il custom-node context:
 *   - generate:  prompt → 3 file TS (executor + definition + schema)
 *   - explain:   selected code → spiegazione naturale
 *   - fix:       diagnostic + source → patch suggerito
 *   - test:      source → test cases generati
 *   - refactor:  source + goal → riscrittura migliorata
 *
 * Pattern: il client editor chiama l'endpoint runtime POST /ai-assist; il
 * runtime costruisce il prompt + lo invia al gateway Liara via safeOutboundFetch
 * (URL `LLM_API_BASE`). Risposta streaming/JSON delegata al gateway.
 *
 * Auth: l'endpoint runtime è owner-only (già enforced dal middleware
 * route-level). Il gateway Liara riceve `X-FF-Workspace` header per quota
 * + rate limit per-tenant.
 *
 * @module services/custom-nodes/ai-assist
 */

import { logger } from '@/lib/logger.js';
import { gatewayChatCompletions } from './llm-gateway.js';

export type AiAssistAction = 'generate' | 'explain' | 'fix' | 'test' | 'refactor' | 'chat';

export interface AiAssistRequest {
  action: AiAssistAction;
  /** Prompt utente — quello che l'utente ha scritto nel textarea sidebar. */
  prompt?: string;
  /** Codice corrente da spiegare/fixare/testare/refactorare. */
  sources?: {
    executor: string;
    definition: string;
    schema: string;
  };
  /** Selezione attiva (testo selezionato nell'editor). */
  selectedText?: string;
  /** Diagnostic di compile (per fix). */
  diagnostic?: {
    message: string;
    line: number;
    file: 'executor' | 'definition' | 'schema';
  };
  workspaceId: string;
  /**
   * Contesto cross-surface (cosa l'utente stava facendo nelle altre schede del
   * workspace, es. il workflow editor). Iniettato nel system prompt così Liara
   * "ricorda" senza che l'utente rispieghi. Costruito dalla route (read-only).
   */
  crossSurfaceContext?: string;
}

export interface AiAssistResponse {
  /** Risposta naturale (markdown). */
  text: string;
  /** Se l'AI ha generato/modificato i 3 file, vengono qui — applicabili come patch. */
  patch?: {
    executor?: string;
    definition?: string;
    schema?: string;
  };
  /** Token consumati (dal gateway). */
  tokens?: { input: number; output: number };
}


const SYSTEM_PROMPT = `Sei un assistente specializzato nello sviluppo di custom nodes per FlowForge — una piattaforma SaaS di workflow automation enterprise.

Un custom node consiste in 3 file TypeScript:
- executor.ts: funzione async che riceve (config, input, context) e ritorna l'output
- definition.ts: metadata + lista config fields per il form UI
- schema.ts: validazione Zod di config e output

SDK disponibili (import statici):
- 'zod' → z.object({...}), z.string(), z.number(), z.enum([...])
- '@flowforge/safe-fetch' → safeFetch(url, { timeoutMs, ... }) — HTTP SSRF-safe
- '@flowforge/community-node-sdk' → tipi NodeDefinition, NodeExecutor

Regole inviolabili:
- VIETATO: require(), eval(), new Function(), child_process, process.env, node:fs/net/os/vm
- USA static imports — dynamic import() vietato per sicurezza sandbox
- Tutte le HTTP via safeFetch (no fetch globale)
- TypeScript strict; nessun \`any\` implicito

Rispondi in italiano. Quando generi codice, mettilo in fence \`\`\`ts.
Quando proponi modifiche complete a un file, marca il blocco con: \`\`\`ts:executor (o :definition / :schema)`;

function buildUserPrompt(req: AiAssistRequest): string {
  switch (req.action) {
    case 'generate':
      return [
        '# Task: genera un nuovo custom node',
        '',
        `Richiesta utente: ${req.prompt ?? '(vuota)'}`,
        '',
        'Genera i 3 file TS (executor, definition, schema) coerenti.',
        'Restituiscili in 3 fence:',
        '```ts:executor',
        '...',
        '```',
        '```ts:definition',
        '...',
        '```',
        '```ts:schema',
        '...',
        '```',
      ].join('\n');

    case 'explain':
      return [
        '# Task: spiega il codice',
        '',
        `Codice (file ${req.diagnostic?.file ?? 'executor'}):`,
        '```ts',
        req.selectedText ?? req.sources?.executor ?? '(vuoto)',
        '```',
        '',
        `${req.prompt ? `Focus: ${req.prompt}` : 'Spiega cosa fa, riga per riga se complesso.'}`,
      ].join('\n');

    case 'fix': {
      const file = req.diagnostic?.file ?? 'executor';
      const sourceForFile = req.sources?.[file] ?? '(vuoto)';
      return [
        '# Task: proponi un fix',
        '',
        `Diagnostic: ${req.diagnostic?.message ?? 'errore non specificato'} (riga ${String(req.diagnostic?.line ?? 0)})`,
        '',
        `File ${file}:`,
        '```ts',
        sourceForFile,
        '```',
        '',
        'Rispondi:',
        '1. Una breve spiegazione del problema (1-2 frasi).',
        '2. Il file completo corretto in un fence `'+'``ts:'+file+'`'+'``.',
      ].join('\n');
    }

    case 'test':
      return [
        '# Task: genera test cases',
        '',
        'Executor corrente:',
        '```ts',
        req.sources?.executor ?? '(vuoto)',
        '```',
        '',
        'Genera 3-5 test cases JSON nel formato:',
        '```json',
        '[',
        '  { "name": "happy path", "input": {...}, "config": {...}, "expectedOutput": {...} },',
        '  { "name": "edge case", ... }',
        ']',
        '```',
      ].join('\n');

    case 'refactor':
      return [
        '# Task: refactor del codice',
        '',
        `Obiettivo: ${req.prompt ?? 'rendi più leggibile e robusto'}`,
        '',
        'Executor corrente:',
        '```ts',
        req.sources?.executor ?? '(vuoto)',
        '```',
        '',
        'Rispondi con:',
        '1. Una nota breve su cosa hai cambiato.',
        '2. Il file completo riscritto in `'+'``ts:executor`'+'``.',
      ].join('\n');

    case 'chat':
      return [
        '# Conversazione sul custom node',
        '',
        'I 3 file CORRENTI del nodo (contesto — NON ripeterli se non servono):',
        '```ts:executor', req.sources?.executor ?? '(vuoto)', '```',
        '```ts:definition', req.sources?.definition ?? '(vuoto)', '```',
        '```ts:schema', req.sources?.schema ?? '(vuoto)', '```',
        '',
        `Messaggio dell'utente: ${req.prompt ?? '(vuoto)'}`,
        '',
        'Rispondi in modo CONVERSAZIONALE, conciso e in italiano (saluti, domande,',
        'spiegazioni a parole). Applica modifiche al codice SOLO se l\'utente lo',
        'chiede ESPLICITAMENTE: in quel caso, e solo allora, emetti i file completi',
        'nei fence ```ts:executor / ```ts:definition / ```ts:schema. Altrimenti',
        'NON emettere codice.',
      ].join('\n');
  }
}

/**
 * Estrae blocchi di codice dai fence marcati `:executor` / `:definition` / `:schema`.
 * Ritorna un patch parziale (solo i file effettivamente generati dall'AI).
 */
export function extractPatchFromMarkdown(md: string): AiAssistResponse['patch'] {
  const patch: { executor?: string; definition?: string; schema?: string } = {};
  const re = /```ts:(executor|definition|schema)\s*\n([\s\S]*?)\n```/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(md)) !== null) {
    const file = m[1] as 'executor' | 'definition' | 'schema';
    const code = m[2]!;
    patch[file] = code;
  }
  return Object.keys(patch).length > 0 ? patch : undefined;
}

/**
 * Chiama il gateway Liara per l'AI assist.
 * Throws su HTTP error o gateway down — il caller decide se fallback.
 */
export async function callAiAssist(req: AiAssistRequest): Promise<AiAssistResponse> {
  // Routing via GATEWAY PORTAL centralizzato in llm-gateway.ts (i container
  // tenant NON raggiungono liara:3003). Throws su HTTP error → la route 500.
  // Timeout 240s: Qwen3 thinking + explain/refactor coi sorgenti interi supera i
  // 60s, specie con la GPU in coda.
  const messages: { role: string; content: string }[] = [{ role: 'system', content: SYSTEM_PROMPT }];
  if (req.crossSurfaceContext && req.crossSurfaceContext.trim().length > 0) {
    messages.push({ role: 'system', content: req.crossSurfaceContext });
  }
  messages.push({ role: 'user', content: buildUserPrompt(req) });

  const r = await gatewayChatCompletions({
    messages,
    temperature: 0.2,
    maxTokens: 2048,
    timeoutMs: Number(process.env.FLOWFORGE_LIARA_TIMEOUT_MS ?? '240000'),
    workspaceId: req.workspaceId,
    ...(process.env.LLM_AI_ASSIST_MODEL ? { modelOverride: process.env.LLM_AI_ASSIST_MODEL } : {}),
  });

  if (!r.ok) {
    logger.error({ status: r.status }, '[ai-assist] gateway error');
    throw new Error(`Liara gateway HTTP ${String(r.status)}`);
  }

  const patch = extractPatchFromMarkdown(r.content);
  const result: AiAssistResponse = { text: r.content };
  if (patch) result.patch = patch;
  if (r.usage.input > 0 || r.usage.output > 0) {
    result.tokens = { input: r.usage.input, output: r.usage.output };
  }
  return result;
}
