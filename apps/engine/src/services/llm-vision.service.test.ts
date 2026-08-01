import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/config.js', () => ({
  isLiaraEnabled: () => true,
  liaraBaseUrl: () => 'https://gw.example.com/llm',
}));

const { dispatchLLMVision } = await import('./llm-vision.service.js');

const IMG = { base64: 'AAAABBBB', mimeType: 'image/png' };

/** Mock fetch globale che ritorna una Response reale col body dato. */
function mockFetch(body: unknown, init: { status?: number } = {}): ReturnType<typeof vi.fn> {
  const fn = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: init.status ?? 200 }));
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

/** Ritorna il body JSON dell'ultima fetch. */
function lastBody(fn: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const call = fn.mock.calls.at(-1)!;
  return JSON.parse((call[1] as { body: string }).body) as Record<string, unknown>;
}

beforeEach(() => { vi.restoreAllMocks(); });

describe('dispatchLLMVision — formato per provider (BYOK)', () => {
  it('OpenAI-compat (openai): content[].image_url data-URL + Bearer', async () => {
    const fn = mockFetch({ choices: [{ message: { content: 'TESTO-OPENAI' } }] });
    const r = await dispatchLLMVision({ provider: 'openai', apiKey: 'sk-1', model: 'gpt-4o' }, 'leggi', [IMG]);
    expect(r).toEqual({ ok: true, text: 'TESTO-OPENAI' });
    const url = fn.mock.calls[0]![0] as string;
    expect(url).toContain('openai.com');
    expect((fn.mock.calls[0]![1] as { headers: Record<string, string> }).headers.Authorization).toBe('Bearer sk-1');
    const body = lastBody(fn);
    const content = (body.messages as { content: { type: string; image_url?: { url: string } }[] }[])[0]!.content;
    expect(content[0]).toEqual({ type: 'text', text: 'leggi' });
    expect(content[1]!.type).toBe('image_url');
    expect(content[1]!.image_url!.url).toBe('data:image/png;base64,AAAABBBB');
  });

  it('Liara: gateway /chat/completions + enable_thinking:false + image_url', async () => {
    const fn = mockFetch({ choices: [{ message: { content: 'TESTO-LIARA' } }] });
    const r = await dispatchLLMVision({ provider: 'liara', apiKey: '', model: '' }, 'leggi', [IMG]);
    expect(r.ok).toBe(true);
    expect(r.text).toBe('TESTO-LIARA');
    expect(fn.mock.calls[0]![0]).toBe('https://gw.example.com/llm/chat/completions');
    const body = lastBody(fn);
    expect((body.chat_template_kwargs as { enable_thinking: boolean }).enable_thinking).toBe(false);
  });

  it('Anthropic: content[].image.source(base64) + header x-api-key', async () => {
    const fn = mockFetch({ content: [{ type: 'text', text: 'TESTO-CLAUDE' }] });
    const r = await dispatchLLMVision({ provider: 'anthropic', apiKey: 'ak-1', model: '' }, 'leggi', [IMG]);
    expect(r).toEqual({ ok: true, text: 'TESTO-CLAUDE' });
    expect((fn.mock.calls[0]![1] as { headers: Record<string, string> }).headers['x-api-key']).toBe('ak-1');
    const content = (lastBody(fn).messages as { content: { type: string; source?: { type: string; media_type: string; data: string } }[] }[])[0]!.content;
    expect(content[1]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAABBBB' } });
  });

  it('Gemini: parts[].inline_data + model+key in URL', async () => {
    const fn = mockFetch({ candidates: [{ content: { parts: [{ text: 'TESTO-GEMINI' }] } }] });
    const r = await dispatchLLMVision({ provider: 'gemini', apiKey: 'gk-1', model: 'gemini-2.0-flash' }, 'leggi', [IMG]);
    expect(r).toEqual({ ok: true, text: 'TESTO-GEMINI' });
    expect(fn.mock.calls[0]![0]).toContain('gemini-2.0-flash:generateContent?key=gk-1');
    const parts = (lastBody(fn).contents as { parts: { inline_data?: { mime_type: string; data: string } }[] }[])[0]!.parts;
    expect(parts[1]).toEqual({ inline_data: { mime_type: 'image/png', data: 'AAAABBBB' } });
  });

  it('Ollama: message.images[] (base64 puro)', async () => {
    const fn = mockFetch({ message: { content: 'TESTO-OLLAMA' } });
    const r = await dispatchLLMVision({ provider: 'ollama', apiKey: '', model: 'llava', baseUrl: 'http://localhost:11434' }, 'leggi', [IMG]);
    expect(r).toEqual({ ok: true, text: 'TESTO-OLLAMA' });
    const msg = (lastBody(fn).messages as { images: string[] }[])[0]!;
    expect(msg.images).toEqual(['AAAABBBB']);
  });

  it('🚨 provider che non supporta vision → ok:false, NESSUNA fetch', async () => {
    const fn = mockFetch({});
    const r = await dispatchLLMVision({ provider: 'cohere', apiKey: 'x', model: '' }, 'leggi', [IMG]);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/non supporta/u);
    expect(fn).not.toHaveBeenCalled();
  });

  it('🚨 nessuna immagine → ok:false', async () => {
    const r = await dispatchLLMVision({ provider: 'openai', apiKey: 'x', model: '' }, 'leggi', []);
    expect(r.ok).toBe(false);
  });

  it('🚨 HTTP error provider → ok:false con status + excerpt', async () => {
    mockFetch({ error: 'boom' }, { status: 500 });
    const r = await dispatchLLMVision({ provider: 'openai', apiKey: 'x', model: 'gpt-4o' }, 'leggi', [IMG]);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/500/u);
  });
});
