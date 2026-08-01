/**
 * Test 2026-grade — Italian-vendor executors (PEC Aruba, SDI fatturapa, Zucchetti).
 *
 * 🚨 BUSINESS+SECURITY-CRITICAL: integrazione enti italiani (SDI agenzia
 * entrate, Aruba PEC, Zucchetti HR). Test mock di network + nodemailer +
 * fs reali per cert/key.
 *
 * Coverage:
 *  - pecArubaSendExecutor:
 *    * SMTP path (default): smtps.pec.aruba.it:465 TLS + auth + body plain text
 *    * SOAP path: WSSE PasswordDigest envelope (SHA-1 mandatory)
 *    * 🚨 attachments JSON parse + SSRF guard URL
 *    * required fields: username/password/to/subject
 *  - zucchettiPayrollExecutor: bearer auth + dryRun flag
 *  - sdiSendInvoiceExecutor:
 *    * skipSigning=true → pass-through XML
 *    * skipSigning=false → carica cert/key + XAdES-BES signature
 *    * 🚨 missing FatturaElettronica root → throw
 *    * 🚨 missing cert → throw esplicito
 *  - sdiCheckStatusExecutor: parse StatoFile XML response
 *  - escapeXml su tutti i campi user-controllable (anti XSS/SOAP injection)
 *  - wsseDigest = SHA-1(nonce + created + password) (WS-Security mandatory)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { writeFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NodeExecutionContext } from '@flowforge/nodes-stdlib';

// Dir di questo test → per leggere le fixture SDI (fattura ufficiale valida).
const __sdiDir = join(dirname(fileURLToPath(import.meta.url)), 'sdi');
// Cert+key X.509 self-signed REALI (fixture) — parsabili da X509Certificate, così
// parseCertMetadata estrae issuer/serial veri (non più il vecchio fallback Unknown/1).
// issuer DN: CN=flowforge-test-signer,O=FlowForge Test CA,C=IT · serial: 305419896 (0x12345678).
const __fixtCertPem = readFileSync(join(__sdiDir, '__fixtures__', 'test-signing-cert.pem'), 'utf-8');
const __fixtKeyPem = readFileSync(join(__sdiDir, '__fixtures__', 'test-signing-key.pem'), 'utf-8');

const m = vi.hoisted(() => ({
  safeFetch: vi.fn(),
  validateUrl: vi.fn(),
  sendMail: vi.fn(),
  close: vi.fn(),
  createTransport: vi.fn(),
}));

vi.mock('@/lib/safe-outbound-fetch.js', () => ({
  safeOutboundFetch: (...a: unknown[]) => m.safeFetch(...a),
}));
vi.mock('@flowforge/safe-fetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@flowforge/safe-fetch')>()),
  validateUrlForFetch: (...a: unknown[]) => m.validateUrl(...a),
}));
vi.mock('nodemailer', () => ({
  createTransport: (...a: unknown[]) => {
    m.createTransport(...a);
    return { sendMail: m.sendMail, close: m.close };
  },
}));

import {
  pecArubaSendExecutor,
  zucchettiPayrollExecutor,
  sdiSendInvoiceExecutor,
  sdiCheckStatusExecutor,
} from './italian.js';

const ctx: NodeExecutionContext = {
  tenantId: 't1', runId: 'r1', workflowId: 'wf1', nodeId: 'n1', secrets: {},
} as NodeExecutionContext;

beforeEach(() => {
  m.safeFetch.mockReset();
  m.validateUrl.mockReset().mockReturnValue({ ok: true });
  m.sendMail.mockReset().mockResolvedValue({
    messageId: '<pec-1@pec.aruba.it>', accepted: ['x@pec.it'], rejected: [], response: '250 OK',
  });
  m.close.mockReset();
  m.createTransport.mockReset();
});

describe('🚨 pecArubaSendExecutor — SMTP default path', () => {
  it('SMTP: createTransport con smtps.pec.aruba.it:465 TLS + auth', async () => {
    await pecArubaSendExecutor({
      username: 'me@pec.aruba.it', password: 'pwd',
      to: 'dest@pec.it', subject: 'oggetto', body: 'corpo PEC',
    }, null, ctx);
    expect(m.createTransport).toHaveBeenCalledWith(expect.objectContaining({
      host: 'smtps.pec.aruba.it', port: 465, secure: true, requireTLS: false,
      auth: { user: 'me@pec.aruba.it', pass: 'pwd' },
    }));
    expect(m.sendMail).toHaveBeenCalledWith(expect.objectContaining({
      from: 'me@pec.aruba.it', to: 'dest@pec.it', subject: 'oggetto', text: 'corpo PEC',
    }));
    expect(m.close).toHaveBeenCalled();
  });

  it('🚨 missing required fields → throw esplicito', async () => {
    await expect(pecArubaSendExecutor({ username: 'me' }, null, ctx))
      .rejects.toThrow(/username\/password\/to\/subject required/u);
  });

  it('output shape: sent/transport/messageId/accepted/rejected', async () => {
    const r = await pecArubaSendExecutor({
      username: 'me@pec.aruba.it', password: 'pwd', to: 'd@pec.it', subject: 'S', body: 'B',
    }, null, ctx);
    const out = r.output as { sent: boolean; transport: string; messageId: string };
    expect(out.sent).toBe(true);
    expect(out.transport).toBe('smtp');
    expect(out.messageId).toBe('<pec-1@pec.aruba.it>');
  });

  it('🚨 attachments JSON invalid → throw', async () => {
    await expect(pecArubaSendExecutor({
      username: 'm', password: 'p', to: 'd', subject: 's',
      attachmentsJson: 'not-json',
    }, null, ctx)).rejects.toThrow(/attachmentsJson is not valid JSON/u);
  });

  it('attachments base64 → content Buffer', async () => {
    await pecArubaSendExecutor({
      username: 'm', password: 'p', to: 'd', subject: 's',
      attachmentsJson: JSON.stringify([{ filename: 'a.pdf', base64: 'aGVsbG8=' }]),
    }, null, ctx);
    const sendCall = m.sendMail.mock.calls[0]?.[0] as { attachments: { filename: string; content: Buffer }[] };
    expect(sendCall.attachments[0]?.filename).toBe('a.pdf');
    expect(sendCall.attachments[0]?.content.toString('utf8')).toBe('hello');
  });

  it('🚨 attachment handle BinaryData inline → content = byte risolti (ref-primario)', async () => {
    const bytes = Buffer.from('PEC-PDF-BYTES');
    const bin = { __ffBinary: true, encoding: 'base64', mimeType: 'application/pdf', size: bytes.length, data: bytes.toString('base64') };
    await pecArubaSendExecutor({
      username: 'm', password: 'p', to: 'd', subject: 's',
      attachmentsJson: JSON.stringify([{ filename: 'fattura.pdf', binary: bin }]),
    }, null, ctx);
    const sendCall = m.sendMail.mock.calls[0]?.[0] as { attachments: { content: Buffer }[] };
    expect(sendCall.attachments[0]?.content.equals(bytes)).toBe(true);
  });

  it('🚨 PRECEDENZA: attachment binary vince su base64', async () => {
    const real = Buffer.from('REAL');
    const bin = { __ffBinary: true, encoding: 'base64', mimeType: 'application/pdf', size: real.length, data: real.toString('base64') };
    await pecArubaSendExecutor({
      username: 'm', password: 'p', to: 'd', subject: 's',
      attachmentsJson: JSON.stringify([{ filename: 'x.pdf', binary: bin, base64: Buffer.from('LEGACY').toString('base64') }]),
    }, null, ctx);
    const sendCall = m.sendMail.mock.calls[0]?.[0] as { attachments: { content: Buffer }[] };
    expect(sendCall.attachments[0]?.content.toString()).toBe('REAL');
  });

  it('🚨 attachment URL SSRF blocked → throw con messaggio CHIARO (non più mascherato)', async () => {
    // FIX 2026-06-20: il parse del JSON e il mapping sono ora SEPARATI → l'errore di
    // sicurezza NON viene più mascherato come "attachmentsJson is not valid JSON".
    m.validateUrl.mockReturnValue({ ok: false, reason: 'private network' });
    await expect(pecArubaSendExecutor({
      username: 'm', password: 'p', to: 'd', subject: 's',
      attachmentsJson: JSON.stringify([{ filename: 'leak.pdf', url: 'http://169.254.169.254/imds' }]),
    }, null, ctx)).rejects.toThrow(/SSRF guard.*private network/u);
    expect(m.validateUrl).toHaveBeenCalledWith('http://169.254.169.254/imds');
  });

  it('attachment URL valid → path passthrough', async () => {
    m.validateUrl.mockReturnValue({ ok: true });
    await pecArubaSendExecutor({
      username: 'm', password: 'p', to: 'd', subject: 's',
      attachmentsJson: JSON.stringify([{ filename: 'doc.pdf', url: 'https://cdn.example.com/d.pdf' }]),
    }, null, ctx);
    const sendCall = m.sendMail.mock.calls[0]?.[0] as { attachments: { path: string }[] };
    expect(sendCall.attachments[0]?.path).toBe('https://cdn.example.com/d.pdf');
  });

  it('🚨🚨 LFI: attachment.path su filesystem (/app/.env) → throw, PEC NON inviata', async () => {
    for (const p of ['/app/.env', '../../etc/passwd', 'file:///etc/passwd']) {
      m.sendMail.mockClear();
      await expect(pecArubaSendExecutor({
        username: 'm', password: 'p', to: 'd', subject: 's',
        attachmentsJson: JSON.stringify([{ filename: 'leak', path: p }]),
      }, null, ctx)).rejects.toThrow(/non ammesso.*filesystem|LFI|filesystem/u);
      expect(m.sendMail).not.toHaveBeenCalled();
    }
  });
});

describe('🚨 pecArubaSendExecutor — SOAP legacy path', () => {
  it('SOAP path: WSSE envelope con UsernameToken digest', async () => {
    m.safeFetch.mockResolvedValue({
      ok: true, status: 200,
      text: async () => '<response><MessageId>msg-123</MessageId></response>',
    });
    await pecArubaSendExecutor({
      username: 'me@pec.it', password: 'pwd', to: 'dest@pec.it', subject: 'S', body: 'B',
      transport: 'soap',
    }, null, ctx);
    expect(m.safeFetch).toHaveBeenCalledWith(
      'https://ws.pec.aruba.it/PecManagement/services/PecService',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Content-Type': 'text/xml; charset=utf-8',
          SOAPAction: '"SendMail"',
        }),
      }),
    );
    const envelope = (m.safeFetch.mock.calls[0]?.[1] as { body: string }).body;
    expect(envelope).toContain('<wsse:UsernameToken>');
    expect(envelope).toContain('<wsse:Username>me@pec.it</wsse:Username>');
    expect(envelope).toContain('<wsse:Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">');
    expect(envelope).toContain('<wsse:Nonce');
    expect(envelope).toContain('<pec:SendMail>');
  });

  it('SOAP: parse MessageId dalla response XML', async () => {
    m.safeFetch.mockResolvedValue({
      ok: true, status: 200,
      text: async () => '<x><MessageId>my-msg-id-99</MessageId></x>',
    });
    const r = await pecArubaSendExecutor({
      username: 'u', password: 'p', to: 'd', subject: 's', body: 'b', transport: 'soap',
    }, null, ctx);
    const out = r.output as { transport: string; messageId: string };
    expect(out.transport).toBe('soap');
    expect(out.messageId).toBe('my-msg-id-99');
  });

  it('🚨 SOAP HTTP error → throw con status code', async () => {
    m.safeFetch.mockResolvedValue({ ok: false, status: 500, text: async () => 'internal' });
    await expect(pecArubaSendExecutor({
      username: 'u', password: 'p', to: 'd', subject: 's', body: 'b', transport: 'soap',
    }, null, ctx)).rejects.toThrow(/PEC Aruba \(SOAP\) 500/u);
  });

  it('🚨 escapeXml su username/to/subject (anti XML injection)', async () => {
    m.safeFetch.mockResolvedValue({ ok: true, status: 200, text: async () => '<x/>' });
    await pecArubaSendExecutor({
      username: 'me<x>@pec.it', password: 'p',
      to: 'dest&evil@pec.it', subject: 'subj"quote', body: "body'apex",
      transport: 'soap',
    }, null, ctx);
    const envelope = (m.safeFetch.mock.calls[0]?.[1] as { body: string }).body;
    expect(envelope).toContain('me&lt;x&gt;@pec.it');
    expect(envelope).toContain('dest&amp;evil@pec.it');
    expect(envelope).toContain('subj&quot;quote');
    expect(envelope).toContain('body&apos;apex');
    expect(envelope).not.toContain('<x>');
  });

  it('🚨🚨 ANTI-ESFILTRAZIONE: endpoint SOAP=attacker.com → blocco, user/pass MAI spediti', async () => {
    await expect(pecArubaSendExecutor({
      username: 'me@pec.aruba.it', password: 'SECRET', to: 'd', subject: 's', body: 'b',
      transport: 'soap', endpoint: 'https://attacker.com/PecService',
    }, null, ctx)).rejects.toThrow(/host non consentito|host/u);
    expect(m.safeFetch).not.toHaveBeenCalled();
  });
});

describe('🚨 zucchettiPayrollExecutor', () => {
  it('happy: POST /payroll/jobs + Bearer + body', async () => {
    m.safeFetch.mockResolvedValue({
      ok: true, status: 200, json: async () => ({ jobId: 'job-1' }),
    });
    const r = await zucchettiPayrollExecutor({
      baseUrl: 'https://api.zucchetti.com', apiToken: 'tok-1',
      companyCode: 'AC01', period: '2026-05', dryRun: true,
    }, null, ctx);
    expect(m.safeFetch).toHaveBeenCalledWith(
      'https://api.zucchetti.com/payroll/jobs',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer tok-1', 'Content-Type': 'application/json',
        }),
      }),
    );
    const body = JSON.parse((m.safeFetch.mock.calls[0]?.[1] as { body: string }).body) as Record<string, unknown>;
    expect(body).toEqual({ companyCode: 'AC01', period: '2026-05', dryRun: true });
    const out = r.output as { jobId: string };
    expect(out.jobId).toBe('job-1');
  });

  it('dryRun=false default', async () => {
    m.safeFetch.mockResolvedValue({
      ok: true, status: 200, json: async () => ({}),
    });
    await zucchettiPayrollExecutor({
      baseUrl: 'https://api.zucchetti.com', apiToken: 't', companyCode: 'C', period: '2026-01',
    }, null, ctx);
    const body = JSON.parse((m.safeFetch.mock.calls[0]?.[1] as { body: string }).body) as Record<string, unknown>;
    expect(body.dryRun).toBe(false);
  });

  it('🚨 missing required → throw', async () => {
    await expect(zucchettiPayrollExecutor({ baseUrl: 'x' }, null, ctx))
      .rejects.toThrow(/baseUrl\/apiToken\/companyCode\/period required/u);
  });

  it('🚨 HTTP error → throw con status', async () => {
    m.safeFetch.mockResolvedValue({
      ok: false, status: 401, text: async () => 'unauth',
    });
    await expect(zucchettiPayrollExecutor({
      baseUrl: 'https://api.zucchetti.com', apiToken: 't', companyCode: 'C', period: 'P',
    }, null, ctx)).rejects.toThrow(/Zucchetti 401/u);
  });

  it('🚨🚨 ANTI-ESFILTRAZIONE: baseUrl=attacker.com → blocco, Bearer MAI spedito', async () => {
    await expect(zucchettiPayrollExecutor({
      baseUrl: 'https://attacker.com', apiToken: 'SECRET', companyCode: 'C', period: 'P',
    }, null, ctx)).rejects.toThrow(/host non consentito|non ammesso|host/u);
    expect(m.safeFetch).not.toHaveBeenCalled();
  });

  it('🚨 baseUrl lookalike (xzucchetti.com / zucchetti.com.evil.net) → bloccato', async () => {
    for (const baseUrl of ['https://xzucchetti.com', 'https://api.zucchetti.com.evil.net']) {
      m.safeFetch.mockReset();
      await expect(zucchettiPayrollExecutor({
        baseUrl, apiToken: 'SECRET', companyCode: 'C', period: 'P',
      }, null, ctx)).rejects.toThrow(/host non consentito|host/u);
      expect(m.safeFetch).not.toHaveBeenCalled();
    }
  });
});

describe('🚨 sdiSendInvoiceExecutor', () => {
  // Stub XML NON conforme XSD: questi test isolano firma/upload, non la validazione →
  // ogni chiamata passa validateXsd:false (la validazione XSD ha i suoi test dedicati sotto).
  const baseInvoiceXml = '<?xml version="1.0"?><FatturaElettronica><HeaderXX/><BodyXX/></FatturaElettronica>';

  beforeEach(() => {
    m.safeFetch.mockResolvedValue({
      ok: true, status: 200,
      text: async () => '<r><IdentificativoSdI>sdi-99</IdentificativoSdI><DataOraRicezione>2026-06-06T10:00:00</DataOraRicezione></r>',
    });
  });

  it('skipSigning=true → bypass signing, upload as-is', async () => {
    const r = await sdiSendInvoiceExecutor({
      invoiceXml: baseInvoiceXml, validateXsd: false,
      sdiUsername: 'u', sdiPassword: 'p',
      skipSigning: true, fileName: 'IT12345_F0.xml',
    }, null, ctx);
    expect(m.safeFetch).toHaveBeenCalled();
    const out = r.output as { fileName: string; identificativoSdi: string; signedXml: string | null };
    expect(out.fileName).toBe('IT12345_F0.xml');
    expect(out.identificativoSdi).toBe('sdi-99');
    expect(out.signedXml).toBeNull(); // skipSigning marker
    // 🚨 ANTI-REGRESSIONE: anche il path FUNZIONANTE (Mode A pre-firmato) usava
    // l'envelope errato `rifiuta`/`fileXml` → il bug rompeva pure questo.
    const sentEnvelope = (m.safeFetch.mock.calls[0]?.[1] as { body: string }).body;
    expect(sentEnvelope).toContain('<tns:fileSdIAccoglienza>');
    expect(sentEnvelope).not.toContain('rifiuta');
  });

  it('🚨🚨 ANTI-ESFILTRAZIONE: sdiUrl=attacker.com → blocco, Basic auth MAI spedito', async () => {
    await expect(sdiSendInvoiceExecutor({
      invoiceXml: baseInvoiceXml, validateXsd: false, skipSigning: true,
      sdiUsername: 'u', sdiPassword: 'SECRET', fileName: 'IT1_F0.xml',
      sdiUrl: 'https://attacker.com/RiceviFile',
    }, null, ctx)).rejects.toThrow(/host non consentito|host/u);
    expect(m.safeFetch).not.toHaveBeenCalled();
  });

  it('✅ sdiUrl ufficiale (servizi.fatturapa.it) passa il guard', async () => {
    await expect(sdiSendInvoiceExecutor({
      invoiceXml: baseInvoiceXml, validateXsd: false, skipSigning: true,
      sdiUsername: 'u', sdiPassword: 'p', fileName: 'IT1_F0.xml',
      sdiUrl: 'https://servizi.fatturapa.it/Services/SdIRiceviFile/RiceviFile',
    }, null, ctx)).resolves.toBeDefined();
    expect(m.safeFetch).toHaveBeenCalledTimes(1);
  });

  it('🚨 invoiceXml mancante → throw', async () => {
    await expect(sdiSendInvoiceExecutor({
      sdiUsername: 'u', sdiPassword: 'p', skipSigning: true,
    }, null, ctx)).rejects.toThrow(/invoiceXml richiesto/u);
  });

  it('🚨 validateXsd default ON: XML con root FatturaElettronica ma contenuto NON conforme → RIFIUTATO pre-invio, NESSUN upload', async () => {
    // Well-formed, root giusta, ma SENZA FatturaElettronicaHeader/Body né i campi required
    // dello schema FatturaPA v1.2.2 → la validazione XSD lo rigetta PRIMA di firmare/inviare.
    const xsdInvalid = '<?xml version="1.0"?><p:FatturaElettronica '
      + 'xmlns:p="http://ivaservizi.agenziaentrate.gov.it/docs/xsd/fatture/v1.2" versione="FPR12">'
      + '<Bogus>non conforme allo schema</Bogus></p:FatturaElettronica>';
    await expect(sdiSendInvoiceExecutor({
      invoiceXml: xsdInvalid, sdiUsername: 'u', sdiPassword: 'p', skipSigning: true,
    }, null, ctx)).rejects.toThrow(/NON è conforme allo schema XSD FatturaPA/u);
    expect(m.safeFetch).not.toHaveBeenCalled(); // bloccato prima dell'upload
  });

  it('🚨 validateXsd:false → bypassa la validazione (XML non conforme viene caricato lo stesso)', async () => {
    const xsdInvalid = '<?xml version="1.0"?><FatturaElettronica><Bogus>non conforme</Bogus></FatturaElettronica>';
    const r = await sdiSendInvoiceExecutor({
      invoiceXml: xsdInvalid, sdiUsername: 'u', sdiPassword: 'p', skipSigning: true, validateXsd: false,
    }, null, ctx);
    expect(m.safeFetch).toHaveBeenCalled(); // bypass esplicito → nessun rigetto
    expect((r.output as { identificativoSdi: string }).identificativoSdi).toBe('sdi-99');
  });

  it('🚨 fattura ufficiale VALIDA + validateXsd ON → passa la validazione e procede all\'upload', async () => {
    const validInvoice = readFileSync(join(__sdiDir, '__fixtures__', 'IT01234567890_FPR01.xml'), 'utf-8');
    const r = await sdiSendInvoiceExecutor({
      invoiceXml: validInvoice, sdiUsername: 'u', sdiPassword: 'p', skipSigning: true,
      // validateXsd default ON: la fattura ufficiale passa → upload eseguito.
    }, null, ctx);
    expect(m.safeFetch).toHaveBeenCalled();
    expect((r.output as { identificativoSdi: string }).identificativoSdi).toBe('sdi-99');
  });

  it('🚨 credentials mancanti → throw', async () => {
    await expect(sdiSendInvoiceExecutor({
      invoiceXml: baseInvoiceXml, validateXsd: false, skipSigning: true,
    }, null, ctx)).rejects.toThrow(/sdiUsername.*sdiPassword/u);
  });

  it('🚨 HTTP error SDI → throw con status', async () => {
    m.safeFetch.mockResolvedValue({
      ok: false, status: 503, text: async () => 'service down',
    });
    await expect(sdiSendInvoiceExecutor({
      invoiceXml: baseInvoiceXml, validateXsd: false, sdiUsername: 'u', sdiPassword: 'p', skipSigning: true,
    }, null, ctx)).rejects.toThrow(/SDI upload 503/u);
  });

  it('🚨 signing path: cert+key da PEM inline → XAdES envelope generato + IssuerSerial REALE', async () => {
    const r = await sdiSendInvoiceExecutor({
      invoiceXml: baseInvoiceXml, validateXsd: false,
      sdiUsername: 'u', sdiPassword: 'p',
      certPem: __fixtCertPem, keyPem: __fixtKeyPem, skipSigning: false,
    }, null, ctx);
    const out = r.output as { signedXml: string };
    // output truncato a 2000 char (preview): ds:Signature/SignatureValue stanno in
    // testa; SignedProperties/issuer/serial sono dopo l'X509Certificate → asseriti
    // sul `decoded` completo più sotto.
    expect(out.signedXml).toContain('<ds:Signature');
    expect(out.signedXml).toContain('<ds:SignatureValue>');

    // 🚨 ANTI-REGRESSIONE BUG CRITICO: il SOAP RiceviFile deve usare
    // fileSdIAccoglienza/NomeFile/File — NON l'errato rifiuta/fileName/fileXml.
    const sentEnvelope = (m.safeFetch.mock.calls[0]?.[1] as { body: string }).body;
    expect(sentEnvelope).toContain('<tns:fileSdIAccoglienza>');
    expect(sentEnvelope).toContain('<NomeFile>');
    expect(sentEnvelope).toContain('<File>');
    expect(sentEnvelope).not.toContain('rifiuta'); // 'rifiuta' = REJECT, mai in un invio
    expect(sentEnvelope).not.toContain('fileXml');

    const fileMatch = /<File>([^<]+)<\/File>/u.exec(sentEnvelope);
    expect(fileMatch).toBeTruthy();
    // `decoded` = XML firmato COMPLETO (out.signedXml è solo un preview troncato a
    // 2000 char: con un cert reale l'X509Certificate spinge SignedProperties oltre).
    const decoded = Buffer.from(fileMatch?.[1] ?? '', 'base64').toString('utf8');
    expect(decoded).toContain('</FatturaElettronica>');
    expect(decoded).toContain('<ds:Signature');
    expect(decoded).toContain('<xades:SignedProperties');

    // 🚨 parseCertMetadata REALE: la firma deve portare l'issuer DN e il serial
    // DECIMALE del cert vero — non più il fallback Unknown/1.
    expect(decoded).toContain('CN=flowforge-test-signer');
    expect(decoded).toContain('<ds:X509SerialNumber xmlns:ds="http://www.w3.org/2000/09/xmldsig#">305419896</ds:X509SerialNumber>');
    expect(decoded).not.toContain('CN=Unknown');
  });

  it('🚨 signing con cert PEM NON parsabile → fail-fast esplicito (no firma con metadata fasulli)', async () => {
    // Vecchio comportamento: parseCertMetadata cadeva su fallback Unknown/1 e
    // firmava lo stesso. Ora X509Certificate rifiuta un PEM che non è un cert.
    const fakeCert = '-----BEGIN CERTIFICATE-----\nbm90LWEtY2VydA==\n-----END CERTIFICATE-----';
    await expect(sdiSendInvoiceExecutor({
      invoiceXml: baseInvoiceXml, validateXsd: false,
      sdiUsername: 'u', sdiPassword: 'p',
      certPem: fakeCert, keyPem: __fixtKeyPem, skipSigning: false,
    }, null, ctx)).rejects.toThrow(/certificato X\.509 non parsabile/u);
  });

  it('🚨 signing su XML senza root FatturaElettronica → throw', async () => {
    await expect(sdiSendInvoiceExecutor({
      invoiceXml: '<?xml version="1.0"?><WrongRoot><inner/></WrongRoot>',
      sdiUsername: 'u', sdiPassword: 'p',
      certPem: __fixtCertPem, keyPem: __fixtKeyPem, skipSigning: false,
      validateXsd: false, // isola il check root del signing (con XSD ON sarebbe rigettato prima)
    }, null, ctx)).rejects.toThrow(/root <FatturaElettronica> non trovata/u);
  });

  it('🚨 signing senza cert/key → throw esplicito', async () => {
    await expect(sdiSendInvoiceExecutor({
      invoiceXml: baseInvoiceXml, validateXsd: false,
      sdiUsername: 'u', sdiPassword: 'p',
      skipSigning: false, // no cert/key/env path
    }, null, ctx)).rejects.toThrow(/Missing FLOWFORGE_SDI/u);
  });

  it('signing via cert/key da disk path (tmp dir)', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'ff-sdi-'));
    const certPath = join(tmpDir, 'cert.pem');
    const keyPath = join(tmpDir, 'key.pem');
    writeFileSync(certPath, __fixtCertPem);
    writeFileSync(keyPath, __fixtKeyPem);

    const r = await sdiSendInvoiceExecutor({
      invoiceXml: baseInvoiceXml, validateXsd: false,
      sdiUsername: 'u', sdiPassword: 'p',
      certPath, keyPath, skipSigning: false,
    }, null, ctx);
    const out = r.output as { signedXml: string };
    expect(out.signedXml).toContain('<ds:Signature');
  });

  it('fileName default = IT<timestamp>_FF.xml', async () => {
    const r = await sdiSendInvoiceExecutor({
      invoiceXml: baseInvoiceXml, validateXsd: false, sdiUsername: 'u', sdiPassword: 'p', skipSigning: true,
    }, null, ctx);
    const out = r.output as { fileName: string };
    expect(out.fileName).toMatch(/^IT\d+_FF\.xml$/u);
  });

  it('🚨 Basic auth header costruito da username:password', async () => {
    await sdiSendInvoiceExecutor({
      invoiceXml: baseInvoiceXml, validateXsd: false,
      sdiUsername: 'sdiUser', sdiPassword: 'sdiPwd',
      skipSigning: true,
    }, null, ctx);
    const init = m.safeFetch.mock.calls[0]?.[1] as { headers: Record<string, string> };
    const expectedAuth = `Basic ${Buffer.from('sdiUser:sdiPwd').toString('base64')}`;
    expect(init.headers.Authorization).toBe(expectedAuth);
  });
});

describe('🚨 sdiCheckStatusExecutor', () => {
  it('happy: parse StatoFile dalla response', async () => {
    m.safeFetch.mockResolvedValue({
      ok: true, status: 200,
      text: async () => '<r><StatoFile>RC</StatoFile></r>',
    });
    const r = await sdiCheckStatusExecutor({
      fileName: 'IT123_F0.xml', sdiUsername: 'u', sdiPassword: 'p',
    }, null, ctx);
    const out = r.output as { fileName: string; status: string };
    expect(out.fileName).toBe('IT123_F0.xml');
    expect(out.status).toBe('RC');
  });

  it('🚨 missing required → throw', async () => {
    await expect(sdiCheckStatusExecutor({ fileName: 'x' }, null, ctx))
      .rejects.toThrow(/fileName\/sdiUsername\/sdiPassword required/u);
  });

  it('status unknown se XML response non contiene StatoFile', async () => {
    m.safeFetch.mockResolvedValue({
      ok: true, status: 200, text: async () => '<r>nothing</r>',
    });
    const r = await sdiCheckStatusExecutor({
      fileName: 'x', sdiUsername: 'u', sdiPassword: 'p',
    }, null, ctx);
    const out = r.output as { status: string };
    expect(out.status).toBe('unknown');
  });

  it('🚨 HTTP error → throw con status', async () => {
    m.safeFetch.mockResolvedValue({ ok: false, status: 404, text: async () => 'not found' });
    await expect(sdiCheckStatusExecutor({
      fileName: 'x', sdiUsername: 'u', sdiPassword: 'p',
    }, null, ctx)).rejects.toThrow(/SDI status 404/u);
  });

  it('fileName URL-encoded nel query string', async () => {
    m.safeFetch.mockResolvedValue({
      ok: true, status: 200, text: async () => '<r/>',
    });
    await sdiCheckStatusExecutor({
      fileName: 'IT/special chars.xml', sdiUsername: 'u', sdiPassword: 'p',
    }, null, ctx);
    const url = m.safeFetch.mock.calls[0]?.[0] as string;
    expect(url).toContain('IT%2Fspecial%20chars.xml');
  });
});
