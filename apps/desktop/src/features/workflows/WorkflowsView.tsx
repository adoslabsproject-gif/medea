/**
 * La sezione Workflow: elenco, editor, assistente, verdetto.
 *
 * Una regola sola governa la barra in fondo: **un workflow con problemi
 * critici non si può attivare**. È lo stesso criterio che impedisce all'AI di
 * consegnarlo, applicato a ciò che l'utente disegna a mano — sarebbe assurdo
 * che il canvas accettasse in silenzio quello che il generatore rifiuta.
 *
 * Lo stato del documento e la cronologia vivono in `useWorkflowEditor`: qui
 * si disegna e si collegano i pezzi.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';

import { workflowApi } from './api';
import { AssistantPanel } from './assistant';
import { BackgroundDialog } from './BackgroundDialog';
import { diagnose, globalIssues } from './canvas/diagnostics';
import { exportPng } from './canvas/export-png';
import { WorkflowCanvas } from './canvas/WorkflowCanvas';
import { findNode } from './catalog';
import { CommandPalette, type Comando } from './CommandPalette';
import { messaggioEliminazione } from './elimina-workflow';
import { FormsDialog } from './FormsDialog';
import { missingSecrets } from './missing-secrets';
import { NodesDialog } from './NodesDialog';
import { RelayDialog } from './RelayDialog';
import { RunsModal } from './runs';
import { secretNames, syncToRuntime, useRuntime } from './runtime';
import { SecretsDialog } from './SecretsDialog';
import { CollapsibleColumn } from './shared';
import { Topbar } from './topbar';
import { savedTriggerInput, TriggerInputDialog } from './TriggerInputDialog';
import type { NodeDef } from './types';
import { useWorkflowEditor } from './useWorkflowEditor';
import { useWorkflowRun } from './useWorkflowRun';
import { VersionsDialog } from './VersionsDialog';
import { TablesBanner, WizardModal } from './wizard';
import { WorkflowList } from './WorkflowList';
import { WorkflowSettingsDialog } from './WorkflowSettingsDialog';
import styles from './WorkflowsView.module.css';

/** Aperto o chiuso, la scelta resta fra una sessione e l'altra: chi lavora
 *  col pannello lo vuole trovare aperto, chi non lo usa non vuole ritrovarselo
 *  ogni volta. */
const ASSISTANT_OPEN_KEY = 'medea.workflows.assistantOpen';

