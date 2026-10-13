/**
 * La barra di Claude Code sopra il campo di scrittura: quale modello, in
 * quale cartella lavora, e come fermarlo.
 */

import { useState } from 'react';

import { aiApi } from '../api';

import styles from './ClaudeCodeBar.module.css';
import {
  cartellaScelta,
  MODELLI,
  modelloScelto,
  scegliCartella,
  scegliModello,
  type ModelloId,
} from './settings';

interface Props {
  /** Un turno è in corso: mostra il pulsante per fermarlo. */
  inCorso: boolean;
  onFerma: () => void;
}

/** Il nome della cartella, senza il percorso che la precede. */
function nomeCorto(percorso: string): string {
  return percorso.split(/[\\/]/u).filter(Boolean).at(-1) ?? percorso;
}

export function ClaudeCodeBar({ inCorso, onFerma }: Props) {
  const [modello, setModello] = useState<ModelloId>(() => modelloScelto());
  const [cartella, setCartella] = useState<string | null>(() => cartellaScelta());
  const [errore, setErrore] = useState<string | null>(null);

  async function scegli() {
    setErrore(null);
    try {
      const scelta = await aiApi.claudeCode.scegliCartella();
      if (scelta === null) return;
      scegliCartella(scelta);
      setCartella(scelta);
    } catch (e) {
      setErrore(e instanceof Error ? e.message : String(e));
    }
  }

  function togli() {
    scegliCartella(null);
    setCartella(null);
  }

  return (
    <div className={styles.bar}>
      <label className={styles.campo}>
        <span className={styles.etichetta}>Modello</span>
        <select
          className={styles.select}
          value={modello}
          aria-label="Modello di Claude Code"
          onChange={(e) => {
            const scelto = MODELLI.find((m) => m.id === e.target.value)?.id ?? 'default';
            scegliModello(scelto);
            setModello(scelto);
          }}
        >
          {MODELLI.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
      </label>

      <div className={styles.campo}>
        <span className={styles.etichetta}>Cartella</span>
        <button
          type="button"
          className={styles.cartella}
          onClick={() => void scegli()}
          title={
            cartella ??
            'Nessuna cartella scelta: Claude Code lavora in una cartella vuota di Medea e non tocca i tuoi file'
          }
        >
          📁 {cartella ? nomeCorto(cartella) : 'nessuna (isolato)'}
        </button>
        {cartella && (
          <button
            type="button"
            className={styles.togli}
            onClick={togli}
            aria-label="Togli la cartella di lavoro"
            title="Torna alla cartella vuota di Medea"
          >
            ✕
          </button>
        )}
      </div>

      {inCorso && (
        <button type="button" className={styles.ferma} onClick={onFerma}>
          ■ Ferma
        </button>
      )}

      {errore && (
        <span role="alert" className={styles.errore}>
          {errore}
        </span>
      )}
    </div>
  );
}
