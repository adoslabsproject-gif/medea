/**
 * Il formato degli eventi in streaming, letto a mano.
 *
 * `EventSource` sarebbe la strada breve, ma non sa mandare intestazioni: il
 * runtime vuole un token e quello resta fuori. Quindi si legge il corpo della
 * risposta a pezzi e si ricompone qui.
 *
 * Il protocollo è a righe: `event:` dice cosa è successo, `data:` cosa
 * contiene, una riga vuota chiude il messaggio. Una riga che comincia per `:`
 * è un commento — il runtime ne manda 16 KB in apertura per convincere i
 * proxy a non trattenere lo stream, e vanno ignorati senza fare rumore.
 */

export interface SseMessage {
  event: string;
  data: string;
}

/**
 * Un lettore che tiene il pezzo di riga rimasto a metà.
 *
 * I pezzi che arrivano dalla rete non coincidono con le righe: un messaggio
 * può spezzarsi ovunque, anche dentro una parola. Senza questo residuo si
 * perderebbe un evento ogni volta che capita.
 */
export function createSseReader(): (chunk: string) => SseMessage[] {
  let buffer = '';

  return (chunk: string): SseMessage[] => {
    buffer += chunk;
    const messages: SseMessage[] = [];

    // I messaggi finiscono con una riga vuota. L'ultimo pezzo resta nel
    // residuo: è incompleto per definizione finché non arriva il resto.
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop() ?? '';

    for (const block of blocks) {
      let event = 'message';
      const data: string[] = [];

      for (const line of block.split(/\r?\n/)) {
        if (line.startsWith(':')) continue;
        const colon = line.indexOf(':');
        const field = colon === -1 ? line : line.slice(0, colon);
        // Uno spazio dopo i due punti è decorazione del protocollo, non dato.
        const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
        if (field === 'event') event = value;
        else if (field === 'data') data.push(value);
      }

      if (data.length > 0) messages.push({ event, data: data.join('\n') });
    }

    return messages;
  };
}

/**
 * Il contenuto di un evento, se è leggibile. Altrimenti niente.
 *
 * Torna `unknown` di proposito: quello che arriva sul filo è dato altrui, e
 * darsi un tipo qui vorrebbe dire fidarsi di una promessa non verificata.
 */
export function parseData(message: SseMessage): unknown {
  try {
    return JSON.parse(message.data);
  } catch {
    return null;
  }
}
