/**
 * EmailDeliverabilityService — DNS diagnostic for outbound email deliverability.
 *
 * Checks three TXT records on the sender's domain:
 *   • SPF   (root domain)            — authorizes which servers can send for the domain
 *   • DKIM  (selector._domainkey)    — cryptographic signature, selector is provider-specific
 *   • DMARC (_dmarc subdomain)       — policy that tells receivers how to handle SPF/DKIM failures
 *
 * Why this matters:
 *   A message that passes SMTP authentication can STILL be silently dropped or
 *   routed to spam by the recipient's mail server when these records are missing
 *   or misconfigured. ~70% of "the email didn't arrive" tickets in SaaS are
 *   actually missing DKIM/SPF/DMARC on the sender domain — NOT a code bug.
 *
 * Implementation choices:
 *   • Pure Node.js `dns.promises` — no external dependencies.
 *   • DKIM selector is provider-specific. We probe 8 common selectors in
 *     parallel; the first hit wins. If none is found we report DKIM missing
 *     and offer guidance to query the provider for the right selector name.
 *   • Each query has a 4-second timeout to keep the overall check ≤ 5s.
 *
 * Output is a structured `DeliverabilityReport` that the test-full endpoint
 * appends to its `steps[]` array so the editor can render a nested checklist.
 */

import { promises as dns } from 'node:dns';

// DKIM selector names vary per provider. We probe a broad set in parallel.
// Each entry below is documented to belong to a real provider so we know
// WHY it's in the list — never add a selector "just in case".
//
//   s1, s2          → SendGrid, generic providers
//   s1-ionos, s2-ionos → IONOS (NOT plain s1/s2)
//   default         → fallback used by some DKIM tools
//   selector1, selector2 → Microsoft 365 / Office 365
//   mail            → Brevo (ex Sendinblue), Zoho Mail
//   dkim            → generic, some self-hosted
//   k1              → Mailchimp, Mandrill
//   google          → Google Workspace
//   sendgrid        → SendGrid (alternative name)
//   mg              → Mailgun
//   mailo           → Mailgun (alternative selector)
//   pm              → Postmark (when not using date-based selectors)
//   resend          → Resend.com
//   aruba           → Aruba (some accounts; many use the generic "dkim")
//   zoho            → Zoho Mail (alternative to "mail")
//
// Providers we CANNOT probe predictably (selector is random per identity):
//   • Amazon SES  → 3 CNAME with random token like "aabbcc1234._domainkey"
//   • Postmark    → may use date-based selectors like "20240101._domainkey"
// For those the report relies on the provider profile guidance instead.
const DKIM_SELECTORS_TO_PROBE = [
  's1', 's2',
  's1-ionos', 's2-ionos',
  'default', 'selector1', 'selector2',
  'mail', 'dkim', 'k1',
  'google', 'sendgrid',
  'mg', 'mailo',
  'pm', 'resend',
  'aruba', 'zoho',
];

/**
 * Per-provider profile: SPF include, DKIM step-by-step, docs URL.
 * Order matters — more-specific regex first. Adding a provider = one row.
 */
interface ProviderProfile {
  match: RegExp;
  label: string;
  spfInclude: string;
  dkimSteps: string;
  docsUrl?: string;
}

