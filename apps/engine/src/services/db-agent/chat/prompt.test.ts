/**
 * Test del system prompt DB-agent — due modalità (database vs globale).
 * Caratterizzazione: la modalità DATABASE resta byte-compatibile con il prompt
 * storico (persona + tools + safety + schema). La modalità GLOBALE aggiunge le
 * istruzioni list/create database.
 *
 * @module services/db-agent/chat/prompt.test
 */
import { describe, it, expect } from 'vitest';
import { buildDbAgentSystemPrompt } from './prompt.js';

describe('buildDbAgentSystemPrompt — modalità DATABASE (storica)', () => {
  it('contiene persona + sezione schema, NON la sezione globale', () => {
    const p = buildDbAgentSystemPrompt({ schemaContext: 'Database "app": nessuna tabella.' });
    expect(p).toContain('Sei Liara');
    expect(p).toContain('[SCHEMA DEL DATABASE SELEZIONATO]');
    expect(p).toContain('Database "app": nessuna tabella.');
    expect(p).not.toContain('[DATABASE DEL WORKSPACE]');
    expect(p).not.toContain('MODALITÀ DB STUDIO');
  });

  it('appende il contesto workflow se presente', () => {
    const p = buildDbAgentSystemPrompt({ schemaContext: 's', workflowContext: 'WF-123' });
    expect(p).toContain('[WORKFLOW CORRENTE]');
    expect(p).toContain('WF-123');
  });

  it('schemaContext assente → sezione schema vuota (no crash)', () => {
    const p = buildDbAgentSystemPrompt({});
    expect(p).toContain('[SCHEMA DEL DATABASE SELEZIONATO]');
  });
});

describe('buildDbAgentSystemPrompt — modalità GLOBALE (DB Studio, nessun DB)', () => {
  it('databasesOverview → istruzioni list/create + sezione workspace, NIENTE sezione schema', () => {
    const p = buildDbAgentSystemPrompt({ databasesOverview: '- "crm" (sqlite, 3 tabelle)' });
    expect(p).toContain('MODALITÀ DB STUDIO');
    expect(p).toContain('create_database');
    expect(p).toContain('[DATABASE DEL WORKSPACE]');
    expect(p).toContain('- "crm" (sqlite, 3 tabelle)');
    expect(p).not.toContain('[SCHEMA DEL DATABASE SELEZIONATO]');
  });

  it('overview ha la PRECEDENZA su schemaContext (se per errore arrivassero entrambi)', () => {
    const p = buildDbAgentSystemPrompt({ databasesOverview: 'OV', schemaContext: 'SCHEMA' });
    expect(p).toContain('[DATABASE DEL WORKSPACE]');
    expect(p).not.toContain('[SCHEMA DEL DATABASE SELEZIONATO]');
    expect(p).not.toContain('SCHEMA');
  });

  it('overview vuota ("") è comunque modalità globale (DB Studio a zero database)', () => {
    const p = buildDbAgentSystemPrompt({ databasesOverview: '' });
    expect(p).toContain('MODALITÀ DB STUDIO');
    expect(p).not.toContain('[SCHEMA DEL DATABASE SELEZIONATO]');
  });

  it('persona + regole tool + safety presenti in ENTRAMBE le modalità', () => {
    for (const ctx of [{ schemaContext: 's' }, { databasesOverview: 'o' }]) {
      const p = buildDbAgentSystemPrompt(ctx);
      expect(p).toContain('Sei Liara');
      expect(p).toContain('preview_schema_plan');
      expect(p).toContain('run_sql è di SOLA LETTURA');
    }
  });
});
