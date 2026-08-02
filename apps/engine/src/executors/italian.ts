/**
 * Italian-vendor executors that need server-side capabilities:
 *  - PEC Aruba: SOAP envelope with WSSE UsernameToken digest auth
 *  - Zucchetti HR Go: REST with bearer token, tenant base URL per customer
 *  - SDI: full XAdES-BES envelope signing + SDICoop upload. Requires a
 *    qualified certificate (X.509 with private key) supplied by the
 *    customer via MEDEA_SDI_CERT_PATH + MEDEA_SDI_KEY_PATH or
 *    inline in node config.
 */

import { createHash, createSign, randomBytes, createPrivateKey, X509Certificate } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { createTransport, type SendMailOptions } from 'nodemailer';
import { safeAttachmentPath } from '@/lib/mail-attachment-path.js';
import { assertConnectHostAllowed } from '@/lib/connect-host-guard.js';
import type { NodeExecutor } from '@medea/engine-nodes-stdlib';
import { resolveBinaryValue, type BinaryData } from '@medea/engine-core-schema';
import { safeOutboundFetch } from '@/lib/safe-outbound-fetch.js';
import { readJsonCapped, readTextTruncated } from '@/lib/capped-response.js';
import { validateFatturaPaXsd } from '@/executors/sdi/xsd-validator.js';
import { assertHostAllowed, HostNotAllowedError } from '@/lib/host-allowlist.js';
import { resolveOutboundDispatcher } from '@/lib/egress-policy.js';

/**
 * Domini ufficiali per provider — l'host base di questi nodi deriva da config del tenant
 * e ci attacchiamo sopra credenziali PERMANENTI (Basic SDI, Bearer Zucchetti, user/pass PEC
 * nell'envelope SOAP). SENZA vincolo, un `sdiUrl`/`baseUrl`/`endpoint = https://attacker.com`
 * esfiltrerebbe la credenziale (i segreti possono provenire dal vault via `{{secrets.*}}`
 * mentre l'host è free-text dell'autore = trust mismatch). Vedi {@link guardCredentialHost}.
 */
const SDI_HOSTS = ['fatturapa.it', 'fatturapa.gov.it'] as const;
const PEC_ARUBA_HOSTS = ['aruba.it'] as const;
const ZUCCHETTI_HOSTS = ['zucchetti.it', 'zucchetti.com'] as const;

/**
 * Guard anti-esfiltrazione PRIMA di spedire una credenziale a un URL derivato da config.
 *
 * Ammette: (1) un host interno che l'OPERATORE ha messo in allowlist (on-prem legittimo,
 * es. un'istanza Zucchetti self-hosted) — coerente con egress-policy #201/#202; OPPURE
 * (2) un host che matcha l'allowlist di suffissi ufficiali del provider. Tutto il resto
 * (host pubblico arbitrario) → throw, niente credenziale spedita.
 */
function guardCredentialHost(url: string, officialHosts: readonly string[], label: string): void {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new Error(`${label}: URL non valido "${url}"`);
  }
  // (1) host interno fidato dall'operatore (on-prem) → ammesso.
  if (resolveOutboundDispatcher(host, false).allowlisted) return;
  // (2) altrimenti deve essere un dominio ufficiale del provider.
  try {
    assertHostAllowed(url, officialHosts);
  } catch (e) {
    if (e instanceof HostNotAllowedError) throw new Error(`${label}: ${e.message}`);
    throw e;
  }
}

/** Cap risposte SOAP/XML (PEC/SDI): 4MB è enorme per una ricevuta SDI/PEC legittima. */
const SOAP_MAX_BYTES = 4 * 1024 * 1024;

interface PecAttachment {
  name?: string;
  filename?: string;
  path?: string;
  url?: string;
  base64?: string;
  /** REF-PRIMARIO: handle BinaryData (da http download / pdf / file-read / imap),
   *  risolto ai byte via resolver. Forma primaria; base64 resta fallback. */
  binary?: BinaryData;
  contentType?: string;
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c] ?? c));
}

