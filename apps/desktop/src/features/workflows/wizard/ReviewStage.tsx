/**
 * Il verdetto, prima di importare.
 *
 * Qui si dice cosa è stato costruito e cosa non torna. Il controllo di
 * qualità gira *prima* di offrire il workflow: mostrarlo e far scoprire dopo
 * che non si poteva attivare sarebbe peggio che non mostrarlo affatto.
 *
 * I problemi critici non impediscono l'importazione — impediscono
 * l'attivazione. Un workflow quasi giusto da correggere sul canvas vale più
 * di uno buttato via.
 */

import type { QualityIssue } from '../quality';
import type { Workflow } from '../types';

import styles from './ReviewStage.module.css';
import { TablesBanner } from './TablesBanner';
import { TraceList } from './TraceList';
import type { TraceEntry } from './types';

interface Props {
  workflow: Workflow;
  issues: readonly QualityIssue[];
  warnings: readonly string[];
  trace: readonly TraceEntry[];
  onImport: () => void;
  onRetry: () => void;
}

export function ReviewStage({ workflow, issues, warnings, trace, onImport, onRetry }: Props) {
  const critical = issues.filter((i) => i.severity === 'critical');
  const minor = issues.filter((i) => i.severity !== 'critical');

  return (
    <div className={styles.root}>
      <div className={styles.summary}>
        <div className={styles.counts}>
          <strong>{String(workflow.nodes.length)}</strong> nodi ·{' '}
          <strong>{String(workflow.edges.length)}</strong> collegamenti
        </div>
        <p className={styles.name}>{workflow.name}</p>
        {workflow.description && <p className={styles.description}>{workflow.description}</p>}
      </div>

      <TablesBanner workflow={workflow} />

      {critical.length > 0 && (
        <section className={`${styles.block} ${styles.critical}`}>
          <h3 className={styles.blockTitle}>Da sistemare prima di attivarlo</h3>
          <ul className={styles.issues}>
            {critical.map((issue, i) => (
              <li key={`${issue.code}-${String(i)}`}>
                {issue.nodeId && <code className={styles.where}>{issue.nodeId}</code>}
                {issue.message}
              </li>
            ))}
          </ul>
        </section>
      )}

      {(minor.length > 0 || warnings.length > 0) && (
        <section className={`${styles.block} ${styles.warning}`}>
          <h3 className={styles.blockTitle}>Merita un'occhiata</h3>
          <ul className={styles.issues}>
            {minor.map((issue, i) => (
              <li key={`${issue.code}-${String(i)}`}>
                {issue.nodeId && <code className={styles.where}>{issue.nodeId}</code>}
                {issue.message}
              </li>
            ))}
            {warnings.map((text, i) => (
              <li key={`w-${String(i)}`}>{text}</li>
            ))}
          </ul>
        </section>
      )}

      {critical.length === 0 && minor.length === 0 && warnings.length === 0 && (
        <p className={styles.clean}>Nessun problema rilevato: si può attivare così com'è.</p>
      )}

      <details className={styles.details}>
        <summary className={styles.summaryToggle}>
          Come ci è arrivato ({String(trace.length)} passi)
        </summary>
        <div className={styles.trace}>
          <TraceList entries={trace} live={false} />
        </div>
      </details>

      <div className={styles.actions}>
        <button type="button" className={styles.secondary} onClick={onRetry}>
          Riprova con altre parole
        </button>
        <button type="button" className={styles.primary} onClick={onImport}>
          Apri nell'editor
        </button>
      </div>
    </div>
  );
}
