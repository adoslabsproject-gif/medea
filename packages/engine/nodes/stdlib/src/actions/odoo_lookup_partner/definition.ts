/**
 * `action_odoo_lookup_partner` — NodeDef.
 *
 * @module actions/odoo_lookup_partner/definition
 */

import type { NodeDef } from '@flowforge/core-schema';

export const odooLookupPartnerNodeDef: NodeDef = {
  id: 'action_odoo_lookup_partner',
  type: 'action',
  label: 'Odoo: Trova Cliente',
  icon: 'user-search',
  color: '#7c3aed',
  description:
    'Wrapper enterprise specializzato sopra action_odoo_rpc che incapsula la ricerca di una res.partner in Odoo ' +
    'con strategia multi-campo deterministica nel rispetto della cascata di affidabilità tipica di un\'anagrafica ' +
    'commerciale italiana: cerca prima per Partita IVA (univoco per legge, formato IT99999999999 con validazione ' +
    'checksum), poi per codice fiscale persona fisica (16 char alphanumeric con check), poi per email business ' +
    '(univoca nel 95% dei casi), poi per numero di telefono normalizzato E.164 (rimuovendo spazi e prefissi ' +
    'duplicati), infine per nome aziendale con similarity matching ilike (last resort, sensibile a typos). ' +
    'Riduce drasticamente la complessità di configurazione del nodo generico action_odoo_rpc: dai 15+ campi ' +
    'tecnici (model, operation, domain JSON con triple [campo, operatore, valore], fields array, limit, ' +
    'order, ecc.) a soli 4-5 campi human-readable inseribili in 30 secondi da un commercialista non-developer. ' +
    'Opzione createIfMissing: se la ricerca non produce match, crea atomicamente il partner con i dati forniti ' +
    'in input (1 chiamata RPC aggiuntiva nell\'esecuzione, transazione atomica server-side Odoo — nessun rischio ' +
    'di partial state); senza questa opzione semplicemente ritorna found=false per gestione downstream esplicita. ' +
    'Output strutturato pronto per workflow downstream: { found, partnerId, name, email, phone, vat, ' +
    'fiscalCode, companyId, customerRank, supplierRank, isCompany, createdNow, matchedBy }. ' +
    'Vantaggio vs n8n/Make/Zapier: in quelle piattaforme servono un SET node che costruisce il domain JSON + un ' +
    'Odoo node configurato a mano con sintassi domain complessa + un IF node per createIfMissing branch — totale ' +
    '3-4 nodi ingestibili da un commercialista. Qui è un nodo singolo con audit del campo che ha matchato. ' +
    'Use case: lookup automatico cliente da PEC ricevuta (parse mittente → cerca P.IVA in firma PEC → match in ' +
    'Odoo o crea nuovo prospect), normalizzazione anagrafica da form web e-commerce verso CRM Odoo, lookup ' +
    'partner per associare una fattura elettronica SDI in ingresso al cliente corretto via Codice Destinatario, ' +
    'dedup contatti tra Pipedrive imported e Odoo nativo (match per email + check ulteriore per VAT), ' +
    'arricchimento email entry-form prima di trasferimento contabile (recupera storico ordini precedenti).',

  configFields: [
    // Auth
    { key: 'baseUrl', label: 'URL Odoo', type: 'text', required: true,
      placeholder: 'https://miostudio.odoo.com',
      help: 'URL base senza /xmlrpc — viene aggiunto automaticamente.' },
    { key: 'database', label: 'Database', type: 'text', required: true,
      placeholder: 'miostudio-prod' },
    { key: 'login', label: 'Login (email)', type: 'text', required: true,
      placeholder: 'studio@cliente.it' },
    { key: 'password', label: 'Password / API Key', type: 'secret', required: true,
      help: 'Usa API Key (user → preferences → API Keys) — bypassa 2FA e non scade.' },

    // Identifiers
    { key: 'email', label: 'Email da cercare', type: 'text', required: false,
      placeholder: 'mario@cliente.it',
      help: 'Match case-insensitive (=ilike). Massimo priorità.' },
    { key: 'vat', label: 'P.IVA / VAT', type: 'text', required: false,
      placeholder: '12345678901',
      help: 'Normalizzato (rimuove spazi, prefisso IT). Match esatto.' },
    { key: 'phone', label: 'Telefono', type: 'text', required: false,
      placeholder: '333 1234567',
      help: 'Normalizzato a soli digit. Match esatto sul valore normalizzato.' },
    { key: 'name', label: 'Nome (fallback)', type: 'text', required: false,
      placeholder: 'Mario Rossi',
      help: 'Match ilike — ultimo tentativo se email/vat/phone non danno hit.' },

    // Scope
    { key: 'companyId', label: 'company_id (multi-company)', type: 'number', required: false,
      placeholder: '1',
      help: 'Restringe la ricerca alla company indicata. Vuoto = tutte.' },

    // Options
    { key: 'createIfMissing', label: 'Crea se non trovato', type: 'boolean',
      required: false, defaultValue: 'false',
      help: 'Se ON e il search ritorna 0 risultati, crea un nuovo res.partner ' +
        'usando i campi email/name/phone/vat forniti. L\'output `created:true` ' +
        'distingue il caso. Richiede almeno email O name per il create.' },
    { key: 'returnFields', label: 'Campi da restituire', type: 'text', required: false,
      defaultValue: 'id,name,email,phone,vat,company_id,user_id',
      help: 'Lista comma-separated. Default copre il 90% dei flussi.' },

    // Knobs
    { key: 'timeoutMs', label: 'Timeout (ms)', type: 'number', required: false,
      defaultValue: '60000' },
    { key: 'followRedirects', label: 'Segui redirect', type: 'boolean',
      required: false, defaultValue: 'true' },
  ],

  vendor: 'flowforge',
  version: '1.0.0',
  cost: { typicalLatencyMs: 250 },

  // OUTPUT CONTRACT — la VERITÀ dall'executor (executor.ts: rami hit/miss/create).
  // ⚠️ La prosa della description elenca campi (name/email/vat/matchedBy/createdNow)
  // che NON sono top-level: stanno DENTRO `partner`. Questo contract è la fonte
  // accurata per l'analisi AI; verificato anti-drift in index.test.ts.
  outputContract: {
    fields: [
      { name: 'found', type: 'boolean', desc: 'true se un partner corrispondente esisteva già in Odoo' },
      { name: 'created', type: 'boolean', desc: 'true SOLO se il partner è stato creato adesso (miss + createIfMissing=true)' },
      { name: 'partnerId', type: 'number | null', desc: 'id Odoo del partner (trovato o creato); NULL se non trovato e createIfMissing=false' },
      { name: 'partner', type: 'object | null', desc: 'record Odoo con i returnFields (name/email/vat/… stanno QUI dentro, NON top-level); null se non trovato e !createIfMissing' },
    ],
    notes: 'Miss + createIfMissing=false → { found:false, created:false, partner:null, partnerId:null }. '
      + 'Per il caso "cliente sconosciuto" collega un ramo che testa partnerId/found (es. logic_if su partnerId == null), '
      + 'NON assumere un id fittizio (NON è 0).',
  },
};
