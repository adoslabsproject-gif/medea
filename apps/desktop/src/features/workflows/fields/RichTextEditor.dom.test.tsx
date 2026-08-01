// @vitest-environment happy-dom

/**
 * L'editor del corpo email.
 *
 * Le cose che devono restare vere, in ordine di quanto farebbero male se
 * smettessero: le espressioni fra graffe arrivano intatte al motore (se
 * l'editor le trasformasse, ogni email automatica direbbe la cosa sbagliata),
 * l'HTML resta quello che i client di posta sanno rendere, e un campo mai
 * toccato risulta vuoto e non `<p></p>`.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Editor } from '@tiptap/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { normalizeHtml, RICH_TEXT_EXTENSIONS } from './rich-text-schema';
import { RichTextEditor } from './RichTextEditor';

afterEach(cleanup);

const SOURCES = [
  { expression: '$node.leggi.json.result.nome', label: 'Nome dal nodo «leggi»', hint: 'testo' },
];

describe('il corpo vuoto', () => {
  it('è vuoto, non un paragrafo senza niente dentro', () => {
    // Salvare `<p></p>` vorrebbe dire che un campo mai toccato risulta
    // compilato, e un nodo che controlla «il corpo c'è?» direbbe di sì.
    expect(normalizeHtml('<p></p>')).toBe('');
    expect(normalizeHtml('<p><br></p>')).toBe('');
    expect(normalizeHtml('<p>ciao</p>')).toBe('<p>ciao</p>');
  });
});

describe('l’editor del corpo email', () => {
  it('mostra i comandi che servono a scrivere una email', () => {
    render(<RichTextEditor value="" onChange={vi.fn()} sources={SOURCES} />);
    for (const c of ['Grassetto', 'Corsivo', 'Titolo', 'Elenco puntato', 'Elenco numerato']) {
      expect(screen.getByLabelText(c)).toBeTruthy();
    }
  });

  it('elenca i dati dei nodi, non solo quelli sempre disponibili', () => {
    render(<RichTextEditor value="" onChange={vi.fn()} sources={SOURCES} />);
    fireEvent.mouseDown(screen.getByText('Dati'));
    expect(screen.getByText('Nome dal nodo «leggi»')).toBeTruthy();
    // I predefiniti restano in fondo: valgono in ogni workflow.
    expect(screen.getByText('Adesso')).toBeTruthy();
  });

  it('fa vedere l’HTML vero, e lo lascia cambiare', () => {
    const onChange = vi.fn();
    render(<RichTextEditor value="<p>ciao</p>" onChange={onChange} sources={[]} />);

    fireEvent.click(screen.getByText('Mostra l’HTML'));
    const area = screen.getByLabelText<HTMLTextAreaElement>('Codice HTML del messaggio');
    expect(area.value).toBe('<p>ciao</p>');

    // Chi incolla un template fatto altrove deve poterlo incollare.
    fireEvent.change(area, { target: { value: '<p>ciao <b>Mario</b></p>' } });
    expect(onChange).toHaveBeenCalledWith('<p>ciao <b>Mario</b></p>');
  });

  it('dice che le graffe restano graffe', () => {
    // È la domanda che si fa chiunque scriva il primo corpo email: «se lo
    // formatto, l'espressione sopravvive?».
    render(<RichTextEditor value="" onChange={vi.fn()} sources={[]} />);
    expect(screen.getByText(/le sostituisce il motore/)).toBeTruthy();
  });
});

describe('che HTML può uscire di qui', () => {
  /**
   * La prova che lo schema è una garanzia e non una promessa: si dà in pasto
   * al documento l'HTML che arriva davvero incollando da Word, da una pagina
   * web, da un template altrui, e si guarda cosa ne esce.
   */
  function attraversoLoSchema(sporco: string): string {
    const editor = new Editor({ extensions: RICH_TEXT_EXTENSIONS, content: sporco });
    const pulito = editor.getHTML();
    editor.destroy();
    return pulito;
  }

  it('butta gli stili inline, che ogni client di posta rende a modo suo', () => {
    const out = attraversoLoSchema('<p style="color:red;font-size:32px">rosso</p>');
    expect(out).toContain('rosso');
    expect(out).not.toContain('style');
  });

  it('butta i <div> e le classi che arrivano incollando da una pagina', () => {
    const out = attraversoLoSchema('<div class="msg"><span class="x">testo</span></div>');
    expect(out).toContain('testo');
    expect(out).not.toContain('class');
    expect(out).not.toContain('<div');
  });

  it('butta gli <img>: o è remota e viene bloccata, o è un allegato', () => {
    const out = attraversoLoSchema('<p>eccola <img src="https://esempio.it/a.png"></p>');
    expect(out).not.toContain('<img');
  });

  it('non lascia passare uno <script>', () => {
    const out = attraversoLoSchema('<p>ciao</p><script>alert(1)</script>');
    expect(out).not.toContain('script');
    expect(out).not.toContain('alert');
  });

  it('tiene quello che serve: grassetto, corsivo, elenchi, link', () => {
    const out = attraversoLoSchema(
      '<p><b>forte</b> e <i>piano</i></p><ul><li>uno</li></ul><p><a href="https://esempio.it">qui</a></p>',
    );
    expect(out).toContain('<strong>forte</strong>');
    expect(out).toContain('<em>piano</em>');
    expect(out).toContain('<li>');
    expect(out).toContain('href="https://esempio.it"');
  });

  it('e non tocca le espressioni: arrivano al motore come sono state scritte', () => {
    // Se l'editor le trasformasse — anche solo scappando le graffe — ogni
    // email automatica direbbe la cosa sbagliata, e non si capirebbe perché.
    const out = attraversoLoSchema('<p>Ciao {{$node.leggi.json.result.nome}}, grazie.</p>');
    expect(out).toContain('{{$node.leggi.json.result.nome}}');
  });
});
