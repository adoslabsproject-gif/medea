/**
 * RAG security guard — re-export del pacchetto condiviso @medea/engine-rag-guard.
 *
 * L'implementazione (scanForInjection, frameRagContent, frameRagResults,
 * RAG_SYSTEM_REINFORCEMENT) vive in `packages/engine/rag-guard` perché è
 * usata sia qui (executor rag_search) sia dal nodo agent (@medea/engine-nodes-ai-agents):
 * un'unica fonte di verità del marker + framing + rinforzo rende impossibile il
 * drift tra il dato framato e il rinforzo system-prompt che vi si riferisce
 * (contratto #2 del reviewer).
 *
 * Questo barrel mantiene il path di import storico (`./rag-guard.js`) per rag.ts
 * e per i consumer interni del runtime.
 */
export {
  scanForInjection,
  frameRagContent,
  frameRagResults,
  RAG_CONTENT_MARKER,
  RAG_SYSTEM_REINFORCEMENT,
  type InjectionScan,
  type RagSearchResult,
} from '@medea/engine-rag-guard';
