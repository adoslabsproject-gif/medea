/**
 * Le impostazioni della ricerca sul web dell'assistente.
 *
 * Senza toccare niente la ricerca funziona già, con DuckDuckGo. Qui si può
 * mettere la chiave di un motore migliore, e decidere se le pagine si aprono
 * senza chiedere.
 */

import { Button, TextField } from '@medea/ui';
import { useEffect, useState } from 'react';

import { FETCH_SENZA_CONFERMA_KEY, confermaWebDisattivata } from '../ai/web-consent';
import { secretsApi } from '../secrets/api';

import styles from './SettingsView.module.css';

/** Le voci del portachiavi: gli stessi nomi che legge lo strumento in Rust. */
export const MOTORI = [
  {
    id: 'tavily',
    voce: 'web.key.tavily',
    nome: 'Tavily',
    nota: 'Risultati pensati per un modello, con un riassunto. tavily.com',
  },
  {
    id: 'brave',
    voce: 'web.key.brave',
    nome: 'Brave Search',
    nota: 'Indice proprio, nessun tracciamento. brave.com/search/api',
  },
] as const;

type MotoreId = (typeof MOTORI)[number]['id'];

export function WebSearchSettings() {
  const [chiavi, setChiavi] = useState<Record<MotoreId, string>>({ tavily: '', brave: '' });
  const [salvata, setSalvata] = useState<MotoreId | null>(null);
  const [errore, setErrore] = useState<string | null>(null);
  const [senzaConferma, setSenzaConferma] = useState(() => confermaWebDisattivata());

  useEffect(() => {
    void (async () => {
      try {
        const lette = { tavily: '', brave: '' };
        for (const m of MOTORI) lette[m.id] = (await secretsApi.get(m.voce)) ?? '';
        setChiavi(lette);
      } catch (e) {
        setErrore(e instanceof Error ? e.message : String(e));
      }
    })();
  }, []);

  async function salva(id: MotoreId, voce: string) {
    setErrore(null);
    try {
      const valore = chiavi[id].trim();
      if (valore) await secretsApi.set(voce, valore);
      else await secretsApi.delete(voce);
      setSalvata(id);
      setTimeout(() => {
        setSalvata(null);
      }, 1200);
    } catch (e) {
      setErrore(e instanceof Error ? e.message : String(e));
    }
  }

  function cambiaConferma(senza: boolean) {
    setSenzaConferma(senza);
    if (senza) localStorage.setItem(FETCH_SENZA_CONFERMA_KEY, 'true');
    else localStorage.removeItem(FETCH_SENZA_CONFERMA_KEY);
  }

  return (
    <div className={`${styles.section} ${styles.formWide}`}>
      <h2 className={styles.sectionTitle}>🌐 Ricerca sul web</h2>
      <p className={styles.muted}>
        L’assistente può cercare sul web e leggere pagine pubbliche con qualunque modello. Senza
        chiavi usa DuckDuckGo. Con una chiave qui sotto usa quel motore, e ripiega su DuckDuckGo se
        non risponde.
      </p>

      <div className={styles.fieldStack} style={{ marginBlockStart: 'var(--space-3)' }}>
        {MOTORI.map((m) => (
          <div key={m.id}>
            <TextField
              label={`Chiave ${m.nome} (facoltativa)`}
              type="password"
              revealable
              value={chiavi[m.id]}
              onChange={(e) => {
                setChiavi({ ...chiavi, [m.id]: e.target.value });
              }}
              autoComplete="off"
              spellCheck={false}
              hint={m.nota}
              fullWidth
            />
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void salva(m.id, m.voce);
              }}
            >
              {salvata === m.id ? '✓ Salvata' : `Salva chiave ${m.nome}`}
            </Button>
          </div>
        ))}
      </div>

      {errore && (
        <p role="alert" className={styles.testKo}>
          {errore}
        </p>
      )}

      <label
        style={{
          display: 'flex',
          gap: 'var(--space-2)',
          alignItems: 'flex-start',
          marginBlockStart: 'var(--space-4)',
        }}
      >
        <input
          type="checkbox"
          checked={senzaConferma}
          onChange={(e) => {
            cambiaConferma(e.target.checked);
          }}
        />
        <span>
          Apri le pagine senza chiedere conferma
          <br />
          <span className={styles.muted}>
            Di norma la prima pagina di ogni sito, in ogni conversazione, la confermi tu vedendo
            l’indirizzo. È una protezione: un’email può contenere istruzioni che spingono il modello
            ad aprire un indirizzo con dentro dati della tua posta.
          </span>
        </span>
      </label>
    </div>
  );
}
