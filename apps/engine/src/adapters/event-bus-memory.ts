import type {
  IEventBus,
  EventListener,
  EventPayload,
  EventName,
  Unsubscribe,
} from '@/ports/event-bus.js';
import { logger } from '@/lib/logger.js';

export class InMemoryEventBus implements IEventBus {
  private readonly globalListeners = new Set<EventListener>();
  private readonly nameListeners = new Map<EventName, Set<EventListener>>();

  emit(event: EventPayload): void {
    void this.dispatchAll(event);
  }

  private async dispatchAll(event: EventPayload): Promise<void> {
    const targets: EventListener[] = [
      ...this.globalListeners,
      ...(this.nameListeners.get(event.name) ?? []),
    ];
    await Promise.allSettled(
      targets.map(async (listener) => {
        try {
          await listener(event);
        } catch (error) {
          logger.error({ err: error, event: event.name }, 'Event listener threw');
        }
      }),
    );
  }

  subscribe(listener: EventListener): Unsubscribe {
    this.globalListeners.add(listener);
    return () => {
      this.globalListeners.delete(listener);
    };
  }

  subscribeTo(name: EventName, listener: EventListener): Unsubscribe {
    const set = this.nameListeners.get(name) ?? new Set<EventListener>();
    set.add(listener);
    this.nameListeners.set(name, set);
    return () => {
      const current = this.nameListeners.get(name);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) {
        this.nameListeners.delete(name);
      }
    };
  }
}
