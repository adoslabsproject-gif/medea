/**
 * Test video-summarizer executor.
 *
 * Fase 2 (#14): la fusion finale passa da `llmResolver` + `dispatchLLMChat`
 * (gateway metered) — il vecchio `LIARA_URL/v1/complete` diretto non esisteva
 * più (401 sempre → summary MAI prodotto). Whisper e Vision restano su
 * safe-outbound-fetch (endpoint di servizio, opt-in/degradanti con warning).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { coerceString } from '@/lib/coerce.js';

vi.mock('@/lib/safe-outbound-fetch.js', () => ({
  safeOutboundFetch: vi.fn(),
}));

const m = vi.hoisted(() => ({
  dispatch: vi.fn(),
  resolve: vi.fn(),
}));
vi.mock('@/services/llm-chat.service.js', () => ({
  dispatchLLMChat: (...a: unknown[]) => m.dispatch(...a),
}));
vi.mock('@/services/llm-resolver.service.js', () => ({
  llmResolver: { resolve: (...a: unknown[]) => m.resolve(...a) },
}));

const reportUsageMock = vi.hoisted(() => vi.fn());
vi.mock('@/services/portal-quota.service.js', () => ({
  reportPortalTokenUsage: (...a: unknown[]) => reportUsageMock(...a),
}));

import { videoSummarizerExecutor } from './video-summarizer.js';
import { safeOutboundFetch } from '@/lib/safe-outbound-fetch.js';

const mockFetch = vi.mocked(safeOutboundFetch);

const baseContext = {
  tenantId: 'tenant-test',
  runId: 'run-1',
  nodeId: 'node-1',
} as unknown as Parameters<typeof videoSummarizerExecutor>[2];

function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Mock dei soli servizi whisper/vision (la fusion LLM è su m.dispatch). */
function mockServices(
  opts: {
    transcript?: unknown;
    scenes?: unknown;
    transcribeThrows?: boolean;
    visionThrows?: boolean;
  } = {},
): string[] {
  const calls: string[] = [];
  mockFetch.mockImplementation(async (url) => {
    const u = String(url);
    calls.push(u);
    if (u.includes('/transcribe')) {
      if (opts.transcribeThrows) throw new Error('connection refused');
      return jsonResp(opts.transcript ?? { transcript: '' });
    }
    if (u.includes('/describe-frames')) {
      if (opts.visionThrows) throw new Error('vision down');
      return jsonResp(opts.scenes ?? { scenes: [] });
    }
    return jsonResp({});
  });
  return calls;
}

beforeEach(() => {
  vi.clearAllMocks();
  reportUsageMock.mockReset();
  m.resolve.mockReturnValue({ provider: 'liara', apiKey: '', model: '' });
  m.dispatch.mockResolvedValue('{"tldr":"","bullets":[],"chapters":[]}');
});

describe('video-summarizer executor — validation', () => {
  it('rejecta videoUrl vuoto', async () => {
    await expect(videoSummarizerExecutor({ videoUrl: '' }, null, baseContext)).rejects.toThrow(
      /obbligatorio/i,
    );
  });

  it('rejecta videoUrl con schema invalido (ftp://)', async () => {
    await expect(
      videoSummarizerExecutor({ videoUrl: 'ftp://example.com/v.mp4' }, null, baseContext),
    ).rejects.toThrow(/http.*o path.*data/i);
  });

  it('accetta path /data/ locale', async () => {
    mockServices();
    await expect(
      videoSummarizerExecutor({ videoUrl: '/data/video/test.mp4' }, null, baseContext),
    ).resolves.toBeDefined();
  });
});

describe('video-summarizer executor — default OFF (out-of-the-box)', () => {
  it('default = no Whisper call, solo Vision + fusion LLM', async () => {
    const calls = mockServices({
      scenes: { scenes: [{ tStart: 0, tEnd: 3, description: 'scena' }] },
    });
    m.dispatch.mockResolvedValue('{"tldr":"summary","bullets":[],"chapters":[]}');
    const r = await videoSummarizerExecutor(
      { videoUrl: 'https://example.com/v.mp4' },
      null,
      baseContext,
    );
    const out = r.output as { transcript: string; warnings: string[] };
    expect(out.transcript).toBe('');
    expect(out.warnings).toEqual([]);
    expect(calls.some((u) => u.includes('/transcribe'))).toBe(false);
    expect(calls.some((u) => u.includes('/describe-frames'))).toBe(true);
    expect(m.dispatch).toHaveBeenCalledOnce();
  });
});

