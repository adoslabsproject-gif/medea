/**
 * La pianificazione, scritta a parole invece che in sintassi cron.
 *
 * Due modi, come nell'originale: le frequenze pronte («ogni giorno alle 9»)
 * per chi non sa cosa sia `0 9 * * *`, e l'espressione libera per chi lo sa.
 * Sotto, sempre visibile, la frase in italiano che descrive davvero quello che
 * è scritto — è il controllo che evita di scoprire l'errore fra una settimana.
 */

import { useState } from 'react';

import { humanizeCron } from './cron-humanize';
import styles from './fields.module.css';

interface Preset {
  label: string;
  expr: string;
}

const PRESETS: Preset[] = [
  { label: 'Ogni 5 minuti', expr: '*/5 * * * *' },
  { label: 'Ogni 15 minuti', expr: '*/15 * * * *' },
  { label: 'Ogni ora', expr: '0 * * * *' },
  { label: 'Ogni giorno alle 9', expr: '0 9 * * *' },
  { label: 'Giorni feriali alle 8', expr: '0 8 * * 1-5' },
  { label: 'Ogni lunedì alle 9', expr: '0 9 * * 1' },
  { label: 'Il 1 del mese alle 3', expr: '0 3 1 * *' },
];

interface Props {
  value: string;
  onChange: (next: string) => void;
}

export function CronBuilder({ value, onChange }: Props) {
  const [custom, setCustom] = useState(() => !PRESETS.some((p) => p.expr === value));

  let description: string;
  try {
    description = humanizeCron(value);
  } catch {
    description =
      'Espressione non valida: servono cinque campi (minuto ora giorno mese giorno-settimana).';
  }

  return (
    <div className={styles.builder}>
      <div className={styles.segmented}>
        <button
          type="button"
          className={styles.segment}
          data-on={custom ? 'false' : 'true'}
          onClick={() => {
            setCustom(false);
          }}
        >
          Frequenze pronte
        </button>
        <button
          type="button"
          className={styles.segment}
          data-on={custom ? 'true' : 'false'}
          onClick={() => {
            setCustom(true);
          }}
        >
          Espressione cron
        </button>
      </div>

      {custom ? (
        <input
          className={`${styles.control} ${styles.mono}`}
          aria-label="Espressione cron"
          placeholder="0 9 * * 1-5"
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
          }}
        />
      ) : (
        <div className={styles.presets}>
          {PRESETS.map((p) => (
            <button
              key={p.expr}
              type="button"
              className={styles.preset}
              data-on={p.expr === value ? 'true' : 'false'}
              onClick={() => {
                onChange(p.expr);
              }}
            >
              {p.label}
            </button>
          ))}
        </div>
      )}

      <p className={styles.preview}>{description}</p>
    </div>
  );
}
