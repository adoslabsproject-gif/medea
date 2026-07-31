/**
 * Le righe di una fattura.
 *
 * Il totale di ogni riga e quello complessivo si vedono mentre si compila:
 * su una fattura il numero che conta è quello in fondo, e scoprirlo solo a
 * documento emesso è il modo più costoso di accorgersi di un errore.
 */

import { useState } from 'react';

import styles from './fields.module.css';
import {
  lineTotal,
  parseInvoiceLines,
  serializeInvoiceLines,
  type InvoiceLine,
} from './serialization';

/** Le aliquote italiane, più «senza IVA» per le operazioni che non la
 *  prevedono. */
const VAT_RATES = [22, 10, 5, 4, 0];

const euro = (n: number) =>
  n.toLocaleString('it-IT', { style: 'currency', currency: 'EUR', maximumFractionDigits: 2 });

interface Props {
  value: string;
  onChange: (next: string) => void;
}

export function InvoiceLineBuilder({ value, onChange }: Props) {
  const [lines, setLines] = useState<InvoiceLine[]>(() => parseInvoiceLines(value));

  const commit = (next: InvoiceLine[]) => {
    setLines(next);
    onChange(serializeInvoiceLines(next));
  };

  const patch = (index: number, change: Partial<InvoiceLine>) => {
    commit(lines.map((l, i) => (i === index ? { ...l, ...change } : l)));
  };

  const total = lines.reduce((sum, l) => sum + lineTotal(l), 0);

  return (
    <div className={styles.builder}>
      {lines.map((line, i) => (
        <div key={i} className={styles.ruleRow}>
          <div className={styles.row}>
            <input
              className={styles.control}
              placeholder="descrizione della voce"
              aria-label="Voce"
              value={line.name}
              onChange={(e) => {
                patch(i, { name: e.target.value });
              }}
            />
            <button
              type="button"
              className={styles.rowRemove}
              aria-label="Rimuovi questa riga"
              onClick={() => {
                commit(lines.filter((_, j) => j !== i));
              }}
            >
              ✕
            </button>
          </div>

          <div className={styles.row}>
            <input
              type="number"
              className={styles.controlNarrow}
              aria-label="Quantità"
              min={0}
              step="any"
              value={line.quantity}
              onChange={(e) => {
                patch(i, { quantity: Number(e.target.value) || 0 });
              }}
            />
            <span className={styles.rowArrow} aria-hidden="true">
              ×
            </span>
            <input
              type="number"
              className={styles.controlNarrow}
              aria-label="Prezzo unitario netto"
              min={0}
              step="any"
              value={line.net_price}
              onChange={(e) => {
                patch(i, { net_price: Number(e.target.value) || 0 });
              }}
            />
            <select
              className={styles.controlNarrow}
              aria-label="Aliquota IVA"
              value={line.vat ?? ''}
              onChange={(e) => {
                const raw = e.target.value;
                // «senza IVA» toglie il campo invece di scriverci dentro
                // `undefined`: nel documento non deve comparire una chiave
                // vuota.
                commit(
                  lines.map((l, j) => {
                    if (j !== i) return l;
                    const { vat: _none, ...rest } = l;
                    return raw === '' ? rest : { ...rest, vat: Number(raw) };
                  }),
                );
              }}
            >
              <option value="">IVA —</option>
              {VAT_RATES.map((r) => (
                <option key={r} value={r}>
                  IVA {r}%
                </option>
              ))}
            </select>
            <span className={styles.lineTotal}>{euro(lineTotal(line))}</span>
          </div>
        </div>
      ))}

      <div className={styles.row}>
        <button
          type="button"
          className={styles.addRow}
          onClick={() => {
            commit([...lines, { name: '', quantity: 1, net_price: 0, vat: 22 }]);
          }}
        >
          + Aggiungi riga
        </button>
        {lines.length > 0 && (
          <span className={styles.grandTotal}>
            Totale <strong>{euro(total)}</strong>
          </span>
        )}
      </div>
    </div>
  );
}
