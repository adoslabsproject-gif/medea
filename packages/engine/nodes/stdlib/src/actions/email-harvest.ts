/**
 * Email Harvester action node — estrazione email da HTML.
 *
 * 5 strategie parallele:
 *   1. mailto: links (conf 100)
 *   2. Cloudflare data-cfemail (conf 95)
 *   3. HTML entity decode (conf 90)
 *   4. Plain regex RFC 5322 (conf 80)
 *   5. Text obfuscation "[at]/[dot]" (conf 70)
 *
 * Output: { primary_email, all_emails[], counts }.
 * Auto noise-filter (noreply, example.com, RFC 2606 reserved).
 * Priority selection: commerciale@/sales@/info@ > admin@ > altro.
 */
import type { NodeModule } from '../types.js';

export const emailHarvestNode: NodeModule = {
  def: {
    id: 'action_email_harvest',
    type: 'action',
    label: 'Email: Estrai da HTML (5 strategie)',
    icon: 'mail-search',
    color: '#06b6d4',
    description:
      'Estrattore enterprise di indirizzi email da HTML — il pattern è universalmente noto come "email ' +
      'harvesting" ma in versione legitimate-only per use case authorized: lead generation B2B da siti ' +
      'aziendali pubblici, contact discovery di referenti commerciali dichiarati pubblicamente sui siti ' +
      'corporate, verifica del proprio sito che renda contatti accessibili senza JavaScript per accessibility, ' +
      'audit di siti cliente per compliance privacy (pre-GDPR pages che leakano email non protected). Cinque ' +
      'strategie parallele di parsing che coprono il 95%+ dei modi in cui le email sono encoded nel HTML reale: ' +
      '(1) mailto: links — il pattern canonico HTML <a href="mailto:info@acme.com">, semplice da parsare via ' +
      'querySelector ma rappresenta solo il 40% dei casi reali perché gli admin web tipicamente nascondono le ' +
      'email per anti-spam; ' +
      '(2) Cloudflare anti-spam decoder — Cloudflare offre la feature "Email Address Obfuscation" che ' +
      'sostituisce le email con span data-cfemail="abc123" e un JavaScript runtime che decodifica al ' +
      'caricamento — il nodo implementa il decoder XOR algorithm di Cloudflare per leggere le email ' +
      'server-side senza eseguire JS; ' +
      "(3) HTML entities decode — l'admin sostituisce @ con &#64; e . con &#46; per evitare crawler naïve " +
      '(es. mario&#64;acme&#46;com) — il nodo decoda le entities e poi applica regex match; ' +
      '(4) Regex plain — match standard RFC 5322 simplified su testo plain decoded (vari pattern fallback per ' +
      'edge case come email con plus addressing mario+spam@acme.com); ' +
      '(5) Obfuscation testuale humano — "mario [at] acme [dot] com", "mario AT acme DOT com", "mario(@)acme(.)com" ' +
      '— pattern usato da admin che pensano "i bot non sanno parsare questo" ma il nodo li riconosce. ' +
      'Filtri noise enterprise per evitare false positive che inquinerebbero il dataset: blocklist di domini ' +
      'noti non-deliverable (example.com, test.com, localhost, domain.tld template placeholder), prefix blocklist ' +
      '(noreply@, no-reply@, donotreply@, mailer-daemon@, postmaster@ — generic non-personal endpoint), regex ' +
      'pattern blocklist per UUID-like local parts (es. 0a1b2c@... che è tipicamente tracking ID non email ' +
      'reale). ' +
      'Output: email primaria (la più probabile da contattare — ranking euristico basato su position nel ' +
      'documento header > body, presence in section "Contatti" vs footer generic, length del local-part) + ' +
      'lista completa con confidence score 0-1 per ognuna (mailto = 1.0, regex plain = 0.7, obfuscation = ' +
      '0.85, entities = 0.95, cloudflare = 0.92). ' +
      'Use case: lead-gen B2B con contact discovery sistematico da siti aziendali (loop su sitemap_crawler ' +
      'URL → fetch pagina /contatti or /chi-siamo → harvest emails); raccolta indirizzi pubblici per import ' +
      'CRM autorizzato (es. la lista pubblica dei broker assicurativi del proprio settore); verifica del ' +
      'proprio sito contatti che renda email leggibile senza JavaScript per audit accessibility WCAG 2.2; ' +
      'deduplica email da pagine staff/team enterprise prima di outreach per evitare di scrivere al CEO + CTO ' +
      '+ HR + Operations Manager dello stesso azienda con stessa proposta; signal di "is this still active' +
      '" pre-outreach (se il dominio non risponde con email = candidato per skip senza sprecare token cold email).',
    configFields: [
      {
        key: 'html',
        label: 'Contenuto HTML da analizzare',
        type: 'expression',
        required: true,
        placeholder: '{{$node.fetch_page.json.content}}',
        help: "HTML della pagina web da cui estrarre email. Tipicamente l'output di un nodo action_fetch_url (campo `content` o `html`). Accetta sia HTML completo che frammenti.",
      },
      {
        key: 'preferredLocalParts',
        label: 'Local-part preferiti (priority)',
        type: 'text',
        required: false,
        defaultValue: 'commerciale,sales,info,contact',
        help: 'Lista CSV di local-part preferiti per scegliere primary_email. La prima email che matcha viene scelta. Default: commerciale,sales,info,contact. Se nessuna trovata, primary_email = email con confidence più alta.',
      },
      {
        key: 'strictNoise',
        label: 'Filtra noise strict',
        type: 'boolean',
        required: false,
        defaultValue: 'true',
        help: 'Se ON: filtra anche email con local-part 1 char, dominio TLD < 2 char, e RFC 2606 reserved (.example/.test/.invalid). Disabilita SOLO se devi catturare anche email partial/incomplete (es. testing).',
      },
    ],
    outputs: ['primary_email', 'all_emails', 'counts', 'has_emails'],
    outputContract: {
      notes: 'Estrae INDIRIZZI EMAIL da una pagina HTML: non serve a tirar fuori dati strutturati da un messaggio — per quello c\'e` `agent_extractor` con uno schema. `has_emails` e` il campo su cui diramare quando la pagina non ne contiene.',
      fields: [
        { name: 'primary_email', type: 'string|null', desc: 'L\'indirizzo piu` promettente fra quelli trovati. Null se non ce n\'e` nessuno.' },
        { name: 'all_emails', type: 'array', desc: 'Tutti gli indirizzi trovati, senza doppioni.' },
        { name: 'counts', type: 'object', desc: 'Quanti ne ha trovati per tipo.' },
        { name: 'has_emails', type: 'boolean', desc: 'Se ne ha trovato almeno uno.' },
      ],
    },
    vendor: 'flowforge',
    version: '1.0.0',
  },
};
