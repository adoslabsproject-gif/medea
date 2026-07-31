import { describe, expect, it } from 'vitest';

import { createSseReader, parseData } from './sse';

describe('il lettore degli eventi in streaming', () => {
  it('legge un messaggio completo', () => {
    const read = createSseReader();
    expect(read('event: run.step\ndata: {"runId":"a"}\n\n')).toEqual([
      { event: 'run.step', data: '{"runId":"a"}' },
    ]);
  });

  it('ricompone un messaggio spezzato dalla rete', () => {
    const read = createSseReader();
    // Il taglio cade dentro il campo: senza residuo, l'evento sparirebbe.
    expect(read('event: run.st')).toEqual([]);
    expect(read('ep\ndata: {"runId"')).toEqual([]);
    expect(read(':"a"}\n\n')).toEqual([{ event: 'run.step', data: '{"runId":"a"}' }]);
  });

  it('legge più messaggi arrivati nello stesso pezzo', () => {
    const read = createSseReader();
    const messages = read('event: a\ndata: 1\n\nevent: b\ndata: 2\n\n');
    expect(messages.map((m) => m.event)).toEqual(['a', 'b']);
  });

  it('ignora i commenti che i proxy si aspettano', () => {
    const read = createSseReader();
    // Il runtime apre con 16 KB di riempimento: non è un evento.
    expect(read(`:${' '.repeat(64)}\n\n`)).toEqual([]);
    expect(read('event: ping\ndata: 1\n\n')).toEqual([{ event: 'ping', data: '1' }]);
  });

  it('accetta le righe che finiscono con ritorno a capo di Windows', () => {
    const read = createSseReader();
    expect(read('event: a\r\ndata: 1\r\n\r\n')).toEqual([{ event: 'a', data: '1' }]);
  });

  it('unisce le righe di dati multiple, come vuole il protocollo', () => {
    const read = createSseReader();
    expect(read('data: uno\ndata: due\n\n')).toEqual([{ event: 'message', data: 'uno\ndue' }]);
  });

  it('non restituisce niente per un messaggio senza dati', () => {
    const read = createSseReader();
    expect(read('event: solo-nome\n\n')).toEqual([]);
  });
});

describe('la lettura del contenuto', () => {
  it('restituisce l’oggetto quando è leggibile', () => {
    expect(parseData({ event: 'x', data: '{"a":1}' })).toEqual({ a: 1 });
  });

  it('restituisce niente invece di scoppiare su un contenuto rotto', () => {
    expect(parseData({ event: 'x', data: 'non json' })).toBeNull();
  });
});
