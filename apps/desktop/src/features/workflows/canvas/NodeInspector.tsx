/**
 * Il pannello del nodo selezionato: configurazione, ingressi, uscite.
 *
 * Tre schede come nell'editor originale. «Configurazione» è quella che si usa
 * sempre; «Ingressi» e «Uscite» rispondono alla domanda che viene subito dopo
 * — da dove arrivano i dati e in che forma escono — senza la quale scrivere
 * un'espressione `{{$node.x.json.campo}}` è un tiro a indovinare.
 *
 * I campi non sono scritti a mano: nascono dalla definizione del nodo, e il
 * tipo dichiarato decide il controllo. Vedi `fields/ConfigFieldRenderer`.
 */

import { useState } from 'react';

import { ConfigFieldRenderer, outputPrefix, upstreamSources } from '../fields';
import type { CanvasNode, NodeDef, WorkflowEdge } from '../types';

import { ErrorHandling } from './ErrorHandling';
import { fieldsFor, hasActions } from './node-actions';
import { NodeActionPicker } from './NodeActionPicker';
import styles from './NodeInspector.module.css';
import { NodeTestPanel } from './NodeTestPanel';
import { PinPanel } from './PinPanel';
import { WebhookAddress } from './WebhookAddress';
import { WebhookTester } from './WebhookTester';

type Tab = 'config' | 'in' | 'out' | 'test';

interface Props {
  node: CanvasNode;
  def: NodeDef | undefined;
  issues: string[];
  /** Il grafo intero: serve per dire chi entra e chi esce da questo nodo. */
  nodes: readonly CanvasNode[];
  edges: readonly WorkflowEdge[];
  defsById: ReadonlyMap<string, NodeDef>;
  onChange: (config: Record<string, unknown>) => void;
  onRename: (label: string) => void;
  /** Cambia una proprietà del nodo che non sta nella configurazione —
   *  `continueOnFail` vive sul nodo, non fra i suoi campi. */
  onNodeChange: (patch: Partial<CanvasNode>) => void;
  onDelete: () => void;
  /** Vero quando il motore è in piedi: senza, la prova non è possibile. */
  runtimeReady: boolean;
  /** Come il motore conosce questo workflow: serve all'indirizzo del webhook. */
  runtimeId?: string;
  /** Cosa ha prodotto ogni nodo nell'ultima esecuzione. */
  lastOutputs?: ReadonlyMap<string, unknown>;
}

