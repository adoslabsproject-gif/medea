/**
 * La cornice comune di ogni campo: etichetta, obbligatorietà, aiuto.
 *
 * Sta qui e non dentro i singoli controlli perché altrimenti venti controlli
 * disegnerebbero venti etichette leggermente diverse.
 */

import type { ReactNode } from 'react';

import type { NodeConfigField } from '../types';

import styles from './fields.module.css';

interface Props {
  field: NodeConfigField;
  children: ReactNode;
}

export function FieldShell({ field, children }: Props) {
  return (
    <div className={styles.field}>
      <span className={styles.label}>
        {field.label ?? field.key}
        {field.required && (
          <span className={styles.required} aria-label="obbligatorio">
            *
          </span>
        )}
      </span>
      {children}
      {field.description && <p className={styles.hint}>{field.description}</p>}
    </div>
  );
}
