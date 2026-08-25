/**
 * La conversazione: cosa succede quando l'utente scrive.
 *
 * Prima si capisce **cosa vuole**: rispondere o costruire. Senza quel
 * passaggio ogni messaggio diventerebbe un tentativo di costruire un
 * workflow, «ciao» compreso.
 *
 * Quando è una richiesta di modifica, l'agente lavora sul workflow
 * **corrente**, quindi la seconda richiesta parte da dove ha lasciato la
 * prima: «aggiungi un controllo» funziona perché vede quello che ha già
 * costruito.
 *
 * Niente viene applicato da solo. L'agente produce un workflow, qui se ne
 * calcola il diff, e il canvas cambia solo quando l'utente lo accetta.
 *
 * La conversazione si conserva per workflow, e si può correggere: modificare
 * una richiesta già inviata taglia tutto quello che veniva dopo e riparte da
 * lì. È un fork — la strada vecchia non serve più, quella nuova parte dallo
 * stesso punto.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

import { useConferma } from '../../shared/conferma';
import { autoLayout, needsLayout } from '../canvas/layout';
import { allNodes } from '../catalog';
import { createAgentChat, runWorkflowAgent, type AgentStep } from '../scaffold';
import type { Workflow } from '../types';

import {
  loadConversations,
  newConversationId,
  saveConversations,
  titleFrom,
  type Conversation,
} from './conversations';
import { computePatch } from './diff';
import { classify } from './intent';
import { isEmptyPatch, type ChatMessage } from './types';

let counter = 0;
function nextId(): string {
  counter += 1;
  return `m${String(counter)}`;
}

interface Options {
  /** Il workflow su cui l'assistente lavora, sempre aggiornato. */
  workflow: Workflow;
}

export interface WorkflowChat {
  messages: ChatMessage[];
  conversations: Conversation[];
  activeId: string | null;
  busy: boolean;
  /** I passi dell'agente nel giro in corso, per mostrarli mentre lavora. */
  liveSteps: AgentStep[];
  /** Ferma il giro in corso: sul serio, non solo smettendo di guardare. */
  stop: () => void;
  /** I token consumati nel giro in corso, se il provider li dichiara. */
  tokens?: { input: number; output: number } | undefined;
  send: (text: string) => Promise<void>;
  /** Corregge una richiesta già inviata e rilancia da lì. */
  editAndResend: (messageId: string, text: string) => Promise<void>;
  applyPatch: (messageId: string) => Workflow | null;
  dismissPatch: (messageId: string) => void;
  startNew: () => void;
  open: (conversationId: string) => void;
  remove: (conversationId: string) => void;
  /**
   * La finestra con cui l'assistente chiede il permesso di modificare.
   *
   * Va resa dal pannello: senza, gli strumenti che scrivono non trovano a chi
   * chiedere e si rifiutano di agire — che è il comportamento voluto, ma qui
   * significherebbe un assistente che non può fare niente.
   */
  dialogoConferma: ReactNode;
}

