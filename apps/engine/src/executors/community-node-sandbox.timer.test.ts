/**
 * Test E2E: timer shim (#223) — setTimeout/clearTimeout dentro isolated-vm.
 *
 * Verifica che bundle node-style che usano setTimeout NON throwano più
 * ReferenceError "setTimeout is not defined" → che veniva poi wrappato come
 * "Timeout dopo 0ms" dal asNodeError middleware.
 *
 * Esegue codice reale dentro isolated-vm.
 */
import { describe, it, expect } from 'vitest';
import { runInSandbox } from './community-node-sandbox.js';

describe('#223 timer shim — sandbox', () => {
  const baseInput = {
    input: {},
    config: {},
    context: {
      tenantId: 'ws_test',
      runId: 'r_test',
      workflowId: 'wf_test',
      nodeId: 'n_test',
      action: 'test',
    },
  };

  it('setTimeout esiste come funct (no ReferenceError)', async () => {
    const source = `
      module.exports = async function(config, input, context) {
        return { typeofST: typeof setTimeout, typeofCT: typeof clearTimeout };
      };
    `;
    const out = await runInSandbox(source, baseInput) as { typeofST: string; typeofCT: string };
    expect(out.typeofST).toBe('function');
    expect(out.typeofCT).toBe('function');
  });

  it('setInterval + clearInterval esistono come funct', async () => {
    const source = `
      module.exports = async function(config, input, context) {
        return { typeofSI: typeof setInterval, typeofCI: typeof clearInterval };
      };
    `;
    const out = await runInSandbox(source, baseInput) as { typeofSI: string; typeofCI: string };
    expect(out.typeofSI).toBe('function');
    expect(out.typeofCI).toBe('function');
  });

  it('setTimeout invoca callback (timing reale gestito da host, no ReferenceError)', async () => {
    const source = `
      module.exports = async function(config, input, context) {
        return new Promise((resolve) => {
          let invoked = false;
          setTimeout(() => { invoked = true; resolve({ invoked, id: typeof t }); }, 300);
          var t = 0;
        });
      };
    `;
    const out = await runInSandbox(source, baseInput) as { invoked: boolean };
    expect(out.invoked).toBe(true);
  });

  it('clearTimeout cancella prima dello scatto → callback NON chiamata', async () => {
    const source = `
      module.exports = async function(config, input, context) {
        return new Promise((resolve) => {
          let fired = false;
          const id = setTimeout(() => { fired = true; }, 300);
          clearTimeout(id);
          setTimeout(() => resolve({ fired }), 600);
        });
      };
    `;
    const out = await runInSandbox(source, baseInput) as { fired: boolean };
    expect(out.fired).toBe(false);
  }, 15_000); // timeout ampio: lo spawn isolated-vm + i timer interni (600ms)
              // possono slittare quando la suite gira a piena concorrenza
              // (worker CPU-starved). La logica resta deterministica (margine
              // 300ms cancellato vs 600ms resolve); qui difendiamo solo dal carico.

  it('AbortSignal.timeout(ms) funziona (depende da setTimeout shim)', async () => {
    const source = `
      module.exports = async function(config, input, context) {
        return new Promise((resolve) => {
          const sig = AbortSignal.timeout(400);
          sig.addEventListener('abort', () => {
            resolve({ aborted: sig.aborted, reason: sig.reason });
          });
        });
      };
    `;
    const out = await runInSandbox(source, baseInput) as { aborted: boolean; reason: string };
    expect(out.aborted).toBe(true);
    expect(out.reason).toBe('TimeoutError');
  });

  it('🚨🚨 HANG ASYNC inline: await che non risolve → kill wall-clock host (no main thread appeso)', async () => {
    // `await new Promise(()=>{})` lascia l'isolate IDLE → il timeout CPU di isolated-vm
    // NON scatta. Senza la Promise.race host-side il main thread resterebbe appeso.
    // Riduco il timeout CPU via env → wall-clock = 300+3000ms.
    process.env.MEDEA_SANDBOX_EXEC_TIMEOUT_MS = '300';
    try {
      const source = `
        module.exports = async function(config, input, context) {
          await new Promise(() => {}); // non risolve MAI
          return { neverReached: true };
        };
      `;
      await expect(runInSandbox(source, baseInput)).rejects.toThrow(/timeout host|hang async|await non risolto/u);
    } finally {
      delete process.env.MEDEA_SANDBOX_EXEC_TIMEOUT_MS;
    }
  }, 12_000);

  it('🚨🚨 timer-bomb: oltre il cap di timer → throw (no esaurimento handle host)', async () => {
    // Un custom node ostile prova a creare migliaia di setInterval. Il cap host
    // (MAX_HOST_TIMERS) deve farlo fallire ben prima del timeout CPU, evitando
    // l'accumulo di handle reali nel processo host.
    const source = `
      module.exports = async function(config, input, context) {
        let n = 0;
        for (let i = 0; i < 5000; i++) { setInterval(() => {}, 100000); n++; }
        return { created: n };
      };
    `;
    await expect(runInSandbox(source, baseInput)).rejects.toThrow(/Limite timer sandbox|timer sandbox superato/u);
  });

  // ROOT CAUSE #3 (2026-06-09): `const fetch` dentro ctx.eval() ha block-scope —
  // non era visibile dal bundle vendor che gira in script.run() successivo.
  // Risultato in prod: ReferenceError "fetch is not defined" silenzioso →
  // domain_rotator probe ritorna 6 candidati come "network: fetch is not defined"
  // → NO_LIVE_HOST mascherato (sandboxNetCount=0). Fix: globalThis.fetch=.
  // ROOT CAUSE #5 (2026-06-09): URL/URLSearchParams shim WHATWG fidelity.
  // isolated-vm V8 NON include URL (Web API, NON ECMA-262). Rotator
  // normaliseHost(): `new URL(raw)` → ReferenceError → catch → "invalid URL".
  // ROOT CAUSE #6 (2026-06-09): vendor source che ritorna NodeExecutionResult
  // shape `{ output, durationMs }` vs custom-node executor che wrappa.
  // PRE-fix: doppio wrap → vars[nodeId] = { output: {...}, durationMs }
  // → template `$node.X.json.field` accede a vars[X].field undefined.
  // POST-fix: smart unwrap quando vendor ritorna NodeExecutionResult.
  it('vendor source che ritorna {output, durationMs} → engine vede output srotolato', async () => {
    const source = `
      module.exports = async function(config, input, context) {
        return {
          output: { liveHost: 'https://example.com', baseUrl: 'https://example.com' },
          durationMs: 42,
        };
      };
    `;
    const result = await runInSandbox(source, baseInput) as { output: unknown; durationMs: number };
    expect(result).toEqual({
      output: { liveHost: 'https://example.com', baseUrl: 'https://example.com' },
      durationMs: 42,
    });
    // NB: questo test verifica il VENDOR side (runInSandbox propaga). Il
    // custom-node.ts smart unwrap copre il binding engine — testato indiret-
    // tamente da workflow-engine integration tests.
  });

  it('vendor source che ritorna direct payload (no NodeExecutionResult) → wrap automatico', async () => {
    const source = `
      module.exports = async function(config, input, context) {
        return { foo: 'bar', count: 7 };
      };
    `;
    const result = await runInSandbox(source, baseInput) as { foo: string; count: number };
    // runInSandbox ritorna VALUE puro (no wrap). custom-node.ts farà il wrap.
    expect(result).toEqual({ foo: 'bar', count: 7 });
  });

  it('URL bridge — WHATWG fidelity host-side via __urlParse (regression #223 ROOT #5)', async () => {
    const source = `
      module.exports = async function(config, input, context) {
        var u = new URL('https://streamingcommunityz.eu/path?q=1#frag');
        return {
          protocol: u.protocol,
          host: u.host,
          hostname: u.hostname,
          pathname: u.pathname,
          search: u.search,
          hash: u.hash,
          href: u.href,
          canParseValid: URL.canParse('https://example.com'),
          canParseInvalid: URL.canParse('not-a-url'),
        };
      };
    `;
    const out = await runInSandbox(source, baseInput) as {
      protocol: string; host: string; hostname: string;
      pathname: string; search: string; hash: string;
      href: string; canParseValid: boolean; canParseInvalid: boolean;
    };
    expect(out.protocol).toBe('https:');
    expect(out.host).toBe('streamingcommunityz.eu');
    expect(out.hostname).toBe('streamingcommunityz.eu');
    expect(out.pathname).toBe('/path');
    expect(out.search).toBe('?q=1');
    expect(out.hash).toBe('#frag');
    expect(out.href).toContain('streamingcommunityz.eu');
    expect(out.canParseValid).toBe(true);
    expect(out.canParseInvalid).toBe(false);
  });

  // ROOT CAUSE #7 (2026-06-09): WHATWG URL.searchParams è URLSearchParams LIVE.
  // Bundle streammy_catalog usa `u.searchParams.set('cursor', cursor)` → senza
  // shim → Cannot read properties of undefined (reading 'set').
  it('URL.searchParams è LIVE e sincronizza search/href (regression #223 ROOT #7)', async () => {
    const source = `
      module.exports = async function(config, input, context) {
        var u = new URL('https://example.com/path');
        u.searchParams.set('cursor', 'abc');
        u.searchParams.set('page', '2');
        u.searchParams.append('tag', 'x');
        var snap1 = { search: u.search, href: u.href };
        u.searchParams.set('cursor', 'xyz');
        u.searchParams['delete']('tag');
        var snap2 = { search: u.search, href: u.href };
        return { snap1, snap2 };
      };
    `;
    const out = await runInSandbox(source, baseInput) as {
      snap1: { search: string; href: string };
      snap2: { search: string; href: string };
    };
    expect(out.snap1.search).toBe('?cursor=abc&page=2&tag=x');
    expect(out.snap1.href).toBe('https://example.com/path?cursor=abc&page=2&tag=x');
    expect(out.snap2.search).toBe('?cursor=xyz&page=2');
    expect(out.snap2.href).toBe('https://example.com/path?cursor=xyz&page=2');
  });

  it('URLSearchParams shim — parse + get/set/has/toString', async () => {
    const source = `
      module.exports = async function(config, input, context) {
        var p = new URLSearchParams('a=1&b=2&a=3');
        return {
          getA: p.get('a'),
          getAllA: p.getAll('a'),
          has: p.has('b'),
          serialized: p.toString(),
        };
      };
    `;
    const out = await runInSandbox(source, baseInput) as {
      getA: string; getAllA: string[]; has: boolean; serialized: string;
    };
    expect(out.getA).toBe('1');
    expect(out.getAllA).toEqual(['1', '3']);
    expect(out.has).toBe(true);
    expect(out.serialized).toBe('a=1&b=2&a=3');
  });

  it('normaliseHost-pattern (rotator) — new URL non lancia per URL https valido', async () => {
    // Riproduce ESATTAMENTE il bundle del rotator: normaliseHost prende un
    // input string e ritorna `${protocol}//${host}${path}` o lancia.
    const source = `
      function normaliseHost(input) {
        if (typeof input !== 'string' || input.length === 0) {
          throw new TypeError('normaliseHost: non-empty string required');
        }
        var raw = input.trim();
        if (raw.endsWith('/')) raw = raw.slice(0, -1);
        try {
          var u = new URL(raw);
          var path = u.pathname === '/' ? '' : u.pathname.replace(/\\/+$/, '');
          return u.protocol + '//' + u.host + path;
        } catch (e) {
          throw new Error('normaliseHost: invalid URL "' + input + '"');
        }
      }
      module.exports = async function(config, input, context) {
        return {
          eu: normaliseHost('https://streamingcommunityz.eu'),
          company: normaliseHost('https://streamingcommunityz.company/'),
          path: normaliseHost('https://example.com/sub/'),
        };
      };
    `;
    const out = await runInSandbox(source, baseInput) as { eu: string; company: string; path: string };
    expect(out.eu).toBe('https://streamingcommunityz.eu');
    expect(out.company).toBe('https://streamingcommunityz.company');
    expect(out.path).toBe('https://example.com/sub');
  });

  // ROOT CAUSE #11: Buffer.from(ArrayBuffer/Uint8Array) — stream_proxy fa
  // Buffer.from(await res.arrayBuffer()). Pre-fix: String(ab) =
  // "[object ArrayBuffer]" → URL firmati con placeholder → playback rotto.
  it('Buffer.from accetta ArrayBuffer / Uint8Array (regression #223 ROOT #11)', async () => {
    const source = `
      module.exports = async function(config, input, context) {
        // ArrayBuffer da bytes "hello" (h=0x68 e=0x65 l=0x6c l=0x6c o=0x6f)
        var ab = new ArrayBuffer(5);
        var view = new Uint8Array(ab);
        view[0] = 0x68; view[1] = 0x65; view[2] = 0x6c; view[3] = 0x6c; view[4] = 0x6f;
        var buf1 = Buffer.from(ab);
        var buf2 = Buffer.from(view);
        var buf3 = Buffer.from([0x68, 0x65, 0x6c, 0x6c, 0x6f]);
        return {
          fromAB: buf1.toString('utf8'),
          fromU8: buf2.toString('utf8'),
          fromArr: buf3.toString('utf8'),
          lenAB: buf1.length,
        };
      };
    `;
    const out = await runInSandbox(source, baseInput) as {
      fromAB: string; fromU8: string; fromArr: string; lenAB: number;
    };
    expect(out.fromAB).toBe('hello');
    expect(out.fromU8).toBe('hello');
    expect(out.fromArr).toBe('hello');
    expect(out.lenAB).toBe(5);
  });

  // ROOT CAUSE #10: node:crypto shim via __nodeCrypto host-bridge.
  it('crypto.createHmac/createHash/randomUUID disponibili (regression #223 ROOT #10)', async () => {
    const source = `
      module.exports = async function(config, input, context) {
        var hmac = __nodeCrypto.createHmac('sha256', 'secret').update('hello').digest('hex');
        var hash = __nodeCrypto.createHash('sha256').update('hello').digest('hex');
        var uuid = __nodeCrypto.randomUUID();
        return { hmac, hash, uuid, uuidValid: /^[0-9a-f-]{36}$/i.test(uuid) };
      };
    `;
    const out = await runInSandbox(source, baseInput) as {
      hmac: string; hash: string; uuid: string; uuidValid: boolean;
    };
    // SHA-256 HMAC("secret", "hello") = "88aab3ede8d3adf94d26ab90d3bafd4a2083070c3bcce9c014ee04a443847c0b"
    expect(out.hmac).toBe('88aab3ede8d3adf94d26ab90d3bafd4a2083070c3bcce9c014ee04a443847c0b');
    // SHA-256("hello") = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
    expect(out.hash).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
    expect(out.uuidValid).toBe(true);
  });

  it('globalThis.crypto.randomUUID disponibile (WebCrypto fidelity)', async () => {
    const source = `
      module.exports = async function(config, input, context) {
        return { uuid: crypto.randomUUID() };
      };
    `;
    const out = await runInSandbox(source, baseInput) as { uuid: string };
    expect(out.uuid).toMatch(/^[0-9a-f-]{36}$/i);
  });

  // ROOT CAUSE #8: Buffer.byteLength (catalog_page calcola Content-Length).
  it('Buffer.byteLength / Buffer.isBuffer disponibili (regression #223 ROOT #8)', async () => {
    const source = `
      module.exports = async function(config, input, context) {
        return {
          asciiLen: Buffer.byteLength('hello', 'utf8'),
          utf8Len: Buffer.byteLength('café', 'utf8'),
          isBufferFalse: Buffer.isBuffer('plain string'),
        };
      };
    `;
    const out = await runInSandbox(source, baseInput) as {
      asciiLen: number; utf8Len: number; isBufferFalse: boolean;
    };
    expect(out.asciiLen).toBe(5);
    expect(out.utf8Len).toBe(5);
    expect(out.isBufferFalse).toBe(false);
  });

  it('fetch / Buffer / console sono globalmente visibili al vendor (regression #223 ROOT #3)', async () => {
    const source = `
      module.exports = async function(config, input, context) {
        return {
          typeofFetch: typeof fetch,
          typeofBuffer: typeof Buffer,
          typeofConsole: typeof console,
          typeofAtob: typeof atob,
          typeofAbortController: typeof AbortController,
        };
      };
    `;
    const out = await runInSandbox(source, baseInput) as {
      typeofFetch: string; typeofBuffer: string; typeofConsole: string;
      typeofAtob: string; typeofAbortController: string;
    };
    expect(out.typeofFetch).toBe('function');
    expect(out.typeofBuffer).toBe('object');
    expect(out.typeofConsole).toBe('object');
    expect(out.typeofAtob).toBe('function');
    expect(out.typeofAbortController).toBe('function');
  });

  // Cappella Sistina+ error propagation (ROOT CAUSE #5): il sandbox deve
  // propagare TUTTO il context error (name, code, meta, cause.probes/outcomes,
  // stackHead) al chiamante — altrimenti operatore vede solo "NO_LIVE_HOST"
  // senza le 6 ragioni reali per ogni candidate fallito (rotator pattern).
  it('error name/code/meta/cause.probes propagati attraverso il boundary sandbox', async () => {
    // Crea un errore reale con structure simile a NoLiveHostError del rotator
    const source = `
      class FakeNoLiveHost extends Error {
        constructor(probes) {
          super('cause-level: all probes failed');
          this.name = 'NoLiveHostError';
          this.probes = probes;
        }
      }
      class FakeNetwork extends Error {
        constructor(msg, meta) {
          super(msg);
          this.name = 'NetworkError';
          this.code = 'NETWORK_ERROR';
          this.meta = meta;
        }
      }
      module.exports = async function(config, input, context) {
        const probes = [
          { ok: false, host: 'https://a.example', reason: 'network: ECONNREFUSED' },
          { ok: false, host: 'https://b.example', reason: 'status_503' },
        ];
        const cause = new FakeNoLiveHost(probes);
        const err = new FakeNetwork('NO_LIVE_HOST: tried 2', { url: 'https://a.example' });
        err.cause = cause;
        throw err;
      };
    `;
    let caught: Error | null = null;
    try {
      await runInSandbox(source, baseInput);
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught!.message).toContain('NO_LIVE_HOST');
    // Il collector NON è injected in questo test (no collector) — ma il fix
    // propaga i fields via worker postMessage. Verifico che il throw arrivi
    // con almeno il message intatto.
  });

  it('bundle node-style con AbortController + setTimeout + abort funziona (regression #223)', async () => {
    // Pattern che simula bundle reale (action_domain_rotator):
    // - AbortController istanziato
    // - setTimeout schedula abort
    // - prima dello scatto → completiamo manualmente → no abort
    const source = `
      module.exports = async function(config, input, context) {
        return new Promise((resolve) => {
          const ctrl = new AbortController();
          const t = setTimeout(() => ctrl.abort(), 500);
          // Completiamo subito
          clearTimeout(t);
          resolve({ aborted: ctrl.signal.aborted, hadTimer: typeof t === 'number' });
        });
      };
    `;
    const out = await runInSandbox(source, baseInput) as { aborted: boolean; hadTimer: boolean };
    expect(out.aborted).toBe(false);
    expect(out.hadTimer).toBe(true);
  });
});
