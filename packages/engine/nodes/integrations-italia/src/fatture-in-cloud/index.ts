import type { NodeModule, NodeExecutor } from '@medea/engine-nodes-stdlib';
import { executeWithHostBreaker } from '@medea/engine-nodes-stdlib';
import {
  safeFetchWithRedirects,
  readTextCapped,
  readJsonCapped,
  readTextTruncated,
} from '@medea/engine-safe-fetch';
import { normalizeInvoiceOutput, normalizeClientOutput, buildPaymentsList } from './fic-mapping.js';

const FIC_API = 'https://api-v2.fattureincloud.it';
const TIMEOUT_MS = 30_000;

/**
 * Gateway: SSRF-safe + per-host CB + 30s timeout. Audit gap closure 2026-06-04
 * (consulente esterno): i fetch nudi su provider hardcoded sembrano sicuri ma
 * un provider impallato senza timeout/breaker droga il pool.
 */
async function gatewayFetch(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string },
): Promise<Response> {
  return executeWithHostBreaker(url, () =>
    safeFetchWithRedirects(url, {
      ...(init.method ? { method: init.method } : {}),
      ...(init.headers ? { headers: init.headers } : {}),
      ...(init.body !== undefined ? { body: init.body } : {}),
      timeoutMs: TIMEOUT_MS,
    }),
  );
}

function reqString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Fatture in Cloud: missing required config "${name}"`);
  }
  return value;
}

const invoiceExecutor: NodeExecutor = async (config, input, _context) => {
  const startedAt = Date.now();
  const apiToken = reqString(config.apiToken, 'apiToken');
  const companyId = reqString(config.companyId, 'companyId');
  const clientId = reqString(config.clientId, 'clientId');
  const itemsRaw = config.itemsJson;
  let items: unknown[];
  try {
    items =
      typeof itemsRaw === 'string' ? (JSON.parse(itemsRaw) as unknown[]) : (itemsRaw as unknown[]);
  } catch {
    throw new Error('Fatture in Cloud: itemsJson is not valid JSON');
  }
  if (!Array.isArray(items)) throw new Error('Fatture in Cloud: itemsJson must be an array');

  // paymentDays → scadenza (payments_list): incluso SOLO se i giorni sono validi e il
  // totale è calcolabile dalle righe (difensivo — fatturazione reale: mai un payload
  // azzardato; se non calcolabile FIC genera la scadenza di default, come prima).
  const paymentDays = Number(config.paymentDays ?? 0);
  const paymentsList = buildPaymentsList(items, paymentDays);

  const payload = {
    data: {
      type: 'invoice',
      entity: { id: Number(clientId) },
      items_list: items,
      payment_method: {
        id: 1,
        name: typeof config.paymentMethod === 'string' ? config.paymentMethod : 'MP05 - Bonifico',
      },
      ...(paymentsList ? { payments_list: paymentsList } : {}),
      ei_data: config.sdiCode
        ? {
            sdi_destination_code:
              typeof config.sdiCode === 'string' ? config.sdiCode : JSON.stringify(config.sdiCode),
          }
        : undefined,
      currency: { id: 'EUR' },
      use_split_payment: false,
    },
  };

  const res = await gatewayFetch(`${FIC_API}/c/${companyId}/issued_documents`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiToken}`,
      Accept: 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const responseText = await readTextCapped(res); // anti-OOM: lancia se >25MB
  let body: unknown = responseText;
  try {
    body = JSON.parse(responseText);
  } catch {
    // keep raw
  }
  if (!res.ok) {
    throw new Error(`Fatture in Cloud ${String(res.status)}: ${responseText.slice(0, 400)}`);
  }
  void input;
  // Output normalizzato (shape stabile per i nodi downstream) + raw per i campi extra.
  return { output: normalizeInvoiceOutput(body), durationMs: Date.now() - startedAt };
};

