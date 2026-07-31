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
  onSave: () => void;
  onDiscard: () => void;
  onRun: () => void;
  onSecrets: () => void;
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
  canDiscard: boolean;
  /** Vero mentre il salvataggio automatico sta scrivendo. */
  autosaving: boolean;
  /** Vero quando il motore di esecuzione è pronto. */
  runtimeReady: boolean;
  /** Vero mentre un'esecuzione è in corso. */
  running: boolean;
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
  canDiscard,
  autosaving,
  runtimeReady,
  running,
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
      label: 'Credenziali',
      items: [
        {
          label: 'Segreti',
          icon: '🔑',
          hint: 'API key e password, nel portachiavi del sistema',
          onSelect: actions.onSecrets,
        },
      ],
    },
    {
      label: 'Modifiche',
      items: [
        {
          label: 'Scarta le modifiche',
          icon: '↺',
          hint: 'Torna a com’era all’apertura, o all’ultimo Salva',
          danger: true,
          disabled: !canDiscard,
          disabledReason: 'Non ci sono modifiche da scartare',
          onSelect: actions.onDiscard,
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

      {/* Eseguire adesso e' come si prova un workflow: non si aspetta che
          scatti un trigger per sapere se funziona. */}
      <button
        type="button"
        className={styles.run}
        disabled={!runtimeReady || running || workflow.nodes.length === 0}
        title={
          !runtimeReady
            ? 'Il motore di esecuzione non è ancora pronto'
            : (blockedReason ?? 'Esegui adesso, senza aspettare il trigger')
        }
        onClick={actions.onRun}
      >
        {running ? '⟳ In corso…' : '▶ Esegui'}
      </button>

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

      {/* Il salvataggio è automatico: il pulsante serve a fissare il punto a
          cui torna «Scarta», e a dire che il lavoro è al sicuro. */}
      <button
        type="button"
        className={styles.save}
        disabled={!dirty}
        title="Salva ora e fissa il punto di ritorno (Cmd/Ctrl+S)"
        onClick={actions.onSave}
      >
        {autosaving ? 'Salvo…' : dirty ? 'Salva' : 'Salvato'}
      </button>

      <MoreActionsMenu groups={groups} />
    </header>
  );
}
