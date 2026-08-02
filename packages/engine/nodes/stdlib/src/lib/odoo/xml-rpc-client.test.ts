/**
 * Tests for the Odoo XML-RPC client.
 *
 * We do NOT smoke-test exports. Every test exercises a real branch:
 *   • encoder type matrix (string/int/double/bool/date/array/struct/null)
 *   • decoder type matrix + the fault path + escape handling
 *   • method-call envelope shape (XML structure pinned)
 *   • authenticate cache hit + miss + failed-auth branch
 *   • execute_kw end-to-end with a fault response (must throw OdooFaultError)
 *   • escape correctness (single + double quotes, ampersands, lt/gt)
 *   • adversarial: nested arrays of structs of arrays survive round-trip
 */

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- Reserved per estensione futura (interface compat)
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  encodeValue,
  encodeMethodCall,
  decodeValue,
  decodeMethodResponse,
  authenticate,
  executeKw,
  OdooFaultError,
  OdooTransportError,
  __clearOdooAuthCacheForTests,
  type OdooHttpTransport,
  type OdooValue,
} from './xml-rpc-client.js';

// ────────────────────────────────────────────────────────────────────────────
// Encoder — pinned XML shapes
// ────────────────────────────────────────────────────────────────────────────

describe('encodeValue', () => {
  it('encodes null as <nil/>', () => {
    expect(encodeValue(null)).toBe('<value><nil/></value>');
  });
  it('encodes boolean as <boolean>0|1</boolean>', () => {
    expect(encodeValue(true)).toBe('<value><boolean>1</boolean></value>');
    expect(encodeValue(false)).toBe('<value><boolean>0</boolean></value>');
  });
  it('encodes integer in range as <int>', () => {
    expect(encodeValue(42)).toBe('<value><int>42</int></value>');
    expect(encodeValue(0)).toBe('<value><int>0</int></value>');
    expect(encodeValue(-1)).toBe('<value><int>-1</int></value>');
  });
  it('promotes large integers to <double>', () => {
    expect(encodeValue(9_999_999_999)).toBe('<value><double>9999999999</double></value>');
  });
  it('encodes non-integer numbers as <double>', () => {
    expect(encodeValue(3.14)).toBe('<value><double>3.14</double></value>');
  });
  it('throws on NaN / Infinity (XML-RPC has no such concept)', () => {
    expect(() => encodeValue(NaN)).toThrow(/NaN|encodable/);
    expect(() => encodeValue(Infinity)).toThrow(/encodable/);
  });
  it('escapes special chars in string', () => {
    const xml = encodeValue('a < b & "c" \'d\' > e');
    expect(xml).toBe(
      '<value><string>a &lt; b &amp; &quot;c&quot; &apos;d&apos; &gt; e</string></value>',
    );
  });
  it('encodes Date as XML-RPC dateTime (NOT ISO 8601 Z)', () => {
    const d = new Date(Date.UTC(2026, 5, 4, 12, 34, 56));
    expect(encodeValue(d)).toBe(
      '<value><dateTime.iso8601>20260604T12:34:56</dateTime.iso8601></value>',
    );
  });
  it('throws on invalid Date', () => {
    expect(() => encodeValue(new Date('invalid'))).toThrow(/invalid Date/);
  });
  it('encodes arrays recursively', () => {
    const xml = encodeValue([1, 'x', true]);
    expect(xml).toBe(
      '<value><array><data><value><int>1</int></value><value><string>x</string></value><value><boolean>1</boolean></value></data></array></value>',
    );
  });
  it('encodes structs recursively, omitting undefined members', () => {
    const xml = encodeValue({ name: 'Alice', age: 30, missing: undefined as unknown as OdooValue });
    expect(xml).toContain(
      '<member><name>name</name><value><string>Alice</string></value></member>',
    );
    expect(xml).toContain('<member><name>age</name><value><int>30</int></value></member>');
    expect(xml).not.toContain('missing');
  });
});