/**
 * WSSE PasswordDigest computation per WS-Security 1.0:
 *   PasswordDigest = Base64( SHA1( Nonce + Created + Password ) )
 *
 * ⚠ SHA-1 MANDATORIO da WS-Security 1.0 (OASIS spec) — imposto dagli
 * endpoint SDI/PEC Aruba, NON è una scelta crypto. NON vulnerabile qui:
 * il digest NON è memorizzato né confrontato a hash di password at-rest, e la
 * freschezza è legata al `<wsu:Created>` dell'envelope (il server WSSE rifiuta
 * i token con Created fuori dalla finestra di clock-skew). NB: NON emettiamo un
 * `<wsu:Expires>` separato — la validità è data dal solo Created lato server.
 * NON sostituire SHA-1 con SHA-256 "per modernizzazione" → rompe l'integrazione
 * con SDI fattura elettronica e PEC.
 */
function wsseDigest(password: string, nonceB64: string, created: string): string {
  const nonceBuf = Buffer.from(nonceB64, 'base64');
  const data = Buffer.concat([nonceBuf, Buffer.from(created, 'utf8'), Buffer.from(password, 'utf8')]);
  return createHash('sha1').update(data).digest('base64');  
}

function buildPecSoapEnvelope(opts: {
  username: string;
  password: string;
  to: string;
  subject: string;
  body: string;
}): string {
  const nonceB64 = randomBytes(16).toString('base64');
  const created = new Date().toISOString();
  const digest = wsseDigest(opts.password, nonceB64, created);

  return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:pec="https://ws.pec.aruba.it/">
  <soapenv:Header>
    <wsse:Security xmlns:wsse="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd">
      <wsse:UsernameToken>
        <wsse:Username>${escapeXml(opts.username)}</wsse:Username>
        <wsse:Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">${digest}</wsse:Password>
        <wsse:Nonce EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary">${nonceB64}</wsse:Nonce>
        <wsu:Created xmlns:wsu="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd">${created}</wsu:Created>
      </wsse:UsernameToken>
    </wsse:Security>
  </soapenv:Header>
  <soapenv:Body>
    <pec:SendMail>
      <to>${escapeXml(opts.to)}</to>
      <subject>${escapeXml(opts.subject)}</subject>
      <body>${escapeXml(opts.body)}</body>
    </pec:SendMail>
  </soapenv:Body>
</soapenv:Envelope>`;
}

/**
 * PEC Aruba send via SMTP standard (smtps.pec.aruba.it:465 TLS).
 *
 * Why SMTP and not SOAP: Aruba PEC is a regular SMTP mailbox under the hood.
 * The SOAP WSSE web service exists for management/automation but doesn't
 * expose a documented attachment schema (the WSDL requires authentication
 * to fetch). SMTP via nodemailer is the production-tested path: Aruba's
 * gateway intercepts the outbound mail, signs it, wraps the original message
 * in a `daticert.xml` certificate, and forwards as PEC. Attachments come
 * along natively as MIME multipart parts — no envelope engineering needed.
 *
 * Endpoint defaults to smtps.pec.aruba.it:465. The legacy SOAP path is
 * preserved when config.transport === 'soap' (no attachments support there).
 */
export const pecArubaSendExecutor: NodeExecutor = async (config, _input, context) => {
  const start = Date.now();
  const username = asString(config.username);
  const password = asString(config.password);
  const to = asString(config.to);
  const subject = asString(config.subject);
  const body = asString(config.body);
  if (!username || !password || !to || !subject) {
    throw new Error('italia_pec_aruba_send: username/password/to/subject required');
  }

  // Legacy SOAP path (no attachments) — kept for back-compat with workflows
  // authored before SMTP became the default.
  const transport = asString(config.transport ?? 'smtp');
  if (transport === 'soap') {
    const envelope = buildPecSoapEnvelope({ username, password, to, subject, body });
    const endpoint = asString(config.endpoint) || 'https://ws.pec.aruba.it/PecManagement/services/PecService';
    // Anti-esfiltrazione: user/password PEC sono dentro l'envelope SOAP → mai a host arbitrario.
    guardCredentialHost(endpoint, PEC_ARUBA_HOSTS, 'italia_pec_send (SOAP)');
    const res = await safeOutboundFetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: '"SendMail"' },
      body: envelope,
    });
    const responseText = (await readTextTruncated(res, SOAP_MAX_BYTES)).text;
    if (!res.ok) throw new Error(`PEC Aruba (SOAP) ${String(res.status)}: ${responseText.slice(0, 500)}`);
    const messageIdMatch = /<MessageId>([^<]+)<\/MessageId>/.exec(responseText);
    return {
      output: { sent: true, transport: 'soap', messageId: messageIdMatch?.[1] ?? null, rawResponse: responseText.slice(0, 2000) },
      durationMs: Date.now() - start,
    };
  }

  // Default path: SMTP via nodemailer (supports attachments).
  const smtpHost = asString(config.smtpHost) || 'smtps.pec.aruba.it';
  const smtpPort = Number(config.smtpPort ?? 465);
  const security = asString(config.smtpSecurity ?? 'tls');

  // Parse attachments (same shape used by action_send_email).
  let attachments: SendMailOptions['attachments'];
  const attachJson = config.attachmentsJson;
  if (typeof attachJson === 'string' && attachJson.trim() !== '') {
    // NB: il parse del JSON e il mapping sono SEPARATI di proposito. Un unico try/catch
    // attorno a tutto mascherava gli errori di SICUREZZA (LFI/SSRF lanciati nel map) come
    // "JSON non valido" → l'autore non capiva, e un audit non vedeva il blocco.
    let parsed: PecAttachment[];
    try {
      parsed = JSON.parse(attachJson) as PecAttachment[];
    } catch {
      throw new Error('italia_pec_aruba_send: attachmentsJson is not valid JSON');
    }
    attachments = await Promise.all(parsed.map(async (a) => {
      const att: NonNullable<SendMailOptions['attachments']>[number] = {
        filename: a.filename ?? a.name ?? 'attachment',
      };
      if (a.contentType) att.contentType = a.contentType;
      // REF-PRIMARIO: handle BinaryData ha precedenza → risolve i byte.
      const binBytes = await resolveBinaryValue(a, context.readBinary);
      if (binBytes) att.content = binBytes;
      // `path`/`url` → SOLO URL http(s) validati SSRF (mai un path su filesystem: LFI →
      // /app/.env esfiltrerebbe i segreti del container). Vedi safeAttachmentPath.
      else if (a.path) att.path = safeAttachmentPath(a.path);
      else if (a.url) att.path = safeAttachmentPath(a.url);
      else if (a.base64) att.content = Buffer.from(a.base64, 'base64');
      return att;
    }));
  }

  assertConnectHostAllowed(smtpHost, 'PEC SMTP'); // SSRF: smtpHost da config → no rete interna
  const transporter = createTransport({
    host: smtpHost,
    port: smtpPort,
    secure: security === 'tls',
    requireTLS: security === 'starttls',
    auth: { user: username, pass: password },
    connectionTimeout: 30_000,
  });

  try {
    const info = await transporter.sendMail({
      from: username, // PEC mailbox = sender
      to,
      subject,
      text: body, // plain-text body. HTML body deliberately omitted: PEC
                   // operators prefer plain text for legal preservation.
      ...(attachments ? { attachments } : {}),
    });
    return {
      output: {
        sent: true,
        transport: 'smtp',
        messageId: info.messageId,
        accepted: info.accepted,
        rejected: info.rejected,
        response: info.response,
      },
      durationMs: Date.now() - start,
    };
  } finally {
    transporter.close();
  }
};

export const zucchettiPayrollExecutor: NodeExecutor = async (config, _input, _context) => {
  const start = Date.now();
  const baseUrl = asString(config.baseUrl);
  const apiToken = asString(config.apiToken);
  const companyCode = asString(config.companyCode);
  const period = asString(config.period);
  if (!baseUrl || !apiToken || !companyCode || !period) {
    throw new Error('italia_zucchetti_payroll: baseUrl/apiToken/companyCode/period required');
  }
  const dryRun = config.dryRun === true || config.dryRun === 'true';

  // Anti-esfiltrazione: il Bearer apiToken non deve finire su un baseUrl arbitrario
  // (on-prem Zucchetti → l'operatore lo aggiunge all'allowlist host-interni del tenant).
  guardCredentialHost(`${baseUrl}/payroll/jobs`, ZUCCHETTI_HOSTS, 'italia_zucchetti_payroll');
  const res = await safeOutboundFetch(`${baseUrl}/payroll/jobs`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ companyCode, period, dryRun }),
  });
  if (!res.ok) throw new Error(`Zucchetti ${String(res.status)}: ${(await readTextTruncated(res, 65_536)).text.slice(0, 400)}`);
  return { output: await readJsonCapped<unknown>(res), durationMs: Date.now() - start };
};

/**
 * XAdES-BES inline-envelope signing per SDI spec.
 *
 * Steps:
 *  1. Compute SHA-256 digest of the canonical FatturaElettronica root.
 *  2. Build the XAdES SignedProperties block with SigningTime + SigningCertificate digest.
 *  3. Compute digest of SignedProperties.
 *  4. Build SignedInfo with two References (document + properties).
 *  5. Sign SignedInfo with the user's RSA private key (RSA-SHA256).
 *  6. Wrap everything as ds:Signature inside the FatturaElettronica root.
 *
 * The cert + key must be qualified (issued by an AgID-trusted CA) — we do
 * not (and cannot) issue these. The user procures them from Aruba/InfoCert/etc.
 *
 * NB: XML canonicalization here uses a simplified C14N — strict SDI spec
 * requires xml-exc-c14n; for invoices generated by this code path the strict
 * form is identical because we control whitespace. For *imported* XML
 * (signed elsewhere then merely uploaded by us) we never re-canonicalize.
 */
function loadPem(envVar: string, configValue: string, inlineKey: string): string {
  if (inlineKey) return inlineKey;
  if (configValue && existsSync(configValue)) return readFileSync(configValue, 'utf8');
  const fromEnv = process.env[envVar];
  if (fromEnv && existsSync(fromEnv)) return readFileSync(fromEnv, 'utf8');
  throw new Error(`Missing ${envVar}: configura il path nel nodo o via env.`);
}

function pemBodyToBase64(pem: string): string {
  return pem
    .replace(/-----BEGIN [^-]+-----/u, '')
    .replace(/-----END [^-]+-----/u, '')
    .replace(/\s+/gu, '');
}

function buildSignedProperties(opts: {
  certB64: string;
  certIssuer: string;
  certSerial: string;
  signingTime: string;
  signatureId: string;
}): string {
  const certDigest = createHash('sha256').update(Buffer.from(opts.certB64, 'base64')).digest('base64');
  return [
    `<xades:SignedProperties xmlns:xades="http://uri.etsi.org/01903/v1.3.2#" Id="${opts.signatureId}-signedprops">`,
    '<xades:SignedSignatureProperties>',
    `<xades:SigningTime>${opts.signingTime}</xades:SigningTime>`,
    '<xades:SigningCertificate>',
    '<xades:Cert>',
    '<xades:CertDigest>',
    '<ds:DigestMethod xmlns:ds="http://www.w3.org/2000/09/xmldsig#" Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/>',
    `<ds:DigestValue xmlns:ds="http://www.w3.org/2000/09/xmldsig#">${certDigest}</ds:DigestValue>`,
    '</xades:CertDigest>',
    '<xades:IssuerSerial>',
    `<ds:X509IssuerName xmlns:ds="http://www.w3.org/2000/09/xmldsig#">${escapeXml(opts.certIssuer)}</ds:X509IssuerName>`,
    `<ds:X509SerialNumber xmlns:ds="http://www.w3.org/2000/09/xmldsig#">${opts.certSerial}</ds:X509SerialNumber>`,
    '</xades:IssuerSerial>',
    '</xades:Cert>',
    '</xades:SigningCertificate>',
    '</xades:SignedSignatureProperties>',
    '</xades:SignedProperties>',
  ].join('');
}

function parseCertMetadata(certPem: string): { issuer: string; serial: string } {
  // X.509 NATIVO (node:crypto ≥15.6) — niente node-forge. La vecchia regex su
  // "Subject:/Serial Number:" NON matchava un PEM base64 standard (quei testi
  // compaiono solo nell'output `openssl -text`, non nel PEM) → ritornava SEMPRE
  // issuer='CN=Unknown' / serial='1' → XAdES IssuerSerial INVALIDO per ogni
  // certificato reale. Qui estraiamo issuer + serial REALI; PEM non parsabile →
  // fail-fast (meglio di firmare con metadata fasulli).
  let cert: X509Certificate;
  try {
    cert = new X509Certificate(certPem);
  } catch {
    throw new Error('italia_sdi_send_invoice: certificato X.509 non parsabile (PEM non valido).');
  }
  // `cert.issuer` è multi-riga "C=..\nO=..\nCN=.." (ordine DER); XAdES X509IssuerName
  // vuole la forma RFC2253/4514 (RDN più specifico per primo, separati da virgola).
  const issuer = cert.issuer.split('\n').map((s) => s.trim()).filter(Boolean).reverse().join(',') || 'CN=Unknown';
  // `cert.serialNumber` è esadecimale; XAdES X509SerialNumber vuole il decimale.
  const serial = BigInt(`0x${cert.serialNumber}`).toString(10);
  return { issuer, serial };
}

function canonicalize(xml: string): string {
  // Minimal C14N: strip XML declaration, normalize whitespace between tags.
  // Sufficient when we generated the XML ourselves; for SDI strict use the
  // user is expected to pre-canonicalize using their tooling.
  return xml.replace(/^<\?xml[^?]*\?>\s*/u, '').replace(/>\s+</gu, '><');
}

export const sdiSendInvoiceExecutor: NodeExecutor = async (config, _input, _context) => {
  const start = Date.now();
  const xmlContent = asString(config.invoiceXml);
  const username = asString(config.sdiUsername);
  const password = asString(config.sdiPassword);
  const certPath = asString(config.certPath);
  const keyPath = asString(config.keyPath);
  const inlineCert = asString(config.certPem);
  const inlineKey = asString(config.keyPem);
  const skipSigning = config.skipSigning === true || config.skipSigning === 'true';
  // Default ON: valida la fattura contro lo schema XSD ufficiale FatturaPA v1.2.2
  // PRIMA dell'invio → intercetta gli errori strutturali che il SdI scarterebbe.
  const validateXsd = config.validateXsd !== false && config.validateXsd !== 'false';

  if (!xmlContent) throw new Error('italia_sdi_send_invoice: invoiceXml richiesto');
  if (!username || !password) throw new Error('italia_sdi_send_invoice: sdiUsername + sdiPassword richiesti');

  // Validazione XSD pre-invio sull'XML originale (la firma aggiunge solo ds:Signature,
  // opzionale nello schema). Fattura non conforme → fail-fast con gli errori XSD, prima
  // di firmare e di consumare una chiamata SOAP al SdI (che la scarterebbe).
  if (validateXsd) {
    const xsd = validateFatturaPaXsd(xmlContent);
    if (!xsd.valid) {
      const detail = xsd.errors.slice(0, 5).join(' | ');
      throw new Error(
        `italia_sdi_send_invoice: la fattura NON è conforme allo schema XSD FatturaPA v1.2.2 `
        + `(il SdI la scarterebbe). Correggi l'XML a monte. Errori: ${detail}`
        + (xsd.errors.length > 5 ? ` …(+${(xsd.errors.length - 5).toString()} altri)` : ''),
      );
    }
  }

  let signedXml: string;
  if (skipSigning) {
    // Mode A: caller already signed the XML elsewhere (es. con software del commercialista).
    signedXml = xmlContent;
  } else {
    // Mode B: sign here with the qualified cert.
    const certPem = loadPem('MEDEA_SDI_CERT_PATH', certPath, inlineCert);
    const keyPem = loadPem('MEDEA_SDI_KEY_PATH', keyPath, inlineKey);
    const certB64 = pemBodyToBase64(certPem);
    const { issuer, serial } = parseCertMetadata(certPem);
    const signatureId = `SIG-${randomBytes(6).toString('hex')}`;
    const signingTime = new Date().toISOString();

    const canonical = canonicalize(xmlContent);
    const docDigest = createHash('sha256').update(canonical).digest('base64');
    const signedProps = buildSignedProperties({ certB64, certIssuer: issuer, certSerial: serial, signingTime, signatureId });
    const propsDigest = createHash('sha256').update(signedProps).digest('base64');

    const signedInfo = [
      '<ds:SignedInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#">',
      '<ds:CanonicalizationMethod Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315"/>',
      '<ds:SignatureMethod Algorithm="http://www.w3.org/2001/04/xmldsig-more#rsa-sha256"/>',
      `<ds:Reference Id="${signatureId}-ref-doc" URI="">`,
      '<ds:Transforms><ds:Transform Algorithm="http://www.w3.org/2000/09/xmldsig#enveloped-signature"/></ds:Transforms>',
      '<ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/>',
      `<ds:DigestValue>${docDigest}</ds:DigestValue>`,
      '</ds:Reference>',
      `<ds:Reference Type="http://uri.etsi.org/01903#SignedProperties" URI="#${signatureId}-signedprops">`,
      '<ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/>',
      `<ds:DigestValue>${propsDigest}</ds:DigestValue>`,
      '</ds:Reference>',
      '</ds:SignedInfo>',
    ].join('');

    const signer = createSign('RSA-SHA256');
    signer.update(signedInfo);
    const privateKey = createPrivateKey({ key: keyPem });
    const signatureValue = signer.sign(privateKey).toString('base64');

    const signatureBlock = [
      `<ds:Signature xmlns:ds="http://www.w3.org/2000/09/xmldsig#" Id="${signatureId}">`,
      signedInfo,
      `<ds:SignatureValue>${signatureValue}</ds:SignatureValue>`,
      `<ds:KeyInfo><ds:X509Data><ds:X509Certificate>${certB64}</ds:X509Certificate></ds:X509Data></ds:KeyInfo>`,
      '<ds:Object>',
      `<xades:QualifyingProperties xmlns:xades="http://uri.etsi.org/01903/v1.3.2#" Target="#${signatureId}">`,
      signedProps,
      '</xades:QualifyingProperties>',
      '</ds:Object>',
      '</ds:Signature>',
    ].join('');

    // Insert before root closing tag (FatturaElettronica)
    signedXml = canonical.replace(/<\/FatturaElettronica>$/u, `${signatureBlock}</FatturaElettronica>`);
    if (signedXml === canonical) {
      throw new Error('italia_sdi_send_invoice: root <FatturaElettronica> non trovata nel XML');
    }
  }

  // Upload to SDICoop via TrasmissioneFatture SOAP endpoint.
  const fileName = asString(config.fileName) || `IT${Date.now().toString()}_FF.xml`;
  const auth = Buffer.from(`${username}:${password}`).toString('base64');
  const sdiUrl = asString(config.sdiUrl) || 'https://servizi.fatturapa.it/Services/SdIRiceviFile/RiceviFile';
  // Anti-esfiltrazione: le credenziali SDICoop (Basic auth) solo verso domini FatturaPA.
  guardCredentialHost(sdiUrl, SDI_HOSTS, 'italia_sdi_send_invoice');

  // SDICoop "RiceviFile" (trasmissione): la richiesta è `fileSdIAccoglienza`
  // con figli `NomeFile` + `File` (base64). Il vecchio envelope usava `rifiuta`
  // (= REJECT, operazione OPPOSTA all'invio) con `fileName`/`fileXml` inesistenti
  // → il SdI lo avrebbe scartato. NB: la risposta è già parsata come
  // IdentificativoSdI/DataOraRicezione (= rispostaRiceviFile), a conferma che
  // l'operazione è RiceviFile e che `rifiuta` era un bug.
  const soapEnvelope = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tns="http://www.fatturapa.gov.it/sdi/ws/trasmissione/v1.0/types">',
    '<soapenv:Body>',
    '<tns:fileSdIAccoglienza>',
    `<NomeFile>${escapeXml(fileName)}</NomeFile>`,
    `<File>${Buffer.from(signedXml, 'utf8').toString('base64')}</File>`,
    '</tns:fileSdIAccoglienza>',
    '</soapenv:Body>',
    '</soapenv:Envelope>',
  ].join('');

  const res = await safeOutboundFetch(sdiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/xml; charset=utf-8',
      SOAPAction: 'RiceviFile',
      Authorization: `Basic ${auth}`,
    },
    body: soapEnvelope,
  });
  const responseText = (await readTextTruncated(res, SOAP_MAX_BYTES)).text;
  if (!res.ok) {
    throw new Error(`SDI upload ${res.status.toString()}: ${responseText.slice(0, 400)}`);
  }
  const identMatch = /<IdentificativoSdI>([^<]+)<\/IdentificativoSdI>/u.exec(responseText);
  const dataMatch = /<DataOraRicezione>([^<]+)<\/DataOraRicezione>/u.exec(responseText);

  return {
    output: {
      fileName,
      identificativoSdi: identMatch?.[1] ?? null,
      dataOraRicezione: dataMatch?.[1] ?? null,
      signedXml: skipSigning ? null : signedXml.slice(0, 2000), // truncated for output sanity
      rawResponse: responseText.slice(0, 2000),
    },
    durationMs: Date.now() - start,
  };
};

export const sdiCheckStatusExecutor: NodeExecutor = async (config, _input, _context) => {
  const start = Date.now();
  const fileName = asString(config.fileName);
  const username = asString(config.sdiUsername);
  const password = asString(config.sdiPassword);
  if (!fileName || !username || !password) {
    throw new Error('italia_sdi_check_status: fileName/sdiUsername/sdiPassword required');
  }
  // SDICoop status endpoint — uses HTTP Basic auth.
  const url = `https://servizi.fatturapa.it/Services/SdIRiceviFile/ReceiveFiles?file=${encodeURIComponent(fileName)}`;
  const auth = Buffer.from(`${username}:${password}`).toString('base64');
  const res = await safeOutboundFetch(url, {
    headers: { Authorization: `Basic ${auth}` },
  });
  const text = (await readTextTruncated(res, SOAP_MAX_BYTES)).text;
  if (!res.ok) throw new Error(`SDI status ${String(res.status)}: ${text.slice(0, 400)}`);
  const statusMatch = /<StatoFile>([^<]+)<\/StatoFile>/.exec(text);
  return {
    output: { fileName, status: statusMatch?.[1] ?? 'unknown', rawResponse: text.slice(0, 2000) },
    durationMs: Date.now() - start,
  };
};