describe('video-summarizer executor — happy path', () => {
  it('pipeline completa con enableTranscription=true: Whisper + Vision + fusion → output strutturato + _llm', async () => {
    mockServices({
      transcript: {
        transcript: 'Benvenuti al webinar. Oggi parliamo di compliance GDPR.',
        segments: [
          { tStart: 0, tEnd: 3, text: 'Benvenuti al webinar.' },
          { tStart: 3, tEnd: 7, text: 'Oggi parliamo di compliance GDPR.' },
        ],
        language: 'it',
      },
      scenes: {
        scenes: [
          { tStart: 0, tEnd: 5, description: 'Slide titolo con logo aziendale' },
          { tStart: 5, tEnd: 10, description: 'Speaker in primo piano' },
        ],
      },
    });
    m.dispatch.mockImplementation(async (...args: unknown[]) => {
      const listener = args[7] as
        | ((u: { input: number; output: number; fromApi: boolean }) => void)
        | undefined;
      listener?.({ input: 300, output: 60, fromApi: true });
      return JSON.stringify({
        tldr: 'Webinar introduttivo su GDPR compliance.',
        bullets: ['Benvenuto', 'GDPR overview', 'Q&A finale'],
        chapters: [
          { tStart: 0, title: 'Introduzione' },
          { tStart: 5, title: 'GDPR' },
        ],
      });
    });

    const r = await videoSummarizerExecutor(
      {
        videoUrl: 'https://example.com/video.mp4',
        frameIntervalSec: '5',
        enableTranscription: 'true',
      },
      null,
      baseContext,
    );
    const out = r.output as {
      transcript: string;
      transcriptLanguage: string;
      scenes: { description: string }[];
      summary: { tldr: string; bullets: string[]; chapters: { tStart: number; title: string }[] };
      warnings: string[];
      durationSec: number;
      _llm: Record<string, unknown>;
    };
    expect(out.transcript).toContain('GDPR');
    expect(out.transcriptLanguage).toBe('it');
    expect(out.scenes).toHaveLength(2);
    expect(out.summary.tldr).toBe('Webinar introduttivo su GDPR compliance.');
    expect(out.summary.bullets).toHaveLength(3);
    expect(out.summary.chapters).toHaveLength(2);
    expect(out.warnings).toEqual([]);
    expect(out.durationSec).toBe(10);
    // Fase 2 (#14): usage standard dalla fusion
    expect(out._llm).toEqual({
      inputTokens: 300,
      outputTokens: 60,
      model: 'liara-default',
      provider: 'liara',
      fromApi: true,
    });
    expect(m.resolve).toHaveBeenCalledWith('tenant-test');
    // Il prompt di fusione contiene transcript + scenes (arg 4 = user message)
    const fusionUser = m.dispatch.mock.calls[0]?.[4] as string;
    expect(fusionUser).toContain('GDPR');
    expect(fusionUser).toContain('Slide titolo');
  });
});

describe('video-summarizer executor — _llm combinato vision+fusion (Fase 2 #14)', () => {
  it('🚨 lo shim /describe-frames riporta usage → _llm somma vision + fusion', async () => {
    mockServices({
      scenes: {
        scenes: [{ tStart: 0, tEnd: 5, description: 'scena' }],
        usage: { input: 5000, output: 400, fromApi: true }, // 24 frame aggregati dallo shim
      },
    });
    m.dispatch.mockImplementation(async (...args: unknown[]) => {
      const listener = args[7] as
        | ((u: { input: number; output: number; fromApi: boolean }) => void)
        | undefined;
      listener?.({ input: 300, output: 60, fromApi: true });
      return '{"tldr":"ok","bullets":[],"chapters":[]}';
    });
    const r = await videoSummarizerExecutor(
      { videoUrl: 'https://example.com/v.mp4' },
      null,
      baseContext,
    );
    const llm = (r.output as { _llm: Record<string, unknown> })._llm;
    expect(llm).toEqual({
      inputTokens: 5300,
      outputTokens: 460,
      model: 'liara-default',
      provider: 'liara',
      fromApi: true,
    });
  });

  it('🚨 metering: usage vision riportato al portal (fire-and-forget) con tenantId e source', async () => {
    mockServices({
      scenes: {
        scenes: [{ tStart: 0, tEnd: 5, description: 's' }],
        usage: { input: 441, output: 159, fromApi: true },
      },
    });
    await videoSummarizerExecutor({ videoUrl: 'https://example.com/v.mp4' }, null, baseContext);
    expect(reportUsageMock).toHaveBeenCalledWith('tenant-test', {
      tokensIn: 441,
      tokensOut: 159,
      source: 'video-describe-frames',
    });
  });

  it('metering: vision senza usage (shim vecchio/zero token) → NESSUN report', async () => {
    mockServices({ scenes: { scenes: [] } });
    await videoSummarizerExecutor({ videoUrl: 'https://example.com/v.mp4' }, null, baseContext);
    expect(reportUsageMock).not.toHaveBeenCalled();
  });

  it('fusion giù MA vision ha speso token → _llm presente con la sola gamba vision', async () => {
    mockServices({
      scenes: {
        scenes: [{ tStart: 0, tEnd: 5, description: 's' }],
        usage: { input: 1000, output: 80, fromApi: true },
      },
    });
    m.dispatch.mockRejectedValue(new Error('gateway down'));
    const r = await videoSummarizerExecutor(
      { videoUrl: 'https://example.com/v.mp4' },
      null,
      baseContext,
    );
    const out = r.output as { _llm: { inputTokens: number; provider: string }; warnings: string[] };
    expect(out._llm.inputTokens).toBe(1000);
    expect(out._llm.provider).toBe('liara');
    expect(out.warnings.some((w) => /liara failed/i.test(w))).toBe(true);
  });
});