describe('encodeMethodCall', () => {
  it('wraps method name + params into the envelope', () => {
    const xml = encodeMethodCall('execute_kw', ['db', 1, ['res.partner', 'search']]);
    expect(xml.startsWith('<?xml version="1.0"?><methodCall>')).toBe(true);
    expect(xml).toContain('<methodName>execute_kw</methodName>');
    expect(xml).toContain('<param><value><string>db</string></value></param>');
    expect(xml).toContain('<param><value><int>1</int></value></param>');
  });
  it('rejects invalid method names (anti-injection)', () => {
    expect(() => encodeMethodCall('exec; rm -rf /', [])).toThrow(/invalid method name/);
    expect(() => encodeMethodCall('<script>', [])).toThrow(/invalid method name/);
  });
  it('accepts dotted notation (system.listMethods style)', () => {
    expect(() => encodeMethodCall('system.listMethods', [])).not.toThrow();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Decoder
// ────────────────────────────────────────────────────────────────────────────

describe('decodeValue', () => {
  it('decodes <nil/> as null', () => {
    expect(decodeValue('<value><nil/></value>')).toBeNull();
  });
  it('decodes boolean', () => {
    expect(decodeValue('<value><boolean>1</boolean></value>')).toBe(true);
    expect(decodeValue('<value><boolean>0</boolean></value>')).toBe(false);
  });
  it('decodes int (both <int> and <i4>)', () => {
    expect(decodeValue('<value><int>42</int></value>')).toBe(42);
    expect(decodeValue('<value><i4>-7</i4></value>')).toBe(-7);
  });
  it('decodes double', () => {
    expect(decodeValue('<value><double>3.14</double></value>')).toBe(3.14);
  });
  it('decodes string + unescape', () => {
    expect(decodeValue('<value><string>a &amp; &quot;b&quot;</string></value>')).toBe('a & "b"');
  });
  it('decodes dateTime.iso8601 → Date', () => {
    const d = decodeValue('<value><dateTime.iso8601>20260604T12:34:56</dateTime.iso8601></value>');
    expect(d).toBeInstanceOf(Date);
    expect((d as Date).toISOString()).toBe('2026-06-04T12:34:56.000Z');
  });
  it('decodes array of mixed', () => {
    const a = decodeValue(
      '<value><array><data><value><int>1</int></value><value><string>x</string></value></data></array></value>',
    );
    expect(a).toEqual([1, 'x']);
  });
  it('decodes struct', () => {
    const s = decodeValue(
      '<value><struct><member><name>name</name><value><string>Alice</string></value></member><member><name>age</name><value><int>30</int></value></member></struct></value>',
    );
    expect(s).toEqual({ name: 'Alice', age: 30 });
  });
  it('treats bare text inside <value> as string (XML-RPC default)', () => {
    expect(decodeValue('<value>hello</value>')).toBe('hello');
  });
});

describe('decodeMethodResponse', () => {
  it('unwraps a single-param successful response', () => {
    const xml =
      '<?xml version="1.0"?><methodResponse><params><param><value><int>123</int></value></param></params></methodResponse>';
    expect(decodeMethodResponse(xml)).toBe(123);
  });
  it('throws OdooFaultError on a fault response', () => {
    const xml = `<?xml version="1.0"?><methodResponse><fault><value><struct>
<member><name>faultCode</name><value><int>1</int></value></member>
<member><name>faultString</name><value><string>AccessError: access denied</string></value></member>
</struct></value></fault></methodResponse>`;
    let caught: unknown = null;
    try {
      decodeMethodResponse(xml);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(OdooFaultError);
    expect((caught as OdooFaultError).fault.faultCode).toBe(1);
    expect((caught as OdooFaultError).fault.faultString).toMatch(/AccessError/);
  });
  it('throws OdooTransportError when the body is HTML (cloudflare / nginx error page)', () => {
    expect(() => decodeMethodResponse('<html><body>502 Bad Gateway</body></html>')).toThrow(
      OdooTransportError,
    );
  });
  it('throws OdooTransportError on empty body', () => {
    expect(() => decodeMethodResponse('')).toThrow(/empty response/);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Round-trip (encoder ↔ decoder)
// ────────────────────────────────────────────────────────────────────────────

describe('round-trip encode ↔ decode', () => {
  it('survives nested struct of array of struct', () => {
    const v: OdooValue = {
      total: 2,
      items: [
        { id: 1, name: 'Mario "Il Capo" Rossi' },
        { id: 2, name: 'Anna & Bianchi', tags: ['vip', 'fattura'] },
      ],
      last_run: new Date(Date.UTC(2026, 5, 4, 10, 0, 0)),
    };
    const encoded = encodeValue(v);
    const decoded = decodeValue(encoded);
    expect(decoded).toEqual({
      total: 2,
      items: [
        { id: 1, name: 'Mario "Il Capo" Rossi' },
        { id: 2, name: 'Anna & Bianchi', tags: ['vip', 'fattura'] },
      ],
      last_run: new Date(Date.UTC(2026, 5, 4, 10, 0, 0)),
    });
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Transport contract — authenticate + executeKw
// ────────────────────────────────────────────────────────────────────────────

function makeTransport(): {
  transport: OdooHttpTransport;
  calls: { url: string; body: string }[];
  queue: { status: number; text: string }[];
} {
  const calls: { url: string; body: string }[] = [];
  const queue: { status: number; text: string }[] = [];
  const transport: OdooHttpTransport = {
    async post(args) {
      calls.push({ url: args.url, body: args.body });
      const next = queue.shift();
      if (!next) throw new Error('test transport: queue exhausted');
      return next;
    },
  };
  return { transport, calls, queue };
}

beforeEach(() => {
  __clearOdooAuthCacheForTests();
});

describe('authenticate', () => {
  const auth = {
    baseUrl: 'https://odoo.example',
    database: 'mydb',
    login: 'admin',
    password: 'pwd',
  };

  it('returns the uid from a successful authenticate response', async () => {
    const { transport, calls, queue } = makeTransport();
    queue.push({
      status: 200,
      text: '<?xml version="1.0"?><methodResponse><params><param><value><int>2</int></value></param></params></methodResponse>',
    });
    const uid = await authenticate(auth, transport);
    expect(uid).toBe(2);
    expect(calls[0]?.url).toBe('https://odoo.example/xmlrpc/2/common');
    expect(calls[0]?.body).toContain('<methodName>authenticate</methodName>');
  });

  it('hits the cache on the second call within TTL', async () => {
    const { transport, queue, calls } = makeTransport();
    queue.push({
      status: 200,
      text: '<?xml version="1.0"?><methodResponse><params><param><value><int>5</int></value></param></params></methodResponse>',
    });
    const a = await authenticate(auth, transport);
    const b = await authenticate(auth, transport);
    expect(a).toBe(5);
    expect(b).toBe(5);
    expect(calls).toHaveLength(1); // only ONE HTTP call total
  });

  it('throws OdooTransportError when Odoo returns False (bad credentials)', async () => {
    const { transport, queue } = makeTransport();
    queue.push({
      status: 200,
      text: '<?xml version="1.0"?><methodResponse><params><param><value><boolean>0</boolean></value></param></params></methodResponse>',
    });
    await expect(authenticate(auth, transport)).rejects.toBeInstanceOf(OdooTransportError);
  });

  it('throws OdooTransportError on HTTP 500', async () => {
    const { transport, queue } = makeTransport();
    queue.push({ status: 500, text: 'boom' });
    await expect(authenticate(auth, transport)).rejects.toBeInstanceOf(OdooTransportError);
  });
});

describe('executeKw', () => {
  const auth = {
    baseUrl: 'https://odoo.example',
    database: 'mydb',
    login: 'admin',
    password: 'pwd',
  };

  it('returns the decoded result on success', async () => {
    const { transport, queue, calls } = makeTransport();
    queue.push({
      status: 200,
      text: '<?xml version="1.0"?><methodResponse><params><param><value><array><data><value><int>1</int></value><value><int>2</int></value></data></array></value></param></params></methodResponse>',
    });
    const out = await executeKw(
      auth,
      2,
      {
        model: 'res.partner',
        method: 'search',
        positional: [[]],
      },
      transport,
    );
    expect(out).toEqual([1, 2]);
    expect(calls[0]?.url).toBe('https://odoo.example/xmlrpc/2/object');
    expect(calls[0]?.body).toContain('<methodName>execute_kw</methodName>');
    expect(calls[0]?.body).toContain('<string>res.partner</string>');
    expect(calls[0]?.body).toContain('<string>search</string>');
  });

  it('throws OdooFaultError on a fault response', async () => {
    const { transport, queue } = makeTransport();
    queue.push({
      status: 200,
      text: '<?xml version="1.0"?><methodResponse><fault><value><struct><member><name>faultCode</name><value><int>1</int></value></member><member><name>faultString</name><value><string>UserError: not allowed</string></value></member></struct></value></fault></methodResponse>',
    });
    await expect(
      executeKw(auth, 2, { model: 'res.partner', method: 'unlink', positional: [[99]] }, transport),
    ).rejects.toBeInstanceOf(OdooFaultError);
  });

  it('rejects malformed model names (anti-injection)', async () => {
    const { transport } = makeTransport();
    await expect(
      executeKw(auth, 2, { model: 'res.partner; DROP TABLE', method: 'search' }, transport),
    ).rejects.toThrow(/invalid model/);
  });

  it('rejects malformed method names', async () => {
    const { transport } = makeTransport();
    await expect(
      executeKw(auth, 2, { model: 'res.partner', method: 'search();drop' }, transport),
    ).rejects.toThrow(/invalid method/);
  });
});