export function WorkflowsView() {
  const editor = useWorkflowEditor();
  const runtime = useRuntime();
  const run = useWorkflowRun();
  /** Il workflow di cui si stanno guardando le esecuzioni. */
  /** Il workflow di cui si guardano le esecuzioni. `runtimeId` serve alla
   *  riesecuzione: si legge dal disco perché la riga dell'elenco non lo porta,
   *  e può essere un workflow diverso da quello aperto nell'editor. */
  const [runsFor, setRunsFor] = useState<{
    id: number;
    name: string;
    runtimeId?: string;
  } | null>(null);
  const [secretsOpen, setSecretsOpen] = useState(false);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [nodesOpen, setNodesOpen] = useState(false);
  const [relayOpen, setRelayOpen] = useState(false);
  const [backgroundOpen, setBackgroundOpen] = useState(false);
  const [triggerInputOpen, setTriggerInputOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [formsOpen, setFormsOpen] = useState(false);
  const [assistantOpen, setAssistantOpen] = useState(
    () => localStorage.getItem(ASSISTANT_OPEN_KEY) !== 'false',
  );
  const { workflow } = editor;

  useEffect(() => {
    localStorage.setItem(ASSISTANT_OPEN_KEY, String(assistantOpen));
  }, [assistantOpen]);

  /**
   * Elimina un workflow, ma solo dopo averlo chiesto.
   *
   * Non c'è cestino e non c'è annulla: quello che se ne va non torna. La
   * domanda nomina il workflow — «questo» in una finestra che ha coperto
   * l'elenco non dice quale — e se è attivo lo dichiara, perché eliminarlo
   * significa anche spegnere un'automazione che sta girando.
   */
  const eliminaWorkflow = useCallback(
    (id: number) => {
      const bersaglio = editor.items.find((i) => i.id === id);
      if (!window.confirm(messaggioEliminazione(bersaglio))) return;
      void editor.remove(id);
    },
    [editor],
  );

  const defsById = useMemo(() => {
    const map = new Map<string, NodeDef>();
    for (const n of workflow.nodes) {
      const def = findNode(n.defId);
      if (def) map.set(n.defId, def);
    }
    return map;
  }, [workflow.nodes]);

  const diag = useMemo(
    () => diagnose(workflow.nodes, workflow.edges, defsById),
    [workflow.nodes, workflow.edges, defsById],
  );
  const critical = diag.issues.filter((i) => i.severity === 'critical');
  const warnings = diag.issues.filter((i) => i.severity === 'medium');
  const global = globalIssues(diag.issues);
  const blockedReason =
    critical.length > 0 ? 'Non puoi attivarlo finché ci sono problemi da risolvere.' : undefined;

  // Le scorciatoie valgono su tutta la sezione, non solo sul canvas: si
  // annulla anche mentre si scrive nel pannello di destra.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey && !e.ctrlKey) return;
      const key = e.key.toLowerCase();
      if (key === 's') {
        e.preventDefault();
        void editor.save();
      } else if (key === 'z' && !e.shiftKey) {
        e.preventDefault();
        editor.undo();
      } else if (key === 'k') {
        // Cmd+K: la quarta strada per arrivare a un'azione, dopo barra, menu
        // e scorciatoia — l'unica che non chiede di ricordarsi dov'è.
        e.preventDefault();
        setPaletteOpen((v) => !v);
      } else if ((key === 'z' && e.shiftKey) || key === 'y') {
        e.preventDefault();
        editor.redo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [editor]);

  const activeId = workflow.id ? Number(workflow.id) : null;

  /**
   * Ci sono modifiche che il motore non sta ancora eseguendo?
   *
   * Vale solo per i workflow attivi: su uno spento non c'è niente in
   * esecuzione da cui la bozza possa discostarsi. `dirty` copre le modifiche
   * appena fatte; `publishedAt` assente copre quelle fatte prima e già
   * salvate.
   */
  const unpublished = editor.enabled && (editor.dirty || !workflow.publishedAt);

  /**
   * Tutto quello che si può fare, cercabile per nome.
   *
   * Sono le stesse azioni della barra e del menu: la palette non ne aggiunge,
   * toglie il bisogno di ricordarsi dove sono.
   */
  const comandi: Comando[] = [
    { id: 'salva', label: 'Salva', hint: 'Cmd+S', run: () => void editor.save() },
    {
      id: 'esegui',
      label: 'Esegui',
      hint: 'senza aspettare il trigger',
      disabled: !runtime.status.running || workflow.nodes.length === 0,
      run: () => void editor.save().then(() => run.start(workflow, savedTriggerInput(workflow.id))),
    },
    {
      id: 'esegui-con',
      label: 'Esegui con dati di prova',
      run: () => {
        setTriggerInputOpen(true);
      },
    },
    {
      id: 'pubblica',
      label: 'Pubblica',
      hint: 'manda in produzione questa versione',
      disabled: !unpublished,
      run: () => void editor.publish(),
    },
    {
      id: 'attiva',
      label: editor.enabled ? 'Disattiva' : 'Attiva',
      run: () => void editor.toggleEnabled(blockedReason),
    },
    { id: 'riordina', label: 'Riordina i nodi', run: editor.relayout },
    {
      id: 'segreti',
      label: 'Segreti',
      run: () => {
        setSecretsOpen(true);
      },
    },
    {
      id: 'form',
      label: 'Form pubblici',
      hint: 'gli indirizzi da mandare e cosa è arrivato',
      run: () => {
        setFormsOpen(true);
      },
    },
    {
      id: 'versioni',
      label: 'Versioni',
      run: () => {
        setVersionsOpen(true);
      },
    },
    {
      id: 'impostazioni',
      label: 'Impostazioni del workflow',
      hint: 'etichette, storico, emergenza',
      run: () => {
        setSettingsOpen(true);
      },
    },
    {
      id: 'nodi',
      label: 'Nodi aggiuntivi',
      run: () => {
        setNodesOpen(true);
      },
    },
    {
      id: 'raggiungibilita',
      label: 'Raggiungibilità da internet',
      run: () => {
        setRelayOpen(true);
      },
    },
    {
      id: 'png',
      label: 'Esporta come immagine',
      run: () => {
        exportPng(workflow, defsById);
      },
    },
    { id: 'json', label: 'Esporta in JSON', run: editor.exportJson },
    { id: 'importa', label: 'Importa da JSON', run: editor.importJson },
    {
      id: 'esecuzioni',
      label: 'Esecuzioni di questo workflow',
      disabled: !workflow.id,
      run: () => {
        if (workflow.id) setRunsFor({ id: Number(workflow.id), name: workflow.name });
      },
    },
  ];

  /**
   * I segreti che il workflow nomina e che non esistono.
   *
   * Senza, il workflow parte, arriva a quel nodo e fallisce con un «401» del
   * servizio esterno — che manda a cercare il problema dalla parte sbagliata.
   */
  const secretiMancanti = useMemo(
    () => missingSecrets(workflow, secretNames()),
    [workflow, secretsOpen],
  );

  return (
    <div className={styles.root}>
      <CollapsibleColumn
        storageKey="medea.workflows.listCollapsed"
        width={240}
        side="start"
        icon="⚡"
        label="Workflow"
      >
        <WorkflowList
          items={editor.items}
          activeId={activeId}
          onOpen={(id) => void editor.open(id)}
          onNew={editor.create}
          onCreateWithAi={() => {
            setWizardOpen(true);
          }}
          onDuplicate={(id) => void editor.duplicate(id)}
          onDelete={eliminaWorkflow}
          onShowRuns={(id) => {
            const found = editor.items.find((i) => i.id === id);
            const name = found?.name ?? 'Workflow';
            setRunsFor({ id, name });
            void workflowApi.get(id).then((loaded) => {
              if (loaded?.runtimeId) setRunsFor({ id, name, runtimeId: loaded.runtimeId });
            });
          }}
        />
      </CollapsibleColumn>

      <div className={styles.main}>
        <Topbar
          workflow={workflow}
          dirty={editor.dirty}
          enabled={editor.enabled}
          assistantOpen={assistantOpen}
          canUndo={editor.canUndo}
          canRedo={editor.canRedo}
          canDiscard={editor.canDiscard}
          autosaving={editor.autosaving}
          runtimeReady={runtime.status.running}
          running={run.running}
          unpublished={unpublished}
          {...(blockedReason ? { blockedReason } : {})}
          actions={{
            onRename: (name) => {
              editor.change({ ...workflow, name });
            },
            onSave: () => void editor.save(),
            onDiscard: editor.discard,
            onSecrets: () => {
              setSecretsOpen(true);
            },
            onNodes: () => {
              setNodesOpen(true);
            },
            onRelay: () => {
              setRelayOpen(true);
            },
            onBackground: () => {
              setBackgroundOpen(true);
            },
            onSettings: () => {
              setSettingsOpen(true);
            },
            onExportPng: () => {
              exportPng(workflow, defsById);
            },
            onVersions: () => {
              // Le versioni le tiene il motore, e il motore conosce il
              // workflow solo dopo che gliel'abbiamo mandato: un documento
              // mai eseguito non ne ha ancora nessuna. Si manda adesso, così
              // la prima versione è quella che si sta guardando.
              if (workflow.runtimeId) {
                setVersionsOpen(true);
                return;
              }
              void editor
                .save()
                .then(() => syncToRuntime(workflow, undefined))
                .then(() => {
                  if (workflow.id) return editor.open(Number(workflow.id));
                  return undefined;
                })
                .then(() => {
                  setVersionsOpen(true);
                })
                .catch(() => {
                  editor.setNotice(
                    'Il motore non è raggiungibile: le versioni non sono disponibili.',
                  );
                });
            },
            onStop: run.cancel,
            onRunWith: () => {
              setTriggerInputOpen(true);
            },
            onRun: () => {
              // Si salva prima: eseguire una versione diversa da quella sul
              // disco vorrebbe dire che lo storico racconta un documento che
              // non esiste.
              // Con i dati di prova già scelti, si riusano: chi mette a
              // punto un workflow lo esegue venti volte di fila.
              void editor.save().then(() => run.start(workflow, savedTriggerInput(workflow.id)));
            },
            onToggleEnabled: () => void editor.toggleEnabled(blockedReason),
            onPublish: () => void editor.publish(),
            onToggleAssistant: () => {
              setAssistantOpen((v) => !v);
            },
            onUndo: editor.undo,
            onRedo: editor.redo,
            onAutoLayout: editor.relayout,
            onImport: editor.importJson,
            onExport: editor.exportJson,
            onDuplicate: () => {
              if (activeId) void editor.duplicate(activeId);
            },
            onDelete: () => {
              if (activeId) eliminaWorkflow(activeId);
            },
          }}
        />

        {secretiMancanti.length > 0 && (
          <div className={styles.missingSecrets} role="status">
            <span>
              {secretiMancanti.length === 1
                ? 'Un segreto nominato non esiste:'
                : 'Alcuni segreti nominati non esistono:'}{' '}
              <code>{secretiMancanti.join(', ')}</code>. Il workflow fallirebbe arrivando lì.
            </span>
            <button
              type="button"
              className={styles.missingAction}
              onClick={() => {
                setSecretsOpen(true);
              }}
            >
              Definiscili
            </button>
          </div>
        )}

        {/* Le tabelle che il workflow dà per esistenti. Sta qui e non solo
            nel wizard perché il problema è dello stesso peso quando il
            workflow lo si disegna a mano. */}
        {runtime.status.running && (
          <div className={styles.tables}>
            <TablesBanner workflow={workflow} />
          </div>
        )}

        <WorkflowCanvas
          workflow={workflow}
          onChange={editor.change}
          runByNode={run.stepsByNode}
          runtimeReady={runtime.status.running}
        />

        <footer className={styles.foot} data-state={critical.length > 0 ? 'blocked' : 'ok'}>
          <div className={styles.verdict}>
            {workflow.nodes.length === 0 ? (
              <span>Workflow vuoto.</span>
            ) : critical.length > 0 ? (
              <span>
                {critical.length} {critical.length === 1 ? 'problema' : 'problemi'} da risolvere
                prima di attivarlo.
              </span>
            ) : diag.ok ? (
              <span>Tutto a posto: il workflow può essere attivato.</span>
            ) : (
              <span>Mancano dei campi obbligatori.</span>
            )}
            {warnings.length > 0 && (
              <span className={styles.warnings}>
                · {warnings.length} {warnings.length === 1 ? 'avviso' : 'avvisi'}
              </span>
            )}
          </div>

          {global.length > 0 && (
            <ul className={styles.globalIssues}>
              {global.map((i) => (
                <li key={i.code}>{i.message}</li>
              ))}
            </ul>
          )}

          {run.progress && (
            <span className={styles.runSummary} data-status={run.progress.status}>
              {run.running ? 'Esecuzione in corso' : 'Ultima esecuzione'}:{' '}
              {run.progress.steps.filter((s) => s.status === 'success').length} riusciti
              {run.progress.errorCount > 0 ? `, ${String(run.progress.errorCount)} falliti` : ''}
              {run.progress.totalDurationMs !== undefined
                ? ` · ${String(run.progress.totalDurationMs)} ms`
                : ''}
            </span>
          )}

          {run.error && <span className={styles.runError}>{run.error}</span>}

          {!runtime.status.running && !runtime.checking && (
            <span className={styles.runtimeOff} title={runtime.status.error ?? undefined}>
              Motore non disponibile
            </span>
          )}

          {editor.notice && <span className={styles.notice}>{editor.notice}</span>}
        </footer>
      </div>

      {wizardOpen && (
        <WizardModal
          onClose={() => {
            setWizardOpen(false);
          }}
          onImport={(built) => {
            // Arriva come bozza: si apre nell'editor e si salva solo quando
            // l'utente decide, come qualunque altra modifica.
            editor.load(built, false);
            setWizardOpen(false);
          }}
        />
      )}

      {versionsOpen && workflow.runtimeId && (
        <VersionsDialog
          runtimeId={workflow.runtimeId}
          workflow={workflow}
          onClose={() => {
            setVersionsOpen(false);
          }}
          onLoad={(restored) => {
            // Arriva come bozza: si guarda, e si salva solo se convince.
            editor.load(restored, editor.enabled);
          }}
        />
      )}

      {formsOpen && (
        <FormsDialog
          onClose={() => {
            setFormsOpen(false);
          }}
          onOpen={(runtimeId) => {
            // L'elenco dei form parla la lingua del motore: gli identificativi
            // sono i suoi. Il sommario porta `runtimeId` proprio per poter
            // fare questo passaggio senza riaprire ogni documento.
            const riga = editor.items.find((i) => i.runtimeId === runtimeId);
            if (!riga) return;
            void editor.open(riga.id);
            setFormsOpen(false);
          }}
        />
      )}

      {paletteOpen && (
        <CommandPalette
          comandi={comandi}
          onClose={() => {
            setPaletteOpen(false);
          }}
        />
      )}

      {settingsOpen && (
        <WorkflowSettingsDialog
          workflow={workflow}
          onChange={editor.change}
          onClose={() => {
            setSettingsOpen(false);
          }}
        />
      )}

      {triggerInputOpen && (
        <TriggerInputDialog
          workflowId={workflow.id}
          onClose={() => {
            setTriggerInputOpen(false);
          }}
          onRun={(input) => {
            void editor.save().then(() => run.start(workflow, input));
          }}
        />
      )}

      {relayOpen && (
        <RelayDialog
          onClose={() => {
            setRelayOpen(false);
          }}
        />
      )}

      {backgroundOpen && (
        <BackgroundDialog
          onClose={() => {
            setBackgroundOpen(false);
          }}
        />
      )}

      {nodesOpen && (
        <NodesDialog
          onClose={() => {
            setNodesOpen(false);
          }}
        />
      )}

      {secretsOpen && (
        <SecretsDialog
          onClose={() => {
            setSecretsOpen(false);
          }}
          onChanged={runtime.provision}
        />
      )}

      {runsFor && (
        <RunsModal
          workflowId={runsFor.id}
          workflowName={runsFor.name}
          {...(runsFor.runtimeId ? { runtimeId: runsFor.runtimeId } : {})}
          onClose={() => {
            setRunsFor(null);
          }}
        />
      )}

      {assistantOpen && (
        <CollapsibleColumn
          storageKey="medea.workflows.assistantCollapsed"
          width={368}
          side="end"
          icon="✨"
          label="Assistente"
        >
          <AssistantPanel
            workflow={workflow}
            onApply={(wf) => {
              editor.changeDistinct(wf);
              editor.setNotice('Modifica applicata: controllala prima di attivare il workflow.');
            }}
            onClose={() => {
              setAssistantOpen(false);
            }}
          />
        </CollapsibleColumn>
      )}
    </div>
  );
}
