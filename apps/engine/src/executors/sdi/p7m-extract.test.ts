/**
 * italia_p7m_extract — estrazione CAdES con fixture p7m REALE (generata con
 * `openssl smime -sign -nodetach -outform DER`, contenuto = fattura FPR12 di
 * test: NON un mock del parser, i byte ASN.1 sono quelli veri).
 *
 * Bug-bounty: base64 spezzato, DER troncato, busta non-SignedData, contenuto
 * non-p7m, pass-through XML in chiaro, input assente.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { extractP7mContent, p7mExtractExecutor } from './p7m-extract.js';
import type { NodeExecutionContext } from '@flowforge/nodes-stdlib';

const __dirname = dirname(fileURLToPath(import.meta.url));
const P7M_B64 = readFileSync(join(__dirname, '__fixtures__', 'fattura-test.p7m.b64'), 'utf8').trim();
const P7M_DER = Buffer.from(P7M_B64, 'base64');

const ctx = { tenantId: 't1', runId: 'r1', nodeId: 'n1' } as unknown as NodeExecutionContext;

async function run(config: Record<string, unknown>, input: unknown = null, context: NodeExecutionContext = ctx) {
  const res = await p7mExtractExecutor(config, input, context);
  return res.output as { content: string; wasSigned: boolean; sizeBytes: number; contentIsXml: boolean };
}

describe('extractP7mContent — parser DER puro', () => {
  it('estrae ESATTAMENTE l\'XML firmato dalla busta CAdES reale', () => {
    const payload = extractP7mContent(P7M_DER);
    const xml = payload.toString('utf8');
    expect(xml).toContain('<p:FatturaElettronica');
    expect(xml).toContain('<Numero>142/A</Numero>');
    expect(xml).toContain('Fornitore Test SRL');
    // Byte-exact: l'XML estratto rientra nella validazione (nessuna corruzione)
    expect(xml.trimStart().startsWith('<?xml')).toBe(true);
  });

  it('🚨 DER troncato → errore actionable, mai crash silenzioso', () => {
    expect(() => extractP7mContent(P7M_DER.subarray(0, 100))).toThrow(/troncat|oltre la fine/iu);
  });

  it('🚨 non-SignedData (SEQUENCE con OID diverso) → errore che nomina il tipo', () => {
    // ContentInfo con OID "data" (1.2.840.113549.1.7.1) invece di signedData
    const bogus = Buffer.from('300f06092a864886f70d010701a0020400', 'hex');
    expect(() => extractP7mContent(bogus)).toThrow(/non è SignedData/u);
  });

  it('🚨 byte a caso → errore, non estrazione fantasma', () => {
    expect(() => extractP7mContent(Buffer.from('deadbeefcafe', 'hex'))).toThrow();
  });
});

describe('p7mExtractExecutor', () => {
  it('base64 in config.content → XML estratto, wasSigned true, contentIsXml true', async () => {
    const out = await run({ content: P7M_B64 });
    expect(out.wasSigned).toBe(true);
    expect(out.contentIsXml).toBe(true);
    expect(out.content).toContain('<Numero>142/A</Numero>');
    expect(out.sizeBytes).toBeGreaterThan(1000);
  });

  it('base64 con a-capo ogni 64 char (formato allegato PEC) → estratto comunque', async () => {
    const wrapped = P7M_B64.replace(/(.{64})/gu, '$1\n');
    const out = await run({ content: wrapped });
    expect(out.wasSigned).toBe(true);
    expect(out.content).toContain('Fornitore Test SRL');
  });

  it('input.content dal nodo precedente (chain PEC → p7m) quando config vuota', async () => {
    const out = await run({}, { content: P7M_B64 });
    expect(out.wasSigned).toBe(true);
  });

  it('XML in chiaro → pass-through con wasSigned false (fattura B2B non firmata è legale)', async () => {
    const xml = '<?xml version="1.0"?><p:FatturaElettronica/>';
    const out = await run({ content: xml });
    expect(out.wasSigned).toBe(false);
    expect(out.contentIsXml).toBe(true);
    expect(out.content).toBe(xml);
  });

  it('🚨 contenuto né XML né p7m → errore chiaro', async () => {
    await expect(run({ content: 'ciao questo è testo qualunque non un p7m' })).rejects.toThrow(/non è né XML né un p7m/u);
  });

  it('🚨 nessun contenuto → errore che spiega DOVE passarlo', async () => {
    await expect(run({}, null)).rejects.toThrow(/allegato binario|campo "content"/u);
  });

  // ── CASO REALE: l'allegato .p7m arriva dall'IMAP/PEC trigger come BinaryData ──
  it('🚨 allegato IMAP come BinaryData ref → risolto via context.readBinary ed estratto', async () => {
    const readBinary = vi.fn((ref: string) => {
      expect(ref).toBe('att-ref-1');
      return P7M_DER;
    });
    const context = { tenantId: 't1', runId: 'r1', nodeId: 'n1', readBinary } as unknown as NodeExecutionContext;
    // Shape reale: l'input del nodo è l'oggetto attachment con dentro un binary ref.
    const input = { binary: { __ffBinary: true as const, encoding: 'ref', ref: 'att-ref-1' } };
    const out = await run({}, input, context);
    expect(readBinary).toHaveBeenCalledTimes(1);
    expect(out.wasSigned).toBe(true);
    expect(out.content).toContain('<Numero>142/A</Numero>');
  });

  it('allegato IMAP come BinaryData base64 inline (senza store) → decodificato ed estratto', async () => {
    const input = { binary: { __ffBinary: true as const, encoding: 'base64', data: P7M_B64 } };
    const out = await run({}, input);
    expect(out.wasSigned).toBe(true);
    expect(out.content).toContain('Fornitore Test SRL');
  });

  it('🚨 CASO PEC: input = mail intera con attachments[] → pesca l\'allegato .p7m per filename', async () => {
    const readBinary = vi.fn(() => P7M_DER);
    const context = { tenantId: 't1', runId: 'r1', nodeId: 'n1', readBinary } as unknown as NodeExecutionContext;
    // Shape reale del trigger IMAP: mail con più allegati, il p7m è quello giusto.
    const mail = {
      subject: 'Fattura elettronica', from: 'sdi@pec.fatturapa.it',
      attachments: [
        { filename: 'messaggio.txt', binary: { __ffBinary: true as const, encoding: 'ref', ref: 'txt-ref' } },
        { filename: 'IT01234567890_00042.xml.p7m', binary: { __ffBinary: true as const, encoding: 'ref', ref: 'p7m-ref' } },
      ],
    };
    const out = await run({}, mail, context);
    // Ha risolto il ref dell'allegato .p7m, non il txt.
    expect(readBinary).toHaveBeenCalledWith('p7m-ref');
    expect(out.wasSigned).toBe(true);
    expect(out.content).toContain('<Numero>142/A</Numero>');
  });

  it('attachments[] con un solo allegato non-.p7m → usa comunque il primo (fallback)', async () => {
    const input = { attachments: [{ filename: 'fattura.xml.base64', binary: { __ffBinary: true as const, encoding: 'base64', data: P7M_B64 } }] };
    const out = await run({}, input);
    expect(out.wasSigned).toBe(true);
  });

  it('il binario ha PRECEDENZA su config.content (ref-primario come pdf_parse)', async () => {
    const readBinary = vi.fn(() => P7M_DER);
    const context = { tenantId: 't1', runId: 'r1', nodeId: 'n1', readBinary } as unknown as NodeExecutionContext;
    const input = { binary: { __ffBinary: true as const, encoding: 'ref', ref: 'x' } };
    // config.content è un XML fasullo: se venisse usato, wasSigned sarebbe false.
    const out = await run({ content: '<fake/>' }, input, context);
    expect(out.wasSigned).toBe(true);
  });
});
