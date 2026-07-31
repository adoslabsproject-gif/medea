/**
 * Gli allegati di un'email.
 *
 * Il campo grezzo chiede di scrivere a mano
 * `[{"name":"x.pdf","base64":"…"}]`: per un PDF vero è impraticabile. Qui si
 * sceglie il file e il contenuto ci finisce da solo.
 *
 * Quattro provenienze, perché quattro sono i casi reali: un file scelto
 * adesso, un indirizzo che il motore scaricherà, un percorso sul disco, e
 * un'espressione — il caso che conta di più, quando è un nodo a monte a
 * generare il documento da allegare.
 */

import { useRef, useState } from 'react';

import styles from './fields.module.css';
import {
  parseAttachments,
  serializeAttachments,
  type Attachment,
  type AttachmentSource,
} from './serialization';

/** Oltre questa dimensione il file gonfia il documento invece di allegarsi:
 *  meglio un indirizzo o un'espressione. */
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

const SOURCE_LABEL: Record<AttachmentSource, string> = {
  upload: 'file scelto ora',
  url: 'indirizzo web',
  path: 'percorso sul disco',
  expression: 'da un nodo a monte',
};

const PLACEHOLDER: Record<AttachmentSource, string> = {
  upload: '',
  url: 'https://…/documento.pdf',
  path: '/percorso/al/file.pdf',
  expression: '{{$node.crea_pdf.json.base64}}',
};

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => {
      reject(new Error('Non sono riuscito a leggere il file.'));
    };
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      // `data:...;base64,XXXX` → solo la parte dopo la virgola.
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.readAsDataURL(file);
  });
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface Props {
  value: string;
  onChange: (next: string) => void;
}

export function AttachmentsBuilder({ value, onChange }: Props) {
  const [items, setItems] = useState<Attachment[]>(() => parseAttachments(value));
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const pendingIndex = useRef<number | null>(null);

  const commit = (next: Attachment[]) => {
    setItems(next);
    onChange(serializeAttachments(next));
  };

  const patch = (index: number, change: Partial<Attachment>) => {
    commit(items.map((a, i) => (i === index ? { ...a, ...change } : a)));
  };

  const onFile = async (file: File) => {
    const index = pendingIndex.current;
    if (index === null) return;
    if (file.size > MAX_UPLOAD_BYTES) {
      setError(
        `«${file.name}» pesa ${humanSize(file.size)}: sopra i 5 MB conviene un indirizzo o un’espressione, altrimenti il file finisce dentro il workflow.`,
      );
      return;
    }
    setError(null);
    patch(index, {
      name: file.name,
      source: 'upload',
      value: await readAsBase64(file),
      contentType: file.type || 'application/octet-stream',
      sizeBytes: file.size,
    });
  };

  return (
    <div className={styles.builder}>
      <input
        ref={fileInput}
        type="file"
        className={styles.hiddenInput}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void onFile(file);
          e.target.value = '';
        }}
      />

      {items.map((a, i) => (
        <div key={i} className={styles.ruleRow}>
          <div className={styles.row}>
            <input
              className={styles.control}
              placeholder="nome del file"
              aria-label="Nome dell’allegato"
              value={a.name}
              onChange={(e) => {
                patch(i, { name: e.target.value });
              }}
            />
            <button
              type="button"
              className={styles.rowRemove}
              aria-label="Rimuovi questo allegato"
              onClick={() => {
                commit(items.filter((_, j) => j !== i));
              }}
            >
              ✕
            </button>
          </div>

          <div className={styles.row}>
            <select
              className={styles.controlNarrow}
              aria-label="Da dove arriva"
              value={a.source}
              onChange={(e) => {
                // Cambiando provenienza il valore di prima non vale più: un
                // base64 non è un indirizzo.
                patch(i, { source: e.target.value as AttachmentSource, value: '' });
              }}
            >
              {(Object.keys(SOURCE_LABEL) as AttachmentSource[]).map((s) => (
                <option key={s} value={s}>
                  {SOURCE_LABEL[s]}
                </option>
              ))}
            </select>

            {a.source === 'upload' ? (
              <button
                type="button"
                className={styles.inlineBtn}
                onClick={() => {
                  pendingIndex.current = i;
                  fileInput.current?.click();
                }}
              >
                {a.value ? `Sostituisci (${humanSize(a.sizeBytes ?? 0)})` : 'Scegli un file…'}
              </button>
            ) : (
              <input
                className={styles.control}
                placeholder={PLACEHOLDER[a.source]}
                aria-label="Valore dell’allegato"
                value={a.value}
                onChange={(e) => {
                  patch(i, { value: e.target.value });
                }}
              />
            )}
          </div>
        </div>
      ))}

      {error && <p className={styles.error}>{error}</p>}

      <button
        type="button"
        className={styles.addRow}
        onClick={() => {
          commit([...items, { name: '', source: 'upload', value: '' }]);
        }}
      >
        + Aggiungi allegato
      </button>
    </div>
  );
}
