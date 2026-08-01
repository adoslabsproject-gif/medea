/**
 * Domain — RuleParamSchema + validator.
 *
 * Una regola dichiara i parametri configurabili da UI. La UI renderizza il
 * widget appropriato (number input, slider, enum dropdown, boolean toggle,
 * duration picker). Il framework valida prima di passare al detect().
 *
 * Federico-grade: lo schema NON è solo descrittivo — è anche il validatore
 * a runtime. UI e backend usano la STESSA definizione, single source of truth.
 */

import { Ok, Err, type Result } from './result.js';

// ────────────────────────────────────────────────────────────────────
// Schema
// ────────────────────────────────────────────────────────────────────

interface RuleParamBase<T extends string> {
  readonly name: string;
  readonly type: T;
  readonly label: string;
  readonly description?: string;
  readonly required: boolean;
}

export interface RuleParamNumber extends RuleParamBase<'number'> {
  readonly default: number;
  readonly min?: number;
  readonly max?: number;
  /** Step per UI input/slider. */
  readonly step?: number;
  /** Unità human-readable (label vicino al field). */
  readonly unit?: string;
}

export interface RuleParamString extends RuleParamBase<'string'> {
  readonly default: string;
  readonly maxLength?: number;
  readonly pattern?: string; // RegExp serializzata per UI client-side preview
}

export interface RuleParamBoolean extends RuleParamBase<'boolean'> {
  readonly default: boolean;
}

export interface RuleParamDurationMs extends RuleParamBase<'duration_ms'> {
  readonly default: number;
  readonly minMs?: number;
  readonly maxMs?: number;
}

export interface RuleParamEnum extends RuleParamBase<'enum'> {
  readonly default: string;
  readonly values: readonly { readonly value: string; readonly label: string }[];
}

export type RuleParamSchema =
  | RuleParamNumber
  | RuleParamString
  | RuleParamBoolean
  | RuleParamDurationMs
  | RuleParamEnum;

// ────────────────────────────────────────────────────────────────────
// Validation
// ────────────────────────────────────────────────────────────────────

export interface ValidationError {
  readonly param: string;
  readonly message: string;
}

/**
 * Valida e normalizza un set di params secondo lo schema. Riempie i
 * default per ogni param mancante, scarta quelli sconosciuti, applica
 * range/length/regex check.
 *
 * NB: la firma `unknown` è intenzionale — i params arrivano da JSON DB,
 * mai assumere il tipo a priori. Il narrowing avviene qui.
 */
export function validateParams(
  schema: readonly RuleParamSchema[],
  raw: unknown,
): Result<Readonly<Record<string, unknown>>, readonly ValidationError[]> {
  const input = (typeof raw === 'object' && raw !== null) ? raw as Record<string, unknown> : {};
  const errors: ValidationError[] = [];
  const out: Record<string, unknown> = {};

  for (const p of schema) {
    const value = p.name in input ? input[p.name] : p.default;
    const r = validateSingle(p, value);
    if (r.ok) {
      out[p.name] = r.value;
    } else {
      errors.push({ param: p.name, message: r.error });
    }
  }
  if (errors.length > 0) return Err(errors);
  return Ok(Object.freeze(out));
}

function validateSingle(p: RuleParamSchema, value: unknown): Result<unknown, string> {
  switch (p.type) {
    case 'number': return validateNumber(p, value);
    case 'string': return validateString(p, value);
    case 'boolean': return validateBoolean(p, value);
    case 'duration_ms': return validateDurationMs(p, value);
    case 'enum': return validateEnum(p, value);
  }
}

function validateNumber(p: RuleParamNumber, value: unknown): Result<number, string> {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return Err(`Atteso numero, ricevuto ${typeof value}`);
  }
  if (p.min !== undefined && value < p.min) return Err(`Minimo ammesso: ${p.min.toString()}`);
  if (p.max !== undefined && value > p.max) return Err(`Massimo ammesso: ${p.max.toString()}`);
  return Ok(value);
}

function validateString(p: RuleParamString, value: unknown): Result<string, string> {
  if (typeof value !== 'string') return Err(`Atteso testo, ricevuto ${typeof value}`);
  if (p.maxLength !== undefined && value.length > p.maxLength) {
    return Err(`Lunghezza massima: ${p.maxLength.toString()}`);
  }
  if (p.pattern !== undefined) {
    try {
      const re = new RegExp(p.pattern);
      if (!re.test(value)) return Err(`Non rispetta il pattern ${p.pattern}`);
    } catch { /* pattern malformato — ignora, è bug della regola */ }
  }
  return Ok(value);
}

function validateBoolean(_: RuleParamBoolean, value: unknown): Result<boolean, string> {
  if (typeof value !== 'boolean') return Err(`Atteso booleano, ricevuto ${typeof value}`);
  return Ok(value);
}

function validateDurationMs(p: RuleParamDurationMs, value: unknown): Result<number, string> {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    return Err('Atteso intero positivo (millisecondi)');
  }
  if (p.minMs !== undefined && value < p.minMs) return Err(`Minimo: ${humanMs(p.minMs)}`);
  if (p.maxMs !== undefined && value > p.maxMs) return Err(`Massimo: ${humanMs(p.maxMs)}`);
  return Ok(value);
}

function validateEnum(p: RuleParamEnum, value: unknown): Result<string, string> {
  if (typeof value !== 'string') return Err(`Atteso enum string, ricevuto ${typeof value}`);
  if (!p.values.some((v) => v.value === value)) {
    return Err(`Valore non ammesso. Ammessi: ${p.values.map((v) => v.value).join(', ')}`);
  }
  return Ok(value);
}

/** Format human di una durata ms — usato in messaggi di errore. */
export function humanMs(ms: number): string {
  if (ms < 1000) return `${ms.toString()}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(0)}s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(0)}m`;
  if (ms < 86_400_000) return `${(ms / 3_600_000).toFixed(1)}h`;
  return `${(ms / 86_400_000).toFixed(1)}g`;
}
