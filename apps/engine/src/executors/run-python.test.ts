import { describe, it, expect, vi, beforeEach } from 'vitest';
import { coerceString } from '@/lib/coerce.js';

vi.mock('@/lib/safe-outbound-fetch.js', () => ({
  safeOutboundFetch: vi.fn(),
}));

import { runPythonExecutor } from './run-python.js';
import { safeOutboundFetch } from '@/lib/safe-outbound-fetch.js';

const mockFetch = vi.mocked(safeOutboundFetch);

const baseContext = {
  tenantId: 'tenant-test',
  runId: 'run-1',
  nodeId: 'node-1',
} as unknown as Parameters<typeof runPythonExecutor>[2];

function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Sempre una nuova Response (Response body consumato a ogni call) — bug di
// "Body has already been read" se si riusa la stessa istanza.
function healthOk(): Response {
  return jsonResp({ status: 'ok', docker: true, image: true });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('run-python executor — validation', () => {
  it('rejecta code vuoto', async () => {
    await expect(
      runPythonExecutor({ code: '' }, null, baseContext),
    ).rejects.toThrow(/obbligatorio/i);
  });

  it('rejecta code > 50KB', async () => {
    await expect(
      runPythonExecutor({ code: 'a'.repeat(50_001) }, null, baseContext),
    ).rejects.toThrow(/troppo lungo/i);
  });
});

describe('run-python executor — input passing (inject_files pattern)', () => {
  it('input nodo precedente arriva come inject_files: [{name:"input.json", content}]', async () => {
    mockFetch.mockImplementation(async (url) => {
      const u = String(url);
      if (u.includes('/health')) return healthOk();
      return jsonResp({ success: true, stdout: '{"ok":true}', stderr: '', exit_code: 0, duration_ms: 5, files: [] });
    });
    const input = { items: [{ id: 1, amount: 99.5 }], total: 99.5 };
    await runPythonExecutor({ code: 'print("hello")' }, input, baseContext);

    // 2nd call = /execute
    const execCall = mockFetch.mock.calls[1];
    expect(execCall?.[0]).toMatch(/\/execute$/);
    const body = JSON.parse(coerceString(execCall?.[1]?.body ?? '{}')) as {
      code: string; inject_files: { name: string; content: string }[];
    };
    expect(body.inject_files).toHaveLength(1);
    expect(body.inject_files[0]?.name).toBe('input.json');
    expect(JSON.parse(body.inject_files[0]?.content ?? '{}')).toEqual(input);
  });

  it('codice utente preservato intatto (prelude separato)', async () => {
    mockFetch.mockImplementation(async (url) => {
      const u = String(url);
      if (u.includes('/health')) return healthOk();
      return jsonResp({ success: true, stdout: '', stderr: '', exit_code: 0, duration_ms: 5, files: [] });
    });
    const USER_CODE = 'result = sum([x["amount"] for x in FLOWFORGE_INPUT["items"]])\nprint(result)';
    await runPythonExecutor({ code: USER_CODE }, { items: [{ amount: 10 }] }, baseContext);

    const execCall = mockFetch.mock.calls[1];
    const body = JSON.parse(coerceString(execCall?.[1]?.body ?? '{}')) as { code: string };
    // Il codice utente arriva come scritto, preceduto dal prelude minimal
    expect(body.code).toContain(USER_CODE);
    // Prelude legge input.json
    expect(body.code).toContain("'/home/sandbox/work/input.json'");
    // Espone sia variabile Python FLOWFORGE_INPUT sia env var (back-compat)
    expect(body.code).toContain('FLOWFORGE_INPUT');
    expect(body.code).toContain("_os.environ['FLOWFORGE_INPUT']");
  });

  it('input non-JSON-serializable (circular) → fallback {}', async () => {
    mockFetch.mockImplementation(async (url) => {
      const u = String(url);
      if (u.includes('/health')) return healthOk();
      return jsonResp({ success: true, stdout: '', stderr: '', exit_code: 0, duration_ms: 5, files: [] });
    });
    interface Circular { a: number; self?: Circular }
    const circular: Circular = { a: 1 };
    circular.self = circular;
    await runPythonExecutor({ code: 'print(0)' }, circular, baseContext);

    const execCall = mockFetch.mock.calls[1];
    const body = JSON.parse(coerceString(execCall?.[1]?.body ?? '{}')) as {
      inject_files: { name: string; content: string }[];
    };
    expect(body.inject_files[0]?.content).toBe('{}');
  });
});

describe('run-python executor — health check', () => {
  it('code-runner unreachable → error chiaro', async () => {
    mockFetch.mockImplementation(async (url) => {
      const u = String(url);
      if (u.includes('/health')) throw new Error('connect refused');
      return jsonResp({});
    });
    await expect(
      runPythonExecutor({ code: 'print(1)' }, null, baseContext),
    ).rejects.toThrow(/code-runner non raggiungibile/i);
  });

  it('code-runner docker non pronto → error specifico', async () => {
    mockFetch.mockImplementation(async (url) => {
      const u = String(url);
      if (u.includes('/health')) return jsonResp({ status: 'ok', docker: false, image: true });
      return jsonResp({});
    });
    await expect(
      runPythonExecutor({ code: 'print(1)' }, null, baseContext),
    ).rejects.toThrow(/code-runner.*Docker o immagine|sandbox non pronti/i);
  });
});

describe('run-python executor — response handling', () => {
  it('429 rate limit → error specifico', async () => {
    mockFetch.mockImplementation(async (url) => {
      const u = String(url);
      if (u.includes('/health')) return healthOk();
      return new Response('rate limited', { status: 429 });
    });
    await expect(
      runPythonExecutor({ code: 'print(1)' }, null, baseContext),
    ).rejects.toThrow(/rate limit/i);
  });

  it('503 server busy → error specifico', async () => {
    mockFetch.mockImplementation(async (url) => {
      const u = String(url);
      if (u.includes('/health')) return healthOk();
      return new Response('busy', { status: 503 });
    });
    await expect(
      runPythonExecutor({ code: 'print(1)' }, null, baseContext),
    ).rejects.toThrow(/occupato/i);
  });

  it('success: stdout JSON parsed se parseStdoutJson=true (default)', async () => {
    mockFetch.mockImplementation(async (url) => {
      const u = String(url);
      if (u.includes('/health')) return healthOk();
      return jsonResp({ success: true, stdout: '{"foo":42}', stderr: '', exit_code: 0, duration_ms: 5, files: [] });
    });
    const r = await runPythonExecutor({ code: 'print(1)' }, null, baseContext);
    const out = r.output as { stdout: unknown };
    expect(out.stdout).toEqual({ foo: 42 });
  });

  it('success: stdout NON parsato se parseStdoutJson=false', async () => {
    mockFetch.mockImplementation(async (url) => {
      const u = String(url);
      if (u.includes('/health')) return healthOk();
      return jsonResp({ success: true, stdout: '{"foo":42}', stderr: '', exit_code: 0, duration_ms: 5, files: [] });
    });
    const r = await runPythonExecutor(
      { code: 'print(1)', parseStdoutJson: 'false' },
      null,
      baseContext,
    );
    const out = r.output as { stdout: unknown };
    expect(out.stdout).toBe('{"foo":42}');
  });

  it('execution fallita → throw con stderr', async () => {
    mockFetch.mockImplementation(async (url) => {
      const u = String(url);
      if (u.includes('/health')) return healthOk();
      return jsonResp({ success: false, stdout: '', stderr: 'NameError: foo not defined', exit_code: 1, duration_ms: 5 });
    });
    await expect(
      runPythonExecutor({ code: 'print(foo)' }, null, baseContext),
    ).rejects.toThrow(/NameError|exit 1/i);
  });

  it('files output (grafici/csv) ritornati intatti', async () => {
    mockFetch.mockImplementation(async (url) => {
      const u = String(url);
      if (u.includes('/health')) return healthOk();
      return jsonResp({
        success: true,
        stdout: '',
        stderr: '',
        exit_code: 0,
        duration_ms: 5,
        files: [{ name: 'chart.png', mime: 'image/png', size_bytes: 1234, base64: 'iVBORw0KGgo...' }],
      });
    });
    const r = await runPythonExecutor({ code: 'pass' }, null, baseContext);
    const out = r.output as { files: { name: string; mime: string }[] };
    expect(out.files).toHaveLength(1);
    expect(out.files[0]?.name).toBe('chart.png');
  });
});

describe('run-python executor — timeout clamping', () => {
  it('timeout < 5000 → clampato a 5000', async () => {
    let timeoutSent = -1;
    mockFetch.mockImplementation(async (url, init) => {
      const u = String(url);
      if (u.includes('/health')) return healthOk();
      const body = JSON.parse(coerceString(init?.body ?? '{}')) as { timeout_ms: number };
      timeoutSent = body.timeout_ms;
      return jsonResp({ success: true, stdout: '', stderr: '', exit_code: 0, duration_ms: 1, files: [] });
    });
    await runPythonExecutor({ code: 'pass', timeoutMs: 100 }, null, baseContext);
    expect(timeoutSent).toBe(5000);
  });

  it('timeout > 120000 → clampato a 120000', async () => {
    let timeoutSent = -1;
    mockFetch.mockImplementation(async (url, init) => {
      const u = String(url);
      if (u.includes('/health')) return healthOk();
      const body = JSON.parse(coerceString(init?.body ?? '{}')) as { timeout_ms: number };
      timeoutSent = body.timeout_ms;
      return jsonResp({ success: true, stdout: '', stderr: '', exit_code: 0, duration_ms: 1, files: [] });
    });
    await runPythonExecutor({ code: 'pass', timeoutMs: 999999 }, null, baseContext);
    expect(timeoutSent).toBe(120_000);
  });
});

describe('run-python executor — network opt-in (Cappella Sistina)', () => {
  it('default (no allowNetwork) → allow_network=false al code-runner', async () => {
    let allowNetworkSent: boolean | undefined;
    mockFetch.mockImplementation(async (url, init) => {
      const u = String(url);
      if (u.includes('/health')) return healthOk();
      const body = JSON.parse(coerceString(init?.body ?? '{}')) as { allow_network?: boolean };
      allowNetworkSent = body.allow_network;
      return jsonResp({ success: true, stdout: '', stderr: '', exit_code: 0, duration_ms: 1, files: [] });
    });
    await runPythonExecutor({ code: 'pass' }, null, baseContext);
    expect(allowNetworkSent).toBe(false);
  });

  it('allowNetwork=true → allow_network=true al code-runner + output.allowedNetwork=true', async () => {
    let allowNetworkSent: boolean | undefined;
    mockFetch.mockImplementation(async (url, init) => {
      const u = String(url);
      if (u.includes('/health')) return healthOk();
      const body = JSON.parse(coerceString(init?.body ?? '{}')) as { allow_network?: boolean };
      allowNetworkSent = body.allow_network;
      return jsonResp({ success: true, stdout: '{"ok":1}', stderr: '', exit_code: 0, duration_ms: 1, files: [] });
    });
    const r = await runPythonExecutor({ code: 'pass', allowNetwork: true }, null, baseContext);
    expect(allowNetworkSent).toBe(true);
    expect((r.output as { allowedNetwork: boolean }).allowedNetwork).toBe(true);
  });

  it('allowNetwork="true" string (form-checkbox) → coerced a true', async () => {
    let allowNetworkSent: boolean | undefined;
    mockFetch.mockImplementation(async (url, init) => {
      const u = String(url);
      if (u.includes('/health')) return healthOk();
      const body = JSON.parse(coerceString(init?.body ?? '{}')) as { allow_network?: boolean };
      allowNetworkSent = body.allow_network;
      return jsonResp({ success: true, stdout: '', stderr: '', exit_code: 0, duration_ms: 1, files: [] });
    });
    await runPythonExecutor({ code: 'pass', allowNetwork: 'true' }, null, baseContext);
    expect(allowNetworkSent).toBe(true);
  });

  it('allowNetwork=false esplicito → allow_network=false (no truthy quirk)', async () => {
    let allowNetworkSent: boolean | undefined;
    mockFetch.mockImplementation(async (url, init) => {
      const u = String(url);
      if (u.includes('/health')) return healthOk();
      const body = JSON.parse(coerceString(init?.body ?? '{}')) as { allow_network?: boolean };
      allowNetworkSent = body.allow_network;
      return jsonResp({ success: true, stdout: '', stderr: '', exit_code: 0, duration_ms: 1, files: [] });
    });
    await runPythonExecutor({ code: 'pass', allowNetwork: false }, null, baseContext);
    expect(allowNetworkSent).toBe(false);
  });

  it('SECURITY: allowNetwork string non-"true" (es. "yes", "1") → coerced a false (whitelist strict)', async () => {
    let allowNetworkSent: boolean | undefined;
    mockFetch.mockImplementation(async (url, init) => {
      const u = String(url);
      if (u.includes('/health')) return healthOk();
      const body = JSON.parse(coerceString(init?.body ?? '{}')) as { allow_network?: boolean };
      allowNetworkSent = body.allow_network;
      return jsonResp({ success: true, stdout: '', stderr: '', exit_code: 0, duration_ms: 1, files: [] });
    });
    await runPythonExecutor({ code: 'pass', allowNetwork: 'yes' }, null, baseContext);
    // Solo boolean true o string esatta "true" → flip. Tutto altro → false safe.
    expect(allowNetworkSent).toBe(false);
  });
});

describe('🚨 GAP2 FLIP — run_python: i file output diventano handle BinaryData (ref-primario)', () => {
  it('🚨 file dallo script → handle inline (senza store), niente base64 grezzo nel payload', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
    mockFetch.mockImplementation(async (url) => {
      if (String(url).includes('/health')) return healthOk();
      return jsonResp({
        success: true, stdout: '', stderr: '', exit_code: 0, duration_ms: 5,
        files: [{ name: 'chart.png', mime: 'image/png', size_bytes: png.length, base64: png.toString('base64') }],
      });
    });
    const r = await runPythonExecutor({ code: 'open("chart.png","wb").write(b"...")' }, null, baseContext);
    const files = (r.output as { files: Record<string, unknown>[] }).files;
    expect(files).toHaveLength(1);
    const f = files[0] as { name: string; binary: { __ffBinary: boolean; encoding: string; data?: string }; base64?: unknown };
    expect(f.name).toBe('chart.png');
    expect(f.binary.__ffBinary).toBe(true);   // handle, NON base64 grezzo
    expect(f.base64).toBeUndefined();
    expect(Buffer.from(f.binary.data ?? '', 'base64').equals(png)).toBe(true);
  });

  it('🚨 CON store → il file diventa ref content-addressed (byte fuori dal payload)', async () => {
    const data = Buffer.from('output-file-bytes');
    const writeBinary = async (buf: Buffer, meta: { mimeType: string; fileName?: string }): Promise<unknown> =>
      ({ __ffBinary: true, encoding: 'ref', mimeType: meta.mimeType, size: buf.length, ref: 'r'.repeat(64), fileName: meta.fileName });
    mockFetch.mockImplementation(async (url) => {
      if (String(url).includes('/health')) return healthOk();
      return jsonResp({
        success: true, stdout: '', stderr: '', exit_code: 0, duration_ms: 5,
        files: [{ name: 'out.bin', mime: 'application/octet-stream', size_bytes: data.length, base64: data.toString('base64') }],
      });
    });
    const ctx = { ...baseContext, writeBinary } as unknown as Parameters<typeof runPythonExecutor>[2];
    const r = await runPythonExecutor({ code: 'x' }, null, ctx);
    const f = (r.output as { files: { binary: { encoding: string; ref: string } }[] }).files[0]!;
    expect(f.binary.encoding).toBe('ref');
    expect(f.binary.ref).toBe('r'.repeat(64));
  });
});

describe('🚨 run-python executor — cancel cooperativo (fix 2026-06-17)', () => {
  it('🚨 context.abortSignal GIÀ abortito → throw "annullato" SENZA chiamare il code-runner', async () => {
    const ac = new AbortController();
    ac.abort();
    const ctx = { ...baseContext, abortSignal: ac.signal } as unknown as Parameters<typeof runPythonExecutor>[2];
    await expect(runPythonExecutor({ code: 'print(1)' }, null, ctx)).rejects.toThrow(/annullato|cancellato/i);
    expect(mockFetch).not.toHaveBeenCalled(); // nessun round-trip sprecato al code-runner
  });

  it('🔒 senza abortSignal → comportamento invariato (health check parte)', async () => {
    mockFetch.mockResolvedValueOnce(healthOk());
    mockFetch.mockResolvedValueOnce(jsonResp({ success: true, stdout: '1', stderr: '', exitCode: 0, durationMs: 5, files: [] }));
    await runPythonExecutor({ code: 'print(1)' }, null, baseContext);
    expect(mockFetch).toHaveBeenCalled(); // health + execute
  });
});
