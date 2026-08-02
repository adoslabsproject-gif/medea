/**
 * action_security_audit — deterministico, NO LLM.
 *
 * Esegue audit DETERMINISTICO su un dominio:
 *  - DNS lookup SPF (TXT "v=spf1 ...") + parsing record
 *  - DNS lookup DKIM (selettori configurabili, default: google,default,selector1,selector2)
 *  - DNS lookup DMARC (TXT _dmarc.<domain> "v=DMARC1; p=...")
 *  - SSL certificate inspection (issuer, notAfter, daysUntilExpiry, SAN match, weak protocol)
 *  - Redirect chain HEAD (max 10 hops, detect open-redirect, HTTP→HTTPS upgrade)
 *  - HSTS / Security Headers check
 *
 * Output: { score 0-100, findings[], spf, dkim, dmarc, ssl, redirects[], headers }
 *
 * Use case: audit security posture cliente B2B prima onboarding, compliance check
 * pre-migrazione DNS, monitoring continuo (cron + alert su drop score), report
 * per stakeholder non-tecnici (HTML render con findings prioritized).
 */
import type { NodeModule } from '../types.js';

export const securityAuditNode: NodeModule = {
  def: {
    id: 'action_security_audit',
    type: 'action',
    label: 'Security Audit (DNS+SSL+redirects)',
    icon: 'shield-check',
    color: '#dc2626',
    description:
      'Auditor enterprise di security posture di un dominio web — esegue una batteria di controlli ' +
      'deterministici read-only che valutano la "salute" di sicurezza del sito target su 4 dimensioni ' +
      "critiche dell'IT security 2026 secondo CIS/OWASP/NIST best practices, ritornando uno score normalizzato " +
      '0-100 con findings prioritizzati actionable per remediation. Le 4 categorie analizzate: ' +
      '(1) DNS Email Authentication — lookup SPF record (Sender Policy Framework, dichiara quali server SMTP ' +
      'sono autorizzati a inviare email per il dominio, presenza richiesta per non finire in spam folder di ' +
      'Google/Microsoft mailbox), DKIM (DomainKeys Identified Mail, firma crittografica delle email outbound), ' +
      'DMARC (Domain-based Message Authentication, Reporting and Conformance — la policy che dice ai mailbox ' +
      'come gestire le email che falliscono SPF/DKIM check); assenza/misconfiguration di questi 3 = signal ' +
      'red flag per email security; ' +
      '(2) SSL/TLS Certificate Inspection — ispezione del certificato HTTPS del dominio: issuer (CA emittente, ' +
      "Let's Encrypt è OK ma se aspettiamo enterprise tier ci aspettiamo Digicert/Comodo/Sectigo), expiry " +
      'date (warning < 30gg residui, critical < 7gg), SAN (Subject Alternative Names — il dominio matcha ' +
      'sul certificato), protocol version (TLS 1.2+ obbligatorio enterprise, TLS 1.0/1.1 deprecati 2020+), ' +
      'cipher suite strength (no SHA-1, no RC4, no MD5); ' +
      '(3) Redirect Chain Analysis — HEAD request seguendo redirect fino a max 10 hop, detect di open-redirect ' +
      'vulnerability (redirect verso domini esterni che non corrispondono al target — pattern di phishing ' +
      'preparation), detect di catene troppo lunghe (UX problem + SEO penalty), terminazione su HTTPS vs HTTP ' +
      '(downgrade attack risk); ' +
      '(4) HTTP Security Headers — verifica presenza di HSTS (HTTP Strict Transport Security per forzare HTTPS ' +
      'browser-side), CSP (Content Security Policy contro XSS), X-Frame-Options o frame-ancestors (anti-clickjacking), ' +
      "X-Content-Type-Options nosniff, Referrer-Policy, Permissions-Policy — l'enterprise standard 2025-2026 " +
      'che dovrebbe essere presente su ogni sito. ' +
      'Score finale weighted: critical findings (-30 ognuno), high (-15), medium (-5), low (-2). Range ' +
      'risultante 0-100 con bandi 90-100=eccellente, 70-89=buono, 50-69=da migliorare, < 50=critico. ' +
      'Output: { score (0-100), findings: [{ severity, category, description, recommendation }], spf: { ' +
      'present, valid, includes, mechanisms }, dkim: { selector?, present, key_size }, dmarc: { present, ' +
      'policy (none|quarantine|reject), rua }, ssl: { issuer, expires_at, days_to_expiry, sans, protocol }, ' +
      'redirects: [{ from, to, status }], headers: { hsts, csp, frame_options, ... }, analyzedAt }. ' +
      'Use case: pre-onboarding due diligence security per cliente B2B enterprise (sales team del cliente ' +
      'richiede compliance attestation per data processing agreement); monitoring cron settimanale con alert ' +
      'su drop score (es. il cert SSL scade tra 28 giorni → notify ops via Telegram); compliance check ' +
      'pre-migrazione DNS per evitare regression dopo cambio nameserver; report PDF stakeholder non-tecnici ' +
      'tradotto in linguaggio business "il vostro sito ha 85/100 di security score, ecco i 3 fix prioritari"; ' +
      'audit posture post-incident di sicurezza per documentare cause-effect remediation.',
    configFields: [
      {
        key: 'domain',
        label: 'Dominio',
        type: 'expression',
        required: true,
        placeholder: 'esempio.it o {{input.domain}}',
        help: 'Dominio da auditare (senza https://). Supporta expression {{ }} per dinamica.',
      },
      {
        key: 'dkimSelectors',
        label: 'Selettori DKIM (CSV)',
        type: 'text',
        required: false,
        defaultValue: 'google,default,selector1,selector2,k1,mail,smtp',
        help: 'Selettori DKIM da provare (lookup TXT <selector>._domainkey.<domain>). Vuoto = skip DKIM check.',
      },
      {
        key: 'checkSsl',
        label: 'Verifica SSL certificate',
        type: 'boolean',
        required: false,
        defaultValue: 'true',
        help: 'Connetti TLS port 443 → estrai issuer, notAfter, SAN. Warning se expiry <30 giorni.',
      },
      {
        key: 'checkRedirects',
        label: 'Verifica redirect chain',
        type: 'boolean',
        required: false,
        defaultValue: 'true',
        help: 'Segui HEAD http://<domain> → max 10 hop. Detect open-redirect (host mismatch).',
      },
      {
        key: 'timeoutMs',
        label: 'Timeout per check (ms)',
        type: 'number',
        required: false,
        defaultValue: '5000',
        help: 'Timeout per ogni DNS/TLS/HTTP check. Min 1000, max 30000. Default 5s.',
      },
    ],
    vendor: 'flowforge',
    version: '1.0.0',
  },
};
