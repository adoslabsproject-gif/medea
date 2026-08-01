/**
 * Cosa succede quando questo nodo fallisce.
 *
 * Il motore lo sa fare da sempre — riprova, oppure prosegue lasciando un
 * errore al posto del risultato — ma nessun pannello lo esponeva: erano due
 * comportamenti raggiungibili solo scrivendo a mano nel JSON.
 *
 * Le due scelte sono diverse e vanno tenute distinte:
 *
 *   RIPROVARE  serve ai guasti che passano da soli — una rete che cade, un
 *              servizio che risponde «troppe richieste».
 *   PROSEGUIRE serve quando il fallimento è un esito accettabile: cercare un
 *              contatto e non trovarlo non deve fermare tutto il flusso.
 *
 * Riprovare un errore di autenticazione non lo aggiusta: lo ripete dieci
 * volte e, con certi servizi, fa bloccare l'account. Per questo si può dire
 * *su quali* categorie proseguire invece che su tutte.
 */

import type { CanvasNode, NodeDef } from '../types';

import styles from './ErrorHandling.module.css';

/** Le categorie di guasto che il motore sa distinguere. */
const CATEGORIE = [
  { id: 'network', label: 'Rete', hint: 'Connessione caduta, timeout' },
  { id: 'rate_limit', label: 'Troppe richieste', hint: 'Il servizio chiede di rallentare' },
  { id: 'auth', label: 'Autenticazione', hint: 'Credenziali rifiutate' },
  { id: 'validation', label: 'Dati non validi', hint: 'Il nodo ha ricevuto qualcosa che non va' },
  { id: 'business', label: 'Esito negativo', hint: 'Il servizio ha detto di no' },
  { id: 'internal', label: 'Guasto interno', hint: 'Qualcosa di rotto nel nodo' },
] as const;

/** Quanti tentativi in più il motore accetta. */
const MAX_TENTATIVI = 10;

interface Props {
  node: CanvasNode;
  def: NodeDef | undefined;
  onNodeChange: (patch: Partial<CanvasNode>) => void;
  onConfigChange: (config: Record<string, unknown>) => void;
}

function numero(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function ErrorHandling({ node, def, onNodeChange, onConfigChange }: Props) {
  const tentativi = numero(node.config.retryCount, 0);
  const attesa = numero(node.config.retryDelayMs, 1000);
  const prosegue = node.continueOnFail === true;
  const soloSu = new Set((node.config.continueOnFailOn as string[] | undefined) ?? []);

  return (
    <section className={styles.root}>
      <h4 className={styles.title}>Se fallisce</h4>

      {/* ── Riprovare ─────────────────────────────────────────────────── */}
      {def?.selfManagedRetry ? (
        <p className={styles.selfManaged}>
          Questo nodo riprova da sé. Il motore non ci si sovrappone: aggiungere altri tentativi qui
          vorrebbe dire moltiplicarli.
        </p>
      ) : (
        <>
          <label className={styles.field}>
            <span className={styles.label}>Tentativi in più</span>
            <input
              type="number"
              className={styles.number}
              min={0}
              max={MAX_TENTATIVI}
              value={tentativi}
              onChange={(e) => {
                // Come stringa: è il contratto del motore, che i numeri li converte lui.
                onConfigChange({ ...node.config, retryCount: e.target.value });
              }}
            />
          </label>

          {tentativi > 0 && (
            <label className={styles.field}>
              <span className={styles.label}>Attesa fra un tentativo e l’altro</span>
              <span className={styles.inline}>
                <input
                  type="number"
                  className={styles.number}
                  min={0}
                  step={250}
                  value={attesa}
                  onChange={(e) => {
                    onConfigChange({ ...node.config, retryDelayMs: e.target.value });
                  }}
                />
                <span className={styles.unit}>millisecondi</span>
              </span>
            </label>
          )}

          <p className={styles.hint}>
            Riprovare aggiusta i guasti che passano da soli. Un errore di autenticazione non è di
            quelli: si ripeterebbe uguale.
          </p>
        </>
      )}

      {/* ── Proseguire ────────────────────────────────────────────────── */}
      <label className={styles.check}>
        <input
          type="checkbox"
          checked={prosegue}
          onChange={(e) => {
            onNodeChange({ continueOnFail: e.target.checked });
          }}
        />
        <span>Prosegui lo stesso, passando l’errore al nodo dopo</span>
      </label>

      {prosegue && (
        <div className={styles.categories}>
          <span className={styles.label}>
            Su quali guasti? <span className={styles.muted}>(nessuno scelto: su tutti)</span>
          </span>
          {CATEGORIE.map((categoria) => (
            <label key={categoria.id} className={styles.category}>
              <input
                type="checkbox"
                checked={soloSu.has(categoria.id)}
                onChange={(e) => {
                  const next = new Set(soloSu);
                  if (e.target.checked) next.add(categoria.id);
                  else next.delete(categoria.id);
                  onConfigChange({ ...node.config, continueOnFailOn: [...next] });
                }}
              />
              <span className={styles.categoryLabel}>{categoria.label}</span>
              <span className={styles.categoryHint}>{categoria.hint}</span>
            </label>
          ))}
        </div>
      )}
    </section>
  );
}
