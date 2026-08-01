/**
 * Streaming JSON parser per output del singleshot scaffold.
 *
 * Pattern: vLLM in modalita\` stream:true emette token a token via SSE.
 * Il content accumulato finale e\` un JSON tipo:
 *   {
 *     "name": "...",
 *     "description": "...",
 *     "reasoning": "...",
 *     "nodes": [
 *       { "id": "n1", "defId": "trigger_cron", ... },  ← appena chiuso questo {} → callback
 *       { "id": "n2", ... },                            ← e cosi\` via
 *       ...
 *     ],
 *     "edges": [...]
 *   }
 *
 * Questo parser tracking-based emette `onNodeAdded(node)` ogni volta che
 * un oggetto figlio dell'array `nodes` viene completato. Analogo per
 * `edges`.
 *
 * NO dipendenze (no `partial-json`, no `clarinet`) — implementazione
 * stato-macchina con brace balance + scan tag `"nodes":`.
 *
 * Limitazioni:
 *  - Aspetta `"nodes": [` per iniziare. Se l'LLM mette altro PRIMA
 *    (es. `description: "..."`), aspetta correttamente.
 *  - Quoted strings con escape `\"` gestite.
 */

export interface StreamParserCallbacks {
  onNodeAdded?: (node: unknown, index: number) => void;
  onEdgeAdded?: (edge: unknown, index: number) => void;
  onMeta?: (meta: { name?: string; description?: string; reasoning?: string }) => void;
}

type Phase = 'pre-nodes' | 'in-nodes' | 'between-arrays' | 'in-edges' | 'done';

export class SingleshotStreamParser {
  private buffer = '';
  private phase: Phase = 'pre-nodes';
  private nodesCount = 0;
  private edgesCount = 0;
  /** Tracking brace balance per identificare il prossimo `}` di array element. */
  private currentObjectStart = -1;
  private braceDepth = 0;
  private inString = false;
  private escapeNext = false;
  private metaEmitted = false;

  constructor(private callbacks: StreamParserCallbacks = {}) {}

  /**
   * Feed con un chunk di testo. Emette callback man mano che identifica
   * elementi completi.
   */
  feed(chunk: string): void {
    this.buffer += chunk;
    this.scan();
  }

  /**
   * Buffer accumulato — utile per parsing finale Zod.
   */
  getAccumulated(): string {
    return this.buffer;
  }

  /**
   * Reset stato — per riuso parser.
   */
  reset(): void {
    this.buffer = '';
    this.phase = 'pre-nodes';
    this.nodesCount = 0;
    this.edgesCount = 0;
    this.currentObjectStart = -1;
    this.braceDepth = 0;
    this.inString = false;
    this.escapeNext = false;
    this.metaEmitted = false;
  }

  private scan(): void {
    // Emit meta ASAP — appena vediamo `name`, `description` parziali
    if (!this.metaEmitted && this.phase === 'pre-nodes' && this.buffer.length > 100) {
      this.tryEmitPartialMeta();
    }

    // Cerca `"nodes":` per entrare in-nodes
    if (this.phase === 'pre-nodes') {
      const idx = this.buffer.indexOf('"nodes"');
      if (idx === -1) return;
      // Trova il `[` dopo
      const bracketIdx = this.buffer.indexOf('[', idx);
      if (bracketIdx === -1) return;
      this.phase = 'in-nodes';
      this.scanCursor = bracketIdx + 1;
      this.processFromIndex();
      return;
    }

    // BUG FIX 2026-05-31: una volta in-nodes/in-edges, lo scan() successivo
    // (chunk feed continuation) DEVE riprendere il processing dal cursor
    // corrente — non solo al primo cambio di phase.
    if (this.phase === 'in-nodes' || this.phase === 'in-edges') {
      this.processFromIndex();
      return;
    }

    if (this.phase === 'between-arrays') {
      const idx = this.buffer.indexOf('"edges"');
      if (idx === -1) return;
      const bracketIdx = this.buffer.indexOf('[', idx);
      if (bracketIdx === -1) return;
      this.phase = 'in-edges';
      this.scanCursor = bracketIdx + 1;
      this.processFromIndex();
      return;
    }
  }

  /**
   * Scan from `this.scanCursor` (state-persistent across chunk feeds).
   * Emette callback per ogni oggetto chiuso.
   */
  private processFromIndex(): void {
    for (let i = this.scanCursor; i < this.buffer.length; i++) {
      this.scanCursor = i + 1;
      const ch = this.buffer[i];
      if (this.escapeNext) {
        this.escapeNext = false;
        continue;
      }
      if (ch === '\\' && this.inString) {
        this.escapeNext = true;
        continue;
      }
      if (ch === '"') {
        this.inString = !this.inString;
        continue;
      }
      if (this.inString) continue;
      if (ch === '{') {
        if (this.braceDepth === 0) this.currentObjectStart = i;
        this.braceDepth++;
      } else if (ch === '}') {
        this.braceDepth--;
        if (this.braceDepth === 0 && this.currentObjectStart >= 0) {
          // Oggetto completato
          const objText = this.buffer.slice(this.currentObjectStart, i + 1);
          this.emitObject(objText);
          this.currentObjectStart = -1;
        }
      } else if (ch === ']' && this.braceDepth === 0) {
        // Fine array
        if (this.phase === 'in-nodes') {
          this.phase = 'between-arrays';
          this.currentObjectStart = -1;
          // Try processing next array (edges) on next feed
          this.scan();
        } else if (this.phase === 'in-edges') {
          this.phase = 'done';
        }
        return;
      }
    }
  }

  private scanCursor = 0;

  private emitObject(text: string): void {
    try {
      const parsed: unknown = JSON.parse(text);
      if (this.phase === 'in-nodes') {
        this.callbacks.onNodeAdded?.(parsed, this.nodesCount);
        this.nodesCount++;
      } else if (this.phase === 'in-edges') {
        this.callbacks.onEdgeAdded?.(parsed, this.edgesCount);
        this.edgesCount++;
      }
    } catch {
      // Malformed object — skip (will be caught by final Zod parse)
    }
  }

  private tryEmitPartialMeta(): void {
    const meta: { name?: string; description?: string; reasoning?: string } = {};
    const m1 = /"name"\s*:\s*"([^"\\]+)"/.exec(this.buffer);
    if (m1?.[1]) meta.name = m1[1];
    const m2 = /"description"\s*:\s*"([^"\\]+)"/.exec(this.buffer);
    if (m2?.[1]) meta.description = m2[1];
    if (meta.name || meta.description) {
      this.callbacks.onMeta?.(meta);
      this.metaEmitted = true;
    }
  }

  getStats(): { phase: Phase; nodesEmitted: number; edgesEmitted: number; bufferLen: number } {
    return {
      phase: this.phase,
      nodesEmitted: this.nodesCount,
      edgesEmitted: this.edgesCount,
      bufferLen: this.buffer.length,
    };
  }
}
