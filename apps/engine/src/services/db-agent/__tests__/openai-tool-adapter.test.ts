/**
 * Test 2026-grade — adapter OpenAI-compat tool-calling.
 * Build (ChatTurn→messaggi) e parse (risposta→LlmTurnResult) sono PURI e
 * testati su fixture; makeOpenAiLlmTurn è testato end-to-end con fetch stubbato
 * (nessun LLM reale: il modello è dipendenza, non soggetto).
 *
 * @module services/db-agent/__tests__/openai-tool-adapter
 */
import { coerceString } from '@/lib/coerce.js';
import { describe, it, expect, vi } from 'vitest';
import {
  buildChatCompletionsRequest,
  parseChatCompletionsResponse,
  makeOpenAiLlmTurn,
} from '../chat/openai-tool-adapter.js';
import type { LlmTurnInput } from '../index.js';

const TOOLS = [
  {
    name: 'create_table',
    description: 'crea tabella',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
      additionalProperties: false,
    },
  },
];

describe('buildChatCompletionsRequest', () => {
  it('system in testa, tools in formato function, tool_choice auto', () => {
    const input: LlmTurnInput = {
      system: 'SYS',
      messages: [{ role: 'user', content: 'ciao' }],
      tools: TOOLS,
    };
    const req = buildChatCompletionsRequest(input, 'qwen3-32b');
    expect(req.messages[0]).toEqual({ role: 'system', content: 'SYS' });
    expect(req.messages[1]).toEqual({ role: 'user', content: 'ciao' });
    expect(req.tools[0]).toEqual({ type: 'function', function: TOOLS[0] });
    expect(req.tool_choice).toBe('auto');
    expect(req.model).toBe('qwen3-32b');
  });

  it('model omesso se vuoto (Liara usa il suo default)', () => {
    const req = buildChatCompletionsRequest({ system: 's', messages: [], tools: [] });
    expect('model' in req).toBe(false);
  });

  it('assistant con toolCalls → tool_calls con arguments STRINGA JSON; tool message → tool_call_id', () => {
    const input: LlmTurnInput = {
      system: 's',
      messages: [
        { role: 'user', content: 'crea customers' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'c1', name: 'create_table', args: { name: 'customers' } }],
        },
        { role: 'tool', toolCallId: 'c1', content: '{"ok":true}' },
      ],
      tools: TOOLS,
    };
    const req = buildChatCompletionsRequest(input);
    const assistant = req.messages[2]!;
    expect(assistant.role).toBe('assistant');
    expect(assistant.content).toBeNull(); // contenuto vuoto → null (valido OpenAI)
    expect(assistant.tool_calls).toEqual([
      {
        id: 'c1',
        type: 'function',
        function: { name: 'create_table', arguments: '{"name":"customers"}' },
      },
    ]);
    const toolMsg = req.messages[3]!;
    expect(toolMsg).toEqual({ role: 'tool', content: '{"ok":true}', tool_call_id: 'c1' });
  });
});

describe('parseChatCompletionsResponse', () => {
  it('content senza tool_calls → final', () => {
    const r = parseChatCompletionsResponse({
      choices: [{ message: { content: 'Ecco le tabelle.' } }],
    });
    expect(r).toEqual({ kind: 'final', text: 'Ecco le tabelle.' });
  });

  it('tool_calls → kind tools con arguments PARSATI da stringa JSON', () => {
    const r = parseChatCompletionsResponse({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              { id: 'x1', function: { name: 'create_table', arguments: '{"name":"orders"}' } },
            ],
          },
        },
      ],
    });
    expect(r).toEqual({
      kind: 'tools',
      toolCalls: [{ id: 'x1', name: 'create_table', args: { name: 'orders' } }],
    });
  });

  it('arguments JSON malformato → args {} (fail-soft, no throw)', () => {
    const r = parseChatCompletionsResponse({
      choices: [
        {
          message: {
            tool_calls: [{ id: 'x', function: { name: 'run_select', arguments: '{rotto' } }],
          },
        },
      ],
    });
    expect(r).toMatchObject({ kind: 'tools', toolCalls: [{ name: 'run_select', args: {} }] });
  });

  it("id tool-call mancante → id sintetico stabile; più tool calls preservano l'ordine", () => {
    const r = parseChatCompletionsResponse({
      choices: [
        {
          message: {
            tool_calls: [
              { function: { name: 'a', arguments: '{}' } },
              { function: { name: 'b', arguments: '{}' } },
            ],
          },
        },
      ],
    });
    expect(r.kind).toBe('tools');
    if (r.kind === 'tools') {
      expect(r.toolCalls.map((c) => c.name)).toEqual(['a', 'b']);
      expect(r.toolCalls.map((c) => c.id)).toEqual(['call_0', 'call_1']);
    }
  });

  it('tool_calls array VUOTO → final (non si entra nel ramo tools)', () => {
    const r = parseChatCompletionsResponse({
      choices: [{ message: { content: 'ok', tool_calls: [] } }],
    });
    expect(r).toEqual({ kind: 'final', text: 'ok' });
  });

  it('risposta vuota/senza choices → final con testo vuoto (no throw)', () => {
    expect(parseChatCompletionsResponse({})).toEqual({ kind: 'final', text: '' });
    expect(parseChatCompletionsResponse(null)).toEqual({ kind: 'final', text: '' });
  });
});

describe('makeOpenAiLlmTurn — trasporto con fetch stubbato', () => {
  it('POSTa la richiesta costruita e ritorna il LlmTurnResult parsato', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          choices: [
            {
              message: {
                tool_calls: [{ id: 'c1', function: { name: 'list_databases', arguments: '{}' } }],
              },
            },
          ],
        }),
    } as Response);
    const turn = makeOpenAiLlmTurn({
      endpoint: 'https://liara.local/chat/completions',
      apiKey: 'k',
      model: 'qwen',
      fetchImpl,
    });
    const res = await turn({
      system: 's',
      messages: [{ role: 'user', content: 'elenca db' }],
      tools: TOOLS,
    });
    expect(res).toEqual({
      kind: 'tools',
      toolCalls: [{ id: 'c1', name: 'list_databases', args: {} }],
    });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://liara.local/chat/completions');
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer k');
    const body = JSON.parse(coerceString(init?.body)) as { tools: unknown[]; tool_choice: string };
    expect(body.tool_choice).toBe('auto');
    expect(body.tools).toHaveLength(1);
  });

  it('HTTP non-ok → throw (guasto infra, il loop lo propaga)', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue({ ok: false, status: 503, json: () => Promise.resolve({}) } as Response);
    const turn = makeOpenAiLlmTurn({ endpoint: 'https://x/y', fetchImpl });
    await expect(turn({ system: 's', messages: [], tools: [] })).rejects.toThrow(/503/);
  });
});
