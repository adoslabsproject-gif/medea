/**
 * Contract anti-drift — excel (def-in-package / executor-in-runtime).
 * Storia (review 2026-06-20): le description promettevano output che l'executor
 * runtime NON produce — parse: headerRow/columnCount/truncated/emptyCellsCount;
 * build: base64/size_bytes/rowCount/columnCount/mimeType. L'executor reale ritorna
 * parse {rows,sheetName,totalRows,columns} e build {binary,path?,fileName,sheetName,
 * rowsWritten,sizeBytes,contentType} (= def.outputs). Questo guard blocca il ri-drift.
 */
import { describe, it, expect } from 'vitest';
import { xlsxParseNode, xlsxBuildNode } from './excel.js';
import type { NodeModule } from '../types.js';

/** Substring della clausola `Output: { … }` della description (o '' se assente). */
function outputClause(description: string): string {
  const m = /Output:\s*\{([\s\S]*?)\}/.exec(description);
  // Gruppo 1 sempre presente quando il match riesce (catch-all `([\s\S]*?)`).
  return m === null ? '' : m[1];
}

const cases: { node: NodeModule; label: string; stale: string[] }[] = [
  // parse: columnCount/headerRow/emptyCellsCount/truncated ora IMPLEMENTATI (non più stale).
  { node: xlsxParseNode, label: 'action_xlsx_parse', stale: [] },
  { node: xlsxBuildNode, label: 'action_xlsx_build', stale: ['base64', 'size_bytes', 'rowCount', 'columnCount', 'mimeType'] },
];

describe('excel — contract description↔outputs (anti-drift)', () => {
  for (const { node, label, stale } of cases) {
    const clause = outputClause(node.def.description);

    it(`[${label}] ogni def.outputs è citato nella clausola Output (description non omette i campi reali)`, () => {
      expect(clause.length).toBeGreaterThan(0);
      const missing = (node.def.outputs ?? []).filter((o) => o !== 'default' && !new RegExp(`\\b${o}\\b`).test(clause));
      expect(missing, `def.outputs non citati nella description: ${missing.join(', ')}`).toEqual([]);
    });

    it(`[${label}] la clausola Output NON ripropone i nomi sbagliati rimossi`, () => {
      const offenders = stale.filter((s) => clause.includes(s));
      expect(offenders, `nomi stale ricomparsi nella clausola Output: ${offenders.join(', ')}`).toEqual([]);
    });
  }
});
