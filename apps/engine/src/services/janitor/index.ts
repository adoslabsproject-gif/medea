/**
 * Janitor — public API.
 *
 * I consumer esterni (routes, app.ts, main.ts, tests) importano DA QUI
 * e niente altro. Tutti i sub-folder restano dettagli implementativi.
 */
export * from './domain/index.js';
export * from './application/index.js';
export * from './infrastructure/janitor.factory.js';
export type { JanitorScheduler } from './scheduler/janitor.scheduler.js';
