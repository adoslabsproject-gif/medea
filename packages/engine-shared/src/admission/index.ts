/**
 * @medea/engine-shared/admission — motore di ammissione LLM (coda globale single-GPU).
 *
 * Engine condiviso da TUTTI i front-door verso vLLM (gateway Liara + gateway
 * portal) → una sola coda Redis (`liara:adm:*`) protegge la GPU unica a
 * prescindere dal path d'ingresso. Il binding alla config + la mappatura SSE
 * restano nelle singole app (config-specific).
 *
 * @module admission
 */
export {
  decideAdmission, releaseLease,
  type PoolState, type Lease, type Waiter,
  type AdmissionInput, type AdmissionDecision, type AdmissionOutcome, type RejectReason,
} from './decision.js';
export {
  tryAdmit, release, heartbeat, ADMISSION_LUA,
  type RedisLike, type AdmissionResult,
} from './redis-queue.js';
export {
  admit, AdmissionOverloadError, AdmissionTimeoutError, AdmissionAbortError,
  type AdmitOptions, type AdmissionHandle,
} from './controller.js';
export { loadAdmissionConfig, type AdmissionConfig } from './config.js';
export {
  publishQueued, publishAdmitted, readPosition, clearPosition,
  type PositionRedis, type QueuePosition,
} from './position-channel.js';