const PROVIDER_PROFILES: ProviderProfile[] = [
  {
    match: /ionos|1and1/i,
    label: 'IONOS',
    spfInclude: 'include:_spf-eu.ionos.com',
    // IONOS pubblica DKIM via CNAME (non TXT) e il selector standard è
    // "s1-ionos" (non "s1"). Se usi i name server IONOS è già attivo per
    // default; se vedi DKIM mancante qualcuno ha cancellato i CNAME.
    dkimSteps: 'my.ionos.it → Domini & SSL → seleziona il dominio → "DNS" → Aggiungi record CNAME. Servono TRE record: (1) host "s1-ionos._domainkey" → "s1.dkim.ionos.com"  (2) host "s2-ionos._domainkey" → "s2.dkim.ionos.com"  (3) host "s<numero-account>._domainkey" → "s<numero-account>.dkim.ionos.com" (il numero specifico del tuo account lo vedi nel pannello). TTL 1 ora. Aspetta 15-30 min e ritesta. NOTA: se usi i name server IONOS, DKIM è attivo di default — controlla se hai eliminato per errore i CNAME esistenti.',
    docsUrl: 'https://www.ionos.it/assistenza/email/configurazione-account-email/firma-dkim/',
  },
  {
    match: /aruba/i,
    label: 'Aruba',
    // Verified via direct DNS probe (2026-05-20): aruba.com and staff.aruba.it
    // publish DKIM on selectors s1._domainkey + s2._domainkey (generic
    // selectors, same as many providers). Selectors s1/s2 are in our probe
    // array, so we DO detect Aruba DKIM when configured.
    spfInclude: 'include:_spf.aruba.it',
    dkimSteps: 'admin.aruba.it → Email & PEC → seleziona il dominio → impostazioni "Antispam & Autenticazione" (il nome può variare per piano). Aruba abilita DKIM lato server e pubblica i record (selector standard "s1._domainkey" e "s2._domainkey"). Se il DNS è su Aruba i record sono automatici; se è altrove (Cloudflare, IONOS), copia host + valore dal pannello Aruba al tuo DNS provider.',
    docsUrl: 'https://www.aruba.it/assistenza',
  },
  {
    match: /sendgrid/i,
    label: 'SendGrid',
    spfInclude: 'include:sendgrid.net',
    dkimSteps: 'app.sendgrid.com → Settings → "Sender Authentication" → "Authenticate Your Domain" → wizard. SendGrid genera 3 CNAME: 2 con selector "s1._domainkey" e "s2._domainkey" (DKIM), uno per il return-path (SPF). Aggiungili al tuo DNS.',
    docsUrl: 'https://docs.sendgrid.com/ui/account-and-settings/how-to-set-up-domain-authentication',
  },
  {
    match: /mailgun/i,
    label: 'Mailgun',
    // Verified via direct DNS probe (2026-05-20): mailgun.com publishes DKIM
    // on mg._domainkey (CNAME → dkim.mailgun.net) AND k1._domainkey (direct
    // RSA TXT). Both selectors are in our probe array.
    spfInclude: 'include:mailgun.org',
    dkimSteps: 'app.mailgun.com → Sending → domini → click sul dominio → "DNS records". Mailgun ti dà i record da copiare: 1 MX, 1 SPF (TXT), 1 DKIM (TXT con selector standard "k1._domainkey" o CNAME su "mg._domainkey" → dkim.mailgun.net), 1 CNAME tracking. Copiali tutti nel tuo DNS provider.',
    docsUrl: 'https://documentation.mailgun.com/docs/mailgun/user-manual/sending-messages/',
  },
  {
    match: /postmark/i,
    label: 'Postmark',
    // Verified via direct DNS probe (2026-05-20): postmarkapp.com publishes
    // the real RSA key on pm._domainkey (other selectors return CNAME
    // wildcards). Selector "pm" is in our probe array.
    spfInclude: 'include:spf.mtasv.net',
    dkimSteps: 'postmarkapp.com → Sender Signatures → seleziona il dominio → tab "DKIM" → "Verify DKIM". Postmark mostra il record TXT da aggiungere al DNS: il selector standard è "pm._domainkey" + valore (chiave pubblica RSA fornita da Postmark).',
    docsUrl: 'https://postmarkapp.com/manual',
  },
  {
    match: /resend/i,
    label: 'Resend',
    // Verified via direct DNS probe (2026-05-20): resend.com itself publishes
    // DKIM on resend._domainkey (single fixed selector). Our probe covers it.
    spfInclude: 'include:_spf.resend.com',
    dkimSteps: 'resend.com/domains → "Add Domain" → seleziona la region (eu-west-1 per UE). Resend genera 4 record: MX, SPF (TXT), DKIM (TXT con selector standard "resend._domainkey") e DMARC (TXT su "_dmarc"). Copia-incolla i valori esatti dal dashboard nel tuo DNS provider.',
    docsUrl: 'https://resend.com/docs/dashboard/domains/introduction',
  },
  {
    match: /amazonses|email-smtp.*\.amazonaws/i,
    label: 'Amazon SES',
    spfInclude: 'include:amazonses.com',
    dkimSteps: 'console.aws.amazon.com → SES → "Verified identities" → seleziona dominio → tab "Authentication" → "Generate DKIM". AWS dà 3 CNAME (selector1/2/3._domainkey).',
    docsUrl: 'https://docs.aws.amazon.com/ses/latest/dg/send-email-authentication-dkim.html',
  },
  {
    match: /office365|outlook|protection\.outlook/i,
    label: 'Microsoft 365',
    spfInclude: 'include:spf.protection.outlook.com',
    dkimSteps: 'security.microsoft.com → Policies → Threat policies → "Email Authentication" → tab "DKIM" → seleziona dominio → "Enable". Microsoft genera 2 CNAME (selector1/2).',
    docsUrl: 'https://learn.microsoft.com/en-us/defender-office-365/email-authentication-dkim-configure',
  },
  {
    match: /gmail|google\.com/i,
    label: 'Google Workspace',
    spfInclude: 'include:_spf.google.com',
    dkimSteps: 'admin.google.com → Apps → Google Workspace → Gmail → "Authenticate email" → seleziona dominio → "Generate new record" → copia il TXT (selector google._domainkey).',
    docsUrl: 'https://support.google.com/a/answer/180504',
  },
  {
    match: /zoho/i,
    label: 'Zoho Mail',
    spfInclude: 'include:zoho.com',
    // Verified on Zoho's official DKIM docs: the customer chooses the
    // selector name and Zoho recommends "zoho" as the default value.
    dkimSteps: 'mailadmin.zoho.com → Domains → seleziona il dominio → "Email Configuration" → "DKIM" → "Add" → scegli un selector (Zoho consiglia "zoho"). Zoho genera la chiave pubblica: aggiungi un TXT al DNS con host "<selector>._domainkey" e valore = chiave pubblica fornita.',
    docsUrl: 'https://www.zoho.com/mail/help/adminconsole/dkim-configuration.html',
  },
];

