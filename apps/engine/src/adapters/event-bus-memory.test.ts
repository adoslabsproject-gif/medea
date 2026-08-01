import { describe, it, expect, vi } from 'vitest';
import { InMemoryEventBus } from './event-bus-memory.js';

describe('InMemoryEventBus', () => {
  it('delivers events to global subscribers', async () => {
    const bus = new InMemoryEventBus();
    const listener = vi.fn();
    bus.subscribe(listener);
    bus.emit({ name: 'workflow.created', data: { id: 'w1' }, ts: new Date().toISOString() });
    await vi.waitFor(() => {
      expect(listener).toHaveBeenCalledOnce();
    });
  });

  it('routes name-scoped subscribers to matching events only', async () => {
    const bus = new InMemoryEventBus();
    const onCreate = vi.fn();
    const onDelete = vi.fn();
    bus.subscribeTo('workflow.created', onCreate);
    bus.subscribeTo('workflow.deleted', onDelete);

    bus.emit({ name: 'workflow.created', data: {}, ts: '' });
    bus.emit({ name: 'workflow.deleted', data: {}, ts: '' });

    await vi.waitFor(() => {
      expect(onCreate).toHaveBeenCalledOnce();
      expect(onDelete).toHaveBeenCalledOnce();
    });
  });

  it('unsubscribe stops further delivery', async () => {
    const bus = new InMemoryEventBus();
    const listener = vi.fn();
    const unsub = bus.subscribe(listener);
    bus.emit({ name: 'workflow.created', data: {}, ts: '' });
    await vi.waitFor(() => {
      expect(listener).toHaveBeenCalledOnce();
    });
    unsub();
    bus.emit({ name: 'workflow.updated', data: {}, ts: '' });
    await new Promise<void>((r) => {
      setTimeout(r, 10);
    });
    expect(listener).toHaveBeenCalledOnce();
  });

  it('one listener throwing does not affect others', async () => {
    const bus = new InMemoryEventBus();
    const bad = vi.fn(() => {
      throw new Error('boom');
    });
    const good = vi.fn();
    bus.subscribe(bad);
    bus.subscribe(good);
    bus.emit({ name: 'workflow.created', data: {}, ts: '' });
    await vi.waitFor(() => {
      expect(good).toHaveBeenCalledOnce();
    });
  });
});
