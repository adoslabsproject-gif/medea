export type EventName =
  | 'run.started'
  | 'run.step'
  // #226 Cappella Sistina+ logging: un singolo StepLog entry per SSE live
  // streaming (granularità entry per virtual scrolling UI).
  | 'run.step.log'
  | 'run.completed'
  | 'run.errored'
  | 'run.deleted'
  | 'run.paused'
  | 'run.resumed'
  | 'run.cancelled'
  // NB (2026-06-15): rimossi gli eventi ORFANI janitor.*/loop.*/iteration.* —
  // erano emessi (o dichiarati) ma nessun consumer li leggeva. Il contratto
  // event-bus.contract.test.ts ora impone "ogni EventName ha un consumer reale".
  //  • janitor.detection → ora consegna una NOTIFICA IN-APP reale (canale
  //    notifications-bus, non event-bus) — vedi NotificationEmitterAdapter.
  //  • loop.*/iteration.* → osservabilità ridondante: il progresso per-iterazione
  //    arriva già via run.step (consumato dalla dashboard). Riaggiungerli SOLO
  //    insieme al loro consumer (UI loop-progress), mai "in anticipo".
  | 'workflow.created'
  | 'workflow.updated'
  | 'workflow.deleted';

export interface EventPayload {
  name: EventName;
  tenantId?: string;
  data: unknown;
  ts: string;
}

export type EventListener = (event: EventPayload) => void | Promise<void>;
export type Unsubscribe = () => void;

export interface IEventBus {
  emit(event: EventPayload): void;
  subscribe(listener: EventListener): Unsubscribe;
  subscribeTo(name: EventName, listener: EventListener): Unsubscribe;
}