export function useWorkflowChat({ workflow }: Options): WorkflowChat {
  // `window.confirm` nel webview di Tauri non mostra niente e risponde sempre
  // di no: la domanda la fa l'applicazione.
  const { chiedi, dialogo: dialogoConferma } = useConferma();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const [liveSteps, setLiveSteps] = useState<AgentStep[]>([]);
  const [tokens, setTokens] = useState<{ input: number; output: number } | undefined>(undefined);
  /** Con cosa si ferma il giro in corso. */
  const controllore = useRef<AbortController | null>(null);

  // Il workflow cambia mentre l'agente lavora (l'utente può spostare un nodo):
  // serve il valore al momento dell'invio.
  const latest = useRef(workflow);
  latest.current = workflow;
  const workflowId = workflow.id;

  // Aprendo un altro workflow si cambia scaffale: le conversazioni sono sue.
  useEffect(() => {
    const stored = loadConversations(workflowId);
    setConversations(stored);
    setActiveId(stored[0]?.id ?? null);
    setMessages(stored[0]?.messages ?? []);
  }, [workflowId]);

  /** Scrive la conversazione corrente nello scaffale del workflow. */
  const persist = useCallback(
    (next: ChatMessage[]) => {
      if (next.length === 0) return;
      setConversations((prev) => {
        const id = activeId ?? newConversationId();
        if (!activeId) setActiveId(id);
        const entry: Conversation = {
          id,
          title: titleFrom(next),
          messages: next,
          updatedAt: Date.now(),
        };
        const others = prev.filter((c) => c.id !== id);
        const updated = [entry, ...others];
        saveConversations(workflowId, updated);
        return updated;
      });
    },
    [activeId, workflowId],
  );

  /** Il giro dell'agente su una storia già decisa dal chiamante. */
  const run = useCallback(
    async (goal: string, history: ChatMessage[]) => {
      const base = latest.current;
      setMessages(history);
      setBusy(true);
      setLiveSteps([]);

      const reply = (patch: Partial<ChatMessage>) => {
        const next = [
          ...history,
          { id: nextId(), role: 'assistant' as const, text: '', at: Date.now(), ...patch },
        ];
        setMessages(next);
        persist(next);
      };

      try {
        // Prima si capisce cosa vuole: senza questo passaggio un saluto
        // diventa un tentativo di costruzione che brucia quaranta passi.
        const intent = await classify(
          goal,
          base,
          history.slice(0, -1).map((m) => ({ role: m.role, text: m.text })),
        );
        if (intent.kind === 'reply') {
          reply({ text: intent.text });
          return;
        }

        const controller = new AbortController();
        controllore.current = controller;
        setTokens(undefined);
        // Il conto si somma sul giro: interessa quanto è costata la risposta,
        // non l'ultima delle chiamate che l'hanno prodotta.
        const chat = await createAgentChat((usati) => {
          setTokens((prima) => ({
            input: (prima?.input ?? 0) + usati.input,
            output: (prima?.output ?? 0) + usati.output,
          }));
        });
        const result = await runWorkflowAgent({
          signal: controller.signal,
          goal: intent.goal,
          catalog: [...allNodes()],
          chat,
          ...(base.nodes.length > 0 ? { seed: base } : {}),
          onStep: (step) => {
            setLiveSteps((prev) => [...prev, step]);
          },
          // Il permesso di modificare l'archivio lo dà una persona, sempre.
          // Il tasto è rosso e il testo dice cosa succede: «Crea la tabella
          // ordini» si valuta, «Procedi» no.
          chiediConferma: async (richiesta) =>
            (await chiedi({ ...richiesta, conferma: 'Procedi', pericoloso: true })).ok,
        });

        if (!result.ok) {
          reply({ text: 'Non sono riuscito a completare la modifica.', error: result.reason });
          return;
        }

        // Un workflow generato da zero arriva senza coordinate sensate: il
        // disegno lo facciamo noi. Uno modificato conserva le sue.
        const produced: Workflow = {
          ...result.workflow,
          ...(base.id ? { id: base.id } : {}),
          nodes: needsLayout(result.workflow.nodes)
            ? autoLayout(result.workflow.nodes, result.workflow.edges)
            : result.workflow.nodes,
        };

        const patch = computePatch(base, produced);
        if (isEmptyPatch(patch)) {
          reply({
            text: 'Il workflow è già come chiedi: non ho trovato niente da cambiare.',
            steps: result.steps,
          });
          return;
        }

        reply({
          text:
            result.remainingIssues.length > 0
              ? `Ecco la modifica. Restano da sistemare: ${result.remainingIssues.join(' ')}`
              : 'Ecco la modifica proposta.',
          steps: result.steps,
          patch,
        });
      } catch (e) {
        reply({
          text: 'Non sono riuscito a parlare con il modello.',
          error: e instanceof Error ? e.message : String(e),
        });
      } finally {
        setBusy(false);
        setLiveSteps([]);
      }
    },
    [persist],
  );

  const send = useCallback(
    async (text: string) => {
      const goal = text.trim();
      if (!goal) return;
      const asked: ChatMessage = { id: nextId(), role: 'user', text: goal, at: Date.now() };
      await run(goal, [...messages, asked]);
    },
    [messages, run],
  );

  /**
   * Correggere una richiesta significa ripartire da lì: quello che veniva
   * dopo rispondeva a una domanda che non è più stata fatta.
   */
  const editAndResend = useCallback(
    async (messageId: string, text: string) => {
      const goal = text.trim();
      if (!goal) return;
      const index = messages.findIndex((m) => m.id === messageId);
      if (index < 0) return;
      const history = [
        ...messages.slice(0, index),
        { ...messages[index], id: nextId(), text: goal, at: Date.now() } as ChatMessage,
      ];
      await run(goal, history);
    },
    [messages, run],
  );

  const applyPatch = useCallback(
    (messageId: string): Workflow | null => {
      const target = messages.find((m) => m.id === messageId);
      if (!target?.patch) return null;
      const next = messages.map((m) => (m.id === messageId ? { ...m, applied: true } : m));
      setMessages(next);
      persist(next);
      return target.patch.next;
    },
    [messages, persist],
  );

  const dismissPatch = useCallback(
    (messageId: string) => {
      const next = messages.map((m) => {
        if (m.id !== messageId) return m;
        const { patch: _discarded, ...rest } = m;
        return rest;
      });
      setMessages(next);
      persist(next);
    },
    [messages, persist],
  );

  const startNew = useCallback(() => {
    setActiveId(null);
    setMessages([]);
  }, []);

  const open = useCallback(
    (conversationId: string) => {
      const found = conversations.find((c) => c.id === conversationId);
      if (!found) return;
      setActiveId(found.id);
      setMessages(found.messages);
    },
    [conversations],
  );

  const remove = useCallback(
    (conversationId: string) => {
      setConversations((prev) => {
        const updated = prev.filter((c) => c.id !== conversationId);
        saveConversations(workflowId, updated);
        return updated;
      });
      if (activeId === conversationId) startNew();
    },
    [activeId, workflowId, startNew],
  );

  /** Ferma il giro. La chiamata in volo viene fatta cadere dal lato Rust, e
   *  il ciclo se ne accorge prima del passo successivo. */
  const stop = useCallback(() => {
    controllore.current?.abort();
    controllore.current = null;
  }, []);

  return {
    messages,
    conversations,
    activeId,
    busy,
    liveSteps,
    stop,
    tokens,
    send,
    editAndResend,
    applyPatch,
    dismissPatch,
    startNew,
    open,
    remove,
    dialogoConferma,
  };
}
