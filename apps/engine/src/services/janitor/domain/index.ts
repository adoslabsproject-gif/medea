/**
 * Domain layer — public barrel.
 *
 * I file dentro `application/`, `adapters/`, `infrastructure/` importano
 * SEMPRE da `./domain` (questo barrel), MAI dai file singoli — single
 * point of import per disaccoppiare la struttura interna.
 */

export * from './severity.js';
export * from './result.js';
export * from './data-source-ref.js';
export * from './detected-row.js';
export * from './rule-params-schema.js';
export * from './rule.js';
export * from './rule-config.js';
export * from './janitor-report.js';
export * from './quarantine-record.js';
