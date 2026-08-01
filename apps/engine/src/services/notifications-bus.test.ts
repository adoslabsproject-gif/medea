/**
 * notifications-bus (#7 Tier 3) — canale push in-process per-utente.
 */
import { describe, it, expect, vi } from 'vitest';
import { notificationsBus } from './notifications-bus.js';
import type { Notification } from './notifications.service.js';

function notif(over: Partial<Notification> = {}): Notification {
  return { id: 'n1', userId: 'u-ada', type: 'mention', workflowId: 'wf1', nodeId: null, actorName: 'marco@x.it', preview: 'ciao', read: false, createdAt: '2026-06-09T12:00:00.000Z', ...over };
}

describe('notificationsBus', () => {
  it('emitToUser consegna solo al subscriber di quell\'utente', () => {
    const ada = vi.fn();
    const marco = vi.fn();
    const offAda = notificationsBus.subscribe('u-ada', ada);
    const offMarco = notificationsBus.subscribe('u-marco', marco);

    const n = notif();
    notificationsBus.emitToUser('u-ada', n);

    expect(ada).toHaveBeenCalledTimes(1);
    expect(ada).toHaveBeenCalledWith(n);
    expect(marco).not.toHaveBeenCalled();
    offAda(); offMarco();
  });

  it('più subscriber dello stesso utente (multi-tab) ricevono entrambi', () => {
    const tab1 = vi.fn();
    const tab2 = vi.fn();
    const off1 = notificationsBus.subscribe('u-x', tab1);
    const off2 = notificationsBus.subscribe('u-x', tab2);
    expect(notificationsBus.listenerCount('u-x')).toBe(2);

    notificationsBus.emitToUser('u-x', notif({ userId: 'u-x' }));
    expect(tab1).toHaveBeenCalledTimes(1);
    expect(tab2).toHaveBeenCalledTimes(1);
    off1(); off2();
  });

  it('unsubscribe rimuove il listener (no consegna dopo)', () => {
    const h = vi.fn();
    const off = notificationsBus.subscribe('u-off', h);
    off();
    expect(notificationsBus.listenerCount('u-off')).toBe(0);
    notificationsBus.emitToUser('u-off', notif({ userId: 'u-off' }));
    expect(h).not.toHaveBeenCalled();
  });

  it('emit verso utente senza subscriber è no-op (nessun throw)', () => {
    expect(() => { notificationsBus.emitToUser('u-nobody', notif()); }).not.toThrow();
    expect(notificationsBus.listenerCount('u-nobody')).toBe(0);
  });
});