const clientLookupExecutor: NodeExecutor = async (config, _input, _context) => {
  const startedAt = Date.now();
  const apiToken = reqString(config.apiToken, 'apiToken');
  const companyId = reqString(config.companyId, 'companyId');
  const vatNumber = typeof config.vatNumber === 'string' ? config.vatNumber : '';
  const taxCode = typeof config.taxCode === 'string' ? config.taxCode : '';
  const createIfMissing = Boolean(config.createIfMissing);

  const query = vatNumber
    ? `vat_number=${encodeURIComponent(vatNumber)}`
    : `tax_code=${encodeURIComponent(taxCode)}`;
  const lookupRes = await gatewayFetch(`${FIC_API}/c/${companyId}/entities/clients?q=${query}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${apiToken}`, Accept: 'application/json' },
  });
  const lookupJson = await readJsonCapped<{ data?: { id: number; name: string }[] }>(lookupRes);
  if (lookupJson.data && lookupJson.data.length > 0) {
    return {
      output: normalizeClientOutput({ found: true, created: false, client: lookupJson.data[0] }),
      durationMs: Date.now() - startedAt,
    };
  }
  if (!createIfMissing) {
    return {
      output: normalizeClientOutput({ found: false, created: false, client: null }),
      durationMs: Date.now() - startedAt,
    };
  }

  const createRes = await gatewayFetch(`${FIC_API}/c/${companyId}/entities/clients`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiToken}` },
    body: JSON.stringify({
      data: {
        name: vatNumber || taxCode || 'New Client',
        vat_number: vatNumber || undefined,
        tax_code: taxCode || undefined,
        type: 'company',
      },
    }),
  });
  if (!createRes.ok) {
    throw new Error(
      `Fatture in Cloud client create ${String(createRes.status)}: ${(await readTextTruncated(createRes, 8192)).text}`,
    );
  }
  const createdJson = await readJsonCapped<{ data?: unknown }>(createRes);
  // FIC ritorna il cliente creato in `data`; lo esponiamo come fullData + clientId.
  const createdClient = (createdJson.data ?? createdJson) as unknown;
  return {
    output: normalizeClientOutput({ found: false, created: true, client: createdClient }),
    durationMs: Date.now() - startedAt,
  };
};

export const fattureInCloudInvoice: NodeModule = {
  def: {
    id: 'italia_fatture_in_cloud_invoice',
    type: 'action',
    label: 'Fatture in Cloud: Create Invoice',
    icon: 'file-text',
    color: '#ff5a1f',
    description:
      'Crea una nuova fattura su Fatture in Cloud (REST API v2, auth Bearer access-token OAuth2 scope invoices.write). ' +
      'Input: clientId (lookup upstream), righe articoli (qty/unit/price/vat%), payment method codici SDI standard, ' +
      'termine pagamento in giorni (paymentDays → scadenza, inclusa se il totale è calcolabile dalle righe), codice destinatario SDI o PEC. ' +
      'Output normalizzato: { invoiceId, number, pdfUrl, sdiStatus, raw }. Invio SDI separato (PEC o Aruba). ' +
      'Use case: fatturazione automatica post-ordine e-commerce, fatturazione ricorrente abbonamenti, ' +
      'fatturazione massiva fine mese per studio commercialista, integrazione checkout B2B.',
    configFields: [
      {
        key: 'apiToken',
        label: 'Access token OAuth2',
        type: 'secret',
        required: true,
        help: 'Ottienilo da fattureincloud.it → Impostazioni → API → "Crea Token". Scope necessari: invoices.write, clients.read.',
      },
      {
        key: 'companyId',
        label: 'ID Azienda',
        type: 'text',
        required: true,
        placeholder: 'es. 123456',
        help: "ID numerico dell'azienda su Fatture in Cloud. Lo trovi in URL: secure.fattureincloud.it/dashboard/COMPANY_ID/...",
      },
      {
        key: 'clientId',
        label: 'ID Cliente',
        type: 'expression',
        required: true,
        placeholder: '{{$node.LookupClient.json.id}}',
        help: 'ID cliente FIC. Tipicamente dinamico — usa il bottone {{ }} per inserire l\'ID dal nodo "Fatture in Cloud: Lookup/Create Client" a monte.',
      },
      {
        key: 'itemsJson',
        label: 'Righe fattura',
        type: 'invoice-lines',
        required: true,
        help: 'Aggiungi una riga per ciascun articolo o servizio fatturato. IVA in % (es. 22 per 22%).',
      },
      {
        key: 'paymentDays',
        label: 'Termine pagamento (giorni)',
        type: 'number',
        required: false,
        defaultValue: '30',
        help: 'Giorni dalla data fattura entro cui pagare.',
      },
      {
        key: 'paymentMethod',
        label: 'Metodo pagamento',
        type: 'select',
        options: ['MP01 - Contanti', 'MP05 - Bonifico', 'MP08 - Carta', 'MP19 - SDD'],
        required: false,
        defaultValue: 'MP05 - Bonifico',
        help: 'Codici standard SDI per fatturazione elettronica.',
      },
      {
        key: 'sdiCode',
        label: 'Codice destinatario SDI',
        type: 'expression',
        required: false,
        placeholder: '{{input.sdiCode}}',
        help: '7 caratteri alfanumerici del codice destinatario PA/B2B. Tipicamente dinamico (dal form o da DB cliente). Usa "0000000" se il cliente fornisce PEC invece di codice SDI.',
      },
    ],
    vendor: 'flowforge-italia',
    version: '0.3.0',
  },
  executor: invoiceExecutor,
};

export const fattureInCloudClient: NodeModule = {
  def: {
    id: 'italia_fatture_in_cloud_client',
    type: 'action',
    label: 'Fatture in Cloud: Lookup/Create Client',
    icon: 'user-plus',
    color: '#ff5a1f',
    description:
      'Cerca un cliente Fatture in Cloud per partita IVA o codice fiscale; opzionalmente lo crea se non esiste (idempotent upsert). ' +
      'Lookup VAT 11 cifre (con/senza prefisso IT) o CF 16 char (persona fisica). ' +
      'Output normalizzato: { clientId, found: bool, created: bool, fullData }. Pair con italia_fatture_in_cloud_invoice downstream. ' +
      'Use case: onboarding lead → cliente FIC prima di emettere fattura, ' +
      'dedup clienti da import CSV, lookup automatico da form contact.',
    configFields: [
      {
        key: 'apiToken',
        label: 'Access token OAuth2',
        type: 'secret',
        required: true,
        help: 'Stesso token usato per le fatture (vedi nodo "Create Invoice").',
      },
      {
        key: 'companyId',
        label: 'ID Azienda',
        type: 'text',
        required: true,
        placeholder: 'es. 123456',
      },
      {
        key: 'vatNumber',
        label: 'Partita IVA',
        type: 'expression',
        required: false,
        placeholder: '{{input.vatNumber}} o "IT12345678901"',
        help: '11 cifre con o senza prefisso IT. Tipicamente dinamico dal form/CRM — usa {{ }} per inserire valore upstream.',
      },
      {
        key: 'taxCode',
        label: 'Codice fiscale',
        type: 'expression',
        required: false,
        placeholder: '{{input.taxCode}}',
        help: '16 caratteri (persona fisica) o 11 cifre (azienda = P.IVA). Dinamico.',
      },
      {
        key: 'createIfMissing',
        label: 'Crea se non trovato',
        type: 'boolean',
        required: false,
        defaultValue: 'true',
        help: 'Se on, crea un nuovo cliente con i dati passati in input quando non esiste. Se off, ritorna found=false.',
      },
    ],
    vendor: 'flowforge-italia',
    version: '0.3.0',
  },
  executor: clientLookupExecutor,
};
