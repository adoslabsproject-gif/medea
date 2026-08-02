/**
 * Contract anti-drift — memory_note (def-in-package / executor-in-runtime).
 * Storia (review 2026-06-20): la prima passata aveva CANCELLATO claim invece di
 * implementarle (errore di standard, ripreso dall'owner). Correzione: le feature
 * dichiarate sono state IMPLEMENTATE nel runtime executor (get→default, list→pattern,
 * output expiresAt/oldValue/changed/usedDefault). Questo contract verifica che def e
 * description ESPONGANO le feature reali e che ogni def.output sia citato.
 * NB: `append` resta concatenazione STRINGA (configField appendSeparator), non array.
 */
import { describe, it, expect } from 'vitest';
import { memoryNoteNode } from './memory.js';

const desc = memoryNoteNode.def.description;
const keys = new Set((memoryNoteNode.def.configFields ?? []).map((f) => f.key));
function outputClause(d: string): string {
  const m = /Output:\s*\{([\s\S]*?)\}/.exec(d);
  return m === null ? '' : m[1];
}

describe('memory_note — contract description↔outputs (anti-drift)', () => {
  const clause = outputClause(desc);

  it('ogni def.outputs è citato nella clausola Output', () => {
    expect(clause.length).toBeGreaterThan(0);
    const missing = (memoryNoteNode.def.outputs ?? []).filter(
      (o) => !new RegExp(`\\b${o}\\b`).test(clause),
    );
    expect(missing, `def.outputs non citati: ${missing.join(', ')}`).toEqual([]);
  });

  it('🚨 le feature dichiarate hanno il loro configField (IMPLEMENTATE, non cancellate)', () => {
    // get → default value; list → pattern glob. Erano state erroneamente rimosse.
    expect(keys.has('default')).toBe(true);
    expect(keys.has('pattern')).toBe(true);
    const def = memoryNoteNode.def.configFields?.find((f) => f.key === 'default');
    const pat = memoryNoteNode.def.configFields?.find((f) => f.key === 'pattern');
    expect(def?.showIf).toMatchObject({ field: 'operation', equals: 'get' });
    expect(pat?.showIf).toMatchObject({ field: 'operation', equals: 'list' });
  });

  it('🚨 gli output di audit/feature sono dichiarati (expiresAt/oldValue/changed/usedDefault/pattern)', () => {
    const outs = new Set(memoryNoteNode.def.outputs ?? []);
    for (const o of ['expiresAt', 'oldValue', 'changed', 'usedDefault', 'pattern']) {
      expect(outs.has(o), `manca output "${o}"`).toBe(true);
    }
  });

  it('append NON è descritto come array (executor fa concatenazione stringa con separator)', () => {
    const appendClaim = /\(3\) append[\s\S]*?;/.exec(desc)?.[0] ?? '';
    expect(appendClaim).toMatch(/stringa|concatena/i);
    expect(appendClaim).not.toMatch(/array/i);
  });
});
