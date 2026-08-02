/**
 * Email MX Validator action node — verifica deliverability DNS-side.
 *
 * Pre-check critico prima di inviare cold outreach:
 *   - MX record check (deliverability garantita)
 *   - A/AAAA fallback RFC 5321 (server email old-school)
 *   - Disposable detection (250+ domini blacklist tempmail)
 *   - Role-based flag (info-only, non bloccante)
 *
 * Output: { mx_valid, mx_records[], disposable, role_based, confidence: 0-100 }.
 * Cache LRU 5min × 5000 domini → costo trascurabile in batch send.
 */
import type { NodeModule } from '../types.js';

export const emailMxNode: NodeModule = {
  def: {
    id: 'action_email_validate_mx',
    type: 'action',
    label: 'Email: Verifica MX + disposable',
    icon: 'mail-check',
    color: '#06b6d4',
    description:
      'Validatore enterprise di deliverability email che esegue DNS-level checks per stabilire se un indirizzo ' +
      'email è plausibilmente deliverable PRIMA di inviare un messaggio reale che sarebbe bouncato — pattern ' +
      'critico per protezione reputation IP SMTP del tenant (provider SaaS come Mailchimp/SendGrid/Mailgun/SES ' +
      'penalizzano le account che bouncano > 2-5% del traffic con throttling, sospensione, ban del subdomain ' +
      'sending). Verifica multi-livello complementari per coverage completa: ' +
      '(1) MX record lookup via DNS query asincrona — il record MX (Mail eXchanger) del dominio dichiara i ' +
      'server SMTP autoritativi del dominio per la ricezione email (es. acme.com MX points a 10 mail.acme.com); ' +
      "l'assenza di MX record è strong signal di dominio non email-capable; " +
      '(2) Fallback A record check (RFC 5321 compliance) — se MX manca, il client SMTP è tenuto da specifica a ' +
      'tentare il A record (IP del dominio) — il nodo replica questa logica per parità di comportamento col ' +
      'mailer reale; ' +
      '(3) Disposable email detection — match contro blacklist di 250+ provider noti di temporary email ' +
      '(mailinator.com, tempmail.org, 10minutemail.com, guerrillamail.com, throwaway.email, ecc. inclusi i ' +
      'pattern italiani come e4ward.com e mail-temporaire.com) che gli utenti usano per signup form per evitare ' +
      'spam — lead da questi domini sono generalmente low-quality con conversion rate < 1% e LTV trascurabile; ' +
      '(4) Role-based vs person email detection — distingue tra email "personali" (mario.rossi@acme.com, ' +
      'firstname.lastname@ pattern enterprise) e email "ruolo" (info@, support@, sales@, admin@, contact@, ' +
      'noreply@, postmaster@) — utili per use case sales outreach (preferiamo person email per personal ' +
      'connection) ma anche per use case ticketing (preferiamo role email per garantire ricezione anche se la ' +
      'persona specifica è in ferie). ' +
      'Output rich: { isValid (bool composite finale), confidence (score 0-100 derivato da signal weighting), ' +
      'hasMx, hasA, mxRecords (lista di server SMTP risolti per audit), isDisposable, disposableProvider?, ' +
      'isRoleBased, rolePrefix?, deliverableConfidence, recommendations? (suggerimenti azionabili come "questa ' +
      'email è role-based, considera contact person") }. ' +
      'Cache LRU 5min × 5000 domini per evitare DNS query ripetute su stesso dominio (workflow batch su 1000 ' +
      'lead di 100 aziende diverse → solo 100 DNS query, non 1000) — overhead trascurabile in batch. ' +
      'Use case: filtrare lead di bassa qualità prima di una campagna outreach commerciale (filter isValid=true ' +
      'AND isDisposable=false AND isRoleBased=false → focus su persone reali); validare email signup form per ' +
      'ridurre bounce rate Mailchimp/SendGrid/SES (rifiutare submission con isValid=false o isDisposable=true ' +
      'al moment del POST per non inserire mai in DB); flaggare domini disposable in registrazione tenant SaaS ' +
      '(red flag per fraud detection — trial fraudsters tipicamente registrano con disposable email); audit ' +
      'mensile della propria lista mailing per pulizia indirizzi morti accumulati nel tempo (loop su lista + ' +
      'validate_mx + delete o flag i dead → recupera reputation score IP); pre-flight check su importazione ' +
      'CSV anagrafica cliente da altro sistema legacy.',
    configFields: [
      {
        key: 'email',
        label: 'Email da validare',
        type: 'expression',
        required: true,
        placeholder: '{{$node.harvest.json.primary_email}}',
        help: "Indirizzo email completo (local@domain). Tipicamente output di un nodo action_email_harvest (campo primary_email) o di un'estrazione manuale.",
      },
      {
        key: 'minConfidence',
        label: 'Confidence minima per ok (0-100)',
        type: 'number',
        required: false,
        defaultValue: '70',
        help: 'Threshold per il campo output `ok`. Default 70:\n  • 100: MX valido, non-disposable, person-style\n  • 85: MX valido, role-based\n  • 60: MX valido, role-based (acceptable B2B)\n  • 30: solo A fallback (deliverable ma debole)\n  • 5: disposable (DA EVITARE)\n  • 0: undeliverable\n\nIl flusso può usare `ok=true/false` in un logic_if subito dopo.',
      },
      {
        key: 'timeoutMs',
        label: 'Timeout DNS lookup (ms)',
        type: 'number',
        required: false,
        defaultValue: '4000',
        help: 'Timeout per ciascuna query DNS (MX/A/AAAA). 4000ms = safe per il 99.9% degli upstream DNS. Aumentare a 8000 se i lookup avvengono via VPN/proxy lento.',
      },
    ],
    outputs: ['mx_valid', 'mx_records', 'disposable', 'role_based', 'confidence', 'reason', 'ok'],
    vendor: 'flowforge',
    version: '1.0.0',
  },
};
