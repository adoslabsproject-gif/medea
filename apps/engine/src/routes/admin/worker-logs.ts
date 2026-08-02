/**
 * Worker log reader — legge gli ultimi N log di un worker SENZA shell.
 *
 * Hardening audit pre-certificazione (#1): la versione precedente costruiva una
 * stringa shell per `execSync` (`journalctl ... || tail ... || echo`). Anche se
 * gli input erano numerici (non sfruttabili), il pattern corretto è `execFile`
 * con argv array → ZERO superficie di command injection, by design.
 *
 * Difesa in profondità: pid e tail sono ri-validati a interi positivi qui,
 * indipendentemente dal chiamante (mai fidarsi del tipo dichiarato).
 */

import { execFileSync } from 'node:child_process';

const EXEC_TIMEOUT_MS = 5000;
const MAX_TAIL = 2000;
const DEFAULT_TAIL = 200;

function tryExec(bin: string, args: readonly string[]): string {
  try {
    return execFileSync(bin, args as string[], {
      timeout: EXEC_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString('utf8');
  } catch {
    return '';
  }
}

/**
 * Ritorna gli ultimi `tailLines` log del worker `pid` via journalctl, con
 * fallback al file `/var/log/flowforge/worker-<pid>.log`, poi a un messaggio.
 * pid/tail invalidi (NaN, ≤0, non-interi) → mai eseguito un comando.
 */
export function readWorkerLogs(pid: number, tailLines: number): string {
  // NO Math.abs: un pid negativo è invalido, non va "raddrizzato" a positivo
  // (leggerebbe i log di un worker diverso). NaN/≤0/non-intero → rifiutato.
  const safePid = Math.floor(Number(pid));
  if (!Number.isInteger(safePid) || safePid <= 0) {
    return '(invalid pid)';
  }
  const flooredTail = Math.floor(Number(tailLines));
  const safeTail = Math.max(
    1,
    Math.min(
      MAX_TAIL,
      Number.isFinite(flooredTail) && flooredTail > 0 ? flooredTail : DEFAULT_TAIL,
    ),
  );

  const pidStr = String(safePid); // garantito cifre-only
  const tailStr = String(safeTail);

  // Fallback basato sul contenuto TRIMMATO (output whitespace-only di journalctl
  // = nessun log → prova il file). Il `||` su stringa non-trimmata fallirebbe.
  let out = tryExec('journalctl', [`_PID=${pidStr}`, '--no-pager', '-n', tailStr, '-o', 'cat']);
  if (out.trim().length === 0) {
    out = tryExec('tail', ['-n', tailStr, `/var/log/flowforge/worker-${pidStr}.log`]);
  }

  return out.trim().length > 0 ? out : `(no logs found for pid ${pidStr})`;
}
