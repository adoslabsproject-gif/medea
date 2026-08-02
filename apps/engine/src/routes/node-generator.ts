import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { NodeGeneratorService, type GeneratedNode } from '@/services/node-generator.service.js';
import { logger } from '@/lib/logger.js';
import { AIInteractionsService } from '@/services/ai-interactions.service.js';
import { llmRateLimit } from '@/middleware/rate-limit.js';
import { requireRole } from '@/middleware/rbac.js';
import { getTenantId } from '@/lib/tenant.js';
import { llmResolver, NoLlmProviderError } from '@/services/llm-resolver.service.js';
import { dispatchLLMChat, dispatchLLMChatStreaming } from '@/services/llm-chat.service.js';
import type {
  ILLMProvider,
  LLMCompletionRequest,
  LLMCompletionResponse,
  LLMStreamChunk,
} from '@/ports/llm-provider.js';

/**
 * Provider-agnostic dispatcher adapter — exposes the ILLMProvider interface
 * over the multi-provider `dispatchLLMChat`. Avoids hardcoding any single
 * vendor (Anthropic, OpenAI, Liara, OpenRouter, Gemini, Mistral, Groq, Ollama
 * all flow through the same code path). NodeGeneratorService consumes only
 * the abstract interface so callers can swap the underlying provider via the
 * tenant's resolved preferences without touching this file.
 */
class ResolvedLLMProvider implements ILLMProvider {
  readonly name: string;
  constructor(
    private readonly provider: string,
    private readonly apiKey: string,
    private readonly model: string,
  ) {
    this.name = provider;
  }

  /** Scompone i messaggi del request nel formato (system, user, history) atteso
   *  dal dispatcher multi-provider. Condiviso da complete() e stream(). */
  private split(req: LLMCompletionRequest): {
    system: string;
    user: string;
    history: { role: 'user' | 'assistant'; content: string }[];
  } {
    const systemMsg = req.messages.find((m) => m.role === 'system');
    const userMsgs = req.messages.filter((m) => m.role !== 'system');
    const last = userMsgs[userMsgs.length - 1];
    const history = userMsgs
      .slice(0, -1)
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));
    return { system: systemMsg?.content ?? '', user: last?.content ?? '', history };
  }

  async complete(req: LLMCompletionRequest): Promise<LLMCompletionResponse> {
    const { system, user, history } = this.split(req);
    const text = await dispatchLLMChat(
      this.provider,
      this.apiKey,
      req.model || this.model,
      system,
      user,
      undefined,
      history,
    );
    return { text, finishReason: 'stop' };
  }

  /**
   * Streaming reale token-by-token attraverso il dispatcher multi-provider
   * (`dispatchLLMChatStreaming`). Per Liara → SSE vLLM; per gli altri provider
   * → fallback non-streaming + un singolo chunk col testo intero.
   *
   * Adattatore PUSH→PULL: il dispatcher consegna i delta via callback (push),
   * mentre `AsyncIterable` è pull. Una coda con segnale di wake-up fa da ponte
   * senza perdere chunk né wake-up (l'executor del Promise assegna `wake`
   * sincronicamente prima di sospendere).
   */
  async *stream(req: LLMCompletionRequest): AsyncIterable<LLMStreamChunk> {
    const { system, user, history } = this.split(req);
    // Canale push→pull: i delta e il segnale di fine (`end`, con eventuale
    // errore) sono ITEM nel buffer — niente flag booleano mutato in closure
    // (che il control-flow di TS/eslint non vedrebbe). `length` è una
    // condizione runtime reale.
    type Item = { kind: 'delta'; value: string } | { kind: 'end'; error?: unknown };
    const buffer: Item[] = [];
    let notify: (() => void) | null = null;
    const push = (item: Item): void => {
      buffer.push(item);
      const n = notify;
      notify = null;
      if (n) n();
    };

    // Fire-and-forget: il .then con DUE handler garantisce che la promise non
    // rigetti mai (no unhandled rejection); l'errore arriva come item `end`.
    void dispatchLLMChatStreaming(
      this.provider,
      this.apiKey,
      req.model || this.model,
      system,
      user,
      undefined,
      history,
      (delta) => {
        push({ kind: 'delta', value: delta });
      },
    ).then(
      () => {
        push({ kind: 'end' });
      },
      (error: unknown) => {
        push({ kind: 'end', error });
      },
    );

    for (;;) {
      const item = buffer.shift();
      if (item === undefined) {
        // Coda vuota: sospendi finché un push non risveglia. L'executor assegna
        // `notify` sincronicamente prima del suspend → nessun wake-up perso.
        await new Promise<void>((resolve) => {
          notify = resolve;
        });
        continue;
      }
      if (item.kind === 'delta') {
        yield { delta: item.value, done: false };
        continue;
      }
      // kind === 'end'
      if (item.error !== undefined) {
        throw item.error instanceof Error
          ? item.error
          : new Error('Node generation stream failed.');
      }
      yield { delta: '', done: true, finishReason: 'stop' };
      return;
    }
  }
}

const GenerateNodeSchema = z.object({
  description: z.string().min(10).max(2000),
  openApiUrl: z.string().url().optional(),
  language: z.enum(['it', 'en']).optional(),
  // Opt-in streaming SSE: progressione token-by-token (eventi delta/done/error).
  // Default false → risposta JSON sincrona (retrocompatibile con l'API pubblica).
  stream: z.boolean().optional(),
});

