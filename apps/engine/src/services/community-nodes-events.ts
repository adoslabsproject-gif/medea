/**
 * Tiny pub/sub for community-node lifecycle events.
 *
 * The routes call `emitCommunityNodesChanged()` after install/uninstall.
 * The `/api/v1/nodes` listing endpoint listens and bumps its ETag so the
 * editor's palette refetch picks up the new node WITHOUT a server restart.
 *
 * Keeping it in a separate file (not inside the service) prevents a cycle:
 *   service → routes → service.
 */

type Listener = () => void;
const listeners = new Set<Listener>();

export function emitCommunityNodesChanged(): void {
  for (const l of listeners) {
    try {
      l();
    } catch {
      /* swallow — never let a misbehaving listener kill the publish */
    }
  }
}

export function onCommunityNodesChanged(l: Listener): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}
