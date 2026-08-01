/**
 * Il disegno come immagine.
 *
 * Serve a mettere un workflow dentro una email, un documento, un messaggio a
 * qualcuno che l'app non ce l'ha. Esportare il JSON è un'altra cosa: quello
 * si riapre, questo si guarda.
 *
 * Si disegna a mano su una tela invece di usare una libreria: catturare
 * l'SVG di React Flow porterebbe dentro fogli di stile, caratteri e icone che
 * nel PNG non si risolvono. Qui si ridisegna quello che conta — i nodi coi
 * loro nomi e le frecce fra loro — con la certezza di cosa viene fuori.
 */

import type { CanvasNode, NodeDef, Workflow } from '../types';

/** Quanto è grande un nodo nell'immagine, e quanto respiro attorno al tutto. */
const NODO = { w: 150, h: 60 };
const MARGINE = 40;

interface Colori {
  sfondo: string;
  nodo: string;
  bordo: string;
  testo: string;
  freccia: string;
}

/**
 * I colori dell'immagine.
 *
 * Sono scritti qui e non presi dal design system, per due motivi che vanno
 * insieme: su una tela le variabili CSS non esistono — `ctx.fillStyle` vuole
 * un colore vero — e soprattutto l'immagine deve restare **chiara anche in
 * tema scuro**, perché finisce dentro email e documenti che chiari lo sono
 * sempre. Un diagramma bianco su nero incollato in un preventivo è una
 * macchia.
 *
 * È l'eccezione, non la regola: nei componenti i colori restano quelli del
 * design system.
 */
/* eslint-disable no-restricted-syntax -- vedi sopra: si dipinge su una tela,
   dove le variabili CSS non esistono, e l'immagine resta chiara di proposito. */
const CHIARO: Colori = {
  sfondo: '#ffffff',
  nodo: '#f4f4f5',
  bordo: '#a1a1aa',
  testo: '#18181b',
  freccia: '#71717a',
};
/* eslint-enable no-restricted-syntax */

/** L'area che i nodi occupano, coi margini. */
export function bounds(nodes: readonly CanvasNode[]): {
  minX: number;
  minY: number;
  width: number;
  height: number;
} {
  if (nodes.length === 0) return { minX: 0, minY: 0, width: 400, height: 200 };
  const xs = nodes.map((n) => n.x);
  const ys = nodes.map((n) => n.y);
  const minX = Math.min(...xs) - MARGINE;
  const minY = Math.min(...ys) - MARGINE;
  return {
    minX,
    minY,
    width: Math.max(...xs) + NODO.w + MARGINE - minX,
    height: Math.max(...ys) + NODO.h + MARGINE - minY,
  };
}

/** Il nome da scrivere dentro un nodo. */
function etichetta(node: CanvasNode, defs: ReadonlyMap<string, NodeDef>): string {
  return node.label ?? defs.get(node.defId)?.label ?? node.defId;
}

/**
 * Disegna il workflow su una tela e restituisce il PNG.
 *
 * Il doppio della risoluzione perché un'immagine di un diagramma finisce
 * ingrandita più spesso di quanto si creda, e sfocata non serve a niente.
 */
export function drawWorkflow(
  workflow: Workflow,
  defs: ReadonlyMap<string, NodeDef>,
  scala = 2,
): HTMLCanvasElement {
  const area = bounds(workflow.nodes);
  const canvas = document.createElement('canvas');
  canvas.width = area.width * scala;
  canvas.height = area.height * scala;

  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;

  ctx.scale(scala, scala);
  ctx.fillStyle = CHIARO.sfondo;
  ctx.fillRect(0, 0, area.width, area.height);

  const posizione = (id: string) => {
    const n = workflow.nodes.find((x) => x.id === id);
    return n ? { x: n.x - area.minX, y: n.y - area.minY } : null;
  };

  // Prima le frecce, così passano SOTTO i nodi invece di attraversarli.
  ctx.strokeStyle = CHIARO.freccia;
  ctx.lineWidth = 1.5;
  for (const edge of workflow.edges) {
    const da = posizione(edge.from);
    const a = posizione(edge.to);
    if (!da || !a) continue;

    ctx.beginPath();
    ctx.moveTo(da.x + NODO.w, da.y + NODO.h / 2);
    ctx.lineTo(a.x, a.y + NODO.h / 2);
    ctx.stroke();
  }

  for (const node of workflow.nodes) {
    const p = posizione(node.id);
    if (!p) continue;

    ctx.fillStyle = CHIARO.nodo;
    ctx.strokeStyle = CHIARO.bordo;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(p.x, p.y, NODO.w, NODO.h, 8);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = CHIARO.testo;
    ctx.font = '12px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    const testo = etichetta(node, defs);
    // Troncato invece che debordante: un nome lungo non deve uscire dal
    // rettangolo e finire sopra la freccia accanto.
    const massimo = NODO.w - 16;
    let scritto = testo;
    while (ctx.measureText(scritto).width > massimo && scritto.length > 1) {
      scritto = `${scritto.slice(0, -2)}…`;
    }
    ctx.fillText(scritto, p.x + 8, p.y + NODO.h / 2);
  }

  return canvas;
}

/** Scarica il disegno come immagine. */
export function exportPng(workflow: Workflow, defs: ReadonlyMap<string, NodeDef>): void {
  const canvas = drawWorkflow(workflow, defs);
  canvas.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${workflow.name || 'workflow'}.png`;
    a.click();
    URL.revokeObjectURL(url);
  }, 'image/png');
}
