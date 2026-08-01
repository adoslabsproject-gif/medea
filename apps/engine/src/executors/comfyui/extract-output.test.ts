import { describe, it, expect } from 'vitest';
import { extractMedia, firstMedia } from './extract-output.js';
import { ComfyError } from './client.js';

describe('extractMedia / firstMedia', () => {
  it('estrae immagini (SaveImage) con kind=image', () => {
    const out = { '9': { images: [{ filename: 'a.png', subfolder: '', type: 'output' }] } };
    const m = extractMedia(out);
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ filename: 'a.png', kind: 'image', type: 'output' });
  });

  it('SaveVideo: .mp4 sotto chiave "images" → kind=video (estensione vince)', () => {
    const out = { '9': { images: [{ filename: 'clip.mp4', subfolder: '', type: 'output' }] } };
    expect(extractMedia(out)[0]?.kind).toBe('video');
  });

  it('chiave gifs/videos → kind=video', () => {
    const out = { '12': { gifs: [{ filename: 'clip.mp4', subfolder: 'v', type: 'output' }] } };
    expect(extractMedia(out)[0]?.kind).toBe('video');
  });

  it('kind dedotto dall\'estensione quando la chiave non è nota', () => {
    const out = { '5': { media: [{ filename: 'x.webm' }] } };
    expect(extractMedia(out)[0]?.kind).toBe('video');
  });

  it('subfolder/type assenti → default vuoto/output', () => {
    const out = { '9': { images: [{ filename: 'a.png' }] } };
    expect(extractMedia(out)[0]).toMatchObject({ subfolder: '', type: 'output' });
  });

  it('outputNodeId filtra al nodo richiesto', () => {
    const out = {
      '9': { images: [{ filename: 'a.png' }] },
      '20': { images: [{ filename: 'b.png' }] },
    };
    expect(extractMedia(out, '20').map((m) => m.filename)).toEqual(['b.png']);
  });

  it('outputNodeId assente → ComfyError parlante', () => {
    expect(() => extractMedia({ '9': { images: [] } }, '99')).toThrow(/non trovato/i);
  });

  it('ignora entry malformate (filename non stringa)', () => {
    const out = { '9': { images: [{ filename: 123 }, { nope: true }, { filename: 'ok.png' }] } };
    expect(extractMedia(out).map((m) => m.filename)).toEqual(['ok.png']);
  });

  it('firstMedia su output senza media → ComfyError', () => {
    expect(() => firstMedia({ '9': { images: [] } })).toThrow(ComfyError);
  });

  it('firstMedia ritorna il primo', () => {
    const out = { '9': { images: [{ filename: '1.png' }, { filename: '2.png' }] } };
    expect(firstMedia(out).filename).toBe('1.png');
  });
});
