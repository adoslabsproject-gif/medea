/**
 * Il catalogo non può divergere dal motore in silenzio.
 *
 * La palette e il motore devono conoscere gli stessi nodi. Se il catalogo ne
 * offre uno che il runtime non sa eseguire, l'utente lo mette sul disegno e
 * scopre il problema quando preme «Esegui»; se ne nasconde uno che funziona,
 * quel nodo semplicemente non esiste per chi usa Medea.
 *
 * L'estrattore aveva già sbagliato una volta in questo modo: leggeva una sola
 * delle due forme in cui i pacchetti espongono i nodi, ne prendeva 145 su 193
 * e taceva. Un estrattore che ne prende una parte e non lo dice è peggio di
 * uno che fallisce — il catalogo sembra completo.
 */

import { describe, expect, it } from 'vitest';

import { allNodes, findNode, searchNodes } from './index';

/** Quanti nodi dichiara il runtime di FlowForge su `/api/v1/nodes`. */
const NODI_DEL_MOTORE = 193;

describe('il catalogo rispetto al motore', () => {
  it('ha esattamente i nodi che il motore sa eseguire', () => {
    expect(allNodes()).toHaveLength(NODI_DEL_MOTORE);
  });

  it('non ha doppioni: un defId identifica un nodo solo', () => {
    const ids = allNodes().map((n) => n.defId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('ogni nodo appartiene a una delle famiglie della palette', () => {
    const famiglie = new Set(['trigger', 'action', 'logic', 'ai']);
    const estranei = allNodes().filter((n) => !famiglie.has(n.type));
    expect(estranei.map((n) => `${n.defId} (${n.type})`)).toEqual([]);
  });

  it('ogni nodo ha un’etichetta leggibile', () => {
    const muti = allNodes().filter((n) => !n.label || n.label.trim() === '');
    expect(muti.map((n) => n.defId)).toEqual([]);
  });

  it('solo l’avvio manuale può non avere configurazione', () => {
    // Un nodo senza campi configurabili è quasi sempre un errore di
    // estrazione, non una scelta: l'unico legittimo è quello che si preme.
    const senzaCampi = allNodes().filter((n) => !n.configFields || n.configFields.length === 0);
    expect(senzaCampi.map((n) => n.defId)).toEqual(['trigger_manual']);
  });

  it('distingue le porte dai campi del risultato', () => {
    // Un logic_if ha due PORTE — due strade diverse. Un meta_extract ha
    // diciassette "outputs" che sono i CAMPI del suo risultato. Disegnarli
    // tutti come porte riempie il nodo di attacchi illeggibili.
    const conPorte = allNodes().filter((n) => n.outputPorts && n.outputPorts.length > 0);
    expect(conPorte.every((n) => n.branching === true)).toBe(true);

    const ramificati = allNodes().filter((n) => n.branching);
    expect(ramificati.map((n) => n.defId).sort()).toEqual([
      'action_janitor_cleanup',
      'action_pec_classify',
      'flow_human_review_decision',
      'logic_if',
      'logic_loop',
      'logic_switch',
    ]);
  });

  it('i nodi che il wizard e l’agente danno per scontati esistono', () => {
    // Se uno di questi sparisce dall'estrazione, l'assistente costruisce
    // workflow che non si possono eseguire.
    for (const defId of [
      'trigger_manual',
      'trigger_cron',
      'trigger_imap',
      'action_send_email',
      'action_http',
      'action_run_js',
      'logic_if',
    ]) {
      expect(findNode(defId), defId).toBeDefined();
    }
  });
});

describe('come si presentano sul disegno', () => {
  it('ogni nodo ha un’icona che si risolve davvero', async () => {
    // Un'icona che non si risolve è un nodo che sul canvas resta vuoto:
    // riconoscibile solo leggendo l'etichetta, che è il modo in cui una
    // palette da 193 voci diventa inutilizzabile.
    const { iconNameFor, resolveLucideIcon } = await import('../canvas/icon-registry');
    const senzaIcona = allNodes().filter((n) => !resolveLucideIcon(iconNameFor(n.defId, n.icon)));
    expect(senzaIcona.map((n) => `${n.defId} (${n.icon ?? 'nessuna'})`)).toEqual([]);
  });
});

describe('i campi che l’estrattore deve conservare', () => {
  it('ogni nodo dichiara la versione della sua definizione', () => {
    // Senza, un workflow salvato mesi fa usa un nodo cambiato da allora e
    // nessuno se ne accorge.
    const senza = allNodes().filter((n) => !n.defVersion);
    expect(senza.map((n) => n.defId)).toEqual([]);
  });

  it('gli alias di ricerca sopravvivono all’estrazione', () => {
    const conAlias = allNodes().filter((n) => (n.searchAliases?.length ?? 0) > 0);
    expect(conAlias.length).toBeGreaterThan(20);
  });

  it('i campi di codice dichiarano in che lingua sono scritti', () => {
    // È quello che permette a CODE_NODE_LANG_MISMATCH di accorgersi di uno
    // SELECT dentro un campo JavaScript.
    const conLingua = allNodes().flatMap((n) => (n.configFields ?? []).filter((f) => f.language));
    expect(conLingua.length).toBeGreaterThan(40);
  });

  it('i contratti di uscita non vengono buttati', () => {
    // Sono quelli che impediscono all'assistente di inventare i nomi delle
    // chiavi quando scrive un'espressione.
    const conContratto = allNodes().filter((n) => n.outputContract);
    expect(conContratto.length).toBeGreaterThan(0);
  });

  it('la descrizione lunga resta accanto a quella corta', () => {
    // La palette mostra la prima frase; l'assistente ha bisogno del resto per
    // scegliere il nodo giusto.
    const conLunga = allNodes().filter((n) => n.descriptionLong);
    expect(conLunga.length).toBeGreaterThan(150);
  });
});

describe('la ricerca nella palette', () => {
  it('trova un nodo dal suo alias, non solo dal nome', () => {
    // `wa` non compare in «WhatsApp Trigger»: senza gli alias, chi scrive la
    // parola giusta non trova niente.
    const risultati = searchNodes('wa');
    expect(risultati.some((n) => n.defId.includes('whatsapp'))).toBe(true);
  });
});
