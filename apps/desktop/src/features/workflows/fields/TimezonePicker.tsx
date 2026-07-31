/**
 * Il fuso orario in cui viene valutata la pianificazione.
 *
 * L'elenco arriva da `Intl.supportedValuesOf('timeZone')` quando c'è — sono i
 * fusi che conosce davvero il sistema — con un ripiego sui più usati per gli
 * ambienti che non lo espongono. Roma è il primo della lista perché è quello
 * che serve quasi sempre.
 */

import { useMemo } from 'react';

import styles from './fields.module.css';

const COMMON = [
  'Europe/Rome',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'Europe/Madrid',
  'UTC',
  'America/New_York',
  'America/Los_Angeles',
  'Asia/Tokyo',
];

function availableZones(): string[] {
  const withSupport = Intl as typeof Intl & { supportedValuesOf?: (k: string) => string[] };
  const all = withSupport.supportedValuesOf?.('timeZone') ?? [];
  if (all.length === 0) return COMMON;
  // I più usati in cima, poi tutti gli altri: si trova subito quello giusto
  // senza rinunciare agli altri.
  const rest = all.filter((z) => !COMMON.includes(z));
  return [...COMMON.filter((z) => all.includes(z)), ...rest];
}

interface Props {
  value: string;
  onChange: (next: string) => void;
}

export function TimezonePicker({ value, onChange }: Props) {
  const zones = useMemo(availableZones, []);
  const now = useMemo(() => {
    if (!value) return '';
    try {
      return new Intl.DateTimeFormat('it-IT', {
        timeZone: value,
        hour: '2-digit',
        minute: '2-digit',
      }).format(new Date());
    } catch {
      return '';
    }
  }, [value]);

  return (
    <div className={styles.builder}>
      <select
        className={styles.control}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
        }}
      >
        <option value="">— non impostato —</option>
        {zones.map((z) => (
          <option key={z} value={z}>
            {z}
          </option>
        ))}
      </select>
      {now && <p className={styles.preview}>Adesso lì sono le {now}.</p>}
    </div>
  );
}
