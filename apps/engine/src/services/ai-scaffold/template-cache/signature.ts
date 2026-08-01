/**
 * Graph signature + token normalization — pure helpers per il template
 * cache retrieval (Livello 1).
 *
 * Pattern enterprise 2026: combinare structural match (graph signature)
 * + lexical match (token Jaccard) + semantic match (BGE-M3 cosine,
 * deferred async). Separati in pure functions per testabilita\`.
 */

/**
 * Canonical graph signature: ordina i defId topologicamente partendo dai
 * trigger, separa multipli trigger con `|`, concatena con `>`.
 *
 * Esempi:
 *   - cron → http → db_insert      = "trigger_cron>action_http>db_insert"
 *   - 2 trigger (file_watch + cron) = "trigger_file_watch>action_pdf_parse>...|trigger_cron>db_query>..."
 *
 * Vince come fingerprint structural: workflow con stessa pipeline
 * matchano anche se prompt diverso ("scan e processa PDF" vs "OCR
 * documenti S3").
 */
export function computeGraphSignature(
  nodes: readonly { id: string; defId: string }[],
  edges: readonly { from: string; to: string }[],
): string {
  const nodeById = new Map<string, { id: string; defId: string }>();
  for (const n of nodes) nodeById.set(n.id, n);
  const outEdges = new Map<string, string[]>();
  for (const e of edges) {
    if (!outEdges.has(e.from)) outEdges.set(e.from, []);
    outEdges.get(e.from)!.push(e.to);
  }
  const triggers = nodes.filter((n) => n.defId.startsWith('trigger_'));
  // Sort triggers per defId for deterministic order
  triggers.sort((a, b) => a.defId.localeCompare(b.defId) || a.id.localeCompare(b.id));

  const visited = new Set<string>();
  const chains: string[] = [];

  for (const trigger of triggers) {
    const chain: string[] = [];
    const dfs = (nodeId: string): void => {
      if (visited.has(nodeId)) return;
      visited.add(nodeId);
      const node = nodeById.get(nodeId);
      if (!node) return;
      chain.push(node.defId);
      const outs = (outEdges.get(nodeId) ?? []).slice().sort();
      for (const next of outs) dfs(next);
    };
    dfs(trigger.id);
    if (chain.length > 0) chains.push(chain.join('>'));
  }

  // Include orphan nodes (no trigger ancestor) at the end — rare but
  // protects from being treated as identical to a smaller workflow.
  const orphans = nodes.filter((n) => !visited.has(n.id) && !n.defId.startsWith('trigger_'));
  if (orphans.length > 0) {
    orphans.sort((a, b) => a.defId.localeCompare(b.defId) || a.id.localeCompare(b.id));
    chains.push(`#orphan>${orphans.map((o) => o.defId).join('>')}`);
  }

  return chains.length === 0 ? '#empty' : chains.join('|');
}

/**
 * Estrae l'insieme dei defId usati nel workflow (deduplicato + ordinato).
 * Usato per filter "il template ha telegram?" + per signature overlap score.
 */
export function extractDefIds(
  nodes: readonly { defId: string }[],
): string[] {
  return Array.from(new Set(nodes.map((n) => n.defId))).sort();
}

/**
 * Stopword IT + EN minimali — i prompt FlowForge sono in italiano per
 * il 90%, ma vogliamo essere bilingual-graceful.
 */
const STOPWORDS: ReadonlySet<string> = new Set([
  // IT
  'il', 'la', 'lo', 'le', 'gli', 'i', 'un', 'una', 'uno',
  'di', 'da', 'a', 'in', 'su', 'per', 'con', 'tra', 'fra',
  'che', 'e', 'o', 'ma', 'se', 'come', 'quando', 'dove', 'perche\'',
  'del', 'della', 'dello', 'dei', 'degli', 'delle',
  'al', 'alla', 'allo', 'ai', 'agli', 'alle',
  'mi', 'ti', 'si', 'ci', 'vi', 'ne', 'lo', 'la',
  'questo', 'questa', 'quello', 'quella',
  'sono', 'sei', 'e\'', 'siamo', 'siete', 'fanno',
  'fa', 'ha', 'ho', 'hai', 'abbiamo', 'avete',
  'devo', 'devi', 'deve', 'dobbiamo', 'dovete', 'devono',
  // EN
  'the', 'a', 'an', 'of', 'to', 'in', 'on', 'at', 'for', 'with', 'by',
  'and', 'or', 'but', 'if', 'as', 'is', 'are', 'was', 'were',
  'this', 'that', 'these', 'those',
  'i', 'you', 'he', 'she', 'it', 'we', 'they',
  'my', 'your', 'his', 'her', 'its', 'our', 'their',
]);