describe('video-summarizer executor — degradation graceful', () => {
  it('Whisper down con enableTranscription=true → continue + warning', async () => {
    mockServices({
      transcribeThrows: true,
      scenes: { scenes: [{ tStart: 0, tEnd: 5, description: 'frame 1' }] },
    });
    m.dispatch.mockResolvedValue('{"tldr":"only video","bullets":[],"chapters":[]}');
    const r = await videoSummarizerExecutor(
      { videoUrl: 'https://example.com/v.mp4', enableTranscription: 'true' },
      null,
      baseContext,
    );
    const out = r.output as { transcript: string; warnings: string[]; summary: { tldr: string } };
    expect(out.transcript).toBe('');
    expect(out.warnings.some((w) => /whisper/i.test(w))).toBe(true);
    expect(out.summary.tldr).toBe('only video');
  });

  it('Vision down → continue con transcript-only (enableTranscription=true)', async () => {
    mockServices({ transcript: { transcript: 'audio test', language: 'it' }, visionThrows: true });
    m.dispatch.mockResolvedValue('{"tldr":"audio only","bullets":[],"chapters":[]}');
    const r = await videoSummarizerExecutor(
      { videoUrl: 'https://example.com/v.mp4', enableTranscription: 'true' },
      null,
      baseContext,
    );
    const out = r.output as { scenes: unknown[]; warnings: string[] };
    expect(out.scenes).toEqual([]);
    expect(out.warnings.some((w) => /vision/i.test(w))).toBe(true);
  });

  it('fusion LLM down → continue con summary vuoto + warning, output SENZA _llm', async () => {
    mockServices();
    m.dispatch.mockRejectedValue(new Error('gateway down'));
    const r = await videoSummarizerExecutor(
      { videoUrl: 'https://example.com/v.mp4' },
      null,
      baseContext,
    );
    const out = r.output as { summary: { tldr: string; bullets: unknown[] }; warnings: string[] };
    expect(out.summary.tldr).toBe('');
    expect(out.summary.bullets).toEqual([]);
    expect(out.warnings.some((w) => /liara/i.test(w))).toBe(true);
    expect('_llm' in (r.output as Record<string, unknown>)).toBe(false);
  });

  it('nessun provider (resolver throw) → summary vuoto + warning, no throw', async () => {
    mockServices();
    m.resolve.mockImplementation(() => {
      throw new Error('nessun provider configurato');
    });
    const r = await videoSummarizerExecutor(
      { videoUrl: 'https://example.com/v.mp4' },
      null,
      baseContext,
    );
    const out = r.output as { summary: { tldr: string }; warnings: string[] };
    expect(out.summary.tldr).toBe('');
    expect(out.warnings.some((w) => /liara failed/i.test(w))).toBe(true);
    expect(m.dispatch).not.toHaveBeenCalled();
  });

  it('modello risponde con JSON malformato → warning specifico', async () => {
    mockServices({ transcript: { transcript: 't', language: 'it' } });
    m.dispatch.mockResolvedValue('non sono JSON, sono solo testo');
    const r = await videoSummarizerExecutor(
      { videoUrl: 'https://example.com/v.mp4' },
      null,
      baseContext,
    );
    const out = r.output as { warnings: string[] };
    expect(out.warnings.some((w) => /no JSON/i.test(w))).toBe(true);
  });
});

describe('video-summarizer executor — clamps', () => {
  it('frameIntervalSec clamp a min 1', async () => {
    let intervalSent = -1;
    mockFetch.mockImplementation(async (url, init) => {
      const u = String(url);
      if (u.includes('/describe-frames')) {
        const body = JSON.parse(coerceString(init?.body ?? '{}')) as { intervalSec: number };
        intervalSent = body.intervalSec;
        return jsonResp({ scenes: [] });
      }
      if (u.includes('/transcribe')) return jsonResp({ transcript: '' });
      return jsonResp({});
    });
    await videoSummarizerExecutor(
      { videoUrl: 'https://example.com/v.mp4', frameIntervalSec: 0 },
      null,
      baseContext,
    );
    expect(intervalSent).toBe(1);
  });

  it('frameIntervalSec clamp a max 60', async () => {
    let intervalSent = -1;
    mockFetch.mockImplementation(async (url, init) => {
      const u = String(url);
      if (u.includes('/describe-frames')) {
        intervalSent = (JSON.parse(coerceString(init?.body ?? '{}')) as { intervalSec: number })
          .intervalSec;
        return jsonResp({ scenes: [] });
      }
      if (u.includes('/transcribe')) return jsonResp({ transcript: '' });
      return jsonResp({});
    });
    await videoSummarizerExecutor(
      { videoUrl: 'https://example.com/v.mp4', frameIntervalSec: 9999 },
      null,
      baseContext,
    );
    expect(intervalSent).toBe(60);
  });
});
