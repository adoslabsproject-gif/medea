/**
 * CONTRACT cross-app — i nodi italia "def nel package / executor nel runtime"
 * (SDI, PEC, Zucchetti) leggono `config.X` da italian.ts, ma le configField
 * sono dichiarate in `@flowforge/nodes-integrations-italia`. Il commento in
 * sdi-adel/index.ts AVVERTE: "se rinomini un campo qui, rinomina anche
 * nell'executor o il nodo si rompe SILENZIOSAMENTE". Nessun test copriva quel
 * match (i contract test del package coprono description↔configFields, non
 * configFields↔executor): questo lo fa.
 *
 * ASSERISCE: ogni `config.<key>` letta da un executor è una configField
 * dichiarata nella def corrispondente → rinomina su un lato solo = ROSSO.
 *
 * @module executors/italian-def-contract
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { NodeModule } from '@flowforge/nodes-stdlib';
import { sdiSendInvoice, sdiCheckStatus, pecArubaSend, pecArubaReceive, zucchettiPayroll } from '@flowforge/nodes-integrations-italia';

const here = dirname(fileURLToPath(import.meta.url));
const srcCache = new Map<string, string>();
function readSrc(file: string): string {
  if (!srcCache.has(file)) srcCache.set(file, readFileSync(join(here, file), 'utf8'));
  return srcCache.get(file)!;
}

/** Estrae il corpo di `export const <name> = …` fino al prossimo `export const`. */
function executorBody(file: string, name: string): string {
  const src = readSrc(file);
  const start = src.indexOf(`export const ${name}`);
  if (start === -1) throw new Error(`executor ${name} non trovato in ${file}`);
  const after = src.indexOf('\nexport const ', start + 1);
  return src.slice(start, after === -1 ? undefined : after);
}

/** Tutte le chiavi lette come `config.<key>` nel corpo. */
function configReads(body: string): Set<string> {
  return new Set([...body.matchAll(/\bconfig\.([a-zA-Z_$][\w$]*)/g)].map((m) => m[1]!));
}

function defKeys(mod: NodeModule): Set<string> {
  return new Set((mod.def.configFields ?? []).map((f) => f.key));
}

const PAIRS: { executor: string; file: string; def: NodeModule; label: string }[] = [
  { executor: 'sdiSendInvoiceExecutor', file: 'italian.ts', def: sdiSendInvoice, label: 'italia_sdi_send_invoice' },
  { executor: 'sdiCheckStatusExecutor', file: 'italian.ts', def: sdiCheckStatus, label: 'italia_sdi_check_status' },
  { executor: 'pecArubaSendExecutor', file: 'italian.ts', def: pecArubaSend, label: 'italia_pec_aruba_send' },
  { executor: 'pecArubaReceiveExecutor', file: 'pec-receive.ts', def: pecArubaReceive, label: 'italia_pec_aruba_receive' },
  { executor: 'zucchettiPayrollExecutor', file: 'italian.ts', def: zucchettiPayroll, label: 'italia_zucchetti_payroll' },
];

describe('🚨 contract cross-app — config.X dell\'executor ⊆ configFields della def', () => {
  for (const { executor, file, def, label } of PAIRS) {
    it(`[${label}] ogni config.<key> letta da ${executor} è dichiarata nella def`, () => {
      const reads = configReads(executorBody(file, executor));
      const keys = defKeys(def);
      const undeclared = [...reads].filter((k) => !keys.has(k));
      expect(
        undeclared,
        `${executor} legge config.${undeclared.join('/config.')} ma la def non lo dichiara ` +
          `(rinomina su un solo lato → nodo rotto silenziosamente)`,
      ).toEqual([]);
    });
  }

  it('sanity: ogni executor legge almeno una config (regex/path validi)', () => {
    for (const { executor, file } of PAIRS) {
      expect(configReads(executorBody(file, executor)).size, `${executor}`).toBeGreaterThan(0);
    }
  });
});
