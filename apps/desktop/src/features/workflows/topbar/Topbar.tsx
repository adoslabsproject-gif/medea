/**
 * La barra dell'editor.
 *
 * In vista sta quello che si usa a ogni sessione — nome, dove gira, annulla,
 * riordina, assistente, attiva, salva — e nel menu tutto il resto. Una barra
 * con quindici pulsanti non è più veloce di un menu: è solo più difficile da
 * leggere.
 */

import type { Workflow } from '../types';

import { MoreActionsMenu, type MenuGroup } from './MoreActionsMenu';
import styles from './Topbar.module.css';

export interface TopbarActions {
  onRename: (name: string) => void;
  onTargetChange: (target: 'local' | 'server') => void;
  onSave: () => void;
  onToggleEnabled: () => void;
  onToggleAssistant: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onAutoLayout: () => void;
  onImport: () => void;
  onExport: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}

interface Props {
  workflow: Workflow;
  dirty: boolean;
  enabled: boolean;
  assistantOpen: boolean;
  canUndo: boolean;
  canRedo: boolean;
  /** Impedisce di attivare un workflow che non funzionerebbe. */
  blockedReason?: string;
  actions: TopbarActions;
}

export function Topbar({
  workflow,
  dirty,
  enabled,
  assistantOpen,
  canUndo,
  canRedo,
  blockedReason,
  actions,
}: Props) {
  const saved = Boolean(workflow.id);

  const groups: MenuGroup[] = [
    {
      label: 'Workflow',
      items: [
        {
          label: 'Importa da JSON',
          icon: '↥',
          hint: 'Un file esportato da Medea o da FlowForge',
          onSelect: actions.onImport,
        },
        {
          label: 'Esporta in JSON',
          icon: '↧',
          hint: 'Si riapre sul server senza conversioni',
          onSelect: actions.onExport,
        },
        {
          label: 'Duplica',
          icon: '⧉',
          disabled: !saved,
          disabledReason: 'Salvalo prima di duplicarlo',
          onSelect: actions.onDuplicate,
        },
        {
          label: 'Elimina',
          icon: '✕',
          danger: true,
          disabled: !saved,
          disabledReason: 'Non è ancora stato salvato',
          onSelect: actions.onDelete,
        },
      ],
    },
    {
      label: 'Canvas',
      items: [
        {
          label: 'Riordina i nodi',
          icon: '⌗',
          hint: 'Una colonna per passo del flusso',
          onSelect: actions.onAutoLayout,
        },
      ],
    },
  ];

  return (
    <header className={styles.root}>
      <input
        className={styles.name}
        value={workflow.name}
        aria-label="Nome del workflow"
        onChange={(e) => {
          actions.onRename(e.target.value);
        }}
      />

      <select
        className={styles.target}
        aria-label="Dove viene eseguito"
        value={workflow.executionTarget ?? 'local'}
        onChange={(e) => {
          actions.onTargetChange(e.target.value as 'local' | 'server');
        }}
      >
        <option value="local">Su questo computer</option>
        <option value="server">Sul server</option>
      </select>

      <div className={styles.group}>
        <button
          type="button"
          className={styles.icon}
          title="Annulla (Cmd/Ctrl+Z)"
          aria-label="Annulla"
          disabled={!canUndo}
          onClick={actions.onUndo}
        >
          ↶
        </button>
        <button
          type="button"
          className={styles.icon}
          title="Ripeti (Cmd/Ctrl+Maiusc+Z)"
          aria-label="Ripeti"
          disabled={!canRedo}
          onClick={actions.onRedo}
        >
          ↷
        </button>
        <button
          type="button"
          className={styles.icon}
          title="Riordina i nodi"
          aria-label="Riordina i nodi"
          onClick={actions.onAutoLayout}
        >
          ⌗
        </button>
      </div>

      <button
        type="button"
        className={styles.ghost}
        data-on={assistantOpen ? 'true' : 'false'}
        title="Apre o chiude il pannello dell'assistente"
        onClick={actions.onToggleAssistant}
      >
        ✨ Assistente
      </button>

      <button
        type="button"
        className={styles.toggle}
        data-on={enabled ? 'true' : 'false'}
        title={blockedReason ?? (enabled ? 'Disattiva il workflow' : 'Attiva il workflow')}
        onClick={actions.onToggleEnabled}
      >
        {enabled ? 'Attivo' : 'Non attivo'}
      </button>

      <button
        type="button"
        className={styles.save}
        disabled={!dirty}
        title="Salva (Cmd/Ctrl+S)"
        onClick={actions.onSave}
      >
        {dirty ? 'Salva' : 'Salvato'}
      </button>

      <MoreActionsMenu groups={groups} />
    </header>
  );
}
