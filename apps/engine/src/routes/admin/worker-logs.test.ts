/**
 * Tests per worker-logs — lettura log SENZA shell (execFile argv).
 *
 * Verifica: nessuna stringa shell (argv array), sanitizzazione pid/tail,
 * fallback journalctl→tail→messaggio, e che un pid/tail "sporco" NON raggiunga
 * mai il binario. Ogni test fallirebbe se l'hardening fosse rimosso.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const calls: { bin: string; args: string[] }[] = [];
// Coda di esiti per ogni invocazione: Buffer (output) o Error (throw).
let outcomes: (Buffer | Error)[] = [];

const m = vi.hoisted(() => ({ exec: vi.fn() }));

vi.mock('node:child_process', () => ({
  execFileSync: (bin: string, args: string[]) => m.exec(bin, args),
}));

import { readWorkerLogs } from './worker-logs.js';

beforeEach(() => {
  calls.length = 0;
  outcomes = [];
  vi.clearAllMocks();
  m.exec.mockImplementation((bin: string, args: string[]) => {
    calls.push({ bin, args });
    const o = outcomes.shift();
    if (o instanceof Error) throw o;
    return o ?? Buffer.from('');
  });
});

describe('readWorkerLogs — no-shell + sanitizzazione', () => {
  it('usa execFile con argv array (NO stringa shell, NO metachar)', () => {
    outcomes = [Buffer.from('line1\nline2')];
    const out = readWorkerLogs(1234, 50);
    expect(out).toBe('line1\nline2');
    expect(calls[0]!.bin).toBe('journalctl');
    expect(calls[0]!.args).toEqual(['_PID=1234', '--no-pager', '-n', '50', '-o', 'cat']);
    expect(calls[0]!.args.some((a) => /[;|&$`><]/.test(a))).toBe(false);
  });

  it('journalctl vuoto → fallback a tail sul file del pid', () => {
    outcomes = [Buffer.from('   '), Buffer.from('from-file')];
    const out = readWorkerLogs(77, 10);
    expect(out).toBe('from-file');
    expect(calls[1]!.bin).toBe('tail');
    expect(calls[1]!.args).toEqual(['-n', '10', '/var/log/flowforge/worker-77.log']);
  });

  it('journalctl throw → fallback a tail', () => {
    outcomes = [new Error('journalctl missing'), Buffer.from('tail-out')];
    expect(readWorkerLogs(5, 10)).toBe('tail-out');
  });

  it('entrambi falliscono/vuoti → messaggio "(no logs found...)"', () => {
    outcomes = [Buffer.from(''), Buffer.from('')];
    expect(readWorkerLogs(9, 10)).toBe('(no logs found for pid 9)');
  });

  it.each([[0], [-5], [NaN], [Infinity]])('pid invalido %j → "(invalid pid)" SENZA eseguire', (pid) => {
    expect(readWorkerLogs(pid, 50)).toBe('(invalid pid)');
    expect(m.exec).not.toHaveBeenCalled();
  });

  it('pid float → floored a intero, argv cifre-only', () => {
    outcomes = [Buffer.from('x')];
    readWorkerLogs(123.9, 10);
    expect(calls[0]!.args[0]).toBe('_PID=123');
  });

  it('tail clampato a max 2000', () => {
    outcomes = [Buffer.from('x')];
    readWorkerLogs(1, 999999);
    expect(calls[0]!.args).toContain('2000');
  });

  it('tail NaN → default 200', () => {
    outcomes = [Buffer.from('x')];
    readWorkerLogs(1, Number('abc'));
    expect(calls[0]!.args).toContain('200');
  });
});
