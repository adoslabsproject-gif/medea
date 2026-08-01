/**
 * Test E2E PERMANENTE — firma SAML reale validata dal VERO @node-saml.
 *
 * Perché esiste
 * -------------
 * `saml.test.ts` mocka `@node-saml` (validatePostResponseAsync = vi.fn()): prova
 * la LOGICA del callback (tenant, sessione, user), NON che una firma SAML vera
 * passi la validazione. Quella prova l'avevo fatta UNA VOLTA a mano e buttata via
 * (effimera). Qui diventa un guardiano CI: ad ogni push ri-prova end-to-end che
 *   • una SAMLResponse a DOPPIA firma (assertion + response, sha256) viene
 *     ACCETTATA dal vero @node-saml con la stessa config di saml.ts;
 *   • una response MANOMESSA dopo la firma viene RIFIUTATA;
 *   • una response con la sola Response firmata (assertion NON firmata) viene
 *     RIFIUTATA → garantisce che `wantAssertionsSigned` è davvero in vigore
 *     (è esattamente il caso che un IdP mal configurato produrrebbe).
 *
 * Ermetico: chiavi + cert self-signed generati A RUNTIME (selfsigned), MAI
 * storati nel repo (no secret-in-code). Firma con xml-crypto (la STESSA libreria
 * che @node-saml usa per validare → compatibilità garantita).
 *
 * NB: questo file NON mocka @node-saml → usa l'implementazione reale.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { SignedXml } from 'xml-crypto';
import selfsigned from 'selfsigned';
import { SAML } from '@node-saml/node-saml';
import { randomUUID } from 'node:crypto';

const SP_ISSUER = 'urn:ff:e2e-test';
const CALLBACK = 'https://tenant.app.automazionezeli.com/api/v1/auth/saml/test/callback';
const IDP = 'https://idp.test/ff-e2e';
const EMAIL = 'sso-user@corp.example';

const ALG = {
  sig: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
  c14n: 'http://www.w3.org/2001/10/xml-exc-c14n#',
  digest: 'http://www.w3.org/2001/04/xmlenc#sha256',
  enveloped: 'http://www.w3.org/2000/09/xmldsig#enveloped-signature',
} as const;

let KEY = '';
let CERT = '';

beforeAll(async () => {
  // Keypair + cert self-signed generati IN MEMORIA, mai scritti su disco/repo.
  // selfsigned.generate è async in v5 → await.
  const pems = await selfsigned.generate([{ name: 'commonName', value: 'ff-e2e-test-idp' }], {
    keySize: 2048,
    algorithm: 'sha256',
  });
  KEY = pems.private;
  CERT = pems.cert;
});

const iso = (d: Date): string => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

/** Costruisce una SAMLResponse non firmata (Response > Status + Assertion). */
function buildResponse(email: string): { xml: string } {
  const respId = '_' + randomUUID();
  const assId = '_' + randomUUID();
  const now = new Date();
  const before = iso(new Date(now.getTime() - 5 * 60_000));
  const after = iso(new Date(now.getTime() + 5 * 60_000));
  const instant = iso(now);
  const NS = 'xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion"';
  const assertion =
    `<saml:Assertion ${NS} ID="${assId}" Version="2.0" IssueInstant="${instant}">` +
    `<saml:Issuer>${IDP}</saml:Issuer>` +
    `<saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${email}</saml:NameID>` +
    `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer">` +
    `<saml:SubjectConfirmationData NotOnOrAfter="${after}" Recipient="${CALLBACK}"/></saml:SubjectConfirmation></saml:Subject>` +
    `<saml:Conditions NotBefore="${before}" NotOnOrAfter="${after}"><saml:AudienceRestriction><saml:Audience>${SP_ISSUER}</saml:Audience></saml:AudienceRestriction></saml:Conditions>` +
    `<saml:AuthnStatement AuthnInstant="${instant}" SessionIndex="${respId}"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement>` +
    `<saml:AttributeStatement><saml:Attribute Name="email" NameFormat="urn:oasis:names:tc:SAML:2.0:attrname-format:basic"><saml:AttributeValue>${email}</saml:AttributeValue></saml:Attribute></saml:AttributeStatement>` +
    `</saml:Assertion>`;
  const xml =
    `<samlp:Response ${NS} ID="${respId}" Version="2.0" IssueInstant="${instant}" Destination="${CALLBACK}">` +
    `<saml:Issuer>${IDP}</saml:Issuer>` +
    `<samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>` +
    assertion +
    `</samlp:Response>`;
  return { xml };
}