export function NodeInspector({
  node,
  def,
  issues,
  nodes,
  edges,
  defsById,
  onChange,
  onRename,
  onNodeChange,
  onDelete,
  runtimeReady,
  runtimeId,
  lastOutputs,
}: Props) {
  const [tab, setTab] = useState<Tab>('config');
  // I campi dipendono da cosa fa il nodo: quelli di comunità ne hanno un
  // gruppo condiviso e uno per ogni operazione che dichiarano.
  const fields = fieldsFor(def, node.config);

  const upstream = edges.filter((e) => e.to === node.id);
  const sources = upstreamSources(node.id, nodes, edges, defsById, lastOutputs);
  const downstream = edges.filter((e) => e.from === node.id);

  return (
    <aside className={styles.root} aria-label="Configurazione del nodo">
      <header className={styles.head}>
        <input
          className={styles.name}
          value={node.label ?? def?.label ?? node.defId}
          aria-label="Nome del nodo"
          onChange={(e) => {
            onRename(e.target.value);
          }}
        />
        <code className={styles.defId}>{node.defId}</code>
      </header>

      <div className={styles.tabs} role="tablist">
        <TabButton id="config" active={tab} onSelect={setTab} label="Configurazione" />
        <TabButton id="in" active={tab} onSelect={setTab} label={`Ingressi (${upstream.length})`} />
        <TabButton
          id="out"
          active={tab}
          onSelect={setTab}
          label={`Uscite (${downstream.length})`}
        />
        <TabButton id="test" active={tab} onSelect={setTab} label="Prova" />
      </div>

      {issues.length > 0 && tab === 'config' && (
        <div className={styles.issues} role="status">
          <h4 className={styles.issuesTitle}>Da sistemare</h4>
          <ul>
            {issues.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        </div>
      )}

      <div className={styles.body}>
        {tab === 'config' && (
          <>
            {def?.description && <p className={styles.description}>{def.description}</p>}
            {node.defId === 'trigger_webhook' && <WebhookAddress runtimeId={runtimeId} />}
            {def && hasActions(def) && (
              <NodeActionPicker def={def} config={node.config} onChange={onChange} />
            )}
            {fields.length === 0 ? (
              <p className={styles.none}>Questo nodo non ha impostazioni.</p>
            ) : (
              fields.map((field) => (
                <ConfigFieldRenderer
                  key={field.key}
                  field={field}
                  value={node.config[field.key]}
                  allValues={node.config}
                  sources={sources}
                  onChange={(next) => {
                    onChange({ ...node.config, [field.key]: next });
                  }}
                />
              ))
            )}

            {/* In fondo, dopo la configurazione: si decide cosa fare quando
                fallisce solo dopo aver stabilito cosa deve fare. I trigger
                non lo hanno — non c'è un «dopo» a cui passare l'errore. */}
            {def?.type !== 'trigger' && (
              <ErrorHandling
                node={node}
                def={def}
                onNodeChange={onNodeChange}
                onConfigChange={onChange}
              />
            )}
          </>
        )}

        {tab === 'test' && (
          <>
            <NodeTestPanel node={node} nodes={nodes} edges={edges} ready={runtimeReady} />
            <PinPanel
              nodeId={node.id}
              runtimeId={runtimeId}
              {...(lastOutputs?.has(node.id) ? { lastOutput: lastOutputs.get(node.id) } : {})}
            />
            {node.defId === 'trigger_webhook' && (
              <WebhookTester runtimeId={runtimeId} config={node.config} />
            )}
          </>
        )}

        {tab === 'in' && (
          <ConnectionList
            empty="Nessun nodo a monte: questo è un punto di partenza."
            entries={upstream.map((e) => ({
              id: e.from,
              def: defsById.get(nodes.find((n) => n.id === e.from)?.defId ?? ''),
              ...(e.fromPort ? { port: e.fromPort } : {}),
            }))}
            expressionFor={(id) => `{{$node.${id}.json.campo}}`}
          />
        )}

        {tab === 'out' && (
          <>
            {/* Quello che il nodo produce, con l'espressione per leggerlo: è
                la domanda che ci si fa scrivendo la configurazione del nodo
                dopo, e senza questa lista si tira a indovinare. */}
            {def?.outputFields && def.outputFields.length > 0 && (
              <section className={styles.outputs}>
                <h4 className={styles.outputsTitle}>
                  Campi prodotti <span className={styles.count}>{def.outputFields.length}</span>
                </h4>
                <ul className={styles.fieldList}>
                  {def.outputFields.map((field) => (
                    <li key={field} className={styles.fieldRow}>
                      <span className={styles.fieldName}>{field}</span>
                      <code className={styles.expression}>
                        {`{{${outputPrefix(node.id, def)}.${field}}}`}
                      </code>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <ConnectionList
              empty="Nessun nodo a valle: il flusso finisce qui."
              entries={downstream.map((e) => ({
                id: e.to,
                def: defsById.get(nodes.find((n) => n.id === e.to)?.defId ?? ''),
                ...(e.fromPort ? { port: e.fromPort } : {}),
              }))}
            />
          </>
        )}
      </div>

      <footer className={styles.foot}>
        <button type="button" className={styles.delete} onClick={onDelete}>
          Elimina nodo
        </button>
      </footer>
    </aside>
  );
}

function TabButton({
  id,
  active,
  onSelect,
  label,
}: {
  id: Tab;
  active: Tab;
  onSelect: (t: Tab) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active === id}
      className={styles.tab}
      data-on={active === id ? 'true' : 'false'}
      onClick={() => {
        onSelect(id);
      }}
    >
      {label}
    </button>
  );
}

interface Entry {
  id: string;
  def: NodeDef | undefined;
  port?: string;
}

function ConnectionList({
  entries,
  empty,
  expressionFor,
}: {
  entries: Entry[];
  empty: string;
  expressionFor?: (id: string) => string;
}) {
  if (entries.length === 0) return <p className={styles.none}>{empty}</p>;
  return (
    <ul className={styles.connections}>
      {entries.map((e) => (
        <li key={`${e.id}-${e.port ?? ''}`} className={styles.connection}>
          <span className={styles.connectionName}>{e.def?.label ?? e.id}</span>
          <code className={styles.connectionId}>{e.id}</code>
          {e.port && <span className={styles.connectionPort}>ramo «{e.port}»</span>}
          {expressionFor && <code className={styles.expression}>{expressionFor(e.id)}</code>}
        </li>
      ))}
    </ul>
  );
}
