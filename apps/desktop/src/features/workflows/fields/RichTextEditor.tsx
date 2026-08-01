/**
 * Il corpo di una email, scritto come si scrive una email.
 *
 * Finora un campo `rich-text` era una casella di testo: chi voleva una parola
 * in grassetto scriveva `<b>`. Funziona — il motore manda HTML — ma vuol dire
 * che per mandare una email formattata bisogna conoscere l'HTML, e chi lo
 * conosce sbaglia comunque il `<br>` fra i paragrafi.
 *
 * Tre cose che questo editor deve fare e che un WYSIWYG generico non fa:
 *
 * 1. **produrre HTML da email**, non HTML da browser. Lo garantisce lo schema
 *    in `rich-text-schema.ts`: quello che non è previsto non può entrare nel
 *    documento, nemmeno incollandolo.
 * 2. **convivere con le espressioni.** Il corpo di una email automatica è
 *    fatto per metà di `{{$node.x.json.result.nome}}`. Restano testo normale —
 *    il motore le sostituisce dopo — e il pulsante «Dati» le inserisce senza
 *    doversi ricordare l'id del nodo.
 * 3. **lasciar vedere l'HTML.** Chi incolla un template fatto altrove deve
 *    poterlo incollare. L'interruttore in basso mostra il codice vero, e
 *    tornando indietro l'editor lo rilegge.
 */

import { EditorContent, useEditor } from '@tiptap/react';
import { useEffect, useState } from 'react';

import type { ExpressionSource } from './ExpressionPicker';
import { BUILTIN_SOURCES } from './ExpressionPicker';
import { normalizeHtml, RICH_TEXT_EXTENSIONS } from './rich-text-schema';
import styles from './RichTextEditor.module.css';
import { RichTextToolbar } from './RichTextToolbar';

interface Props {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  /** Cosa si può referenziare da questo campo. */
  sources: readonly ExpressionSource[];
}

export function RichTextEditor({ value, onChange, placeholder, sources }: Props) {
  /** Vero quando si sta guardando il codice invece del risultato. */
  const [codice, setCodice] = useState(false);
  const [datiAperti, setDatiAperti] = useState(false);

  const editor = useEditor({
    extensions: RICH_TEXT_EXTENSIONS,
    content: value,
    onUpdate: ({ editor: e }) => {
      onChange(normalizeHtml(e.getHTML()));
    },
    editorProps: { attributes: { class: styles.surface ?? '', role: 'textbox' } },
  });

  // Il valore può cambiare da fuori — si carica una versione, si annulla una
  // modifica — e allora l'editor deve rileggerlo. Ma solo se è davvero
  // diverso: riscriverlo a ogni battuta sposterebbe il cursore in fondo.
  useEffect(() => {
    if (!editor || codice) return;
    if (editor.getHTML() !== value && normalizeHtml(editor.getHTML()) !== value) {
      editor.commands.setContent(value, { emitUpdate: false });
    }
  }, [editor, value, codice]);

  if (!editor) return null;

  const inserisci = (expression: string) => {
    // Come testo, non come nodo: l'espressione deve arrivare al motore
    // esattamente com'è scritta, graffe comprese.
    editor.chain().focus().insertContent(`{{${expression}}}`).run();
    setDatiAperti(false);
  };

  const modificaLink = () => {
    const attuale = editor.getAttributes('link').href as string | undefined;
    const href = window.prompt('Indirizzo del collegamento', attuale ?? 'https://');
    if (href === null) return;
    if (href.trim() === '') {
      editor.chain().focus().unsetLink().run();
      return;
    }
    editor.chain().focus().extendMarkRange('link').setLink({ href: href.trim() }).run();
  };

  const tutte = [...sources, ...BUILTIN_SOURCES];

  return (
    <div className={styles.root}>
      <RichTextToolbar
        editor={editor}
        onEditLink={modificaLink}
        onInsertData={() => {
          setDatiAperti((v) => !v);
        }}
      />

      {datiAperti && (
        <ul className={styles.sources}>
          {tutte.map((s) => (
            <li key={s.expression}>
              <button
                type="button"
                className={styles.source}
                onMouseDown={(e) => {
                  e.preventDefault();
                  inserisci(s.expression);
                }}
              >
                <span className={styles.sourceLabel}>{s.label}</span>
                {s.hint && <span className={styles.sourceHint}>{s.hint}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}

      {codice ? (
        <textarea
          className={styles.code}
          aria-label="Codice HTML del messaggio"
          value={value}
          placeholder={placeholder ?? ''}
          rows={10}
          onChange={(e) => {
            onChange(e.target.value);
          }}
        />
      ) : (
        <EditorContent editor={editor} className={styles.content} />
      )}

      <div className={styles.foot}>
        <button
          type="button"
          className={styles.toggle}
          onClick={() => {
            // Tornando dal codice l'editor deve rileggere quello che c'è
            // scritto ora, non quello che aveva prima.
            if (codice) editor.commands.setContent(value, { emitUpdate: false });
            setCodice((v) => !v);
          }}
        >
          {codice ? 'Torna al testo' : 'Mostra l’HTML'}
        </button>
        <span className={styles.note}>
          Le espressioni fra graffe restano tali: le sostituisce il motore quando parte.
        </span>
      </div>
    </div>
  );
}
