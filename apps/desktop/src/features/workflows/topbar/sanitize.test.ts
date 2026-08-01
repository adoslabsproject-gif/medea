import { describe, expect, it } from 'vitest';

import type { CanvasNode, Workflow } from '../types';

import { sanitizeWorkflow } from './sanitize';

function workflow(...nodes: CanvasNode[]): Workflow {
  return { name: 'prova', nodes, edges: [] };
}

function node(id: string, config: Record<string, unknown>): CanvasNode {
  return { id, defId: 'action_http', x: 0, y: 0, config };
}

describe('l’esportazione ripulita', () => {
  it('sostituisce una password con un riferimento a segreto', () => {
    const { workflow: out, replaced } = sanitizeWorkflow(
      workflow(node('invio', { host: 'smtp.aruba.it', password: 'unaPasswordVera' })),
    );
    expect(out.nodes[0]?.config.password).toBe('{{secrets.INVIO_PASSWORD}}');
    expect(replaced).toEqual(['invio.password → INVIO_PASSWORD']);
  });

  it('lascia intatto quello che non è una credenziale', () => {
    const { workflow: out } = sanitizeWorkflow(
      workflow(node('invio', { host: 'smtp.aruba.it', port: 587 })),
    );
    expect(out.nodes[0]?.config).toEqual({ host: 'smtp.aruba.it', port: 587 });
  });

  it('riconosce le forme in cui si scrive una chiave', () => {
    const { replaced } = sanitizeWorkflow(
      workflow(
        node('a', { apiKey: 'x', api_key: 'y', 'api-key': 'z', bearerToken: 'w', secret: 'v' }),
      ),
    );
    expect(replaced).toHaveLength(5);
  });

  it('non tocca un riferimento già scritto bene', () => {
    // Sostituirlo produrrebbe `{{secrets.A_PASSWORD}}` al posto del nome
    // scelto dall'utente, e il workflow smetterebbe di funzionare.
    const { workflow: out, replaced } = sanitizeWorkflow(
      workflow(node('a', { password: '{{secrets.SMTP_ARUBA}}' })),
    );
    expect(out.nodes[0]?.config.password).toBe('{{secrets.SMTP_ARUBA}}');
    expect(replaced).toEqual([]);
  });

  it('non tocca i valori che non sono testo', () => {
    // Un `false` in un campo che si chiama `auth` è una scelta di
    // configurazione, non una credenziale.
    const { workflow: out } = sanitizeWorkflow(workflow(node('a', { auth: false })));
    expect(out.nodes[0]?.config.auth).toBe(false);
  });

  it('non tocca un campo vuoto: non c’è niente da nascondere', () => {
    const { replaced } = sanitizeWorkflow(workflow(node('a', { password: '' })));
    expect(replaced).toEqual([]);
  });

  it('lascia stare i nomi che somigliano a un segreto ma non lo sono', () => {
    const { replaced } = sanitizeWorkflow(
      workflow(node('a', { passthrough: 'x', author: 'Medea' })),
    );
    expect(replaced).toEqual([]);
  });

  it('produce nomi utilizzabili anche da identificativi con trattini', () => {
    const { replaced } = sanitizeWorkflow(workflow(node('invia-posta_1', { token: 'x' })));
    expect(replaced).toEqual(['invia-posta_1.token → INVIA_POSTA_1_TOKEN']);
  });

  it('non modifica il documento originale', () => {
    const original = workflow(node('a', { password: 'segreta' }));
    sanitizeWorkflow(original);
    expect(original.nodes[0]?.config.password).toBe('segreta');
  });
});
