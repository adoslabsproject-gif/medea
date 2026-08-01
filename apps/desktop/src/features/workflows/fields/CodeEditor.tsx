/**
 * Un campo di codice che si legge.
 *
 * Prima era una `<textarea>`: JavaScript, JSON e SQL erano lo stesso muro
 * grigio, e una parentesi non chiusa si scopriva a esecuzione fallita. Ora la
 * sintassi è colorata, le parentesi si chiudono da sole e il rientro segue il
 * blocco.
 *
 * **CodeMirror e non Monaco**, di proposito. Quello che serve qui è leggere e
 * scrivere trenta righe: colore, parentesi, rientro. Il completamento coi tipi
 * e la diagnostica — il resto di Monaco — sarebbero tre megabyte dentro un
 * installatore che ne pesa quattro, scaricati anche da chi un campo di codice
 * non lo apre mai. Se un giorno servissero, si sostituisce questo componente e
 * basta: il resto dell'editor non sa cosa c'è dentro.
 *
 * La lingua la dichiara il nodo (`field.language`), ed è uno dei campi che
 * l'estrattore recuperava buttava via: senza, sarebbe di nuovo tutto grigio.
 */

import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { sql } from '@codemirror/lang-sql';
import {
  bracketMatching,
  foldGutter,
  indentOnInput,
  syntaxHighlighting,
  defaultHighlightStyle,
} from '@codemirror/language';
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, placeholder as cmPlaceholder } from '@codemirror/view';
import { useEffect, useRef } from 'react';

import styles from './CodeEditor.module.css';

interface Props {
  value: string;
  language?: string;
  placeholder?: string;
  onChange: (value: string) => void;
}

/** Il supporto per la lingua dichiarata, se ne conosciamo uno. */
function languageSupport(language: string | undefined): Extension[] {
  switch (language) {
    case 'javascript':
    case 'typescript':
      return [javascript({ typescript: language === 'typescript' })];
    case 'json':
      return [json()];
    case 'sql':
      return [sql()];
    // `yaml` e `jsonata` non hanno un supporto qui: restano senza colore, che
    // è meglio di colorarli con le regole di un'altra lingua.
    default:
      return [];
  }
}

/**
 * Il tema: i colori del documento, non quelli di CodeMirror.
 *
 * Un riquadro di codice che ignora il tema dell'app è la cosa che si nota
 * per prima — e in tema scuro sarebbe un rettangolo bianco in mezzo.
 */
const tema = EditorView.theme({
  '&': {
    backgroundColor: 'var(--color-surface-1)',
    color: 'var(--color-text-primary)',
    fontSize: 'var(--font-size-xs)',
    border: '1px solid var(--color-border-default)',
    borderRadius: 'var(--radius-sm)',
  },
  '&.cm-focused': { outline: '2px solid var(--color-accent-default)', outlineOffset: '1px' },
  '.cm-content': { fontFamily: 'var(--font-family-mono)', padding: 'var(--space-2)' },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    color: 'var(--color-text-muted)',
    border: 'none',
  },
  '.cm-activeLine': { backgroundColor: 'transparent' },
  '.cm-cursor': { borderLeftColor: 'var(--color-text-primary)' },
});

export function CodeEditor({ value, language, placeholder, onChange }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  /** L'ultimo `onChange`, senza ricostruire l'editor a ogni ridisegno. */
  const emit = useRef(onChange);
  emit.current = onChange;

  useEffect(() => {
    if (!host.current) return;

    const editor = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          foldGutter(),
          history(),
          indentOnInput(),
          bracketMatching(),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          EditorView.lineWrapping,
          tema,
          ...(placeholder ? [cmPlaceholder(placeholder)] : []),
          ...languageSupport(language),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) emit.current(update.state.doc.toString());
          }),
        ],
      }),
    });
    view.current = editor;

    return () => {
      editor.destroy();
      view.current = null;
    };
    // Si ricostruisce solo se cambia la lingua: il valore lo si allinea
    // sotto, senza buttare via lo stato dell'editor a ogni battuta.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [language, placeholder]);

  /**
   * Allinea il testo quando cambia da fuori — un annulla, un workflow
   * riaperto — senza toccarlo mentre lo si sta scrivendo: sostituire il
   * documento a ogni battuta sposterebbe il cursore alla fine.
   */
  useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    const corrente = editor.state.doc.toString();
    if (corrente === value) return;
    editor.dispatch({ changes: { from: 0, to: corrente.length, insert: value } });
  }, [value]);

  return <div ref={host} className={styles.root} />;
}