/** id del nodo generato (per il messaggio dell'audit). NodeDef.id è validato
 *  non-vuoto da parseLLMResponse, quindi è sempre una stringa. */
function generatedNodeId(result: GeneratedNode): string {
  return result.def.id;
}

/** "forbidden"/"validation" nel messaggio → 422 (client error), altrimenti 500. */
function errorStatus(message: string): 422 | 500 {
  return message.includes('forbidden') || message.includes('validation') ? 422 : 500;
}

interface RecordArgs {
  tenantId: string;
  userId?: string;
  prompt: string;
  result: GeneratedNode;
  modelLabel: string;
  latencyMs: number;
}

/** Persiste l'interazione AI (audit + analytics) e ritorna l'interactionId.
 *  Condiviso dal path JSON e da quello SSE. */
function recordGeneration(capture: AIInteractionsService, a: RecordArgs): string | null {
  return capture.insert({
    context: { tenantId: a.tenantId, ...(a.userId ? { userId: a.userId } : {}) },
    interactionType: 'node_generate',
    request: { prompt: a.prompt },
    response: {
      message: `Generated node: ${generatedNodeId(a.result)}`,
      patch: a.result,
      model: a.modelLabel,
      latencyMs: a.latencyMs,
    },
  });
}

export function createNodeGeneratorRoutes(): Hono {
  const app = new Hono();

  // OWNER-ONLY come tutto il sottosistema custom-node (custom-nodes/community-nodes sono
  // requireRole('owner')). Prima: solo llmRateLimit → qualsiasi ruolo poteva generare nodi
  // via LLM (abuso costo + incoerenza privilegi, dato che il persist è owner-only).
  app.use('/node-generator/*', requireRole('owner'));

  app.post(
    '/node-generator/generate',
    llmRateLimit('node-generator'),
    zValidator('json', GenerateNodeSchema),
    (c) => {
      const startTime = Date.now();
      const tenantId = getTenantId(c);
      // Attore per l'attribuzione dell'interazione AI: dal CONTEXT JWT (set dal
      // middleware auth dopo verifySession), NON dall'header `x-user-id` che è
      // client-spoofabile (parità con custom-nodes.ts). La route è owner-only
      // (requireRole('owner') sotto) → auth è garantito.
      const actorUserId = (c.get('auth') as { userId?: string } | undefined)?.userId;
      const headerKey = c.req.header('x-llm-api-key');
      const headerProvider = c.req.header('x-llm-provider');

      // Resolve LLM provider via the tenant resolver — Liara default, BYO
      // (Anthropic/OpenAI/Gemini/Mistral/Groq/OpenRouter/Ollama) when configured.
      // NEVER hardcode a vendor name here.
      let resolved;
      try {
        const opts: { headerApiKey?: string; requestedProvider?: string } = {};
        if (headerKey) opts.headerApiKey = headerKey;
        if (headerProvider) opts.requestedProvider = headerProvider;
        resolved = llmResolver.resolve(tenantId, opts);
      } catch (e) {
        if (e instanceof NoLlmProviderError) {
          return c.json({ error: e.message }, e.httpStatus ?? 400);
        }
        throw e;
      }

      const body = c.req.valid('json');
      const modelLabel = `${resolved.provider}/${resolved.model || 'default'}`;
      const llm = new ResolvedLLMProvider(resolved.provider, resolved.apiKey, resolved.model);
      const service = new NodeGeneratorService(llm);
      const generateInput: Parameters<NodeGeneratorService['generate']>[0] = {
        description: body.description,
      };
      if (body.openApiUrl !== undefined) generateInput.openApiUrl = body.openApiUrl;
      if (body.language !== undefined) generateInput.language = body.language;

      // ── Ramo STREAMING (SSE): delta live → done col nodo → error su guasto ──
      if (body.stream) {
        return streamSSE(c, async (stream) => {
          try {
            let result: GeneratedNode | null = null;
            for await (const ev of service.generateStream(generateInput)) {
              if (ev.type === 'delta') {
                await stream.writeSSE({ event: 'delta', data: JSON.stringify({ text: ev.text }) });
              } else {
                result = ev.node;
              }
            }
            if (!result) throw new Error('Stream ended without a generated node');
            const interactionId = recordGeneration(new AIInteractionsService(), {
              tenantId,
              ...(actorUserId ? { userId: actorUserId } : {}),
              prompt: body.description,
              result,
              modelLabel,
              latencyMs: Date.now() - startTime,
            });
            await stream.writeSSE({
              event: 'done',
              data: JSON.stringify({ node: result, interactionId }),
            });
          } catch (error) {
            logger.error({ err: error }, 'Node generation (stream) failed');
            const message = error instanceof Error ? error.message : String(error);
            await stream.writeSSE({
              event: 'error',
              data: JSON.stringify({ error: message, status: errorStatus(message) }),
            });
          }
        });
      }

      // ── Ramo JSON sincrono (default, retrocompatibile) ──
      return (async () => {
        try {
          const result = await service.generate(generateInput);
          const interactionId = recordGeneration(new AIInteractionsService(), {
            tenantId,
            ...(actorUserId ? { userId: actorUserId } : {}),
            prompt: body.description,
            result,
            modelLabel,
            latencyMs: Date.now() - startTime,
          });
          return c.json({ node: result, interactionId }, 200);
        } catch (error) {
          logger.error({ err: error }, 'Node generation failed');
          const message = error instanceof Error ? error.message : String(error);
          return c.json({ error: message }, errorStatus(message));
        }
      })();
    },
  );

  return app;
}
