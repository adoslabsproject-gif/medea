/**
 * La casella da cui si scrive all'assistente.
 *
 * Invio manda, Maiusc+Invio va a capo: la convenzione di ogni chat. Il campo
 * cresce con il testo fino a un tetto, perché una richiesta articolata non
 * deve stare in una riga sola.
 */

import { useRef, useState, type KeyboardEvent } from 'react';

import styles from './Composer.module.css';

interface Props {
  busy: boolean;
  placeholder: string;
  suggestions?: string[];
  onSend: (text: string) => void;
}

const MAX_ROWS = 8;

export function Composer({ busy, placeholder, suggestions, onSend }: Props) {
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);

  const send = () => {
    const value = text.trim();
    if (!value || busy) return;
    onSend(value);
    setText('');
    if (ref.current) ref.current.style.height = 'auto';
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  const grow = (el: HTMLTextAreaElement) => {
    el.style.height = 'auto';
    const lineHeight = 20;
    el.style.height = `${String(Math.min(el.scrollHeight, MAX_ROWS * lineHeight))}px`;
  };

  return (
    <div className={styles.root}>
      {suggestions && suggestions.length > 0 && text === '' && !busy && (
        <div className={styles.suggestions}>
          {suggestions.map((s) => (
            <button
              key={s}
              type="button"
              className={styles.suggestion}
              onClick={() => {
                onSend(s);
              }}
            >
              {s}
            </button>
          ))}
        </div>
      )}

      <div className={styles.inputRow}>
        <textarea
          ref={ref}
          className={styles.input}
          rows={1}
          placeholder={placeholder}
          value={text}
          disabled={busy}
          onChange={(e) => {
            setText(e.target.value);
            grow(e.target);
          }}
          onKeyDown={onKeyDown}
        />
        <button
          type="button"
          className={styles.send}
          disabled={busy || text.trim() === ''}
          aria-label="Invia"
          onClick={send}
        >
          ↑
        </button>
      </div>
    </div>
  );
}
