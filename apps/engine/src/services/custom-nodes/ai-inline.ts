/**
 * AI Inline Completion — Copilot-style ghost text via Liara.
 *
 * Endpoint dedicato per IDE-pro ghost text:
 *  - prompt MINIMAL (no markdown, no spiegazione)
 *  - max_tokens 100 (1-3 righe, no monologo)
 *  - temperature 0.15 (deterministic, no creatività)
 *  - stop sequences su \n\n e \n```\n (no continuare oltre)
 *  - timeout 8s (UX target: ghost text appare entro 1s tipicamente)
 *  - cache miss → call Liara; cache hit gestito lato client
 *
 * Differenze vs ai-assist.ts:
 *  - NO patch extraction (output è raw text da inserire)
 *  - NO history (single-shot)
 *  - Token budget 5x più piccolo (100 vs 2048)
 *
 * @module services/custom-nodes/ai-inline
 */
import { gatewayChatCompletions, type GatewayChatResult } from './llm-gateway.js';
import { logger } from '@/lib/logger.js';

export interface InlineCompletionRequest {
  workspaceId: string;
  nodeId: string;
  file: string;
  contextBefore: string;
  cursorLine: number;
  cursorColumn: number;
}

export interface InlineCompletionResponse {
  completion: string;
  tokensIn: number;
  tokensOut: number;
  fromCache: boolean;
}

const SYSTEM_PROMPT = [
  'You are an inline code completion engine for the Zeli FlowForge Custom Node Editor.',
  'You complete TypeScript code as the developer types — Copilot-style.',
  '',
  'STRICT RULES (violation = lost trust):',
  '  1. Output ONLY the raw text to insert at the cursor. No markdown, no fences, no explanation.',
  '  2. NEVER repeat the existing context. The cursor sits at the END of `contextBefore`.',
  '  3. Generate 1 to 3 lines max. Stop at the first complete statement.',
  '  4. Prefer completing the current line over starting a new one.',
  '  5. Match indentation of the line containing the cursor.',
  '  6. Use APIs from @medea/engine-community-node-sdk, zod, @medea/engine-safe-fetch only.',
  '  7. If you cannot suggest meaningfully, output EMPTY string.',
  '  8. No await/async/return etc. that doesn\'t make sense given the surrounding code.',
  '  9. Never insert imports — the editor handles those separately.',
  ' 10. Never insert comments — code only.',
].join('\n');

function buildPrompt(req: InlineCompletionRequest): string {
  return [
    `// File: ${req.file}`,
    `// Cursor at line ${String(req.cursorLine)}, column ${String(req.cursorColumn)}`,
    '',
    '/* Context before cursor: */',
    req.contextBefore,
    '/* >>> CURSOR <<< */',
  ].join('\n');
}

/**
 * Pulisce output Liara da artifact comuni: fence markdown, prefix backtick,
 * commenti spuri "Here is the completion:", whitespace puro.
 */
export function sanitizeCompletion(raw: string, contextBefore: string): string {
  let s = raw;
  // Strip fence markdown ```ts ... ``` (idempotent loop su multipli)
  for (let i = 0; i < 3; i++) {
    const before = s;
    s = s.replace(/^```(?:typescript|ts|tsx|js|javascript)?\n?/u, '');
    s = s.replace(/\n?```\s*$/u, '');
    if (s === before) break;
  }
  // Strip leading "Here is..."/"Sure!"/"Certainly!"/etc. — fino a 3 prefix concatenati
  for (let i = 0; i < 3; i++) {
    const before = s;
    s = s.replace(/^(?:Here(?:'s| is)|Sure|Certainly|Okay|Of course)[^.\n!?]*[.:!?\n]\s*/iu, '');
    if (s === before) break;
  }
  // Re-strip fence dopo aver rimosso il prefix
  s = s.replace(/^```(?:typescript|ts|tsx|js|javascript)?\n?/u, '');
  s = s.replace(/\n?```\s*$/u, '');
  // Strip leading "// Cursor:" marker
  s = s.replace(/^\s*\/\*\s*>>>\s*CURSOR\s*<<<\s*\*\/\s*/u, '');
  // Strip se ripete l'ultima riga del contesto (overlap)
  const lastCtxLine = (contextBefore.split('\n').pop() ?? '').trim();
  if (lastCtxLine.length > 4 && s.startsWith(lastCtxLine)) {
    s = s.slice(lastCtxLine.length);
  }
  return s.trim();
}

export async function callInlineCompletion(req: InlineCompletionRequest): Promise<InlineCompletionResponse> {
  // ⛔ FIX 2026-06-13: passa dal GATEWAY PORTAL (helper condiviso) — prima
  // puntava a liara:3003, irraggiungibile dai container tenant → ghost-text
  // MORTO in prod (fallback empty silenzioso). Fail-soft: qualunque errore → vuoto.
  let r: GatewayChatResult;
  try {
    r = await gatewayChatCompletions({
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildPrompt(req) },
      ],
      temperature: 0.15,
      maxTokens: 100,
      stop: ['\n\n', '\n```', '/* >>>'],
      timeoutMs: 8_000,
      workspaceId: req.workspaceId,
      feature: 'inline-completion',
      ...(process.env.LLM_INLINE_MODEL ? { modelOverride: process.env.LLM_INLINE_MODEL } : {}),
    });
  } catch (e) {
    logger.warn({ err: (e as Error).message }, '[ai-inline] gateway unreachable, fallback empty');
    return { completion: '', tokensIn: 0, tokensOut: 0, fromCache: false };
  }

  if (!r.ok) {
    logger.warn({ status: r.status }, '[ai-inline] gateway non-ok, fallback empty');
    return { completion: '', tokensIn: 0, tokensOut: 0, fromCache: false };
  }

  const completion = sanitizeCompletion(r.content, req.contextBefore);
  return {
    completion,
    tokensIn: r.usage.input,
    tokensOut: r.usage.output,
    fromCache: false,
  };
}