function findProvider(smtpHost: string | undefined): ProviderProfile | null {
  if (!smtpHost) return null;
  return PROVIDER_PROFILES.find((p) => p.match.test(smtpHost)) ?? null;
}

export interface DnsCheck {
  ok: boolean;
  value?: string;
  hint?: string;
}

export interface DeliverabilityReport {
  domain: string;
  /** Provider detected from the SMTP host. Null when unknown — UI falls back to generic copy. */
  provider: { label: string; docsUrl?: string } | null;
  spf: DnsCheck;
  dkim: DnsCheck & { selectorFound?: string; selectorsTried: string[] };
  dmarc: DnsCheck;
  /** True when all three records exist (good deliverability baseline). */
  ok: boolean;
  /** Summary actionable for the operator. */
  summary: string;
}

/**
 * Resolve a TXT record with a hard timeout. Returns null for any failure
 * (NXDOMAIN, timeout, network error) — callers treat null as "not present".
 */
async function resolveTxtSafe(name: string, timeoutMs = 4000): Promise<string[] | null> {
  try {
    const records = await Promise.race([
      dns.resolveTxt(name),
      new Promise<never>((_, reject) => setTimeout(() => { reject(new Error('dns timeout')); }, timeoutMs)),
    ]);
    // Each TXT record is string[]; flatten by joining the chunks.
    return records.map((chunks) => chunks.join(''));
  } catch {
    return null;
  }
}

function inferSpfHint(smtpHost: string | undefined): string {
  const provider = findProvider(smtpHost);
  return provider ? `v=spf1 ${provider.spfInclude} ~all` : 'v=spf1 ~all';
}

