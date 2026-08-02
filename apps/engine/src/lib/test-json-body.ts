/**
 * Lettura del corpo JSON di una risposta, nei test.
 *
 * `Response.json()` restituisce `unknown`, ed è giusto così: nessuno può
 * garantire la forma di un corpo HTTP prima di averlo guardato. Nei test però
 * quella forma la conosciamo — è esattamente ciò che il test sta verificando —
 * e ripetere un cast a ogni asserzione renderebbe illeggibile il test.
 *
 * Si dichiara qui, una volta per test, cosa ci si aspetta di leggere:
 *
 *     const body = await jsonBody<{ ok: boolean; count: number }>(res);
 *     expect(body.ok).toBe(true);
 *
 * Il tipo dichiarato NON viene verificato a runtime: è una promessa che fa chi
 * scrive il test. Se la rotta cambia forma, a rompersi sarà l'asserzione —
 * che è precisamente il lavoro del test.
 *
 * @module lib/test-json-body
 */

/** Il corpo di una risposta, letto con la forma che il test si aspetta. */
export async function jsonBody<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T;
}
