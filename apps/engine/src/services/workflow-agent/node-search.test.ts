/**
 * Test node-search — ricerca keyword sul catalog. Verifica ranking, match per
 * campo (defId/label/alias/descrizione), determinismo e limit.
 */
import { describe, it, expect } from 'vitest';
import { searchNodes } from './node-search.js';
import type { NodeCatalogEntry } from '@/services/ai-scaffold/node-catalog.js';

const CATALOG: NodeCatalogEntry[] = [
  {
    defId: 'action_send_email',
    type: 'action',
    label: 'Invia Email',
    description: 'Manda una email via SMTP',
    fields: [],
    searchAliases: ['mail', 'posta'],
  },
  {
    defId: 'action_http_request',
    type: 'action',
    label: 'HTTP Request',
    description: 'Chiama un endpoint HTTP',
    fields: [],
  },
  {
    defId: 'db_insert',
    type: 'action',
    label: 'DB Insert',
    description: 'Inserisci righe in una tabella database',
    fields: [],
  },
  {
    defId: 'trigger_webhook',
    type: 'trigger',
    label: 'Webhook',
    description: 'Avvia su richiesta HTTP in ingresso',
    fields: [],
  },
];

describe('searchNodes', () => {
  it('match esatto del defId → in cima con score alto', () => {
    const hits = searchNodes(CATALOG, 'db_insert');
    expect(hits[0]!.defId).toBe('db_insert');
    expect(hits[0]!.score).toBeGreaterThanOrEqual(100);
  });

  it('🚨 trova per ALIAS ("posta" → send_email)', () => {
    const hits = searchNodes(CATALOG, 'posta elettronica');
    expect(hits.map((h) => h.defId)).toContain('action_send_email');
  });

  it('trova per label/descrizione ("inserisci database" → db_insert)', () => {
    const hits = searchNodes(CATALOG, 'inserisci nel database');
    expect(hits[0]!.defId).toBe('db_insert');
  });

  it('🚨 ranking: il match più forte (defId+label) batte il solo descrizione', () => {
    // "http" è nel defId+label di http_request e nella descrizione di webhook
    const hits = searchNodes(CATALOG, 'http');
    expect(hits[0]!.defId).toBe('action_http_request');
    expect(hits.map((h) => h.defId)).toContain('trigger_webhook');
    const http = hits.find((h) => h.defId === 'action_http_request')!;
    const webhook = hits.find((h) => h.defId === 'trigger_webhook')!;
    expect(http.score).toBeGreaterThan(webhook.score);
  });

  it('nessun match → []', () => {
    expect(searchNodes(CATALOG, 'criptovaluta blockchain')).toEqual([]);
  });

  it('query vuota/non significativa → []', () => {
    expect(searchNodes(CATALOG, '')).toEqual([]);
    expect(searchNodes(CATALOG, '! ? .')).toEqual([]);
  });

  it('rispetta il limit', () => {
    expect(searchNodes(CATALOG, 'http email database webhook', 2)).toHaveLength(2);
  });

  it('🚨 determinismo: stesso score → ordine stabile per defId', () => {
    const a = searchNodes(CATALOG, 'http email database webhook');
    const b = searchNodes(CATALOG, 'http email database webhook');
    expect(a.map((h) => h.defId)).toEqual(b.map((h) => h.defId));
  });
});
