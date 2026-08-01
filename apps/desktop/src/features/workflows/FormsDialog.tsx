/**
 * I form pubblici, tutti in un posto.
 *
 * Un form disegnato è un workflow come gli altri: finisce nell'elenco, e
 * dopo due settimane non si sa più quale fosse né se qualcuno l'ha compilato.
 * Qui si vedono per quello che sono — pagine con un indirizzo — e si vede
 * subito la cosa che interessa: **quanti invii**, e l'ultimo quando.
 *
 * Aprendone uno si legge cosa è stato scritto. È l'unico posto dell'editor
 * dove si guardano i dati e non il disegno, ed è di proposito: chi pubblica
 * un form vuole leggere le risposte, non ispezionare esecuzioni.
 */

import { useEffect, useState } from 'react';

import styles from './FormsDialog.module.css';
import { listForms, submissions } from './runtime';
import type { PublicForm, Submission } from './runtime';

interface Props {
  onClose: () => void;
  /** Porta nell'editor il workflow che sta dietro al form. */
  onOpen: (workflowId: string) => void;
}

/** La data come la direbbe una persona. */
function when(iso: string | null): string {
  if (!iso) return 'mai';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString('it-IT');
}

/** Cosa ha scritto qualcuno, in una riga sola. */
function riassunto(input: Record<string, unknown>): string {
  const parti = Object.entries(input).map(([k, v]) => `${k}: ${String(v)}`);
  return parti.length > 0 ? parti.join(' · ') : '(vuoto)';
}

export function FormsDialog({ onClose, onOpen }: Props) {
  const [forms, setForms] = useState<PublicForm[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Quale form si sta guardando dentro. */
  const [aperto, setAperto] = useState<string | null>(null);
  const [invii, setInvii] = useState<Submission[] | null>(null);
  const [copiato, setCopiato] = useState<string | null>(null);

  useEffect(() => {
    void listForms()
      .then(setForms)
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : String(e));
        setForms([]);
      });
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

  const guarda = (form: PublicForm) => {
    if (aperto === form.workflowId) {
      setAperto(null);
      return;
    }
    setAperto(form.workflowId);
    setInvii(null);
    void submissions(form.workflowId)
      .then(setInvii)
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : String(e));
        setInvii([]);
      });
  };

  const copia = (form: PublicForm) => {
    void navigator.clipboard.writeText(form.formUrl).then(() => {
      setCopiato(form.workflowId);
    });
  };

  return (
    <div className={styles.backdrop} role="dialog" aria-modal="true" aria-label="Form pubblici">
      <div className={styles.panel}>
        <header className={styles.head}>
          <div>
            <h2 className={styles.title}>Form</h2>
            <span className={styles.subtitle}>Le pagine compilabili e cosa ci è arrivato</span>
          </div>
          <button type="button" className={styles.close} aria-label="Chiudi" onClick={onClose}>
            ✕
          </button>
        </header>

        {error && <p className={styles.error}>{error}</p>}

        <div className={styles.body}>
          {forms === null && <p className={styles.hint}>Sto guardando…</p>}

          {forms?.length === 0 && (
            <p className={styles.hint}>
              Nessun form. Ne nasce uno appena un workflow comincia con il nodo «Form»: da lì in poi
              ha un indirizzo da mandare a qualcuno.
            </p>
          )}

          {forms?.map((form) => (
            <article key={form.workflowId} className={styles.card}>
              <div className={styles.cardHead}>
                <div className={styles.identity}>
                  <span className={styles.name}>{form.title}</span>
                  <span className={styles.meta}>
                    {form.workflowName} · {form.fieldsCount} campi
                    {!form.enabled && (
                      /* Un form spento ha un indirizzo che risponde con un
                         errore: dirlo qui evita di mandarlo a qualcuno e
                         scoprirlo da lui. */
                      <span className={styles.off}> · spento, non risponde</span>
                    )}
                  </span>
                </div>
                <div className={styles.counts}>
                  <span className={styles.count}>{form.submissionCount}</span>
                  <span className={styles.countLabel}>
                    {form.submissionCount === 1 ? 'invio' : 'invii'}
                  </span>
                </div>
              </div>

              <div className={styles.urlRow}>
                <code className={styles.url}>{form.formUrl}</code>
                <button
                  type="button"
                  className={styles.small}
                  onClick={() => {
                    copia(form);
                  }}
                >
                  {copiato === form.workflowId ? 'Copiato' : 'Copia'}
                </button>
              </div>

              <div className={styles.actions}>
                <span className={styles.last}>Ultimo: {when(form.lastSubmissionAt)}</span>
                <button
                  type="button"
                  className={styles.small}
                  onClick={() => {
                    guarda(form);
                  }}
                >
                  {aperto === form.workflowId ? 'Chiudi' : 'Cosa è arrivato'}
                </button>
                <button
                  type="button"
                  className={styles.small}
                  onClick={() => {
                    onOpen(form.workflowId);
                  }}
                >
                  Apri il workflow
                </button>
              </div>

              {aperto === form.workflowId && (
                <div className={styles.submissions}>
                  {invii === null && <p className={styles.hint}>Sto leggendo…</p>}
                  {invii?.length === 0 && (
                    <p className={styles.hint}>Ancora nessuno l’ha compilato.</p>
                  )}
                  {invii?.map((s) => (
                    <div key={s.runId} className={styles.submission} data-status={s.status}>
                      <span className={styles.subWhen}>{when(s.startedAt)}</span>
                      <span className={styles.subInput}>{riassunto(s.input)}</span>
                    </div>
                  ))}
                </div>
              )}
            </article>
          ))}
        </div>

        <footer className={styles.foot}>
          {/* Lo stesso avvertimento dei webhook, e per lo stesso motivo:
              mostrare un indirizzo pubblico che non esiste sarebbe peggio che
              dire che è locale. */}
          L’indirizzo è su questo computer: si apre da qui, o da chi arriva con un tunnel. Da
          internet, così com’è, non si raggiunge.
        </footer>
      </div>
    </div>
  );
}