/** Firma l'elemento indicato (Assertion|Response) in-place, dopo il suo Issuer. */
function signElement(xml: string, localName: string): string {
  const s = new SignedXml({ privateKey: KEY, publicCert: CERT });
  s.signatureAlgorithm = ALG.sig;
  s.canonicalizationAlgorithm = ALG.c14n;
  s.addReference({
    xpath: `//*[local-name(.)='${localName}']`,
    transforms: [ALG.enveloped, ALG.c14n],
    digestAlgorithm: ALG.digest,
  });
  s.computeSignature(xml, {
    location: { reference: `//*[local-name(.)='${localName}']/*[local-name(.)='Issuer']`, action: 'after' },
  });
  return s.getSignedXml();
}

/** SAML SP con la STESSA config di saml.ts buildSamlConfig() (righe 45-58). */
function makeSamlSp(): SAML {
  return new SAML({
    callbackUrl: CALLBACK,
    entryPoint: `${IDP}/sso`,
    issuer: SP_ISSUER,
    idpCert: CERT,
    wantAssertionsSigned: true,        // mirror saml.ts:51
    wantAuthnResponseSigned: true,     // mirror saml.ts:56
    signatureAlgorithm: 'sha256',      // mirror saml.ts:57
    audience: SP_ISSUER,
  });
}

function toB64(xml: string): string {
  return Buffer.from(xml, 'utf8').toString('base64');
}

describe('🚨 SAML signature E2E — vero @node-saml (no mock)', () => {
  it('🚨 doppia firma valida (assertion+response) → ACCETTATA, email estratta', async () => {
    let xml = buildResponse(EMAIL).xml;
    xml = signElement(xml, 'Assertion'); // firma assertion PRIMA
    xml = signElement(xml, 'Response');  // poi la response (copre l'assertion firmata)

    const saml = makeSamlSp();
    const { profile } = await saml.validatePostResponseAsync({ SAMLResponse: toB64(xml) });
    expect(profile).toBeTruthy();
    const email = (profile as Record<string, unknown>)?.email
      ?? (profile as Record<string, unknown>)?.['http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress'];
    expect(email).toBe(EMAIL);
  });

  it('🚨 response MANOMESSA dopo la firma → RIFIUTATA (il test verifica davvero la firma)', async () => {
    let xml = buildResponse(EMAIL).xml;
    xml = signElement(xml, 'Assertion');
    xml = signElement(xml, 'Response');
    // Tamper: cambio l'email DOPO aver firmato → digest non combacia più.
    const tampered = xml.replace(EMAIL, 'attacker@evil.example');
    expect(tampered).not.toBe(xml);

    const saml = makeSamlSp();
    await expect(saml.validatePostResponseAsync({ SAMLResponse: toB64(tampered) })).rejects.toThrow();
  });

  it('🚨 assertion NON firmata (solo Response) → RIFIUTATA (wantAssertionsSigned in vigore)', async () => {
    let xml = buildResponse(EMAIL).xml;
    xml = signElement(xml, 'Response'); // firmo SOLO la response, NON l'assertion
    // È esattamente ciò che un IdP mal configurato (o samlify con sola
    // wantMessageSigned) produce: deve essere rifiutato.
    const saml = makeSamlSp();
    await expect(saml.validatePostResponseAsync({ SAMLResponse: toB64(xml) })).rejects.toThrow();
  });
});