/**
 * Normalizza il prompt utente in un set di token lemmati semplici per
 * Jaccard similarity. Lowercase, rimuove punctuation, rimuove stopwords,
 * deduplica.
 *
 * NON e\` un lemmatizer vero — non vale la pena (incremental gain
 * marginale, dependency tree pesante). Stop-list + dedup bastano a
 * eliminare il 70% del rumore.
 */
export function tokenizePrompt(text: string): string[] {
  const lower = text.toLowerCase();
  // Replace any non-alphanumeric (incl. apostrofi italiani) with space
  const cleaned = lower.replace(/[^a-z0-9à-ÿ]+/g, ' ');
  const tokens = cleaned.split(/\s+/).filter((t) => t.length >= 3 && !STOPWORDS.has(t));
  return Array.from(new Set(tokens)).sort();
}

/**
 * Jaccard similarity tra 2 set di token: |A ∩ B| / |A ∪ B|.
 * Range [0, 1]. 1 = identical, 0 = disjoint.
 */
export function jaccardSimilarity(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;
  for (const t of setA) if (setB.has(t)) intersection++;
  const union = setA.size + setB.size - intersection;
  return intersection / union;
}

/**
 * Overlap score tra 2 set di defId: |A ∩ B| / max(|A|, |B|).
 * Range [0, 1]. 1 = stessi nodi (anche se topology diversa).
 * Asymmetric su denominatore: penalizza i template MOLTO piu\` grandi
 * del query (non vogliamo ritornare un mega-workflow per request semplice).
 */
export function defIdOverlap(query: readonly string[], template: readonly string[]): number {
  if (query.length === 0 || template.length === 0) return 0;
  const setQ = new Set(query);
  const setT = new Set(template);
  let intersection = 0;
  for (const t of setQ) if (setT.has(t)) intersection++;
  return intersection / Math.max(setQ.size, setT.size);
}

/**
 * Cosine similarity tra 2 vettori float di stessa dim.
 * Range [-1, 1]. 1 = identical direction (semantic match).
 * Per BGE-M3 embeddings (1024d) i valori reali sono in [0.3, 0.95]
 * (raramente <0.3 perche\` lo spazio embedding e\` denso).
 */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    dot += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Final score: weighted combo dei segnali disponibili PRE-LLM.
 *
 * BUG FIX 2026-05-31: i pesi originali (0.45 graph + 0.35 jaccard +
 * 0.10 success + 0.10 cosine) erano sbagliati per il flow reale.
 * `graph_overlap` richiede defId del workflow target — disponibili
 * SOLO dopo l'LLM call. Pre-LLM e\` sempre 0 → score teorico max 0.55
 * → mai use_direct, mai inject_fewshot. Cache di fatto inutile.
 *
 * Nuovi pesi (bilanciati sui signal effettivamente disponibili pre-LLM):
 *   - 0.50 prompt_jaccard       (token overlap — signal primario)
 *   - 0.40 cosine               (BGE-M3 semantic — boost secondario)
 *   - 0.10 success_rate         (rank boost template proven)
 *
 * Math: prompt identico + cosine 1.0 + success 0.5 = 0.50 + 0.40 + 0.05 = **0.95** → use_direct.
 * Prompt simile (jaccard 0.7) + cosine 0.8 + success 0.5 = 0.35 + 0.32 + 0.05 = **0.72** → inject_fewshot.
 *
 * `graph_overlap` parametro mantenuto per future SECOND-PASS retrieve
 * (post-LLM, dopo aver generato i defId) — peso 0 oggi.
 */
export function computeRetrievalScore(opts: {
  graphOverlap: number;
  promptJaccard: number;
  successRate: number;
  cosine: number;
}): number {
  return 0.50 * opts.promptJaccard
    + 0.40 * opts.cosine
    + 0.10 * opts.successRate
    + 0.00 * opts.graphOverlap; // reserved for second-pass retrieval
}