export class EmailDeliverabilityService {
  /**
   * Check SPF, DKIM (probing common selectors), DMARC on the sender domain.
   * `smtpHost` is used to suggest the correct SPF `include:` for the provider.
   */
  async check(fromAddress: string, smtpHost: string | undefined): Promise<DeliverabilityReport> {
    const domain = extractDomain(fromAddress);
    const provider = findProvider(smtpHost);
    const providerPayload = provider
      ? { label: provider.label, ...(provider.docsUrl ? { docsUrl: provider.docsUrl } : {}) }
      : null;

    if (!domain) {
      const empty: DnsCheck = { ok: false, hint: 'fromAddress non contiene un dominio valido' };
      return {
        domain: '?',
        provider: providerPayload,
        spf: empty,
        dkim: { ...empty, selectorsTried: [] },
        dmarc: empty,
        ok: false,
        summary: 'fromAddress invalido — impossibile verificare deliverability',
      };
    }

    const [spfRecords, dmarcRecords, dkimResults] = await Promise.all([
      resolveTxtSafe(domain),
      resolveTxtSafe(`_dmarc.${domain}`),
      Promise.all(DKIM_SELECTORS_TO_PROBE.map(async (sel) => ({
        selector: sel,
        records: await resolveTxtSafe(`${sel}._domainkey.${domain}`),
      }))),
    ]);

    // SPF — look for the v=spf1 record among all TXT records on the apex.
    const spfRecord = (spfRecords ?? []).find((r) => r.toLowerCase().startsWith('v=spf1'));
    const spf: DnsCheck = spfRecord
      ? { ok: true, value: spfRecord }
      : {
          ok: false,
          hint: `Manca il record SPF. Aggiungi un TXT all'host @ con valore: ${inferSpfHint(smtpHost)}`,
        };

    // DKIM — first selector that returns a TXT containing v=DKIM1 OR p= (public key)
    const dkimHit = dkimResults.find((r) =>
      r.records?.some((rec) => /v=dkim1|p=[A-Za-z0-9+/]/i.test(rec)),
    );
    const providerSteps = provider
      ? `Provider rilevato: ${provider.label}. ${provider.dkimSteps}${provider.docsUrl ? ` Docs ufficiali: ${provider.docsUrl}` : ''}`
      : 'Provider non riconosciuto automaticamente. Cerca nelle impostazioni del tuo provider email "DKIM" o "Email authentication", oppure chiedi al supporto del provider la chiave DKIM e il selector da pubblicare nel DNS.';
    const dkim: DnsCheck & { selectorFound?: string; selectorsTried: string[] } = dkimHit
      ? {
          ok: true,
          value: (dkimHit.records ?? []).find((r) => /v=dkim1|p=/i.test(r)) ?? '',
          selectorFound: dkimHit.selector,
          selectorsTried: DKIM_SELECTORS_TO_PROBE,
        }
      : {
          ok: false,
          hint: providerSteps,
          selectorsTried: DKIM_SELECTORS_TO_PROBE,
        };

    // DMARC — look for v=DMARC1
    const dmarcRecord = (dmarcRecords ?? []).find((r) => r.toLowerCase().startsWith('v=dmarc1'));
    const dmarc: DnsCheck = dmarcRecord
      ? { ok: true, value: dmarcRecord }
      : {
          ok: false,
          hint: `Manca il record DMARC. Aggiungi un TXT con host "_dmarc" e valore: v=DMARC1; p=none; rua=mailto:dmarc@${domain}`,
        };

    const okCount = [spf.ok, dkim.ok, dmarc.ok].filter(Boolean).length;
    const ok = okCount === 3;
    let summary: string;
    if (ok) summary = `Eccellente — tutti i 3 record DNS sono presenti su ${domain}. Le tue email avranno deliverability ottimale.`;
    else if (okCount === 0) summary = `Nessun record (SPF/DKIM/DMARC) configurato per ${domain}. Le email finiranno in spam su Gmail/Outlook. Configura i 3 record qui sotto.`;
    else summary = `${okCount.toString()}/3 record presenti. Aggiungi quelli mancanti per migliorare la deliverability.`;

    return { domain, provider: providerPayload, spf, dkim, dmarc, ok, summary };
  }
}

function extractDomain(email: string): string | null {
  const m = /^[^@]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})$/.exec(email);
  return m?.[1] ? m[1].toLowerCase() : null;
}
