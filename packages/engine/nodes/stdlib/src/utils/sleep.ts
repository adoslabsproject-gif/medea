/**
 * Sleep utility con supporto AbortSignal — abort interruttibile.
 *
 * Standard `setTimeout` non onora AbortSignal nativamente. Wrapping necessario
 * per executor che fanno retry con backoff o polling: senza abort responsiveness
 * un cancel utente attende il prossimo wake.
 */

export async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  if (signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    }
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}
