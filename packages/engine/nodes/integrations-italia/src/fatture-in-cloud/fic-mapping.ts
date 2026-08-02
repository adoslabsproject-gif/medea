/**
 * Mapping PURO per Fatture in Cloud (FIC API v2) — separato dall'I/O dell'executor.
 *
 * Due responsabilità che la description PROMETTE e che vanno rese vere:
 *  1. Normalizzazione output: la API FIC ritorna `{ data: { id, number, url, ei_status, … } }`.
 *     I nodi downstream hanno bisogno di una shape STABILE { invoiceId, number, pdfUrl,
 *     sdiStatus } (+ `raw` per chi vuole tutto), non del JSON grezzo che cambia col provider.
 *  2. paymentDays → scadenza: il configField esisteva ma l'executor lo IGNORAVA. FIC v2
 *     accetta `data.payments_list` con `due_date`. Lo costruiamo SOLO se il totale è
 *     calcolabile dagli items (difensivo: fatturazione reale → mai un payload azzardato;
 *     se non calcolabile, si omette e FIC genera la scadenza di default come prima).
 *
 * Tutto puro e testabile: zero rete, zero dipendenze dallo stato.
 */

export interface NormalizedInvoice {
  invoiceId: number | null;
  number: string;
  pdfUrl: string;
  sdiStatus: string;
  /** Risposta FIC completa, per i casi che servono campi extra. */
  raw: unknown;
}

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';
}

/** Estrae la shape stabile dalla risposta FIC `{ data: {…} }`. Campi assenti → null/''. */
export function normalizeInvoiceOutput(ficResponse: unknown): NormalizedInvoice {
  const data = asRecord(asRecord(ficResponse).data);
  const id = data.id;
  return {
    invoiceId:
      typeof id === 'number' ? id : typeof id === 'string' && id !== '' ? Number(id) : null,
    number: str(data.number),
    pdfUrl: str(data.url) || str(data.url_attachment),
    // e-invoice (SDI) status: FIC lo espone come `ei_status`.
    sdiStatus: str(data.ei_status),
    raw: ficResponse,
  };
}

export interface NormalizedClient {
  clientId: number | null;
  found: boolean;
  created: boolean;
  /** Oggetto cliente completo (trovato o creato), null se nessuno. */
  fullData: unknown;
}

/** Normalizza l'esito lookup/create cliente nella shape promessa dalla description. */
export function normalizeClientOutput(opts: {
  found: boolean;
  created: boolean;
  client: unknown;
}): NormalizedClient {
  const rec = asRecord(opts.client);
  const id = rec.id;
  return {
    clientId: typeof id === 'number' ? id : typeof id === 'string' && id !== '' ? Number(id) : null,
    found: opts.found,
    created: opts.created,
    fullData: opts.client ?? null,
  };
}

/**
 * Calcola il totale lordo (IVA inclusa) di una lista di righe FIC, in modo DIFENSIVO:
 * legge qty (default 1) e prezzo unitario da più nomi possibili (net_price/gross_price/
 * price/unit_price) + IVA da vat/vat_rate (o oggetto { value }). Ritorna `null` se NESSUNA
 * riga è calcolabile → il chiamante OMETTE payments_list (nessun azzardo sul payload).
 */
export function computeItemsGrossTotal(items: readonly unknown[]): number | null {
  let total = 0;
  let anyValid = false;
  for (const raw of items) {
    const it = asRecord(raw);
    // Qty PRIMA di tutto: qty assente→1, ma ≤0/NaN si salta SENZA valutare
    // prezzo/IVA (altrimenti una riga scartata triggererebbe il null-conservativo
    // dell'IVA qui sotto).
    const qty = Number(it.qty ?? it.quantity ?? 1);
    if (!Number.isFinite(qty) || qty <= 0) continue;
    const gross = it.gross_price ?? it.grossPrice;
    const net = it.net_price ?? it.netPrice ?? it.price ?? it.unit_price ?? it.unitPrice;
    let unitGross: number;
    if (gross !== undefined && Number.isFinite(Number(gross))) {
      unitGross = Number(gross); // lordo esplicito: nessuna IVA da risolvere
    } else if (net !== undefined && Number.isFinite(Number(net))) {
      // IVA risolvibile SOLO come percentuale numerica esplicita (vat_rate/vatRate/
      // vat numerico/`vat:{value}`). Il formato FIC NATIVO `vat:{id}` (riferimento
      // a un'aliquota) NON è una percentuale → lordo indeterminato. NON si assume
      // 0% (sottostimerebbe il lordo → payments_list.amount ≠ totale fattura FIC =
      // errore di riconciliazione): si dichiara l'INTERO totale non calcolabile.
      const vatRec = asRecord(it.vat);
      const vatRaw =
        it.vat_rate ?? it.vatRate ?? (typeof it.vat === 'number' ? it.vat : vatRec.value);
      const vatPct = Number(vatRaw);
      if (vatRaw === undefined || vatRaw === null || !Number.isFinite(vatPct)) {
        return null; // IVA non determinabile su riga net → totale inaffidabile
      }
      unitGross = Number(net) * (1 + vatPct / 100);
    } else {
      continue; // riga non calcolabile (né gross né net) → la salto
    }
    total += unitGross * qty;
    anyValid = true;
  }
  if (!anyValid) return null;
  return Math.round(total * 100) / 100;
}

/** Data ISO (YYYY-MM-DD) di oggi + `days`. Usata per la due_date della scadenza. */
export function dueDateFromNow(days: number, now: Date = new Date()): string {
  const d = new Date(now.getTime());
  d.setDate(d.getDate() + (Number.isFinite(days) ? days : 0));
  return d.toISOString().slice(0, 10);
}

export interface PaymentEntry {
  due_date: string;
  amount: number;
  status: 'not_paid';
}

/**
 * Costruisce `payments_list` per onorare paymentDays. Ritorna `null` (→ ometti il campo)
 * se i giorni non sono validi o il totale non è calcolabile: su fatturazione reale è meglio
 * la scadenza di default di FIC che un payload inventato.
 */
export function buildPaymentsList(
  items: readonly unknown[],
  paymentDays: number,
  now?: Date,
): PaymentEntry[] | null {
  if (!Number.isFinite(paymentDays) || paymentDays <= 0) return null;
  const total = computeItemsGrossTotal(items);
  if (total === null) return null;
  return [{ due_date: dueDateFromNow(paymentDays, now), amount: total, status: 'not_paid' }];
}
