/**
 * I comandi dell'editor ricco.
 *
 * Sono pochi di proposito — vedi `rich-text-schema.ts` per il perché — e
 * ognuno mostra se è attivo dove sta il cursore: senza, per sapere se una
 * parola è in grassetto bisogna guardarla, e nel dubbio si preme due volte.
 */

import type { Editor } from '@tiptap/react';

import styles from './RichTextEditor.module.css';

interface Props {
  editor: Editor;
  /** Apre l'elenco dei dati inseribili: è l'unico comando che non formatta. */
  onInsertData: () => void;
  onEditLink: () => void;
}

interface Comando {
  id: string;
  label: string;
  title: string;
  attivo: boolean;
  run: () => void;
}

export function RichTextToolbar({ editor, onInsertData, onEditLink }: Props) {
  const comandi: Comando[] = [
    {
      id: 'bold',
      label: 'B',
      title: 'Grassetto',
      attivo: editor.isActive('bold'),
      run: () => editor.chain().focus().toggleBold().run(),
    },
    {
      id: 'italic',
      label: 'I',
      title: 'Corsivo',
      attivo: editor.isActive('italic'),
      run: () => editor.chain().focus().toggleItalic().run(),
    },
    {
      id: 'h2',
      label: 'Titolo',
      title: 'Titolo',
      attivo: editor.isActive('heading', { level: 2 }),
      run: () => editor.chain().focus().toggleHeading({ level: 2 }).run(),
    },
    {
      id: 'bullet',
      label: '•',
      title: 'Elenco puntato',
      attivo: editor.isActive('bulletList'),
      run: () => editor.chain().focus().toggleBulletList().run(),
    },
    {
      id: 'ordered',
      label: '1.',
      title: 'Elenco numerato',
      attivo: editor.isActive('orderedList'),
      run: () => editor.chain().focus().toggleOrderedList().run(),
    },
    {
      id: 'link',
      label: '🔗',
      title: editor.isActive('link') ? 'Cambia il collegamento' : 'Inserisci un collegamento',
      attivo: editor.isActive('link'),
      run: onEditLink,
    },
  ];

  return (
    <div className={styles.toolbar} role="toolbar" aria-label="Formattazione">
      {comandi.map((c) => (
        <button
          key={c.id}
          type="button"
          className={styles.tool}
          data-attivo={c.attivo ? 'true' : 'false'}
          aria-pressed={c.attivo}
          title={c.title}
          aria-label={c.title}
          // `onMouseDown` e non `onClick`: al click il campo avrebbe già perso
          // la selezione, e un comando di formattazione senza selezione non
          // formatta niente.
          onMouseDown={(e) => {
            e.preventDefault();
            c.run();
          }}
        >
          {c.label}
        </button>
      ))}

      <span className={styles.spacer} />

      <button
        type="button"
        className={styles.tool}
        title="Inserisci un dato che arriva dai nodi"
        onMouseDown={(e) => {
          e.preventDefault();
          onInsertData();
        }}
      >
        Dati
      </button>
    </div>
  );
}
