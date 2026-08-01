/**
 * Validazione architetturale del workflow generato — estratta da singleshot
 * (split NO-MONOLITI 2026-06-11). PURA: (nodes, edges, catalog) → issues[].
 * 4 check anti-bug user-observed: trigger-no-inbound, no-orfani, switch-case-port,
 * anti-pigrizia-slack. Il caller mergia gli issues e decide il throw.
 */
interface VaNode { id: string; defId: string; config: Record<string, unknown> }
interface VaEdge { from: string; to: string; fromPort?: string | undefined }
interface VaCatalogEntry { defId: string; type: string }

export function validateArchitecture(
  nodes: readonly VaNode[],
  edges: readonly VaEdge[],
  catalog: readonly VaCatalogEntry[],
): string[] {
  const issues: string[] = [];
  // 1. TRIGGER non possono ricevere edge in entrata (sono SEMPRE root)
  const triggerIds = new Set(
    nodes.filter((n) => {
      const entry = catalog.find((c) => c.defId === n.defId);
      return entry && (entry.type === 'trigger' || n.defId.startsWith('trigger_'));
    }).map((n) => n.id),
  );
  for (const e of edges) {
    if (triggerIds.has(e.to)) {
      issues.push(
        `Edge "${e.from}" → "${e.to}" invalido: "${e.to}" e\` un TRIGGER (root). I trigger sono scatenati ` +
        `dall'esterno (cron/imap/webhook/file), MAI da altri nodi. Rimuovi questo edge — se serve un ` +
        `flusso "dopo X scatena Y", connetti il terminale di X a un nodo action_/db_/community_, non a un trigger.`,
      );
    }
  }

  // 2. Nodi non-trigger DEVONO avere almeno 1 edge in entrata (no orfani)
  const nodesWithIncoming = new Set(edges.map((e) => e.to));
  for (const n of nodes) {
    if (triggerIds.has(n.id)) continue;
    if (!nodesWithIncoming.has(n.id)) {
      issues.push(`Nodo "${n.id}" (${n.defId}) e\` orfano: nessun edge in entrata. Aggiungi un edge da un altro nodo, o rimuovilo.`);
    }
  }

  // 3. Ogni switch case nominato deve avere un edge OUT con quel fromPort
  for (const n of nodes) {
    if (n.defId !== 'logic_switch') continue;
    const casesRaw = (n.config).cases;
    if (!Array.isArray(casesRaw)) continue;
    const casesPorts = new Set<string>();
    for (const c of casesRaw) {
      if (c && typeof c === 'object') {
        const port = (c as Record<string, unknown>).case ?? (c as Record<string, unknown>).output;
        if (typeof port === 'string') casesPorts.add(port);
      } else if (typeof c === 'string') {
        casesPorts.add(c);
      }
    }
    const outgoingPorts = new Set(
      edges
        .filter((e) => e.from === n.id && typeof e.fromPort === 'string')
        .map((e) => e.fromPort!),
    );
    for (const port of casesPorts) {
      if (!outgoingPorts.has(port)) {
        issues.push(
          `Switch "${n.id}" ha case "${port}" dichiarato in config ma NESSUN edge in uscita con fromPort="${port}". ` +
          `Aggiungi un edge {from:"${n.id}", to:"<destinazione>", fromPort:"${port}"}.`,
        );
      }
    }
  }

  // 4. Anti-pigrizia: se 3+ rami consecutivi di uno switch finiscono tutti
  //    in community_slack, probabilmente Liara ha "sbrigato" il branching.
  //    Warning (non block) — utente puo\` deciderlo, ma log.
  for (const n of nodes) {
    if (n.defId !== 'logic_switch') continue;
    const branchEdges = edges.filter((e) => e.from === n.id);
    const destDefIds = branchEdges
      .map((e) => nodes.find((nn) => nn.id === e.to)?.defId)
      .filter(Boolean);
    if (destDefIds.length >= 3) {
      const slackCount = destDefIds.filter((d) => d === 'community_slack').length;
      if (slackCount === destDefIds.length) {
        issues.push(
          `Switch "${n.id}" ha ${destDefIds.length.toString()} rami TUTTI verso community_slack. ` +
          `Probabilmente il goal richiede destinazioni DIVERSE (es. ERP=action_http, CRM=community_<crm>, Slack=community_slack). ` +
          `Rivedi i defId dei nodi di destinazione e differenzia.`,
        );
      }
    }
  }
  return issues;
}
