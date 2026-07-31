/**
 * Il nodo sul canvas, portato dall'editor di FlowForge.
 *
 * Aspetto identico all'originale: scheda 140×120 con gradiente per categoria,
 * icona Lucide grande al centro che dice COSA fa il nodo, e in basso a destra
 * un secondo distintivo — il logo del servizio quando c'è (Telegram, Slack,
 * Stripe…), altrimenti l'icona della categoria. Doppia icona: funzione e
 * provenienza, lo stesso schema di n8n e Linear.
 *
 * La differenza rispetto all'originale è solo nel modo di scrivere lo stile:
 * là Tailwind, qui i CSS module e i token del design system. I registri delle
 * icone (`icon-registry`, `brand-icons`) sono invece copiati tali e quali, così
 * un nodo ha la stessa icona in Medea e sul server.
 */

import { Handle, Position, type NodeProps } from '@xyflow/react';
import { memo } from 'react';

import type { NodeDef } from '../types';

import { brandIconFor } from './brand-icons';
import { iconNameFor, resolveLucideIcon } from './icon-registry';
import styles from './WorkflowNode.module.css';

export interface WorkflowNodeData extends Record<string, unknown> {
  def?: NodeDef;
  defId: string;
  label?: string;
  /** Campi obbligatori ancora vuoti: il distintivo di avviso. */
  missing: number;
  /** Problemi del quality gate riferiti a questo nodo. */
  issues: number;
  missingLabels?: string[];
}

/** Il distintivo piccolo dice di che TIPO è il nodo. Icone diverse da quelle
 *  grandi apposta: grande e piccola non devono confondersi. */
const CATEGORY_BADGE_ICON: Record<string, string> = {
  trigger: 'Zap',
  action: 'MousePointerClick',
  logic: 'GitBranchPlus',
  ai: 'Sparkles',
  data: 'Database',
  communication: 'MessageCircle',
};

/** Il ripiego quando nessuna icona Lucide corrisponde. */
const TYPE_FALLBACK: Record<string, string> = {
  trigger: '⚡',
  action: '▶',
  logic: '◆',
  ai: '✨',
};

/** Un nome leggibile ricavato dal defId, per i nodi non installati. */
function humanize(defId: string): string {
  const stripped = defId.replace(/^(trigger|action|logic|ai|db|italia|action_send_)_+/iu, '');
  return stripped.replace(/_/gu, ' ').replace(/\b\w/gu, (c) => c.toUpperCase()) || defId;
}

function WorkflowNodeImpl({ data, selected }: NodeProps) {
  const d = data as WorkflowNodeData;
  const def = d.def;
  const typeKey = def?.type ?? 'action';
  const isUnknown = !def;
  const label = d.label ?? def?.label ?? humanize(d.defId);
  const ports = def?.outputPorts ?? [];
  const branching = ports.length > 0;

  const LucideIcon = resolveLucideIcon(iconNameFor(d.defId, def?.icon));
  const brand = brandIconFor(d.defId);
  const CategoryIcon = resolveLucideIcon(CATEGORY_BADGE_ICON[typeKey] ?? 'Hash');

  return (
    <div
      className={`${styles.card} ${selected ? styles.selected : ''} ${isUnknown ? styles.unknown : ''}`}
      data-type={typeKey}
      title={def?.description ?? d.defId}
    >
      {/* Entrata a sinistra e in alto, uscita a destra e in basso: ogni lato
          ha un significato solo, come nell'originale. */}
      <Handle
        type="target"
        position={Position.Left}
        id="t-left"
        className={`${styles.handle} ${styles.handleIn}`}
        title="Ingresso — rilascia qui per collegare"
      />
      <Handle
        type="target"
        position={Position.Top}
        id="t-top"
        className={`${styles.handle} ${styles.handleIn}`}
        title="Ingresso — rilascia qui per collegare"
      />
      {!branching && (
        <Handle
          type="source"
          position={Position.Bottom}
          id="s-bottom"
          className={`${styles.handle} ${styles.handleOut}`}
          title="Uscita — trascina da qui per collegare"
        />
      )}

      {/* Le strisce sul perimetro dicono da che lato si entra e da quale si
          esce, anche senza passarci sopra col mouse. */}
      <div className={styles.perimeter} aria-hidden="true">
        <span className={styles.edgeLeft} />
        <span className={styles.edgeTop} />
        <span className={styles.edgeRight} />
        <span className={styles.edgeBottom} />
      </div>

      <div className={styles.iconBox} aria-hidden="true">
        {LucideIcon ? (
          <LucideIcon size={26} strokeWidth={2} />
        ) : (
          <span className={styles.iconFallback}>{TYPE_FALLBACK[typeKey] ?? '▶'}</span>
        )}

        {brand ? (
          <span
            className={styles.brandBadge}
            style={{ backgroundColor: brand.bg, color: 'var(--color-accent-on)' }}
            title={brand.label}
          >
            <svg viewBox="0 0 24 24" width={12} height={12} fill="currentColor">
              <path d={brand.svg} />
            </svg>
          </span>
        ) : (
          <span className={styles.categoryBadge} title={`Categoria: ${typeKey}`}>
            {CategoryIcon ? (
              <CategoryIcon size={11} strokeWidth={2.5} />
            ) : (
              <span className={styles.iconFallback}>{TYPE_FALLBACK[typeKey] ?? '▶'}</span>
            )}
          </span>
        )}
      </div>

      <div className={styles.label}>{label}</div>

      {branching ? (
        ports.map((port, idx) => (
          <span
            key={port}
            className={styles.portSlot}
            style={{ top: `${String(((idx + 1) / (ports.length + 1)) * 100)}%` }}
          >
            <Handle
              type="source"
              id={port}
              position={Position.Right}
              className={`${styles.handle} ${styles.portHandle}`}
              data-port={port}
            />
            <span className={styles.portLabel} data-port={port}>
              {port}
            </span>
          </span>
        ))
      ) : (
        <Handle
          type="source"
          id="s-right"
          position={Position.Right}
          className={`${styles.handle} ${styles.handleOut}`}
          title="Uscita — trascina da qui per collegare"
        />
      )}

      {isUnknown && (
        <span className={styles.badgeError} title={`Nodo non installato: ${d.defId}`}>
          !
        </span>
      )}

      {!isUnknown && d.missing > 0 && (
        <span
          className={styles.badgeWarning}
          title={
            d.missingLabels && d.missingLabels.length > 0
              ? `Da configurare: ${d.missingLabels.join(', ')}`
              : `${String(d.missing)} campi obbligatori da compilare`
          }
          aria-label={`Mancano ${String(d.missing)} campi obbligatori`}
        >
          ⚠
        </span>
      )}

      <span className={styles.gear} aria-hidden="true">
        ⚙
      </span>
    </div>
  );
}

export const WorkflowNode = memo(WorkflowNodeImpl);
