/**
 * Le impostazioni di un workflow, e quella che vale per tutti.
 *
 * Tre cose che il motore sa fare da sempre e che nessuno poteva scegliere:
 *
 *   ETICHETTE      per ritrovare un workflow fra trenta. Con cinque non
 *                  servono; con trenta, l'elenco senza è una lista di nomi
 *                  che si somigliano.
 *   QUANTO SCRIVE  nello storico. Un workflow che gira ogni minuto e registra
 *                  tutto riempie il database di roba che nessuno leggerà.
 *   EMERGENZA      quale workflow lanciare quando qualcosa fallisce. Senza,
 *                  un cron notturno che smette di funzionare lo si scopre
 *                  giorni dopo, quando qualcuno nota che una cosa non è stata
 *                  fatta.
 *
 * L'ultima vale per tutti i workflow, non per questo: sta qui perché è qui che
 * si va quando si pensa «e se fallisce?».
 */

import { useEffect, useState } from 'react';

import { useElenco } from './pickers';
import { errorWorkflow, setErrorWorkflow } from './runtime';
import type { Workflow } from './types';
import styles from './WorkflowSettingsDialog.module.css';

interface Props {
  workflow: Workflow;
  onChange: (wf: Workflow) => void;
  onClose: () => void;
}

/** Quanto un'esecuzione registra di sé. */
const VERBOSITY = [
  { id: 'summary', label: 'Il necessario', hint: 'Stato e durata di ogni passo' },
  { id: 'full', label: 'Tutto', hint: 'Anche ingressi e uscite: utile mentre lo si mette a punto' },
  { id: 'silent', label: 'Solo i fallimenti', hint: 'Per i workflow che girano spessissimo' },
] as const;

export function WorkflowSettingsDialog({ workflow, onChange, onClose }: Props) {
  const [emergenza, setEmergenza] = useState<string | null>(null);
  const [nuovaEtichetta, setNuovaEtichetta] = useState('');
  const { scelte: workflows } = useElenco('workflow-picker');

  useEffect(() => {
    void errorWorkflow()
      .then(setEmergenza)
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const tags = workflow.tags ?? [];

  const aggiungiEtichetta = () => {
    const pulita = nuovaEtichetta.trim().toLowerCase();
    // Niente doppioni e niente vuote: un'etichetta ripetuta non aiuta a
    // trovare niente, e una vuota è solo una virgola in più nell'elenco.
    if (!pulita || tags.includes(pulita)) return;
    onChange({ ...workflow, tags: [...tags, pulita] });
    setNuovaEtichetta('');
  };

  return (
    <div className={styles.backdrop} role="dialog" aria-modal="true" aria-label="Impostazioni">
      <div className={styles.panel}>
        <header className={styles.head}>
          <h2 className={styles.title}>Impostazioni</h2>
          <button type="button" className={styles.close} aria-label="Chiudi" onClick={onClose}>
            ✕
          </button>
        </header>

        <div className={styles.body}>
          {/* ── Etichette ─────────────────────────────────────────────── */}
          <section className={styles.section}>
            <h3 className={styles.sectionTitle}>Etichette</h3>
            <p className={styles.hint}>
              Per ritrovarlo fra trenta. Con cinque workflow non servono.
            </p>

            {tags.length > 0 && (
              <div className={styles.tags}>
                {tags.map((tag) => (
                  <button
                    key={tag}
                    type="button"
                    className={styles.tag}
                    title={`Togli «${tag}»`}
                    onClick={() => {
                      onChange({ ...workflow, tags: tags.filter((t) => t !== tag) });
                    }}
                  >
                    {tag} ✕
                  </button>
                ))}
              </div>
            )}

            <div className={styles.row}>
              <input
                className={styles.input}
                placeholder="posta, fatture, notturni…"
                aria-label="Nuova etichetta"
                value={nuovaEtichetta}
                onChange={(e) => {
                  setNuovaEtichetta(e.target.value);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    aggiungiEtichetta();
                  }
                }}
              />
              <button type="button" className={styles.secondary} onClick={aggiungiEtichetta}>
                Aggiungi
              </button>
            </div>
          </section>

          {/* ── Quanto registra ───────────────────────────────────────── */}
          <section className={styles.section}>
            <h3 className={styles.sectionTitle}>Cosa registra nello storico</h3>
            {VERBOSITY.map((v) => (
              <label key={v.id} className={styles.choice}>
                <input
                  type="radio"
                  name="verbosity"
                  checked={(workflow.runVerbosity ?? 'summary') === v.id}
                  onChange={() => {
                    onChange({ ...workflow, runVerbosity: v.id });
                  }}
                />
                <span>
                  <span className={styles.choiceLabel}>{v.label}</span>
                  <span className={styles.hint}> — {v.hint}</span>
                </span>
              </label>
            ))}
          </section>

          {/* ── Emergenza ─────────────────────────────────────────────── */}
          <section className={styles.section}>
            <h3 className={styles.sectionTitle}>Se qualcosa fallisce</h3>
            <p className={styles.hint}>
              Vale per <strong>tutti</strong> i workflow. Senza, un cron notturno che smette di
              funzionare lo si scopre giorni dopo.
            </p>
            <select
              className={styles.input}
              aria-label="Workflow di emergenza"
              value={emergenza ?? ''}
              onChange={(e) => {
                const scelto = e.target.value || null;
                setEmergenza(scelto);
                void setErrorWorkflow(scelto);
              }}
            >
              <option value="">— nessuno —</option>
              {workflows.map((w) => (
                <option key={w.value} value={w.value}>
                  {w.label}
                </option>
              ))}
            </select>
          </section>
        </div>
      </div>
    </div>
  );
}
