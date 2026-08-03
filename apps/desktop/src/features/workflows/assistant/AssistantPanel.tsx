/**
 * Il pannello dell'assistente: una colonna accanto al canvas.
 *
 * Non è un modale. La differenza conta: con un modale si chiede una cosa
 * sola e si chiude, con un pannello si conversa — «adesso aggiungi il
 * controllo», «no, sposta l'email dopo» — guardando il canvas cambiare
 * accanto. È il modo in cui si costruisce davvero un workflow.
 *
 * Il provider è quello scelto in Impostazioni: Liara, Claude, GPT o un
 * modello locale. L'agente è lo stesso, cambia solo chi risponde.
 */

import { activeProvider } from '../../ai/connection';
import { providerLabel } from '../../ai/types';
import type { Workflow } from '../types';

import styles from './AssistantPanel.module.css';
import { Composer } from './Composer';
import { ConversationMenu } from './ConversationMenu';
import { MessageList } from './MessageList';
import { useWorkflowChat } from './useWorkflowChat';

interface Props {
  workflow: Workflow;
  onApply: (wf: Workflow) => void;
  onClose: () => void;
}

const SUGGERIMENTI = [
  'Ogni mattina alle 8 scarica gli ordini e mandami il riepilogo',
  'Quando arriva una PEC salvala nel database e avvisami',
  'Ogni lunedì controlla i link rotti del sito e scrivi un report',
];

export function AssistantPanel({ workflow, onApply, onClose }: Props) {
  const chat = useWorkflowChat({ workflow });
  const provider = activeProvider();
  const isEmpty = workflow.nodes.length === 0;

  return (
    <aside className={styles.root} aria-label="Assistente workflow">
      <header className={styles.head}>
        <div className={styles.titleGroup}>
          <span className={styles.title}>Assistente</span>
          <span className={styles.provider}>{providerLabel(provider)}</span>
        </div>
        <div className={styles.headActions}>
          <ConversationMenu
            conversations={chat.conversations}
            activeId={chat.activeId}
            onOpen={chat.open}
            onRemove={chat.remove}
          />
          {chat.messages.length > 0 && (
            <button
              type="button"
              className={styles.iconBtn}
              title="Nuova conversazione"
              aria-label="Nuova conversazione"
              onClick={chat.startNew}
            >
              ⟲
            </button>
          )}
          <button
            type="button"
            className={styles.iconBtn}
            title="Chiudi"
            aria-label="Chiudi il pannello"
            onClick={onClose}
          >
            ✕
          </button>
        </div>
      </header>

      <MessageList
        messages={chat.messages}
        busy={chat.busy}
        liveSteps={chat.liveSteps}
        onApply={(id) => {
          const next = chat.applyPatch(id);
          if (next) onApply(next);
        }}
        onDismiss={chat.dismissPatch}
        onEdit={(id, text) => {
          void chat.editAndResend(id, text);
        }}
      />

      {chat.busy && (
        <div className={styles.inCorso}>
          <button
            type="button"
            className={styles.stop}
            onClick={chat.stop}
            title="Ferma la risposta in corso"
          >
            ✕ Interrompi
          </button>
          <span className={styles.conto}>
            {chat.liveSteps.length > 0 && `${String(chat.liveSteps.length)} passi`}
            {chat.tokens && ` · ↓${String(chat.tokens.input)} ↑${String(chat.tokens.output)} token`}
          </span>
        </div>
      )}

      <Composer
        busy={chat.busy}
        placeholder={
          isEmpty ? 'Descrivi cosa deve fare…' : 'Chiedi una modifica al workflow aperto…'
        }
        {...(isEmpty && chat.messages.length === 0 ? { suggestions: SUGGERIMENTI } : {})}
        onSend={(text) => {
          void chat.send(text);
        }}
      />
    </aside>
  );
}
