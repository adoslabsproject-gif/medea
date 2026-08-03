/**
 * Mentre costruisce.
 *
 * Un minuto davanti a un cerchio che gira è indistinguibile da un programma
 * bloccato — ed è successo davvero: cinque minuti su «sta pensando» senza che
 * niente dicesse se stava lavorando o se era morto.
 *
 * Quindi qui si dice tutto quello che si sa: a che punto è sui passi previsti,
 * da quanto ci sta lavorando, quanti token è costato finora, quanti passi sono
 * andati bene e quanti no, e cosa sta facendo proprio adesso. Chi guarda deve
 * poter decidere se aspettare o fermare, e per decidere servono numeri.
 */

import { iconNameFor, resolveLucideIcon } from '../canvas/icon-registry';
import { findNode } from '../catalog';

import styles from './BuildingStage.module.css';
import { TraceList } from './TraceList';
import type { TraceEntry } from './types';

interface Props {
  elapsedMs: number;
  built: readonly { id: string; defId: string }[];
  trace: readonly TraceEntry[];
  /** Quanti passi al massimo può fare l'agente: dà la misura di quanto manca. */
  maxSteps: number;
  /** I token consumati finora, se il provider li dichiara. */
  tokens?: { input: number; output: number } | undefined;
  /** Il nome del provider che sta lavorando. */
  provider?: string | undefined;
  /** Ferma tutto. */
  onStop: () => void;
}

/** Il tempo trascorso, come lo direbbe una persona. */
function elapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${String(seconds)} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${String(minutes)} min ${String(rest).padStart(2, '0')} s`;
}

/** I numeri grandi si leggono meglio accorciati: 12.400 diventa 12,4k. */
function compatto(n: number): string {
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(1).replace('.', ',')}k`;
}

export function BuildingStage({
  elapsedMs,
  built,
  trace,
  maxSteps,
  tokens,
  provider,
  onStop,
}: Props) {
  const fatti = trace.length;
  const riusciti = trace.filter((t) => t.ok).length;
  const falliti = fatti - riusciti;
  // La percentuale è sui passi possibili, non su quelli fatti: dice quanto
  // margine resta prima che l'agente si arrenda, che è l'informazione utile.
  const percentuale = Math.min(100, Math.round((fatti / maxSteps) * 100));
  const ultimo = trace.at(-1);

  return (
    <div className={styles.root}>
      <div className={styles.hero}>
        <span className={styles.spinner} aria-hidden="true" />
        <div className={styles.heroText}>
          {provider && <p className={styles.provider}>{provider}</p>}
          <p className={styles.title}>{ultimo?.label ?? 'Sta preparando la richiesta…'}</p>
          {ultimo?.detail && <p className={styles.detail}>{ultimo.detail}</p>}
        </div>

        <dl className={styles.numeri}>
          <div className={styles.numero}>
            <dt>Passo</dt>
            <dd>
              {fatti}
              <span className={styles.su}>/{maxSteps}</span>
            </dd>
          </div>
          <div className={styles.numero}>
            <dt>Tempo</dt>
            <dd>{elapsed(elapsedMs)}</dd>
          </div>
          {tokens && (
            <div className={styles.numero} title="Token letti e scritti dal modello">
              <dt>Token</dt>
              <dd>
                ↓{compatto(tokens.input)} ↑{compatto(tokens.output)}
              </dd>
            </div>
          )}
        </dl>
      </div>

      <div className={styles.barraRiga}>
        <div
          className={styles.barra}
          role="progressbar"
          aria-valuenow={percentuale}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Avanzamento della costruzione"
        >
          <span className={styles.barraPiena} style={{ inlineSize: `${String(percentuale)}%` }} />
        </div>
        <span className={styles.esiti}>
          <span className={styles.ok} title="Passi riusciti">
            ✓ {riusciti}
          </span>
          <span
            className={styles.ko}
            data-ce={falliti > 0 ? 'true' : 'false'}
            title="Passi falliti"
          >
            ✕ {falliti}
          </span>
        </span>
      </div>

      <div className={styles.azioni}>
        <button type="button" className={styles.stop} onClick={onStop}>
          ✕ Interrompi
        </button>
        <span className={styles.nota}>
          Quello che ha già costruito resta: si riprende da lì, o si ricomincia.
        </span>
      </div>

      {built.length > 0 && (
        <div className={styles.built}>
          {built.map((node) => {
            const def = findNode(node.defId);
            // La stessa icona che il nodo avrà sul disegno: chi guarda deve
            // riconoscere subito quello che vedrà fra un momento sul canvas.
            const Icon = resolveLucideIcon(iconNameFor(node.defId, def?.icon));
            return (
              <span key={node.id} className={styles.node} title={node.defId}>
                {Icon && <Icon size={14} aria-hidden="true" />}
                {def?.label ?? node.defId}
              </span>
            );
          })}
        </div>
      )}

      <div className={styles.trace}>
        <TraceList entries={trace} live />
      </div>
    </div>
  );
}
